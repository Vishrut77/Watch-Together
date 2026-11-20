import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(ROOT, 'backend');
const PYTHON_EXE = path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe');
const LIVEKIT_EXE = path.join(ROOT, 'demo', 'bin', 'livekit-server.exe');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SYNC_CLIP = path.join(__dirname, 'fixtures', 'local_sync_65s.mp4');
const OTHER_CLIP = path.join(__dirname, 'fixtures', 'bench_1080p.mp4');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs = 15000, stepMs = 200) {
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

function ensureSyncFixture() {
  if (fs.existsSync(SYNC_CLIP) && fs.statSync(SYNC_CLIP).size > 100_000) return;
  fs.mkdirSync(path.dirname(SYNC_CLIP), { recursive: true });
  const ffmpeg = execFileSync(
    PYTHON_EXE,
    ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],
    { encoding: 'utf8' }
  ).trim();
  console.log('[local_sync] Creating 65s 720p H.264 test fixture...');
  execFileSync(
    ffmpeg,
    [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=65',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=65',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ac', '2', '-b:a', '96k', '-movflags', '+faststart',
      SYNC_CLIP,
    ],
    { stdio: 'pipe' }
  );
}

async function main() {
  ensureSyncFixture();
  const dbPath = path.join(os.tmpdir(), `wt_lsync_${Date.now()}.db`);
  const lkPort = 7880;
  const apiPort = 8007;
  const baseUrl = `http://127.0.0.1:${apiPort}`;

  const lkProc = spawn(LIVEKIT_EXE, ['--dev', '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await until(async () => {
    try { await fetch(`http://127.0.0.1:${lkPort}`); return true; } catch { return false; }
  }, 15000, 250);

  const apiProc = spawn(
    PYTHON_EXE,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(apiPort)],
    {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        APP_ENV: 'development',
        SECRET_KEY: 'lsync-test-secret-key-not-for-prod-12345',
        DATABASE_URL: `sqlite:///${dbPath.replace(/\\/g, '/')}`,
        LIVEKIT_URL: `ws://127.0.0.1:${lkPort}`,
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'secret',
        RATE_LIMIT_ENABLED: 'false',
        FRONTEND_DIST: path.join(ROOT, 'frontend', 'dist'),
      },
      stdio: 'ignore',
    }
  );

  let browser;
  try {
    await until(async () => (await fetch(`${baseUrl}/health`)).ok, 20000, 250);
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      defaultViewport: { width: 1280, height: 720 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    const joinViewer = async (roomUrl, name) => {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.goto(roomUrl, { waitUntil: 'networkidle0' });
      await page.waitForSelector('form.form input.input');
      await page.type('form.form input.input', name);
      await page.click('form.form button.primary');
      await page.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 20000 });
      return page;
    };

    const ctxH = await browser.createBrowserContext();
    const pageH = await ctxH.newPage();
    await pageH.goto(baseUrl, { waitUntil: 'networkidle0' });
    await pageH.type('input[aria-label="Nickname"]', 'SyncHost');
    await pageH.click('button.primary');
    await pageH.waitForSelector('form.form');
    await pageH.type('input[placeholder="Friday movie night"]', 'Local Sync Test');
    await pageH.click('form.form button.primary');
    await pageH.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 20000 });
    const roomUrl = pageH.url();

    const pageV1 = await joinViewer(roomUrl, 'Viewer1');
    const pageV2 = await joinViewer(roomUrl, 'Viewer2');

    // Host chooses local sync mode
    await pageH.waitForSelector('.sync-only-btn');
    await pageH.evaluate(() => {
      window.__watchTogether.room.player.launchMode = 'local_sync';
    });
    const hostInput = await pageH.$('.stage input[type=file]');
    await hostInput.uploadFile(SYNC_CLIP);
    await pageH.waitForFunction(() => {
      const p = window.__watchTogether?.room?.player;
      return p?.isStreamer === true && p?.mode === 'local_sync';
    }, { timeout: 15000 });

    // Check zero movie tracks published on Host
    const hostLk = await pageH.evaluate(() => ({
      video: window.__watchTogether.room.media.movieTracks.video,
      audio: window.__watchTogether.room.media.movieTracks.audio,
      mode: window.__watchTogether.room.playback?.mode,
    }));
    assert(hostLk.video === null && hostLk.audio === null, `Expected 0 LiveKit movie tracks on host, got ${JSON.stringify(hostLk)}`);
    assert(hostLk.mode === 'local_sync', `Expected host mode local_sync, got ${hostLk.mode}`);

    // Viewer 1 first uploads mismatched file -> assert mismatch dialog
    if (fs.existsSync(OTHER_CLIP)) {
      await pageV1.waitForFunction(() => window.__watchTogether?.room?.playback?.mode === 'local_sync', { timeout: 10000 });
      const v1Inputs = await pageV1.$$('.stage input[type=file]');
      const v1Picker = v1Inputs[1];
      await v1Picker.uploadFile(OTHER_CLIP);
      await pageV1.waitForSelector('.dialog h2', { timeout: 5000 });
      const dlgText = await pageV1.$eval('.dialog h2', (e) => e.textContent);
      console.log('[local_sync] Mismatch dialog:', dlgText);
      assert(dlgText.toLowerCase().includes('different file'), `Unexpected mismatch dialog: ${dlgText}`);
      // Dismiss mismatch dialog
      const cancelBtn = await pageV1.$('.dialog-actions button:not(.primary)');
      await cancelBtn.click();
      await sleep(200);
    }

    // Both viewers pick matching SYNC_CLIP
    for (const [label, pv] of [['V1', pageV1], ['V2', pageV2]]) {
      const inputs = await pv.$$('.stage input[type=file]');
      await inputs[1].uploadFile(SYNC_CLIP);
      await pv.waitForFunction(() => window.__watchTogether?.room?.player?.localViewerReady === true, { timeout: 10000 });
      const lkState = await pv.evaluate(() => window.__watchTogether.room.media.state.movie);
      assert(lkState === null, `${label} unexpectedly saw a LiveKit movie track`);
      console.log(`[local_sync] ${label} matched and ready.`);
    }

    // Start playback on Host and monitor across 60s (with seek + pause/resume check)
    await pageH.evaluate(() => window.__watchTogether.room.player.vMovie.play());
    await sleep(2000);

    let maxDriftV1 = 0;
    let maxDriftV2 = 0;
    const samples = [];
    for (let elapsed = 0; elapsed < 60; elapsed += 2) {
      if (elapsed === 16) {
        console.log('[local_sync] Host seeking to 25.0s...');
        await pageH.evaluate(() => window.__watchTogether.room.player.seekTo(25.0));
        await sleep(1200); // allow 1 tick for viewer seek to land
      }
      if (elapsed === 32) {
        console.log('[local_sync] Host pausing then resuming...');
        await pageH.evaluate(() => window.__watchTogether.room.player.vMovie.pause());
        await sleep(1000);
        const pausedState = await Promise.all([pageV1, pageV2].map((p) => p.evaluate(() => window.__watchTogether.room.player.vMovie.paused)));
        assert(pausedState[0] && pausedState[1], `Viewers failed to pause: ${JSON.stringify(pausedState)}`);
        await pageH.evaluate(() => window.__watchTogether.room.player.vMovie.play());
        await sleep(1000);
      }

      const [tH, t1, t2] = await Promise.all([
        pageH.evaluate(() => ({ t: window.__watchTogether.room.player.vMovie.currentTime, paused: window.__watchTogether.room.player.vMovie.paused })),
        pageV1.evaluate(() => ({ t: window.__watchTogether.room.player.vMovie.currentTime, rate: window.__watchTogether.room.player.vMovie.playbackRate })),
        pageV2.evaluate(() => ({ t: window.__watchTogether.room.player.vMovie.currentTime, rate: window.__watchTogether.room.player.vMovie.playbackRate })),
      ]);
      const d1 = Math.abs(t1.t - tH.t);
      const d2 = Math.abs(t2.t - tH.t);
      if (elapsed >= 4) { // after initial startup settle
        maxDriftV1 = Math.max(maxDriftV1, d1);
        maxDriftV2 = Math.max(maxDriftV2, d2);
      }
      samples.push({ elapsed, h: Number(tH.t.toFixed(2)), v1: Number(t1.t.toFixed(2)), v2: Number(t2.t.toFixed(2)), d1: Number(d1.toFixed(3)), d2: Number(d2.toFixed(3)) });
      console.log(`[local_sync] t+${elapsed}s | host=${tH.t.toFixed(2)}s | V1=${t1.t.toFixed(2)}s (d=${d1.toFixed(3)}s r=${t1.rate}) | V2=${t2.t.toFixed(2)}s (d=${d2.toFixed(3)}s r=${t2.rate})`);
      assert(elapsed < 4 || (d1 < 0.5 && d2 < 0.5), `Drift exceeded 0.5s at ${elapsed}s: d1=${d1.toFixed(3)}s, d2=${d2.toFixed(3)}s`);
      await sleep(2000);
    }

    console.log(`[local_sync] ALL 60s LOCAL SYNC ASSERTIONS PASSED! maxDriftV1=${maxDriftV1.toFixed(3)}s, maxDriftV2=${maxDriftV2.toFixed(3)}s`);
  } finally {
    await browser?.close().catch(() => {});
    try { apiProc.kill(); } catch {}
    try { lkProc.kill(); } catch {}
    try { fs.rmSync(dbPath, { force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
