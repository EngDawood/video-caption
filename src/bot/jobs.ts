import { NonRetryableError } from 'cloudflare:workflows';
import { resolveVideo } from '../media/download';
import { purgeAssets } from '../media/assets';
import { ffmpegFor } from '../media/ffmpeg';
import { telegram, type InlineKeyboard } from './telegram';
import type { Env } from '../types';

/**
 * Everything between a message arriving and a CaptionWorkflow running.
 *
 * An uploaded video starts a job straight away. A link is gated behind a
 * confirm card first, because captioning costs container time and STT and a
 * pasted link is easy to send by accident.
 *
 * callback_data grammar (Telegram caps it at 64 bytes, and a post URL rarely
 * fits, so only a short id rides on the button — the URL lives in KV):
 *   d:<id>       caption it
 *   dx:<id>      do not
 *   k:<token>    stop a job that is already running
 */

/** How long a confirm card stays tappable. */
const OFFER_TTL_SECONDS = 3600;

/** A job cannot outlive this, so neither need its cancel button. */
const CANCEL_TTL_SECONDS = 3600;

const pendingKey = (id: string) => `pending:${id}`;
export const cancelKey = (token: string) => `cancel:${token}`;

interface Pending {
  url: string;
  /** The message that carried the link, so the result replies to it. */
  messageId: number;
}

export function isOfferCallback(data: string): boolean {
  return data.startsWith('d:') || data.startsWith('dx:');
}

export function isCancelCallback(data: string): boolean {
  return data.startsWith('k:');
}

/** The ✖️ Stop button carried on a running job's status line. */
export const cancelKeyboard = (token: string): InlineKeyboard => [
  [{ text: '✖️ Stop', callback_data: `k:${token}` }],
];

/** Post the status message and kick off a caption job for it. */
export async function startJob(
  env: Env,
  chatId: number,
  messageId: number,
  source: { fileId: string; sourceUrl?: never } | { sourceUrl: string; fileId?: never },
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
 */
export async function sendOffer(env: Env, chatId: number, messageId: number, url: string): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);

  if (!env.CAPTION_SETTINGS) throw new NonRetryableError('the KV namespace that holds pending links is not bound');

  const media = await resolveVideo(env, url);

  const id = crypto.randomUUID().slice(0, 8);
  const pending: Pending = { url, messageId };
  await env.CAPTION_SETTINGS.put(pendingKey(id), JSON.stringify(pending), {
    expirationTtl: OFFER_TTL_SECONDS,
  });

  const card = [
    media.platform,
    media.quality,
    media.filesize ? `${(media.filesize / 1024 / 1024).toFixed(1)} MB` : null,
  ]
    .filter(Boolean)
    .join(' · ');

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
