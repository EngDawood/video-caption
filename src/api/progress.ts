import type { Env } from '../types';

/**
 * The latest progress line of an API job, kept for `jobStatus` to read back.
 *
 * The Workflow binding reports only running/complete, never which stage a run
 * is in, and a job submitted without a `callbackUrl` has nowhere else to hear
 * it. KV is eventually consistent, so a poll can lag a stage behind — fine for
 * a status line, which the next poll corrects.
 */
const key = (jobId: string) => `api:progress:${jobId}`;

/** As long as the job's assets live in R2 — past that there is nothing left to ask about. */
const TTL_SECONDS = 2 * 24 * 60 * 60;

export async function recordProgress(env: Env, jobId: string, line: string): Promise<void> {
  await env.CAPTION_SETTINGS?.put(key(jobId), line, { expirationTtl: TTL_SECONDS }).catch((err) => {
    console.error(`[progress] could not record for ${jobId}:`, err);
  });
}

export async function readProgress(env: Env, jobId: string): Promise<string | undefined> {
  return (await env.CAPTION_SETTINGS?.get(key(jobId)).catch(() => null)) ?? undefined;
}
