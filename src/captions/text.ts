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

/** Invisible formatting characters, minus ZWNJ. */
const CONTROLS =
  /[\u00AD\u061C\u200B\u200D-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/;

/** Arabic Presentation Forms-A and -B. U+FEFF is a control and is stripped first. */
const PRESENTATION = /[\uFB50-\uFDFF\uFE70-\uFEFF]/;

const CONTROLS_G = new RegExp(CONTROLS.source, 'gu');
const PRESENTATION_G = new RegExp(PRESENTATION.source, 'gu');

/** Drop what cannot be drawn, and spell what can be spelled canonically. */
export function sanitize(text: string): string {
  return text.replace(CONTROLS_G, '').replace(PRESENTATION_G, (ch) => ch.normalize('NFKC'));
}

/**
 * What `sanitize` would touch, as `U+200F` codepoints.
 *
 * The burn logs this so a font that renders boxes can be diagnosed from
 * `wrangler tail` instead of from a screenshot: either the offending character
 * is named here, or the text was clean and the font itself is at fault.
 */
export function foreignCharacters(text: string): string[] {
  const seen = new Set<string>();

  for (const ch of text) {
    if (!CONTROLS.test(ch) && !PRESENTATION.test(ch)) continue;
    seen.add(`U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
  }

  return [...seen];
}
