import type { Env } from '../types';

/**
 * Routing through Cloudflare AI Gateway, for its logs and per-model analytics.
 *
 * `AI_GATEWAY_ID` unset means every call goes straight to its provider, as it
 * did before the gateway existed. Workers AI goes through the binding, which
 * is pre-authenticated, so the id alone is enough there. Groq and Mistral are
 * plain `fetch`es to the gateway's URL, and the gateway Cloudflare creates as
 * `default` has Authentication on, so they also need `AI_GATEWAY_TOKEN`; with
 * no token they keep calling the provider directly rather than fail with 401.
 *
 * NVIDIA is not a native gateway provider (it would need a Custom Provider set
 * up on the account), so its calls are not routed here.
 */

/** Third argument to `env.AI.run`: the gateway, or nothing. */
export function aiOptions(env: Env): AiOptions | undefined {
  return env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined;
}

/**
 * Base URL for an OpenAI-compatible provider: the gateway's endpoint for it
 * when one is configured and authenticated, else `direct`. The gateway URL
 * stands in for the provider's own base, so callers append the same path to
 * either — which is why Groq's direct base ends in `/openai/v1`.
 */
export async function providerBase(env: Env, provider: 'groq' | 'mistral', direct: string): Promise<string> {
  if (!env.AI_GATEWAY_ID || !env.AI_GATEWAY_TOKEN) return direct;
  return (await env.AI.gateway(env.AI_GATEWAY_ID).getUrl(provider)).replace(/\/$/, '');
}

/** The gateway's auth header, when the request is going through it. */
export function gatewayHeaders(env: Env): Record<string, string> {
  return env.AI_GATEWAY_ID && env.AI_GATEWAY_TOKEN ? { 'cf-aig-authorization': `Bearer ${env.AI_GATEWAY_TOKEN}` } : {};
}
