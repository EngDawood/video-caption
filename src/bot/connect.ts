import { canShare } from './edit/share';
import { telegram, type InlineKeyboard } from './telegram';
import { ICONS, PLATFORMS, PLATFORM_NAMES, createConnectLink, type Platform } from '../social/composio';
import type { Env } from '../types';

/**
 * /connect: a Composio sign-in link for a platform, so 📤 Share and /accounts
 * have something to find — without leaving Telegram to dig through Composio's
 * dashboard for the right "Connect" button.
 *
 * Two taps: /connect lists the platforms, tapping one asks Composio for a
 * fresh link and hands it back as a button Telegram opens directly (a `url`
 * button, not `callback_data` — Telegram, not this bot, takes it from there).
 *
 * callback_data grammar:
 *   c:<platform>   mint a sign-in link for that platform
 */

export function isConnectCallback(data: string): boolean {
  return data.startsWith('c:');
}

/** `/connect` — list the platforms Composio can sign into. */
export async function sendConnectMenu(env: Env, chatId: number, replyTo: number): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  if (!canShare(env, chatId)) {
    await tg.sendMessage(
      chatId,
      '⚠️ Not set up for this chat — needs COMPOSIO_API_KEY and API_KEY, and this chat listed in ADMIN_CHAT_ID.',
      replyTo,
    );
    return;
  }

  const keyboard: InlineKeyboard = PLATFORMS.map((p) => [
    { text: `${ICONS[p]} Sign in to ${PLATFORM_NAMES[p]}`, callback_data: `c:${p}` },
  ]);
  await tg.sendMessage(
    chatId,
    '🔌 Connect an account in Composio. Tap a platform for a sign-in link — once it goes through there, /accounts (or 📤 Share) will see it.',
    replyTo,
    keyboard,
  );
}

/** `c:<platform>` — mint the link and hand it back as a button to tap. */
export async function handleConnectCallback(
  env: Env,
  chatId: number,
  messageId: number,
  callbackId: string,
  data: string,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  if (!canShare(env, chatId)) return void (await tg.answerCallbackQuery(callbackId));

  const platform = data.slice('c:'.length) as Platform;
  if (!PLATFORMS.includes(platform)) {
    await tg.answerCallbackQuery(callbackId, 'Unknown platform');
    return;
  }

  await tg.answerCallbackQuery(callbackId, 'Creating a sign-in link…');
  try {
    const link = await createConnectLink(env, platform);
    const expires = new Date(link.expiresAt).toLocaleString('en-US', { timeZone: 'UTC', timeZoneName: 'short' });
    const keyboard: InlineKeyboard = [[{ text: `🔗 Sign in to ${PLATFORM_NAMES[platform]}`, url: link.redirectUrl }]];
    await tg.sendMessage(
      chatId,
      `${ICONS[platform]} Tap below, sign into ${PLATFORM_NAMES[platform]} there, and it's connected. Link expires ${expires}.\n\nCheck /accounts afterward to confirm it went through.`,
      messageId,
      keyboard,
    );
  } catch (err) {
    console.error(`[connect] could not create a ${platform} sign-in link:`, err);
    const reason = err instanceof Error ? err.message : String(err);
    await tg.sendMessage(chatId, `⚠️ Could not create a sign-in link.\n\n${reason}`, messageId);
  }
}
