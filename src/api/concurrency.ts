import type { Env } from '../types';

/**
 * A soft cap on concurrent API-originated jobs, tracked in KV since the
 * Workflow binding exposes no "list running instances" call to check against
 * the container's own ceiling directly.
 *
 * Deliberately lower than `max_instances: 5` in wrangler.jsonc's `containers`
 * block: a Telegram job can be running on that same pool at any moment, and
 * this guard only ever sees the API's own share of it.
 */
const LIMIT = 3;

/** Self-clears even if a run's terminal `releaseSlot` call is missed. */
const TTL_SECONDS = 30 * 60;

const key = (jobId: string) => `api:running:${jobId}`;

/** Reserve a slot for a new job. False means the API is at capacity right now. */
export async function reserveSlot(env: Env, jobId: string): Promise<boolean> {
  const kv = env.CAPTION_SETTINGS;
  // No KV bound means nothing to count with — fail open rather than block
  // every submission on a namespace this deploy never configured.
  if (!kv) return true;

  const running = await kv.list({ prefix: 'api:running:' });
  if (running.keys.length >= LIMIT) return false;

  await kv.put(key(jobId), '1', { expirationTtl: TTL_SECONDS });
  return true;
}

/** Free a job's slot once its run has ended, success or failure. */
export async function releaseSlot(env: Env, jobId: string): Promise<void> {
  await env.CAPTION_SETTINGS?.delete(key(jobId)).catch(() => {});
}
