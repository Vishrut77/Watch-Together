import fs from 'fs';
import os from 'os';
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
const MOVIE_FILE = path.join(__dirname, 'fixtures', 'bench_720p.mp4');

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

async function main() {
  if (!fs.existsSync(MOVIE_FILE)) throw new Error(`Missing fixture: ${MOVIE_FILE}`);
  const dbPath = path.join(os.tmpdir(), `wt_part2_${Date.now()}.db`);
  const lkPort = 7880;
  const apiPort = 8006;
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
        SECRET_KEY: 'part2-test-secret-key-not-for-prod-12345',
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

    const ctxH = await browser.createBrowserContext();
    const pageH = await ctxH.newPage();
    await pageH.goto(baseUrl, { waitUntil: 'networkidle0' });
    await pageH.type('input[aria-label="Nickname"]', 'HostP2');
    await pageH.click('button.primary');
    await pageH.waitForSelector('form.form');
    await pageH.type('input[placeholder="Friday movie night"]', 'Part 2 Verification');
    await pageH.click('form.form button.primary');
    await pageH.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 20000 });
    const roomUrl = pageH.url();

    const ctxV = await browser.createBrowserContext();
    const pageV = await ctxV.newPage();
    await pageV.goto(roomUrl, { waitUntil: 'networkidle0' });
    await pageV.waitForSelector('form.form input.input');
    await pageV.type('form.form input.input', 'ViewerP2');
    await pageV.click('form.form button.primary');
    await pageV.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 20000 });

    const fileInput = await pageH.$('.stage input[type=file]');
    await fileInput.uploadFile(MOVIE_FILE);
    await pageH.waitForFunction(() => {
      const r = window.__watchTogether?.room;
      return r?.player?.isStreamer === true && r?.playback?.has_movie === true;
    }, { timeout: 20000 });
    await pageH.evaluate(() => {
      const v = window.__watchTogether.room.player.vMovie;
      v.loop = true;
      return v.play().catch(() => {});
    });
    try {
      await pageV.waitForFunction(() => {
        const m = window.__watchTogether?.room?.media?.state?.movie;
        return !!m?.video?.receiver && !!m?.audio?.receiver;
      }, { timeout: 20000 });
    } catch (e) {
      const diag = await pageV.evaluate(() => {
        const r = window.__watchTogether?.room;
        return {
          connected: r?.media?.connected,
          pb: r?.playback,
          movie: r?.media?.state?.movie ? {
            hasVideo: !!r.media.state.movie.video,
            hasAudio: !!r.media.state.movie.audio,
            hasVideoRcv: !!r.media.state.movie.video?.receiver,
            hasAudioRcv: !!r.media.state.movie.audio?.receiver,
          } : null,
          hostTracks: null,
        };
      });
      const hostDiag = await pageH.evaluate(() => ({
        sent: window.__watchTogether?.room?.player?.sent,
        paused: window.__watchTogether?.room?.player?.vMovie?.paused,
        hasVideo: !!window.__watchTogether?.room?.media?.movieTracks?.video,
        hasAudio: !!window.__watchTogether?.room?.media?.movieTracks?.audio,
      }));
      console.error('[part2] DIAG:', JSON.stringify({ viewer: diag, host: hostDiag }));
      throw e;
    }
    await sleep(2500);

    // 1. Verify initial attach count = 1 & balanced jitterBufferTarget = 1500ms on both video & audio
    const initStats = await pageV.evaluate(async () => {
      const r = window.__watchTogether.room;
      const recv = await r.media.movieReceiveStats();
      return {
        attachCount: r.player.movieAttachCount,
        smoothness: r.media.smoothness,
        jbV: recv?.jbTargetVideo,
        jbA: recv?.jbTargetAudio,
        qualityBtnVisible: getComputedStyle(r.player.btnQuality).display !== 'none',
      };
    });
    console.log('[part2] Initial viewer state:', JSON.stringify(initStats));
    assert(initStats.attachCount === 1, `Expected initial attachCount === 1, got ${initStats.attachCount}`);
    assert(initStats.qualityBtnVisible, 'Expected viewer smoothness button to be visible');
    assert(initStats.jbV === 1500 && initStats.jbA === 1500, `Expected Balanced jbTargetVideo/Audio 1500/1500, got ${initStats.jbV}/${initStats.jbA}`);

    // 2. Open menu on viewer UI, switch to Smoothest -> verify jbTargetVideo === 2500 && jbTargetAudio === 2500
    await pageV.click('.ctl.quality');
    await pageV.waitForSelector('.quality-menu:not([hidden])');
    const menuItems = await pageV.$$eval('.quality-menu .menu-item', (els) => els.map((e) => e.textContent.trim()));
    console.log('[part2] Viewer smoothness menu items:', menuItems);
    assert(menuItems.some((t) => t.includes('Balanced')) && menuItems.some((t) => t.includes('Smoothest')), 'Smoothness options missing');
    const smoothestIdx = menuItems.findIndex((t) => t.includes('Smoothest'));
    const buttons = await pageV.$$('.quality-menu .menu-item');
    await buttons[smoothestIdx].click();
    await sleep(400);

    const smoothStats = await pageV.evaluate(async () => {
      const r = window.__watchTogether.room;
      const recv = await r.media.movieReceiveStats();
      return { smoothness: r.media.smoothness, jbV: recv?.jbTargetVideo, jbA: recv?.jbTargetAudio };
    });
    console.log('[part2] After Smoothest click:', JSON.stringify(smoothStats));
    assert(smoothStats.jbV === 2500 && smoothStats.jbA === 2500, `Expected Smoothest 2500/2500, got ${smoothStats.jbV}/${smoothStats.jbA}`);

    // Switch back to Balanced
    await pageV.click('.ctl.quality');
    await pageV.waitForSelector('.quality-menu:not([hidden])');
    const buttons2 = await pageV.$$('.quality-menu .menu-item');
    await buttons2[menuItems.findIndex((t) => t.includes('Balanced'))].click();
    await sleep(400);

    // 3. Stress actions (camera toggle, chat message, resize, theatre toggle) -> attachCount must remain 1
    await pageH.click('.dock-btn.cam');
    await pageV.click('.dock-btn.cam');
    await pageV.type('.chat-form input.input', 'Testing no teardown!');
    await pageV.keyboard.press('Enter');
    await pageV.setViewport({ width: 900, height: 650 });
    await sleep(300);
    await pageV.click('.ctl.theatre');
    await sleep(300);
    await pageV.click('.ctl.theatre');
    await pageV.setViewport({ width: 1280, height: 720 });
    await sleep(1000);

    const afterStress = await pageV.evaluate(() => ({
      attachCount: window.__watchTogether.room.player.movieAttachCount,
      paused: window.__watchTogether.room.player.vMovie.paused,
    }));
    console.log('[part2] After stress:', JSON.stringify(afterStress));
    assert(afterStress.attachCount === 1, `Video re-attached during camera/chat/resize/theatre! count=${afterStress.attachCount}`);
    assert(!afterStress.paused, 'Viewer video unexpectedly paused during UI updates');

    // 4. Verify drift correction snaps displayed time cleanly WITHOUT setting vMovie.currentTime
    const driftResult = await pageV.evaluate(() => {
      const p = window.__watchTogether.room.player;
      const v = p.vMovie;
      let seekSetCount = 0;
      const origDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      Object.defineProperty(v, 'currentTime', {
        get: () => origDesc.get.call(v),
        set: (val) => { seekSetCount++; origDesc.set.call(v, val); },
        configurable: true,
      });
      // Inject large display drift (> streamDelaySec + 1.0s)
      p.viewerDisplayPos += 8.0;
      const corrected = p.currentPosition();
      const expected = p.rawServerPosition() - p.streamDelaySec;
      delete v.currentTime;
      return { seekSetCount, corrected, expected, diff: Math.abs(corrected - expected), streamDelaySec: p.streamDelaySec };
    });
    console.log('[part2] Drift correction check:', JSON.stringify(driftResult));
    assert(driftResult.seekSetCount === 0, `Expected 0 seeks on live <video>, got ${driftResult.seekSetCount}`);
    assert(driftResult.diff < 0.25, `Drift not corrected accurately: diff=${driftResult.diff}`);

    console.log('[part2] ALL PART 2 ASSERTIONS PASSED!');
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
