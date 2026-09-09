import { foreignCharacters, sanitize, unexpectedCharacters } from './text';
import type { Segment } from '../types';

/**
 * ASS subtitle generation for hard-burn via libass.
 *
 * The style presets are ported from ffmpeg-webCLI's ffmpeg-caption-styles.js.
 * That project's browser build had to fake this with canvas PNGs because the
 * @ffmpeg/core WASM build ships no fonts for libass — here ffmpeg is real and
 * the fonts are installed in the image, so the ASS goes straight through the
 * `subtitles` filter.
 */

/** Right-to-left embedding marks: keep digits and Latin words correctly placed
 *  inside an Arabic line. Shaping and bidi themselves are libass + HarfBuzz. */
const RLE = '‫';
const PDF = '‬';

/** Floor for a cue's on-screen time, so a zero-length segment still reads. */
const MIN_CUE_SECONDS = 0.8;

/**
 * ASS colours are &HAABBGGRR — blue/green/red reversed, and alpha is the
 * opposite of CSS: 00 is fully opaque, FF fully transparent.
 */
function assColor(r: number, g: number, b: number, alpha = 0): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  return `&H${hex(a)}${hex(b)}${hex(g)}${hex(r)}`;
}

const COLOR = {
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
  lowerThird: { label: 'Lower third', align: 2, margin: 4 },
  upperThird: { label: 'Upper third', align: 8, margin: 4 },
  lowerMiddle: { label: 'Lower middle', align: 2, margin: 6 },
} as const;

export type CaptionPosition = keyof typeof POSITIONS;

type OutlineWeight = 'none' | 'thin' | 'med' | 'heavy';

interface PresetStyle {
  primary: string;
  /** With BorderStyle 3 this is the box fill, with BorderStyle 1 the outline. */
  outlineColour: string;
  /** Shadow colour under BorderStyle 1. */
  backColour: string;
  /** 1 = outline + shadow, 3 = opaque box behind the text. */
  borderStyle: 1 | 3;
  outline: OutlineWeight;
  shadow: number;
  bold: boolean;
}

const PRESETS: Record<CaptionPreset, PresetStyle> = {
  /** White text, thick black outline, no box. The safe default over any footage. */
  clean: {
    primary: COLOR.white,
    outlineColour: COLOR.black,
    backColour: COLOR.shadow75Black,
    borderStyle: 1,
    outline: 'med',
    shadow: 0,
    bold: false,
  },

  /** Yellow on a solid black box — the short-form/viral look. */
  hormozi: {
    primary: COLOR.hormoziYellow,
    outlineColour: COLOR.black,
    backColour: COLOR.black,
    borderStyle: 3,
    outline: 'none',
    shadow: 0,
    bold: true,
  },

  /** No box, heavy outline and a soft shadow. Least intrusive over video. */
  cinematic: {
    primary: COLOR.white,
    outlineColour: COLOR.black,
    backColour: COLOR.shadow75Black,
    borderStyle: 1,
    outline: 'heavy',
    shadow: 0.75,
    bold: true,
  },

  /** White on a 75%-opaque black box. Maximum readability, busiest look. */
  youtube: {
    primary: COLOR.white,
    outlineColour: COLOR.box75Black,
    backColour: COLOR.black,
    borderStyle: 3,
    outline: 'none',
    shadow: 0,
    bold: false,
  },

  /** Classical Naskh treatment: thin outline plus a drop shadow, no box.
   *  Suits lectures, religious and literary content. */
  naskh: {
    primary: COLOR.white,
    outlineColour: COLOR.black,
    backColour: COLOR.shadow75Black,
    borderStyle: 1,
    outline: 'thin',
    shadow: 0.75,
    bold: false,
  },
};

/**
 * Caption height as a multiple of the medium default.
 *
 * The three original steps keep the numbers they always had, so a stored
 * setting still means what it meant. The two new ones extend the range rather
 * than re-space it.
 */
const SIZE_SCALE: Record<CaptionSize, number> = {
  xsmall: 0.55,
  small: 0.7,
  medium: 1,
  large: 1.5,
  xlarge: 2,
};

/**
 * Absolute bounds on the computed font size, in frame pixels.
 *
 * Wide, because a tight clamp silently collapses the steps into each other:
 * the old floor of 18 made small and medium identical on anything under about
 * 500px tall, and the old ceiling of 120 cut large down to a fifth over medium
 * on a 1080x1920 portrait video — the shape most videos arrive as. The bounds
 * are still here to keep an unusual frame from producing an absurd size, not
 * to shape the scale.
 */
const MIN_FONT_PX = 14;
const MAX_FONT_PX = 240;

/** Outline thickness as a fraction of the font size. */
const OUTLINE_RATIO: Record<OutlineWeight, number> = { none: 0, thin: 0.04, med: 0.08, heavy: 0.13 };

/** Arabic glyphs read smaller than Latin at the same point size. */
const RTL_SIZE_BUMP = 1.15;

export interface AssOptions {
  font: string;
  width: number;
  height: number;
  rtl?: boolean;
  preset?: CaptionPreset;
  size?: CaptionSize;
  position?: CaptionPosition;
  /**
   * Only set true for a font with a real bold weight. libass synthesises bold
   * otherwise, which smears Arabic letterforms.
   */
  allowBold?: boolean;
  /** Overrides the preset's text colour. */
  color?: TextColorId;
  /** Overrides the preset's background treatment. */
  background?: BackgroundId;
}

/**
 * Which way round a caption's backdrop goes.
 *
 * Every preset ships a black outline, a black box and a black shadow, which is
 * right under the four light text colours and unreadable under the fifth: black
 * text with a black outline is a blob, because the outline fills the counters,
 * and black text on a black box is nothing at all. The text colour is what the
 * user picked, so the backdrop is what flips.
 */
function backdropFor(color: TextColorId | undefined) {
  const dark = color ? !TEXT_COLORS[color]?.light : false;
  return dark
    ? { edge: COLOR.white, box: COLOR.box75White, shade: COLOR.shadow75White }
    : { edge: COLOR.black, box: COLOR.box75Black, shade: COLOR.shadow75Black };
}

/** Apply the per-axis overrides on top of a preset, mirroring the web UI. */
function applyOverrides(base: PresetStyle, opts: AssOptions): PresetStyle {
  const style = { ...base };
  const backdrop = backdropFor(opts.color);

  if (opts.color && TEXT_COLORS[opts.color]) {
    style.primary = TEXT_COLORS[opts.color].value;

    // The preset's own treatment needs flipping too: 🎞 Background 'preset'
    // keeps it verbatim, and clean's black outline under black text is as
    // unreadable as the box is.
    if (!TEXT_COLORS[opts.color].light) {
      style.outlineColour = style.borderStyle === 3 ? backdrop.box : backdrop.edge;
      style.backColour = backdrop.shade;
    }
  }

  switch (opts.background) {
    case 'none':
      style.borderStyle = 1;
      style.outlineColour = backdrop.edge;
      // Without a box the text needs an outline to stay readable.
      if (style.outline === 'none') style.outline = 'med';
      break;
    case 'box':
      style.borderStyle = 3;
      style.outlineColour = backdrop.box;
      // A shadow under BorderStyle 3 is a second, offset copy of the box, and
      // two 75% blacks stacked are 94% — which is not a translucent box.
      style.shadow = 0;
      break;
    case 'solid':
      style.borderStyle = 3;
      style.outlineColour = backdrop.edge;
      style.shadow = 0;
      break;
    default:
      break;
  }

  // libass sizes a BorderStyle-3 box from the Outline value, so a box style
  // with no outline draws no box at all — which is what made 🎨 Hormozi render
  // as bare yellow text and 🎨 YouTube as bare white text, with 🎞 Background
  // powerless to put the box back. Guarded once here rather than in each
  // preset and each branch above.
  if (style.borderStyle === 3 && style.outline === 'none') style.outline = 'med';

  return style;
}

/**
 * Build an ASS file. Font, size, outline and margins are baked into the Style
 * line, so the `subtitles` filter needs nothing but `fontsdir`.
 */
export function buildAss(segments: Segment[], opts: AssOptions): string {
  const width = opts.width || 1280;
  const height = opts.height || 720;
  const rtl = opts.rtl !== false;
  const style = applyOverrides(PRESETS[opts.preset ?? 'clean'] ?? PRESETS.clean, opts);
  const position = opts.position ?? 'bottom';

  const scale = SIZE_SCALE[opts.size ?? 'medium'] ?? 1;
  const fontSize = clamp(
    Math.round(height * 0.045 * scale * (rtl ? RTL_SIZE_BUMP : 1)),
    MIN_FONT_PX,
    MAX_FONT_PX,
  );

  const outline = round2(fontSize * OUTLINE_RATIO[style.outline]);
  const shadow = round2(fontSize * 0.035 * style.shadow);
  const place = POSITIONS[position] ?? POSITIONS.bottom;
  const marginV = Math.round(height * 0.045 * place.margin);
  const marginH = Math.round(width * 0.07);
  const bold = style.bold && opts.allowBold ? -1 : 0;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    // Pinning the script resolution to the real frame means every size below
    // is in true pixels rather than ASS's default 384x288 canvas.
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.601',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      `Style: Default,${opts.font},${fontSize}`,
      style.primary,
      COLOR.white,
      style.outlineColour,
      style.backColour,
      `${bold},0,0,0`,
      '100,100,0,0',
      `${style.borderStyle},${outline},${shadow}`,
      `${place.align},${marginH},${marginH},${marginV}`,
      '1', // Encoding 1 = Unicode; set explicitly so legacy fonts skip ANSI mode.
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  // Logged, not shown: a caption that renders boxes is reported as a
  // screenshot, and this is what turns that into a codepoint in `wrangler
  // tail`. Both halves matter — the first names what was removed, the second
  // what is still not ordinary caption text and may have no glyph either.
  // Both empty means the text is clean and the font is at fault; check it
  // with `/debug/fonts`.
  const raw = segments.map((s) => s.text).join('');
  const stripped = foreignCharacters(raw);
  if (stripped.length > 0) {
    console.warn(`[ass] stripped characters no caption font need draw: ${stripped.join(', ')}`);
  }

  const odd = unexpectedCharacters(sanitize(raw));
  if (odd.length > 0) {
    console.warn(`[ass] unexpected characters left in the caption text: ${odd.join(', ')}`);
  }

  const events = segments
    .filter((s) => s.text.trim())
    .map((s) => {
      const text = escapeAss(s.text);
      const body = rtl ? `${RLE}${text}${PDF}` : text;
      // A cue with no duration never paints — give it a readable minimum.
      const end = Math.max(s.end, s.start + MIN_CUE_SECONDS);
      return `Dialogue: 0,${assTime(s.start)},${assTime(end)},Default,,0,0,0,,${body}`;
    })
    .join('\n');

  return `${header}\n${events}\n`;
}

/** ASS timestamps are H:MM:SS.cc (centiseconds, hours not zero-padded). */
function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const rest = cs % 100;
  return `${h}:${pad(m)}:${pad(s)}.${pad(rest)}`;
}

const pad = (n: number) => String(n).padStart(2, '0');
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * `{}` open an override block and `\` starts an escape, so strip both before
 * re-introducing our own `\N` line breaks.
 */
function escapeAss(text: string): string {
  // `sanitize` here as well as where the text was produced: this is the one
  // point every burned character passes through, so it also covers cues stored
  // in R2 before that existed and text a user has pasted back by hand.
  return sanitize(text)
    .replace(/\\/g, '')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, '\\N')
    .trim();
}
