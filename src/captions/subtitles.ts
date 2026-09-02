import type { Segment } from './types';

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
  shadow75Black: assColor(0, 0, 0, 0.25),
};

/** Text colours offered in the bot's settings menu. */
export const TEXT_COLORS = {
  white: { label: 'White', value: COLOR.white },
  yellow: { label: 'Yellow', value: COLOR.hormoziYellow },
  green: { label: 'Green', value: assColor(0, 255, 135) },
  cyan: { label: 'Cyan', value: assColor(0, 209, 255) },
  black: { label: 'Black', value: COLOR.black },
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
export type CaptionSize = 'small' | 'medium' | 'large';
export type CaptionPosition = 'top' | 'center' | 'bottom';

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

/** ASS numpad alignment. */
const ALIGNMENT: Record<CaptionPosition, number> = { bottom: 2, center: 5, top: 8 };

const SIZE_SCALE: Record<CaptionSize, number> = { small: 0.7, medium: 1, large: 1.5 };

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

/** Apply the per-axis overrides on top of a preset, mirroring the web UI. */
function applyOverrides(base: PresetStyle, opts: AssOptions): PresetStyle {
  const style = { ...base };

  if (opts.color && TEXT_COLORS[opts.color]) {
    style.primary = TEXT_COLORS[opts.color].value;
  }

  switch (opts.background) {
    case 'none':
      style.borderStyle = 1;
      style.outlineColour = COLOR.black;
      // Without a box the text needs an outline to stay readable.
      if (style.outline === 'none') style.outline = 'med';
      break;
    case 'box':
      style.borderStyle = 3;
      style.outlineColour = COLOR.box75Black;
      break;
    case 'solid':
      style.borderStyle = 3;
      style.outlineColour = COLOR.black;
      break;
    default:
      break;
  }

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
  const fontSize = clamp(Math.round(height * 0.045 * scale * (rtl ? RTL_SIZE_BUMP : 1)), 18, 120);

  const outline = round2(fontSize * OUTLINE_RATIO[style.outline]);
  const shadow = round2(fontSize * 0.035 * style.shadow);
  const marginV = Math.round(height * 0.045);
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
      `${ALIGNMENT[position]},${marginH},${marginH},${marginV}`,
      '1', // Encoding 1 = Unicode; set explicitly so legacy fonts skip ANSI mode.
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

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
  return text
    .replace(/\\/g, '')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, '\\N')
    .trim();
}
