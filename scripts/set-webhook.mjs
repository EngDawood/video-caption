#!/usr/bin/env node
/**
 * Point the Telegram bot at the deployed Worker.
 *
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
 *     node scripts/set-webhook.mjs https://video-caption.<subdomain>.workers.dev
 *
 * The secret must match the TELEGRAM_WEBHOOK_SECRET secret set on the Worker —
 * Telegram sends it back in the X-Telegram-Bot-Api-Secret-Token header.
 */

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const base = process.argv[2];

if (!token || !secret || !base) {
  console.error('usage: TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… node scripts/set-webhook.mjs <worker-url>');
  process.exit(1);
}

const url = `${base.replace(/\/$/, '')}/telegram/webhook`;

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url,
    secret_token: secret,
    // callback_query is required or the /settings buttons silently do nothing.
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  }),
});

const body = await res.json();
console.log(JSON.stringify(body, null, 2));
if (!body.ok) process.exit(1);
console.log(`\nwebhook set to ${url}`);

// The ☰ command menu lives in src/index.ts (COMMANDS), so it is published by
// the Worker rather than restated here. Same secret guards the endpoint.
const commandsUrl = `${base.replace(/\/$/, '')}/telegram/commands?secret=${encodeURIComponent(secret)}`;
const commands = await fetch(commandsUrl, { method: 'POST' });
const commandsBody = await commands.json().catch(() => ({ ok: false, error: `HTTP ${commands.status}` }));

if (!commandsBody.ok) {
  console.error(`\ncommand menu NOT published: ${JSON.stringify(commandsBody)}`);
  process.exit(1);
}
console.log(`command menu published for scopes: ${Object.keys(commandsBody.scopes).join(', ')}`);
