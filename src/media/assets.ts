import type { CaptionSettings } from '../captions/settings';
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
  /**
   * The text the video arrived with — typed or forwarded with an upload, or a
   * linked post's own caption — as it came. Only the 📣 Post text reads it.
   */
  caption: `jobs/${jobId}/caption.txt`,
  /** An API job's post text, one entry per language — see `write-post-text` in workflow.ts. */
  post: `jobs/${jobId}/post.json`,
  /**
   * The settings an API job's current output was burned with, written when it
   * is delivered. A re-run is measured against it — `pickMode` needs the
   * before to choose a depth — and it only exists once there is a video.
   */
  settings: `jobs/${jobId}/settings.json`,
});

/**
 * Separates an API re-run's id from the job whose files it re-burns:
 * `<assetJobId>__<tag>`. Neither a UUID nor an `api-<hex>` id contains it.
 */
const RERUN_SEPARATOR = '__';

/** The job whose R2 prefix `jobId` works under — itself, unless it is an API re-run. */
export const assetJobIdOf = (jobId: string): string => jobId.split(RERUN_SEPARATOR)[0];

export const rerunJobId = (assetJobId: string, tag: string): string => `${assetJobId}${RERUN_SEPARATOR}${tag}`;

/** The settings an API job's delivered video was made with, or null if it has none (yet, or any more). */
export async function loadJobSettings(env: Env, jobId: string): Promise<CaptionSettings | null> {
  const object = await env.MEDIA.get(assetKeys(jobId).settings);
  return object ? await object.json<CaptionSettings>() : null;
}

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

/** The text the video arrived with, or null if it had none or it expired. */
export async function loadPostCaption(env: Env, jobId: string): Promise<string | null> {
  const object = await env.MEDIA.get(assetKeys(jobId).caption);
  return object ? await object.text() : null;
}

/** The post text an API job wrote, by language code, or null if none was written or it expired. */
export async function loadPostText(env: Env, jobId: string): Promise<Record<string, string> | null> {
  const object = await env.MEDIA.get(assetKeys(jobId).post);
  return object ? await object.json<Record<string, string>>() : null;
}

/** Drop everything a job stored. Safe to call twice. */
export async function purgeAssets(env: Env, jobId: string): Promise<void> {
  const keys = assetKeys(jobId);
  await env.MEDIA.delete([keys.input, keys.output, keys.segments, keys.caption, keys.post, keys.settings]).catch((err) => {
    console.error(`[assets] purge failed for ${jobId}:`, err);
  });
}
