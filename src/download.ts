import { NonRetryableError } from 'cloudflare:workflows';
import type { Env } from './types';

const DEFAULT_BASE = 'https://dl.engdawood.com';

/**
 * Hosts accepted without a scheme, because people paste "vm.tiktok.com/xyz"
 * bare. Anything carrying an explicit http(s):// is passed through as-is and
 * the API decides whether it can handle it.
 */
const SOCIAL_HOSTS =
  /^(?:www\.|m\.|mobile\.|vm\.|vt\.)?(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|douyin\.com|twitter\.com|x\.com|facebook\.com|fb\.watch|fb\.com|threads\.net|threads\.com|soundcloud\.com|spotify\.com|pinterest\.com|pin\.it)$/i;

const CANDIDATE = /(?:https?:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s]*)?/gi;

/**
 * Ceiling on a video pulled from a social link. Telegram caps what a bot may
 * upload at 50 MB, and burning captions re-encodes rather than shrinks, so a
 * source near that cap can produce an undeliverable result.
 */
export const maxSourceBytes = (env: Env): number => Number(env.MAX_SOURCE_MB || 45) * 1024 * 1024;

export interface ResolvedMedia {
  url: string;
  platform: string;
  /** Poster image for the confirm card. Optional — not every platform has one. */
  thumbnail?: string;
  quality?: string;
  filesize?: number;
}

interface ApiMedia {
  type?: string;
  url?: string;
  quality?: string;
  filesize?: number;
}

interface ApiResponse {
  status?: string;
  platform?: string;
  media?: ApiMedia[];
  thumbnail?: string;
  error?: string;
  message?: string;
  retryable?: boolean;
  failureKind?: string;
}

/**
 * First post URL in a message, or null.
 *
 * Bare hosts are only honoured for known platforms — otherwise ordinary prose
 * ("done.Try again") would read as a link and start a job.
 */
export function extractSourceUrl(text: string | undefined): string | null {
  if (!text) return null;

  for (const match of text.matchAll(CANDIDATE)) {
    // Trailing sentence punctuation is never part of the link.
    const raw = match[0].replace(/[.,;:!?)\]]+$/, '');
    const hasScheme = /^https?:\/\//i.test(raw);

    let host: string;
    try {
      host = new URL(hasScheme ? raw : `https://${raw}`).hostname;
    } catch {
      continue;
    }

    if (hasScheme) return raw;
    if (SOCIAL_HOSTS.test(host)) return `https://${raw}`;
  }

  return null;
}

/**
 * Ask download-media-bot to turn a post URL into a direct video link.
 *
 * The API returns links, not bytes, and they are short-lived — fetch what
 * comes back promptly and never store it.
 */
export async function resolveVideo(env: Env, postUrl: string): Promise<ResolvedMedia> {
  if (!env.DOWNLOAD_API_KEY) {
    throw new NonRetryableError('Link downloads are not set up on this bot (DOWNLOAD_API_KEY is missing).');
  }

  const base = (env.DOWNLOAD_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const res = await fetch(`${base}/api/download`, {
    method: 'POST',
    headers: { 'x-api-key': env.DOWNLOAD_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ url: postUrl, mode: 'auto' }),
  });

  const data = (await res.json().catch(() => ({}))) as ApiResponse;

  // The body field is the contract, not the HTTP code.
  if (data.status !== 'success') {
    const detail = data.error ?? data.message ?? `HTTP ${res.status}`;
    // A 502 flagged retryable means a backend is still extracting: a plain
    // Error lets the workflow step back off and ask again.
    if (res.status === 502 && data.retryable) throw new Error(`downloader busy (${detail})`);
    throw new NonRetryableError(explain(res.status, detail));
  }

  const items = data.media ?? [];
  const video = items.find((m) => m.type === 'video' && m.url);

  if (!video?.url) {
    if (items.some((m) => m.type === 'photo')) {
      throw new NonRetryableError('That post only has photos — there is nothing to caption.');
    }
    throw new NonRetryableError('No video came back for that link.');
  }

  return {
    url: video.url,
    platform: data.platform ?? 'Link',
    // The post's own text is deliberately not carried: it is untrusted
    // third-party content and nothing downstream needs it.
    thumbnail: data.thumbnail,
    quality: video.quality,
    filesize: video.filesize,
  };
}

/** Pull the resolved link down, refusing anything over `maxBytes`. */
export async function fetchMedia(media: ResolvedMedia, maxBytes: number): Promise<ArrayBuffer> {
  const declared = Number(media.filesize ?? 0);
  if (declared > maxBytes) throw new NonRetryableError(tooBig(declared, maxBytes));

  const res = await fetch(media.url);
  // Signed links expire quickly; a retry re-resolves the post, so stay retryable.
  if (!res.ok) throw new Error(`media link fetch failed (${res.status})`);

  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > maxBytes) throw new NonRetryableError(tooBig(length, maxBytes));

  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new NonRetryableError(tooBig(bytes.byteLength, maxBytes));
  if (bytes.byteLength === 0) throw new Error('media link returned an empty body');

  return bytes;
}

function tooBig(bytes: number, maxBytes: number): string {
  return `That video is ${(bytes / 1024 / 1024).toFixed(1)} MB — the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`;
}

function explain(status: number, detail: string): string {
  switch (status) {
    case 400:
      return `That link is not one I can download (${detail}).`;
    case 401:
      return 'The download service rejected this bot’s API key.';
    case 403:
      return 'That content is blocked by the download service.';
    case 503:
      return 'The download service is not accepting requests right now.';
    default:
      return `Could not download that post (${detail}).`;
  }
}
