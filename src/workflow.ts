import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
  type WorkflowTimeoutDuration,
} from 'cloudflare:workers';
import { transcribeChunk, translateSegments } from './ai';
import { ffmpegFor } from './ffmpeg';
import { buildAss } from './subtitles';
import { telegram } from './telegram';
import type { CaptionJob, Env, Segment, VideoMeta } from './types';

const RETRY: WorkflowStepConfig = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
};

const longStep = (timeout: WorkflowTimeoutDuration): WorkflowStepConfig => ({ ...RETRY, timeout });

export class CaptionWorkflow extends WorkflowEntrypoint<Env, CaptionJob> {
  async run(event: WorkflowEvent<CaptionJob>, step: WorkflowStep) {
    const { jobId, chatId, messageId, fileId, statusMessageId } = event.payload;
    const env = this.env;
    const tg = telegram(env.TELEGRAM_BOT_TOKEN);
    const ffmpeg = ffmpegFor(env, jobId);
    const inputKey = `jobs/${jobId}/input.mp4`;
    const outputKey = `jobs/${jobId}/output.mp4`;

    const say = (text: string) =>
      statusMessageId
        ? tg.editMessageText(chatId, statusMessageId, text)
        : tg.sendMessage(chatId, text).catch(() => null);

    try {
      // 1. Get the source video out of Telegram and into R2, so later steps can
      //    re-read it without hitting the Bot API again.
      await step.do('fetch-video', RETRY, async () => {
        const bytes = await tg.download(fileId);
        await env.MEDIA.put(inputKey, bytes);
        return { bytes: bytes.byteLength };
      });

      // 2. Hand it to ffmpeg, which extracts a 16 kHz mono track for the ASR model.
      const meta = (await step.do('extract-audio', longStep('5 minutes'), async () => {
        await say('⏳ Extracting audio…');
        const object = await env.MEDIA.get(inputKey);
        if (!object) throw new Error('input video missing from R2');
        return ffmpeg.uploadVideo(await object.arrayBuffer());
      })) as VideoMeta;

      const maxSeconds = Number(env.MAX_VIDEO_SECONDS || 900);
      if (meta.duration > maxSeconds) {
        await say(`⚠️ Video is ${Math.round(meta.duration)}s, limit is ${maxSeconds}s.`);
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
          const audio = await this.withVideoLoaded(jobId, inputKey, () => ffmpeg.audioSlice(start, dur));
          return transcribeChunk(env, audio, start, dur);
        })) as Segment[];

        transcribed.push(...segments);
      }

      if (transcribed.length === 0) {
        await say('⚠️ No speech found in this video.');
        return;
      }

      // 4. Translate each cue.
      const translated = (await step.do('translate', longStep('5 minutes'), async () => {
        await say(`⏳ Translating ${transcribed.length} lines to Arabic…`);
        return translateSegments(env, transcribed);
      })) as Segment[];

      // 5. Burn the Arabic in.
      await step.do('burn-subtitles', longStep('10 minutes'), async () => {
        await say('⏳ Burning captions into the video…');
        const ass = buildAss(translated, {
          font: env.SUBTITLE_FONT,
          width: meta.width ?? 1280,
          height: meta.height ?? 720,
          rtl: (env.TARGET_LANG || 'ar') === 'ar',
          preset: env.CAPTION_PRESET,
          size: env.CAPTION_SIZE,
          position: env.CAPTION_POSITION,
          allowBold: env.SUBTITLE_FONT_BOLD === 'true',
        });

        await this.withVideoLoaded(jobId, inputKey, async () => {
          await ffmpeg.putSubtitles(ass);
          const burned = await ffmpeg.burn();
          await env.MEDIA.put(outputKey, burned);
          return burned;
        });
        return { lines: translated.length };
      });

      // 6. Send it back.
      await step.do('deliver', RETRY, async () => {
        const object = await env.MEDIA.get(outputKey);
        if (!object) throw new Error('burned video missing from R2');
        await tg.sendVideo(chatId, await object.arrayBuffer(), { replyTo: messageId });
      });

      await step.do('cleanup', async () => {
        await say('✅ Done.');
        await ffmpeg.cleanup();
        await env.MEDIA.delete([inputKey, outputKey]);
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
   * The container's disk is ephemeral and a retried step may land on a fresh
   * instance, so re-push the source video if it reports the job is gone.
   */
  private async withVideoLoaded<T>(jobId: string, inputKey: string, fn: () => Promise<T>): Promise<T> {
    const ffmpeg = ffmpegFor(this.env, jobId);
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/no_audio_extracted|no_video|409/.test(message)) throw err;

      const object = await this.env.MEDIA.get(inputKey);
      if (!object) throw err;
      await ffmpeg.uploadVideo(await object.arrayBuffer());
      return fn();
    }
  }
}

export type { VideoMeta };
