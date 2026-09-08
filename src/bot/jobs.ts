import { NonRetryableError } from 'cloudflare:workflows';
import { resolveVideo } from '../media/download';
import { purgeAssets } from '../media/assets';
import { ffmpegFor } from '../media/ffmpeg';
import {
  MENUS,
  START_FIELDS,
  decodeSettings,
  defaults,
  encodeSettings,
  type CaptionSettings,
  type SettingsField,
} from '../captions/settings';
import { fieldKeyboard, readChoice, rootKeyboard, shortLabel, type MenuScope } from './menu';
import { telegram, type InlineKeyboard } from './telegram';
import type { Env } from '../types';

/**
 * Everything between a message arriving and a CaptionWorkflow running.
 *
 * An uploaded video starts a job straight away. A link is gated behind a
 * confirm card first, because captioning costs container time and STT and a
 * pasted link is easy to send by accident.
 *
 * With 🧾 Confirm settings on — the default — both routes stop on a settings
 * card first. It is the /settings keyboard seeded from the chat defaults, but
 * the draft rides on the buttons as a code and is handed to the job rather than
 * written back to KV, so a change made there applies to that one video.
 *
 * callback_data grammar (Telegram caps it at 64 bytes, and a post URL rarely
 * fits, so only a short id rides on the button — the URL lives in KV):
 *   d:<id>                    caption it            (confirm off)
 *   dx:<id>                   do not                (confirm off)
 *   gm:<token>:<code>:<field> open a setting, or 'root' for the top level
 *   gs:<token>:<code>:<field> choose a value — <code> already carries it
 *   gg:<token>:<code>         caption it with this draft
 *   gx:<token>                do not
 *   k:<token>                 stop a job that is already running
 */

/** How long a confirm card stays tappable. */
const OFFER_TTL_SECONDS = 3600;

/** A job cannot outlive this, so neither need its cancel button. */
const CANCEL_TTL_SECONDS = 3600;

const pendingKey = (id: string) => `pending:${id}`;
const startKey = (token: string) => `start:${token}`;
export const cancelKey = (token: string) => `cancel:${token}`;

interface Pending {
  url: string;
  /** The message that carried the link, so the result replies to it. */
  messageId: number;
}

/**
 * What a 🧾 confirm card needs when its ✅ is finally tapped.
 *
 * Written once and never rewritten, for the same reason the ✏️ card's session
 * is: KV is eventually consistent, so a read-modify-write per tap could serve a
 * stale draft. The draft is on the buttons; only the source is in here.
 */
interface StartSession {
  /** Telegram file id, when the user sent the video itself. */
  fileId?: string;
  /** Social post URL, when the user sent a link instead. */
  sourceUrl?: string;
  /** The user's original message, so the result replies to it. */
  messageId: number;
  /** The one-line description of a resolved link, kept so redraws keep it. */
  preview?: string;
}

export function isOfferCallback(data: string): boolean {
  return data.startsWith('d:') || data.startsWith('dx:');
}

export function isStartCallback(data: string): boolean {
  return /^g[msgx]:/.test(data);
}

export function isCancelCallback(data: string): boolean {
  return data.startsWith('k:');
}

/** The ✖️ Stop button carried on a running job's status line. */
export const cancelKeyboard = (token: string): InlineKeyboard => [
  [{ text: '✖️ Stop', callback_data: `k:${token}` }],
];

/**
 * Post the status message and kick off a caption job for it.
 *
 * `settings` is the per-video draft a 🧾 confirm card produced. Passing it
 * freezes the run against exactly what the user approved; leaving it out lets
 * the workflow read the chat defaults for itself, which is what a job started
 * with the card turned off wants.
 */
export async function startJob(
  env: Env,
  chatId: number,
  messageId: number,
  source: { fileId: string; sourceUrl?: never } | { sourceUrl: string; fileId?: never },
  settings?: CaptionSettings,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const jobId = crypto.randomUUID();

  // The token is minted before the status message so the ✖️ Stop button can go
  // on from the very first line — a job is at its most cancellable while it is
  // still queued, which is exactly when a mistaken send gets noticed.
  const token = crypto.randomUUID().slice(0, 8);
  await env.CAPTION_SETTINGS?.put(cancelKey(token), jobId, { expirationTtl: CANCEL_TTL_SECONDS }).catch(
    (err) => console.error('[jobs] could not store a cancel token:', err),
  );

  const status = await tg.sendMessage(chatId, '⏳ Queued…', messageId, cancelKeyboard(token));

  await env.CAPTION_WORKFLOW.create({
    id: jobId,
    params: {
      jobId,
      chatId,
      messageId,
      ...source,
      ...(settings ? { settings } : {}),
      statusMessageId: status.message_id,
      cancelToken: token,
    },
  });
}

/**
 * Stop a running job.
 *
 * Terminating the workflow is not enough on its own: the container bills for
 * as long as it is awake, so it is stopped here rather than left to its idle
 * timer, and the half-finished files go with it.
 */
export async function handleCancelCallback(
  env: Env,
  chatId: number,
  messageId: number,
  callbackId: string,
  data: string,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const token = data.slice(data.indexOf(':') + 1);

  const jobId = await env.CAPTION_SETTINGS?.get(cancelKey(token));
  if (!jobId) {
    await tg.answerCallbackQuery(callbackId, 'That job has already finished.');
    await tg.editMessageText(chatId, messageId, '⌛ Nothing left to stop.');
    return;
  }

  // Spent either way, so a second tap cannot race the first.
  await env.CAPTION_SETTINGS?.delete(cancelKey(token)).catch(() => {});

  try {
    const instance = await env.CAPTION_WORKFLOW.get(jobId);
    await instance.terminate();
  } catch (err) {
    console.error(`[jobs] could not terminate ${jobId}:`, err);
  }

  await ffmpegFor(env, jobId).cleanup();
  await purgeAssets(env, jobId);

  await tg.answerCallbackQuery(callbackId, 'Stopped');
  await tg.editMessageText(chatId, messageId, '✖️ Stopped.');
}

/**
 * Resolve a post and ask whether to caption it.
 *
 * The resolved media link is deliberately thrown away: it is signed and
 * short-lived, so it would be dead by the time the button is tapped. Only the
 * post URL is kept, and the workflow resolves it again for itself.
 *
 * With 🧾 Confirm settings on this *is* the settings card: the preview line
 * sits above the settings list rather than on a card of its own, because
 * ✅ Caption it means the same thing on both and two taps for one video is one
 * too many.
 */
export async function sendOffer(
  env: Env,
  chatId: number,
  messageId: number,
  url: string,
  settings: CaptionSettings,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);

  if (!env.CAPTION_SETTINGS) throw new NonRetryableError('the KV namespace that holds pending links is not bound');

  const media = await resolveVideo(env, url);

  const card = [
    media.platform,
    media.quality,
    media.filesize ? `${(media.filesize / 1024 / 1024).toFixed(1)} MB` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  if (settings.confirm === 'on') {
    const sent = await sendStartCard(
      env,
      chatId,
      { sourceUrl: url, messageId, preview: card },
      settings,
      media.thumbnail,
    );
    // Only a KV write that did not land gets here, and a link the user is
    // waiting on is better served by the plain offer below than by an error.
    if (sent) return;
  }

  const id = crypto.randomUUID().slice(0, 8);
  const pending: Pending = { url, messageId };
  await env.CAPTION_SETTINGS.put(pendingKey(id), JSON.stringify(pending), {
    expirationTtl: OFFER_TTL_SECONDS,
  });

  const keyboard: InlineKeyboard = [
    [
      { text: '✅ Caption it', callback_data: `d:${id}` },
      { text: '❌ Cancel', callback_data: `dx:${id}` },
    ],
  ];

  // The thumbnail is optional, and its link can be as short-lived as the media
  // one — so a failed photo send falls back to the same card as text.
  if (media.thumbnail) {
    const sent = await tg.sendPhoto(chatId, media.thumbnail, { caption: card, replyTo: messageId, keyboard });
    if (sent) return;
  }

  await tg.sendMessage(chatId, card, messageId, keyboard);
}

/**
 * Handle a tap on a confirm card.
 *
 * The pending key is deleted before the job starts, so a second tap finds
 * nothing and cannot spend the money twice.
 */
export async function handleOfferCallback(
  env: Env,
  chatId: number,
  messageId: number,
  callbackId: string,
  data: string,
  isPhotoCard: boolean,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const cancelled = data.startsWith('dx:');
  const id = data.slice(data.indexOf(':') + 1);

  // Buttons come off the card either way — the offer is spent.
  const rewrite = (text: string) =>
    isPhotoCard
      ? tg.editMessageCaption(chatId, messageId, text)
      : tg.editMessageText(chatId, messageId, text);

  const stored = env.CAPTION_SETTINGS
    ? await env.CAPTION_SETTINGS.get<Pending>(pendingKey(id), 'json')
    : null;
  await env.CAPTION_SETTINGS?.delete(pendingKey(id)).catch(() => {});

  if (!stored) {
    await tg.answerCallbackQuery(callbackId, 'That offer expired or already started — send the link again.');
    await rewrite('⌛ Expired.');
    return;
  }

  if (cancelled) {
    await tg.answerCallbackQuery(callbackId, 'Cancelled');
    await rewrite('❌ Cancelled.');
    return;
  }

  await tg.answerCallbackQuery(callbackId, 'Starting…');
  await rewrite('✅ Starting…');
  // A fresh text message carries the progress: the workflow edits its status
  // line with editMessageText, which cannot touch a photo card.
  await startJob(env, chatId, stored.messageId, { sourceUrl: stored.url });
}

/**
 * The 🧾 confirm card: what this video is about to be captioned with.
 *
 * It is the /settings keyboard, seeded from the chat defaults and pointed at
 * this card instead. The draft rides on the buttons as a code — exactly as the
 * ✏️ Edit card's does, and for the same reason: KV is eventually consistent, so
 * a read-modify-write per tap can serve a stale draft and quietly undo a change
 * the user already made. Nothing here is ever written back to the chat
 * defaults, which is what makes a change on this card apply to one video.
 */
const START_TITLE = '🧾 Ready to caption';

const START_HINT = [
  'Tap a setting to change it for this video only, then ✅ Caption it.',
  'Your chat defaults stay as they are.',
].join('\n');

const startBody = (preview?: string) =>
  [START_TITLE, ...(preview ? [preview] : []), '', START_HINT].join('\n');

const startScope = (token: string, settings: CaptionSettings): MenuScope => ({
  open: (field) => `gm:${token}:${encodeSettings(settings)}:${field}`,
  // The code carries the value; the field name rides along only so the tap can
  // be acknowledged with the name of what just changed.
  pick: (field, value) =>
    `gs:${token}:${encodeSettings({ ...settings, [field]: value } as CaptionSettings)}:${field}`,
  footer: [
    [
      { text: '✅ Caption it', callback_data: `gg:${token}:${encodeSettings(settings)}` },
      { text: '❌ Cancel', callback_data: `gx:${token}` },
    ],
  ],
  // 🧾 Confirm settings is the one field left off: turning the card off from
  // the card would only apply to the video already showing it.
  fields: START_FIELDS,
});

/**
 * Ask for approval before anything is spent.
 *
 * Returns false when the session could not be parked, so the caller can fall
 * back to starting the job rather than leaving the user with a card no tap can
 * do anything with.
 */
export async function sendStartCard(
  env: Env,
  chatId: number,
  session: StartSession,
  settings: CaptionSettings,
  thumbnail?: string,
): Promise<boolean> {
  if (!env.CAPTION_SETTINGS) return false;

  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const token = crypto.randomUUID().slice(0, 8);

  try {
    await env.CAPTION_SETTINGS.put(startKey(token), JSON.stringify(session), {
      expirationTtl: OFFER_TTL_SECONDS,
    });
  } catch (err) {
    console.error('[jobs] could not park a confirm card:', err);
    return false;
  }

  const body = startBody(session.preview);
  const keyboard = rootKeyboard(settings, startScope(token, settings));

  // A link's thumbnail is worth keeping, but it is optional and its URL can be
  // as short-lived as the media one — so a failed photo send falls back to the
  // same card as text.
  if (thumbnail) {
    const sent = await tg.sendPhoto(chatId, thumbnail, {
      caption: body,
      replyTo: session.messageId,
      keyboard,
    });
    if (sent) return true;
  }

  await tg.sendMessage(chatId, body, session.messageId, keyboard);
  return true;
}

/**
 * Handle a tap on a confirm card.
 *
 * `isPhotoCard` decides which edit call redraws it: editMessageText is refused
 * on a photo message, and a link's card carries its thumbnail.
 */
export async function handleStartCallback(
  env: Env,
  chatId: number,
  messageId: number,
  callbackId: string,
  data: string,
  isPhotoCard: boolean,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const [verb, token, code, rawField] = data.split(':');

  const rewrite = (text: string, keyboard?: InlineKeyboard) =>
    isPhotoCard
      ? tg.editMessageCaption(chatId, messageId, text, keyboard)
      : tg.editMessageText(chatId, messageId, text, keyboard);

  const session = env.CAPTION_SETTINGS
    ? await env.CAPTION_SETTINGS.get<StartSession>(startKey(token), 'json')
    : null;

  if (!session) {
    await tg.answerCallbackQuery(callbackId, 'That card expired or already started — send the video again.');
    await rewrite('⌛ Expired.');
    return;
  }

  if (verb === 'gx') {
    await env.CAPTION_SETTINGS?.delete(startKey(token)).catch(() => {});
    await tg.answerCallbackQuery(callbackId, 'Cancelled');
    await rewrite('❌ Cancelled.');
    return;
  }

  // The code carries every field, so the deployed defaults are only a
  // structural floor for a truncated or corrupted one — no KV read per tap.
  const settings = decodeSettings(code ?? '', defaults(env));
  const scope = startScope(token, settings);

  switch (verb) {
    case 'gm': {
      if (rawField === 'root') {
        await tg.answerCallbackQuery(callbackId);
        await rewrite(startBody(session.preview), rootKeyboard(settings, scope));
        return;
      }

      const field = rawField as SettingsField;
      if (!START_FIELDS.includes(field)) return void (await tg.answerCallbackQuery(callbackId));
      await tg.answerCallbackQuery(callbackId);
      await rewrite(`${MENUS[field].icon} ${MENUS[field].label}`, fieldKeyboard(field, settings, scope));
      return;
    }

    case 'gs': {
      // The code already holds the new value, so there is nothing to save —
      // just acknowledge which field moved and redraw the top level.
      const field = readChoice(rawField ?? '', settings[rawField as SettingsField] ?? '');
      if (!field) return void (await tg.answerCallbackQuery(callbackId, 'Unknown option'));

      await tg.answerCallbackQuery(callbackId, `${MENUS[field].label}: ${shortLabel(field, settings[field])}`);
      await rewrite(startBody(session.preview), rootKeyboard(settings, scope));
      return;
    }

    case 'gg': {
      // Spent before the job is queued, so a second tap finds nothing and
      // cannot pay for the same video twice.
      await env.CAPTION_SETTINGS?.delete(startKey(token)).catch(() => {});

      const source = session.sourceUrl
        ? ({ sourceUrl: session.sourceUrl } as const)
        : session.fileId
          ? ({ fileId: session.fileId } as const)
          : null;

      if (!source) {
        await tg.answerCallbackQuery(callbackId, 'That card has no video on it — send it again.');
        await rewrite('⚠️ Nothing to caption.');
        return;
      }

      await tg.answerCallbackQuery(callbackId, 'Starting…');
      // Buttons come off first: the card is spent, and a fresh text message
      // carries the progress — the workflow edits its status line with
      // editMessageText, which cannot touch a photo card.
      await rewrite('✅ Starting…');
      await startJob(env, chatId, session.messageId, source, settings);
      return;
    }

    default:
      await tg.answerCallbackQuery(callbackId);
  }
}
