import { Container } from '@cloudflare/containers';
import type { Env } from '../types';

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

  // No fetch override: the base class's containerFetch already starts the
  // container when it is not healthy. Wrapping that start in
  // blockConcurrencyWhile, as this class once did, holds the input gate for
  // the whole cold boot — and the runtime cancels a gate held past ~30s and
  // resets the Durable Object, failing the step on any slow start.

  override onError(error: unknown) {
    console.error('[container] error', error);
  }
}
