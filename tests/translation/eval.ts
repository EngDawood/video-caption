/**
 * Translation quality eval: runs the production translation path
 * (`translateWith`, so grouping, context, script checks and leak repair all
 * apply) over the sample scripts with each candidate model, then scores it.
 *
 *   npm run eval:translate -- --models=llama70b,kimi --samples=script-6,script-8 --judge=kimi
 *
 * Three kinds of evidence, strongest first:
 *  - checks: the known regressions in `samples.ts`, pass or fail;
 *  - judge: a stronger model scores every unit 1–5 for meaning and tone;
 *  - the side-by-side report, for a human to read.
 *
 * Needs real keys (from the environment or .dev.vars): CLOUDFLARE_ACCOUNT_ID
 * and CLOUDFLARE_API_TOKEN with Workers AI permission for the `@cf/` models,
 * NVIDIA_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY for the rest. Results go to
 * tests/translation/results/<timestamp>/, which is gitignored.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { TRANSLATORS } from '../../src/captions/settings';
import { groupForTranslation, translateWith } from '../../src/pipeline/translate';
import type { TranslatorModel } from '../../src/pipeline/translators';
import type { Env, Segment } from '../../src/types';
import { SAMPLES, type Check, type Sample } from './samples';
import { parseSrt } from './srt';

// ── Candidates ─────────────────────────────────────────────────────────────

/**
 * Production translators (the NVIDIA chat ones included, on their real
 * transport), plus chat models not on the menu yet. A `provider:`
 * prefix on `model` routes it through `fakeEnv` to that provider's
 * OpenAI-compatible endpoint, with the production chat prompt unchanged.
 */
const CANDIDATES: Record<string, TranslatorModel & { label: string }> = {
  ...TRANSLATORS,
  // Google Translate's free web endpoint, keyless and unofficial: a baseline
  // to beat, not a production option. Plain MT, so no context and no repair.
  google: { label: 'Google Translate (free web endpoint)', model: 'google:gtx', kind: 'mt' },
  mistral: { label: 'Mistral Medium (Mistral)', model: 'mistral:mistral-medium-latest', kind: 'chat' },
  gptoss: { label: 'GPT-OSS 120B (Groq)', model: 'groq:openai/gpt-oss-120b', kind: 'chat' },
  qwen: { label: 'Qwen 3.8 27B (Groq)', model: 'groq:qwen/qwen3.8-27b', kind: 'chat' },
};

const PROVIDERS: Record<string, { base: string; key: string }> = {
  nvidia: { base: 'https://integrate.api.nvidia.com/v1', key: 'NVIDIA_API_KEY' },
  mistral: { base: 'https://api.mistral.ai/v1', key: 'MISTRAL_API_KEY' },
  groq: { base: 'https://api.groq.com/openai/v1', key: 'GROQ_API_KEY' },
};

// ── Transport ──────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with backoff on rate limits and server errors, which are not the model's fault. */
async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${url} → ${res.status}: ${text.slice(0, 300)}`);
  }
}

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Reasoning models sometimes leave their thinking in the answer. */
const stripThinking = (text: string): string => text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

async function chat(model: string, messages: unknown, temperature: number): Promise<string> {
  const [provider, id] = [model.slice(0, model.indexOf(':')), model.slice(model.indexOf(':') + 1)];
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider in ${model}`);
  const data = await post(
    `${p.base}/chat/completions`,
    { authorization: `Bearer ${need(p.key)}` },
    { model: id, messages, temperature, max_tokens: 8192 },
  );
  return stripThinking(String(data?.choices?.[0]?.message?.content ?? ''));
}

/** Google Translate's keyless endpoint; its answer is the translated sentences in order. */
async function google(text: string, source: string, target: string): Promise<string> {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t' +
    `&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(text)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const data: any = await res.json();
      return (data?.[0] ?? []).map((part: any[]) => part?.[0] ?? '').join('');
    }
    if (res.status === 429 && attempt < 3) {
      await sleep(3000 * 2 ** attempt);
      continue;
    }
    throw new Error(`google translate → ${res.status}`);
  }
}

/** The slice of `Env` translation touches, backed by real APIs. */
function fakeEnv(): Env {
  const AI = {
    async run(model: string, input: any) {
      if (model === 'google:gtx') return { translated_text: await google(input.text, input.source_lang, input.target_lang) };
      if (!model.startsWith('@cf/')) return { response: await chat(model, input.messages, input.temperature ?? 0.2) };
      const data = await post(
        `https://api.cloudflare.com/client/v4/accounts/${need('CLOUDFLARE_ACCOUNT_ID')}/ai/run/${model}`,
        { authorization: `Bearer ${need('CLOUDFLARE_API_TOKEN')}` },
        input,
      );
      // The REST API can answer a chat model in OpenAI's `choices` shape; the
      // Worker binding's documented shape is `{ response }`, which is what
      // production reads.
      const content = data.result?.choices?.[0]?.message?.content;
      return typeof content === 'string' ? { response: content } : data.result;
    },
  };
  return { AI, NVIDIA_API_KEY: process.env.NVIDIA_API_KEY } as unknown as Env;
}

// ── Judge ──────────────────────────────────────────────────────────────────

interface Verdict {
  score: number;
  issue: string;
  note: string;
}

async function judge(judgeModel: string, sample: Sample, units: Segment[], out: Segment[]): Promise<Verdict[]> {
  const lines = units.map((u, i) => `[${i + 1}] SOURCE: ${u.text}\n[${i + 1}] TRANSLATION: ${out[i]?.text ?? ''}`);
  const system =
    'You are a strict reviewer of Arabic video subtitles translated from another language. ' +
    'Judge each numbered TRANSLATION against its SOURCE, reading the whole script for context. ' +
    'Score 5 = accurate and natural, as a professional subtitler would write it; 4 = minor wording issue; ' +
    '3 = understandable but clumsy or loses tone; 2 = a real meaning error; 1 = wrong or untranslated. ' +
    'Meaning errors matter most: idioms taken literally, pronouns resolved wrong, slang or insults ' +
    'softened or misread, jokes that no longer work. The source is speech-to-text output and may itself be ' +
    'garbled; do not blame the translator for that, but do note it. ' +
    'Reply with ONLY JSON: {"units":[{"i":1,"score":5,"issue":"none|meaning|tone|omission|addition|fluency|untranslated|source","note":"short, in English"}]}';
  const user =
    `SCRIPT: ${sample.title}\n` +
    (sample.notes ? `REVIEWER NOTES: ${sample.notes}\n` : '') +
    `\n${lines.join('\n\n')}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await chat(judgeModel, [{ role: 'system', content: system }, { role: 'user', content: user }], 0);
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      const byIndex = new Map<number, Verdict>(json.units.map((v: any) => [Number(v.i), v]));
      return units.map((_, i) => byIndex.get(i + 1) ?? { score: 0, issue: 'unjudged', note: '' });
    } catch (err) {
      if (attempt === 1) console.error(`judge failed on ${sample.file}:`, err);
    }
  }
  return units.map(() => ({ score: 0, issue: 'unjudged', note: '' }));
}

// ── Checks ─────────────────────────────────────────────────────────────────

interface CheckResult extends Check {
  pass: boolean;
  got: string;
}

function runChecks(sample: Sample, units: Segment[], out: Segment[]): CheckResult[] {
  return sample.checks.flatMap((check) => {
    const hits = units.flatMap((u, i) => (u.text.includes(check.source) ? [out[i]?.text ?? ''] : []));
    if (!hits.length) return [{ ...check, pass: false, got: '(source phrase not found in any unit)' }];
    return hits.map((got) => ({
      ...check,
      got,
      pass: (!check.must || check.must.test(got)) && (!check.mustNot || !check.mustNot.test(got)),
    }));
  });
}

// ── Run ────────────────────────────────────────────────────────────────────

interface Run {
  model: string;
  sample: string;
  units: Segment[];
  out: Segment[];
  verdicts: Verdict[];
  checks: CheckResult[];
  seconds: number;
  logs: string[];
  error?: string;
}

const logScope = new AsyncLocalStorage<string[]>();
for (const level of ['log', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const sink = logScope.getStore();
    if (sink) sink.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' '));
    else original(...args);
  };
}

async function runOne(env: Env, modelId: string, sample: Sample, target: string, judgeModel: string | null): Promise<Run> {
  const segments = parseSrt(readFileSync(new URL(`./samples/${sample.file}`, import.meta.url), 'utf8'));
  // Same grouping as production, so units line up with what was translated.
  const units = groupForTranslation(segments);
  const logs: string[] = [];
  const started = Date.now();
  try {
    const out = await logScope.run(logs, () => translateWith(env, segments, sample.source, target, CANDIDATES[modelId]));
    const seconds = (Date.now() - started) / 1000;
    const verdicts = judgeModel ? await judge(judgeModel, sample, units, out) : [];
    return { model: modelId, sample: sample.file, units, out, verdicts, checks: runChecks(sample, units, out), seconds, logs };
  } catch (err) {
    return { model: modelId, sample: sample.file, units, out: [], verdicts: [], checks: [], seconds: 0, logs, error: String(err) };
  }
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function report(runs: Run[], models: string[], samples: Sample[], judgeModel: string | null): string {
  const md: string[] = [`# Translation eval\n`, `Judge: ${judgeModel ?? 'none'} · Target: Arabic · ${new Date().toISOString()}\n`];

  md.push('## Summary\n', '| Model | Checks passed | Mean score | Units ≤ 2 | Retries/repairs logged | Time (s) |', '|---|---|---|---|---|---|');
  for (const m of models) {
    const rs = runs.filter((r) => r.model === m);
    const checks = rs.flatMap((r) => r.checks);
    const scores = rs.flatMap((r) => r.verdicts.map((v) => v.score)).filter((s) => s > 0);
    const errors = rs.filter((r) => r.error).length;
    md.push(
      `| ${m}${errors ? ` (${errors} failed)` : ''} | ${checks.filter((c) => c.pass).length}/${checks.length} | ` +
        `${mean(scores).toFixed(2)} | ${scores.filter((s) => s <= 2).length} | ` +
        `${rs.reduce((n, r) => n + r.logs.length, 0)} | ${rs.reduce((n, r) => n + r.seconds, 0).toFixed(0)} |`,
    );
  }

  md.push('\n## Failed checks\n');
  for (const r of runs) for (const c of r.checks.filter((c) => !c.pass)) md.push(`- **${r.model}** · ${r.sample} · "${c.source}": ${c.why}. Got: ${c.got}`);

  for (const sample of samples) {
    md.push(`\n## ${sample.file}: ${sample.title}\n`);
    if (sample.notes) md.push(`> ${sample.notes}\n`);
    const rs = models.map((m) => runs.find((r) => r.model === m && r.sample === sample.file)!);
    for (const r of rs) if (r.error) md.push(`**${r.model} failed:** ${r.error}\n`);
    const units = rs[0].units;
    units.forEach((u, i) => {
      md.push(`**[${i + 1}]** ${esc(u.text)}\n`);
      md.push('| Model | Translation | Score | Note |', '|---|---|---|---|');
      for (const r of rs) {
        const v = r.verdicts[i];
        md.push(`| ${r.model} | ${esc(r.out[i]?.text ?? '')} | ${v?.score || ''} | ${esc(v ? `${v.issue === 'none' ? '' : v.issue + ': '}${v.note}` : '')} |`);
      }
      md.push('');
    });
    for (const r of rs) if (r.logs.length) md.push(`<details><summary>${r.model} log</summary>\n\n${r.logs.map((l) => `- ${esc(l)}`).join('\n')}\n</details>\n`);
  }
  return md.join('\n');
}

async function main() {
  const models = (arg('models') ?? 'llama70b,riva,google,kimi,glm,deepseek,mistral,gptoss').split(',');
  for (const m of models) if (!CANDIDATES[m]) throw new Error(`unknown model ${m}; one of ${Object.keys(CANDIDATES).join(', ')}`);
  const wanted = arg('samples')?.split(',');
  const samples = SAMPLES.filter((s) => !wanted || wanted.some((w) => s.file.startsWith(w)));
  const judgeArg = arg('judge') ?? 'kimi';
  const judgeCandidate = CANDIDATES[judgeArg];
  const judgeModel =
    judgeArg === 'none'
      ? null
      : judgeCandidate?.kind === 'nvidia-chat'
        ? `nvidia:${judgeCandidate.model}`
        : (judgeCandidate?.model ?? judgeArg);
  if (judgeModel && !judgeModel.includes(':')) throw new Error('the judge must be a provider model, e.g. kimi or mistral:mistral-medium-latest');
  const target = arg('target') ?? 'ar';

  const env = fakeEnv();
  const runs: Run[] = [];
  // Models in parallel (they hit different providers), samples in turn within each.
  await Promise.all(
    models.map(async (m) => {
      for (const sample of samples) {
        const run = await runOne(env, m, sample, target, judgeModel);
        runs.push(run);
        const passed = run.checks.filter((c) => c.pass).length;
        console.log(`${m.padEnd(9)} ${sample.file}  ${run.error ? 'FAILED ' + run.error.slice(0, 120) : `checks ${passed}/${run.checks.length}, ${run.seconds.toFixed(0)}s`}`);
      }
    }),
  );

  const dir = new URL(`./results/${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('report.md', dir), report(runs, models, samples, judgeModel));
  writeFileSync(new URL('results.json', dir), JSON.stringify(runs, (k, v) => (v instanceof RegExp ? v.source : v), 2));
  console.log(`\nReport: ${new URL('report.md', dir).pathname}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
