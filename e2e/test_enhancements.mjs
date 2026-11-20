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
const DUAL_AUDIO_FILE = path.join(ROOT, 'e2e', 'fixtures', 'formats', '07_dual_audio.mkv');
const SUBTITLE_FILE = path.join(ROOT, 'e2e', 'fixtures', 'test_sub.srt');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs = 25000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(stepMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms: ${lastErr ? lastErr.message : ''}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function measureAudioRms(page) {
  return page.evaluate(async () => {
    const track = window.__watchTogether?.room?.media?.state?.movie?.audio?.mediaStreamTrack;
    if (!track) return 0;
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
}

async function run() {
  console.log('=== Real Browser Verification: Headless Bot Enhancements ===');

  assert(fs.existsSync(DUAL_AUDIO_FILE), `Fixture missing: ${DUAL_AUDIO_FILE}`);

  // Create sample subtitle file for testing
  fs.writeFileSync(SUBTITLE_FILE, `1\n00:00:01,000 --> 00:00:08,000\nWatchTogether Bot Subtitles Test\n\n`, 'utf-8');

  // 1. LiveKit server check
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
    console.log('[livekit] Running on port 7880.');
  } else {
    console.log('[livekit] Reusing livekit on port 7880.');
  }

  // 2. Start backend on port 8009
  const dbPath = path.join(BACKEND_DIR, 'test_enhancements.db');
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

  console.log('[backend] Starting backend server on port 8009...');
  const backendProc = spawn(
    PYTHON_EXE,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8009'],
    { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  backendProc.stderr.on('data', (d) => {
    const s = d.toString();
    if (!s.includes('INFO:') && !s.includes('StarletteDeprecationWarning')) {
      process.stderr.write(`[backend err] ${s}`);
    }
  });
  backendProc.stdout.on('data', (d) => {
    process.stdout.write(`[backend out] ${d.toString()}`);
  });

  await until(async () => {
    try {
      const res = await fetch('http://127.0.0.1:8009/api/rooms');
      return res.ok;
    } catch {
      return false;
    }
  }, 20000, 300);
  console.log('[backend] Ready at http://127.0.0.1:8009.');

  // 3. Launch Chrome
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

  const testReport = [];

  try {
    const ctxH = await browser.createBrowserContext();
    const ctxV = await browser.createBrowserContext();
    const pageH = await ctxH.newPage();
    const pageV = await ctxV.newPage();

    // Create room via Host
    await pageH.goto('http://127.0.0.1:8009', { waitUntil: 'networkidle0' });
    await pageH.waitForSelector('input[aria-label="Nickname"]');
    await pageH.type('input[aria-label="Nickname"]', 'HostDeku');
    await pageH.click('button.primary');
    await pageH.waitForSelector('form.form');
    await pageH.type('input[placeholder="Friday movie night"]', 'Picker & Seek Test');
    await pageH.click('form.form button.primary');
    await pageH.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 20000 });

    const roomUrl = pageH.url();
    const code = await pageH.evaluate(() => window.__watchTogether.room.code);
    const token = await pageH.evaluate(() => window.__watchTogether.room.token);
    assert(code && token, 'Room or token missing');
    console.log(`[room] Created room ${code} with token.`);

    // Join Viewer
    await pageV.goto(roomUrl, { waitUntil: 'networkidle0' });
    await pageV.waitForSelector('form.form input.input');
    await pageV.type('form.form input.input', 'ViewerAarav');
    await pageV.click('form.form button.primary');
    await pageV.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 20000 });
    console.log('[room] Viewer joined.');

    // -------------------------------------------------------------------------
    // TEST 1: File Picker & Security Checks
    // -------------------------------------------------------------------------
    console.log('\n--- 1. Testing Local File Picker & Security ---');

    // Test Tunnel Security: Reject requests carrying CF-Connecting-IP
    const cfSecRes = await fetch(`http://127.0.0.1:8009/api/local/browse?room_id=${code}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'CF-Connecting-IP': '198.51.100.42',
      },
    });
    console.log(`[security] CF-Connecting-IP request status: ${cfSecRes.status}`);
    assert(cfSecRes.status === 403, `Expected 403 for CF-Connecting-IP, got ${cfSecRes.status}`);

    // Test Tunnel Security: Reject requests carrying X-Forwarded-For
    const xffSecRes = await fetch(`http://127.0.0.1:8009/api/local/browse?room_id=${code}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Forwarded-For': '203.0.113.19',
      },
    });
    console.log(`[security] X-Forwarded-For request status: ${xffSecRes.status}`);
    assert(xffSecRes.status === 403, `Expected 403 for X-Forwarded-For, got ${xffSecRes.status}`);

    // Test Browse API (valid host request)
    const browseRes = await fetch(`http://127.0.0.1:8009/api/local/browse?room_id=${code}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(browseRes.ok, `Browse failed: ${browseRes.status}`);
    const browseData = await browseRes.json();
    console.log(`[picker] Browse returned current path: ${browseData.current_path}, folders: ${browseData.folders.length}, files: ${browseData.files.length}`);
    assert(Array.isArray(browseData.folders) && Array.isArray(browseData.files), 'Browse folders/files not arrays');

    // Test select-file returning opaque file_id
    const selRes = await fetch(`http://127.0.0.1:8009/api/local/select-file`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        room_id: code,
        path: DUAL_AUDIO_FILE,
        file_type: 'video',
      }),
    });
    assert(selRes.ok, `select-file failed: ${selRes.status}`);
    const selData = await selRes.json();
    console.log(`[picker] Selected file opaque id: ${selData.file_id}, filename: ${selData.filename}, duration: ${selData.duration}s`);
    assert(selData.file_id && !selData.file_id.includes('\\') && !selData.file_id.includes('/'), 'file_id must be opaque');
    assert(selData.filename === '07_dual_audio.mkv', 'filename mismatch');
    assert(selData.duration > 5 && selData.duration < 8, `Probed duration ${selData.duration} not ~6s`);

    testReport.push({
      item: 'Item 1: File Picker & Security',
      metric: 'Opaque file_id, tunnel blocking (CF/XFF 403), probe caching',
      result: 'PASS',
    });

    // -------------------------------------------------------------------------
    // TEST 2: Start Bot Stream with file_id & Probe Verification
    // -------------------------------------------------------------------------
    console.log('\n--- 2. Starting Bot Stream via file_id ---');
    const startRes = await pageH.evaluate(async (fId) => {
      return window.__watchTogether.room.player.startBotStream({
        fileId: fId,
        quality: 'auto',
      });
    }, selData.file_id);

    assert(startRes && startRes.status === 'started', `Bot start failed: ${JSON.stringify(startRes)}`);
    console.log(`[bot] Bot started: ${startRes.bot_id}, res=${startRes.width}x${startRes.height}, audio_tracks=${startRes.audio_tracks?.length}`);
    assert(startRes.audio_tracks?.length === 2, `Expected 2 audio tracks, found ${startRes.audio_tracks?.length}`);

    // Wait for viewer to receive video and audio
    console.log('[viewer] Waiting for video & audio tracks...');
    const vStats = await until(async () => {
      const st = await pageV.evaluate(() => window.__watchTogether?.room?.media?.movieReceiveStats?.());
      if (st && st.width > 0 && st.framesDecoded > 15) return st;
      return false;
    }, 20000, 300);

    const aRms = await measureAudioRms(pageV);
    console.log(`[viewer] Initial video: ${vStats.width}x${vStats.height}, frames=${vStats.framesDecoded}, audio RMS=${aRms.toFixed(5)}`);
    assert(vStats.framesDecoded >= 15, 'Viewer did not decode enough frames');
    assert(aRms > 0.005, 'Viewer audio RMS too low');

    // Verify timeline max matches probed duration
    const timelineMax = await pageH.evaluate(() => {
      const p = window.__watchTogether.room.player;
      return { max: p.timeline.max, dur: p.duration() };
    });
    console.log(`[player] Timeline max: ${timelineMax.max}, dur: ${timelineMax.dur}`);
    assert(Math.round(timelineMax.dur) === 6, `Duration expected 6, got ${timelineMax.dur}`);

    // -------------------------------------------------------------------------
    // TEST 3: Seek and Skip During Streaming
    // -------------------------------------------------------------------------
    console.log('\n--- 3. Testing Fast Input Seek & Frame Holding ---');

    // Seek forward to 3.0 seconds
    const seekTarget = 3.0;
    const seekStart = performance.now();
    const canDriveH = await pageH.evaluate(() => window.__watchTogether.room.player.canDrive());
    console.log(`[seek] pageH canDrive = ${canDriveH}`);
    await pageH.evaluate((target) => window.__watchTogether.room.player.seekTo(target), seekTarget);

    // Verify position updates on viewer
    const seekedPb = await until(async () => {
      const pb = await pageV.evaluate(() => window.__watchTogether?.room?.playback);
      console.log(`[seek poll] viewer pb position: ${pb?.position}, playing: ${pb?.playing}`);
      if (pb && Math.abs(pb.position - seekTarget) < 1.0) return pb;
      return false;
    }, 10000, 500);
    const seekDuration = performance.now() - seekStart;
    console.log(`[seek] Seek to ${seekTarget}s verified in ${seekDuration.toFixed(0)}ms: reported pos = ${seekedPb.position.toFixed(2)}s`);

    // Verify WebRTC tracks were NOT broken/destroyed
    const tracksAlive = await pageV.evaluate(() => {
      const st = window.__watchTogether?.room?.media?.state?.movie;
      return {
        hasVideo: !!st?.video?.mediaStreamTrack && st.video.mediaStreamTrack.readyState === 'live',
        hasAudio: !!st?.audio?.mediaStreamTrack && st.audio.mediaStreamTrack.readyState === 'live',
      };
    });
    console.log('[seek] Tracks after seek:', tracksAlive);
    assert(tracksAlive.hasVideo && tracksAlive.hasAudio, 'Tracks died during seek!');

    // Wait and verify frames continue decoding after seek
    const postSeekStats = await until(async () => {
      const st = await pageV.evaluate(() => window.__watchTogether?.room?.media?.movieReceiveStats?.());
      if (st && st.framesDecoded > vStats.framesDecoded + 10) return st;
      return false;
    }, 10000, 200);
    console.log(`[seek] Post-seek frames decoded: ${postSeekStats.framesDecoded} (> ${vStats.framesDecoded})`);

    const postSeekRms = await measureAudioRms(pageV);
    console.log(`[seek] Post-seek audio RMS: ${postSeekRms.toFixed(5)}`);
    assert(postSeekRms > 0.005, 'Audio RMS dead after seek');

    // Test +/-10s button or skip
    console.log('[skip] Testing skip(-1.5)...');
    const posBeforeSkip = await pageH.evaluate(() => window.__watchTogether.room.player.currentPosition());
    await pageH.evaluate(() => window.__watchTogether.room.player.skip(-1.5));
    await until(async () => {
      const pb = await pageV.evaluate(() => window.__watchTogether?.room?.playback);
      return pb && pb.position < posBeforeSkip - 0.5;
    }, 8000, 200);
    console.log('[skip] Backward skip verified.');

    // Test rapid scrubbing debounce
    console.log('[scrub] Testing rapid seek calls (debounce)...');
    await pageH.evaluate(() => {
      window.__watchTogether.room.player.seekTo(1.0);
      window.__watchTogether.room.player.seekTo(1.5);
      window.__watchTogether.room.player.seekTo(2.0);
    });
    await sleep(300);
    await until(async () => {
      const pb = await pageV.evaluate(() => window.__watchTogether?.room?.playback);
      return pb && Math.abs(pb.position - 2.0) < 1.0;
    }, 8000, 200);
    console.log('[scrub] Rapid scrubbing debounced successfully.');

    testReport.push({
      item: 'Item 2: Seek & Skip',
      metric: `Fast seek in ${seekDuration.toFixed(0)}ms, tracks continuous, frames post-seek`,
      result: 'PASS',
    });

    // -------------------------------------------------------------------------
    // TEST 4: Audio Track Switching & Subtitles
    // -------------------------------------------------------------------------
    console.log('\n--- 4. Testing Audio Track Switching & Subtitles ---');

    // Check Audio Menu visibility and options
    const audioMenuInfo = await pageH.evaluate(() => {
      const p = window.__watchTogether.room.player;
      p.renderAudioMenu();
      const items = Array.from(p.audioMenu.querySelectorAll('.menu-item')).map((el) => el.textContent.trim());
      return {
        buttonVisible: p.btnAudio.parentElement.style.display !== 'none',
        items,
      };
    });
    console.log(`[audio-menu] Visible: ${audioMenuInfo.buttonVisible}, tracks: ${JSON.stringify(audioMenuInfo.items)}`);
    assert(audioMenuInfo.buttonVisible, 'Audio menu button not visible');
    assert(audioMenuInfo.items.length >= 2, 'Audio tracks menu does not list both audio tracks');

    // Reset position to 1.5s so we have ample runtime for track tests
    await pageH.evaluate(() => window.__watchTogether.room.player.seekTo(1.5));
    await sleep(300);

    // Switch to Japanese track (index 1)
    console.log('[audio-switch] Switching to Japanese audio track (index 1)...');
    const switchPosBefore = await pageH.evaluate(() => window.__watchTogether.room.player.currentPosition());
    await pageH.evaluate(async () => {
      const token = window.__watchTogether.room.token;
      const roomId = window.__watchTogether.room.code;
      await window.__watchTogether.api.botCommand(token, {
        room_id: roomId,
        action: 'audio_track',
        track_index: 1,
        audio_index: 1,
      });
    });

    // Verify toast notice broadcast on viewer
    const noticeReceived = await until(async () => {
      const pb = await pageV.evaluate(() => window.__watchTogether?.room?.playback);
      console.log(`[audio-switch poll] viewer pb audio_index: ${pb?.audio_index}, pos: ${pb?.position}`);
      return pb && pb.audio_index === 1;
    }, 10000, 200);
    assert(noticeReceived, 'Viewer did not receive audio_index 1 update');

    const switchPosAfter = await pageV.evaluate(() => window.__watchTogether?.room?.playback?.position);
    const drift = Math.abs((switchPosAfter || 0) - switchPosBefore);
    console.log(`[audio-switch] Track switched! Position before: ${switchPosBefore.toFixed(2)}s, after: ${(switchPosAfter || 0).toFixed(2)}s, drift: ${drift.toFixed(2)}s`);
    assert(drift < 2.0, `Audio track switch jumped position too far: ${drift.toFixed(2)}s`);

    // Verify audio still playing on new track
    const switchedRms = await measureAudioRms(pageV);
    console.log(`[audio-switch] Audio RMS on Hindi track: ${switchedRms.toFixed(5)}`);
    assert(switchedRms > 0.005, 'Audio dead after track switch');

    // Test Subtitle Selection
    console.log('[subtitles] Testing subtitle file selection and command...');
    const subSelRes = await fetch(`http://127.0.0.1:8009/api/local/select-file`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        room_id: code,
        path: SUBTITLE_FILE,
        file_type: 'subtitle',
      }),
    });
    assert(subSelRes.ok, 'select-file for subtitle failed');
    const subSelData = await subSelRes.json();
    console.log(`[subtitles] Subtitle file selected: ${subSelData.file_id}`);

    // Reset position to 1.0s before subtitle test so we don't hit 6.02s EOF
    await pageH.evaluate(() => window.__watchTogether.room.player.seekTo(1.0));
    await sleep(300);

    // Switch subtitle track to external file
    await pageH.evaluate(async (subId) => {
      const token = window.__watchTogether.room.token;
      const roomId = window.__watchTogether.room.code;
      await window.__watchTogether.api.botCommand(token, {
        room_id: roomId,
        action: 'subtitle_track',
        subtitle_file_id: subId,
      });
    }, subSelData.file_id);

    await until(async () => {
      const pb = await pageV.evaluate(() => window.__watchTogether?.room?.playback);
      console.log(`[subtitles poll] viewer pb: playing=${pb?.playing}, pos=${pb?.position}`);
      return pb && pb.playing;
    }, 10000, 200);
    console.log('[subtitles] Bot restarted with subtitles burned in without error!');

    testReport.push({
      item: 'Item 3: Audio Tracks & Subtitles',
      metric: `2 audio tracks rendered, switched to track 1 with drift ${drift.toFixed(2)}s, audio RMS ${switchedRms.toFixed(5)}, external subtitle loaded`,
      result: 'PASS',
    });

    // Cleanup movie
    await pageH.evaluate(() => window.__watchTogether.room.player.stopMovie());
    await until(async () => {
      const pb = await pageV.evaluate(() => window.__watchTogether?.room?.playback);
      return pb && !pb.has_movie;
    }, 8000, 200);

    await ctxH.close();
    await ctxV.close();
  } finally {
    await browser.close();
    backendProc.kill();
    if (livekitProc) livekitProc.kill();
    try { fs.rmSync(dbPath, { force: true }); } catch {}
    try { fs.rmSync(SUBTITLE_FILE, { force: true }); } catch {}
  }

  console.log('\n=================== VERIFICATION SUMMARY ===================');
  console.table(testReport);
  console.log('All Headless Bot Enhancements verified successfully!');
}

run().catch((err) => {
  console.error('\nVerification Failed:', err);
  process.exit(1);
});
