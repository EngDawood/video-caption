import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { ApiJobError, jobStatus, submitJob } from '../api/jobs';
import { signedOutputUrl } from '../api/output';
import { ALL_FIELDS, MENUS } from '../captions/settings';
import { buildSrt } from '../bot/edit/script';
import { assetKeys, loadCues } from '../media/assets';
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

const jobId = z.string().min(1).max(128).describe('The jobId returned by submit_job');

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
        settings: settingsSchema.optional(),
      }),
      outputSchema: z.object({ jobId: z.string().describe('Pass to job_status and get_output') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: {
        'openai/toolInvocation/invoking': 'Queuing the caption job…',
        'openai/toolInvocation/invoked': 'Caption job queued',
      },
    },
    async ({ sourceUrl, callbackUrl, settings }) => {
      try {
        return result({ ...(await submitJob(env, { sourceUrl, callbackUrl, settings })) });
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
        "Use this when a job's status is complete and the user wants the captioned video. Returns a download URL rather than the MP4 itself, which is too large to return inline; ready is false until the video exists. The URL is signed and opens directly in a browser for 24 hours — share it with the user as a link. Also returns the script that was burned in, as SRT with each cue's original line (🗣) above its translation (💬); show it when the user wants to read or check the captions.",
      inputSchema: z.object({ jobId }),
      outputSchema: z.object({
        jobId: z.string(),
        ready: z.boolean().describe('Whether the captioned video can be downloaded yet'),
        url: z.string().describe('Signed MP4 download link, valid for 24 hours'),
        script: z
          .string()
          .optional()
          .describe('The captions as SRT, original line above translation; absent once the job has expired'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: {
        'openai/toolInvocation/invoking': 'Looking up the captioned video…',
        'openai/toolInvocation/invoked': 'Found the captioned video link',
      },
    },
    async ({ jobId }) => {
      const [head, cues] = await Promise.all([env.MEDIA.head(assetKeys(jobId).output), loadCues(env, jobId)]);
      const script = cues && cues.segments.length > 0 ? buildSrt(cues) : undefined;
      return result({ jobId, ready: head !== null, url: await signedOutputUrl(env, jobId), script });
    },
  );

  return server;
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return createMcpHandler(() => createServer(env))(request, env, ctx);
}
