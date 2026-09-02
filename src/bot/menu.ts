import {
  MENUS,
  isValid,
  labelFor,
  loadSettings,
  saveSettings,
  type CaptionSettings,
  type SettingsField,
} from '../captions/settings';
import { telegram, type InlineKeyboard } from './telegram';
import type { Env } from '../types';

/**
 * The inline-keyboard settings menu.
 *
 * The same keyboards drive two flows, so the callback_data prefixes are handed
 * in as a `MenuScope` rather than hard-coded: /settings edits the chat defaults
 * (this file), while the ✏️ Edit card edits one video's draft (bot/edit.ts).
 *
 * callback_data grammar for the chat-defaults scope (Telegram caps it at 64
 * bytes):
 *   m:root          open the top level
 *   m:<field>       open one field's options
 *   s:<field>:<v>   choose a value
 *   x               close
 */

const FIELDS = Object.keys(MENUS) as SettingsField[];

export const MENU_TITLE = '⚙️ Caption settings\n\nTap a setting to change it. New videos use these.';

/** Where a keyboard's buttons point, and what sits under the settings rows. */
export interface MenuScope {
  /** callback_data that opens a field's options, or the top level. */
  open: (field: SettingsField | 'root') => string;
  /** callback_data that selects a value. */
  pick: (field: SettingsField, value: string) => string;
  /** Rows appended below the settings rows on the top level. */
  footer: InlineKeyboard;
}

const chatScope: MenuScope = {
  open: (field) => `m:${field}`,
  pick: (field, value) => `s:${field}:${value}`,
  footer: [[{ text: '✅ Done', callback_data: 'x' }]],
};

/** Top level: one row per setting, showing what it is currently set to. */
export function rootKeyboard(settings: CaptionSettings, scope: MenuScope = chatScope): InlineKeyboard {
  const rows: InlineKeyboard = FIELDS.map((field) => [
    {
      text: `${MENUS[field].icon} ${MENUS[field].label}: ${shortLabel(field, settings[field])}`,
      callback_data: scope.open(field),
    },
  ]);
  return [...rows, ...scope.footer];
}

/** One field's options, with a tick against the active one. */
export function fieldKeyboard(
  field: SettingsField,
  settings: CaptionSettings,
  scope: MenuScope = chatScope,
): InlineKeyboard {
  const rows: InlineKeyboard = MENUS[field].options.map((option) => [
    {
      text: `${settings[field] === option.value ? '✅' : '▫️'} ${option.label}`,
      callback_data: scope.pick(field, option.value),
    },
  ]);
  rows.push([{ text: '⬅️ Back', callback_data: scope.open('root') }]);
  return rows;
}

/** Option labels carry a description after an em dash; the button row wants only the name. */
export function shortLabel(field: SettingsField, value: string): string {
  return labelFor(field, value).split(' — ')[0];
}

/** Validate a `<field>:<value>` pair coming off a button, in either scope. */
export function readChoice(field: string, value: string): SettingsField | null {
  const known = field as SettingsField;
  if (!MENUS[known] || !isValid(known, value)) return null;
  return known;
}

/**
 * Handle one callback_query from the settings menu. Returns nothing — it
 * answers the callback and edits the menu message in place.
 */
export async function handleMenuCallback(
  env: Env,
  chatId: number,
  messageId: number,
  callbackId: string,
  data: string,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const settings = await loadSettings(env, chatId);

  if (data === 'x') {
    await tg.answerCallbackQuery(callbackId, 'Saved');
    await tg.editMessageText(chatId, messageId, `${MENU_TITLE}\n\n${summary(settings)}`);
    return;
  }

  if (data === 'm:root') {
    await tg.answerCallbackQuery(callbackId);
    await tg.editMessageText(chatId, messageId, MENU_TITLE, rootKeyboard(settings));
    return;
  }

  if (data.startsWith('m:')) {
    const field = data.slice(2) as SettingsField;
    if (!MENUS[field]) return void (await tg.answerCallbackQuery(callbackId));
    await tg.answerCallbackQuery(callbackId);
    await tg.editMessageText(
      chatId,
      messageId,
      `${MENUS[field].icon} ${MENUS[field].label}`,
      fieldKeyboard(field, settings),
    );
    return;
  }

  if (data.startsWith('s:')) {
    const [, rawField, value] = data.split(':');
    const field = readChoice(rawField, value);
    if (!field) return void (await tg.answerCallbackQuery(callbackId, 'Unknown option'));

    const updated = { ...settings, [field]: value } as CaptionSettings;
    await saveSettings(env, chatId, updated);
    await tg.answerCallbackQuery(callbackId, `${MENUS[field].label}: ${shortLabel(field, value)}`);
    // Straight back to the top level so several settings can be changed quickly.
    await tg.editMessageText(chatId, messageId, MENU_TITLE, rootKeyboard(updated));
    return;
  }

  await tg.answerCallbackQuery(callbackId);
}

export function summary(settings: CaptionSettings): string {
  return FIELDS.map((f) => `${MENUS[f].icon} ${MENUS[f].label}: ${shortLabel(f, settings[f])}`).join('\n');
}
