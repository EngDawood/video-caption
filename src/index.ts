import { MENU_TITLE, handleMenuCallback, rootKeyboard, summary } from './menu';
import { loadSettings } from './settings';
import { extractVideo, telegram, type TgUpdate } from './telegram';
import type { Env } from './types';
import { usageReport } from './usage';

export { FfmpegContainer } from './container';
export { CaptionWorkflow } from './workflow';

// The Bot API refuses to hand a bot any file larger than this.
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

const HELP = [
  'Send me a video and I will:',
  '1. pull the speech out of it,',
  '2. translate it to Arabic,',
  '3. burn the Arabic captions into the video and send it back.',
  '',
  `Videos must be under ${TELEGRAM_DOWNLOAD_LIMIT / 1024 / 1024} MB — that is a Telegram limit on what bots may download.`,
  '',
  'Send /settings to change the caption style, font, size, colour or position.',
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
      } else if (message.text) {
        await tg.sendMessage(chatId, HELP, message.message_id);
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

    const status = await tg.sendMessage(chatId, '⏳ Queued…', message.message_id);
    const jobId = crypto.randomUUID();

    await env.CAPTION_WORKFLOW.create({
      id: jobId,
      params: {
        jobId,
        chatId,
        messageId: message.message_id,
        fileId: video.fileId,
        statusMessageId: status.message_id,
      },
    });
  } catch (err) {
    console.error('[webhook] failed to start job:', err);
    await tg.sendMessage(chatId, '❌ Could not start the job. Try again.').catch(() => {});
  }
}
