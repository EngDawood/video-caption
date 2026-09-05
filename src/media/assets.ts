import type { Env, StoredCues } from '../types';

/**
 * The R2 objects a job leaves behind.
 *
 * The input video and the translated cues outlive the run that produced them,
 * because a restyle re-burns from exactly these two and re-fetching or
 * re-transcribing would cost far more than the storage does. They are dropped
 * when the user closes the ✏️ Edit card; `npm run r2-lifecycle` installs the
 * backstop for the cards nobody ever taps.
 */
export const assetKeys = (jobId: string) => ({
  input: `jobs/${jobId}/input.mp4`,
  output: `jobs/${jobId}/output.mp4`,
  segments: `jobs/${jobId}/segments.json`,
});

/** The cues a finished run stored, or null once they have expired. */
export async function loadCues(env: Env, jobId: string): Promise<StoredCues | null> {
  const object = await env.MEDIA.get(assetKeys(jobId).segments);
  return object ? await object.json<StoredCues>() : null;
}

/**
 * Replace the stored cues.
 *
 * The ✍️ Fix text flow writes through here, which is what makes a corrected
 * line survive: the next `restyle` loads exactly this object and burns it.
 */
export async function saveCues(env: Env, jobId: string, cues: StoredCues): Promise<void> {
  await env.MEDIA.put(assetKeys(jobId).segments, JSON.stringify(cues));
}

/** Drop everything a job stored. Safe to call twice. */
export async function purgeAssets(env: Env, jobId: string): Promise<void> {
  const keys = assetKeys(jobId);
  await env.MEDIA.delete([keys.input, keys.output, keys.segments]).catch((err) => {
    console.error(`[assets] purge failed for ${jobId}:`, err);
  });
}
