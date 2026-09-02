import { Container } from '@cloudflare/containers';
import type { Env } from './types';

/**
 * The ffmpeg worker. One instance per job (routed with getByName(jobId)), so
 * files written by one request are still on disk for the next one.
 */
export class FfmpegContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];

  // Safety net only. The workflow calls stop() when a job ends, so this just
  // bounds the damage if a run dies before its cleanup step. Keep it short:
  // an awake container bills for its provisioned memory and disk the whole
  // time, so idle minutes cost the same as working ones.
  sleepAfter = '2m';

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
