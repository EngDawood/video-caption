import { NonRetryableError } from 'cloudflare:workflows';
import { extractSourceUrl, maxSourceBytes } from './media/download';
import { handleEditCallback, isEditCallback } from './bot/edit';
import { handleOfferCallback, isOfferCallback, sendOffer, startJob } from './bot/jobs';
import { MENU_TITLE, handleMenuCallback, rootKeyboard, summary } from './bot/menu';
import { loadSettings } from './captions/settings';
import { extractVideo, telegram, type TgUpdate } from './bot/telegram';
import type { Env } from './types';
import { usageReport } from './bot/usage';

export { FfmpegContainer } from './media/container';
export { CaptionWorkflow } from './pipeline/workflow';

// The Bot API refuses to hand a bot any file larger than this.
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

const help = (env: Env) =>
  [
    'Send me a video — or a link to one on TikTok, Instagram, YouTube, X, Facebook or Threads — and I will:',
    '1. pull the speech out of it,',
    '2. translate it to Arabic,',
    '3. burn the Arabic captions into the video and send it back.',
    '',
    'A link is previewed first — nothing is transcribed until you tap ✅ Caption it.',
    '',
    `Uploads must be under ${TELEGRAM_DOWNLOAD_LIMIT / 1024 / 1024} MB, which is a Telegram limit on what bots may download. Videos from a link must be under ${Math.round(maxSourceBytes(env) / 1024 / 1024)} MB, so the captioned result still fits back into Telegram.`,
    '',
    'Every finished video comes with an ✏️ Edit button: change the style, position, size or line length for that one video and tap ♻️ Apply & re-burn. It only re-renders, so it skips the transcription and costs a fraction of the first run.',
    '',
    'Send /settings to change the defaults every new video starts from.',
  ].join('\n');

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true });
    }

    // Handy after a deploy: shows which font families libass can actually see,
    // so SUBTITLE_FONT can be set to a name that exists.
    if (url.pathname === '/debug/fonts') {
      if (url.searchParams.get('secret') !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const probe = env.FFMPEG.getByName('debug');
      const [fonts, health] = await Promise.all([
        probe.fetch('http://ffmpeg/fonts').then((r) => r.json()),
        probe.fetch('http://ffmpeg/health').then((r) => r.json()),
      ]);
      return Response.json({ configured: env.SUBTITLE_FONT, health, fonts });
    }

    if (url.pathname === '/telegram/webhook' && request.method === 'POST') {
      if (request.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }

      const update = (await request.json()) as TgUpdate;
      // Always 200 quickly — Telegram retries anything else and would queue duplicates.
      ctx.waitUntil(handleUpdate(update, env));
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Whether this chat may use the bot at all.
 *
 * Fails OPEN when ADMIN_CHAT_ID is unset, so a fresh deploy is not silently
 * dead — set the secret to lock the bot to yourself.
 */
function isOwner(env: Env, chatId: number): boolean {
  if (!env.ADMIN_CHAT_ID) return true;
  return env.ADMIN_CHAT_ID.split(',')
    .map((id) => id.trim())
    .includes(String(chatId));
}

async function handleUpdate(update: TgUpdate, env: Env): Promise<void> {
  // Button presses in the /settings menu arrive as callback queries.
  if (update.callback_query) {
    const query = update.callback_query;
    const origin = query.message;
    if (!origin || !query.data) return;
    if (!isOwner(env, origin.chat.id)) return;

    if (isOfferCallback(query.data)) {
      await handleOfferCallback(
        env,
        origin.chat.id,
        origin.message_id,
        query.id,
        query.data,
        Boolean(origin.photo),
      );
      return;
    }

    // Restyling one delivered video, as opposed to the chat-wide defaults below.
    if (isEditCallback(query.data)) {
      await handleEditCallback(env, origin.chat.id, origin.message_id, query.id, query.data);
      return;
    }

    await handleMenuCallback(env, origin.chat.id, origin.message_id, query.id, query.data);
    return;
  }

  const message = update.message ?? update.edited_message;
  if (!message) return;

  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const chatId = message.chat.id;

  // Transcription, translation and ffmpeg time all cost money, so a stranger
  // finding the bot must not be able to spend it.
  if (!isOwner(env, chatId)) {
    await tg.sendMessage(chatId, '⛔ This bot is private.', message.message_id).catch(() => {});
    return;
  }

  try {
    const video = extractVideo(message);
    const sourceUrl = video ? null : extractSourceUrl(message.text ?? message.caption);

    if (!video) {
      const command = message.text?.trim().split(/[\s@]/)[0];

      if (command === '/usage') {
        await tg.sendMessage(chatId, await usageReport(env), message.message_id);
      } else if (command === '/settings') {
        const settings = await loadSettings(env, chatId);
        await tg.sendMessage(chatId, MENU_TITLE, message.message_id, rootKeyboard(settings));
      } else if (command === '/style') {
        const settings = await loadSettings(env, chatId);
        await tg.sendMessage(chatId, summary(settings), message.message_id);
      } else if (sourceUrl) {
        // A social link: resolve it for a preview, then let the user confirm
        // before any container time or transcription is paid for.
        if (!env.DOWNLOAD_API_KEY) {
          await tg.sendMessage(
            chatId,
            '⚠️ Link downloads are not set up on this bot. Send the video file instead.',
            message.message_id,
          );
          return;
        }
        try {
          await sendOffer(env, chatId, message.message_id, sourceUrl);
        } catch (err) {
          await tg.sendMessage(chatId, `⚠️ ${offerProblem(err)}`, message.message_id);
        }
      } else if (message.text) {
        await tg.sendMessage(chatId, help(env), message.message_id);
      }
      return;
    }

    if (video.size > TELEGRAM_DOWNLOAD_LIMIT) {
      await tg.sendMessage(
        chatId,
        `⚠️ That video is ${(video.size / 1024 / 1024).toFixed(1)} MB. Telegram only lets bots download files up to 20 MB.`,
        message.message_id,
      );
      return;
    }

    await startJob(env, chatId, message.message_id, { fileId: video.fileId });
  } catch (err) {
    console.error('[webhook] failed to start job:', err);
    await tg.sendMessage(chatId, '❌ Could not start the job. Try again.').catch(() => {});
  }
}

/**
 * Why a link could not be offered.
 *
 * A NonRetryableError carries a message written for the user; anything else is
 * a busy or flaky backend, which is worth trying again by hand.
 */
function offerProblem(err: unknown): string {
  if (err instanceof NonRetryableError) return err.message;
  console.error('[webhook] could not resolve link:', err);
  return 'The download service is busy right now — send that link again in a moment.';
}
