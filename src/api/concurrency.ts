import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';

/**
 * A cap on concurrent API-originated jobs, since the Workflow binding exposes
 * no "list running instances" call to check against the container's own
 * ceiling directly.
 *
 * Deliberately lower than `max_instances: 5` in wrangler.jsonc's `containers`
 * block: a Telegram job can be running on that same pool at any moment, and
 * this guard only ever sees the API's own share of it.
 */
const LIMIT = 3;

/** Self-clears even if a run's terminal `releaseSlot` call is missed. */
const TTL_MS = 30 * 60 * 1000;

/**
 * The slot table, as one Durable Object for the whole API.
 *
 * This used to be a KV prefix counted with `list()`, which is eventually
 * consistent: two submissions a moment apart could both count two running
 * jobs and both take the third slot. A Durable Object runs one call at a
 * time, and each method here is synchronous SQL with no await between the
 * count and the insert, so the check and the claim cannot interleave.
 */
export class ApiSlots extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS slots (job_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
  }

  reserve(jobId: string): boolean {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec('DELETE FROM slots WHERE expires_at <= ?', now);
    const { n } = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM slots').one();
    if (n >= LIMIT) return false;
    sql.exec('INSERT OR REPLACE INTO slots (job_id, expires_at) VALUES (?, ?)', jobId, now + TTL_MS);
    return true;
  }

  release(jobId: string): void {
    this.ctx.storage.sql.exec('DELETE FROM slots WHERE job_id = ?', jobId);
  }
}

const slots = (env: Env) => env.API_SLOTS.getByName('api');

/** Reserve a slot for a new job. False means the API is at capacity right now. */
export async function reserveSlot(env: Env, jobId: string): Promise<boolean> {
  return slots(env).reserve(jobId);
}

/** Free a job's slot once its run has ended, success or failure. */
export async function releaseSlot(env: Env, jobId: string): Promise<void> {
  await slots(env)
    .release(jobId)
    .catch((err) => console.error(`[concurrency] could not release ${jobId}:`, err));
}
