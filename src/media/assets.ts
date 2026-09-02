import type { Env } from '../types';

/**
 * The R2 objects a job leaves behind.
 *
 * The input video and the translated cues outlive the run that produced them,
 * because a restyle re-burns from exactly these two and re-fetching or
 * re-transcribing would cost far more than the storage does. They are dropped
 * when the user closes the ✏️ Edit card — set a lifecycle rule on the `jobs/`
 * prefix as a backstop for the cards nobody ever taps.
 */
export const assetKeys = (jobId: string) => ({
  input: `jobs/${jobId}/input.mp4`,
  output: `jobs/${jobId}/output.mp4`,
  segments: `jobs/${jobId}/segments.json`,
});

/** Drop everything a job stored. Safe to call twice. */
export async function purgeAssets(env: Env, jobId: string): Promise<void> {
  const keys = assetKeys(jobId);
  await env.MEDIA.delete([keys.input, keys.output, keys.segments]).catch((err) => {
    console.error(`[assets] purge failed for ${jobId}:`, err);
  });
}
