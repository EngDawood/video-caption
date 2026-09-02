import { NonRetryableError } from 'cloudflare:workflows';
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
  type WorkflowTimeoutDuration,
} from 'cloudflare:workers';
import { refitSegments, transcribeChunk, translateSegments } from './ai';
import { fetchMedia, maxSourceBytes, resolveVideo } from '../media/download';
import { assetKeys } from '../media/assets';
import { ffmpegFor } from '../media/ffmpeg';
import { FONTS, loadSettings, type CaptionSettings } from '../captions/settings';
import { buildAss } from '../captions/subtitles';
import { sendEditCard } from '../bot/edit';
import { telegram } from '../bot/telegram';
import type { CaptionJob, Env, Segment, VideoMeta } from '../types';

const RETRY: WorkflowStepConfig = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
};

const longStep = (timeout: WorkflowTimeoutDuration): WorkflowStepConfig => ({ ...RETRY, timeout });

/** What a finished run leaves in R2 for a later re-burn to pick up. */
interface StoredCues {
  meta: VideoMeta;
  /** Translated but not yet fitted to a line length — see `refitSegments`. */
  segments: Segment[];
}

const EXPIRED = 'that video is no longer stored — send it again to caption it fresh';

export class CaptionWorkflow extends WorkflowEntrypoint<Env, CaptionJob> {
  async run(event: WorkflowEvent<CaptionJob>, step: WorkflowStep) {
    const { jobId, chatId, messageId, fileId, sourceUrl, statusMessageId } = event.payload;
    const mode = event.payload.mode ?? 'full';
    // A re-burn reads the video and the cues the original run stored, so it
    // works under that job's prefix and overwrites that job's output.
    const assetJobId = event.payload.assetJobId ?? jobId;
    const keys = assetKeys(assetJobId);

    const env = this.env;
    const tg = telegram(env.TELEGRAM_BOT_TOKEN);
    const ffmpeg = ffmpegFor(env, jobId);

    const say = (text: string) =>
      statusMessageId
        ? tg.editMessageText(chatId, statusMessageId, text)
        : tg.sendMessage(chatId, text).catch(() => null);

    try {
      // Frozen for the whole run: a re-burn carries the draft the user just
      // built, and a first run pins the chat defaults as they were at queue
      // time rather than whatever a retry might read later.
      const settings = (await step.do('resolve-settings', RETRY, async () => {
        return event.payload.settings ?? (await loadSettings(env, chatId));
      })) as CaptionSettings;

      let meta: VideoMeta;
      let cues: Segment[];

      if (mode === 'restyle') {
        const stored = (await step.do('load-cues', RETRY, async () => {
          const object = await env.MEDIA.get(keys.segments);
          if (!object) throw new NonRetryableError(EXPIRED);
          return object.json<StoredCues>();
        })) as StoredCues;

        meta = stored.meta;
        cues = stored.segments;

        await step.do('load-video', longStep('5 minutes'), async () => {
          await say('⏳ Reloading the video…');
          const object = await env.MEDIA.get(keys.input);
          if (!object) throw new NonRetryableError(EXPIRED);
          // Nothing here reads the audio track — only the video is re-encoded.
          await ffmpeg.uploadVideo(await object.arrayBuffer(), { skipAudio: true });
        });
      } else {
        // 1. Get the source video into R2, so later steps can re-read it without
        //    hitting the Bot API — or the expiring social link — again.
        await step.do('fetch-video', RETRY, async () => {
          if (sourceUrl) {
            // Resolve and download inside one step: the links the API hands back
            // are signed and short-lived, so they must not outlive this attempt.
            const media = await resolveVideo(env, sourceUrl);
            await say(`⏳ Downloading from ${media.platform}…`);
            const bytes = await fetchMedia(media, maxSourceBytes(env));
            await env.MEDIA.put(keys.input, bytes);
            return { bytes: bytes.byteLength, platform: media.platform };
          }

          if (!fileId) throw new NonRetryableError('job has neither a file nor a link');
          const bytes = await tg.download(fileId);
          await env.MEDIA.put(keys.input, bytes);
          return { bytes: bytes.byteLength };
        });

        // 2. Hand it to ffmpeg, which extracts a 16 kHz mono track for the ASR model.
        meta = (await step.do('extract-audio', longStep('5 minutes'), async () => {
          await say('⏳ Extracting audio…');
          const object = await env.MEDIA.get(keys.input);
          if (!object) throw new Error('input video missing from R2');
          return ffmpeg.uploadVideo(await object.arrayBuffer());
        })) as VideoMeta;

        const maxSeconds = Number(env.MAX_VIDEO_SECONDS || 900);
        if (meta.duration > maxSeconds) {
          await say(`⚠️ Video is ${Math.round(meta.duration)}s, limit is ${maxSeconds}s.`);
          await this.abandon(ffmpeg, assetJobId);
          return;
        }

        // 3. Transcribe in chunks — one step each, so a failure retries just that slice.
        const chunkSeconds = Number(env.CHUNK_SECONDS || 240);
        const chunkCount = Math.max(1, Math.ceil(meta.duration / chunkSeconds));
        const transcribed: Segment[] = [];

        for (let i = 0; i < chunkCount; i++) {
          const start = i * chunkSeconds;
          const dur = Math.min(chunkSeconds, meta.duration - start);

          const segments = (await step.do(`transcribe-${i}`, longStep('5 minutes'), async () => {
            await say(`⏳ Transcribing… (${i + 1}/${chunkCount})`);
            const audio = await this.withVideoLoaded(jobId, keys.input, () => ffmpeg.audioSlice(start, dur));
            return transcribeChunk(env, audio, start, dur);
          })) as Segment[];

          transcribed.push(...segments);
        }

        if (transcribed.length === 0) {
          await say('⚠️ No speech found in this video.');
          await this.abandon(ffmpeg, assetJobId);
          return;
        }

        // 4. Translate each cue, then park the result next to the video. Those
        //    two objects are everything a re-burn needs, and keeping them turns
        //    a restyle into one encode instead of a second round of STT.
        const translated = (await step.do('translate', longStep('5 minutes'), async () => {
          await say(`⏳ Translating ${transcribed.length} lines to Arabic…`);
          return translateSegments(env, transcribed);
        })) as Segment[];

        await step.do('store-cues', RETRY, async () => {
          await env.MEDIA.put(keys.segments, JSON.stringify({ meta, segments: translated } satisfies StoredCues));
        });

        cues = translated;
      }

      // 5. Burn the Arabic in.
      await step.do('burn-subtitles', longStep('10 minutes'), async () => {
        await say('⏳ Burning captions into the video…');
        const font = FONTS[settings.font];

        const ass = buildAss(refitSegments(cues, Number(settings.chars)), {
          font: font.family,
          width: meta.width ?? 1280,
          height: meta.height ?? 720,
          rtl: (env.TARGET_LANG || 'ar') === 'ar',
          preset: settings.preset,
          size: settings.size,
          position: settings.position,
          color: settings.color,
          background: settings.background,
          // Per-font, not per-deployment: only Al Jazeera ships a real bold.
          allowBold: font.hasBold,
        });

        // Both calls sit inside the retry: re-pushing the video wipes the
        // container's work directory, taking the subtitle file with it.
        const burn = async () => {
          await ffmpeg.putSubtitles(ass);
          const burned = await ffmpeg.burn();
          await env.MEDIA.put(keys.output, burned);
          return burned;
        };

        await this.withVideoLoaded(jobId, keys.input, burn, mode === 'restyle');
        return { lines: cues.length };
      });

      // 6. Send it back.
      await step.do('deliver', RETRY, async () => {
        const object = await env.MEDIA.get(keys.output);
        if (!object) throw new Error('burned video missing from R2');
        await tg.sendVideo(chatId, await object.arrayBuffer(), { replyTo: messageId });
      });

      await step.do('cleanup', async () => {
        await say('✅ Done.');
        await ffmpeg.cleanup();
        // The input and the cues stay: they are what makes the ✏️ Edit card
        // below cheap. Closing that card drops them.
        await env.MEDIA.delete(keys.output);
      });

      // 7. Offer to change how it looks, for this video only.
      await step.do('offer-restyle', async () => {
        await sendEditCard(env, chatId, messageId, assetJobId, settings);
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[workflow] job ${jobId} failed:`, reason);
      await say(`❌ Failed: ${reason}`);
      await ffmpeg.cleanup();
      throw err;
    }
  }

  /**
   * Give up on a job that produced nothing worth sending.
   *
   * Stopping the container matters: it bills for provisioned memory the whole
   * time it is awake, so walking away without this leaves the idle timer to
   * charge for work that already ended.
   */
  private async abandon(ffmpeg: ReturnType<typeof ffmpegFor>, assetJobId: string): Promise<void> {
    await ffmpeg.cleanup();
    const keys = assetKeys(assetJobId);
    await this.env.MEDIA.delete([keys.input, keys.output, keys.segments]).catch(() => {});
  }

  /**
   * The container's disk is ephemeral and a retried step may land on a fresh
   * instance, so re-push the source video if it reports the job is gone.
   */
  private async withVideoLoaded<T>(
    jobId: string,
    inputKey: string,
    fn: () => Promise<T>,
    skipAudio = false,
  ): Promise<T> {
    const ffmpeg = ffmpegFor(this.env, jobId);
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/no_audio_extracted|no_video|409/.test(message)) throw err;

      const object = await this.env.MEDIA.get(inputKey);
      if (!object) throw err;
      await ffmpeg.uploadVideo(await object.arrayBuffer(), { skipAudio });
      return fn();
    }
  }
}

export type { VideoMeta };
