import { buildSingleSrt, buildSrt } from '../bot/edit/script';
import type { CaptionSettings } from '../captions/settings';
import type { CaptionJob, Env, StoredCues } from '../types';

/**
 * The request log in D1. Best-effort by design: a database hiccup must never
 * fail a caption job, so every write swallows and logs its error.
 */
async function run(env: Env, what: string, statement: D1PreparedStatement | undefined): Promise<void> {
  if (!statement) return;
  await statement.run().catch((err) => console.error(`[db] ${what} failed:`, err));
}

/** Insert the request when a first run starts. A retried step is a no-op. */
export async function recordRequest(env: Env, job: CaptionJob): Promise<void> {
  const now = Date.now();
  await run(
    env,
    'recordRequest',
    env.DB?.prepare(
      `INSERT OR IGNORE INTO requests
        (job_id, channel, chat_id, source_type, source_url, telegram_file_id, post_caption, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    ).bind(
      job.jobId,
      job.channel?.type === 'webhook' ? 'api' : 'telegram',
      job.chatId ?? null,
      job.sourceUrl ? 'url' : 'upload',
      job.sourceUrl ?? null,
      job.sourceUrl ? null : (job.fileId ?? null),
      job.postCaption ?? null,
      now,
      now,
    ),
  );
}

/** Keep the script (as .srt and as cues) next to the request. */
export async function recordScript(env: Env, assetJobId: string, stored: StoredCues, settings: CaptionSettings): Promise<void> {
  await run(
    env,
    'recordScript',
    env.DB?.prepare(
      `UPDATE requests SET source_lang = ?, target_lang = ?, source_srt = ?, target_srt = ?, script_srt = ?,
        segments = ?, duration = ?, updated_at = ? WHERE job_id = ?`,
    ).bind(
      settings.sourceLang,
      settings.targetLang,
      buildSingleSrt(stored, 'source'),
      buildSingleSrt(stored, 'target'),
      buildSrt(stored),
      JSON.stringify(stored),
      stored.meta.duration,
      Date.now(),
      assetJobId,
    ),
  );
}

/** Sync hand-corrected cues (✍️ Fix text). Languages are untouched: an edit never changes them. */
export async function recordCorrection(env: Env, assetJobId: string, stored: StoredCues): Promise<void> {
  await run(
    env,
    'recordCorrection',
    env.DB?.prepare(
      `UPDATE requests SET source_srt = ?, target_srt = ?, script_srt = ?, segments = ?, updated_at = ?
       WHERE job_id = ?`,
    ).bind(
      buildSingleSrt(stored, 'source'),
      buildSingleSrt(stored, 'target'),
      buildSrt(stored),
      JSON.stringify(stored),
      Date.now(),
      assetJobId,
    ),
  );
}

/** Note where the delivered video's thumbnail is kept in R2, and the frame size it stands for. */
export async function recordThumbnail(
  env: Env,
  assetJobId: string,
  key: string,
  width?: number,
  height?: number,
): Promise<void> {
  await run(
    env,
    'recordThumbnail',
    env.DB?.prepare(
      'UPDATE requests SET thumb_key = ?, thumb_width = ?, thumb_height = ?, updated_at = ? WHERE job_id = ?',
    ).bind(key, width ?? null, height ?? null, Date.now(), assetJobId),
  );
}

export async function recordStatus(
  env: Env,
  assetJobId: string,
  status: 'running' | 'done' | 'failed',
  extra: { settings?: CaptionSettings; error?: string } = {},
): Promise<void> {
  await run(
    env,
    'recordStatus',
    env.DB?.prepare(
      'UPDATE requests SET status = ?, settings = COALESCE(?, settings), error = ?, updated_at = ? WHERE job_id = ?',
    ).bind(status, extra.settings ? JSON.stringify(extra.settings) : null, extra.error ?? null, Date.now(), assetJobId),
  );
}
