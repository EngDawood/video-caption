import { EDIT_FIELDS, encodeSettings, type CaptionSettings } from '../../captions/settings';
import { loadCues } from '../../media/assets';
import { summary, type MenuScope } from '../menu';
import { telegram, type InlineKeyboard } from '../telegram';
import type { Env } from '../../types';
import { previewCaption, renderPreview } from './preview';
import { sendScript } from './script';
import { EDIT_TTL_SECONDS, fixKey, openSession, type FixSession } from './session';

/** The ✏️ card after a delivery, and the 📝/🖼 card that stands in front of a burn. */

/** What `sendReviewCard` posted, so a caller waiting on the tap can act as if it happened. */
export interface ReviewCard {
  /** The session token the card's buttons carry — `eg:${token}:${code}` is ✅ Burn it. */
  token: string;
  /** The card message itself, so a later status edit lands on it like a tap's would. */
  messageId: number;
}

export const scopeFor = (token: string, settings: CaptionSettings): MenuScope => ({
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
  // 📝 Check script is a chat default, not a property of a video that has
  // already been burned.
  fields: EDIT_FIELDS,
});

const CARD_TITLE = '🎬 Captioned with:';
export const MENU_TITLE =
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

  try {
    const token = await openSession(env, { assetJobId, messageId, settings });
    if (!token) return;

    const code = encodeSettings(settings);
    const keyboard: InlineKeyboard = [
      [
        { text: '✏️ Edit', callback_data: `e:${token}:${code}` },
        { text: '✍️ Fix text', callback_data: `et:${token}:${code}` },
      ],
      [
        { text: '📄 Script', callback_data: `ed:${token}:${code}` },
        { text: '🖼 Preview', callback_data: `ep:${token}:${code}` },
      ],
      [{ text: '✖️ Cancel', callback_data: `ex:${token}` }],
    ];
    await tg.sendMessage(
      chatId,
      `${CARD_TITLE}\n${summary(settings, EDIT_FIELDS)}`,
      messageId,
      keyboard,
    );
  } catch (err) {
    console.error('[edit] could not offer a restyle:', err);
  }
}

const reviewTitle = (script: boolean, frame: boolean) =>
  [
    `${script ? '📝' : '🖼'} Check it before I burn it.`,
    '',
    script && frame
      ? 'Above: the whole script, and one frame with the captions burned into it.'
      : script
        ? 'The script is in the file above.'
        : 'Above is one frame with the captions burned into it.',
    '',
    'Tap ✍️ Fix text to correct a line, ✏️ Edit to change how it will look, 🖼 Preview to render another frame, then ✅ Burn it.',
    '',
    'Nothing has been encoded yet — ✖️ Discard drops the video and costs nothing.',
  ].join('\n');

/**
 * Stop before the burn and put what the chat asked for in front of the user:
 * the script (📝 Check script), one burned frame (🖼 Check preview), or both on
 * one card.
 *
 * The card is the ✏️ card with one button added, because the whole flow behind
 * it already exists: ✍️ Fix text writes corrections into the stored cues, and
 * ✅ Burn it is the same `restyle` re-run the ♻️ Apply button has always
 * queued. That is why the workflow can end here rather than idle waiting for a
 * tap — a paused run would hold a Workflow instance open for as long as the
 * user takes to read, and the burn has to reload the video into a container
 * either way.
 *
 * Returns false if there is nothing to show, and the caller burns as usual
 * rather than parking a job behind a card with nothing on it.
 */
export async function sendReviewCard(
  env: Env,
  chatId: number,
  messageId: number,
  assetJobId: string,
  settings: CaptionSettings,
): Promise<ReviewCard | false> {
  const tg = telegram(env.TELEGRAM_BOT_TOKEN);

  try {
    const token = await openSession(env, { assetJobId, messageId, settings });
    if (!token) return false;

    const code = encodeSettings(settings);

    const sentScript = settings.review === 'on' && (await sendScript(env, chatId, assetJobId));

    let sentFrame = false;
    if (settings.preview === 'on') {
      const stored = await loadCues(env, assetJobId);
      const shot =
        stored && stored.segments.length > 0
          ? await renderPreview(env, assetJobId, settings, stored)
          : null;

      if (shot) {
        await tg.sendPhotoFile(chatId, shot.frame, { caption: previewCaption(shot.at) });
        sentFrame = true;
      }
    }

    // Nothing to look at is nothing to approve. Both settings can ask for a
    // gate and still land here with neither attachment — an expired video, a
    // container that would not render — and a card with no content above it
    // would strand a job the user cannot finish.
    if (!sentScript && !sentFrame) return false;

    // The pointer the pasted-back blocks are matched against, exactly as the
    // ✍️ button would have written it — a correction is the first thing
    // someone reading a script wants to send, with no tap in between. Only
    // worth writing when the script is actually on screen to copy from; the
    // ✍️ button writes it for itself otherwise.
    if (sentScript) {
      await env.CAPTION_SETTINGS?.put(
        fixKey(chatId),
        JSON.stringify({ token, code } satisfies FixSession),
        { expirationTtl: EDIT_TTL_SECONDS },
      ).catch(() => {});
    }

    const keyboard: InlineKeyboard = [
      [{ text: '✅ Burn it', callback_data: `eg:${token}:${code}` }],
      [
        { text: '✍️ Fix text', callback_data: `et:${token}:${code}` },
        { text: '✏️ Edit', callback_data: `e:${token}:${code}` },
      ],
      [
        { text: '🖼 Preview', callback_data: `ep:${token}:${code}` },
        { text: '✖️ Discard', callback_data: `ex:${token}` },
      ],
    ];
    const sent = await tg.sendMessage(chatId, reviewTitle(sentScript, sentFrame), messageId, keyboard);
    return { token, messageId: sent.message_id };
  } catch (err) {
    console.error('[edit] could not offer a review:', err);
    return false;
  }
}
