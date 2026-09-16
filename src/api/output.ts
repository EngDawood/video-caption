import { assetKeys } from '../media/assets';
import type { Env } from '../types';

/**
 * Where a finished API job's video can be fetched from.
 *
 * Workflows run with no request to read an origin from, so the host comes
 * from `API_BASE_URL` when it is set. Left unset, the link is a bare path —
 * fine for a client calling this Worker on a host it already knows.
 */
export function outputUrl(env: Env, jobId: string): string {
  const base = (env.API_BASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/api/jobs/${jobId}/output`;
}

/**
 * The burned video for a finished API job, or null if it was never produced,
 * already fetched, or has aged out of the `r2-lifecycle` rule.
 *
 * Only a webhook-channel job's output survives past delivery — see the
 * `cleanup` step in `workflow.ts` — so this is the only kind `GET
 * /api/jobs/{id}/output` can ever serve.
 */
export async function getOutput(env: Env, jobId: string): Promise<R2ObjectBody | null> {
  return env.MEDIA.get(assetKeys(jobId).output);
}
