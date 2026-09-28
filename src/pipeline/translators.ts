import type { GenreId, TRANSLATORS, TranslatorId } from '../captions/settings';
import type { Env } from '../types';
import { ARABIC_RULES } from './arabic';

/**
 * The translator transports — one per `kind` in `TRANSLATORS` — and the
 * prompt pieces they share. Choosing and checking a translation is
 * `translate.ts`; this file only sends text and reads the answer back.
 */

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
  it: 'Italian',
  de: 'German',
};

export const langName = (code: string): string => LANGUAGE_NAMES[code] ?? code;

/** The source language for a prompt; `auto` means the model reads it off the text. */
export const sourceName = (code: string): string => (code === 'auto' ? 'the original language' : langName(code));

/** A `TRANSLATORS` entry, or anything shaped like one. */
export interface TranslatorModel {
  model: string;
  kind: (typeof TRANSLATORS)[TranslatorId]['kind'];
}

export interface TranslationContext {
  before: string;
  after: string;
  /** What kind of video it is, as the user set it on 🎭 Video type. */
  genre?: GenreId;
  /** This video's names and terms, one fixed rendering each — see `buildGlossary`. */
  glossary?: string;
}

/**
 * One paragraph of prompt per 🎭 Video type: what matters most in that kind
 * of video. A `Record` over `GenreId`, so a type added to `GENRES` without its
 * paragraph is a type error rather than a silent no-op.
 */
const GENRE_RULES: Record<GenreId, (target: string) => string> = {
  auto: () => '',
  comedy: (t) =>
    'This video is comedy. Keep every joke working in ' + t + ': wordplay, running gags and ' +
    'callbacks stay recognisable, so a recurring phrase is rendered the same way every time; ' +
    'banter stays casual; insults and crude jokes keep their strength. When a joke rests on an ' +
    'idiom being taken literally, keep the literal image.',
  lecture: (t) =>
    'This video is a lecture or educational talk. Use the standard ' + t + ' term for each ' +
    'technical concept and the same term every time; keep a clear, precise register; keep the ' +
    'reasoning words (because, therefore, however) explicit.',
  speech: () =>
    'This video is a public speech or news. Use a formal, rhetorical register. Names of people, ' +
    'places, organisations and agencies take their established forms. Keep slogans and ' +
    'rhetorical parallelism intact.',
  interview: () =>
    'This video is an interview or podcast. Keep it plain and conversational; drop fillers and ' +
    'false starts, and where a speaker restarts a sentence, translate the version they settled on.',
  drama: () =>
    'This video is drama or film dialogue. Write short, natural, direct lines; keep each ' +
    "character's emotion, and the relationship their way of addressing each other shows.",
  song: () =>
    'This video is a song. Translate what each line means, not its rhyme or metre; keep lines ' +
    'short; a refrain is translated the same way every time it returns; use no punctuation ' +
    'except ? and !.',
};

/** Models sometimes echo the label or wrap the line in quotes; take that back off. */
export function stripWrapper(text: string): string {
  const unlabelled = text.replace(/^\s*(?:TEXT|TRANSLATION)\s*:\s*/i, '').trim();
  const quoted = /^(["'«“])([\s\S]*)(["'»”])$/.exec(unlabelled);
  return (quoted ? quoted[2] : unlabelled).trim();
}

/**
 * How to translate, as opposed to what to reply with — for every target.
 *
 * The prompt used to say only "keep the tone and register", and the misses it
 * let through were all of one kind: fluent, in the right script, and wrong.
 * "I've got it" became لديه (he has), "You a**hole" became يا مجنون (you
 * madman), "dog" as a form of address became كلب. Each is a word translated
 * where the meaning should have been.
 */
const MEANING_RULES = [
  'Translate what the speaker means, not word for word, the way a professional subtitler would.',
  'An idiom becomes the equivalent idiom or its plain meaning, never a literal rendering, unless the ' +
    'context shows the literal image is the joke.',
  'A short reply ("Fine.", "Got it.", "All right.") means what it means in the exchange: read the ' +
    'context — "I\'ve got it" is "I understand" or "I\'m on it", not possession.',
  'Slang forms of address ("dog", "man", "bro", "son", "old boy") are forms of address, not nouns.',
  'Keep the tone, register and formality: a joke stays funny, an insult stays an insult, a lecture ' +
    'stays precise.',
  'The source is speech recognition output: if a word is obviously misheard, translate what was ' +
    'plainly meant.',
].join(' ');

/** Chat models: told what to do, and told firmly not to add anything around it. */
export async function promptTranslate(
  env: Env,
  model: TranslatorModel,
  text: string,
  source: string,
  target: string,
  context: TranslationContext,
): Promise<string> {
  const parts = [
    context.glossary ? `GLOSSARY:\n${context.glossary}` : null,
    context.before ? `CONTEXT BEFORE: ${context.before}` : null,
    `TEXT: ${text}`,
    context.after ? `CONTEXT AFTER: ${context.after}` : null,
  ].filter(Boolean);

  const answer = await chatComplete(
    env,
    model,
    [
      {
        role: 'system',
        content:
          `You translate video subtitles from ${sourceName(source)} to ${langName(target)}. ` +
          'The message may carry CONTEXT BEFORE and CONTEXT AFTER around the TEXT. ' +
          'Those are the speech either side of it, given only so that a sentence ' +
          'running across the boundary, or a pronoun whose subject sits outside it, ' +
          'still makes sense. Translate ONLY the TEXT — never translate, repeat or ' +
          'summarise the context. ' +
          `Reply with ONLY the ${langName(target)} translation of TEXT — no quotes, ` +
          'no labels, no notes, nothing before or after it. ' +
          `Every word must be ${langName(target)}: never leave a word untranslated ` +
          'and never use a third language. ' +
          (target === 'ar' ? '' : 'Names and numbers keep their source spelling. ') +
          MEANING_RULES +
          (target === 'ar' ? ` ${ARABIC_RULES}` : '') +
          (context.genre && context.genre !== 'auto' ? ` ${GENRE_RULES[context.genre](langName(target))}` : '') +
          (context.glossary
            ? ' A GLOSSARY may come first: the names and terms of this whole video, each with the ' +
              'rendering to use every time it appears. Follow it exactly; it is reference, not text ' +
              'to translate.'
            : ''),
      },
      { role: 'user', content: parts.join('\n\n') },
    ],
    0.2,
  );
  return stripWrapper(answer);
}

const NVIDIA_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';

/** Longest a single NVIDIA chat call may take; Kimi thinks before it answers. */
const NVIDIA_CHAT_TIMEOUT_MS = 60_000;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * One answer from a `chat` or `nvidia-chat` translator — the same messages
 * either way, sent to Workers AI or to NVIDIA's endpoint.
 *
 * NVIDIA rate-limits by the minute and a translation fans six units out at
 * once, so a 429 waits and tries again once here rather than spending one of
 * `translateText`'s two attempts, whose fallback is untranslated source text.
 * Reasoning models can leave their `<think>` block in the answer; it is cut.
 */
export async function chatComplete(
  env: Env,
  model: TranslatorModel,
  messages: ChatMessage[],
  temperature: number,
): Promise<string> {
  if (model.kind !== 'nvidia-chat') {
    const res: any = await env.AI.run(model.model as any, { messages, temperature } as any);
    return String(res?.response ?? '').trim();
  }

  const apiKey = env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error(`${model.model} is selected as translator but NVIDIA_API_KEY is not set`);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(NVIDIA_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: model.model, messages, temperature, max_tokens: 4096, stream: false }),
      signal: AbortSignal.timeout(NVIDIA_CHAT_TIMEOUT_MS),
    });
    if (res.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    if (!res.ok) throw new Error(`${model.model} failed (${res.status}): ${await res.text()}`);
    const data: any = await res.json();
    return String(data?.choices?.[0]?.message?.content ?? '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim();
  }
}

/**
 * NVIDIA Riva: an external chat-completions endpoint, not Workers AI, and its
 * own rigid prompt shape — the system message is the bare `source-target`
 * language pair, the user message is the text and nothing else. No CONTEXT
 * BEFORE/AFTER, no tone instructions: NVIDIA's own docs say the model was
 * fine-tuned on exactly this template and underperforms off it, so unlike
 * `promptTranslate` this deliberately does not reuse that context window.
 */
export async function nvidiaTranslate(
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
export async function mtTranslate(
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
