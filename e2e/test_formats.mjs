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

function getFfmpegExe() {
  return execFileSync(
    PYTHON_EXE,
    ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],
    { encoding: 'utf8' }
  ).trim();
}

function ensureFormatFixtures(ffmpeg) {
  fs.mkdirSync(FORMATS_DIR, { recursive: true });
  const specs = [
    {
      name: '01_mp4_h264_aac.mp4',
      label: 'MP4 (H.264 + AAC)',
      expectTier: 0,
      hasAudio: true,
      args: [
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ac', '2', '-b:a', '96k', '-movflags', '+faststart',
      ],
    },
    {
      name: '02_webm_vp9_opus.webm',
      label: 'WebM (VP9 + Opus)',
      expectTier: 0,
      hasAudio: true,
      args: [
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
        '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '600k',
        '-c:a', 'libopus', '-ac', '2', '-b:a', '96k',
      ],
    },
    {
      name: '03_mkv_h264_ac3_51.mkv',
      label: 'MKV (H.264 + AC3 5.1)',
      expectTier: 1,
      expectPlan: 'audio_transcode',
      hasAudio: true,
      args: [
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'ac3', '-ac', '6', '-b:a', '192k',
      ],
    },
    {
      name: '04_mkv_h264_eac3.mkv',
      label: 'MKV (H.264 + EAC3)',
      expectTier: 1,
      expectPlan: 'audio_transcode',
      hasAudio: true,
      args: [
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=392:sample_rate=48000:duration=6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'eac3', '-ac', '6', '-b:a', '192k',
      ],
    },
    {
      name: '05_mkv_hevc_aac.mkv',
      label: 'MKV (HEVC + AAC)',
      expectTier: 1,
      expectPlan: 'full_transcode',
      hasAudio: true,
      args: [
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=6',
        '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ac', '2', '-b:a', '96k',
      ],
    },
    {
      name: '06_avi_mpeg4_mp3.avi',
      label: 'AVI (MPEG-4 + MP3)',
      expectTier: 1,
      expectPlan: 'full_transcode',
      hasAudio: true,
      args: [
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=587:sample_rate=48000:duration=6',
        '-c:v', 'mpeg4', '-q:v', '6',
        '-c:a', 'libmp3lame', '-ac', '2', '-b:a', '128k',
      ],
    },
    {
      name: '07_dual_audio.mkv',
      label: 'Dual-Audio MKV (ENG AC3 + JPN AAC)',
      expectTier: 1,
      expectPlan: 'remux',
      hasAudio: true,
      dualAudio: true,
      args: [
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=6',
        '-map', '0:v', '-map', '1:a', '-map', '2:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a:0', 'ac3', '-ac:0', '2', '-b:a:0', '128k', '-metadata:s:a:0', 'language=eng',
        '-c:a:1', 'aac', '-ac:1', '2', '-b:a:1', '96k', '-metadata:s:a:1', 'language=jpn',
      ],
    },
    {
      name: '08_no_audio.mp4',
      label: 'MP4 (H.264, no audio)',
      expectTier: 0,
      hasAudio: false,
      args: [
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
        '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
      ],
    },
    {
      name: '09_mkv_h264_aac_remux.mkv',
      label: 'MKV (H.264 + AAC remux)',
      expectTier: 1,
      expectPlan: 'remux',
      hasAudio: true,
      args: [
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ac', '2', '-b:a', '96k',
      ],
    },
    {
      name: '10_mkv_vp9_opus.mkv',
      label: 'MKV (VP9 + Opus remux)',
      expectTier: 1,
      expectPlan: 'remux',
      hasAudio: true,
      args: [
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=6',
        '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '500k',
        '-c:a', 'libopus', '-ac', '2', '-b:a', '96k',
      ],
    },
    {
      name: '11_long_hevc_1080p.mkv',
      label: 'Long 90s 1080p MKV (HEVC + AAC)',
      expectTier: 1,
      expectPlan: 'full_transcode',
      playWhileConverting: true,
      hasAudio: true,
      args: [
        '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24:duration=90',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=90',
        '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ac', '2', '-b:a', '96k',
      ],
    },
  ];

  for (const s of specs) {
    s.file = path.join(FORMATS_DIR, s.name);
    if (fs.existsSync(s.file) && fs.statSync(s.file).size > 5000) continue;
    console.log(`[formats] Generating ${s.name} ...`);
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...s.args, s.file], { stdio: 'pipe' });
  }
  return specs;
}

async function main() {
  const ffmpeg = getFfmpegExe();
  const specs = ensureFormatFixtures(ffmpeg);

  const dbPath = path.join(os.tmpdir(), `wt_formats_${Date.now()}.db`);
  const lkPort = 7880;
  const apiPort = 8008;
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
        SECRET_KEY: 'formats-test-secret-key-not-for-prod-12345',
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
  const summary = [];
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
    pageH.on('pageerror', (e) => console.log('[pageH error]', e.message));
    pageH.on('console', (m) => { if (['error', 'warn', 'warning'].includes(m.type())) console.log(`[pageH ${m.type()}]`, m.text()); });
    await pageH.exposeFunction('__logToast', (msg) => console.log('[pageH toast]', msg));
    await pageH.goto(baseUrl, { waitUntil: 'networkidle0' });
    await pageH.evaluate(() => {
      const obs = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.classList?.contains('toast')) window.__logToast(n.textContent);
        }
      });
      const attachObs = () => {
        const host = document.querySelector('.toasts');
        if (host) obs.observe(host, { childList: true });
        else setTimeout(attachObs, 200);
      };
      attachObs();
    });
    await pageH.type('input[aria-label="Nickname"]', 'FormatHost');
    await pageH.click('button.primary');
    await pageH.waitForSelector('form.form');
    await pageH.type('input[placeholder="Friday movie night"]', 'Format Matrix Test');
    await pageH.click('form.form button.primary');
    await pageH.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 20000 });
    const roomUrl = pageH.url();

    const ctxV = await browser.createBrowserContext();
    const pageV = await ctxV.newPage();
    await pageV.goto(roomUrl, { waitUntil: 'networkidle0' });
    await pageV.waitForSelector('form.form input.input');
    await pageV.type('form.form input.input', 'FormatViewer');
    await pageV.click('form.form button.primary');
    await pageV.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 20000 });

    for (const s of specs) {
      console.log(`\n[formats] === Testing ${s.label} ===`);
      const fileInput = await pageH.$('.stage input[type=file]');
      await fileInput.uploadFile(s.file);

      if (s.dualAudio) {
        await pageH.waitForSelector('.dialog h2', { timeout: 20000 });
        const opts = await pageH.$$eval('.dialog select option', (els) => els.map((e) => e.textContent.trim()));
        console.log('[formats] Track dialog options:', opts);
        assert(opts.length >= 2, `Expected >=2 audio tracks in picker, got ${opts.length}`);
        // Pick second audio track (JPN AAC)
        const secondVal = await pageH.$eval('.dialog select option:nth-child(2)', (e) => e.value);
        await pageH.select('.dialog select', secondVal);
        await pageH.click('.dialog-actions button.primary');
      }

      try {
        await pageH.waitForFunction(() => {
          const p = window.__watchTogether?.room?.player;
          return p?.isStreamer === true && window.__watchTogether?.room?.playback?.has_movie === true;
        }, { timeout: 25000 });
      } catch (e) {
        const diag = await pageH.evaluate(() => ({
          toasts: Array.from(document.querySelectorAll('.toast')).map((x) => x.textContent),
          busy: document.querySelector('.stage-busy')?.textContent,
          tier: window.__watchTogether?.room?.player?.tier,
          probe: window.__watchTogether?.room?.player?.mediaProbe,
          src: window.__watchTogether?.room?.player?.vMovie?.currentSrc,
        }));
        console.error('[formats] Host wait timeout diag:', JSON.stringify(diag));
        throw e;
      }

      // Loop & play so WebRTC receives frames continuously
      await pageH.evaluate(() => {
        const v = window.__watchTogether.room.player.vMovie;
        v.loop = true;
        return v.play();
      });

      if (s.playWhileConverting) {
        const mid = await pageH.evaluate(() => {
          const p = window.__watchTogether.room.player;
          return {
            status: p.convInfo?.status,
            convertedSec: p.convertedSec,
            dur: p.duration(),
            speedX: p.convInfo?.speed_x,
            etaSec: p.convInfo?.eta_sec,
            timelineDataset: p.timeline.dataset.convertedSec,
          };
        });
        console.log('[formats] Play-while-converting right at playback start:', JSON.stringify(mid));
        assert(mid.dur >= 85, `Expected full duration >=85s immediately during conversion, got ${mid.dur}`);
        assert(mid.status === 'processing' && mid.convertedSec !== null && mid.convertedSec < mid.dur - 10,
          `Expected active play-while-converting with convertedSec < dur, got ${JSON.stringify(mid)}`);
        // Verify seeking beyond converted range clamps inside converted range
        await pageH.evaluate((d) => window.__watchTogether.room.player.seekTo(d - 2), mid.dur);
        await sleep(300);
        const clamped = await pageH.evaluate(() => ({
          pos: window.__watchTogether.room.player.vMovie.currentTime,
          conv: window.__watchTogether.room.player.convertedSec,
        }));
        assert(clamped.pos <= (clamped.conv ?? mid.dur) + 1.0, `Expected clamped seek <= convertedSec, got ${JSON.stringify(clamped)}`);
        console.log(`[formats] Verified forward seek clamped to ${clamped.pos.toFixed(2)}s (convertedSec=${clamped.conv}s)`);
        // Rewind to beginning for standard frame/audio checks
        await pageH.evaluate(() => window.__watchTogether.room.player.seekTo(0.5));
      }

      // Wait for viewer video frames
      await until(async () => {
        const st = await pageV.evaluate(() => window.__watchTogether?.room?.media?.movieReceiveStats?.());
        return st && st.width > 0 && st.framesDecoded > 5;
      }, 20000, 300);

      // Test seeking on host video
      await pageH.evaluate(() => {
        window.__watchTogether.room.player.seekTo(2.5);
      });
      await sleep(700);
      const afterSeek = await pageH.evaluate(() => window.__watchTogether.room.player.vMovie.currentTime);
      assert(afterSeek >= 2.0, `${s.name}: seek to 2.5s failed (got ${afterSeek})`);

      // Measure audio RMS on viewer when track has audio
      let rms = 0;
      if (s.hasAudio) {
        await until(async () => {
          const hasA = await pageV.evaluate(() => !!window.__watchTogether?.room?.media?.state?.movie?.audio?.mediaStreamTrack);
          return hasA;
        }, 12000, 200);
        rms = await pageV.evaluate(async () => {
          const t = window.__watchTogether.room.media.state.movie.audio.mediaStreamTrack;
          const ctx = new AudioContext();
          await ctx.resume();
          const src = ctx.createMediaStreamSource(new MediaStream([t]));
          const an = ctx.createAnalyser();
          an.fftSize = 1024;
          src.connect(an);
          const buf = new Float32Array(an.fftSize);
          let peak = 0;
          for (let i = 0; i < 12; i++) {
            await new Promise((r) => setTimeout(r, 100));
            an.getFloatTimeDomainData(buf);
            let sq = 0;
            for (let k = 0; k < buf.length; k++) sq += buf[k] * buf[k];
            peak = Math.max(peak, Math.sqrt(sq / buf.length));
          }
          await ctx.close();
          return peak;
        });
        assert(rms > 0.005, `${s.name}: expected viewer audio RMS > 0.005, got ${rms.toFixed(5)}`);
      } else {
        const toastTexts = await pageH.$$eval('.toasts .toast', (els) => els.map((e) => e.textContent));
        assert(toastTexts.some((t) => /no audio/i.test(t)), `${s.name}: expected honest no-audio warning toast, got ${JSON.stringify(toastTexts)}`);
      }

      const hostInfo = await pageH.evaluate(() => {
        const p = window.__watchTogether.room.player;
        return {
          tier: p.tier,
          convInfo: p.convInfo,
          convertedSec: p.convertedSec,
          dur: p.duration(),
        };
      });
      assert(hostInfo.tier === s.expectTier, `${s.name}: expected tier ${s.expectTier}, got ${hostInfo.tier}`);
      if (s.expectPlan) {
        assert(hostInfo.convInfo?.plan === s.expectPlan, `${s.name}: expected plan ${s.expectPlan}, got ${hostInfo.convInfo?.plan}`);
      }

      if (s.playWhileConverting) {
        // Wait for conversion to finish cleanly and extend timeline
        await pageH.waitForFunction(() => {
          const p = window.__watchTogether?.room?.player;
          return p?.convInfo?.status === 'ready' && p?.convertedSec === null;
        }, { timeout: 30000 });
        await pageH.evaluate((d) => window.__watchTogether.room.player.seekTo(d - 4), hostInfo.dur);
        await until(async () => (await pageH.evaluate(() => window.__watchTogether.room.player.vMovie.currentTime)) >= hostInfo.dur - 6, 8000, 150);
        const fullSeekPos = await pageH.evaluate(() => window.__watchTogether.room.player.vMovie.currentTime);
        console.log(`[formats] Full timeline unlocked on ready; seeked to ${fullSeekPos.toFixed(2)}s`);
      }

      const finalConv = await pageH.evaluate(() => window.__watchTogether.room.player.convInfo);
      const recv = await pageV.evaluate(() => window.__watchTogether.room.media.movieReceiveStats());
      summary.push({
        format: s.label,
        tier: hostInfo.tier,
        plan: finalConv?.plan || 'native',
        encoder: finalConv?.encoder || '-',
        elapsedSec: finalConv?.elapsed_sec ?? '-',
        speedX: finalConv?.speed_x ? `${finalConv.speed_x}x` : '-',
        viewerRes: `${recv.width}x${recv.height}`,
        seekPos: Number(afterSeek.toFixed(2)),
        audioRms: Number(rms.toFixed(4)),
      });
      console.log(`[formats] PASS ${s.label}: tier=${hostInfo.tier}, plan=${finalConv?.plan || 'native'}, enc=${finalConv?.encoder || '-'}, time=${finalConv?.elapsed_sec ?? '-'}s (${finalConv?.speed_x ?? '-'}x), viewer=${recv.width}x${recv.height}, rms=${rms.toFixed(4)}`);

      // Stop movie cleanly before next fixture
      await pageH.evaluate(() => window.__watchTogether.room.player.stopMovie(true));
      await until(async () => pageH.evaluate(() => !window.__watchTogether.room.player.isStreamer && !window.__watchTogether.room.playback?.has_movie), 10000);
      await sleep(500);
    }

    console.log('\n=== FORMAT MATRIX SUMMARY ===');
    console.table(summary);
    console.log(`[formats] ALL ${specs.length} FORMAT TESTS PASSED!`);
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
