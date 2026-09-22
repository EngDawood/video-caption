import type { Env, VideoMeta } from '../types';

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
    /**
     * Hand over the source video; returns duration/dimensions and, unless
     * `skipAudio` is set, extracts the audio track. A re-burn passes
     * `skipAudio` — it already has the transcript, so the audio pass would be
     * work nothing reads.
     *
     * Streamed straight from R2 rather than read into memory first: a video
     * near MAX_SOURCE_MB, buffered here and again on the way back from the
     * burn, is most of a Worker's 128 MB. The container writes the request
     * body to disk as it arrives.
     */
    async uploadVideo(video: R2ObjectBody, opts: { skipAudio?: boolean } = {}): Promise<VideoMeta> {
      const res = await stub.fetch(`${BASE}/job/video${opts.skipAudio ? '?audio=skip' : ''}`, {
        method: 'POST',
        body: video.body.pipeThrough(new FixedLengthStream(video.size)),
        headers: { 'content-type': 'application/octet-stream' },
      });
      if (res.status === 422) throw new Error('no_audio_track');
      return (await unwrap(res, 'upload')).json() as Promise<VideoMeta>;
    },

    /** Pull `dur` seconds of audio starting at `start` (seconds). */
    /** `lead` prepends that many seconds of silence — see `handleAudio`. */
    async audioSlice(start: number, dur: number, lead = 0): Promise<ArrayBuffer> {
      const res = await stub.fetch(`${BASE}/job/audio?start=${start}&dur=${dur}&lead=${lead}`);
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

    /**
     * Hardsub the stored ASS onto the stored video and stream the result into
     * `bucket` at `key`, never holding the MP4 in memory. The container sends
     * a content-length, which R2 needs for a streamed put.
     */
    async burnTo(bucket: R2Bucket, key: string, opts: { crf?: number; preset?: string } = {}): Promise<void> {
      const params = new URLSearchParams();
      if (opts.crf) params.set('crf', String(opts.crf));
      if (opts.preset) params.set('preset', opts.preset);
      const res = await unwrap(await stub.fetch(`${BASE}/job/burn?${params}`, { method: 'POST' }), 'burn');
      const size = Number(res.headers.get('content-length'));
      if (!res.body || !Number.isSafeInteger(size) || size <= 0) throw new Error('ffmpeg burn returned no sized body');
      await bucket.put(key, res.body.pipeThrough(new FixedLengthStream(size)), {
        httpMetadata: { contentType: 'video/mp4' },
      });
    },

    /** One jpeg frame near `at` seconds, with the stored subtitles burned in. */
    async previewFrame(at: number): Promise<ArrayBuffer> {
      const res = await stub.fetch(`${BASE}/job/preview?at=${encodeURIComponent(String(at))}`);
      return (await unwrap(res, 'preview')).arrayBuffer();
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
