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

async function main() {
  const dbPath = path.join(os.tmpdir(), `wt_p1chk_${Date.now()}.db`);
  const lkPort = 7880;
  const apiPort = 8009;
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
        SECRET_KEY: 'p1chk-test-secret-key-not-for-prod-12345',
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
    await pageH.evaluateOnNewDocument(() => {
      localStorage.setItem('wt_quality', 'auto');
    });
    await pageH.goto(baseUrl, { waitUntil: 'networkidle0' });
    await pageH.type('input[aria-label="Nickname"]', 'P1Host');
    await pageH.click('button.primary');
    await pageH.waitForSelector('form.form');
    await pageH.type('input[placeholder="Friday movie night"]', 'P1 Hysteresis Check');
    await pageH.click('form.form button.primary');
    await pageH.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 20000 });
    const roomUrl = pageH.url();

    const ctxV = await browser.createBrowserContext();
    const pageV = await ctxV.newPage();
    await pageV.goto(roomUrl, { waitUntil: 'networkidle0' });
    await pageV.waitForSelector('form.form input.input');
    await pageV.type('form.form input.input', 'P1Viewer');
    await pageV.click('form.form button.primary');
    await pageV.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 20000 });

    const fileInput = await pageH.$('.stage input[type=file]');
    await fileInput.uploadFile(MOVIE_FILE);
    await pageH.waitForFunction(() => window.__watchTogether?.room?.player?.isStreamer === true, { timeout: 20000 });
    await pageH.evaluate(() => {
      const v = window.__watchTogether.room.player.vMovie;
      v.loop = true;
      return v.play();
    });
    await sleep(3000);

    // Patch sender.getStats to emulate dynamic uplink bandwidth / CPU pressure
    await pageH.evaluate(() => {
      const m = window.__watchTogether.room.media;
      window.__wtSim = { availBps: 8_000_000, cpuLim: false };
      const installPatch = () => {
        const s = m.movieTracks?.video?.sender;
        if (!s || s.__wtSimPatched) return;
        const orig = s.getStats.bind(s);
        s.__wtSimPatched = true;
        s.getStats = async () => {
          const rep = await orig();
          const fake = [];
          rep.forEach((v) => {
            const c = { ...v };
            if (c.type === 'candidate-pair' && c.state === 'succeeded') c.availableOutgoingBitrate = window.__wtSim.availBps;
            if (c.type === 'outbound-rtp' && c.kind === 'video' && window.__wtSim.cpuLim) c.qualityLimitationReason = 'cpu';
            fake.push(c);
          });
          return { forEach: (fn) => fake.forEach(fn), values: () => fake.values(), [Symbol.iterator]: () => fake[Symbol.iterator]() };
        };
      };
      installPatch();
      setInterval(installPatch, 500);
    });

    const startIdx = await pageH.evaluate(() => window.__watchTogether.room.media.autoState?.idx);
    console.log('[p1chk] Initial auto rung idx:', startIdx);
    assert(startIdx === 4, `Expected initial 720p rung 4, got ${startIdx}`);

    // 1. Step-down fast (~4s of low 750kbps uplink)
    await pageH.evaluate(() => { window.__wtSim.availBps = 750_000; });
    await sleep(6500);
    const downIdx = await pageH.evaluate(() => window.__watchTogether.room.media.autoState?.idx);
    console.log('[p1chk] After 6.5s @ 750kbps, rung idx:', downIdx);
    assert(downIdx <= 2, `Expected fast step-down <= rung 2 (540p/480p), got ${downIdx}`);

    // 2. Step-up slow hysteresis: restore 8 Mbps -> must NOT jump up after 6s, MUST step up after ~20s
    await pageH.evaluate(() => { window.__wtSim.availBps = 8_000_000; });
    await sleep(6000);
    const earlyIdx = await pageH.evaluate(() => window.__watchTogether.room.media.autoState?.idx);
    console.log('[p1chk] After 6s recovery @ 8Mbps (should still be holding):', earlyIdx);
    assert(earlyIdx === downIdx, `Stepped up too fast! Was ${downIdx}, now ${earlyIdx}`);

    await sleep(16500); // total 22.5s stable
    const upIdx = await pageH.evaluate(() => window.__watchTogether.room.media.autoState?.idx);
    console.log('[p1chk] After 22.5s recovery @ 8Mbps, rung idx:', upIdx);
    assert(upIdx > downIdx, `Expected step-up after 20s stable! Remained at ${upIdx}`);

    // 3. Efficiency mode AV1 -> VP9 fallback on CPU struggle
    await pageH.evaluate(() => window.__watchTogether.room.player.deps.media.setMovieQuality('auto', { efficiency: true, sourceFps: 24 }));
    await sleep(1500);
    const effCodecBefore = await pageH.evaluate(() => window.__watchTogether.room.media.movieTracks.codec);
    console.log('[p1chk] Efficiency codec before CPU overload:', effCodecBefore);
    await pageH.evaluate(() => { window.__wtSim.cpuLim = true; });
    await sleep(6000);
    await pageH.evaluate(() => { window.__wtSim.cpuLim = false; });
    const effCodecAfter = await pageH.evaluate(() => ({
      codec: window.__watchTogether.room.media.movieTracks.codec,
      blocked: [...window.__watchTogether.room.media.codecBlocked],
    }));
    console.log('[p1chk] Efficiency codec after CPU overload:', JSON.stringify(effCodecAfter));
    assert(effCodecAfter.blocked.includes(effCodecBefore) && effCodecAfter.codec !== effCodecBefore, 'Expected CPU overload codec fallback');

    // 4. Fixed preset 'high' never auto-downgrades or prompts even at low upload
    await pageH.evaluate(() => window.__watchTogether.room.player.deps.media.setMovieQuality('high', { efficiency: false, sourceFps: 24 }));
    await pageH.evaluate(() => { window.__wtSim.availBps = 900_000; });
    await sleep(6000);
    const fixedState = await pageH.evaluate(() => ({
      quality: window.__watchTogether.room.media.movieTracks.quality,
      enc: window.__watchTogether.room.media.movieTracks.video?.sender?.getParameters()?.encodings,
      toasts: Array.from(document.querySelectorAll('.toast')).map((e) => e.textContent),
    }));
    console.log('[p1chk] Fixed high preset under 900kbps:', JSON.stringify(fixedState));
    assert(fixedState.quality === 'high', `Fixed preset changed to ${fixedState.quality}`);
    assert(!fixedState.toasts.some((t) => /lower.*quality|decrease.*quality/i.test(t)), 'Unexpected prompt to lower quality!');

    console.log('[p1chk] ALL PART 1 HYSTERESIS / FALLBACK / FIXED-PRESET CHECKS PASSED!');
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

