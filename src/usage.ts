import type { Env } from './types';

/**
 * Container usage for the current billing month, for the bot's /usage command.
 *
 * Reads containersUsageAdaptiveGroups — the dataset that bills the micro-VM
 * sandbox alongside your process, and the one behind the dashboard's usage
 * estimates. containersMetricsAdaptiveGroups measures the process only and
 * will read lower than what you are charged for.
 */

/** Included with the $5/mo Workers Paid plan. */
const INCLUDED = { memory: 25, cpu: 375, disk: 200 };
/** Overage per unit of the same measure. */
const RATES = { memory: 0.0000025 * 3600, cpu: 0.00002 * 60, disk: 0.00000007 * 3600 };
const UNITS = { memory: 'GiB-hr', cpu: 'vCPU-min', disk: 'GB-hr' };

type Metric = keyof typeof INCLUDED;

const QUERY = `
  query ContainersUsage($accountTag: String, $start: Date, $end: Date) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        containersUsageAdaptiveGroups(
          limit: 1000
          filter: { date_geq: $start, date_leq: $end }
          orderBy: [date_ASC]
        ) {
          sum { cpuTimeSec allocatedMemory allocatedDisk }
        }
      }
    }
  }`;

export async function usageReport(env: Env): Promise<string> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return '⚠️ Usage reporting needs the CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets.';
  }

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { accountTag: env.CLOUDFLARE_ACCOUNT_ID, start: iso(start), end: iso(now) },
    }),
  });

  if (!res.ok) return `❌ Analytics API returned ${res.status}.`;

  const body = (await res.json()) as any;
  if (body.errors?.length) {
    return `❌ ${body.errors.map((e: any) => e.message).join('; ')}`;
  }

  const rows = body.data?.viewer?.accounts?.[0]?.containersUsageAdaptiveGroups ?? [];
  if (rows.length === 0) return `No container usage recorded since ${iso(start)}.`;

  // allocatedMemory and allocatedDisk arrive as byte-seconds.
  const totals = rows.reduce(
    (acc: Record<Metric, number>, r: any) => ({
      cpu: acc.cpu + r.sum.cpuTimeSec / 60,
      memory: acc.memory + r.sum.allocatedMemory / 1024 ** 3 / 3600,
      disk: acc.disk + r.sum.allocatedDisk / 1e9 / 3600,
    }),
    { cpu: 0, memory: 0, disk: 0 },
  );

  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

  const lines = [`📊 Container usage — ${iso(start).slice(0, 7)} (day ${dayOfMonth}/${daysInMonth})`, ''];
  let overageCost = 0;

  for (const metric of ['memory', 'cpu', 'disk'] as Metric[]) {
    const used = totals[metric];
    const limit = INCLUDED[metric];
    const pct = (used / limit) * 100;
    const projected = (used / dayOfMonth) * daysInMonth;
    const over = Math.max(0, projected - limit);
    overageCost += over * RATES[metric];

    const filled = Math.min(12, Math.round((pct / 100) * 12));
    lines.push(
      `${metric.padEnd(6)} ${'█'.repeat(filled)}${'░'.repeat(12 - filled)} ${pct.toFixed(0)}%`,
      `  ${used.toFixed(1)} / ${limit} ${UNITS[metric]} · trending to ${projected.toFixed(0)}`,
    );
  }

  lines.push(
    '',
    overageCost > 0
      ? `⚠️ On track to exceed. Projected extra: ~$${overageCost.toFixed(2)}`
      : '✅ On track to stay within the plan.',
  );

  return lines.join('\n');
}
