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
 * The /settings inline-keyboard menu.
 *
 * callback_data grammar (Telegram caps it at 64 bytes):
 *   m:root          open the top level
 *   m:<field>       open one field's options
 *   s:<field>:<v>   choose a value
 *   x               close
 */

const FIELDS = Object.keys(MENUS) as SettingsField[];

export const MENU_TITLE = '⚙️ Caption settings\n\nTap a setting to change it. New videos use these.';

/** Top level: one row per setting, showing what it is currently set to. */
export function rootKeyboard(settings: CaptionSettings): InlineKeyboard {
  const rows: InlineKeyboard = FIELDS.map((field) => [
    {
      text: `${MENUS[field].icon} ${MENUS[field].label}: ${shortLabel(field, settings[field])}`,
      callback_data: `m:${field}`,
    },
  ]);
  rows.push([{ text: '✅ Done', callback_data: 'x' }]);
  return rows;
}

/** One field's options, with a tick against the active one. */
export function fieldKeyboard(field: SettingsField, settings: CaptionSettings): InlineKeyboard {
  const rows: InlineKeyboard = MENUS[field].options.map((option) => [
    {
      text: `${settings[field] === option.value ? '✅' : '▫️'} ${option.label}`,
      callback_data: `s:${field}:${option.value}`,
    },
  ]);
  rows.push([{ text: '⬅️ Back', callback_data: 'm:root' }]);
  return rows;
}

/** Option labels carry a description after an em dash; the button row wants only the name. */
function shortLabel(field: SettingsField, value: string): string {
  return labelFor(field, value).split(' — ')[0];
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
    const [, field, value] = data.split(':') as [string, SettingsField, string];
    if (!MENUS[field] || !isValid(field, value)) {
      return void (await tg.answerCallbackQuery(callbackId, 'Unknown option'));
    }

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
