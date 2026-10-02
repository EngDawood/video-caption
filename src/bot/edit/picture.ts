import type { CaptionSettings } from '../../captions/settings';
import { recordThumbnail } from '../../db/requests';
import { assetKeys } from '../../media/assets';
import { telegram, videoPicture, type TgMessage } from '../telegram';
import type { Env } from '../../types';

/** What the ✏️ Edit card's picture is drawn on: the stored thumbnail and the frame it stands for. */
export interface EditPicture {
  width?: number;
  height?: number;
}

/**
 * Keep the thumbnail Telegram made for the video just delivered, so the ✏️ Edit
 * card can draw on it. Stored in R2 (the row in D1 only points at it) and
 * best-effort: a card without a picture still works.
 */
export async function keepThumbnail(env: Env, assetJobId: string, sent: TgMessage): Promise<EditPicture | null> {
  const { thumb, width, height } = videoPicture(sent);
  if (!thumb) return null;

  try {
    const image = await telegram(env.TELEGRAM_BOT_TOKEN).download(thumb);
    const key = assetKeys(assetJobId).thumb;
    await env.MEDIA.put(key, image, { httpMetadata: { contentType: 'image/jpeg' } });
    await recordThumbnail(env, assetJobId, key, width, height);
    return { width, height };
  } catch (err) {
    console.error('[edit] could not keep the thumbnail:', err);
    return null;
  }
}

/** The ✏️ card's picture: sample captions in `settings` on the stored thumbnail. Null on any failure. */
export async function drawEditPicture(
  env: Env,
  assetJobId: string,
  picture: EditPicture,
  settings: CaptionSettings,
): Promise<Uint8Array | null> {
  try {
    const object = await env.MEDIA.get(assetKeys(assetJobId).thumb);
    if (!object) return null;
    // Loaded on use: the rasteriser's wasm is only needed when a card is drawn.
    const { renderMockup } = await import('../../captions/mockup');
    return await renderMockup({ settings, image: await object.arrayBuffer(), width: picture.width, height: picture.height });
  } catch (err) {
    console.error('[edit] could not draw the card picture:', err);
    return null;
  }
}
