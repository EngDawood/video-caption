import type { Env } from '../types';

/**
 * Composio's REST API: the social accounts connected to it, and running one of
 * its tools as one of them.
 *
 * Accounts are connected in Composio itself, never here — so a new account (or
 * a new Facebook Page on an existing login) is picked up by the 📤 button with
 * no deploy and no setting to change.
 */

const BASE = 'https://backend.composio.dev/api/v3.1';

export type Platform = 'instagram' | 'facebook' | 'linkedin';

export const PLATFORMS: Platform[] = ['instagram', 'facebook', 'linkedin'];

/** One place a video can be posted: an Instagram account, a Facebook Page, a LinkedIn profile. */
export interface Target {
  platform: Platform;
  /** Composio's connected-account id — which login a tool call runs as. */
  connectionId: string;
  /** The Composio user that connection belongs to. */
  userId: string;
  /** What the platform calls the destination: ig_user_id, or a Page id. Unused on LinkedIn. */
  targetId: string;
  /** How the button names it. */
  name: string;
}

const ICONS: Record<Platform, string> = { instagram: '📸', facebook: '📘', linkedin: '💼' };
const PLATFORM_NAMES: Record<Platform, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn' };

export const targetLabel = (t: Target) => `${ICONS[t.platform]} ${t.name}`;

/** A target as the /accounts report lists it — the platform named next to the account. */
const describeTarget = (t: Target) => `${ICONS[t.platform]} ${t.name} — ${PLATFORM_NAMES[t.platform]}`;

/**
 * What one login can post to is looked up once a day at most: it costs a
 * Composio call per connection, and a Page added to a login shows up by tomorrow.
 */
const TARGETS_TTL_SECONDS = 24 * 60 * 60;
const targetsKey = (connectionId: string) => `targets:${connectionId}`;

interface ConnectedAccount {
  id: string;
  status: string;
  user_id: string;
}

interface ExecuteResponse {
  successful: boolean;
  data: unknown;
  error: string | null;
}

type Login = Pick<Target, 'connectionId' | 'userId'>;

async function api<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!env.COMPOSIO_API_KEY) throw new Error('COMPOSIO_API_KEY is not set');
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'x-api-key': env.COMPOSIO_API_KEY, 'content-type': 'application/json', ...init.headers },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`composio ${path} → ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

/**
 * Run a Composio tool as one connected account and return its `data`.
 *
 * Composio answers 200 with `successful: false` when the tool itself failed —
 * Meta refusing a video, say — so that is thrown here like any HTTP error.
 */
export async function execute<T>(env: Env, login: Login, tool: string, args: Record<string, unknown>): Promise<T> {
  const res = await api<ExecuteResponse>(env, `/tools/execute/${tool}`, {
    method: 'POST',
    body: JSON.stringify({ connected_account_id: login.connectionId, user_id: login.userId, arguments: args }),
  });
  if (!res.successful) throw new Error(`${tool}: ${res.error ?? 'failed'}`);
  return res.data as T;
}

/** What one login can post to. A Facebook login is one target per Page it may post on. */
async function readTargets(env: Env, platform: Platform, login: Login): Promise<Target[]> {
  const base = { platform, ...login };
  switch (platform) {
    case 'instagram': {
      const me = await execute<{ id: string; username: string }>(env, login, 'INSTAGRAM_GET_USER_INFO', {
        ig_user_id: 'me',
      });
      return [{ ...base, targetId: me.id, name: `@${me.username}` }];
    }
    case 'facebook': {
      // Only Pages: Facebook's API cannot post to a personal profile.
      const pages = await execute<{ data: { id: string; name: string; tasks?: string[] }[] }>(
        env,
        login,
        'FACEBOOK_LIST_MANAGED_PAGES',
        { fields: 'id,name,tasks', limit: 50 },
      );
      return pages.data
        .filter((p) => !p.tasks || p.tasks.includes('CREATE_CONTENT') || p.tasks.includes('MANAGE'))
        .map((p) => ({ ...base, targetId: p.id, name: p.name.trim() }));
    }
    case 'linkedin': {
      const me = await execute<{ id: string; localizedFirstName?: string; localizedLastName?: string }>(
        env,
        login,
        'LINKEDIN_GET_MY_INFO',
        {},
      );
      const name = [me.localizedFirstName, me.localizedLastName].filter(Boolean).join(' ');
      return [{ ...base, targetId: me.id, name: name || 'LinkedIn profile' }];
    }
  }
}

/**
 * Every place a video can be posted, across every active connection in Composio.
 *
 * One listing per platform rather than one call with every toolkit in it, so a
 * platform Composio cannot list costs that platform only. A login that cannot
 * be read is left out rather than failing the whole list.
 */
export async function publishTargets(env: Env): Promise<Target[]> {
  const perPlatform = await Promise.all(
    PLATFORMS.map(async (platform) => {
      const listed = await api<{ items: ConnectedAccount[] }>(
        env,
        `/connected_accounts?toolkit_slugs=${platform}&statuses=ACTIVE&limit=20`,
      ).catch((err) => {
        console.error(`[composio] could not list ${platform} connections:`, err);
        return { items: [] };
      });

      const perLogin = await Promise.all(
        listed.items
          .filter((item) => item.status === 'ACTIVE')
          .map(async (item) => {
            const cached = await env.CAPTION_SETTINGS?.get<Target[]>(targetsKey(item.id), 'json').catch(() => null);
            if (cached) return cached;
            try {
              const targets = await readTargets(env, platform, { connectionId: item.id, userId: item.user_id });
              await env.CAPTION_SETTINGS?.put(targetsKey(item.id), JSON.stringify(targets), {
                expirationTtl: TARGETS_TTL_SECONDS,
              }).catch(() => {});
              return targets;
            } catch (err) {
              console.error(`[composio] could not read ${platform} connection ${item.id}:`, err);
              return [];
            }
          }),
      );
      return perLogin.flat();
    }),
  );
  return perPlatform.flat();
}

/** The /accounts command: every place 📤 Share can currently post to. */
export async function accountsReport(env: Env): Promise<string> {
  const targets = await publishTargets(env);
  if (targets.length === 0) {
    return '⚠️ No Instagram, Facebook or LinkedIn account is connected in Composio.';
  }
  return ['📤 Connected accounts', '', ...targets.map(describeTarget)].join('\n');
}
