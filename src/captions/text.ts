/**
 * Text that survives every stage untouched and only fails at the font.
 *
 * libass hands the caption string to HarfBuzz exactly as it stands, so a
 * character the font has no glyph for is drawn as `.notdef` — the hollow box
 * that reads as a "?" wedged inside a word. Two sources of that are worth
 * removing before the burn rather than after someone has watched the video:
 *
 * - **Bidi and joining controls.** `buildAss` already wraps every RTL line in
 *   its own RLE/PDF pair, so an RLM, LRE or ALM that a translation model
 *   emitted adds nothing and risks a box. U+200C (ZWNJ) is the one exception:
 *   Persian and Urdu spell words with it, and dropping it is a real spelling
 *   change rather than a clean-up.
 * - **Arabic presentation forms.** A model that answers with ﻻ (U+FEFB) rather
 *   than the canonical pair لا has produced text only a font shipping the
 *   Presentation Forms-B block can draw. Most Arabic fonts do not ship it —
 *   they carry the ligature as a GSUB rule over the canonical letters, which is
 *   what HarfBuzz expects to apply. NFKC on just those characters puts the
 *   canonical letters back and leaves the rest of the line alone.
 *
 * Applied where text is produced (`clean`, `translateSegments`, a pasted-back
 * correction) and again inside `escapeAss`, which is the one point every
 * burned character passes through — including cues written to R2 before any of
 * this existed.
 */

/**
 * Invisible formatting characters and the two replacement characters.
 *
 * The whole `Cf` category rather than a hand-picked list, because the ones that
 * matter are exactly the ones nobody thinks to list: U+2066 isolates, U+0600
 * number sign, U+06DD end of ayah. U+200C is the single exception — Persian and
 * Urdu spell words with it.
 *
 * U+FFFD is not a formatting character at all but belongs here for the same
 * reason: it is what a decoder leaves behind when bytes did not form valid
 * UTF-8, it carries no meaning, and no caption font draws it.
 */
const CONTROLS = /(?!\u200C)[\p{Cf}\u00AD\uFFFC\uFFFD]/u;

/** Arabic Presentation Forms-A and -B. U+FEFF is a control and is stripped first. */
const PRESENTATION = /[\uFB50-\uFDFF\uFE70-\uFEFF]/u;

const CONTROLS_G = new RegExp(CONTROLS.source, 'gu');
const PRESENTATION_G = new RegExp(PRESENTATION.source, 'gu');

/**
 * What a caption is expected to be made of: Latin, Arabic, digits, spacing and
 * ordinary punctuation.
 *
 * Deliberately conservative and independent of any font — the Worker cannot see
 * the fonts, which live in the container image. Anything outside this survives
 * `sanitize` and may still have no glyph, so it is worth naming in the log.
 *
 * The Arabic block is included in pieces rather than whole: U+0610–U+061A and
 * U+06D6–U+06ED are Quranic honorifics and recitation marks that no translated
 * caption contains and no caption font draws, so they are worth hearing about.
 * U+200C is expected — Persian and Urdu spell words with it.
 */
const EXPECTED =
  /[\s\u0020-\u007E\u00A0-\u024F\u0606-\u060F\u061B-\u06D5\u06EE-\u06FF\u200C\u2010-\u2027\u2030-\u205E\u20AC]/u;

/** Drop what cannot be drawn, and spell what can be spelled canonically. */
export function sanitize(text: string): string {
  return text.replace(CONTROLS_G, '').replace(PRESENTATION_G, (ch) => ch.normalize('NFKC'));
}

const codepoint = (ch: string) =>
  `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

/** Distinct codepoints in `text` matching `pred`, as `U+200F` strings. */
function census(text: string, pred: (ch: string) => boolean): string[] {
  const seen = new Set<string>();
  for (const ch of text) if (pred(ch)) seen.add(codepoint(ch));
  return [...seen];
}

/**
 * What `sanitize` removes or rewrites.
 *
 * Logged at the burn so a report of boxes is diagnosed from `wrangler tail`
 * rather than from a screenshot.
 */
export function foreignCharacters(text: string): string[] {
  return census(text, (ch) => CONTROLS.test(ch) || PRESENTATION.test(ch));
}

/**
 * What survives `sanitize` and is still not ordinary caption text.
 *
 * The other half of the diagnosis, and the half that matters when a burn is
 * still wrong: `foreignCharacters` can only name what we already knew to
 * remove, so a character nobody anticipated would leave the log empty and the
 * video full of boxes. This names it whatever it is.
 */
export function unexpectedCharacters(text: string): string[] {
  return census(text, (ch) => !EXPECTED.test(ch));
}
