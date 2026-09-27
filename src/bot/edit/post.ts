import { loadSettings } from '../../captions/settings';
import { loadCues, loadPostCaption, loadPostOrigin } from '../../media/assets';
import { postSourceOf, postTextLanguages, writeHashtags, writePostText } from '../../pipeline/describe';
import { escapeHtml, telegram } from '../telegram';
import type { Env } from '../../types';
import type { EditSession } from './session';

/** 📣 Post text: a description to paste under the video when publishing it. */

const FLAGS: Record<string, string> = { ar: '🇸🇦', en: '🇬🇧' };

const LANGUAGE_LABELS: Record<string, string> = { ar: 'العربية', en: 'English' };

const TITLE = '📣 Post text — tap a block to copy it.';

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
  session: EditSession,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const [stored, caption, origin] = await Promise.all([
    loadCues(env, session.assetJobId),
    loadPostCaption(env, session.assetJobId),
    loadPostOrigin(env, session.assetJobId),
  ]);
  if (!stored) {
    await tg.answerCallbackQuery(callbackId, 'That video is no longer stored.');
    return;
  }

  // What was said, in the language it was said in, and what the video was
  // posted with; the translation only stands in for a video stored before
  // transcripts were kept.
  const source = postSourceOf(stored.source?.length ? stored.source : stored.segments, caption, origin);
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
    await tg.sendMessage(chatId, [TITLE, ...blocks].join('\n\n'), session.messageId, undefined, 'HTML');
  } catch (err) {
    console.error('[edit] could not post the post text:', err);
  }
}
