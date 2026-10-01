import { loadSettings } from '../../captions/settings';
import { findShow, loadShows, showId, type Shows } from '../../captions/shows';
import { loadCues, loadJobSettings, loadPostCaption, loadPostOrigin } from '../../media/assets';
import { postSourceOf, postTextLanguages, writeHashtags, writePostText } from '../../pipeline/describe';
import { escapeHtml, telegram, type InlineKeyboard } from '../telegram';
import type { Env } from '../../types';
import type { EditSession } from './session';

/** 📣 Post text: a description to paste under the video when publishing it. */

const FLAGS: Record<string, string> = { ar: '🇸🇦', en: '🇬🇧' };

const LANGUAGE_LABELS: Record<string, string> = { ar: 'العربية', en: 'English' };

const TITLE = '📣 Post text — tap a block to copy it.';

/** Most shows offered as buttons; the rest are still matched automatically. */
const MAX_SHOW_BUTTONS = 12;

/** Which 🎬 show a tap picked: its id, 'a' for the automatic match, or nothing on the first 📣 tap. */
export interface ShowPick {
  messageId: number;
  show: string;
}

/**
 * One button per saved show, two to a row, with ✅ on the one the text was
 * written from and a 🔄 Auto row once a show has been picked by hand. Empty
 * when no show is saved, so a chat that does not use /shows sees no change.
 */
function showKeyboard(token: string, shows: Shows, used: string | null, manual: boolean): InlineKeyboard {
  const names = Object.keys(shows).slice(0, MAX_SHOW_BUTTONS);
  if (names.length === 0) return [];
  const buttons = names.map((name) => ({
    text: `${name === used ? '✅ ' : '🎬 '}${name.length > 28 ? `${name.slice(0, 27)}…` : name}`,
    callback_data: `ew:${token}:${showId(name)}`,
  }));
  const rows: InlineKeyboard = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  if (manual) rows.push([{ text: '🔄 Auto', callback_data: `ew:${token}:a` }]);
  return rows;
}

/**
 * Write and post the description in every configured language.
 *
 * Nothing is cached: a second tap writes a fresh version, which is what makes
 * the button double as "try again". Answered once, after the send, so the
 * toast can report a failure — Telegram accepts only the first answer.
 */
export async function sendPostText(
  env: Env,
  chatId: number,
  callbackId: string,
  token: string,
  session: EditSession,
  pick?: ShowPick,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const [stored, caption, origin, ran] = await Promise.all([
    loadCues(env, session.assetJobId),
    loadPostCaption(env, session.assetJobId),
    loadPostOrigin(env, session.assetJobId),
    loadJobSettings(env, session.assetJobId),
  ]);
  if (!stored) {
    await tg.answerCallbackQuery(callbackId, 'That video is no longer stored.');
    return;
  }

  // The 🎭 type the latest run used: a re-run rewrites settings.json, the
  // session keeps the first run's.
  const genre = ran?.genre ?? session.settings?.genre;

  // What was said, in the language it was said in, and what the video was
  // posted with; the translation only stands in for a video stored before
  // transcripts were kept.
  // The 🎬 show: the one tapped, or else the one the post's caption names.
  const shows = await loadShows(env, chatId);
  const used =
    pick && pick.show !== 'a'
      ? (Object.keys(shows).find((name) => showId(name) === pick.show) ?? null)
      : findShow(shows, [caption, origin?.author]);
  const source = postSourceOf(
    stored.source?.length ? stored.source : stored.segments,
    caption,
    origin,
    genre,
    used === null ? null : shows[used],
  );
  if (!source) {
    await tg.answerCallbackQuery(callbackId, 'There is too little speech or text in this video to describe.');
    return;
  }

  // Writing takes a few seconds; acknowledge the tap first so the button
  // does not sit spinning, and report the outcome as a message instead.
  await tg.answerCallbackQuery(callbackId, 'Writing…');

  // The chat's current choice, not the one the video was burned under: the
  // writer changes nothing about the video, and picking a new one in
  // /settings should apply to the next tap on any card still open.
  const { writer } = await loadSettings(env, chatId);
  const languages = postTextLanguages(env);
  const [texts, tags] = await Promise.all([
    Promise.all(languages.map((lang) => writePostText(env, writer, source, lang))),
    writeHashtags(env, writer, source, languages),
  ]);

  const title = used ? `${TITLE}\n🎬 ${escapeHtml(used)}` : TITLE;
  const keyboard = showKeyboard(token, shows, used, pick !== undefined && pick.show !== 'a');
  const blocks = languages.flatMap((lang, i) => {
    const text = texts[i];
    if (!text) return [];
    const label = `${FLAGS[lang] ?? '🌐'} ${LANGUAGE_LABELS[lang] ?? lang}`;
    return [`${label}\n<pre>${escapeHtml(text)}</pre>`];
  });
  // A block of their own, so they can be copied, trimmed or left off
  // separately from the text.
  if (blocks.length > 0 && tags.length > 0) blocks.push(`#️⃣ Hashtags\n<pre>${escapeHtml(tags.join(' '))}</pre>`);

  try {
    if (blocks.length === 0) {
      await tg.sendMessage(chatId, '⚠️ Could not write the post text. Tap 📣 again to retry.');
      return;
    }
    const text = [title, ...blocks].join('\n\n');
    if (pick) await tg.editMessageText(chatId, pick.messageId, text, keyboard, 'HTML');
    else await tg.sendMessage(chatId, text, session.messageId, keyboard.length > 0 ? keyboard : undefined, 'HTML');
  } catch (err) {
    console.error('[edit] could not post the post text:', err);
  }
}
