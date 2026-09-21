/**
 * The caption option tables both halves of the captions code read.
 *
 * `settings.ts` builds the menus from them and `subtitles.ts` renders with
 * them. They live here, importing nothing, so neither of those two has to
 * import the other to get at them: `MENUS` reads these at module load, and
 * when they sat in `subtitles.ts` — which itself imports `settings.ts` — the
 * two only worked because of which one happened to load first.
 */

/**
 * ASS colours are &HAABBGGRR — blue/green/red reversed, and alpha is the
 * opposite of CSS: 00 is fully opaque, FF fully transparent.
 */
export function assColor(r: number, g: number, b: number, alpha = 0): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  return `&H${hex(a)}${hex(b)}${hex(g)}${hex(r)}`;
}

export const COLOR = {
  white: assColor(255, 255, 255),
  black: assColor(0, 0, 0),
  hormoziYellow: assColor(254, 212, 36),
  box75Black: assColor(0, 0, 0, 0.25),
  box75White: assColor(255, 255, 255, 0.25),
  shadow75Black: assColor(0, 0, 0, 0.25),
  shadow75White: assColor(255, 255, 255, 0.25),
};

/**
 * Text colours offered in the bot's settings menu.
 *
 * `light` is what the backdrop is chosen against — see `backdropFor`. Every
 * preset ships a black outline, box and shadow, which is right under the four
 * light colours and unreadable under the dark one.
 */
export const TEXT_COLORS = {
  white: { label: 'White', value: COLOR.white, light: true },
  yellow: { label: 'Yellow', value: COLOR.hormoziYellow, light: true },
  green: { label: 'Green', value: assColor(0, 255, 135), light: true },
  cyan: { label: 'Cyan', value: assColor(0, 209, 255), light: true },
  black: { label: 'Black', value: COLOR.black, light: false },
} as const;

export type TextColorId = keyof typeof TEXT_COLORS;

/** Background treatments, independent of the preset's own choice. */
export const BACKGROUNDS = {
  preset: { label: 'Preset default' },
  none: { label: 'None (outline only)' },
  box: { label: 'Translucent box' },
  solid: { label: 'Solid box' },
} as const;

export type BackgroundId = keyof typeof BACKGROUNDS;

export type CaptionPreset = 'clean' | 'hormozi' | 'cinematic' | 'youtube' | 'naskh';
export type CaptionSize = 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';
/**
 * Where the caption block sits. `align` is the ASS numpad alignment and
 * `margin` scales the base edge margin, which is how the raised variants lift
 * the text clear of the player chrome social apps draw over a video. A margin
 * only moves the top and bottom rows — libass centres the middle row whatever
 * MarginV says.
 *
 * Append only: `MENUS.position` derives its options from this order, and
 * `encodeSettings` puts that index on the buttons. Reorder it and a card
 * minted by the previous deploy moves someone's captions somewhere else.
 * The keyboard reads in grid order instead — see `layout` in settings.ts.
 */
export const POSITIONS = {
  bottom: { label: 'Bottom', align: 2, margin: 1 },
  center: { label: 'Centre', align: 5, margin: 1 },
  top: { label: 'Top', align: 8, margin: 1 },
  bottomLeft: { label: 'Bottom left', align: 1, margin: 1 },
  bottomRight: { label: 'Bottom right', align: 3, margin: 1 },
  middleLeft: { label: 'Middle left', align: 4, margin: 1 },
  middleRight: { label: 'Middle right', align: 6, margin: 1 },
  topLeft: { label: 'Top left', align: 7, margin: 1 },
  topRight: { label: 'Top right', align: 9, margin: 1 },
  lowerThird: { label: 'Lower third — 18% up', align: 2, margin: 4 },
  upperThird: { label: 'Upper third — 18% down', align: 8, margin: 4 },
  lowerMiddle: { label: 'Lower middle — 27% up', align: 2, margin: 6 },
  // Filling in the gap between 'Bottom' and 'Centre', which was two steps
  // wide: the whole point of the raised variants is clearing whatever the
  // player draws over the bottom of a video, and how much that covers differs
  // per app. The percentage in each label is the MarginV these work out to —
  // `marginV` in subtitles.ts is `height * 0.045 * margin`.
  aboveBottom: { label: 'Above bottom — 9% up', align: 2, margin: 2 },
  belowCentre: { label: 'Below centre — 36% up', align: 2, margin: 8 },
} as const;

export type CaptionPosition = keyof typeof POSITIONS;
