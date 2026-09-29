import { Resvg, initWasm } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import alJazeeraRegular from './fonts/Al-Jazeera-Regular.ttf';
import alJazeeraBold from './fonts/Al-Jazeera-Bold.ttf';
import thmanyahRegular from './fonts/thmanyah-serif-display-Regular.ttf';
import notoRegular from '../../public/ttf/NotoNaskhArabic-Regular.ttf';
import almaraiRegular from '../../public/ttf/Almarai-Regular.ttf';
import almaraiBold from '../../public/ttf/Almarai-Bold.ttf';
import cairoRegular from '../../public/ttf/Cairo-Regular.ttf';
import cairoBold from '../../public/ttf/Cairo-Bold.ttf';
import dubaiRegular from '../../public/ttf/Dubai-Regular.ttf';
import frutigerRegular from '../../public/ttf/FrutigerLTArabic-Regular.ttf';
import frutigerBold from '../../public/ttf/FrutigerLTArabic-Bold.ttf';
import neosansRegular from '../../public/ttf/NeoSansArabic-Regular.ttf';
import arimoRegular from '../../public/ttf/Arimo-Regular.ttf';
import arimoBold from '../../public/ttf/Arimo-Bold.ttf';
import tinosRegular from '../../public/ttf/Tinos-Regular.ttf';
import tinosBold from '../../public/ttf/Tinos-Bold.ttf';
import { FONTS, type CaptionSettings, type FontId } from './settings';
import { assOptionsFor, resolveStyle, type ResolvedStyle } from './subtitles';
import { sanitize } from './text';
import { fitSegments } from '../pipeline/fit';
import type { Segment } from '../types';

/**
 * The 🧾 card's picture: sample captions drawn onto the video's thumbnail in
 * the Worker, with no container.
 *
 * An approximation of the burn, and it says so on the card. The sizes,
 * colours, margins and line length all come from the same `resolveStyle` and
 * `fitSegments` the burn uses; what differs is the rasteriser. resvg shapes
 * text with rustybuzz (a HarfBuzz port) and draws outlines as SVG strokes,
 * where libass has its own stroker and line layout, so edges and exact line
 * breaks can differ by a few pixels. It is for judging size, position and
 * colour at a glance — the 🖼 frame on the ✏️ card is still the exact one.
 *
 * The two woff2 fonts are decompressed copies in `./fonts/` (resvg reads
 * sfnt only); every other face is imported straight from `public/ttf`, the
 * same files the container image is built from.
 */

interface Face {
  regular: ArrayBuffer;
  bold?: ArrayBuffer;
}

const FACES: Record<FontId, Face> = {
  aljazeera: { regular: alJazeeraRegular, bold: alJazeeraBold },
  thmanyah: { regular: thmanyahRegular },
  noto: { regular: notoRegular },
  almarai: { regular: almaraiRegular, bold: almaraiBold },
  cairo: { regular: cairoRegular, bold: cairoBold },
  dubai: { regular: dubaiRegular },
  frutiger: { regular: frutigerRegular, bold: frutigerBold },
  neosans: { regular: neosansRegular },
  // Arimo and Tinos: the metric twins behind the 'Arial' and 'Times New
  // Roman' menu labels — see FONTS in settings.ts.
  arial: { regular: arimoRegular, bold: arimoBold },
  times: { regular: tinosRegular, bold: tinosBold },
};

/**
 * Sample text per caption language: two sentences, so 📏 Line length has
 * something to split and the picture shows the first cue it would produce.
 */
const SAMPLES: Record<string, string> = {
  ar: 'هكذا ستظهر الترجمة على الفيديو. غيّر أي إعداد وشاهد النتيجة هنا.',
  en: 'This is how your captions will look. Change a setting to see it here.',
  es: 'Así se verán tus subtítulos en el vídeo. Cambia un ajuste para verlo aquí.',
  fr: 'Voici à quoi ressembleront vos sous-titres. Changez un réglage pour le voir ici.',
  hi: 'आपके कैप्शन ऐसे दिखेंगे। कोई सेटिंग बदलें और यहाँ देखें।',
  ur: 'آپ کے کیپشن ایسے دکھائی دیں گے۔ کوئی سیٹنگ بدلیں اور یہاں دیکھیں۔',
  fa: 'زیرنویس‌های شما این‌گونه دیده می‌شوند. یک تنظیم را تغییر دهید و اینجا ببینید.',
  tr: 'Altyazılarınız videoda böyle görünecek. Bir ayarı değiştirin ve burada görün.',
  ru: 'Так будут выглядеть ваши субтитры. Измените настройку и посмотрите здесь.',
  pt: 'É assim que suas legendas vão ficar. Mude uma configuração para ver aqui.',
};

/** How long the sample is on screen, which only 📏 'auto' reads. */
const SAMPLE_SECONDS = 6;

/** Longest side of the picture sent to Telegram, in pixels. */
const OUTPUT_LONG_SIDE = 1280;

/** A frame size to lay out on when neither the video nor the thumbnail gives one. */
const FALLBACK_FRAME = { width: 720, height: 1280 };

/** Settings that change the picture — anything else leaves it as it is. */
export const MOCKUP_FIELDS = new Set<keyof CaptionSettings>([
  'preset',
  'font',
  'size',
  'color',
  'background',
  'position',
  'chars',
  'sourceLang',
  'targetLang',
]);

let wasmReady: Promise<void> | undefined;

/** Instantiated once per isolate; a failed start is retried on the next call. */
function ensureWasm(): Promise<void> {
  wasmReady ??= initWasm(resvgWasm).catch((err) => {
    wasmReady = undefined;
    throw err;
  });
  return wasmReady;
}

export interface MockupInput {
  settings: CaptionSettings;
  /** Thumbnail bytes. Without one the captions go on a plain dark frame. */
  image?: ArrayBuffer;
  /** The video's real frame size, when known; otherwise the thumbnail's shape is used. */
  width?: number;
  height?: number;
}

/** Render the picture as PNG bytes. Throws on failure; callers fall back to text. */
export async function renderMockup(input: MockupInput): Promise<Uint8Array> {
  await ensureWasm();

  const image = input.image ? new Uint8Array(input.image) : undefined;
  const type = image ? imageType(image) : undefined;
  const frame = frameSize(input, image && type ? imageSize(image, type) : undefined);
  // resvg-wasm draws WebP as nothing at all, so a WebP still sets the frame's
  // shape but the captions go on the plain frame. Telegram's own thumbnails,
  // which is what both routes read, are JPEG.
  const mime = type === 'image/webp' ? undefined : type;

  const sample = sampleText(input.settings);
  const cues = fitSegments([sample], input.settings, frame);
  const text = sanitize(cues[0]?.text ?? sample.text).trim();

  const opts = assOptionsFor(input.settings, frame, [sample]);
  const style = resolveStyle(opts);
  const face = FACES[input.settings.font] ?? FACES.aljazeera;
  const fonts = [new Uint8Array(face.regular), ...(style.bold && face.bold ? [new Uint8Array(face.bold)] : [])];
  const metrics = fontMetrics(new Uint8Array(face.regular));

  const family = FONTS[input.settings.font]?.family ?? FONTS.aljazeera.family;
  // libass sizes a face so ascender + descender (OS/2 win metrics, as GDI
  // does) equals the ASS Fontsize; SVG's font-size is the em. Converting here
  // is what keeps a tall-metric font like Noto Naskh from drawing twice the
  // size it burns at.
  const em = (style.fontSize * metrics.unitsPerEm) / (metrics.ascent + metrics.descent);
  const ascent = (style.fontSize * metrics.ascent) / (metrics.ascent + metrics.descent);

  const textAttrs = [
    `font-family="${escapeXml(family)}"`,
    `font-size="${em.toFixed(2)}"`,
    style.bold ? 'font-weight="bold"' : '',
    style.rtl ? 'direction="rtl" unicode-bidi="embed"' : '',
  ].join(' ');

  const measure = (line: string) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}"><text x="${frame.width / 2}" y="${frame.height / 2}" ${textAttrs}>${escapeXml(line)}</text></svg>`;
    const r = new Resvg(svg, { font: { fontBuffers: fonts, defaultFontFamily: family } });
    const box = r.getBBox();
    const out = box ? { x: box.x - frame.width / 2, width: box.width } : { x: 0, width: 0 };
    box?.free();
    r.free();
    return out;
  };

  const lines = wrap(text, frame.width - 2 * style.marginH, measure);
  const svg = compose(frame, style, lines, textAttrs, ascent, image, mime);

  const scale = Math.min(1, OUTPUT_LONG_SIDE / Math.max(frame.width, frame.height));
  const resvg = new Resvg(svg, {
    font: { fontBuffers: fonts, defaultFontFamily: family },
    fitTo: { mode: 'width', value: Math.round(frame.width * scale) },
  });
  try {
    const rendered = resvg.render();
    const png = rendered.asPng();
    rendered.free();
    return png;
  } finally {
    resvg.free();
  }
}

function sampleText(settings: CaptionSettings): Segment {
  const lang = settings.targetLang === 'original' ? settings.sourceLang : settings.targetLang;
  return { start: 0, end: SAMPLE_SECONDS, text: SAMPLES[lang] ?? SAMPLES.en };
}

function frameSize(
  input: MockupInput,
  thumb: { width: number; height: number } | undefined,
): { width: number; height: number } {
  if (input.width && input.height) return { width: input.width, height: input.height };
  if (!thumb) return FALLBACK_FRAME;
  // A thumbnail is a few hundred pixels across; the burn's size clamps are in
  // real frame pixels, so lay out on a frame of that shape at a real size.
  const scale = 1280 / Math.max(thumb.width, thumb.height);
  return { width: Math.round(thumb.width * scale), height: Math.round(thumb.height * scale) };
}

interface Line {
  text: string;
  x: number;
  width: number;
}

/**
 * libass WrapStyle 0: a line too wide for the frame is broken into lines of
 * roughly equal width rather than filled greedily. Words are never split.
 */
function wrap(text: string, available: number, measure: (s: string) => { x: number; width: number }): Line[] {
  const whole = measure(text);
  if (whole.width <= available) return [{ text, ...whole }];

  const words = text.split(/\s+/).filter(Boolean);
  for (let count = 2; count <= Math.min(words.length, 4); count++) {
    const lines = balance(words, count).map((t) => ({ text: t, ...measure(t) }));
    if (lines.every((l) => l.width <= available) || count === Math.min(words.length, 4)) return lines;
  }
  return [{ text, ...whole }];
}

/** Split words into `count` lines of about the same character count. */
function balance(words: string[], count: number): string[] {
  const total = words.join(' ').length;
  const target = total / count;
  const lines: string[] = [];
  let current: string[] = [];

  for (const word of words) {
    const next = [...current, word].join(' ');
    if (current.length > 0 && next.length > target && lines.length < count - 1) {
      lines.push(current.join(' '));
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) lines.push(current.join(' '));
  return lines;
}

/** Lay the lines out the way libass places a block at an ASS alignment. */
function compose(
  frame: { width: number; height: number },
  style: ResolvedStyle,
  lines: Line[],
  textAttrs: string,
  ascent: number,
  image: Uint8Array | undefined,
  mime: string | undefined,
): string {
  const { width, height } = frame;
  const lineHeight = style.fontSize;
  const blockHeight = lines.length * lineHeight;

  const row = Math.ceil(style.align / 3); // 1 bottom, 2 middle, 3 top
  const column = ((style.align - 1) % 3) + 1; // 1 left, 2 centre, 3 right
  const top =
    row === 1 ? height - style.marginV - blockHeight : row === 3 ? style.marginV : (height - blockHeight) / 2;

  const background =
    image && mime
      ? `<image href="data:${mime};base64,${toBase64(image)}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>`
      : `<rect width="${width}" height="${height}" fill="#3a3f47"/>`;

  const primary = assToSvg(style.primary);
  const edge = assToSvg(style.outlineColour);
  const back = assToSvg(style.backColour);
  const pad = style.outline;
  const layers: string[] = [];

  lines.forEach((line, i) => {
    const lineTop = top + i * lineHeight;
    const left =
      column === 1
        ? style.marginH
        : column === 3
          ? width - style.marginH - line.width
          : (width - line.width) / 2;
    // Measured at x = 0 with the ink starting at `line.x`; shift so it starts at `left`.
    const x = left - line.x;
    const y = lineTop + ascent;
    const content = escapeXml(line.text);

    if (style.borderStyle === 3) {
      // A box per line, grown by the Outline value — which is how libass sizes it.
      const rect = (dx: number, fill: { color: string; opacity: number }) =>
        `<rect x="${(left - pad + dx).toFixed(1)}" y="${(lineTop - pad + dx).toFixed(1)}" width="${(line.width + 2 * pad).toFixed(1)}" height="${(lineHeight + 2 * pad).toFixed(1)}" fill="${fill.color}" fill-opacity="${fill.opacity}"/>`;
      if (style.shadow > 0) layers.push(rect(style.shadow, back));
      layers.push(rect(0, edge));
      layers.push(textEl(x, y, textAttrs, content, primary));
      return;
    }

    const stroke = style.outline > 0 ? style.outline * 2 : 0;
    if (style.shadow > 0) {
      layers.push(textEl(x + style.shadow, y + style.shadow, textAttrs, content, back, back, stroke));
    }
    layers.push(textEl(x, y, textAttrs, content, primary, edge, stroke));
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${background}${layers.join('')}</svg>`;
}

function textEl(
  x: number,
  y: number,
  attrs: string,
  content: string,
  fill: { color: string; opacity: number },
  stroke?: { color: string; opacity: number },
  strokeWidth = 0,
): string {
  const outline =
    stroke && strokeWidth > 0
      ? ` stroke="${stroke.color}" stroke-opacity="${stroke.opacity}" stroke-width="${strokeWidth.toFixed(2)}" stroke-linejoin="round" paint-order="stroke"`
      : '';
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" ${attrs} fill="${fill.color}" fill-opacity="${fill.opacity}"${outline}>${content}</text>`;
}

/** &HAABBGGRR, where alpha 00 is opaque, to an SVG colour and opacity. */
function assToSvg(ass: string): { color: string; opacity: number } {
  const hex = ass.replace(/^&H/i, '').padStart(8, '0');
  const alpha = parseInt(hex.slice(0, 2), 16);
  const [b, g, r] = [hex.slice(2, 4), hex.slice(4, 6), hex.slice(6, 8)];
  return { color: `#${r}${g}${b}`, opacity: Math.round((1 - alpha / 255) * 1000) / 1000 };
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Image type from its magic bytes. */
function imageType(b: Uint8Array): string | undefined {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  return undefined;
}

/** Pixel size from the image header, without decoding it. */
function imageSize(b: Uint8Array, mime: string): { width: number; height: number } | undefined {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (mime === 'image/png') return { width: view.getUint32(16), height: view.getUint32(20) };
    if (mime === 'image/gif') return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return undefined;
        const marker = b[i + 1];
        const length = view.getUint16(i + 2);
        // SOF0–SOF15, less DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
        }
        i += 2 + length;
      }
      return undefined;
    }
    if (mime === 'image/webp') {
      const chunk = ascii(b, 12, 4);
      if (chunk === 'VP8X') {
        return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      }
      if (chunk === 'VP8L') {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** unitsPerEm from `head`, and OS/2 usWinAscent/usWinDescent — what libass sizes by. */
function fontMetrics(font: Uint8Array): { unitsPerEm: number; ascent: number; descent: number } {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tables = view.getUint16(4);
  let unitsPerEm = 1000;
  let ascent = 800;
  let descent = 200;

  for (let i = 0; i < tables; i++) {
    const record = 12 + i * 16;
    const tag = ascii(font, record, 4);
    const offset = view.getUint32(record + 8);
    if (tag === 'head') unitsPerEm = view.getUint16(offset + 18);
    if (tag === 'OS/2') {
      ascent = view.getUint16(offset + 74);
      descent = view.getUint16(offset + 76);
    }
  }
  if (ascent + descent <= 0) return { unitsPerEm, ascent: 800, descent: 200 };
  return { unitsPerEm, ascent, descent };
}
