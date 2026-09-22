import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { ApiJobError, jobStatus, submitJob } from '../api/jobs';
import { signedOutputUrl } from '../api/output';
import { cancelJob, fixScript, restyleJob } from '../api/reruns';
import { ALL_FIELDS, MENUS } from '../captions/settings';
import { buildSrt } from '../bot/edit/script';
import { assetJobIdOf, assetKeys, loadCues, loadPostText } from '../media/assets';
import type { Env } from '../types';

// Built from MENUS so tools/list advertises the same option values submitJob validates against.
const settingsSchema = z
  .object(
    Object.fromEntries(
      ALL_FIELDS.map((field) => {
        const { label, options } = MENUS[field];
        const values = options.map((o) => o.value) as [string, ...string[]];
        return [field, z.enum(values).optional().describe(`${label}: ${options.map((o) => `${o.value} (${o.label})`).join(', ')}`)];
      }),
    ),
  )
  .describe(
    'Only the fields that should differ from the bot owner\'s saved settings (or the deployed defaults when none are configured). review and preview must be omitted or "off" — they pause on a Telegram card that does not exist here.',
  );

const jobId = z.string().min(1).max(128).describe('The jobId returned by submit_job, restyle_job or fix_script');

function result<T extends Record<string, unknown>>(structuredContent: T) {
  return { structuredContent, content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }] };
}

function failure(err: unknown) {
  if (!(err instanceof ApiJobError)) console.error('[mcp] tool call failed:', err);
  const message = err instanceof ApiJobError ? err.message : 'unexpected error';
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function createServer(env: Env): McpServer {
  const server = new McpServer({ name: 'video-caption', version: '1.0.0' });

  server.registerTool(
    'submit_job',
    {
      title: 'Caption a social video',
      description:
        'Use this when the user wants a video from a TikTok, Instagram, YouTube, X, Facebook or Threads post transcribed, translated and re-delivered with the translated captions burned in. Starts a new paid job on every call, so do not call it again to check on a job — poll job_status for progress instead. A direct file link is not accepted as sourceUrl.',
      inputSchema: z.object({
        sourceUrl: z.url({ protocol: /^https?$/ }).describe('Public post URL on a supported platform, not a direct media file link'),
        callbackUrl: z
          .url({ protocol: /^https$/, error: 'must be an https:// URL' })
          .optional()
          .describe('Optional https:// endpoint that also receives progress and completion webhooks. Omit it unless the user gives one.'),
        idempotencyKey: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'A fresh random string per user request. Sending the same key again returns the job it already started instead of starting a second paid one; use a new key to retry a failed job.',
          ),
        settings: settingsSchema.optional(),
      }),
      outputSchema: z.object({ jobId: z.string().describe('Pass to job_status and get_output') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: {
        'openai/toolInvocation/invoking': 'Queuing the caption job…',
        'openai/toolInvocation/invoked': 'Caption job queued',
      },
    },
    async ({ sourceUrl, callbackUrl, idempotencyKey, settings }) => {
      try {
        return result({ ...(await submitJob(env, { sourceUrl, callbackUrl, idempotencyKey, settings })) });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'job_status',
    {
      title: 'Check a caption job',
      description:
        'Use this when the user asks how a caption job queued with submit_job is going, or whether it has finished or failed. Returns the state and the stage it is at; once it reports complete, call get_output for the video and its script.',
      inputSchema: z.object({ jobId }),
      outputSchema: z.object({
        jobId: z.string(),
        status: z
          .string()
          .describe('queued, running, paused, waiting, waitingForPause, complete, errored, terminated or unknown'),
        progress: z
          .string()
          .optional()
          .describe('The latest stage, e.g. "⏳ Transcribing… (2/5)"; can lag a few seconds behind the job'),
        error: z.string().optional().describe('Why the job failed, when status is errored'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: {
        'openai/toolInvocation/invoking': 'Checking the caption job…',
        'openai/toolInvocation/invoked': 'Checked the caption job',
      },
    },
    async ({ jobId }) => {
      try {
        return result({ ...(await jobStatus(env, jobId)) });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'get_output',
    {
      title: 'Get a captioned video and its script',
      description:
        "Use this when a job's status is complete and the user wants the captioned video. After restyle_job or fix_script, pass the jobId that tool returned. Returns a download URL rather than the MP4 itself, which is too large to return inline; ready is false until the video exists. The URL is signed and opens directly in a browser for 24 hours — share it with the user as a link. Also returns the script that was burned in, as SRT with each cue's original line (🗣) above its translation (💬); show it when the user wants to read or check the captions. When available, also returns postText: a ready-to-paste description for publishing the video on Facebook, Instagram or TikTok, one per language — offer it with the link.",
      inputSchema: z.object({ jobId }),
      outputSchema: z.object({
        jobId: z.string(),
        ready: z.boolean().describe('Whether this job has finished and its video can be downloaded'),
        url: z.string().describe('Signed MP4 download link, valid for 24 hours'),
        script: z
          .string()
          .optional()
          .describe('The captions as SRT, original line above translation; absent once the job has expired'),
        postText: z
          .record(z.string(), z.string())
          .optional()
          .describe('Post text for publishing the video, keyed by language code (e.g. ar, en); absent when none could be written'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: {
        'openai/toolInvocation/invoking': 'Looking up the captioned video…',
        'openai/toolInvocation/invoked': 'Found the captioned video link',
      },
    },
    async ({ jobId }) => {
      // A re-run's files live under the job it re-burns.
      const assetJobId = assetJobIdOf(jobId);
      const [head, cues, post, run] = await Promise.all([
        env.MEDIA.head(assetKeys(assetJobId).output),
        loadCues(env, assetJobId),
        loadPostText(env, assetJobId),
        env.CAPTION_WORKFLOW.get(jobId)
          .then((instance) => instance.status())
          .catch(() => null),
      ]);
      const script = cues && cues.segments.length > 0 ? buildSrt(cues) : undefined;
      return result({
        jobId,
        // The output object alone is not enough: a re-run overwrites the
        // previous burn in place, so it exists long before this run is done.
        // An instance past Workflows' retention reads as null, not complete.
        ready: head !== null && (run === null || run.status === 'complete'),
        url: await signedOutputUrl(env, jobId),
        script,
        postText: post ?? undefined,
      });
    },
  );

  server.registerTool(
    'cancel_job',
    {
      title: 'Stop a caption job',
      description:
        'Use this when the user wants to stop a caption job that is still queued or running. A first run is stopped and its files deleted; a restyle or fix run is stopped and the previously delivered video kept. Does nothing to a job that has already finished.',
      inputSchema: z.object({ jobId }),
      outputSchema: z.object({
        jobId: z.string(),
        cancelled: z.boolean().describe('False when the job had already finished, failed or been stopped'),
        status: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: {
        'openai/toolInvocation/invoking': 'Stopping the caption job…',
        'openai/toolInvocation/invoked': 'Caption job stopped',
      },
    },
    async ({ jobId }) => {
      try {
        return result({ ...(await cancelJob(env, jobId)) });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'restyle_job',
    {
      title: 'Change how a captioned video looks',
      description:
        "Use this when the user wants a finished video's captions changed — font, size, colour, position, or the target language or translator. Re-burns the same video at the cheapest depth that serves the change (styling needs no new transcription) and replaces the previous download. Starts a paid run and returns a new jobId: poll job_status with it, then call get_output with it.",
      inputSchema: z.object({
        jobId,
        settings: settingsSchema.describe(
          'Only the fields to change; everything else keeps what the video was made with. review and preview must be omitted or "off".',
        ),
      }),
      outputSchema: z.object({
        jobId: z.string().describe('The re-run, for job_status and get_output'),
        mode: z.string().describe('restyle (one encode), retranslate, or retranscribe'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: {
        'openai/toolInvocation/invoking': 'Queuing the re-burn…',
        'openai/toolInvocation/invoked': 'Re-burn queued',
      },
    },
    async ({ jobId, settings }) => {
      try {
        return result({ ...(await restyleJob(env, jobId, settings)) });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'fix_script',
    {
      title: 'Correct caption lines',
      description:
        'Use this when the user wants specific caption lines in a finished video reworded or removed. Address each line by its start timestamp from the script get_output returned. Saves the corrections and re-burns the video with its current look, replacing the previous download. Starts a paid run and returns a new jobId: poll job_status with it, then call get_output with it.',
      inputSchema: z.object({
        jobId,
        corrections: z
          .array(
            z.object({
              start: z.string().describe("The line's start time exactly as the script shows it, e.g. 00:00:12,400"),
              text: z.string().max(500).optional().describe('The corrected caption, in the language that is burned in'),
              remove: z.boolean().optional().describe('True to delete the line instead'),
            }),
          )
          .min(1)
          .max(200),
      }),
      outputSchema: z.object({
        jobId: z.string().describe('The re-run, for job_status and get_output'),
        mode: z.string(),
        updated: z.number().describe('Lines reworded'),
        deleted: z.number().describe('Lines removed'),
        missed: z.array(z.string()).describe('Timestamps that matched no line and were skipped'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: {
        'openai/toolInvocation/invoking': 'Saving the corrections…',
        'openai/toolInvocation/invoked': 'Corrections saved; re-burn queued',
      },
    },
    async ({ jobId, corrections }) => {
      try {
        return result({ ...(await fixScript(env, jobId, corrections)) });
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return createMcpHandler(() => createServer(env))(request, env, ctx);
}
