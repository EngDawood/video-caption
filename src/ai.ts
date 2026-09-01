import type { Env, Segment } from './types';

const WHISPER = '@cf/openai/whisper-large-v3-turbo';
const TRANSLATOR = '@cf/meta/m2m100-1.2b';

/** Workers AI wants the audio as base64; chunked so a long clip cannot blow the stack. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// --- transcription ---------------------------------------------------------

/**
 * Transcribe one audio chunk. `offset` is where this chunk starts in the full
 * video, so the returned timings are absolute.
 */
export async function transcribeChunk(
  env: Env,
  audio: ArrayBuffer,
  offset: number,
  fallbackDuration: number,
): Promise<Segment[]> {
  const raw =
    env.STT_PROVIDER === 'groq' || env.STT_PROVIDER === 'mistral'
      ? await transcribeExternal(env, audio, env.STT_PROVIDER)
      : await transcribeWorkersAI(env, audio);

  return normalize(raw, fallbackDuration).map((s) => ({
    start: s.start + offset,
    end: s.end + offset,
    text: s.text,
  }));
}

async function transcribeWorkersAI(env: Env, audio: ArrayBuffer): Promise<any> {
  const input: Record<string, unknown> = { audio: toBase64(audio) };
  if (env.SOURCE_LANG && env.SOURCE_LANG !== 'auto') input.language = env.SOURCE_LANG;
  return env.AI.run(WHISPER as any, input as any);
}

/**
 * OpenAI-compatible transcription providers.
 *
 * `granularityField` is not cosmetic: Groq takes the PHP-style array form and
 * Mistral (Voxtral) takes the plain name — and Voxtral returns an EMPTY
 * segments array if segment granularity is not requested at all.
 */
const PROVIDERS = {
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3-turbo',
    keyVar: 'GROQ_API_KEY',
    granularityField: 'timestamp_granularities[]',
  },
  mistral: {
    endpoint: 'https://api.mistral.ai/v1/audio/transcriptions',
    model: 'voxtral-mini-latest',
    keyVar: 'MISTRAL_API_KEY',
    granularityField: 'timestamp_granularities',
  },
} as const;

async function transcribeExternal(env: Env, audio: ArrayBuffer, id: 'groq' | 'mistral'): Promise<any> {
  const provider = PROVIDERS[id];
  const apiKey = env[provider.keyVar];
  if (!apiKey) throw new Error(`STT_PROVIDER=${id} but ${provider.keyVar} is not set`);

  const form = new FormData();
  form.append('file', new File([audio], 'audio.mp3', { type: 'audio/mpeg' }));
  form.append('model', provider.model);
  form.append('response_format', 'verbose_json');
  form.append(provider.granularityField, 'segment');
  if (env.SOURCE_LANG && env.SOURCE_LANG !== 'auto') form.append('language', env.SOURCE_LANG);

  const res = await fetch(provider.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`${id} transcription failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/**
 * Whisper responses vary by model and provider: some return `segments`, some
 * only `vtt`, some only word timings. Take whichever is present.
 */
function normalize(raw: any, fallbackDuration: number): Segment[] {
  if (Array.isArray(raw?.segments) && raw.segments.length && typeof raw.segments[0]?.start === 'number') {
    return clean(
      raw.segments.map((s: any) => ({
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
        text: String(s.text ?? '').trim(),
      })),
    );
  }

  if (typeof raw?.vtt === 'string' && raw.vtt.includes('-->')) {
    return clean(parseVtt(raw.vtt));
  }

  if (Array.isArray(raw?.words) && raw.words.length) {
    return clean(groupWords(raw.words));
  }

  const text = String(raw?.text ?? '').trim();
  return text ? [{ start: 0, end: fallbackDuration, text }] : [];
}

function parseVtt(vtt: string): Segment[] {
  const segments: Segment[] = [];
  const blocks = vtt.replace(/\r/g, '').split('\n\n');

  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    const cueIndex = lines.findIndex((l) => l.includes('-->'));
    if (cueIndex === -1) continue;

    const [from, to] = lines[cueIndex].split('-->').map((t) => t.trim().split(' ')[0]);
    const text = lines.slice(cueIndex + 1).join(' ').trim();
    if (!text) continue;

    segments.push({ start: vttTime(from), end: vttTime(to), text });
  }
  return segments;
}

function vttTime(stamp: string): number {
  const parts = stamp.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(stamp) || 0;
}

/** Fall back to stitching word timings into readable subtitle lines. */
function groupWords(words: any[]): Segment[] {
  const MAX_CHARS = 42;
  const MAX_SECONDS = 6;
  const GAP = 0.8;

  const segments: Segment[] = [];
  let current: Segment | null = null;

  for (const w of words) {
    const word = String(w.word ?? w.text ?? '').trim();
    if (!word) continue;
    const start = Number(w.start) || 0;
    const end = Number(w.end) || start;

    const tooLong = current && (current.text.length + word.length + 1 > MAX_CHARS || end - current.start > MAX_SECONDS);
    const bigGap = current && start - current.end > GAP;

    if (!current || tooLong || bigGap) {
      if (current) segments.push(current);
      current = { start, end, text: word };
    } else {
      current.text += ` ${word}`;
      current.end = end;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/** Drop empties and make sure every cue has a sane, non-overlapping duration. */
function clean(segments: Segment[]): Segment[] {
  const out = segments
    .map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text.length > 0)
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < out.length; i++) {
    if (!(out[i].end > out[i].start)) out[i].end = out[i].start + 1.5;
    const next = out[i + 1];
    if (next && out[i].end > next.start) out[i].end = Math.max(out[i].start + 0.4, next.start - 0.02);
  }
  return out;
}

// --- translation -----------------------------------------------------------

export async function translateSegments(env: Env, segments: Segment[]): Promise<Segment[]> {
  const source = env.SOURCE_LANG && env.SOURCE_LANG !== 'auto' ? env.SOURCE_LANG : 'en';
  const target = env.TARGET_LANG || 'ar';

  return mapLimit(segments, 6, async (segment) => {
    const text = await translateText(env, segment.text, source, target);
    return { ...segment, text };
  });
}

async function translateText(env: Env, text: string, source: string, target: string): Promise<string> {
  if (!text.trim()) return text;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res: any = await env.AI.run(TRANSLATOR as any, {
        text,
        source_lang: source,
        target_lang: target,
      } as any);
      const out = String(res?.translated_text ?? '').trim();
      if (out) return out;
    } catch (err) {
      if (attempt === 1) console.error('[ai] translation failed, keeping source text:', err);
    }
  }
  // Better to burn the original line than to drop it entirely.
  return text;
}
