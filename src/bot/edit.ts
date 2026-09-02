import { MENUS, type CaptionSettings, type SettingsField } from '../captions/settings';
import { purgeAssets } from '../media/assets';
import { fieldKeyboard, readChoice, rootKeyboard, shortLabel, summary, type MenuScope } from './menu';
import { telegram, type InlineKeyboard } from './telegram';
import type { Env } from '../types';

/**
 * Restyling one delivered video.
 *
 * After a job sends its video, it posts a card offering to change how the
 * captions look. Editing here writes to a per-video draft, never to the chat
 * defaults — the whole point is to fix one video without changing what the
 * next one will look like.
 *
 * Applying re-burns from the input video and the translated cues the original
 * run left in R2, so it pays for one encode: no download, no transcription,
 * no translation.
 *
 * callback_data grammar (Telegram caps it at 64 bytes, and a job id is a
 * 36-char UUID, so a short token stands in for it and the real id lives in KV):
 *   e:<token>                open the draft menu
 *   em:<token>:<field>       open one field's options ('root' for the top level)
 *   es:<token>:<field>:<v>   set a value on the draft
 *   eg:<token>               burn it again with the draft
 *   ex:<token>               close, and drop the stored video
 */

/** How long a delivered video stays restylable — and stays in R2. */
const EDIT_TTL_SECONDS = 24 * 60 * 60;

const editKey = (token: string) => `edit:${token}`;

interface EditSession {
  /** Whose R2 prefix holds the input video and the cues. */
  assetJobId: string;
  /** The user's original message, so a re-burn replies to it like the first run did. */
  messageId: number;
  /** The draft being edited: the settings the last burn used, plus any changes. */
  settings: CaptionSettings;
}

export function isEditCallback(data: string): boolean {
  return /^e[msgx]?:/.test(data);
}

const scopeFor = (token: string): MenuScope => ({
  open: (field) => `em:${token}:${field}`,
  pick: (field, value) => `es:${token}:${field}:${value}`,
  footer: [
    [
      { text: '♻️ Apply & re-burn', callback_data: `eg:${token}` },
      { text: '✖️ Close', callback_data: `ex:${token}` },
    ],
  ],
});

const CARD_TITLE = '🎬 Captioned with:';
const MENU_TITLE = '✏️ Editing this video only\n\nChange what you like, then tap ♻️ Apply & re-burn.\nYour chat defaults are untouched.';

/**
 * Offer to restyle the video that was just delivered.
 *
 * Best-effort: a job that has already sent its video must not be marked failed
 * because the follow-up card did not post.
 */
export async function sendEditCard(
  env: Env,
  chatId: number,
  messageId: number,
  assetJobId: string,
  settings: CaptionSettings,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);

  if (!env.CAPTION_SETTINGS) return;

  const token = crypto.randomUUID().slice(0, 8);
  const session: EditSession = { assetJobId, messageId, settings };

  try {
    await env.CAPTION_SETTINGS.put(editKey(token), JSON.stringify(session), {
      expirationTtl: EDIT_TTL_SECONDS,
    });

    const keyboard: InlineKeyboard = [
      [
        { text: '✏️ Edit', callback_data: `e:${token}` },
        { text: '✖️ Cancel', callback_data: `ex:${token}` },
      ],
    ];
    await tg.sendMessage(chatId, `${CARD_TITLE}\n${summary(settings)}`, messageId, keyboard);
  } catch (err) {
    console.error('[edit] could not offer a restyle:', err);
  }
}

/** Handle a tap anywhere in the per-video edit flow. */
export async function handleEditCallback(
  env: Env,
  chatId: number,
  messageId: number,
  callbackId: string,
  data: string,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const [verb, token, ...rest] = data.split(':');

  const session = env.CAPTION_SETTINGS
    ? await env.CAPTION_SETTINGS.get<EditSession>(editKey(token), 'json')
    : null;

  if (!session) {
    await tg.answerCallbackQuery(callbackId, 'That video has expired — send it again to caption it fresh.');
    await tg.editMessageText(chatId, messageId, '⌛ Expired.');
    return;
  }

  const scope = scopeFor(token);

  switch (verb) {
    // Close: the stored video is what makes a restyle cheap, and it is no
    // longer wanted, so it goes now rather than waiting out the TTL.
    case 'ex': {
      await env.CAPTION_SETTINGS?.delete(editKey(token)).catch(() => {});
      await purgeAssets(env, session.assetJobId);
      await tg.answerCallbackQuery(callbackId, 'Closed');
      await tg.editMessageText(chatId, messageId, `${CARD_TITLE}\n${summary(session.settings)}`);
      return;
    }

    case 'e': {
      await tg.answerCallbackQuery(callbackId);
      await tg.editMessageText(chatId, messageId, MENU_TITLE, rootKeyboard(session.settings, scope));
      return;
    }

    case 'em': {
      const [rawField] = rest;
      if (rawField === 'root') {
        await tg.answerCallbackQuery(callbackId);
        await tg.editMessageText(chatId, messageId, MENU_TITLE, rootKeyboard(session.settings, scope));
        return;
      }

      const field = rawField as SettingsField;
      if (!MENUS[field]) return void (await tg.answerCallbackQuery(callbackId));
      await tg.answerCallbackQuery(callbackId);
      await tg.editMessageText(
        chatId,
        messageId,
        `${MENUS[field].icon} ${MENUS[field].label}`,
        fieldKeyboard(field, session.settings, scope),
      );
      return;
    }

    case 'es': {
      const [rawField, value] = rest;
      const field = readChoice(rawField, value);
      if (!field) return void (await tg.answerCallbackQuery(callbackId, 'Unknown option'));

      const updated = { ...session.settings, [field]: value } as CaptionSettings;
      // Re-put rather than merge: the TTL restarts, so a video someone is
      // actively editing does not expire out from under them mid-session.
      await env.CAPTION_SETTINGS.put(
        editKey(token),
        JSON.stringify({ ...session, settings: updated } satisfies EditSession),
        { expirationTtl: EDIT_TTL_SECONDS },
      );
      await tg.answerCallbackQuery(callbackId, `${MENUS[field].label}: ${shortLabel(field, value)}`);
      await tg.editMessageText(chatId, messageId, MENU_TITLE, rootKeyboard(updated, scope));
      return;
    }

    case 'eg': {
      await tg.answerCallbackQuery(callbackId, 'Re-burning…');
      // The card becomes the status line and loses its buttons, so a second
      // tap cannot queue the same burn twice. The token stays alive: the new
      // run posts a fresh card of its own when it finishes.
      const status = await tg.editMessageText(chatId, messageId, '⏳ Queued…');

      const jobId = crypto.randomUUID();
      await env.CAPTION_WORKFLOW.create({
        id: jobId,
        params: {
          jobId,
          chatId,
          messageId: session.messageId,
          mode: 'restyle',
          assetJobId: session.assetJobId,
          settings: session.settings,
          statusMessageId: status?.message_id ?? messageId,
        },
      });
      return;
    }

    default:
      await tg.answerCallbackQuery(callbackId);
  }
}
