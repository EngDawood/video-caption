import type { TRANSLATORS, TranslatorId } from '../captions/settings';
import type { Env } from '../types';

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
};

export const langName = (code: string): string => LANGUAGE_NAMES[code] ?? code;

export type TranslatorModel = (typeof TRANSLATORS)[TranslatorId];

export interface TranslationContext {
  before: string;
  after: string;
}

/** Models sometimes echo the label or wrap the line in quotes; take that back off. */
export function stripWrapper(text: string): string {
  const unlabelled = text.replace(/^\s*(?:TEXT|TRANSLATION)\s*:\s*/i, '').trim();
  const quoted = /^(["'«“])([\s\S]*)(["'»”])$/.exec(unlabelled);
  return (quoted ? quoted[2] : unlabelled).trim();
}

/** Chat models: told what to do, and told firmly not to add anything around it. */
export async function promptTranslate(
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

const NVIDIA_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';

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
