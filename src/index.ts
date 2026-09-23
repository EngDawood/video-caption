import { NonRetryableError } from 'cloudflare:workflows';
import { ApiJobError, jobStatus, submitJob } from './api/jobs';
import { getOutput, hasValidSignature } from './api/output';
import { handleMcp } from './mcp/server';
import { extractSourceUrl, maxSourceBytes } from './media/download';
import { handleEditCallback, handleShareReply, handleTextCorrection, isEditCallback } from './bot/edit';
import { canShare } from './bot/edit/share';
import {
  handleCancelCallback,
  handleOfferCallback,
  handleStartCallback,
  isCancelCallback,
  isOfferCallback,
  isStartCallback,
  sendOffer,
  sendStartCard,
  startJob,
} from './bot/jobs';
import { MENU_TITLE, handleMenuCallback, rootKeyboard, summary } from './bot/menu';
import { loadSettings } from './captions/settings';
import { extractVideo, telegram, type BotCommand, type TgUpdate } from './bot/telegram';
import type { CaptionSettings } from './captions/settings';
import type { Env } from './types';
import { usageReport } from './bot/usage';
import { accountsReport } from './social/composio';

export { FfmpegContainer } from './media/container';
export { ApiSlots } from './api/concurrency';
export { CaptionWorkflow } from './pipeline/workflow';
export { PublishWorkflow } from './social/publish';

// The Bot API refuses to hand a bot any file larger than this.
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

const help = (env: Env) =>
  [
    'Send me a video — or a link to one on TikTok, Instagram, YouTube, X, Facebook or Threads — and I will:',
    '1. pull the speech out of it,',
    '2. translate it,',
    '3. burn the captions into the video and send it back.',
    '',
    'Every video stops on a 🧾 card first, listing the settings it is about to be captioned with — style, size, position, language, transcriber, translator. Change anything there and it applies to that video only; your chat defaults are untouched. Nothing is transcribed until you tap ✅ Caption it, and a running job can be stopped with ✖️ Stop on its status line.',
    '',
    'If you would rather videos start the moment they arrive, turn 🧾 Confirm settings off in /settings.',
    '',
    `Uploads must be under ${TELEGRAM_DOWNLOAD_LIMIT / 1024 / 1024} MB, which is a Telegram limit on what bots may download. Videos from a link must be under ${Math.round(maxSourceBytes(env) / 1024 / 1024)} MB, so the captioned result still fits back into Telegram.`,
    '',
    'Every finished video comes with an ✏️ Edit button: change anything — style, size, position, line length, language, or which transcriber and translator to use — for that one video, then tap ♻️ Apply. It redoes only what your change actually needs, so a style tweak skips straight to re-rendering.',
    '',
    'Next to it, ✍️ Fix text lists every line with its timestamps — what was said and what was burned in. Tap a block to copy it, correct the wording and send it back; the timestamps are how I find the line to replace.',
    '',
    '🖼 Preview burns the captions onto a single frame so you can see how they sit before paying for the whole encode. Turn 🖼 Check preview on in /settings and every video stops on that frame and waits for ✅ Burn it.',
    '',
    '📏 Line length on Auto sizes the caption to the video: a phone-shaped video gets a shorter line than a widescreen one, so a caption stays on one line instead of stacking up over the picture.',
    '',
    'Send /settings to change the defaults every new video starts from, or /info for what is set up right now.',
  ].join('\n');

/**
 * The ☰ command menu, published to Telegram by POST /telegram/commands.
 *
 * /usage is deliberately absent: it reports billing figures, so it is listed
 * only to the admin chats, in ADMIN_COMMANDS below.
 */
const COMMANDS: BotCommand[] = [
  { command: 'start', description: 'What this bot does' },
  { command: 'info', description: 'How it works, the limits and the current setup' },
  { command: 'settings', description: 'Caption style every new video starts from' },
  { command: 'style', description: 'Show the current caption style' },
  { command: 'help', description: 'Show the quick guide again' },
];

const ADMIN_COMMANDS: BotCommand[] = [
  ...COMMANDS,
  { command: 'usage', description: 'Container usage and projected cost this month' },
  { command: 'accounts', description: 'Instagram, Facebook and LinkedIn accounts connected for 📤 Share' },
];

/** What the bot is set up to do right now, as opposed to how to use it. */
const info = (env: Env, settings: CaptionSettings, commands: BotCommand[]) =>
  [
    'ℹ️ About this bot',
    '',
    'It pulls the speech out of a video, translates it, and burns the result back in as subtitles.',
    '',
    `⏱ Longest video: ${Math.round(Number(env.MAX_VIDEO_SECONDS || 900) / 60)} min`,
    `📦 Upload: up to ${TELEGRAM_DOWNLOAD_LIMIT / 1024 / 1024} MB · from a link: up to ${Math.round(maxSourceBytes(env) / 1024 / 1024)} MB`,
    `🔗 Links: ${
      env.DOWNLOAD_API_KEY
        ? 'TikTok, Instagram, YouTube, X, Facebook, Threads'
        : 'not set up on this bot — send the video file instead'
    }`,
    '',
    'Current setup:',
    summary(settings),
    '',
    'Commands:',
    ...commands.map((c) => `/${c.command} — ${c.description}`),
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

    // Publishes the ☰ command menu. Run once after any deploy that changes
    // COMMANDS — scripts/set-webhook.mjs does it for you, and it is safe to
    // repeat, so opening it in a browser works just as well.
    if (url.pathname === '/telegram/commands') {
      if (url.searchParams.get('secret') !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        return Response.json({ ok: true, scopes: await registerCommands(env) });
      } catch (err) {
        console.error('[commands] setMyCommands failed:', err);
        return Response.json({ ok: false, error: String(err) }, { status: 502 });
      }
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

    // The external REST API and its MCP twin. Unlike ADMIN_CHAT_ID this fails
    // CLOSED: an unset API_KEY disables every route below rather than opening them.
    if (url.pathname === '/mcp') {
      // ?token= because ChatGPT cannot send custom headers — only OAuth or no auth.
      const key = request.headers.get('x-api-key') ?? url.searchParams.get('token');
      if (!env.API_KEY || key !== env.API_KEY) {
        return new Response('forbidden', { status: 403 });
      }
      return handleMcp(request, env, ctx);
    }

    if (url.pathname.startsWith('/api/jobs')) {
      // The download is also a link someone opens in a browser, which cannot set a header.
      const download = request.method === 'GET' ? url.pathname.match(/^\/api\/jobs\/([^/]+)\/output$/) : null;
      const key = request.headers.get('x-api-key') ?? (download ? url.searchParams.get('token') : null);
      const signed = download !== null && (await hasValidSignature(env, download[1], url));
      if (!env.API_KEY || (key !== env.API_KEY && !signed)) {
        return new Response('forbidden', { status: 403 });
      }
      return handleApiJobs(request, env, url);
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
  const admins = adminChatIds(env);
  if (admins.length === 0) return true;
  return admins.includes(String(chatId));
}

/** The chats ADMIN_CHAT_ID names, as trimmed strings. Empty when unset. */
function adminChatIds(env: Env): string[] {
  return (env.ADMIN_CHAT_ID ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Which command list a chat should see. Admins additionally get /usage. */
function commandsFor(env: Env, chatId: number): BotCommand[] {
  return adminChatIds(env).includes(String(chatId)) ? ADMIN_COMMANDS : COMMANDS;
}

/**
 * Publish the command menu to Telegram: the public list by default, and the
 * one with /usage on it to each admin chat. A chat-scoped list replaces the
 * default for that chat, which is why ADMIN_COMMANDS repeats the public ones.
 */
async function registerCommands(env: Env): Promise<Record<string, boolean>> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const published: Record<string, boolean> = {
    default: await tg.setMyCommands(COMMANDS, { type: 'default' }),
  };
  for (const id of adminChatIds(env)) {
    published[id] = await tg.setMyCommands(ADMIN_COMMANDS, { type: 'chat', chat_id: Number(id) });
  }
  return published;
}

async function handleUpdate(update: TgUpdate, env: Env): Promise<void> {
  // Button presses in the /settings menu arrive as callback queries.
  if (update.callback_query) {
    const query = update.callback_query;
    const origin = query.message;
    if (!origin || !query.data) return;
    if (!isOwner(env, origin.chat.id)) return;

    // The 🧾 confirm card: the settings this video is about to be captioned
    // with, before any container time or transcription is paid for.
    if (isStartCallback(query.data)) {
      await handleStartCallback(
        env,
        origin.chat.id,
        origin.message_id,
        query.id,
        query.data,
        Boolean(origin.photo),
      );
      return;
    }

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

    if (isCancelCallback(query.data)) {
      await handleCancelCallback(env, origin.chat.id, origin.message_id, query.id, query.data);
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
      } else if (command === '/accounts') {
        if (!canShare(env, chatId)) {
          await tg.sendMessage(
            chatId,
            '⚠️ Not set up for this chat — 📤 Share needs COMPOSIO_API_KEY and API_KEY, and this chat listed in ADMIN_CHAT_ID.',
            message.message_id,
          );
        } else {
          await tg.sendMessage(chatId, await accountsReport(env), message.message_id);
        }
      } else if (command === '/settings') {
        const settings = await loadSettings(env, chatId);
        await tg.sendMessage(chatId, MENU_TITLE, message.message_id, rootKeyboard(settings));
      } else if (command === '/style') {
        const settings = await loadSettings(env, chatId);
        await tg.sendMessage(chatId, summary(settings), message.message_id);
      } else if (command === '/info') {
        const settings = await loadSettings(env, chatId);
        await tg.sendMessage(chatId, info(env, settings, commandsFor(env, chatId)), message.message_id);
      } else if (command === '/start' || command === '/help') {
        await tg.sendMessage(chatId, help(env), message.message_id);
      } else if (
        message.reply_to_message &&
        message.text &&
        (await handleShareReply(env, chatId, message.message_id, message.reply_to_message.message_id, message.text))
      ) {
        // New wording for a 📤 card's post text, sent as a reply to that card.
      } else if (await handleTextCorrection(env, chatId, message.message_id, message.text ?? '')) {
        // A block copied out of the ✍️ list and sent back with the wording
        // fixed. It costs no KV read unless the text actually carries
        // timestamps, so ordinary messages fall straight through.
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
          await sendOffer(env, chatId, message.message_id, sourceUrl, await loadSettings(env, chatId));
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

    const settings = await loadSettings(env, chatId);
    // Whatever was typed or forwarded with the video, which the 📣 Post text
    // reads alongside the speech.
    const upload = { fileId: video.fileId, postCaption: message.caption?.trim() || undefined };

    // With 🧾 Confirm settings on, an upload stops on the settings card rather
    // than starting: it is the only chance to change what this video is
    // captioned with before the transcription is paid for. A card that could
    // not be parked falls through to the job, so a video is never lost to it.
    if (settings.confirm === 'on') {
      const asked = await sendStartCard(env, chatId, { ...upload, messageId: message.message_id }, settings);
      if (asked) return;
    }

    await startJob(env, chatId, message.message_id, upload, settings);
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

/**
 * `POST /api/jobs`, `GET /api/jobs/{id}` and `GET /api/jobs/{id}/output` —
 * the external REST API. Progress and the finished video go out through the
 * `callbackUrl` the job was submitted with (`pipeline/channel.ts`); this
 * endpoint exists for polling and for fetching the result once it lands.
 */
async function handleApiJobs(request: Request, env: Env, url: URL): Promise<Response> {
  const outputMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/output$/);
  if (outputMatch && request.method === 'GET') {
    const object = await getOutput(env, outputMatch[1]);
    if (!object) return Response.json({ error: 'no output for that job — not finished, already fetched, or expired' }, { status: 404 });
    return new Response(object.body, {
      headers: { 'content-type': 'video/mp4', 'content-length': String(object.size) },
    });
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && request.method === 'GET') {
    try {
      return Response.json(await jobStatus(env, jobMatch[1]));
    } catch (err) {
      if (err instanceof ApiJobError) return Response.json({ error: err.message }, { status: err.status });
      throw err;
    }
  }

  if (url.pathname === '/api/jobs' && request.method === 'POST') {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'request body must be valid JSON' }, { status: 400 });
    }

    try {
      return Response.json(await submitJob(env, body), { status: 202 });
    } catch (err) {
      if (err instanceof ApiJobError) return Response.json({ error: err.message }, { status: err.status });
      console.error('[api] job submission failed:', err);
      return Response.json({ error: 'could not start job' }, { status: 500 });
    }
  }

  return new Response('not found', { status: 404 });
}
