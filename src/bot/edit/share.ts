import { loadCues, loadPostCaption } from '../../media/assets';
import { loadSettings } from '../../captions/settings';
import { postSourceOf, postTextLanguages, writePostText } from '../../pipeline/describe';
import { publishTargets, targetLabel, type Target } from '../../social/composio';
import type { PublishJob } from '../../social/publish';
import { telegram, type InlineKeyboard } from '../telegram';
import type { Env } from '../../types';
import { EDIT_TTL_SECONDS, type EditSession } from './session';

/**
 * 📤 Share: post the delivered video to a social account connected in
 * Composio — an Instagram account (as a Reel), a Facebook Page, a LinkedIn
 * profile. Whatever is connected there gets a button here.
 *
 * Two taps, never one: the first writes the caption and shows it with a button
 * per account, the second posts. Publishing is public and cannot be taken back
 * from here, so nothing goes out that the user has not just read. The card
 * stays up after a post, so one caption can go to several accounts without
 * being written again.
 *
 * The text is the user's to change: a reply to the card with new wording posts
 * a fresh card carrying it, and takes the buttons off the old one so the old
 * wording cannot go out by a stray tap.
 */

/** Instagram's cap on a caption, the tightest of the three. */
const CAPTION_LIMIT = 2200;

const draftKey = (id: string) => `share:${id}`;

/** Which card a reply is rewriting the text of. Written once per card. */
const cardKey = (chatId: number, messageId: number) => `sharecard:${chatId}:${messageId}`;

interface ShareCard {
  token: string;
  draftId: string;
}

/** What the second tap posts. Written once per 📤 tap, never rewritten. */
interface ShareDraft {
  caption: string;
  targets: Target[];
}

/**
 * Whether this chat may post at all. Fails CLOSED, unlike the bot itself: an
 * unset ADMIN_CHAT_ID opens the bot to anyone, and anyone must not be able to
 * post to these accounts. API_KEY signs the link the platforms download from.
 */
export function canShare(env: Env, chatId: number): boolean {
  if (!env.COMPOSIO_API_KEY || !env.API_KEY) return false;
  return (env.ADMIN_CHAT_ID ?? '').split(',').map((id) => id.trim()).includes(String(chatId));
}

/**
 * The caption: the 📣 post text in every configured language, one after the
 * other. Empty rather than failing when there is nothing to write it from —
 * the video can still be posted, and the preview shows that it has none.
 */
async function writeCaption(env: Env, chatId: number, assetJobId: string): Promise<string> {
  const [stored, posted] = await Promise.all([loadCues(env, assetJobId), loadPostCaption(env, assetJobId)]);
  const source = stored && postSourceOf(stored.source?.length ? stored.source : stored.segments, posted);
  if (!source) return '';

  const { writer } = await loadSettings(env, chatId);
  const texts = await Promise.all(postTextLanguages(env).map((lang) => writePostText(env, writer, source, lang)));
  return texts.filter(Boolean).join('\n\n').slice(0, CAPTION_LIMIT);
}

/**
 * Park the draft and post the card that offers it: the text as it will go
 * out, and a button per account. Both records are written once and never
 * rewritten — a changed text is a new draft on a new card.
 */
async function sendShareCard(
  env: Env,
  chatId: number,
  replyTo: number,
  token: string,
  draft: ShareDraft,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const draftId = crypto.randomUUID().slice(0, 8);
  await env.CAPTION_SETTINGS.put(draftKey(draftId), JSON.stringify(draft), { expirationTtl: EDIT_TTL_SECONDS });

  const keyboard: InlineKeyboard = [
    ...draft.targets.map((t, i) => [{ text: targetLabel(t), callback_data: `eu:${token}:${draftId}:${i}` }]),
    [{ text: '✖️ Close', callback_data: `eu:${token}:${draftId}:x` }],
  ];
  const text = [
    '📤 Post this video? Tap where.',
    '',
    'Text:',
    draft.caption || '(none — there was nothing to write it from)',
    '',
    '✏️ Reply to this message to change the text.',
  ].join('\n');
  const card = await tg.sendMessage(chatId, text, replyTo, keyboard);

  await env.CAPTION_SETTINGS.put(cardKey(chatId, card.message_id), JSON.stringify({ token, draftId } satisfies ShareCard), {
    expirationTtl: EDIT_TTL_SECONDS,
  });
}

/**
 * A reply to a 📤 card: its text replaces the draft's. Returns false when the
 * message was not a reply to one, so the caller treats it as ordinary chat.
 * Costs a KV read only for a reply, which ordinary messages are not.
 */
export async function handleShareReply(
  env: Env,
  chatId: number,
  messageId: number,
  repliedTo: number,
  text: string,
): Promise<boolean> {
  if (!canShare(env, chatId)) return false;
  const card = await env.CAPTION_SETTINGS.get<ShareCard>(cardKey(chatId, repliedTo), 'json').catch(() => null);
  if (!card) return false;

  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  const draft = await env.CAPTION_SETTINGS.get<ShareDraft>(draftKey(card.draftId), 'json').catch(() => null);
  if (!draft) {
    await tg.sendMessage(chatId, '⌛ That card has expired — tap 📤 again.', messageId);
    return true;
  }

  // Refused rather than cut: a trimmed text would go out ending mid-sentence.
  const caption = text.trim();
  if (caption.length > CAPTION_LIMIT) {
    await tg.sendMessage(
      chatId,
      `⚠️ That is ${caption.length} characters; Instagram allows ${CAPTION_LIMIT}. Shorten it and reply again.`,
      messageId,
    );
    return true;
  }

  await tg.editMessageText(chatId, repliedTo, '✏️ Text changed — use the card below.');
  await sendShareCard(env, chatId, messageId, card.token, { ...draft, caption });
  return true;
}

/** `ei:<token>` — write the text and ask where to post it. */
export async function offerShare(
  env: Env,
  chatId: number,
  callbackId: string,
  token: string,
  session: EditSession,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  if (!canShare(env, chatId)) return void (await tg.answerCallbackQuery(callbackId));

  // Writing takes a few seconds; acknowledge the tap first so it does not spin.
  await tg.answerCallbackQuery(callbackId, 'Writing the text…');

  try {
    const [targets, caption] = await Promise.all([
      publishTargets(env),
      writeCaption(env, chatId, session.assetJobId),
    ]);
    if (targets.length === 0) {
      await tg.sendMessage(chatId, '⚠️ No Instagram, Facebook or LinkedIn account is connected in Composio.', session.messageId);
      return;
    }

    await sendShareCard(env, chatId, session.messageId, token, { caption, targets });
  } catch (err) {
    console.error('[share] could not prepare a post:', err);
    await tg.sendMessage(chatId, '⚠️ Could not reach Composio. Tap 📤 again to retry.', session.messageId).catch(() => {});
  }
}

/** `eu:<token>:<draftId>:<n|x>` — post to the n-th target, or cancel. */
export async function startShare(
  env: Env,
  chatId: number,
  messageId: number,
  callbackId: string,
  draftId: string,
  choice: string,
  session: EditSession,
): Promise<void> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);
  if (!canShare(env, chatId)) return void (await tg.answerCallbackQuery(callbackId));

  if (choice === 'x') {
    await tg.answerCallbackQuery(callbackId, 'Closed');
    await tg.editMessageText(chatId, messageId, '📤 Closed.');
    return;
  }

  const draft = await env.CAPTION_SETTINGS.get<ShareDraft>(draftKey(draftId), 'json');
  const target = draft?.targets[Number(choice)];
  if (!draft || !target) {
    await tg.answerCallbackQuery(callbackId, 'That post has expired — tap 📤 again.');
    await tg.editMessageText(chatId, messageId, '⌛ Expired.');
    return;
  }

  // The card stays up, so the same caption can go to one account after
  // another; each post reports on a status line of its own under it.
  await tg.answerCallbackQuery(callbackId, 'Posting…');
  const status = await tg.sendMessage(
    chatId,
    `⏳ Posting to ${targetLabel(target)}… this can take a couple of minutes.`,
    messageId,
  );

  // Deterministic per card and account, so a second tap on the same button
  // collides into the same instance instead of posting the video twice. As in
  // `queueRestyle`, the collision is read back rather than matched on the error.
  const id = `share-${draftId}-${choice}`;
  const params: PublishJob = {
    assetJobId: session.assetJobId,
    target,
    caption: draft.caption,
    chatId,
    statusMessageId: status.message_id,
  };
  try {
    await env.PUBLISH_WORKFLOW.create({ id, params });
  } catch (err) {
    const existing = await env.PUBLISH_WORKFLOW.get(id).catch(() => null);
    if (!existing) console.error('[share] could not queue the post:', err);
    await tg.editMessageText(
      chatId,
      status.message_id,
      existing
        ? `↩️ Already sent to ${targetLabel(target)} from this card.`
        : '⚠️ Could not start the post. Tap the button again to retry.',
    );
  }
}
