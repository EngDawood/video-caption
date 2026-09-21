import {
  EDIT_FIELDS,
  MENUS,
  decodeSettings,
  defaults,
  type SettingsField,
} from '../captions/settings';
import { loadCues, purgeAssets } from '../media/assets';
import { fieldKeyboard, readChoice, rootKeyboard, shortLabel } from './menu';
import { telegram } from './telegram';
import type { Env } from '../types';
import { MENU_TITLE, scopeFor } from './edit/cards';
import { sendPreview } from './edit/preview';
import { revisionOf, startRestyle } from './edit/rerun';
import { sendScript, startFix } from './edit/script';
import { editKey, fixKey, type EditSession, type FixSession } from './edit/session';

export { sendEditCard, sendReviewCard, type ReviewCard } from './edit/cards';
export { queueRestyle } from './edit/rerun';
export { handleTextCorrection } from './edit/script';

/**
 * Re-running one delivered video.
 *
 * After a job sends its video, it posts a card offering to change anything
 * about it. Editing here never touches the chat defaults — the whole point is
 * to fix one video without changing what the next one looks like.
 *
 * Applying re-runs from the shallowest stage that can serve the change, using
 * what the first run left in R2 (see `pickMode`): a new font is one encode, a
 * new translator re-translates the stored transcript, and a new transcriber or
 * spoken language reads the stored video's speech again. Nothing is ever
 * downloaded twice.
 *
 * The draft rides on the buttons as a compact code (see `encodeSettings`), not
 * in KV. KV is eventually consistent, and a read-modify-write per tap can
 * serve a stale draft and quietly undo changes the user already made. What KV
 * does hold — written once, never rewritten — is which job's files to re-burn.
 *
 * Wording is the one thing a menu cannot fix, so ✍️ Fix text takes corrections
 * as ordinary chat replies (`12 the corrected line`) and writes them straight
 * into the stored cues. No new pipeline depth is needed for that: a `restyle`
 * already burns whatever `segments.json` holds, so correcting the text and
 * re-burning are the same operation the ♻️ Apply button has always performed.
 *
 * callback_data grammar (Telegram caps it at 64 bytes; the longest below is
 * about 40, and a job id is a 36-char UUID, so a short token stands in for it):
 *   e:<token>:<code>              open the draft menu
 *   em:<token>:<code>:<field>     open one field's options ('root' for the top)
 *   es:<token>:<code>:<field>     <code> already carries the new value
 *   eg:<token>:<code>             burn it again with this draft
 *   ed:<token>:<code>             send the whole script as an .srt file
 *   ep:<token>:<code>             send one burned frame near the first caption
 *   et:<token>:<code>             list the cues and start taking corrections
 *   ef:<token>:<code>             burn the corrections
 *   er:<token>:<code>             translate a corrected transcript, then burn
 *   ex:<token>                    close, and drop the stored video
 */

export function isEditCallback(data: string): boolean {
  return /^e[msgxtfrdp]?:/.test(data);
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
  const [verb, token, code, rawField] = data.split(':');

  const session = env.CAPTION_SETTINGS
    ? await env.CAPTION_SETTINGS.get<EditSession>(editKey(token), 'json')
    : null;

  if (!session) {
    await tg.answerCallbackQuery(callbackId, 'That video has expired — send it again to caption it fresh.');
    await tg.editMessageText(chatId, messageId, '⌛ Expired.');
    return;
  }

  // Close needs no draft, and its button carries none.
  if (verb === 'ex') {
    // The stored video is what makes a restyle cheap, and it is no longer
    // wanted, so it goes now rather than waiting out the TTL.
    await env.CAPTION_SETTINGS?.delete(editKey(token)).catch(() => {});
    // Only if it still points here: another video's ✍️ list may have opened
    // since, and closing this card must not silence that one.
    const fix = await env.CAPTION_SETTINGS?.get<FixSession>(fixKey(chatId), 'json').catch(() => null);
    if (fix?.token === token) await env.CAPTION_SETTINGS?.delete(fixKey(chatId)).catch(() => {});
    await purgeAssets(env, session.assetJobId);
    await tg.answerCallbackQuery(callbackId, 'Closed');
    await tg.editMessageText(chatId, messageId, '✅ Closed. That video is no longer stored.');
    return;
  }

  // The code carries all seven fields, so the deployed defaults are only a
  // structural floor for a truncated or corrupted one — no KV read per tap.
  const settings = decodeSettings(code ?? '', defaults(env));
  const scope = scopeFor(token, settings);

  switch (verb) {
    case 'e': {
      await tg.answerCallbackQuery(callbackId);
      await tg.editMessageText(chatId, messageId, MENU_TITLE, rootKeyboard(settings, scope));
      return;
    }

    case 'em': {
      if (rawField === 'root') {
        await tg.answerCallbackQuery(callbackId);
        await tg.editMessageText(chatId, messageId, MENU_TITLE, rootKeyboard(settings, scope));
        return;
      }

      const field = rawField as SettingsField;
      if (!EDIT_FIELDS.includes(field)) return void (await tg.answerCallbackQuery(callbackId));
      await tg.answerCallbackQuery(callbackId);
      await tg.editMessageText(
        chatId,
        messageId,
        `${MENUS[field].icon} ${MENUS[field].label}`,
        fieldKeyboard(field, settings, scope),
      );
      return;
    }

    case 'es': {
      // The code already holds the new value, so there is nothing to save —
      // just acknowledge which field moved and redraw the top level.
      const field = readChoice(rawField ?? '', settings[rawField as SettingsField] ?? '');
      if (!field) return void (await tg.answerCallbackQuery(callbackId, 'Unknown option'));

      await tg.answerCallbackQuery(callbackId, `${MENUS[field].label}: ${shortLabel(field, settings[field])}`);
      await tg.editMessageText(chatId, messageId, MENU_TITLE, rootKeyboard(settings, scope));
      return;
    }

    case 'eg':
      return startRestyle(env, chatId, messageId, callbackId, token, code, session, settings);

    case 'ed': {
      // Answered once, after the send, so the toast can report a failure —
      // Telegram accepts only the first answer to a query.
      const sent = await sendScript(env, chatId, session.assetJobId).catch((err) => {
        console.error('[edit] could not send the script:', err);
        return false;
      });
      await tg.answerCallbackQuery(callbackId, sent ? undefined : 'The text for that video is no longer stored.');
      return;
    }

    case 'ep':
      return sendPreview(env, chatId, callbackId, session, settings);

    case 'et':
      return startFix(env, chatId, callbackId, token, code, session);

    case 'ef':
    case 'er': {
      // Derived from the text as it stands now rather than from the button, so
      // the ♻️ under an earlier correction still burns the latest wording — and
      // two taps on the same wording still collide into one run.
      const stored = await loadCues(env, session.assetJobId);
      if (!stored) {
        await tg.answerCallbackQuery(callbackId, 'That video is no longer stored.');
        return;
      }

      // A corrected transcript is only worth anything once it has been through
      // the translator again, so that tap forces the depth rather than letting
      // `pickMode` read unchanged settings and choose a plain re-burn.
      const source = stored.source ?? [];
      if (verb === 'er' && source.length === 0) {
        await tg.answerCallbackQuery(callbackId, 'No stored transcript for this video.');
        return;
      }

      return startRestyle(env, chatId, messageId, callbackId, token, code, session, settings, {
        mode: verb === 'er' ? 'retranslate' : undefined,
        revision: revisionOf(verb === 'er' ? source : stored.segments),
      });
    }

    default:
      await tg.answerCallbackQuery(callbackId);
  }
}
