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
import { FONTS, isRtlLang, loadSettings, type CaptionSettings } from '../captions/settings';
import { buildAss } from '../captions/subtitles';
import { sendEditCard } from '../bot/edit';
import { shortLabel } from '../bot/menu';
import { cancelKey, cancelKeyboard } from '../bot/jobs';
import { telegram } from '../bot/telegram';
import type { CaptionJob, Env, Segment, VideoMeta } from '../types';

const RETRY: WorkflowStepConfig = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
};

const longStep = (timeout: WorkflowTimeoutDuration): WorkflowStepConfig => ({ ...RETRY, timeout });

/** What a finished run leaves in R2 for a later re-run to pick up. */
interface StoredCues {
  meta: VideoMeta;
  /** Translated but not yet fitted to a line length — see `refitSegments`. */
  segments: Segment[];
  /**
   * The transcript before translation. This is what makes a re-translate cheap:
   * a different translator or target language costs one translation pass, with
   * no container and no second round of STT.
   */
  source?: Segment[];
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

    // Telegram drops an inline keyboard from any edit that does not re-send
    // it, so every progress line has to carry the ✖️ Stop button along.
    const keyboard = event.payload.cancelToken ? cancelKeyboard(event.payload.cancelToken) : undefined;
    const say = (text: string) =>
      statusMessageId
        ? tg.editMessageText(chatId, statusMessageId, text, keyboard)
        : tg.sendMessage(chatId, text).catch(() => null);

    /** For lines that end the job: the button would have nothing left to stop. */
    const settle = (text: string) =>
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

      // How deep this run goes. Each mode reuses everything the stage above it
      // already produced, so a re-run only pays for what actually changed.
      const readsSpeech = mode === 'full' || mode === 'retranscribe';
      const translates = readsSpeech || mode === 'retranslate';

      let meta: VideoMeta;
      let cues: Segment[];
      /** The pre-translation transcript, carried to `store-cues` at the end. */
      let transcript: Segment[];

      if (readsSpeech) {
        // 1. Get the source video into R2, so later steps can re-read it without
        //    hitting the Bot API — or the expiring social link — again. A
        //    re-transcribe skips this: the video is already there.
        if (mode === 'full') {
          await step.do('fetch-video', RETRY, async () => {
            if (sourceUrl) {
              // Resolve and download inside one step: the links the API hands
              // back are signed and short-lived, so they must not outlive this
              // attempt.
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
        }

        // 2. Hand it to ffmpeg, which extracts a 16 kHz mono track for the ASR model.
        meta = (await step.do('extract-audio', longStep('5 minutes'), async () => {
          await say('⏳ Extracting audio…');
          const object = await env.MEDIA.get(keys.input);
          if (!object) throw new NonRetryableError(EXPIRED);
          return ffmpeg.uploadVideo(await object.arrayBuffer());
        })) as VideoMeta;

        const maxSeconds = Number(env.MAX_VIDEO_SECONDS || 900);
        if (meta.duration > maxSeconds) {
          await settle(`⚠️ Video is ${Math.round(meta.duration)}s, limit is ${maxSeconds}s.`);
          await this.abandon(ffmpeg, assetJobId, mode === 'full');
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
            return transcribeChunk(env, audio, start, dur, settings.sourceLang, settings.stt);
          })) as Segment[];

          transcribed.push(...segments);
        }

        if (transcribed.length === 0) {
          await settle(
            mode === 'full'
              ? '⚠️ No speech found in this video.'
              : '⚠️ That transcriber found no speech — the video you already have is untouched.',
          );
          await this.abandon(ffmpeg, assetJobId, mode === 'full');
          return;
        }

        // Nothing between here and the burn needs ffmpeg, and translating a
        // few hundred cues takes minutes. A container bills for its memory the
        // whole time it is awake, so it is stopped rather than left idling
        // through a phase that never touches it.
        await step.do('release-container', async () => {
          await ffmpeg.cleanup();
        });

        transcript = transcribed;
        // Filled by the translate stage below, which every speech-reading mode
        // runs — there is no path from here to the burn that skips it.
        cues = [];
      } else {
        const stored = (await step.do('load-cues', RETRY, async () => {
          const object = await env.MEDIA.get(keys.segments);
          if (!object) throw new NonRetryableError(EXPIRED);
          return object.json<StoredCues>();
        })) as StoredCues;

        meta = stored.meta;
        cues = stored.segments;
        transcript = stored.source ?? [];

        // Cues stored before transcripts were kept have nothing to re-translate
        // from. Burning the text already there beats failing outright, and the
        // ✏️ Edit card is still on the message to try something else.
        if (mode === 'retranslate' && transcript.length === 0) {
          await say('⚠️ No stored transcript for this video — re-burning the text it already has.');
        }
      }

      // 4. Translate a sentence at a time, then park both the transcript and
      //    the translation next to the video. Those objects are what let a
      //    later re-run restart from the middle instead of the top.
      if (translates && transcript.length > 0) {
        const translated = (await step.do('translate', longStep('5 minutes'), async () => {
          const language = shortLabel('targetLang', settings.targetLang);
          await say(`⏳ Translating ${transcript.length} lines to ${language}…`);
          return translateSegments(
            env,
            transcript,
            settings.sourceLang,
            settings.targetLang,
            settings.translator,
          );
        })) as Segment[];

        await step.do('store-cues', RETRY, async () => {
          await env.MEDIA.put(
            keys.segments,
            JSON.stringify({ meta, segments: translated, source: transcript } satisfies StoredCues),
          );
        });

        cues = translated;
      }

      // 5. Put the video back in front of ffmpeg. Both paths arrive here with
      //    no container: a first run stopped it before translating, and a
      //    re-burn never had one. Audio is skipped — the burn re-encodes the
      //    original track and nothing reads the extracted one.
      await step.do('load-video', longStep('5 minutes'), async () => {
        await say('⏳ Preparing to burn…');
        const object = await env.MEDIA.get(keys.input);
        if (!object) throw new NonRetryableError(EXPIRED);
        await ffmpeg.uploadVideo(await object.arrayBuffer(), { skipAudio: true });
      });

      // 6. Burn the Arabic in.
      await step.do('burn-subtitles', longStep('10 minutes'), async () => {
        await say('⏳ Burning captions into the video…');
        const font = FONTS[settings.font];

        const ass = buildAss(refitSegments(cues, Number(settings.chars)), {
          font: font.family,
          width: meta.width ?? 1280,
          height: meta.height ?? 720,
          rtl: isRtlLang(settings.targetLang),
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

        await this.withVideoLoaded(jobId, keys.input, burn, true);
        return { lines: cues.length };
      });

      // 7. Send it back.
      await step.do('deliver', RETRY, async () => {
        const object = await env.MEDIA.get(keys.output);
        if (!object) throw new Error('burned video missing from R2');
        await tg.sendVideo(chatId, await object.arrayBuffer(), { replyTo: messageId });
      });

      await step.do('cleanup', async () => {
        await settle('✅ Done.');
        await ffmpeg.cleanup();
        await this.forgetCancelToken(event.payload.cancelToken);
        // The input and the cues stay: they are what makes the ✏️ Edit card
        // below cheap. Closing that card drops them.
        await env.MEDIA.delete(keys.output);
      });

      // 8. Offer to change how it looks, for this video only.
      await step.do('offer-restyle', async () => {
        await sendEditCard(env, chatId, messageId, assetJobId, settings);
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[workflow] job ${jobId} failed:`, reason);
      await settle(`❌ Failed: ${reason}`);
      await ffmpeg.cleanup();
      await this.forgetCancelToken(event.payload.cancelToken);
      throw err;
    }
  }

  /**
   * Retire the ✖️ Stop button's token once the job is past stopping, so a late
   * tap says "already finished" instead of terminating nothing and deleting
   * files the ✏️ Edit card still needs.
   */
  private async forgetCancelToken(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.env.CAPTION_SETTINGS?.delete(cancelKey(token)).catch(() => {});
  }

  /**
   * Give up on a run that produced nothing worth sending.
   *
   * Stopping the container matters: it bills for provisioned memory the whole
   * time it is awake, so walking away without this leaves the idle timer to
   * charge for work that already ended.
   *
   * `purge` is false for every re-run. A first attempt that finds no speech has
   * nothing worth keeping, but a re-transcribe that comes back empty must not
   * take the delivered video's files with it — the user still has a good result
   * on the message above, and deleting its assets would strand the ✏️ Edit card.
   */
  private async abandon(
    ffmpeg: ReturnType<typeof ffmpegFor>,
    assetJobId: string,
    purge: boolean,
  ): Promise<void> {
    await ffmpeg.cleanup();
    if (!purge) return;
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
