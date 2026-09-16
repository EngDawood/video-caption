import {
  BACKGROUNDS,
  POSITIONS,
  TEXT_COLORS,
  type BackgroundId,
  type CaptionPosition,
  type CaptionPreset,
  type CaptionSize,
  type TextColorId,
} from './subtitles';
import type { Env } from '../types';

/**
 * Per-chat caption settings, edited from the bot's /settings menu and stored
 * in KV. Anything unset falls back to the wrangler.jsonc vars, so the deployed
 * defaults still apply to a chat that has never opened the menu.
 */

/**
 * Fonts bundled in the container image, by internal family name.
 *
 * Append only, like `CODE_FIELDS`: `MENUS.font` derives its options from this
 * order and `encodeSettings` puts that index on the buttons, so reordering it
 * changes the font on a card minted by the previous deploy.
 *
 * Coverage is not a detail here. Al Jazeera and Thmanyah are Arabic-only and
 * both miss the letters Urdu needs (ٹ ڈ ڑ ں ے); Thmanyah also misses Persian's
 * گ ک ی ژ ہ and the Persian digits. Noto Naskh Arabic, Almarai and Cairo carry
 * the whole Arabic block plus both supplements, so any of the three can serve
 * every RTL target on the menu.
 */
export const FONTS = {
  aljazeera: { label: 'Al Jazeera', family: 'Al Jazeera', hasBold: true },
  thmanyah: { label: 'Thmanyah Serif', family: 'thmanyah serif display', hasBold: false },
  // A variable font with a 400–700 weight axis. libass renders the default
  // instance and cannot pick 700, so bold stays off rather than being
  // synthesised — which smears Arabic letterforms.
  noto: { label: 'Noto Naskh Arabic', family: 'Noto Naskh Arabic', hasBold: false },
  // Same coverage as Noto, but Regular/Bold are separate static weights, so
  // bold actually renders instead of staying off.
  almarai: { label: 'Almarai', family: 'Almarai', hasBold: true },
  // Ships only as a variable font; Regular/Bold here are static instances
  // baked out of it, for the same reason Noto's bold stays off otherwise.
  cairo: { label: 'Cairo', family: 'Cairo', hasBold: true },
  // Internal family name is "Dubai W23 Regular", not "Dubai" — only the
  // Regular weight was supplied, so bold stays off rather than synthesised.
  dubai: { label: 'Dubai', family: 'Dubai W23 Regular', hasBold: false },
  // Commercially licensed — the 75 Black weight's own name table shipped
  // under the Roman weight's family, so its Regular/Bold no-op'd; the name
  // table was corrected so both weights register under one family.
  frutiger: { label: 'Frutiger Arabic', family: 'Frutiger LT Arabic', hasBold: true },
  // Commercially licensed. Only a Regular weight was supplied.
  neosans: { label: 'Neo Sans Arabic', family: 'Neo Sans Arabic', hasBold: false },
} as const;

export type FontId = keyof typeof FONTS;

/**
 * Offered line lengths, in characters. Stored as strings because every menu
 * value is a string on the way through a callback_data payload.
 *
 * Append only, like every other option list here — `encodeSettings` puts the
 * index on the buttons — so 'auto' goes on the end and `layout` shows it
 * first. It is not a number: `charLimitFor` resolves it per video, against
 * that video's frame and the size the captions are being drawn at.
 */
export const CHAR_LIMITS = {
  '28': { label: '28 — punchy, one short line' },
  '36': { label: '36 — tight' },
  '42': { label: '42 — broadcast norm' },
  '52': { label: '52 — relaxed' },
  '64': { label: '64 — long lines' },
  auto: { label: 'Auto — fit this video' },
} as const;

export type CharLimitId = keyof typeof CHAR_LIMITS;

/** Spoken language of the source video. 'auto' lets the STT provider detect it. */
export const SOURCE_LANGUAGES = {
  auto: { label: 'Auto-detect' },
  en: { label: 'English' },
  ar: { label: 'Arabic' },
  es: { label: 'Spanish' },
  fr: { label: 'French' },
  hi: { label: 'Hindi' },
  ur: { label: 'Urdu' },
  fa: { label: 'Persian' },
  tr: { label: 'Turkish' },
  ru: { label: 'Russian' },
} as const;

export type SourceLangId = keyof typeof SOURCE_LANGUAGES;

/** Language captions are translated into. */
export const TARGET_LANGUAGES = {
  ar: { label: 'Arabic' },
  en: { label: 'English' },
  es: { label: 'Spanish' },
  fr: { label: 'French' },
  hi: { label: 'Hindi' },
  ur: { label: 'Urdu' },
  fa: { label: 'Persian' },
  tr: { label: 'Turkish' },
  ru: { label: 'Russian' },
  pt: { label: 'Portuguese' },
} as const;

export type TargetLangId = keyof typeof TARGET_LANGUAGES;

/** Scripts that read right-to-left — drives caption shaping and line width in `buildAss`. */
const RTL_LANGS = new Set<string>(['ar', 'ur', 'fa']);

export const isRtlLang = (lang: string): boolean => RTL_LANGS.has(lang);

/**
 * Which transcription provider is tried FIRST. The others still follow as
 * fallbacks — see `sttChain` — so this is a preference, not a restriction.
 */
export const STT_PROVIDERS = {
  groq: { label: 'Groq Whisper — fastest' },
  mistral: { label: 'Mistral Voxtral' },
  'workers-ai': { label: 'Cloudflare Whisper' },
} as const;

export type SttProviderId = keyof typeof STT_PROVIDERS;

/**
 * Translation models.
 *
 * `kind` is the API shape, not a label: a chat model is sent `messages` and
 * answers in `response`, while m2m100 is sent `text`/`source_lang`/`target_lang`
 * and answers in `translated_text`.
 */
export const TRANSLATORS = {
  llama70b: {
    label: 'Llama 3.3 70B — most accurate',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    kind: 'chat',
  },
  scout: {
    label: 'Llama 4 Scout — faster',
    model: '@cf/meta/llama-4-scout-17b-16e-instruct',
    kind: 'chat',
  },
  m2m100: {
    label: 'M2M100 — literal, cheapest',
    model: '@cf/meta/m2m100-1.2b',
    kind: 'mt',
  },
} as const;

export type TranslatorId = keyof typeof TRANSLATORS;

/**
 * Whether a run stops and shows the script before it burns anything.
 *
 * Off is the default: the fast path is a video coming back with no taps in
 * between. On, the job stops once the translation is stored, posts the whole
 * script as an .srt and waits — the burn is then a re-run from those stored
 * cues, which costs one encode and no transcription.
 */
export const REVIEW = {
  off: { label: 'Off — burn straight away' },
  on: { label: 'On — show me the script first' },
} as const;

export type ReviewId = keyof typeof REVIEW;

/**
 * Whether a video stops on a settings card before anything is spent.
 *
 * On is the default: the card lists what this video is about to be captioned
 * with, and a change made on it applies to that video alone — the chat
 * defaults it was seeded from are never written back. Off is the old
 * behaviour, where an upload starts the moment it arrives.
 */
export const CONFIRM = {
  on: { label: 'On — show me the settings first' },
  off: { label: 'Off — start straight away' },
} as const;

export type ConfirmId = keyof typeof CONFIRM;

/**
 * Whether a run stops and shows one burned frame before it encodes the video.
 *
 * Off is the default: the 🖼 Preview button is already on the ✏️ card and the
 * 📝 review card, so nothing here is lost by leaving it off — this only makes
 * the check automatic. On, the run ends after the translation exactly as 📝
 * Check script does, with a single frame in place of the .srt, and ✅ Burn it
 * queues the same `restyle` re-run. Both on posts the script and the frame on
 * one card.
 *
 * It is not free: the frame needs the video back in a container, so an
 * approved video pays one extra container wake and one extra upload. A style
 * that turns out wrong otherwise costs a whole encode instead.
 */
export const PREVIEW = {
  off: { label: 'Off — burn straight away' },
  on: { label: 'On — show me a frame first' },
} as const;

export type PreviewId = keyof typeof PREVIEW;

export interface CaptionSettings {
  preset: CaptionPreset;
  size: CaptionSize;
  position: CaptionPosition;
  font: FontId;
  color: TextColorId;
  background: BackgroundId;
  /** Longest caption line before it is split into another cue. */
  chars: CharLimitId;
  sourceLang: SourceLangId;
  targetLang: TargetLangId;
  stt: SttProviderId;
  translator: TranslatorId;
  /** Stop and show the script before burning. */
  review: ReviewId;
  /** Stop and show these settings before the video is started at all. */
  confirm: ConfirmId;
  /** Stop and show one burned frame before the full encode. */
  preview: PreviewId;
}

export type SettingsField = keyof CaptionSettings;

interface MenuOption {
  value: string;
  label: string;
}

interface Menu {
  label: string;
  icon: string;
  options: MenuOption[];
  /**
   * Values in the order the keyboard shows them, for a field whose stored
   * option order is pinned by the settings code and reads badly as a menu.
   */
  layout?: string[];
  /**
   * The keyboard as explicit rows, for a field whose reading order is not the
   * one-per-row list everything else gets. 📍 Position is the one: it is a
   * picture of the frame, so its rows have to be the frame's bands top to
   * bottom, and the bands between the bottom edge and the centre hold one
   * button each.
   */
  rows?: string[][];
}

/** Drives both the menu buttons and the validation of incoming callbacks. */
export const MENUS: Record<SettingsField, Menu> = {
  preset: {
    label: 'Style',
    icon: '🎨',
    options: [
      { value: 'clean', label: 'Clean — white, outlined' },
      { value: 'hormozi', label: 'Hormozi — yellow on black' },
      { value: 'cinematic', label: 'Cinematic — heavy outline' },
      { value: 'youtube', label: 'YouTube — box' },
      { value: 'naskh', label: 'Naskh — classical' },
    ],
  },
  font: {
    label: 'Font',
    icon: '🅰️',
    options: Object.entries(FONTS).map(([value, f]) => ({ value, label: f.label })),
  },
  size: {
    label: 'Size',
    icon: '🔠',
    // Append only, like every other option list: `encodeSettings` puts the
    // index on the buttons, so the two new steps go on the end and the
    // keyboard reads them in size order via `layout`. The percentages are of
    // the medium default, which is the question the menu kept raising — small
    // and medium are 30% apart, not the same.
    options: [
      { value: 'small', label: 'Small — 70%' },
      { value: 'medium', label: 'Medium — 100%' },
      { value: 'large', label: 'Large — 150%' },
      { value: 'xsmall', label: 'Extra small — 55%' },
      { value: 'xlarge', label: 'Extra large — 200%' },
    ],
    layout: ['xsmall', 'small', 'medium', 'large', 'xlarge'],
  },
  color: {
    label: 'Text colour',
    icon: '🖍',
    options: Object.entries(TEXT_COLORS).map(([value, c]) => ({ value, label: c.label })),
  },
  background: {
    label: 'Background',
    icon: '🎞',
    options: Object.entries(BACKGROUNDS).map(([value, b]) => ({ value, label: b.label })),
  },
  position: {
    label: 'Position',
    icon: '📍',
    options: Object.entries(POSITIONS).map(([value, p]) => ({ value, label: p.label })),
    // A picture of the frame, read top to bottom. The nine-cell grid alone was
    // one, but the raised variants were tacked on as a fourth row below
    // 'Bottom left' — so 'Upper third' sat under the bottom of the frame and
    // the four steps between the bottom edge and the centre read in no order
    // at all. Each band is its own row now, in the order the eye travels, and
    // a band with one option is a full-width button rather than a cell in a
    // grid that means nothing. The options themselves stay in POSITIONS order,
    // because that index is what rides on the buttons.
    rows: [
      ['topLeft', 'top', 'topRight'],
      ['upperThird'],
      ['middleLeft', 'center', 'middleRight'],
      ['belowCentre'],
      ['lowerMiddle'],
      ['lowerThird'],
      ['aboveBottom'],
      ['bottomLeft', 'bottom', 'bottomRight'],
    ],
  },
  chars: {
    label: 'Line length',
    icon: '📏',
    options: Object.entries(CHAR_LIMITS).map(([value, c]) => ({ value, label: c.label })),
    // 'auto' is last in CHAR_LIMITS because that list is append-only, and
    // first on the keyboard because it is the one that needs no thought.
    layout: ['auto', '28', '36', '42', '52', '64'],
  },
  sourceLang: {
    label: 'Spoken language',
    icon: '🗣️',
    options: Object.entries(SOURCE_LANGUAGES).map(([value, l]) => ({ value, label: l.label })),
  },
  targetLang: {
    label: 'Translate to',
    icon: '🌐',
    options: Object.entries(TARGET_LANGUAGES).map(([value, l]) => ({ value, label: l.label })),
  },
  stt: {
    label: 'Transcriber',
    icon: '🎙',
    options: Object.entries(STT_PROVIDERS).map(([value, p]) => ({ value, label: p.label })),
  },
  translator: {
    label: 'Translator',
    icon: '🧠',
    options: Object.entries(TRANSLATORS).map(([value, t]) => ({ value, label: t.label })),
  },
  review: {
    label: 'Check script',
    icon: '📝',
    options: Object.entries(REVIEW).map(([value, r]) => ({ value, label: r.label })),
  },
  confirm: {
    label: 'Confirm settings',
    icon: '🧾',
    options: Object.entries(CONFIRM).map(([value, c]) => ({ value, label: c.label })),
  },
  preview: {
    label: 'Check preview',
    icon: '🖼',
    options: Object.entries(PREVIEW).map(([value, p]) => ({ value, label: p.label })),
  },
};

/**
 * Settings the per-video ✏️ card leaves out.
 *
 * Every other field can still change a video that already exists, which is
 * what that card re-runs. Reviewing the script cannot: the script has been
 * burned by the time the card is posted, and the card is itself the place the
 * review would have happened. Nor can 🧾 Confirm settings: the run it gates
 * has already happened by then. 🖼 Check preview is the same — the card it
 * would gate is this one, and it carries a 🖼 Preview button already.
 */
const CHAT_ONLY = new Set<SettingsField>(['review', 'confirm', 'preview']);

/**
 * The one setting the 🧾 confirm card leaves out.
 *
 * Everything else on it still shapes the run it is gating — including 📝 Check
 * script, which the ✏️ card cannot offer but this one is posted before. Turning
 * the card itself off *from* the card would only apply to the video already
 * showing it, which means nothing.
 */
const START_ONLY_EXCLUDED = new Set<SettingsField>(['confirm']);

export const ALL_FIELDS = Object.keys(MENUS) as SettingsField[];

/** The fields the ✏️ Edit card shows, in menu order. */
export const EDIT_FIELDS = ALL_FIELDS.filter((field) => !CHAT_ONLY.has(field));

/** The fields the 🧾 confirm card shows, in menu order. */
export const START_FIELDS = ALL_FIELDS.filter((field) => !START_ONLY_EXCLUDED.has(field));

/**
 * Field order for the compact code below. Append only — never reorder or
 * remove, or a code minted by the previous deploy decodes to the wrong
 * settings on a button someone taps after a release.
 */
const CODE_FIELDS: SettingsField[] = [
  'preset',
  'font',
  'size',
  'color',
  'background',
  'position',
  'chars',
  'sourceLang',
  'targetLang',
  'stt',
  'translator',
  'review',
  'confirm',
  'preview',
];

/**
 * Squeeze a whole settings object into one base-36 digit per field.
 *
 * This is what lets the per-video edit menu carry its draft inside
 * `callback_data` instead of reading and rewriting KV on every tap. KV is
 * eventually consistent, so a read-modify-write per button press can serve a
 * stale draft and silently drop changes the user already made; a code on the
 * button cannot go stale because the button *is* the state.
 */
export function encodeSettings(settings: CaptionSettings): string {
  return CODE_FIELDS.map((field) => {
    const index = MENUS[field].options.findIndex((o) => o.value === settings[field]);
    return Math.max(0, index).toString(36);
  }).join('');
}

/** Read a code back, falling back to `base` for anything unreadable. */
export function decodeSettings(code: string, base: CaptionSettings): CaptionSettings {
  const settings = { ...base };

  CODE_FIELDS.forEach((field, i) => {
    const option = MENUS[field].options[parseInt(code[i] ?? '', 36)];
    if (option) (settings as Record<string, string>)[field] = option.value;
  });

  return settings;
}

export function defaults(env: Env): CaptionSettings {
  // Match the deployed font var back to a known font id where possible.
  const font =
    (Object.keys(FONTS) as FontId[]).find((id) => FONTS[id].family === env.SUBTITLE_FONT) ?? 'aljazeera';

  // Only snaps to a menu option when the deployed number is one of them; an
  // off-menu value would render as a button no tap could ever reproduce.
  // 'auto' is one of them, so a deployment can make the fitted limit the
  // default for every new chat by setting MAX_CAPTION_CHARS to it.
  const chars = (env.MAX_CAPTION_CHARS in CHAR_LIMITS ? env.MAX_CAPTION_CHARS : '42') as CharLimitId;
  const sourceLang = (env.SOURCE_LANG in SOURCE_LANGUAGES ? env.SOURCE_LANG : 'auto') as SourceLangId;
  const targetLang = (env.TARGET_LANG in TARGET_LANGUAGES ? env.TARGET_LANG : 'ar') as TargetLangId;
  const stt = (env.STT_PROVIDER in STT_PROVIDERS ? env.STT_PROVIDER : 'groq') as SttProviderId;

  // The deployed var names the model itself; match it back to a menu option.
  const translator =
    (Object.keys(TRANSLATORS) as TranslatorId[]).find(
      (id) => TRANSLATORS[id].model === env.TRANSLATION_MODEL,
    ) ?? 'llama70b';

  return {
    preset: env.CAPTION_PRESET || 'clean',
    size: env.CAPTION_SIZE || 'medium',
    position: env.CAPTION_POSITION || 'bottom',
    font,
    color: 'white',
    background: 'preset',
    chars,
    sourceLang,
    targetLang,
    stt,
    translator,
    // Off by default: a video that comes back without needing a tap is the
    // point of the bot, and the ✏️ card can still fix anything afterwards.
    review: 'off',
    // On by default: the card costs one tap and is the only chance to change
    // what a video is captioned with *before* the transcription is paid for.
    confirm: 'on',
    // Off by default: the frame costs a container wake and an upload on every
    // approved video, and the same look is one tap away on the ✏️ card for
    // anyone who only wants to check now and then.
    preview: 'off',
  };
}

const key = (chatId: number) => `settings:${chatId}`;

export async function loadSettings(env: Env, chatId: number): Promise<CaptionSettings> {
  const base = defaults(env);
  if (!env.CAPTION_SETTINGS) return base;

  try {
    const stored = await env.CAPTION_SETTINGS.get<Partial<CaptionSettings>>(key(chatId), 'json');
    // Merge rather than replace, so a newly added field picks up its default.
    return stored ? { ...base, ...stored } : base;
  } catch (err) {
    console.error('[settings] load failed, using defaults:', err);
    return base;
  }
}

export async function saveSettings(env: Env, chatId: number, settings: CaptionSettings): Promise<void> {
  if (!env.CAPTION_SETTINGS) throw new Error('CAPTION_SETTINGS KV namespace is not bound');
  await env.CAPTION_SETTINGS.put(key(chatId), JSON.stringify(settings));
}

/** Reject anything that is not one of the offered options. */
export function isValid(field: SettingsField, value: string): boolean {
  return MENUS[field].options.some((o) => o.value === value);
}

export function labelFor(field: SettingsField, value: string): string {
  return MENUS[field].options.find((o) => o.value === value)?.label ?? value;
}
