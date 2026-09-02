'use strict';

/**
 * Minimal ffmpeg job service.
 *
 * One container instance handles one job at a time — the Worker routes with
 * getByName(jobId), so every request for a given job lands on this instance and
 * can rely on files left on local disk by the previous call.
 *
 *   POST   /job/video?audio=skip  raw video bytes -> { duration, width, height, hasAudio }
 *   GET    /job/audio?start=&dur=         -> mp3 slice of the extracted audio
 *   PUT    /job/subs    ASS text          -> { ok: true }
 *   POST   /job/burn                      -> burned-in mp4 bytes
 *   DELETE /job                           -> { ok: true }
 *   GET    /health                        -> { ok, ffmpeg, subtitlesFilter }
 *   GET    /fonts                         -> font families libass can resolve
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const PORT = Number(process.env.PORT || 8080);
const JOBS_DIR = process.env.JOBS_DIR || '/tmp/jobs';
const FONTS_DIR = process.env.FONTS_DIR || '/usr/share/fonts/custom';

const WORK = path.join(JOBS_DIR, 'current');
const INPUT = path.join(WORK, 'input.bin');
const AUDIO = path.join(WORK, 'audio.mp3');
const SUBS = path.join(WORK, 'subs.ass');
const OUTPUT = path.join(WORK, 'output.mp4');

// --- process helpers -------------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd || WORK });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      // ffmpeg is chatty; only the tail is useful for diagnosing a failure.
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function ffmpeg(args) {
  const res = await run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-y', ...args]);
  if (res.code !== 0) {
    const err = new Error(`ffmpeg exited ${res.code}`);
    err.detail = res.stderr.split('\n').slice(-25).join('\n');
    throw err;
  }
  return res;
}

async function probe(file) {
  const res = await run('ffprobe', [
    '-hide_banner',
    '-loglevel', 'error',
    '-show_format',
    '-show_streams',
    '-print_format', 'json',
    file,
  ]);
  if (res.code !== 0) {
    const err = new Error('ffprobe failed');
    err.detail = res.stderr.split('\n').slice(-15).join('\n');
    throw err;
  }
  return JSON.parse(res.stdout);
}

// --- http helpers ----------------------------------------------------------

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function receiveToFile(req, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(req, fs.createWriteStream(dest));
  const { size } = await fsp.stat(dest);
  return size;
}

async function readText(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function sendFile(res, file, contentType) {
  const { size } = await fsp.stat(file);
  res.writeHead(200, { 'content-type': contentType, 'content-length': size });
  await pipeline(fs.createReadStream(file), res);
}

async function resetWorkdir() {
  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(WORK, { recursive: true });
}

// --- handlers --------------------------------------------------------------

/** Accept the source video, extract a whisper-friendly audio track, report metadata. */
async function handleVideo(req, res, url) {
  await resetWorkdir();
  const size = await receiveToFile(req, INPUT);
  if (size === 0) return json(res, 400, { error: 'empty body' });

  const meta = await probe(INPUT);
  const video = (meta.streams || []).find((s) => s.codec_type === 'video');
  const audio = (meta.streams || []).find((s) => s.codec_type === 'audio');
  const duration = Number(meta.format?.duration || video?.duration || 0);

  // A re-burn already has its transcript, so the audio pass would be pure
  // waste — and an audio-less source that got this far must not be rejected
  // on a second visit for a track nothing is going to read.
  if (url.searchParams.get('audio') === 'skip') {
    return json(res, 200, {
      bytes: size,
      duration,
      width: video ? Number(video.width) : null,
      height: video ? Number(video.height) : null,
      hasAudio: Boolean(audio),
      audioBytes: 0,
    });
  }

  if (!audio) {
    return json(res, 422, { error: 'no_audio_track', duration, bytes: size });
  }

  // 16 kHz mono mp3 — small enough to ship to a speech model, plenty for speech.
  await ffmpeg([
    '-i', INPUT,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'libmp3lame',
    '-b:a', '64k',
    AUDIO,
  ]);

  const audioSize = (await fsp.stat(AUDIO)).size;
  json(res, 200, {
    bytes: size,
    duration,
    width: video ? Number(video.width) : null,
    height: video ? Number(video.height) : null,
    hasAudio: true,
    audioBytes: audioSize,
  });
}

/** Return a slice of the extracted audio so long videos can be transcribed in chunks. */
async function handleAudio(res, url) {
  if (!fs.existsSync(AUDIO)) return json(res, 409, { error: 'no_audio_extracted' });

  const start = Number(url.searchParams.get('start') || 0);
  const dur = Number(url.searchParams.get('dur') || 0);

  if (!start && !dur) return sendFile(res, AUDIO, 'audio/mpeg');

  const chunk = path.join(WORK, `chunk-${start}-${dur}.mp3`);
  await ffmpeg([
    '-ss', String(start),
    ...(dur > 0 ? ['-t', String(dur)] : []),
    '-i', AUDIO,
    '-c', 'copy',
    chunk,
  ]);
  await sendFile(res, chunk, 'audio/mpeg');
  await fsp.rm(chunk, { force: true });
}

/** Store the ASS subtitle file next to the video (relative path keeps filter escaping simple). */
async function handleSubs(req, res) {
  const text = await readText(req);
  if (!text.trim()) return json(res, 400, { error: 'empty subtitles' });
  await fsp.mkdir(WORK, { recursive: true });
  await fsp.writeFile(SUBS, text, 'utf8');
  json(res, 200, { ok: true, bytes: Buffer.byteLength(text) });
}

/** Hardsub the stored ASS onto the stored video. */
async function handleBurn(res, url) {
  if (!fs.existsSync(INPUT)) return json(res, 409, { error: 'no_video' });
  if (!fs.existsSync(SUBS)) return json(res, 409, { error: 'no_subtitles' });

  const crf = url.searchParams.get('crf') || '23';
  const preset = url.searchParams.get('preset') || 'veryfast';

  // cwd is WORK, so the filter can reference `subs.ass` by bare name — no
  // Windows-style colon/backslash escaping headaches inside the filtergraph.
  await ffmpeg([
    '-i', 'input.bin',
    '-vf', `subtitles=subs.ass:fontsdir=${FONTS_DIR}`,
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', crf,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    'output.mp4',
  ]);

  await sendFile(res, OUTPUT, 'video/mp4');
}

async function handleFonts(res) {
  const families = await run('fc-list', [':', 'family'], { cwd: '/' });
  const list = [...new Set(families.stdout.split('\n').flatMap((l) => l.split(',')).map((s) => s.trim()).filter(Boolean))].sort();
  json(res, 200, { fontsDir: FONTS_DIR, families: list });
}

async function handleHealth(res) {
  const version = await run('ffmpeg', ['-version'], { cwd: '/' });
  const filters = await run('sh', ['-c', 'ffmpeg -hide_banner -filters 2>/dev/null | grep -c " subtitles "'], { cwd: '/' });
  json(res, 200, {
    ok: true,
    ffmpeg: version.stdout.split('\n')[0] || null,
    subtitlesFilter: Number(filters.stdout.trim()) > 0,
  });
}

// --- server ----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://container');
  const route = `${req.method} ${url.pathname}`;

  try {
    switch (route) {
      case 'GET /health':
        return await handleHealth(res);
      case 'GET /fonts':
        return await handleFonts(res);
      case 'POST /job/video':
        return await handleVideo(req, res, url);
      case 'GET /job/audio':
        return await handleAudio(res, url);
      case 'PUT /job/subs':
        return await handleSubs(req, res);
      case 'POST /job/burn':
        return await handleBurn(res, url);
      case 'DELETE /job':
        await resetWorkdir();
        return json(res, 200, { ok: true });
      default:
        return json(res, 404, { error: 'not_found', route });
    }
  } catch (err) {
    console.error(`[ffmpeg] ${route} failed:`, err.message, err.detail || '');
    if (res.headersSent) return res.destroy();
    json(res, 500, { error: err.message, detail: err.detail || null });
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  await fsp.mkdir(WORK, { recursive: true });
  const filters = await run('sh', ['-c', 'ffmpeg -hide_banner -filters 2>/dev/null | grep -c " subtitles "'], { cwd: '/' });
  const hasSubtitles = Number(filters.stdout.trim()) > 0;
  console.log(`[ffmpeg] listening on ${PORT}; subtitles filter (libass): ${hasSubtitles ? 'available' : 'MISSING'}`);
  if (!hasSubtitles) {
    console.error('[ffmpeg] this ffmpeg build has no subtitles filter — burn-in will fail');
  }
});

// The platform sends SIGTERM before stopping the instance.
process.on('SIGTERM', () => {
  console.log('[ffmpeg] SIGTERM, closing');
  server.close(() => process.exit(0));
});
