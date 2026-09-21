import { reserveSlot } from './concurrency';
import { readProgress } from './progress';
import { ALL_FIELDS, defaults, isValid, loadSettings, type CaptionSettings } from '../captions/settings';
import type { Env } from '../types';

/** Thrown for anything wrong with the request itself — the caller turns this into the HTTP response. */
export class ApiJobError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface JobSubmission {
  jobId: string;
}

export interface JobStatusResponse {
  jobId: string;
  status: string;
  /** The latest progress line, e.g. "⏳ Transcribing… (2/5)". */
  progress?: string;
  error?: string;
}

/**
 * The settings a client's fields are laid over: API_SETTINGS_CHAT_ID's saved
 * /settings when it names a chat, otherwise the deployed defaults — so a
 * client only has to name what it wants to differ.
 */
async function baseSettings(env: Env): Promise<CaptionSettings> {
  const chatId = Number(env.API_SETTINGS_CHAT_ID);
  if (!env.API_SETTINGS_CHAT_ID || !Number.isSafeInteger(chatId)) return defaults(env);

  // The chat's own 📝/🖼 gates would pause on a Telegram card this job never
  // posts; only a client that asks for them explicitly is refused below.
  return { ...(await loadSettings(env, chatId)), review: 'off', preview: 'off' };
}

async function parseSettings(env: Env, input: unknown): Promise<CaptionSettings> {
  const settings = {
    ...(await baseSettings(env)),
    ...(input && typeof input === 'object' ? input : {}),
  } as CaptionSettings;

  for (const field of ALL_FIELDS) {
    if (!isValid(field, settings[field])) {
      throw new ApiJobError(`settings.${field}: "${settings[field]}" is not one of the options this bot offers`);
    }
  }

  // 📝 Check script pauses the run on a Telegram card with an .srt attached —
  // there is nothing to pause on over the API yet. 🖼 Check preview is the
  // same card, so it is rejected here rather than silently ignored: the
  // webhook channel declines the gate and burns straight through, and a client
  // that asked to approve a frame first would never learn it did not.
  for (const field of ['review', 'preview'] as const) {
    if (settings[field] === 'on') {
      throw new ApiJobError(
        `settings.${field} "on" is not supported over the API yet — set it to "off"`,
      );
    }
  }

  return settings;
}

/** Optional: a client with nowhere to receive callbacks polls `jobStatus` instead. */
function parseCallbackUrl(input: unknown): string | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input !== 'string') throw new ApiJobError('callbackUrl must be a string');
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new ApiJobError('callbackUrl must be a valid URL');
  }
  if (parsed.protocol !== 'https:') throw new ApiJobError('callbackUrl must be https://');
  return input;
}

/**
 * Queue a job from an API request body.
 *
 * `sourceUrl` goes through the same `resolveVideo`/`fetchMedia` path a
 * Telegram link does, so it is a supported social post URL (TikTok,
 * Instagram, YouTube, X, Facebook, Threads), not an arbitrary file link.
 */
export async function submitJob(env: Env, body: unknown): Promise<JobSubmission> {
  if (!env.CAPTION_WORKFLOW) throw new ApiJobError('the workflow binding is not configured', 500);
  if (typeof body !== 'object' || body === null) throw new ApiJobError('request body must be a JSON object');

  const req = body as Record<string, unknown>;
  if (typeof req.sourceUrl !== 'string' || !req.sourceUrl) {
    throw new ApiJobError('sourceUrl is required');
  }

  const callbackUrl = parseCallbackUrl(req.callbackUrl);
  const settings = await parseSettings(env, req.settings);

  const jobId = crypto.randomUUID();
  if (!(await reserveSlot(env, jobId))) {
    throw new ApiJobError('the API is at capacity right now — try again shortly', 429);
  }

  await env.CAPTION_WORKFLOW.create({
    id: jobId,
    params: {
      jobId,
      sourceUrl: req.sourceUrl,
      settings,
      channel: callbackUrl ? { type: 'webhook', callbackUrl } : { type: 'webhook' },
    },
  });

  return { jobId };
}

/** Poll a job's state — the only progress a job submitted without a callbackUrl reports. */
export async function jobStatus(env: Env, jobId: string): Promise<JobStatusResponse> {
  if (!env.CAPTION_WORKFLOW) throw new ApiJobError('the workflow binding is not configured', 500);

  try {
    const instance = await env.CAPTION_WORKFLOW.get(jobId);
    const [status, progress] = await Promise.all([instance.status(), readProgress(env, jobId)]);
    return { jobId, status: status.status, progress, error: status.error?.message };
  } catch {
    throw new ApiJobError('no such job', 404);
  }
}
