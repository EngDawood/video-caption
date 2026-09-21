import { TRANSLATORS, type CaptionSettings, type SttProviderId, type TranslatorId } from '../captions/settings';
import { charLimitFor } from '../captions/subtitles';
import { sanitize } from '../captions/text';
import type { Env, Segment, VideoMeta } from '../types';

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

interface CaptionLimits {
  maxChars: number;
  /**
   * Set only by 📏 Line length 'auto'. A cue also gets no more characters than
   * can be read in the time it is on screen — see `limitFor`.
   */
  charsPerSecond?: number;
}

/** Cues further apart than this are separate thoughts and never merged. */
const MERGE_GAP_SECONDS = 0.35;

/**
 * Reading rate 📏 'auto' fits to, in characters per second of cue time.
 *
 * The broadcast subtitling norm is 15–20 cps; 17 sits in the middle of it.
 */
export const AUTO_CHARS_PER_SECOND = 17;

/** Below this, the rate cap is ignored — it would cut cues to single words. */
const AUTO_CHARS_FLOOR = 16;

/**
 * The limit for one cue: the frame's cap, narrowed by how long the cue is up.
 *
 * Only 'auto' passes a rate, and it is honest about what this buys. Splitting
 * a dense cue in two does not give the viewer more time to read it — each half
 * gets half the span, so the characters-per-second is the same. What it does
 * change is the shape: a line that would flash on screen full-width for half a
 * second becomes two shorter ones, which the eye takes in at a glance instead
 * of scanning. The cap is the geometry, and this only ever tightens it.
 */
function limitFor(limits: CaptionLimits, duration: number): number {
  if (!limits.charsPerSecond || !(duration > 0)) return limits.maxChars;
  const readable = Math.round(duration * limits.charsPerSecond);
  return Math.max(AUTO_CHARS_FLOOR, Math.min(limits.maxChars, readable));
}

/**
 * Re-fit finished cues to a new line length, in either direction.
 *
 * `resegment` only ever splits, so on its own it cannot widen cues that were
 * already broken up at a smaller limit. The restyle flow needs both directions
 * — a user raising the limit expects longer lines — so glue contiguous cues
 * back together first, then split the result as usual.
 */
export function refitSegments(
  segments: Segment[],
  maxChars: number,
  opts: { charsPerSecond?: number } = {},
): Segment[] {
  const limits: CaptionLimits = {
    maxChars: Math.max(12, maxChars || 42),
    charsPerSecond: opts.charsPerSecond,
  };
  const merged: Segment[] = [];

  for (const raw of segments) {
    // Also the backstop for cues already sitting in R2 from before the line
    // above existed, and for text a user has pasted back by hand.
    const segment = { ...raw, text: sanitize(raw.text).replace(/\s+/g, ' ').trim() };
    const previous = merged[merged.length - 1];
    const joined = previous ? `${previous.text} ${segment.text}` : '';

    // Merged against the frame's cap, not the per-cue rate one: this pass only
    // widens, and the split below re-cuts the result at whatever the rate
    // allows. Merging at the tighter number would leave nothing to re-cut.
    if (previous && joined.length <= limits.maxChars && segment.start - previous.end <= MERGE_GAP_SECONDS) {
      previous.text = joined;
      previous.end = segment.end;
      continue;
    }

    merged.push({ ...segment });
  }

  return resegment(merged, limits);
}

/**
 * The cues a burn actually draws: `refitSegments` with the line length this
 * video resolves to.
 *
 * One function because the two callers — the workflow's burn step and the 🖼
 * preview — have to agree exactly. A preview rendered at a different limit
 * from the burn is worse than no preview at all.
 */
export function fitSegments(
  segments: Segment[],
  settings: CaptionSettings,
  meta: Pick<VideoMeta, 'width' | 'height'>,
): Segment[] {
  return refitSegments(
    segments,
    charLimitFor(settings, meta),
    // The reading-rate cap is part of what 'auto' means; a fixed limit is a
    // number the user chose and is left alone.
    settings.chars === 'auto' ? { charsPerSecond: AUTO_CHARS_PER_SECOND } : {},
  );
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
    const maxChars = limitFor(limits, duration);
    const words = segment.text.split(/\s+/).filter(Boolean);

    // Length is the only reason to split. A short line that happens to span a
    // long pause should keep its full timing — truncating it would blank the
    // caption while the speaker is still on that sentence.
    if (segment.text.length <= maxChars) {
      out.push(segment);
      continue;
    }

    // Greedily fill lines, closing early on a sentence/clause boundary once the
    // line is long enough that the break will not look abrupt.
    const chunks: string[] = [];
    let current: string[] = [];

    for (const word of words) {
      const candidate = current.length ? `${current.join(' ')} ${word}` : word;

      if (candidate.length > maxChars && current.length) {
        chunks.push(current.join(' '));
        current = [word];
        continue;
      }

      current.push(word);
      const length = candidate.length;
      const atSentence = SENTENCE_END.test(word);
      const atClause = CLAUSE_END.test(word);

      if ((atSentence && length >= maxChars * 0.4) || (atClause && length >= maxChars * 0.7)) {
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

// --- translation -----------------------------------------------------------

/** Longest run of speech handed to the translator as one unit. */
const TRANSLATION_UNIT_CHARS = 400;
/** A pause this long ends a thought, even with no full stop spoken. */
const TRANSLATION_GAP_SECONDS = 1.2;
/** How much neighbouring speech the translator is shown around its unit. */
const TRANSLATION_CONTEXT_CHARS = 200;

/** Collapse consecutive segments into the single span handed to the translator. */
function asUnit(segments: Segment[]): Segment {
  return {
    start: segments[0].start,
    end: segments[segments.length - 1].end,
    text: segments.map((s) => s.text).join(' '),
  };
}

/** Length of the text those segments would join into. */
const unitLength = (segments: Segment[]): number =>
  segments.reduce((sum, s) => sum + s.text.length + 1, -1);

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
 *
 * The length cap is the awkward case, and the reason this buffers rather than
 * appending greedily. Reaching the cap mid-sentence used to close the unit at
 * whatever segment boundary happened to be there, so "I'll do more" and
 * "videos on that" became two units and each half was translated blind — the
 * exact failure the grouping exists to prevent, reintroduced by the cap. A
 * forced break now rewinds to the last sentence end inside the buffer and
 * carries the remainder forward, and cuts where it stands only when the buffer
 * holds no sentence boundary at all.
 */
function groupForTranslation(segments: Segment[]): Segment[] {
  const units: Segment[] = [];
  let buffer: Segment[] = [];

  const flushAll = () => {
    if (buffer.length) units.push(asUnit(buffer));
    buffer = [];
  };

  /** Close the buffer at its last sentence end, carrying the rest forward. */
  const flushAtSentence = () => {
    let boundary = -1;
    for (let i = 0; i < buffer.length - 1; i++) {
      if (SENTENCE_END.test(buffer[i].text)) boundary = i;
    }
    if (boundary === -1) {
      flushAll();
      return;
    }
    units.push(asUnit(buffer.slice(0, boundary + 1)));
    buffer = buffer.slice(boundary + 1);
  };

  for (const segment of segments) {
    const previous = buffer[buffer.length - 1];

    if (previous) {
      const ended = SENTENCE_END.test(previous.text);
      const paused = segment.start - previous.end > TRANSLATION_GAP_SECONDS;
      const fits = unitLength(buffer) + 1 + segment.text.length <= TRANSLATION_UNIT_CHARS;

      if (ended || paused) {
        flushAll();
      } else if (!fits) {
        flushAtSentence();
        // The carried remainder can still be too long to take this segment, in
        // which case it stands as its own unit rather than overflowing the cap.
        if (buffer.length && unitLength(buffer) + 1 + segment.text.length > TRANSLATION_UNIT_CHARS) {
          flushAll();
        }
      }
    }

    buffer.push(segment);
  }

  flushAll();
  return units;
}

/** The tail of the previous unit and the head of the next, as context. */
const contextTail = (text?: string): string =>
  text ? text.slice(Math.max(0, text.length - TRANSLATION_CONTEXT_CHARS)) : '';
const contextHead = (text?: string): string => (text ? text.slice(0, TRANSLATION_CONTEXT_CHARS) : '');

interface TranslationContext {
  before: string;
  after: string;
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
  const units = groupForTranslation(segments);

  // Translated a whole sentence at a time, not a caption-sized fragment, and
  // with its neighbours in view. Sentence-aware grouping keeps most sentences
  // whole, but a stretch of speech that Whisper returned with no punctuation
  // at all gives it nothing to break on, so a unit can still open mid-thought
  // — and then the surrounding speech is the only thing that says what a
  // pronoun or a dangling verb belongs to.
  //
  // Deliberately returned unfitted: the target language renders at a different
  // length than the source, so these still need splitting into caption-sized
  // cues — but that is done at burn time with `refitSegments`, because the
  // line length is a per-job setting and a restyle has to be able to re-fit
  // the same text to a new limit.
  return mapLimit(units, 6, async (unit, i) => {
    const context: TranslationContext = {
      before: contextTail(units[i - 1]?.text),
      after: contextHead(units[i + 1]?.text),
    };
    const text = await translateText(env, unit.text, source, target, model, context);
    // Whitespace-normalised the way `clean` does it for the transcript: a model
    // that pads or doubles a space would otherwise have it burned in, because a
    // cue short enough to skip `resegment` never has its words rejoined. The
    // same call drops the bidi marks and presentation forms a model leaks into
    // Arabic — see `sanitize`.
    return { ...unit, text: sanitize(text).replace(/\s+/g, ' ').trim() };
  });
}

type TranslatorModel = (typeof TRANSLATORS)[TranslatorId];

/**
 * The Unicode script each target language is written in; a target not listed
 * goes unchecked. Latin is allowed on top of it everywhere, because names and
 * numbers keep their source spelling.
 */
const TARGET_SCRIPT: Record<string, string> = {
  ar: 'Arabic',
  ur: 'Arabic',
  fa: 'Arabic',
  ru: 'Cyrillic',
  hi: 'Devanagari',
  en: 'Latin',
  es: 'Latin',
  fr: 'Latin',
  tr: 'Latin',
  pt: 'Latin',
};

/**
 * A letter that belongs in neither the target's script nor Latin.
 *
 * An allow-list, not a list of scripts to forbid. Checking only the target's
 * own script is not enough — a leaked word in a third script counts towards
 * neither side of a share-of-target ratio, which is how `لآخرين` passed with
 * three Cyrillic letters spliced into it — and the list of third scripts that
 * replaced that check still let through any script nobody had thought to list.
 * Common and Inherited cover the letters every script shares, such as the
 * Arabic tatweel and the combining marks.
 */
const foreignLetter = (script: string, flags = 'u'): RegExp =>
  new RegExp(
    `[^\\P{L}\\p{Script=Latin}\\p{Script=${script}}\\p{Script=Common}\\p{Script=Inherited}]`,
    flags,
  );

/** Names and numbers keep their source spelling, so some Latin is expected. */
const MIN_TARGET_SCRIPT_SHARE = 0.2;

const countIn = (text: string, script: string): number =>
  (text.match(new RegExp(`\\p{Script=${script}}`, 'gu')) ?? []).length;

/**
 * Does this read like a translation into `target` at all?
 *
 * `translateText` used to retry only on a thrown error or an empty string, so
 * a model that answered in the wrong language — or leaked a stray token from a
 * third one, which fp8 Llama does often enough to matter — was taken at face
 * value and burned into the video.
 *
 * Two separate tests, because the two failures look nothing alike. Any
 * character from a script that is neither the target's nor Latin is a leak,
 * and one is enough to reject. The share test then catches the answer that is
 * simply not translated: it is deliberately loose, because a line that is
 * mostly proper nouns is common and proves nothing on its own.
 */
function isPlausible(text: string, target: string): boolean {
  const expected = TARGET_SCRIPT[target];
  if (!expected) return true;
  if (foreignLetter(expected).test(text)) return false;
  if (expected === 'Latin') return true;

  const inScript = countIn(text, expected);
  const latin = countIn(text, 'Latin');
  const letters = inScript + latin;
  return letters === 0 || inScript / letters >= MIN_TARGET_SCRIPT_SHARE;
}

/** Links, handles and hashtags keep their Latin spelling in any language. */
const LATIN_EXEMPT = /(?:https?:\/\/|www\.)\S+|[@#][\w.]+|\b[\w-]+\.(?:com|net|org|io|ai|co|me|tv)\b/gi;

/** One word: letters and marks, with inner apostrophes and hyphens, not touching a digit. */
const WORD = /(?<![\p{L}\p{M}\d])[\p{L}\p{M}][\p{L}\p{M}'’-]*(?![\p{L}\p{M}\d])/gu;

/**
 * Letters of Persian and Urdu that standard Arabic does not use. In an Arabic
 * translation they mean the model drifted into a sibling language that shares
 * the alphabet, which no script test can see — `است` is Arabic letters too.
 */
const NOT_ARABIC = /[پچژگکیٹڈڑںہے]/;

/**
 * Words in a translation that are not in the target language.
 *
 * Three kinds, and `isPlausible` sees only the first:
 *  - a word with a letter from a third script — `вещан` in the middle of an
 *    Arabic line. `isPlausible` rejects the line, but if the retry leaks too
 *    the rejected line is kept, so this still has to be mendable.
 *  - a source word left in Latin letters. A line with one or two English words
 *    in it is still mostly Arabic, so the share test passes it.
 *  - in Arabic, a Persian or Urdu word, written in the same alphabet.
 *
 * Names are what make the Latin case hard, since they keep their source
 * spelling on purpose — so a Latin word counts only when nothing marks it as a
 * name. A lowercase word is not a name. A capitalised one is a leak only when
 * the source used the same word in lowercase, which is how a sentence-initial
 * "Actually" shows itself to be an ordinary word. Acronyms, mixed-case brands
 * (iPhone, macOS) and anything written against a digit (a unit, a model
 * number) are left alone. Accented Latin counts as Latin, so a Spanish
 * `también` is named whole rather than cut to `tambi` at the accent.
 */
function leakedWords(text: string, sourceText: string, target: string): string[] {
  const expected = TARGET_SCRIPT[target];
  if (!expected) return [];
  const foreign = foreignLetter(expected);
  const lowercaseInSource = new Set(
    [...sourceText.matchAll(WORD)].map((m) => m[0]).filter((w) => /^\p{Ll}/u.test(w)),
  );
  const leaks = new Set<string>();

  for (const m of text.replace(LATIN_EXEMPT, ' ').matchAll(WORD)) {
    const word = m[0];
    if (foreign.test(word) || (target === 'ar' && NOT_ARABIC.test(word))) {
      leaks.add(word);
      continue;
    }
    if (expected === 'Latin' || !/^[\p{Script=Latin}\p{M}'’-]+$/u.test(word)) continue;
    // An acronym, or a brand cased like iPhone or macOS.
    if (word === word.toUpperCase() || /\p{Lu}/u.test(word.slice(1))) continue;
    if (/^\p{Ll}/u.test(word) || lowercaseInSource.has(word.toLowerCase())) leaks.add(word);
  }
  return [...leaks];
}

async function translateText(
  env: Env,
  text: string,
  source: string,
  target: string,
  model: TranslatorModel,
  context: TranslationContext,
): Promise<string> {
  if (!text.trim()) return text;

  // A rejected answer is still kept: one stray foreign word in an otherwise
  // good line beats falling all the way back to untranslated source text.
  let best = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out =
        model.kind === 'chat'
          ? await promptTranslate(env, model.model, text, source, target, context)
          : model.kind === 'nvidia'
            ? await nvidiaTranslate(env, model.model, text, source, target)
            : await mtTranslate(env, model.model, text, source, target);
      if (out) {
        if (isPlausible(out, target)) return repairLeaks(env, text, out, source, target, model);
        best ||= out;
        console.error(`[ai] translation was not ${langName(target)}, retrying:`, out.slice(0, 120));
      }
    } catch (err) {
      if (attempt === 1) console.error('[ai] translation failed, keeping source text:', err);
    }
  }
  // Both attempts leaked: mend the words that are wrong rather than burn them —
  // this is the path `هناك вещان متميزتان` took. Failing that, better to burn
  // the original line than to drop it entirely.
  return best ? repairLeaks(env, text, best, source, target, model) : text;
}

/** Models sometimes echo the label or wrap the line in quotes; take that back off. */
function stripWrapper(text: string): string {
  const unlabelled = text.replace(/^\s*(?:TEXT|TRANSLATION)\s*:\s*/i, '').trim();
  const quoted = /^(["'«“])([\s\S]*)(["'»”])$/.exec(unlabelled);
  return (quoted ? quoted[2] : unlabelled).trim();
}

/** Chat models: told what to do, and told firmly not to add anything around it. */
async function promptTranslate(
  env: Env,
  model: string,
  text: string,
  source: string,
  target: string,
  context: TranslationContext,
): Promise<string> {
  const parts = [
    context.before ? `CONTEXT BEFORE: ${context.before}` : null,
    `TEXT: ${text}`,
    context.after ? `CONTEXT AFTER: ${context.after}` : null,
  ].filter(Boolean);

  const res: any = await env.AI.run(model as any, {
    messages: [
      {
        role: 'system',
        content:
          `You translate video subtitles from ${langName(source)} to ${langName(target)}. ` +
          'The message may carry CONTEXT BEFORE and CONTEXT AFTER around the TEXT. ' +
          'Those are the speech either side of it, given only so that a sentence ' +
          'running across the boundary, or a pronoun whose subject sits outside it, ' +
          'still makes sense. Translate ONLY the TEXT — never translate, repeat or ' +
          'summarise the context. ' +
          `Reply with ONLY the ${langName(target)} translation of TEXT — no quotes, ` +
          'no labels, no notes, nothing before or after it. ' +
          `Every word must be ${langName(target)}: never leave a word untranslated ` +
          'and never use a third language. Names and numbers keep their source ' +
          'spelling. Keep the tone and register the speaker used.',
      },
      { role: 'user', content: parts.join('\n\n') },
    ],
    temperature: 0.2,
  } as any);
  return stripWrapper(String(res?.response ?? '').trim());
}

/**
 * One targeted second pass for a translation with words not in the target
 * language — left in the source, or leaked from a third one.
 *
 * `leakedWords` finds them and this only mends them: the model is handed the
 * words by name and asked for the same line with those replaced, which a
 * model does far more reliably than noticing on its own what it left behind.
 * A repair is kept only if it is still plausible and strictly fewer words are
 * left over, so a pass that rewrote the line or made it worse is thrown away
 * and the first translation stands. Never throws — a failed repair must not
 * cost the translation it was trying to improve.
 *
 * Chat translators only: `m2m100` and Riva take no instructions, so for those
 * the leak is logged and nothing else.
 */
async function repairLeaks(
  env: Env,
  sourceText: string,
  translation: string,
  source: string,
  target: string,
  model: TranslatorModel,
): Promise<string> {
  const leaks = leakedWords(translation, sourceText, target);
  if (!leaks.length) return translation;
  if (model.kind !== 'chat') {
    console.warn('[ai] translation has words not in the target language:', leaks.join(', '));
    return translation;
  }

  try {
    const res: any = await env.AI.run(model.model as any, {
      messages: [
        {
          role: 'system',
          content:
            `You fix subtitle translations from ${langName(source)} to ${langName(target)}. ` +
            `The words listed under WRONG WORDS in the TRANSLATION are not ${langName(target)}: ` +
            `some were left in ${langName(source)}, some slipped in from another language. ` +
            `Replace each of them with the right ${langName(target)} word, reading the ORIGINAL ` +
            'to see what belongs there, and change nothing else. A word that is really a ' +
            'name or a brand keeps its spelling. ' +
            `Reply with ONLY the corrected ${langName(target)} line — no quotes, no labels, ` +
            'no notes, nothing before or after it.',
        },
        {
          role: 'user',
          content: `ORIGINAL: ${sourceText}\n\nTRANSLATION: ${translation}\n\nWRONG WORDS: ${leaks.join(', ')}`,
        },
      ],
      temperature: 0.1,
    } as any);
    const repaired = stripWrapper(String(res?.response ?? '').trim());
    const left = repaired ? leakedWords(repaired, sourceText, target) : leaks;

    if (repaired && isPlausible(repaired, target) && left.length < leaks.length) {
      console.log(`[ai] repaired wrong-language words: ${leaks.join(', ')}` + (left.length ? ` (still left: ${left.join(', ')})` : ''));
      return repaired;
    }
    console.warn('[ai] repair did not help, keeping first translation; wrong words:', leaks.join(', '));
  } catch (err) {
    console.error('[ai] repair failed, keeping first translation:', err);
  }
  return translation;
}

const NVIDIA_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';

/**
 * NVIDIA Riva: an external chat-completions endpoint, not Workers AI, and its
 * own rigid prompt shape — the system message is the bare `source-target`
 * language pair, the user message is the text and nothing else. No CONTEXT
 * BEFORE/AFTER, no tone instructions: NVIDIA's own docs say the model was
 * fine-tuned on exactly this template and underperforms off it, so unlike
 * `promptTranslate` this deliberately does not reuse that context window.
 */
async function nvidiaTranslate(
  env: Env,
  model: string,
  text: string,
  source: string,
  target: string,
): Promise<string> {
  const apiKey = env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('riva is selected as translator but NVIDIA_API_KEY is not set');

  const res = await fetch(NVIDIA_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: `${source}-${target}` },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`nvidia translation failed (${res.status}): ${await res.text()}`);

  const data: any = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? '').trim();
}

/**
 * m2m100 and friends: a plain MT endpoint, no prompting involved — and so no
 * way to pass it the surrounding speech. It is the literal, cheapest option on
 * the 🧠 Translator menu, and this is part of what that buys.
 */
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
