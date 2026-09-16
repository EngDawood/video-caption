import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { ApiJobError, jobStatus, submitJob } from '../api/jobs';
import { signedOutputUrl } from '../api/output';
import { ALL_FIELDS, MENUS } from '../captions/settings';
import { assetKeys } from '../media/assets';
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
    'Only the fields that should differ from the deployed defaults. review and preview must be omitted or "off" — they pause on a Telegram card that does not exist here.',
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
        'Use this when the user wants a video from a TikTok, Instagram, YouTube, X, Facebook or Threads post transcribed, translated and re-delivered with the translated captions burned in. Starts a new paid job on every call, so do not call it again to check on a job — use job_status for that. Requires an https callbackUrl that receives progress and the finished video; a direct file link is not accepted as sourceUrl.',
      inputSchema: z.object({
        sourceUrl: z.url({ protocol: /^https?$/ }).describe('Public post URL on a supported platform, not a direct media file link'),
        callbackUrl: z.url({ protocol: /^https$/, error: 'must be an https:// URL' }).describe('https:// endpoint that receives progress and completion webhooks'),
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
        'Use this when the user asks whether a caption job queued with submit_job has finished or failed. Returns the job state only; once it reports complete, call get_output for the video.',
      inputSchema: z.object({ jobId }),
      outputSchema: z.object({
        jobId: z.string(),
        status: z
          .string()
          .describe('queued, running, paused, waiting, waitingForPause, complete, errored, terminated or unknown'),
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
      title: 'Get a captioned video link',
      description:
        "Use this when a job's status is complete and the user wants the captioned video. Returns a download URL rather than the MP4 itself, which is too large to return inline; ready is false until the video exists. The URL is signed and opens directly in a browser for 24 hours — share it with the user as a link.",
      inputSchema: z.object({ jobId }),
      outputSchema: z.object({
        jobId: z.string(),
        ready: z.boolean().describe('Whether the captioned video can be downloaded yet'),
        url: z.string().describe('Signed MP4 download link, valid for 24 hours'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: {
        'openai/toolInvocation/invoking': 'Looking up the captioned video…',
        'openai/toolInvocation/invoked': 'Found the captioned video link',
      },
    },
    async ({ jobId }) => {
      const head = await env.MEDIA.head(assetKeys(jobId).output);
      return result({ jobId, ready: head !== null, url: await signedOutputUrl(env, jobId) });
    },
  );

  return server;
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return createMcpHandler(() => createServer(env))(request, env, ctx);
}
