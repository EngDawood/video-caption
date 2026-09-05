import { TRANSLATORS, type SttProviderId, type TranslatorId } from '../captions/settings';
import type { Env, Segment } from '../types';

/** Only the Workers AI leg of the STT chain — Groq and Mistral name their own. */
const WHISPER_DEFAULT = '@cf/openai/whisper-large-v3-turbo';

const whisperModel = (env: Env): string => env.WHISPER_MODEL || WHISPER_DEFAULT;

/** Language names for the translation prompt; codes fall back to themselves. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ar: 'Arabic',
  es: 'Spanish',
  fr: 'French',
  hi: 'Hindi',
  ur: 'Urdu',
  fa: 'Persian',
  tr: 'Turkish',
  ru: 'Russian',
  pt: 'Portuguese',
};

const langName = (code: string): string => LANGUAGE_NAMES[code] ?? code;

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
  sourceLang: string,
  preferred: SttProviderId,
): Promise<Segment[]> {
  const raw = await transcribe(env, audio, sourceLang, preferred);

  // Left at the provider's own granularity — deliberately NOT split into
  // caption-sized cues yet. The translator gets whole sentences this way
  // instead of arbitrary ~42-char fragments, which is what was cutting
  // sentences in half before translation and mistranslating both halves.
  // Caption-sizing happens after translation, on the translated text, via
  // `refitSegments` at burn time.
  return normalize(raw, fallbackDuration).map((s) => ({
    start: s.start + offset,
    end: s.end + offset,
    text: s.text,
  }));
}

interface CaptionLimits {
  maxChars: number;
}

/** Cues further apart than this are separate thoughts and never merged. */
const MERGE_GAP_SECONDS = 0.35;

/**
 * Re-fit finished cues to a new line length, in either direction.
 *
 * `resegment` only ever splits, so on its own it cannot widen cues that were
 * already broken up at a smaller limit. The restyle flow needs both directions
 * — a user raising the limit expects longer lines — so glue contiguous cues
 * back together first, then split the result as usual.
 */
export function refitSegments(segments: Segment[], maxChars: number): Segment[] {
  const limits: CaptionLimits = { maxChars: Math.max(12, maxChars || 42) };
  const merged: Segment[] = [];

  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    const joined = previous ? `${previous.text} ${segment.text}` : '';

    if (previous && joined.length <= limits.maxChars && segment.start - previous.end <= MERGE_GAP_SECONDS) {
      previous.text = joined;
      previous.end = segment.end;
      continue;
    }

    merged.push({ ...segment });
  }

  return resegment(merged, limits);
}

/** Sentence enders, Latin and Arabic (؟ question mark, ۔ full stop). */
const SENTENCE_END = /[.!?؟۔]$/;
/** Clause breaks — second choice when no sentence boundary fits. */
const CLAUSE_END = /[,;:،؛]$/;

/**
 * Split cues that are too long to read into shorter ones, preferring sentence
 * boundaries, then clause boundaries, then plain word breaks. New timings are
 * interpolated across the original span by character count — close enough at
 * subtitle granularity, and it keeps cues butted up against each other.
 */
export function resegment(segments: Segment[], limits: CaptionLimits): Segment[] {
  const out: Segment[] = [];

  for (const segment of segments) {
    const duration = segment.end - segment.start;
    const words = segment.text.split(/\s+/).filter(Boolean);

    // Length is the only reason to split. A short line that happens to span a
    // long pause should keep its full timing — truncating it would blank the
    // caption while the speaker is still on that sentence.
    if (segment.text.length <= limits.maxChars) {
      out.push(segment);
      continue;
    }

    // Greedily fill lines, closing early on a sentence/clause boundary once the
    // line is long enough that the break will not look abrupt.
    const chunks: string[] = [];
    let current: string[] = [];

    for (const word of words) {
      const candidate = current.length ? `${current.join(' ')} ${word}` : word;

      if (candidate.length > limits.maxChars && current.length) {
        chunks.push(current.join(' '));
        current = [word];
        continue;
      }

      current.push(word);
      const length = candidate.length;
      const atSentence = SENTENCE_END.test(word);
      const atClause = CLAUSE_END.test(word);

      if ((atSentence && length >= limits.maxChars * 0.4) || (atClause && length >= limits.maxChars * 0.7)) {
        chunks.push(current.join(' '));
        current = [];
      }
    }
    if (current.length) chunks.push(current.join(' '));

    // Spread the original time span over the chunks, weighted by length.
    const total = chunks.reduce((sum, c) => sum + c.length, 0) || 1;
    let cursor = segment.start;

    for (const chunk of chunks) {
      const span = (chunk.length / total) * duration;
      out.push({ start: cursor, end: cursor + span, text: chunk });
      cursor += span;
    }
  }

  return out;
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

/** Longest run of speech handed to the translator as one unit. */
const TRANSLATION_UNIT_CHARS = 400;
/** A pause this long ends a thought, even with no full stop spoken. */
const TRANSLATION_GAP_SECONDS = 1.2;

/**
 * Glue consecutive segments back into whole sentences for the translator.
 *
 * Whisper's own segmentation is not reliably sentence-shaped: a talking head
 * gives long paragraphs, but a cut-heavy video gives a string of fragments,
 * and some models return no terminal punctuation at all. Translating a
 * fragment alone is what produced wrong Arabic, so a segment is joined to the
 * previous one unless there is a reason to believe the thought ended — a
 * sentence-ending mark, or a real pause.
 *
 * Genuinely disconnected speech therefore stays disconnected: a video that is
 * separate one-line utterances hits the gap rule and is translated line by
 * line, which is the right unit for it.
 */
function groupForTranslation(segments: Segment[]): Segment[] {
  const units: Segment[] = [];

  for (const segment of segments) {
    const previous = units[units.length - 1];
    const continues =
      previous &&
      !SENTENCE_END.test(previous.text) &&
      segment.start - previous.end <= TRANSLATION_GAP_SECONDS &&
      previous.text.length + segment.text.length + 1 <= TRANSLATION_UNIT_CHARS;

    if (continues) {
      previous.text = `${previous.text} ${segment.text}`;
      previous.end = segment.end;
      continue;
    }

    units.push({ ...segment });
  }

  return units;
}

export async function translateSegments(
  env: Env,
  segments: Segment[],
  sourceLang: string,
  targetLang: string,
  translator: TranslatorId,
): Promise<Segment[]> {
  const source = sourceLang && sourceLang !== 'auto' ? sourceLang : 'en';
  const target = targetLang || 'ar';
  const model = TRANSLATORS[translator] ?? TRANSLATORS.llama70b;

  // Translated a whole sentence at a time, not a caption-sized fragment.
  // Deliberately returned unfitted: the target language renders at a different
  // length than the source, so these still need splitting into caption-sized
  // cues — but that is done at burn time with `refitSegments`, because the
  // line length is a per-job setting and a restyle has to be able to re-fit
  // the same text to a new limit.
  return mapLimit(groupForTranslation(segments), 6, async (segment) => {
    const text = await translateText(env, segment.text, source, target, model);
    return { ...segment, text };
  });
}

type TranslatorModel = (typeof TRANSLATORS)[TranslatorId];

async function translateText(
  env: Env,
  text: string,
  source: string,
  target: string,
  model: TranslatorModel,
): Promise<string> {
  if (!text.trim()) return text;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out =
        model.kind === 'chat'
          ? await promptTranslate(env, model.model, text, source, target)
          : await mtTranslate(env, model.model, text, source, target);
      if (out) return out;
    } catch (err) {
      if (attempt === 1) console.error('[ai] translation failed, keeping source text:', err);
    }
  }
  // Better to burn the original line than to drop it entirely.
  return text;
}

/** Chat models: told what to do, and told firmly not to add anything around it. */
async function promptTranslate(
  env: Env,
  model: string,
  text: string,
  source: string,
  target: string,
): Promise<string> {
  const res: any = await env.AI.run(model as any, {
    messages: [
      {
        role: 'system',
        content:
          `You translate video subtitles from ${langName(source)} to ${langName(target)}. ` +
          'Reply with ONLY the translation — no quotes, no notes, no explanations, ' +
          'nothing before or after it. Keep names and numbers as in the source, and ' +
          'keep the tone and register the speaker used.',
      },
      { role: 'user', content: text },
    ],
    temperature: 0.2,
  } as any);
  return String(res?.response ?? '').trim();
}

/** m2m100 and friends: a plain MT endpoint, no prompting involved. */
async function mtTranslate(
  env: Env,
  model: string,
  text: string,
  source: string,
  target: string,
): Promise<string> {
  const res: any = await env.AI.run(model as any, {
    text,
    source_lang: source,
    target_lang: target,
  } as any);
  return String(res?.translated_text ?? '').trim();
}
