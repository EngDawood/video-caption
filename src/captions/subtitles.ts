import { foreignCharacters, sanitize, unexpectedCharacters } from './text';
import { FONTS, isRtlLang, type CaptionSettings } from './settings';
import {
  COLOR,
  POSITIONS,
  TEXT_COLORS,
  type BackgroundId,
  type CaptionPosition,
  type CaptionPreset,
  type CaptionSize,
  type TextColorId,
} from './options';
import type { Segment, VideoMeta } from '../types';

/**
 * ASS subtitle generation for hard-burn via libass.
 *
 * The style presets are ported from ffmpeg-webCLI's ffmpeg-caption-styles.js.
 * That project's browser build had to fake this with canvas PNGs because the
 * @ffmpeg/core WASM build ships no fonts for libass — here ffmpeg is real and
 * the fonts are installed in the image, so the ASS goes straight through the
 * `ass` filter.
 */

/** Right-to-left embedding marks: keep digits and Latin words correctly placed
 *  inside an Arabic line. Shaping and bidi themselves are libass + HarfBuzz. */
const RLE = '‫';
const PDF = '‬';

/** Floor for a cue's on-screen time, so a zero-length segment still reads. */
const MIN_CUE_SECONDS = 0.8;

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

/** Side margin as a fraction of frame width, one per edge. */
const MARGIN_H_RATIO = 0.07;

/**
 * Caption height in frame pixels, for one size step.
 *
 * Pulled out of `buildAss` because 📏 Line length 'auto' has to know it: the
 * number of characters that fit on a line is the usable width divided by the
 * width of a glyph, and a glyph's width comes from here.
 */
export function fontSizeFor(height: number, size: CaptionSize | undefined, rtl: boolean): number {
  const scale = SIZE_SCALE[size ?? 'medium'] ?? 1;
  return clamp(
    Math.round(height * 0.045 * scale * (rtl ? RTL_SIZE_BUMP : 1)),
    MIN_FONT_PX,
    MAX_FONT_PX,
  );
}

/**
 * Average glyph advance as a fraction of the font size.
 *
 * An estimate, and deliberately so: the exact answer needs the font's own
 * metrics per character, which only libass inside the container can see. These
 * two numbers are the mean advance over ordinary caption text — Arabic naskh
 * sits narrower than Latin at the same point size, which is also why it gets
 * `RTL_SIZE_BUMP` to begin with.
 */
const ADVANCE_RATIO = { ltr: 0.5, rtl: 0.46 };

/**
 * Bounds on the computed limit.
 *
 * The ceiling is the broadcast norm, not the widest line the frame can hold:
 * a 1920x1080 frame at medium fits about 64 characters across, and a
 * 64-character caption is past what anyone reads comfortably however well it
 * fits. So 'auto' only ever shortens — a landscape video lands on the same 42
 * a person would have picked, and a portrait one drops to what its width can
 * actually carry.
 *
 * The floor is there because the alternative is worse: at 🔠 Extra large on a
 * portrait frame only about eleven characters fit, and a limit that low cuts
 * captions to one word each. Below the floor the line wraps, which is the
 * lesser fault.
 */
const AUTO_CHARS_MIN = 16;
const AUTO_CHARS_MAX = 42;

/**
 * The longest line that stays on ONE line in this frame, at these settings.
 *
 * This is what 📏 Line length 'auto' resolves to. libass wraps a line too wide
 * for the frame rather than clipping it, so the failure a fixed limit produces
 * is silent: 42 characters is the broadcast norm for a 16:9 frame and roughly
 * double what fits across a 9:16 phone video at the same size — which is the
 * shape most videos arrive as, and where every cue quietly became two or three
 * stacked lines. Sizing the limit from the frame instead means one cue is one
 * line, whatever the video and whatever 🔠 Size is set to.
 *
 * What it works out to, for reference: 16:9 at 🔠 Medium stays on 42, 9:16 at
 * Medium drops to 20, and 9:16 at Large to the 16-character floor.
 */
export function charLimitFor(
  settings: CaptionSettings,
  meta: Pick<VideoMeta, 'width' | 'height'>,
): number {
  if (settings.chars !== 'auto') return Number(settings.chars) || 42;

  const width = meta.width || 1280;
  const height = meta.height || 720;
  const rtl = isRtlLang(settings.targetLang);
  const fontSize = fontSizeFor(height, settings.size, rtl);
  const usable = width * (1 - 2 * MARGIN_H_RATIO);
  const advance = fontSize * (rtl ? ADVANCE_RATIO.rtl : ADVANCE_RATIO.ltr);

  return clamp(Math.floor(usable / advance), AUTO_CHARS_MIN, AUTO_CHARS_MAX);
}

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
 * line, so the `ass` filter needs nothing but `fontsdir`.
 */
export function buildAss(segments: Segment[], opts: AssOptions): string {
  const width = opts.width || 1280;
  const height = opts.height || 720;
  const rtl = opts.rtl !== false;
  const style = applyOverrides(PRESETS[opts.preset ?? 'clean'] ?? PRESETS.clean, opts);
  const position = opts.position ?? 'bottom';

  const fontSize = fontSizeFor(height, opts.size, rtl);

  const outline = round2(fontSize * OUTLINE_RATIO[style.outline]);
  const shadow = round2(fontSize * 0.035 * style.shadow);
  const place = POSITIONS[position] ?? POSITIONS.bottom;
  const marginV = Math.round(height * 0.045 * place.margin);
  const marginH = Math.round(width * MARGIN_H_RATIO);
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

/**
 * `buildAss` from a chat's or a draft's `CaptionSettings` rather than the raw
 * `AssOptions` it takes — the font-family lookup and the RTL-from-target-lang
 * decision are the same two steps everywhere a burn or a preview needs an ASS
 * file, so both call this instead of repeating them.
 */
export function buildAssForSettings(
  segments: Segment[],
  settings: CaptionSettings,
  meta: Pick<VideoMeta, 'width' | 'height'>,
): string {
  const font = FONTS[settings.font];
  return buildAss(segments, {
    font: font.family,
    width: meta.width ?? 1280,
    height: meta.height ?? 720,
    rtl: isRtlLang(settings.targetLang),
    preset: settings.preset,
    size: settings.size,
    position: settings.position,
    color: settings.color,
    background: settings.background,
    allowBold: font.hasBold,
  });
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
