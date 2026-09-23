import { NonRetryableError } from 'cloudflare:workflows';
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import { signedOutputUrl } from '../api/output';
import { assetKeys } from '../media/assets';
import { telegram } from '../bot/telegram';
import type { Env } from '../types';
import { execute, targetLabel, type Target } from './composio';

/**
 * Posting one delivered video to one social account through Composio.
 *
 * A Workflow rather than the callback that queued it, because every platform
 * downloads the video itself and Instagram then takes a minute or two to
 * process it — far longer than a webhook's `waitUntil` may run.
 *
 * Retries are per platform and deliberately uneven: a step that only prepares
 * (an Instagram container, a LinkedIn upload) is safe to repeat, but a step
 * that publishes is retried only where the platform itself refuses a repeat.
 * A post that went out but whose answer was lost must not go out twice.
 */
export interface PublishJob {
  /** Whose R2 prefix holds `output.mp4` — the latest burn of that video. */
  assetJobId: string;
  target: Target;
  caption: string;
  chatId: number;
  /** The confirmation card, which becomes the status line. */
  statusMessageId: number;
  /** Facebook only — an unpublished post instead of a live one. Ignored elsewhere. */
  draft?: boolean;
}

const PREPARE: WorkflowStepConfig = {
  retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
  timeout: '8 minutes',
};

const ONCE: WorkflowStepConfig = { retries: { limit: 0, delay: '1 second' }, timeout: '8 minutes' };

export class PublishWorkflow extends WorkflowEntrypoint<Env, PublishJob> {
  async run(event: WorkflowEvent<PublishJob>, step: WorkflowStep) {
    const { assetJobId, target, caption, chatId, statusMessageId } = event.payload;
    // Only Facebook's post call can honour it; treated as false everywhere else.
    const draft = Boolean(event.payload.draft) && target.platform === 'facebook';
    const env = this.env;
    const tg = telegram(env.TELEGRAM_BOT_TOKEN);
    const label = targetLabel(target);

    try {
      // Every platform fetches the video from this link while it processes it;
      // it is good for a day.
      const videoUrl = await step.do('link', async () => {
        if (!(await env.MEDIA.head(assetKeys(assetJobId).output))) {
          throw new NonRetryableError('that video is no longer stored — caption it again to post it');
        }
        return signedOutputUrl(env, assetJobId);
      });

      const link = await this.post(step, target, videoUrl, caption, draft);

      await step.do('notify', async () => {
        const text = draft
          ? `📝 Saved as a draft on ${label}. Publish it from the Page's Publishing Tools when you're ready.`
          : `✅ Posted to ${label}${link ? `\n${link}` : ''}`;
        await tg.editMessageText(chatId, statusMessageId, text);
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[publish] ${event.instanceId} failed:`, err);
      await step.do('notify-failure', async () => {
        await tg.editMessageText(chatId, statusMessageId, `⚠️ Could not post to ${label}.\n\n${reason.slice(0, 500)}`);
      });
    }
  }

  /**
   * Post it, and return a link to the post when the platform gives one and it
   * is actually live — a draft has nothing to link to yet.
   */
  private async post(
    step: WorkflowStep,
    target: Target,
    videoUrl: string,
    caption: string,
    draft: boolean,
  ): Promise<string | null> {
    const env = this.env;

    switch (target.platform) {
      case 'instagram': {
        // An unpublished container simply expires, so repeating this is free.
        const creationId = await step.do('create-container', PREPARE, async () => {
          const container = await execute<{ id: string }>(env, target, 'INSTAGRAM_POST_IG_USER_MEDIA', {
            ig_user_id: target.targetId,
            video_url: videoUrl,
            media_type: 'REELS',
            share_to_feed: true,
            caption,
          });
          return container.id;
        });

        // Composio polls the container until Meta has finished with it. Meta
        // refuses to publish one container twice, so this one retry is safe.
        const mediaId = await step.do(
          'publish',
          { retries: { limit: 1, delay: '30 seconds' }, timeout: '8 minutes' },
          async () => {
            const published = await execute<{ id: string }>(env, target, 'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH', {
              ig_user_id: target.targetId,
              creation_id: creationId,
              max_wait_seconds: 300,
              poll_interval_seconds: 5,
            });
            return published.id;
          },
        );

        // Only for the link in the reply: the post is live whether or not this works.
        return step.do('permalink', async () => {
          const media = await execute<{ permalink?: string }>(env, target, 'INSTAGRAM_GET_IG_MEDIA', {
            ig_media_id: mediaId,
            fields: 'permalink',
          }).catch(() => null);
          return media?.permalink ?? null;
        });
      }

      case 'facebook': {
        // One call uploads and, unless this is a draft, publishes — so it is
        // never repeated either way: a draft left as `published: false` is
        // exactly as unrepeatable as a live post would be.
        const videoId = await step.do('post', ONCE, async () => {
          const video = await execute<{ id: string }>(env, target, 'FACEBOOK_CREATE_VIDEO_POST', {
            page_id: target.targetId,
            file_url: videoUrl,
            description: caption,
            published: !draft,
          });
          return video.id;
        });
        return draft ? null : `https://www.facebook.com/watch/?v=${videoId}`;
      }

      case 'linkedin': {
        // An upload that is never posted is invisible, so this may repeat.
        const videoUrn = await step.do('upload', PREPARE, async () => {
          const upload = await execute<{ video_urn: string }>(env, target, 'LINKEDIN_UPLOAD_VIDEO', {
            video_url: videoUrl,
          });
          return upload.video_urn;
        });
        const postId = await step.do('post', ONCE, async () => {
          const post = await execute<{ post_id: string }>(env, target, 'LINKEDIN_CREATE_VIDEO_POST', {
            video_urn: videoUrn,
            // LinkedIn's own cap is 3000; the caption is already held to Instagram's 2200.
            commentary: caption,
          });
          return post.post_id;
        });
        return `https://www.linkedin.com/feed/update/${postId}`;
      }
    }
  }
}
