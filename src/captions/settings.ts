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

export interface CaptionSettings {
  preset: CaptionPreset;
  size: CaptionSize;
  position: CaptionPosition;
  font: FontId;
  color: TextColorId;
  background: BackgroundId;
  /** Longest caption line before it is split into another cue. */
  chars: CharLimitId;
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
};

export function defaults(env: Env): CaptionSettings {
  // Match the deployed font var back to a known font id where possible.
  const font =
    (Object.keys(FONTS) as FontId[]).find((id) => FONTS[id].family === env.SUBTITLE_FONT) ?? 'aljazeera';

  // Only snaps to a menu option when the deployed number is one of them; an
  // off-menu value would render as a button no tap could ever reproduce.
  const chars = (env.MAX_CAPTION_CHARS in CHAR_LIMITS ? env.MAX_CAPTION_CHARS : '42') as CharLimitId;

  return {
    preset: env.CAPTION_PRESET || 'clean',
    size: env.CAPTION_SIZE || 'medium',
    position: env.CAPTION_POSITION || 'bottom',
    font,
    color: 'white',
    background: 'preset',
    chars,
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
