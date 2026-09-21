import type { SttProviderId } from '../captions/settings';
import { sanitize } from '../captions/text';
import type { Env, Segment } from '../types';

/**
 * Speech to text: the provider chain, and turning whatever each provider
 * returns into timed segments at the provider's own granularity.
 */

/** Only the Workers AI leg of the STT chain — Groq and Mistral name their own. */
const WHISPER_DEFAULT = '@cf/openai/whisper-large-v3-turbo';

const whisperModel = (env: Env): string => env.WHISPER_MODEL || WHISPER_DEFAULT;

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

/**
 * Silence prepended to every chunk before it is transcribed.
 *
 * Whisper swallows the opening words when speech starts on the very first
 * sample: "learn to speak in cadence" came back as "to speak in cadence", and
 * the same thing happens at the head of each chunk of a long video. A short
 * run-up of silence is enough to stop it. The container pads the audio and
 * this file takes the offset back off the timings.
 */
export const TRANSCRIBE_LEAD_SECONDS = 1;

/**
 * Transcribe one audio chunk. `offset` is where this chunk starts in the full
 * video, so the returned timings are absolute; `lead` is the silence the
 * container prepended, which has to come back off before that is true.
 */
export async function transcribeChunk(
  env: Env,
  audio: ArrayBuffer,
  offset: number,
  fallbackDuration: number,
  sourceLang: string,
  preferred: SttProviderId,
  lead = 0,
): Promise<Segment[]> {
  const raw = await transcribe(env, audio, sourceLang, preferred);

  // Left at the provider's own granularity — deliberately NOT split into
  // caption-sized cues yet. The translator gets whole sentences this way
  // instead of arbitrary ~42-char fragments, which is what was cutting
  // sentences in half before translation and mistranslating both halves.
  // Caption-sizing happens after translation, on the translated text, via
  // `refitSegments` at burn time.
  return (
    normalize(raw, fallbackDuration + lead)
      .map((s) => ({ start: s.start - lead, end: s.end - lead, text: s.text }))
      // The pad is silence, so nothing should be transcribed inside it — but a
      // model that hallucinates one there must not push every real cue late.
      .filter((s) => s.end > 0)
      .map((s) => ({
        start: Math.max(0, s.start) + offset,
        end: Math.max(0, s.end) + offset,
        text: s.text,
      }))
  );
}

async function transcribeWorkersAI(env: Env, audio: ArrayBuffer, sourceLang: string): Promise<any> {
  const input: Record<string, unknown> = { audio: toBase64(audio) };
  if (sourceLang && sourceLang !== 'auto') input.language = sourceLang;
  return env.AI.run(whisperModel(env) as any, input as any);
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

async function transcribeExternal(
  env: Env,
  audio: ArrayBuffer,
  id: 'groq' | 'mistral',
  sourceLang: string,
): Promise<any> {
  const provider = PROVIDERS[id];
  const apiKey = env[provider.keyVar];
  if (!apiKey) throw new Error(`${id} is in the STT chain but ${provider.keyVar} is not set`);

  const form = new FormData();
  form.append('file', new File([audio], 'audio.mp3', { type: 'audio/mpeg' }));
  form.append('model', provider.model);
  form.append('response_format', 'verbose_json');
  form.append(provider.granularityField, 'segment');
  if (sourceLang && sourceLang !== 'auto') form.append('language', sourceLang);

  const res = await fetch(provider.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`${id} transcription failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/**
 * Transcription providers in the order they are tried.
 *
 * STT_PROVIDER names the PREFERRED provider, not the only one: the rest of the
 * chain is the fallback, so a Groq outage or a spent quota rolls over to
 * Mistral and finally to Workers AI instead of failing the job. Workers AI is
 * always last because it is the slowest of the three and the only one billed
 * to the Cloudflare account.
 *
 * An external provider with no API key is skipped rather than counted as a
 * failure — nothing is attempted that cannot possibly work.
 */
const STT_ORDER: readonly SttProviderId[] = ['groq', 'mistral', 'workers-ai'];

export function sttChain(env: Env, preferred: SttProviderId): SttProviderId[] {
  const first = STT_ORDER.includes(preferred) ? preferred : 'groq';
  return [first, ...STT_ORDER.filter((id) => id !== first)].filter(
    (id) => id === 'workers-ai' || Boolean(env[PROVIDERS[id].keyVar]),
  );
}

/**
 * Try each provider in turn. Only a thrown error rolls over — an empty result
 * is taken at face value, because a silent chunk is normal (music, a gap) and
 * re-running all three providers on it would cost time and money for nothing.
 */
async function transcribe(
  env: Env,
  audio: ArrayBuffer,
  sourceLang: string,
  preferred: SttProviderId,
): Promise<any> {
  const chain = sttChain(env, preferred);
  let last: unknown;

  for (const id of chain) {
    try {
      return id === 'workers-ai'
        ? await transcribeWorkersAI(env, audio, sourceLang)
        : await transcribeExternal(env, audio, id, sourceLang);
    } catch (err) {
      last = err;
      console.error(`[ai] ${id} transcription failed, falling back:`, err);
    }
  }

  throw last ?? new Error('no transcription provider available');
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
    // `sanitize` as well as whitespace: a provider that returns Arabic in
    // presentation forms hands the burn characters most fonts cannot draw.
    .map((s) => ({ ...s, text: sanitize(s.text).replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text.length > 0)
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < out.length; i++) {
    if (!(out[i].end > out[i].start)) out[i].end = out[i].start + 1.5;
    const next = out[i + 1];
    if (next && out[i].end > next.start) out[i].end = Math.max(out[i].start + 0.4, next.start - 0.02);
  }
  return out;
}
