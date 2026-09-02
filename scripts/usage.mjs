#!/usr/bin/env node
/**
 * Report container usage for the current billing month against the allowances
 * included with Workers Paid, and project where the month will land.
 *
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/usage.mjs
 *
 * The token needs Account Analytics: Read. These are the same numbers the
 * dashboard shows (containersUsageAdaptiveGroups bills the micro-VM sandbox
 * alongside your process, so it runs slightly above raw process metrics).
 */

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!token || !account) {
  console.error('usage: CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/usage.mjs');
  process.exit(1);
}

// Included with the $5/mo Workers Paid plan.
const INCLUDED = { memory: 25, cpu: 375, disk: 200 };
// Overage, per unit of the same measure.
const RATES = { memory: 0.0000025 * 3600, cpu: 0.00002 * 60, disk: 0.00000007 * 3600 };

const now = new Date();
const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const iso = (d) => d.toISOString().slice(0, 10);

const query = `
  query ContainersUsage($accountTag: String, $start: Date, $end: Date) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        containersUsageAdaptiveGroups(
          limit: 1000
          filter: { date_geq: $start, date_leq: $end }
          orderBy: [date_ASC]
        ) {
          dimensions { date }
          sum { cpuTimeSec allocatedMemory allocatedDisk }
        }
      }
    }
  }`;

const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    query,
    variables: { accountTag: account, start: iso(start), end: iso(now) },
  }),
});

const body = await res.json();
if (body.errors?.length) {
  console.error('GraphQL error:', body.errors.map((e) => e.message).join('; '));
  process.exit(1);
}

const rows = body.data?.viewer?.accounts?.[0]?.containersUsageAdaptiveGroups ?? [];
if (rows.length === 0) {
  console.log(`No container usage recorded since ${iso(start)}.`);
  process.exit(0);
}

// allocatedMemory / allocatedDisk come back as byte-seconds.
const totals = rows.reduce(
  (acc, r) => ({
    cpu: acc.cpu + r.sum.cpuTimeSec / 60,
    memory: acc.memory + r.sum.allocatedMemory / 1024 ** 3 / 3600,
    disk: acc.disk + r.sum.allocatedDisk / 1e9 / 3600,
  }),
  { cpu: 0, memory: 0, disk: 0 },
);

const daysElapsed = Math.max(1, Math.round((now - start) / 86400000) + 1);
const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
const project = (used) => (used / daysElapsed) * daysInMonth;

const bar = (pct) => {
  const filled = Math.min(20, Math.round((pct / 100) * 20));
  return '█'.repeat(filled) + '░'.repeat(20 - filled);
};

const UNITS = { memory: 'GiB-hr', cpu: 'vCPU-min', disk: 'GB-hr' };

console.log(`Container usage ${iso(start)} → ${iso(now)}  (day ${daysElapsed} of ${daysInMonth})\n`);

let overage = 0;
for (const metric of ['memory', 'cpu', 'disk']) {
  const used = totals[metric];
  const limit = INCLUDED[metric];
  const pct = (used / limit) * 100;
  const projected = project(used);
  const projectedPct = (projected / limit) * 100;
  const over = Math.max(0, projected - limit);
  overage += over * RATES[metric];

  console.log(
    `${metric.padEnd(7)} ${bar(pct)} ${used.toFixed(1)} / ${limit} ${UNITS[metric]} (${pct.toFixed(0)}%)`,
  );
  console.log(
    `        projected month end: ${projected.toFixed(1)} ${UNITS[metric]} (${projectedPct.toFixed(0)}%)` +
      (over > 0 ? `  ⚠️  ${over.toFixed(1)} over` : ''),
  );
}

console.log(
  overage > 0
    ? `\n⚠️  Projected overage: about $${overage.toFixed(2)} on top of the $5 plan.`
    : '\n✅ Projected to stay within the included allowances.',
);
