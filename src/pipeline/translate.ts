import { labelFor, TRANSLATORS, type GenreId, type TranslatorId } from '../captions/settings';
import { sanitize } from '../captions/text';
import type { Env, Segment } from '../types';
import { tidyArabic } from './arabic';
import { SENTENCE_END } from './fit';
import {
  chatComplete,
  langName,
  mtTranslate,
  nvidiaTranslate,
  promptTranslate,
  sourceName,
  stripWrapper,
  type TranslationContext,
  type TranslatorModel,
} from './translators';

/**
 * Translation: grouping the transcript into whole sentences, translating each
 * with its neighbours as context, and checking the answer is in the target
 * language before it is kept.
 */

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
export function groupForTranslation(segments: Segment[]): Segment[] {
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

/** A unit's words, ignoring case and punctuation, for spotting a repeat. */
const spokenWords = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Merge a phrase said again straight after itself into one unit.
 *
 * "All right. / All right." and "I've got it. / I've got it." are two cues on
 * the audio but one thing said, and the Netflix Arabic guide (§17) has the
 * phrase translated once and timed across both. Translating each copy alone
 * was also the worst case for meaning: a two-word line with nothing in it to
 * say what "it" is. Only an exact repeat after a short gap merges — "You can't
 * deny" after "You cannot deny" is someone saying it differently, not again.
 */
export function collapseRepeats(units: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const unit of units) {
    const previous = out[out.length - 1];
    if (
      previous &&
      spokenWords(previous.text) === spokenWords(unit.text) &&
      unit.start - previous.end <= TRANSLATION_GAP_SECONDS
    ) {
      out[out.length - 1] = { ...previous, end: unit.end };
      continue;
    }
    out.push(unit);
  }
  return out;
}

/**
 * The units a translation works in: whole sentences, with back-to-back
 * repeats merged. Exported so the eval lines its units up with the output.
 */
export const translationUnits = (segments: Segment[]): Segment[] =>
  collapseRepeats(groupForTranslation(segments));

/** The tail of the previous unit and the head of the next, as context. */
const contextTail = (text?: string): string =>
  text ? text.slice(Math.max(0, text.length - TRANSLATION_CONTEXT_CHARS)) : '';
const contextHead = (text?: string): string => (text ? text.slice(0, TRANSLATION_CONTEXT_CHARS) : '');

/**
 * The transcript as the cues to burn, for 🌐 Original — no translator call.
 *
 * Grouped into sentences exactly as a translation would be, so the stored cues
 * have the same shape either way and `fitSegments` splits both the same way at
 * the burn; and cleaned the same way `translateSegments` cleans its output.
 */
export function asSpoken(segments: Segment[]): Segment[] {
  return groupForTranslation(segments)
    .map((unit) => ({ ...unit, text: sanitize(unit.text).replace(/\s+/g, ' ').trim() }))
    .filter((unit) => unit.text.length > 0);
}

/** Translators that take a prompt, and so can be told about context, genre and glossary. */
const isChat = (model: TranslatorModel): boolean => model.kind === 'chat' || model.kind === 'nvidia-chat';

/** How much of the transcript the glossary call reads. A long video's names are mostly introduced early. */
const GLOSSARY_SOURCE_CHARS = 12_000;
const GLOSSARY_MAX_ENTRIES = 25;

/**
 * Whether a glossary line is a name or a term, the only things a glossary may
 * fix. A phrase or line of dialogue pinned to one rendering is worse than no
 * glossary: a first run locked "You a**hole = أنت خسيس" (a weak insult) into
 * every unit, and "Come on = هيا" pulled "Come on, I can take it" off its
 * meaning. So beyond what the prompt asks, an entry is dropped when its source
 * is more than four words or carries sentence punctuation, or its rendering
 * has a note in brackets (an idiom glossed with its meaning).
 */
function isGlossaryEntry(term: string, rendering: string, target: string): boolean {
  if (term.split(/\s+/).length > 4 || /[.!?,;*]/.test(term)) return false;
  if (/[()]/.test(rendering)) return false;
  return isPlausible(rendering, target);
}

/**
 * This video's names and recurring terms, each with the one rendering every
 * unit must use: the consistency table the Netflix guide calls a KNP list.
 *
 * Units are translated in parallel and each sees only its neighbours, so
 * nothing else stops "Bob Osteen" coming out as بوب أوستين in one line and
 * بوب أوستن in the next — a risk that grew once Arabic stopped keeping names
 * in Latin letters — or a lecture's key term changing word halfway through.
 *
 * One call per video, over the whole transcript. An entry is kept only when
 * its rendering is plausibly in the target language, and any failure returns
 * no glossary rather than costing the translation.
 */
export async function buildGlossary(
  env: Env,
  model: TranslatorModel,
  units: Segment[],
  source: string,
  target: string,
  genre: GenreId,
): Promise<string> {
  const transcript = units.map((u) => u.text).join('\n').slice(0, GLOSSARY_SOURCE_CHARS);
  if (!transcript.trim()) return '';

  try {
    const answer = await chatComplete(
      env,
      model,
      [
        {
          role: 'system',
          content:
            `You prepare a glossary for translating a video's subtitles from ${sourceName(source)} ` +
            `to ${langName(target)}${genre === 'auto' ? '' : ` (the video is: ${labelFor('genre', genre)})`}. ` +
            'List only the names of people, places, organisations and brands, and the technical terms ' +
            'of a field (medicine, law, finance, science) that recur. Never list everyday words, ' +
            'greetings, idioms, or phrases and lines of dialogue: those depend on their context and must ' +
            `be translated fresh each time. Give each entry the single ${langName(target)} rendering to use` +
            (target === 'ar' ? ', with names transliterated into Arabic letters' : '') +
            ', and nothing else on the line. ' +
            `At most ${GLOSSARY_MAX_ENTRIES} entries, one per line, as: source = rendering. ` +
            'Nothing else: no numbering, no notes. If there is nothing worth listing, reply NONE.',
        },
        { role: 'user', content: transcript },
      ],
      0.1,
    );

    const entries = answer
      .split('\n')
      .map((line) => /^\s*(?:[-*•]|\d+[.)])?\s*(.+?)\s*(?:=|→)\s*(.+?)\s*$/.exec(line))
      .filter((m): m is RegExpExecArray => !!m && isGlossaryEntry(m[1], m[2], target))
      .slice(0, GLOSSARY_MAX_ENTRIES)
      .map((m) => `${m[1]} = ${sanitize(m[2])}`);
    if (entries.length) console.log(`[ai] glossary: ${entries.join('; ')}`);
    return entries.join('\n');
  } catch (err) {
    console.error('[ai] glossary failed, translating without one:', err);
    return '';
  }
}

export async function translateSegments(
  env: Env,
  segments: Segment[],
  sourceLang: string,
  targetLang: string,
  translator: TranslatorId,
  genre: GenreId = 'auto',
): Promise<Segment[]> {
  return translateWith(env, segments, sourceLang, targetLang, TRANSLATORS[translator] ?? TRANSLATORS.llama70b, genre);
}

/**
 * `translateSegments` with the model handed in rather than looked up, so the
 * translation eval (`tests/translation/eval.ts`) can run the production path
 * over candidates that are not on the 🧠 Translator menu.
 */
export async function translateWith(
  env: Env,
  segments: Segment[],
  sourceLang: string,
  targetLang: string,
  model: TranslatorModel,
  genre: GenreId = 'auto',
): Promise<Segment[]> {
  // `auto` stays `auto` for a chat model, which is told to read the language
  // off the text: STT's detected language is not kept, and assuming English
  // sent every non-English video to the model as "from English".
  const source = sourceLang || 'auto';
  const target = targetLang || 'ar';
  const units = translationUnits(segments);
  const glossary = isChat(model) ? await buildGlossary(env, model, units, source, target, genre) : '';

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
      genre,
      glossary,
    };
    const text = await translateText(env, unit.text, source, target, model, context);
    // Whitespace-normalised the way `clean` does it for the transcript: a model
    // that pads or doubles a space would otherwise have it burned in, because a
    // cue short enough to skip `resegment` never has its words rejoined. The
    // same call drops the bidi marks and presentation forms a model leaks into
    // Arabic — see `sanitize`.
    const clean = sanitize(text).replace(/\s+/g, ' ').trim();
    return { ...unit, text: target === 'ar' ? tidyArabic(clean) : clean };
  });
}

/**
 * The Unicode script each target language is written in; a target not listed
 * goes unchecked. Latin is allowed on top of it everywhere, because names and
 * numbers keep their source spelling in most targets — Arabic transliterates
 * them, but a stray Latin name there is mended by `repairLeaks`, not rejected.
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
export function isPlausible(text: string, target: string): boolean {
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
 *
 * Arabic is the exception to all of that: the Netflix Arabic guide writes
 * names, brands and acronyms in Arabic letters, so there every Latin word is
 * one to mend.
 */
export function leakedWords(text: string, sourceText: string, target: string): string[] {
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
    // Arabic subtitles carry no Latin letters at all: names, brands and
    // acronyms are transliterated (see `ARABIC_RULES`).
    if (target === 'ar') {
      leaks.add(word);
      continue;
    }
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
        isChat(model)
          ? await promptTranslate(env, model, text, source, target, context)
          : model.kind === 'nvidia'
            ? await nvidiaTranslate(env, model.model, text, source === 'auto' ? 'en' : source, target)
            : await mtTranslate(env, model.model, text, source === 'auto' ? 'en' : source, target);
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
 * Chat translators only (`chat` and `nvidia-chat`): `m2m100` and Riva take no instructions, so for those
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
  if (!isChat(model)) {
    console.warn('[ai] translation has words not in the target language:', leaks.join(', '));
    return translation;
  }

  try {
    const answer = await chatComplete(
      env,
      model,
      [
        {
          role: 'system',
          content:
            `You fix subtitle translations from ${sourceName(source)} to ${langName(target)}. ` +
            `The words listed under WRONG WORDS in the TRANSLATION are not ${langName(target)}: ` +
            `some were left in ${sourceName(source)}, some slipped in from another language. ` +
            `Replace each of them with the right ${langName(target)} word, reading the ORIGINAL ` +
            'to see what belongs there, and change nothing else. ' +
            (target === 'ar'
              ? 'A name, brand or acronym is transliterated into Arabic letters. '
              : 'A word that is really a name or a brand keeps its spelling. ') +
            `Reply with ONLY the corrected ${langName(target)} line — no quotes, no labels, ` +
            'no notes, nothing before or after it.',
        },
        {
          role: 'user',
          content: `ORIGINAL: ${sourceText}\n\nTRANSLATION: ${translation}\n\nWRONG WORDS: ${leaks.join(', ')}`,
        },
      ],
      0.1,
    );
    const repaired = stripWrapper(answer);
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
