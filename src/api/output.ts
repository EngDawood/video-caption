import { assetJobIdOf, assetKeys } from '../media/assets';
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

/** Long enough to open the link later that day; R2 expires the video after two anyway. */
const SIGNED_LINK_SECONDS = 24 * 60 * 60;

async function hmac(key: string, message: string): Promise<ArrayBuffer> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(message));
}

const signature = (key: string, jobId: string, expires: number) => hmac(key, `output:${jobId}:${expires}`);

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Headers proving a callback came from this Worker: HMAC-SHA256 with API_KEY
 * over `${timestamp}.${body}`. The timestamp is inside the signature so a
 * captured callback cannot be replayed later with a fresh one; a receiver
 * should reject a timestamp more than a few minutes old.
 */
export async function callbackSignature(env: Env, body: string): Promise<Record<string, string>> {
  if (!env.API_KEY) return {};
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = toHex(await hmac(env.API_KEY, `${timestamp}.${body}`));
  return { 'x-signature-timestamp': timestamp, 'x-signature': `sha256=${sig}` };
}

/**
 * `outputUrl` with an expiring HMAC instead of a credential, for a link shown to
 * a person in a chat — it opens in a browser and never exposes `API_KEY`.
 */
export async function signedOutputUrl(env: Env, jobId: string): Promise<string> {
  if (!env.API_KEY) throw new Error('API_KEY is not set');
  const expires = Math.floor(Date.now() / 1000) + SIGNED_LINK_SECONDS;
  const sig = toHex(await signature(env.API_KEY, jobId, expires));
  return `${outputUrl(env, jobId)}?exp=${expires}&sig=${sig}`;
}

export async function hasValidSignature(env: Env, jobId: string, url: URL): Promise<boolean> {
  const expires = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') ?? '';
  if (!env.API_KEY || !Number.isInteger(expires) || expires < Date.now() / 1000 || !/^[0-9a-f]{64}$/.test(sig)) {
    return false;
  }
  const expected = new TextEncoder().encode(toHex(await signature(env.API_KEY, jobId, expires)));
  return crypto.subtle.timingSafeEqual(expected, new TextEncoder().encode(sig));
}

/**
 * The burned video for a finished API job, or null if it was never produced,
 * already fetched, or has aged out of the `r2-lifecycle` rule.
 *
 * A Telegram job's output is kept too, for 📤 Share to hand the platforms a
 * signed link to it, and goes when its ✏️ card is closed.
 */
export async function getOutput(env: Env, jobId: string): Promise<R2ObjectBody | null> {
  // A re-run's id reads the video it re-burned, which lives under the original's prefix.
  return env.MEDIA.get(assetKeys(assetJobIdOf(jobId)).output);
}
