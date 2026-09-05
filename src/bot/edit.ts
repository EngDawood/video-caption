import {
  MENUS,
  decodeSettings,
  defaults,
  encodeSettings,
  type CaptionSettings,
  type SettingsField,
} from '../captions/settings';
import { purgeAssets } from '../media/assets';
import { fieldKeyboard, readChoice, rootKeyboard, shortLabel, summary, type MenuScope } from './menu';
import { telegram, type InlineKeyboard } from './telegram';
import type { CaptionJob, Env } from '../types';

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
 * callback_data grammar (Telegram caps it at 64 bytes; the longest below is
 * about 40, and a job id is a 36-char UUID, so a short token stands in for it):
 *   e:<token>:<code>              open the draft menu
 *   em:<token>:<code>:<field>     open one field's options ('root' for the top)
 *   es:<token>:<code>:<field>     <code> already carries the new value
 *   eg:<token>:<code>             burn it again with this draft
 *   ex:<token>                    close, and drop the stored video
 */

/** How long a delivered video stays restylable — and stays in R2. */
const EDIT_TTL_SECONDS = 24 * 60 * 60;

const editKey = (token: string) => `edit:${token}`;

/** Written once when the card is posted, so there is no rewrite to race. */
interface EditSession {
  /** Whose R2 prefix holds the input video, the transcript and the cues. */
  assetJobId: string;
  /** The user's original message, so a re-run replies to it like the first run did. */
  messageId: number;
  /**
   * What the run that produced this video used. The draft is compared against
   * it to work out how much of the pipeline has to happen again.
   */
  settings?: CaptionSettings;
}

export function isEditCallback(data: string): boolean {
  return /^e[msgx]?:/.test(data);
}

/**
 * The shallowest re-run that can deliver `draft`.
 *
 * Reading the speech again is the expensive one, so it is reserved for the two
 * settings that actually change what the transcriber does. Everything else is
 * either a translation input or pure styling.
 */
function pickMode(was: CaptionSettings | undefined, draft: CaptionSettings): CaptionJob['mode'] {
  // No record of the original settings (a card posted by an older deploy):
  // re-burn, which is what that card promised anyway.
  if (!was) return 'restyle';
  if (was.stt !== draft.stt || was.sourceLang !== draft.sourceLang) return 'retranscribe';
  if (was.translator !== draft.translator || was.targetLang !== draft.targetLang) return 'retranslate';
  return 'restyle';
}

const WORKING: Record<string, string> = {
  restyle: '⏳ Queued — re-burning…',
  retranslate: '⏳ Queued — translating again…',
  retranscribe: '⏳ Queued — reading the speech again…',
};

const scopeFor = (token: string, settings: CaptionSettings): MenuScope => ({
  open: (field) => `em:${token}:${encodeSettings(settings)}:${field}`,
  // The code carries the value; the field name rides along only so the tap can
  // be acknowledged with the name of what just changed.
  pick: (field, value) =>
    `es:${token}:${encodeSettings({ ...settings, [field]: value } as CaptionSettings)}:${field}`,
  footer: [
    [
      { text: '♻️ Apply', callback_data: `eg:${token}:${encodeSettings(settings)}` },
      { text: '✖️ Close', callback_data: `ex:${token}` },
    ],
  ],
});

const CARD_TITLE = '🎬 Captioned with:';
const MENU_TITLE =
  '✏️ Editing this video only\n\nChange what you like, then tap ♻️ Apply.\nYour chat defaults are untouched.';

/**
 * Offer to change the video that was just delivered.
 *
 * The settings this run used go into the session, because that is what a later
 * tap is compared against to decide how much has to happen again.
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

  try {
    await env.CAPTION_SETTINGS.put(
      editKey(token),
      JSON.stringify({ assetJobId, messageId, settings } satisfies EditSession),
      { expirationTtl: EDIT_TTL_SECONDS },
    );

    const keyboard: InlineKeyboard = [
      [
        { text: '✏️ Edit', callback_data: `e:${token}:${encodeSettings(settings)}` },
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
      if (!MENUS[field]) return void (await tg.answerCallbackQuery(callbackId));
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

    default:
      await tg.answerCallbackQuery(callbackId);
  }
}

/**
 * Queue the re-run, at whatever depth the draft calls for.
 *
 * The workflow id is derived from the token and the draft rather than being
 * random, so a double tap lands on an id that already exists and Workflows
 * refuses it. Every mode here ends in a whole video encode — the one thing
 * that must not happen twice because a button was pressed twice.
 */
async function startRestyle(
  env: Env,
  chatId: number,
  messageId: number,
  callbackId: string,
  token: string,
  code: string,
  session: EditSession,
  settings: CaptionSettings,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const jobId = `restyle-${token}-${code}`;
  const mode = pickMode(session.settings, settings);

  await tg.answerCallbackQuery(callbackId, 'Working…');
  // Buttons come off before the job is queued, so a second tap has nothing
  // left to hit. The card is the status line from here on, and the finished
  // run posts a fresh card of its own.
  await tg.editMessageText(chatId, messageId, WORKING[mode ?? 'restyle']);

  try {
    await env.CAPTION_WORKFLOW.create({
      id: jobId,
      params: {
        jobId,
        chatId,
        messageId: session.messageId,
        mode,
        assetJobId: session.assetJobId,
        settings,
        statusMessageId: messageId,
      },
    });
  } catch (err) {
    // Ask whether it is already there rather than matching on the error text,
    // which is not part of any contract. If it is, the status line above is
    // already telling the truth and there is nothing to undo.
    const existing = await env.CAPTION_WORKFLOW.get(jobId).catch(() => null);
    if (existing) return;

    console.error('[edit] could not queue a re-run:', err);
    await tg.editMessageText(
      chatId,
      messageId,
      `⚠️ Could not start that re-run.\n\n${MENU_TITLE}`,
      rootKeyboard(settings, scopeFor(token, settings)),
    );
  }
}
