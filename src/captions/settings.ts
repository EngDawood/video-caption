import {
  BACKGROUNDS,
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

/** Fonts bundled in the container image, by internal family name. */
export const FONTS = {
  aljazeera: { label: 'Al Jazeera', family: 'Al Jazeera', hasBold: true },
  thmanyah: { label: 'Thmanyah Serif', family: 'thmanyah serif display', hasBold: false },
} as const;

export type FontId = keyof typeof FONTS;

/**
 * Offered line lengths, in characters. Stored as strings because every menu
 * value is a string on the way through a callback_data payload.
 */
export const CHAR_LIMITS = {
  '28': { label: '28 — punchy, one short line' },
  '36': { label: '36 — tight' },
  '42': { label: '42 — broadcast norm' },
  '52': { label: '52 — relaxed' },
  '64': { label: '64 — long lines' },
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
    options: [
      { value: 'small', label: 'Small' },
      { value: 'medium', label: 'Medium' },
      { value: 'large', label: 'Large' },
    ],
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
    options: [
      { value: 'bottom', label: 'Bottom' },
      { value: 'center', label: 'Centre' },
      { value: 'top', label: 'Top' },
    ],
  },
  chars: {
    label: 'Line length',
    icon: '📏',
    options: Object.entries(CHAR_LIMITS).map(([value, c]) => ({ value, label: c.label })),
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
};

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
