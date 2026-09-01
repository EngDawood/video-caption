import { Container } from '@cloudflare/containers';
import type { Env } from './types';

/**
 * The ffmpeg worker. One instance per job (routed with getByName(jobId)), so
 * files written by one request are still on disk for the next one.
 */
export class FfmpegContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];

  // Burning a few minutes of video takes a while and the Workflow may pause
  // between steps; keep the instance warm rather than paying a cold start and
  // losing the job directory mid-pipeline.
  sleepAfter = '10m';

  // Everything it needs is handed to it over the binding — no egress required.
  enableInternet = false;

  private booted = false;

  override async fetch(request: Request): Promise<Response> {
    await this.ctx.blockConcurrencyWhile(async () => {
      if (!this.booted) {
        await this.startAndWaitForPorts();
        this.booted = true;
      }
    });
    return super.fetch(request);
  }

  override onError(error: unknown) {
    console.error('[container] error', error);
    this.booted = false;
  }

  override onStop() {
    this.booted = false;
  }
}
