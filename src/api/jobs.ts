import { reserveSlot } from './concurrency';
import { ALL_FIELDS, defaults, isValid, type CaptionSettings } from '../captions/settings';
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
  error?: string;
}

/**
 * Every field is required — there is no chat to fall back to defaults from,
 * unlike a Telegram job. `defaults(env)` seeds the deployed vars so a client
 * only has to name what it wants to differ.
 */
function parseSettings(env: Env, input: unknown): CaptionSettings {
  const settings = { ...defaults(env), ...(input && typeof input === 'object' ? input : {}) } as CaptionSettings;

  for (const field of ALL_FIELDS) {
    if (!isValid(field, settings[field])) {
      throw new ApiJobError(`settings.${field}: "${settings[field]}" is not one of the options this bot offers`);
    }
  }

  // 📝 Check script pauses the run on a Telegram card with an .srt attached —
  // there is nothing to pause on over the API yet.
  if (settings.review === 'on') {
    throw new ApiJobError('settings.review "on" is not supported over the API yet — set it to "off"');
  }

  return settings;
}

function parseCallbackUrl(input: unknown): string {
  if (typeof input !== 'string' || !input) throw new ApiJobError('callbackUrl is required');
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
  const settings = parseSettings(env, req.settings);

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
      channel: { type: 'webhook', callbackUrl },
    },
  });

  return { jobId };
}

/** Poll a job's state — a supplement to the callback, not a replacement for it. */
export async function jobStatus(env: Env, jobId: string): Promise<JobStatusResponse> {
  if (!env.CAPTION_WORKFLOW) throw new ApiJobError('the workflow binding is not configured', 500);

  try {
    const instance = await env.CAPTION_WORKFLOW.get(jobId);
    const status = await instance.status();
    return { jobId, status: status.status, error: status.error?.message };
  } catch {
    throw new ApiJobError('no such job', 404);
  }
}
