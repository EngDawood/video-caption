import { WRITERS, type WriterId } from '../captions/settings';
import { sanitize } from '../captions/text';
import type { Env, Segment } from '../types';
import { isPlausible } from './translate';
import { langName, stripWrapper } from './translators';

/**
 * Post text for publishing a delivered video — one short description per
 * language, written straight from what was said.
 *
 * Written in each language directly rather than written once and translated:
 * a hook that works in English rarely survives a translation, and a second
 * translation stacks its errors on the first. The transcript is the input, not
 * the burned captions, for the same reason.
 */

const DEFAULT_LANGUAGES = 'ar,en';

/** Writes when the chosen writer fails; needs no key, so it is always there. */
const FALLBACK: WriterId = 'llama70b';

const NVIDIA_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';

/**
 * Less speech than this is not enough to describe without inventing it.
 */
const MIN_TRANSCRIPT_CHARS = 20;

/**
 * The prompt budget for the transcript. A long video keeps its opening and its
 * ending — where a speaker says what the video is and how it lands — and loses
 * the middle.
 */
const MAX_TRANSCRIPT_CHARS = 8000;

/**
 * How long all of it may take. The 📣 tap is handled in the webhook's
 * `waitUntil`, which the runtime cuts off 30 s after the response, so the
 * chosen writer gets most of this and the fallback gets what is left.
 */
const BUDGET_MS = 26_000;

/** The fallback is not started with less than this left — it would only be cut off. */
const MIN_FALLBACK_MS = 6_000;

/** Models add hashtags however firmly they are told not to. */
const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/gu;

/** Reasoning models may put their thinking in the answer itself. */
const THINKING = /<think>[\s\S]*?<\/think>/gi;

export const postTextLanguages = (env: Env): string[] =>
  (env.POST_TEXT_LANGUAGES || DEFAULT_LANGUAGES)
    .split(',')
    .map((code: string) => code.trim())
    .filter(Boolean);

/** The speech as one text, or null when there is too little to describe. */
export function transcriptOf(segments: Segment[]): string | null {
  const text = segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < MIN_TRANSCRIPT_CHARS) return null;
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;

  const half = MAX_TRANSCRIPT_CHARS / 2;
  return `${text.slice(0, half)} … ${text.slice(-half)}`;
}

function tidy(text: string): string {
  return sanitize(stripWrapper(text.replace(THINKING, '')))
    .replace(HASHTAG, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function messagesFor(transcript: string, lang: string) {
  const language = langName(lang);
  return [
    {
      role: 'system',
      content:
        `You write the post text for a short video on Facebook, Instagram and TikTok, in ${language}. ` +
        'You are given the transcript of what is said in the video, which may be in another language. ' +
        'Write one opening line that makes someone stop scrolling — under 120 characters, because ' +
        'the apps cut the caption off after that — then a blank line, then two to four short ' +
        'sentences on what the video is about. ' +
        'Use only what the transcript says: never invent names, places, numbers or claims. ' +
        'No hashtags, no emoji, no quotes, no labels, no notes — reply with the post text and nothing else. ' +
        `Every word must be ${language}; names keep their own spelling.`,
    },
    { role: 'user', content: `TRANSCRIPT: ${transcript}` },
  ];
}

/** Reject after `ms`, for a call that takes no abort signal. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => timer && clearTimeout(timer));
}

async function ask(env: Env, writer: WriterId, transcript: string, lang: string, ms: number): Promise<string> {
  const { model, kind } = WRITERS[writer];
  const messages = messagesFor(transcript, lang);

  if (kind === 'nvidia') {
    if (!env.NVIDIA_API_KEY) throw new Error(`${writer} is the post writer but NVIDIA_API_KEY is not set`);
    const res = await fetch(NVIDIA_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 2048, stream: false }),
      signal: AbortSignal.timeout(ms),
    });
    if (!res.ok) throw new Error(`${writer} failed (${res.status}): ${await res.text()}`);
    const data: any = await res.json();
    return tidy(String(data?.choices?.[0]?.message?.content ?? ''));
  }

  const res: any = await within(ms, env.AI.run(model as any, { messages, temperature: 0.7 } as any));
  return tidy(String(res?.response ?? ''));
}

/**
 * One description in `lang`, or null when nothing usable came back in time.
 *
 * The chosen writer is asked first. If it fails, times out or answers in the
 * wrong script, the Workers AI fallback is asked with whatever time is left.
 * A wrong-script answer is still returned when nothing better arrives, since
 * the user reads it before posting it — unlike a caption, nothing is published
 * unseen.
 */
export async function writePostText(
  env: Env,
  writer: WriterId,
  transcript: string,
  lang: string,
): Promise<string | null> {
  const deadline = Date.now() + BUDGET_MS;
  const chain = writer === FALLBACK ? [writer] : [writer, FALLBACK];
  let rejected: string | null = null;

  for (const [i, id] of chain.entries()) {
    const left = deadline - Date.now();
    if (i > 0 && left < MIN_FALLBACK_MS) break;

    const started = Date.now();
    const text = await ask(env, id, transcript, lang, i === 0 ? left - MIN_FALLBACK_MS : left).catch(
      (err) => {
        console.error(`[describe] ${id} (${lang}) failed:`, err);
        return '';
      },
    );
    console.log(`[describe] ${id} (${lang}) answered in ${Date.now() - started} ms`);

    if (!text) continue;
    if (isPlausible(text, lang)) return text;
    rejected ??= text;
  }
  return rejected;
}
