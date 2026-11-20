import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(ROOT, 'backend');
const PYTHON_EXE = path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe');
const LIVEKIT_EXE = path.join(ROOT, 'demo', 'bin', 'livekit-server.exe');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FORMATS_DIR = path.join(__dirname, 'fixtures', 'formats');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs = 20000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(stepMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function measureCpu(procPid, durationMs = 1500) {
  if (!procPid) return 0;
  try {
    const { execSync } = await import('child_process');
    const out = execSync(
      `powershell -Command "(Get-Process -Id ${procPid} -ErrorAction SilentlyContinue).CPU"`,
      { encoding: 'utf8' }
    ).trim();
    const c1 = parseFloat(out) || 0;
    await sleep(durationMs);
    const out2 = execSync(
      `powershell -Command "(Get-Process -Id ${procPid} -ErrorAction SilentlyContinue).CPU"`,
      { encoding: 'utf8' }
    ).trim();
    const c2 = parseFloat(out2) || 0;
    const numCores = (await import('os')).cpus().length || 1;
    const cpuPct = ((c2 - c1) / (durationMs / 1000)) * (100 / numCores);
    return Math.max(0, Math.min(100, cpuPct));
  } catch {
    return 0;
  }
}

async function run() {
  console.log('=== E2E Test: Headless FFmpeg Bot Fallback Tier ===');

  // Verify test fixture files exist
  const testFiles = [
    {
      name: '03_mkv_h264_ac3_51.mkv',
      label: 'MKV (H.264 + AC3 5.1)',
      relPath: 'e2e/fixtures/formats/03_mkv_h264_ac3_51.mkv',
    },
    {
      name: '05_mkv_hevc_aac.mkv',
      label: 'MKV (HEVC + AAC)',
      relPath: 'e2e/fixtures/formats/05_mkv_hevc_aac.mkv',
    },
    {
      name: '06_avi_mpeg4_mp3.avi',
      label: 'AVI (MPEG-4 + MP3)',
      relPath: 'e2e/fixtures/formats/06_avi_mpeg4_mp3.avi',
    },
  ];

  for (const f of testFiles) {
    const full = path.join(ROOT, f.relPath);
    assert(fs.existsSync(full), `Test fixture missing: ${full}`);
  }

  // 1. Ensure livekit-server is running
  let livekitProc = null;
  const lkPing = await fetch('http://127.0.0.1:7880').then(() => true).catch(() => false);
  if (!lkPing) {
    console.log('[livekit] Starting local livekit-server --dev...');
    livekitProc = spawn(LIVEKIT_EXE, ['--dev'], { stdio: 'ignore' });
    await until(async () => {
      try {
        const r = await fetch('http://127.0.0.1:7880');
        return r.status >= 200;
      } catch {
        return false;
      }
    }, 15000, 300);
    console.log('[livekit] Server is up on port 7880.');
  } else {
    console.log('[livekit] Reusing already running livekit-server on port 7880.');
  }

  // 2. Start backend on port 8008
  const dbPath = path.join(BACKEND_DIR, 'test_movie_bot.db');
  try { fs.rmSync(dbPath, { force: true }); } catch {}

  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    SECRET_KEY: 'test-secret-key-test-secret-key-0123456789',
    DATABASE_URL: `sqlite:///${dbPath.replace(/\\/g, '/')}`,
    LIVEKIT_URL: 'ws://127.0.0.1:7880',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret',
    APP_ENV: 'test',
  };

  console.log('[backend] Starting backend server on port 8008...');
  const backendProc = spawn(
    PYTHON_EXE,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8008'],
    { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  backendProc.stderr.on('data', (d) => {
    const s = d.toString();
    if (!s.includes('INFO:') && !s.includes('StarletteDeprecationWarning')) {
      process.stderr.write(`[backend err] ${s}`);
    }
  });

  await until(async () => {
    try {
      const res = await fetch('http://127.0.0.1:8008/api/rooms');
      return res.ok;
    } catch {
      return false;
    }
  }, 20000, 300);
  console.log('[backend] Ready at http://127.0.0.1:8008.');

  // 3. Launch Chromium browser with Host and Viewer contexts
  console.log('[browser] Launching Chromium...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
    defaultViewport: { width: 1280, height: 720 },
  });

  const results = [];

  try {
    const ctxH = await browser.createBrowserContext();
    const ctxV = await browser.createBrowserContext();
    const pageH = await ctxH.newPage();
    const pageV = await ctxV.newPage();

    // Create room via Host
    await pageH.goto('http://127.0.0.1:8008', { waitUntil: 'networkidle0' });
    await pageH.waitForSelector('input[aria-label="Nickname"]');
    await pageH.type('input[aria-label="Nickname"]', 'Deku');
    await pageH.click('button.primary');
    await pageH.waitForSelector('form.form');
    await pageH.type('input[placeholder="Friday movie night"]', 'Bot Test Room');
    await pageH.click('form.form button.primary');
    await pageH.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 20000 });

    const roomUrl = pageH.url();
    const code = await pageH.evaluate(() => window.__watchTogether.room.code);
    assert(code && code.length === 6, `Room code invalid: ${code}`);
    console.log(`[room] Room created with code: ${code} (${roomUrl})`);

    // Join Viewer
    await pageV.goto(roomUrl, { waitUntil: 'networkidle0' });
    await pageV.waitForSelector('form.form input.input');
    await pageV.type('form.form input.input', 'Aarav');
    await pageV.click('form.form button.primary');
    await pageV.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 20000 });
    console.log('[room] Viewer joined and connected to room.');

    for (const testSpec of testFiles) {
      console.log(`\n--- Testing Format: ${testSpec.label} (${testSpec.name}) ---`);
      const absPath = path.join(ROOT, testSpec.relPath);

      // Start movie bot on Host
      const startRes = await pageH.evaluate(async (fPath) => {
        return window.__watchTogether.room.player.startBotStream({
          filePath: fPath,
          quality: 'auto',
        });
      }, absPath);

      assert(startRes && startRes.status === 'started', `Bot failed to start: ${JSON.stringify(startRes)}`);
      console.log(`[bot] Started: ${startRes.bot_id} (${startRes.width}x${startRes.height}@${startRes.fps}fps)`);

      // Verify playback state shows bot as streamer
      await until(async () => {
        const pb = await pageV.evaluate(() => window.__watchTogether?.room?.playback);
        return pb && pb.has_movie && pb.streamer_id?.startsWith('movie-bot-') && pb.playing;
      }, 15000, 200);

      // Wait for viewer to receive video frames
      console.log('[viewer] Waiting for video reception from bot...');
      const recvStats = await until(async () => {
        const st = await pageV.evaluate(() => window.__watchTogether?.room?.media?.movieReceiveStats?.());
        if (st && st.width > 0 && st.framesDecoded > 10) return st;
        return false;
      }, 20000, 300);

      console.log(`[viewer] Video received: ${recvStats.width}x${recvStats.height}, framesDecoded=${recvStats.framesDecoded}, fps=${recvStats.fps.toFixed(1)}`);
      assert(recvStats.width > 0 && recvStats.height > 0, 'Viewer received invalid video resolution');
      assert(recvStats.framesDecoded >= 10, 'Viewer did not receive enough video frames');

      // Measure viewer audio RMS
      console.log('[viewer] Measuring audio RMS from bot stream...');
      await until(async () => {
        const hasA = await pageV.evaluate(() => !!window.__watchTogether?.room?.media?.state?.movie?.audio?.mediaStreamTrack);
        return hasA;
      }, 10000, 200);

      const rms = await pageV.evaluate(async () => {
        const track = window.__watchTogether.room.media.state.movie.audio.mediaStreamTrack;
        const ctx = new AudioContext();
        await ctx.resume();
        const src = ctx.createMediaStreamSource(new MediaStream([track]));
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        src.connect(an);
        const buf = new Float32Array(an.fftSize);
        let peak = 0;
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 100));
          an.getFloatTimeDomainData(buf);
          let sq = 0;
          for (let k = 0; k < buf.length; k++) sq += buf[k] * buf[k];
          peak = Math.max(peak, Math.sqrt(sq / buf.length));
        }
        await ctx.close();
        return peak;
      });

      console.log(`[viewer] Measured audio RMS: ${rms.toFixed(5)}`);
      assert(rms > 0.005, `Expected audio RMS > 0.005, got ${rms.toFixed(5)}`);

      // Measure CPU utilization
      const cpuUsage = await measureCpu(backendProc.pid, 1000);
      console.log(`[system] Backend CPU usage: ${cpuUsage.toFixed(1)}%`);

      // Test Host Playback Controls: Pause, Seek, Resume
      console.log('[controls] Testing pause...');
      await pageH.evaluate(() => window.__watchTogether.room.player.togglePlay());
      await until(async () => {
        const pb = await pageV.evaluate(() => window.__watchTogether?.room?.playback);
        return pb && !pb.playing;
      }, 8000, 200);
      console.log('[controls] Pause verified.');

      console.log('[controls] Testing seek to 2.5s...');
      await pageH.evaluate(() => window.__watchTogether.room.player.seekTo(2.5));
      await until(async () => {
        const pb = await pageV.evaluate(() => window.__watchTogether?.room?.playback);
        return pb && Math.abs(pb.position - 2.5) < 0.8;
      }, 8000, 200);
      console.log('[controls] Seek verified.');

      console.log('[controls] Testing resume...');
      await pageH.evaluate(() => window.__watchTogether.room.player.togglePlay());
      await until(async () => {
        const pb = await pageV.evaluate(() => window.__watchTogether?.room?.playback);
        return pb && pb.playing;
      }, 8000, 200);
      console.log('[controls] Resume verified.');

      // Stop movie before next format
      await pageH.evaluate(() => window.__watchTogether.room.player.stopMovie());
      await until(async () => {
        const pb = await pageV.evaluate(() => window.__watchTogether?.room?.playback);
        return pb && !pb.has_movie;
      }, 8000, 200);
      console.log(`[bot] Stopped movie for ${testSpec.name}.`);

      results.push({
        label: testSpec.label,
        name: testSpec.name,
        resolution: `${recvStats.width}x${recvStats.height}`,
        fps: Math.round(recvStats.fps),
        audioRms: Number(rms.toFixed(4)),
        cpu: `${cpuUsage.toFixed(1)}%`,
        status: 'PASS',
      });
    }

    await ctxH.close();
    await ctxV.close();
  } finally {
    await browser.close();
    backendProc.kill();
    if (livekitProc) livekitProc.kill();
    try { fs.rmSync(dbPath, { force: true }); } catch {}
  }

  console.log('\n=================== BOT FALLBACK TEST SUMMARY ===================');
  console.table(results);
  console.log('All formats streamed successfully via Headless FFmpeg Bot!');
}

run().catch((err) => {
  console.error('\nE2E Test Failed:', err);
  process.exit(1);
});
