import type { Env, VideoMeta } from './types';

const BASE = 'http://ffmpeg';

async function unwrap(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  let detail = await res.text().catch(() => '');
  if (detail.length > 800) detail = `${detail.slice(0, 800)}…`;
  throw new Error(`ffmpeg ${what} failed (${res.status}): ${detail}`);
}

/**
 * Talks to the ffmpeg container instance dedicated to this job.
 * Every call routes to the same instance, so state on its disk persists.
 */
export function ffmpegFor(env: Env, jobId: string) {
  const stub = env.FFMPEG.getByName(jobId);

  return {
    /** Hand over the source video; returns duration/dimensions and extracts the audio track. */
    async uploadVideo(video: ArrayBuffer): Promise<VideoMeta> {
      const res = await stub.fetch(`${BASE}/job/video`, {
        method: 'POST',
        body: video,
        headers: { 'content-type': 'application/octet-stream' },
      });
      if (res.status === 422) throw new Error('no_audio_track');
      return (await unwrap(res, 'upload')).json() as Promise<VideoMeta>;
    },

    /** Pull `dur` seconds of audio starting at `start` (seconds). */
    async audioSlice(start: number, dur: number): Promise<ArrayBuffer> {
      const res = await stub.fetch(`${BASE}/job/audio?start=${start}&dur=${dur}`);
      return (await unwrap(res, 'audio slice')).arrayBuffer();
    },

    async putSubtitles(ass: string): Promise<void> {
      const res = await stub.fetch(`${BASE}/job/subs`, {
        method: 'PUT',
        body: ass,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
      await unwrap(res, 'subtitle upload');
    },

    /** Hardsub the stored ASS onto the stored video. */
    async burn(opts: { crf?: number; preset?: string } = {}): Promise<ArrayBuffer> {
      const params = new URLSearchParams();
      if (opts.crf) params.set('crf', String(opts.crf));
      if (opts.preset) params.set('preset', opts.preset);
      const res = await stub.fetch(`${BASE}/job/burn?${params}`, { method: 'POST' });
      return (await unwrap(res, 'burn')).arrayBuffer();
    },

    /**
     * Clear the job directory and stop the instance.
     *
     * Stopping matters for cost: a container bills for provisioned memory and
     * disk the whole time it is awake, and it stays awake for `sleepAfter`
     * after the last request. Ending it here means a job is billed for the work
     * it did rather than the work plus the idle timer.
     */
    async cleanup(): Promise<void> {
      await stub.fetch(`${BASE}/job`, { method: 'DELETE' }).catch(() => {});
      await stub.stop().catch(() => {});
    },
  };
}
