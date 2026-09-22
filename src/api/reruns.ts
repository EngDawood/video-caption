import { encodeSettings } from '../captions/settings';
import { applyCorrections, parseClock, tidy, type Correction } from '../bot/edit/corrections';
import { pickMode, revisionOf } from '../bot/edit/rerun';
import { assetJobIdOf, assetKeys, loadCues, loadJobSettings, purgeAssets, rerunJobId, saveCues } from '../media/assets';
import { ffmpegFor } from '../media/ffmpeg';
import { releaseSlot } from './concurrency';
import { ApiJobError, parseSettings, startApiRun } from './jobs';
import { recordProgress } from './progress';
import type { CaptionJob, Env } from '../types';

/**
 * Acting on an API job after it was submitted: stopping it, and the two
 * re-runs the Telegram ✏️ Edit card offers — a restyle and ✍️ Fix text.
 *
 * A re-run is its own Workflow instance working under the original job's R2
 * prefix (`assetJobId`), so it has its own id for `job_status` while
 * `get_output` on either id returns the latest burn.
 */

const NOT_DELIVERED =
  'that job has no delivered video to change — wait until job_status says complete, or it has expired';

const TERMINAL = new Set(['complete', 'errored', 'terminated']);

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The id for a re-run of `assetJobId` that burns `what`.
 *
 * Deterministic, so a retried request lands on the run the first one started
 * instead of paying for a second encode. The current output's etag is part of
 * it: once a re-run has replaced the video, asking for an earlier look again
 * is a new burn, not a repeat of the one already done.
 */
async function rerunId(env: Env, assetJobId: string, mode: CaptionJob['mode'], what: string): Promise<string> {
  const output = await env.MEDIA.head(assetKeys(assetJobId).output);
  return rerunJobId(assetJobId, `${mode}-${await shortHash(`${what}|${output?.etag ?? ''}`)}`);
}

export interface CancelResult {
  jobId: string;
  cancelled: boolean;
  status: string;
}

/**
 * Stop a job that is still running — the API's ✖️ Stop.
 *
 * A first run's files are deleted with it, as Telegram's Stop does. A re-run's
 * are not: they belong to a video the client already has, the same rule
 * `abandon(..., purge)` follows.
 */
export async function cancelJob(env: Env, jobId: string): Promise<CancelResult> {
  const instance = await env.CAPTION_WORKFLOW.get(jobId).catch(() => null);
  if (!instance) throw new ApiJobError('no such job', 404);

  const { status } = await instance.status();
  if (TERMINAL.has(status)) return { jobId, cancelled: false, status };

  await instance.terminate();
  await ffmpegFor(env, jobId).cleanup();
  await releaseSlot(env, jobId);
  if (assetJobIdOf(jobId) === jobId) await purgeAssets(env, jobId);
  await recordProgress(env, jobId, '✖️ Cancelled.');
  return { jobId, cancelled: true, status: 'terminated' };
}

export interface RerunResult {
  /** The re-run's own id, for job_status. */
  jobId: string;
  /** How deep it goes: restyle (one encode), retranslate, or retranscribe. */
  mode: NonNullable<CaptionJob['mode']>;
}

/**
 * Re-burn a delivered video with some settings changed, at the shallowest
 * depth that serves the change — `pickMode`, exactly as the ✏️ Edit card does.
 * A font or position change costs one encode; a new target language, one
 * translation and an encode; only the transcriber or source language reads
 * the speech again.
 */
export async function restyleJob(env: Env, jobId: string, changes: unknown): Promise<RerunResult> {
  const assetJobId = assetJobIdOf(jobId);
  const was = await loadJobSettings(env, assetJobId);
  if (!was) throw new ApiJobError(NOT_DELIVERED, 409);

  const draft = await parseSettings(env, changes, was);
  const code = encodeSettings(draft);
  if (code === encodeSettings(was)) {
    throw new ApiJobError('those are the settings the video already has — name at least one field to change');
  }

  const mode = pickMode(was, draft) ?? 'restyle';
  const id = await rerunId(env, assetJobId, mode, code);
  await startApiRun(env, id, { mode, assetJobId, settings: draft, channel: { type: 'webhook' } });
  return { jobId: id, mode };
}

export interface ScriptCorrection {
  /** The cue's start time as the script shows it, e.g. `00:00:12,400`. */
  start: string;
  /** The corrected caption. */
  text?: string;
  /** Drop the cue instead. */
  remove?: boolean;
}

export interface FixResult extends RerunResult {
  updated: number;
  deleted: number;
  /** Start times that matched no cue and were skipped. */
  missed: string[];
}

/**
 * ✍️ Fix text over the API: rewrite or drop captions, then re-burn.
 *
 * The corrections go into the stored cues first — the same object the
 * Telegram paste-back writes — and the burn is a plain `restyle` with the
 * video's own settings, because a restyle burns whatever those cues hold.
 * Cues are matched on start time within 0.6 s, so a timestamp copied out of
 * `get_output`'s script finds its line even after other lines were removed.
 */
export async function fixScript(env: Env, jobId: string, input: ScriptCorrection[]): Promise<FixResult> {
  const assetJobId = assetJobIdOf(jobId);
  const [was, stored] = await Promise.all([loadJobSettings(env, assetJobId), loadCues(env, assetJobId)]);
  if (!was || !stored) throw new ApiJobError(NOT_DELIVERED, 409);
  if (input.length === 0) throw new ApiJobError('corrections is empty');

  const corrections = input.map((c): Correction => {
    const start = parseClock(c.start);
    if (start === null) throw new ApiJobError(`"${c.start}" is not a timestamp — copy it from the script`);
    if (c.remove) return { start, remove: true };
    const target = tidy(c.text ?? '');
    if (!target) throw new ApiJobError(`the correction at ${c.start} needs text, or remove: true`);
    return { start, target };
  });

  const applied = applyCorrections(stored, corrections);
  if ('error' in applied) throw new ApiJobError(applied.error);
  await saveCues(env, assetJobId, stored);

  // The wording is part of the id: the same settings over reworded cues is a
  // burn the client is owed, not a repeat of the last one.
  const id = await rerunId(env, assetJobId, 'restyle', `${encodeSettings(was)}|${revisionOf(stored.segments)}`);
  await startApiRun(env, id, { mode: 'restyle', assetJobId, settings: was, channel: { type: 'webhook' } });

  return {
    jobId: id,
    mode: 'restyle',
    updated: applied.patched.length - applied.doomed.size,
    deleted: applied.doomed.size,
    missed: applied.missed,
  };
}
