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
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = {
    mode: 'baseline',
    preset: '', // empty = keep current app default
    efficiency: '',
    smoothness: '',
    res: ['720p', '1080p'],
    caps: [1.0, 1.5, 2.0, 3.0],
    duration: 16, // measurement seconds per cap (sampled every 2s)
    warmup: 4,
    out: path.join(__dirname, 'bench_results.json'),
  };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'mode' && v) opts.mode = v;
    if (k === 'preset' && v !== undefined) opts.preset = v;
    if (k === 'efficiency' && v !== undefined) opts.efficiency = v;
    if (k === 'smoothness' && v !== undefined) opts.smoothness = v;
    if (k === 'res' && v) opts.res = v.split(',').map((s) => s.trim());
    if (k === 'caps' && v) opts.caps = v.split(',').map((n) => Number(n));
    if (k === 'duration' && v) opts.duration = Number(v);
    if (k === 'warmup' && v) opts.warmup = Number(v);
    if (k === 'out' && v) opts.out = path.resolve(ROOT, v);
  }
  return opts;
}

function getFfmpegExe() {
  return execFileSync(
    PYTHON_EXE,
    ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'],
    { encoding: 'utf8' }
  ).trim();
}

function ensureTestMovies(ffmpeg) {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  const specs = [
    { key: '720p', width: 1280, height: 720, file: path.join(FIXTURES_DIR, 'bench_720p.mp4') },
    { key: '1080p', width: 1920, height: 1080, file: path.join(FIXTURES_DIR, 'bench_1080p.mp4') },
  ];
  for (const s of specs) {
    if (fs.existsSync(s.file) && fs.statSync(s.file).size > 100_000) continue;
    console.log(`[bench] Generating moving test clip ${s.key} (${s.width}x${s.height} @ 24fps)...`);
    const halfW = s.width / 2;
    const h = s.height;
    // Left half: crisp testsrc2 moving pattern; Right half: organic high-detail cellauto/mandelbrot/hue motion
    const filter = [
      `testsrc2=size=${halfW}x${h}:rate=24:duration=30,format=yuv420p[left]`,
      `mandelbrot=size=${halfW}x${h}:rate=24:maxiter=60,hue=H=t*0.8,format=yuv420p[right]`,
      `[left][right]hstack=inputs=2[v]`,
    ].join(';');
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-filter_complex', filter,
        '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=30',
        '-map', '[v]', '-map', '0:a',
        '-t', '30',
        '-r', '24',
        '-shortest',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-g', '48', '-keyint_min', '24',
        '-c:a', 'aac', '-ac', '2', '-b:a', '128k',
        '-movflags', '+faststart',
        s.file,
      ],
      { stdio: 'pipe' }
    );
  }
  return Object.fromEntries(specs.map((s) => [s.key, s.file]));
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function until(fn, ms = 20000, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(step);
  }
  return null;
}

async function collectStats(hostPage, viewerPage) {
  const host = await hostPage.evaluate(async () => {
    const m = window.__watchTogether?.room?.media;
    const track = m?.movieTracks?.video;
    if (!track) return null;
    const lkStats = (await track.getSenderStats?.()) || [];
    let rawOutbound = [];
    let availableOutgoingBitrate = null;
    let packetLossPct = null;
    if (track.sender?.getStats) {
      const raw = await track.sender.getStats();
      const remoteById = new Map();
      raw.forEach((v) => {
        if (v.type === 'remote-inbound-rtp') remoteById.set(v.id, v);
        if (v.type === 'candidate-pair' && v.state === 'succeeded' && v.availableOutgoingBitrate) {
          availableOutgoingBitrate = v.availableOutgoingBitrate;
        }
      });
      raw.forEach((v) => {
        if (v.type === 'outbound-rtp' && v.kind === 'video') {
          const ri = v.remoteId ? remoteById.get(v.remoteId) : null;
          if (ri && typeof ri.fractionLost === 'number') {
            packetLossPct = +(ri.fractionLost * 100).toFixed(2);
          }
          rawOutbound.push({
            rid: v.rid || '',
            width: v.frameWidth || 0,
            height: v.frameHeight || 0,
            fps: v.framesPerSecond || 0,
            targetBitrate: v.targetBitrate || 0,
            qualityLimitationReason: v.qualityLimitationReason || 'none',
            framesSent: v.framesSent || 0,
            framesEncoded: v.framesEncoded || 0,
            totalEncodeTime: v.totalEncodeTime || 0,
            bytesSent: v.bytesSent || 0,
            codecId: v.codecId || '',
            active: v.active,
          });
        }
      });
    }
    const active = rawOutbound.filter((o) => o.width > 0);
    const top = (active.length ? active : rawOutbound).reduce(
      (a, b) => ((b.width || 0) >= (a.width || 0) ? b : a),
      { width: 0, height: 0, fps: 0, targetBitrate: 0, qualityLimitationReason: 'none', framesSent: 0 }
    );
    const totalTargetBitrate = rawOutbound.reduce((s, o) => s + (o.targetBitrate || 0), 0);
    const totalFramesSent = rawOutbound.reduce((s, o) => s + (o.framesSent || 0), 0);
    const totalBytesSent = rawOutbound.reduce((s, o) => s + (o.bytesSent || 0), 0);
    const lkTop = lkStats.length
      ? lkStats.reduce((a, b) => ((b.frameWidth || 0) >= (a.frameWidth || 0) ? b : a))
      : null;
    return {
      width: lkTop?.frameWidth || top.width,
      height: lkTop?.frameHeight || top.height,
      fps: lkTop?.framesPerSecond ?? top.fps,
      targetBitrate: totalTargetBitrate || lkTop?.targetBitrate || top.targetBitrate,
      qualityLimitationReason: lkTop?.qualityLimitationReason || top.qualityLimitationReason || 'none',
      framesSent: totalFramesSent || lkTop?.framesSent || top.framesSent,
      framesEncoded: top.framesEncoded || 0,
      bytesSent: totalBytesSent,
      availableOutgoingBitrate,
      packetLossPct,
      layerCount: rawOutbound.length,
      preset: m?.movieTracks?.quality || '',
    };
  });

  const viewer = await viewerPage.evaluate(async () => {
    const m = window.__watchTogether?.room?.media;
    const vTrack = m?.state?.movie?.video;
    const aTrack = m?.state?.movie?.audio;
    if (!vTrack) return null;
    const lkRecv = (await vTrack.getReceiverStats?.()) || null;
    let inbound = null;
    let audioJB = null;
    if (vTrack.receiver?.getStats) {
      const raw = await vTrack.receiver.getStats();
      raw.forEach((v) => {
        if (v.type === 'inbound-rtp' && v.kind === 'video') {
          inbound = {
            width: v.frameWidth || 0,
            height: v.frameHeight || 0,
            fps: v.framesPerSecond || 0,
            framesDecoded: v.framesDecoded || 0,
            framesDropped: v.framesDropped || 0,
            framesReceived: v.framesReceived || 0,
            freezeCount: v.freezeCount || 0,
            totalFreezesDuration: v.totalFreezesDuration || 0,
            jitterBufferDelay: v.jitterBufferDelay || 0,
            jitterBufferEmittedCount: v.jitterBufferEmittedCount || 0,
            qpSum: v.qpSum || 0,
            bytesReceived: v.bytesReceived || 0,
          };
        }
      });
    }
    if (aTrack?.receiver?.getStats) {
      const rawA = await aTrack.receiver.getStats();
      rawA.forEach((v) => {
        if (v.type === 'inbound-rtp' && v.kind === 'audio') {
          audioJB = v.jitterBufferEmittedCount ? v.jitterBufferDelay / v.jitterBufferEmittedCount : null;
        }
      });
    }
    return {
      width: inbound?.width ?? lkRecv?.frameWidth ?? 0,
      height: inbound?.height ?? lkRecv?.frameHeight ?? 0,
      fps: inbound?.fps ?? 0,
      framesDecoded: inbound?.framesDecoded ?? lkRecv?.framesDecoded ?? 0,
      framesDropped: inbound?.framesDropped ?? lkRecv?.framesDropped ?? 0,
      freezeCount: inbound?.freezeCount ?? 0,
      totalFreezesDuration: inbound?.totalFreezesDuration ?? 0,
      jitterBufferDelay: inbound?.jitterBufferDelay ?? 0,
      jitterBufferEmittedCount: inbound?.jitterBufferEmittedCount ?? 0,
      audioJbAvgSec: audioJB,
      qpSum: inbound?.qpSum ?? 0,
      bytesReceived: inbound?.bytesReceived ?? lkRecv?.bytesReceived ?? 0,
      jbTargetVideo: vTrack.receiver?.jitterBufferTarget ?? null,
      jbTargetAudio: aTrack?.receiver?.jitterBufferTarget ?? null,
    };
  });

  return { t: Date.now(), host, viewer };
}

async function applySenderCap(hostPage, capBps, { autoEmulate = false } = {}) {
  await hostPage.evaluate(async (bps, emulateAuto) => {
    const r = window.__watchTogether?.room;
    const track = r?.media?.movieTracks?.video;
    const sender = track?.sender;
    if (!sender) throw new Error('No movie sender found');
    window.__wtBenchCapBps = bps;
    window.__wtBenchEmulateUplink = emulateAuto ? bps : 0;

    if (emulateAuto && !sender.__wtStatsPatched) {
      const origGetStats = sender.getStats.bind(sender);
      sender.__wtStatsPatched = true;
      sender.getStats = async () => {
        const report = await origGetStats();
        const limit = window.__wtBenchEmulateUplink;
        if (!limit) return report;
        const fake = [];
        report.forEach((v) => {
          if (v.type === 'candidate-pair' && v.state === 'succeeded') {
            fake.push([v.id, { ...v, availableOutgoingBitrate: Math.min(v.availableOutgoingBitrate || limit, limit) }]);
          } else {
            fake.push([v.id, v]);
          }
        });
        return new Map(fake);
      };
    }

    if (!sender.__wtClamped) {
      const origSet = sender.setParameters.bind(sender);
      sender.__wtClamped = true;
      sender.__origSetParameters = origSet;
      sender.__wtOrigMax = (sender.getParameters().encodings || []).map((e) => e.maxBitrate || 6_000_000);
      sender.setParameters = async (params) => {
        const limit = window.__wtBenchCapBps || bps;
        const cloned = structuredClone(params);
        if (limit > 0 && Array.isArray(cloned.encodings) && cloned.encodings.length) {
          const active = cloned.encodings.filter((e) => e.active !== false);
          if (active.length <= 1) {
            const target = active[0] || cloned.encodings[cloned.encodings.length - 1];
            target.maxBitrate = Math.min(target.maxBitrate || limit, limit);
          } else {
            const totalReq = active.reduce((s, e, idx) => s + (e.maxBitrate || sender.__wtOrigMax[idx] || limit), 0);
            if (totalReq > limit) {
              for (let i = 0; i < cloned.encodings.length; i++) {
                const e = cloned.encodings[i];
                if (e.active === false) continue;
                const req = e.maxBitrate || sender.__wtOrigMax[i] || (limit / active.length);
                e.maxBitrate = Math.max(150_000, Math.floor((req / totalReq) * limit));
              }
            }
          }
        }
        return origSet(cloned);
      };
    }

    if (!emulateAuto) {
      // For fixed presets: clamp from original ceilings
      const p = sender.getParameters();
      if (Array.isArray(p.encodings) && p.encodings.length) {
        for (let i = 0; i < p.encodings.length; i++) {
          if (sender.__wtOrigMax?.[i]) p.encodings[i].maxBitrate = sender.__wtOrigMax[i];
        }
        await sender.setParameters(p);
      }
    }
  }, capBps, autoEmulate);
}

async function clearSenderCap(hostPage) {
  await hostPage.evaluate(() => {
    window.__wtBenchCapBps = 0;
    window.__wtBenchEmulateUplink = 0;
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ffmpeg = getFfmpegExe();
  const movies = ensureTestMovies(ffmpeg);

  const dbPath = path.join(os.tmpdir(), `wt_bench_${Date.now()}.db`);
  const lkPort = 7880;
  const apiPort = 8005;
  const baseUrl = `http://127.0.0.1:${apiPort}`;

  console.log(`[bench] Mode=${opts.mode} Res=${opts.res.join(',')} Caps=${opts.caps.join(',')}Mbps Duration=${opts.duration}s/cap`);
  console.log('[bench] Starting local livekit-server --dev ...');
  const lkProc = spawn(LIVEKIT_EXE, ['--dev', '--bind', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let lkLogs = '';
  lkProc.stdout.on('data', (d) => { lkLogs += d.toString(); });
  lkProc.stderr.on('data', (d) => { lkLogs += d.toString(); });

  await until(async () => {
    try { await fetch(`http://127.0.0.1:${lkPort}`); return true; } catch { return false; }
  }, 15000, 250);

  console.log(`[bench] Starting FastAPI backend on ${baseUrl} ...`);
  const pyEnv = {
    ...process.env,
    APP_ENV: 'development',
    SECRET_KEY: 'bench-secret-key-not-for-production-use-12345',
    DATABASE_URL: `sqlite:///${dbPath.replace(/\\/g, '/')}`,
    LIVEKIT_URL: `ws://127.0.0.1:${lkPort}`,
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret',
    RATE_LIMIT_ENABLED: 'false',
    FRONTEND_DIST: path.join(ROOT, 'frontend', 'dist'),
  };
  const apiProc = spawn(
    PYTHON_EXE,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(apiPort)],
    { cwd: BACKEND_DIR, env: pyEnv, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let apiLogs = '';
  apiProc.stdout.on('data', (d) => { apiLogs += d.toString(); });
  apiProc.stderr.on('data', (d) => { apiLogs += d.toString(); });

  let browser;
  const results = [];

  try {
    await waitForHttp(`${baseUrl}/health`, 20000);
    const health = await (await fetch(`${baseUrl}/health`)).json();
    if (!health.livekit_configured) throw new Error('LiveKit not configured on bench backend');

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      defaultViewport: { width: 1920, height: 1080 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    for (const resKey of opts.res) {
      const movieFile = movies[resKey];
      if (!movieFile) throw new Error(`Unknown res ${resKey}`);
      console.log(`\n=== Benchmarking ${resKey} (${path.basename(movieFile)}) ===`);

      const ctxHost = await browser.createBrowserContext();
      const ctxView = await browser.createBrowserContext();
      const host = await ctxHost.newPage();
      const viewer = await ctxView.newPage();
      host.on('console', (m) => { if (m.type() === 'error') console.error('[host console]', m.text()); });
      host.on('pageerror', (e) => console.error('[host pageerror]', e.message));
      viewer.on('console', (m) => { if (m.type() === 'error') console.error('[viewer console]', m.text()); });

      await host.evaluateOnNewDocument((optsArg) => {
        if (optsArg.preset) localStorage.setItem('wt_quality', optsArg.preset);
        if (optsArg.efficiency !== '') localStorage.setItem('wt_efficiency', optsArg.efficiency);
      }, opts);
      await viewer.evaluateOnNewDocument((optsArg) => {
        if (optsArg.smoothness) localStorage.setItem('wt_smoothness', optsArg.smoothness);
      }, opts);

      await host.goto(baseUrl, { waitUntil: 'networkidle0' });
      await host.waitForSelector('input[aria-label=Nickname]');
      await host.type('input[aria-label=Nickname]', 'BenchHost');
      await host.click('button.primary');
      await host.waitForSelector('form.form');
      await host.type('input[placeholder="Friday movie night"]', `Bench ${resKey}`);
      await host.click('form.form button.primary');
      await host.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 20000 });
      const roomUrl = host.url();

      await viewer.goto(roomUrl, { waitUntil: 'networkidle0' });
      await viewer.waitForSelector('form.form input.input');
      await viewer.type('form.form input.input', 'BenchViewer');
      await viewer.click('form.form button.primary');
      await viewer.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 20000 });

      const fileInput = await host.$('.stage input[type=file]');
      await fileInput.uploadFile(movieFile);
      await host.waitForFunction(() => {
        const r = window.__watchTogether?.room;
        return r?.player?.isStreamer === true && r?.playback?.has_movie === true;
      }, { timeout: 20000 });

      // Ensure loop + start playback
      await host.evaluate(() => {
        const v = window.__watchTogether.room.player.vMovie;
        v.loop = true;
        return v.play();
      });

      await until(async () => {
        const s = await collectStats(host, viewer);
        return s?.viewer?.width > 0 && s?.viewer?.framesDecoded > 10;
      }, 15000);
      await sleep(3000); // let initial LiveKit adaptiveStream/dynacast settle

      const initialDiag = await host.evaluate(() => {
        const sender = window.__watchTogether?.room?.media?.movieTracks?.video?.sender;
        return sender ? sender.getParameters().encodings : null;
      });
      const viewerRect = await viewer.evaluate(() => {
        const v = document.querySelector('.stage video.layer.on');
        const r = v?.getBoundingClientRect();
        return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
      });
      console.log(`  [${resKey}] Initial encodings:`, JSON.stringify(initialDiag), 'Viewer video box:', JSON.stringify(viewerRect));

      for (const capMbps of opts.caps) {
        const capBps = Math.round(capMbps * 1_000_000);
        await applySenderCap(host, capBps, { autoEmulate: opts.preset === 'auto' });
        await sleep(opts.warmup * 1000);

        const startSample = await collectStats(host, viewer);
        const samples = [];
        const steps = Math.max(2, Math.round(opts.duration / 2));
        for (let i = 0; i < steps; i++) {
          await sleep(2000);
          const s = await collectStats(host, viewer);
          samples.push(s);
          const h = s.host || {};
          const v = s.viewer || {};
          const jbMs = v.jitterBufferEmittedCount
            ? ((v.jitterBufferDelay / v.jitterBufferEmittedCount) * 1000).toFixed(0)
            : '-';
          console.log(
            `  [${resKey} @ ${capMbps}M] ${(i + 1) * 2}s | ` +
            `HOST ${h.width}x${h.height}@${Math.round(h.fps || 0)}fps tgt=${Math.round((h.targetBitrate || 0) / 1000)}k lim=${h.qualityLimitationReason} sent=${h.framesSent} | ` +
            `VIEW ${v.width}x${v.height}@${Math.round(v.fps || 0)}fps dec=${v.framesDecoded} drop=${v.framesDropped} frz=${v.freezeCount}(${(v.totalFreezesDuration || 0).toFixed(2)}s) jb=${jbMs}ms qp=${v.qpSum}`
          );
        }
        const endSample = samples[samples.length - 1];
        const elapsedSec = Math.max(1, (endSample.t - startSample.t) / 1000);

        const decDelta = Math.max(0, (endSample.viewer?.framesDecoded || 0) - (startSample.viewer?.framesDecoded || 0));
        const dropDelta = Math.max(0, (endSample.viewer?.framesDropped || 0) - (startSample.viewer?.framesDropped || 0));
        const frzDelta = Math.max(0, (endSample.viewer?.freezeCount || 0) - (startSample.viewer?.freezeCount || 0));
        const frzDurDelta = Math.max(0, (endSample.viewer?.totalFreezesDuration || 0) - (startSample.viewer?.totalFreezesDuration || 0));
        const validViewers = samples.map((s) => s.viewer).filter((v) => v && v.width > 0);
        const avgFps = decDelta / elapsedSec;
        const lastView = validViewers[validViewers.length - 1] || {};
        const freezesPerMin = (frzDelta / elapsedSec) * 60;
        const denom = decDelta + dropDelta;
        const droppedPct = denom > 0 ? (dropDelta / denom) * 100 : 0;

        results.push({
          source: resKey,
          capMbps,
          delivered: `${lastView.width || 0}x${lastView.height || 0}`,
          deliveredHeight: lastView.height || 0,
          fps: +avgFps.toFixed(1),
          freezesPerMin: +freezesPerMin.toFixed(2),
          freezeCount: frzDelta,
          freezeSec: +frzDurDelta.toFixed(2),
          droppedPct: +droppedPct.toFixed(2),
          hostRes: `${endSample.host?.width || 0}x${endSample.host?.height || 0}`,
          hostFps: +(endSample.host?.fps || 0).toFixed(1),
          hostTargetKbps: Math.round((endSample.host?.targetBitrate || 0) / 1000),
          hostPreset: endSample.host?.preset || opts.preset || 'default',
          jbTargetVideo: endSample.viewer?.jbTargetVideo ?? null,
          jbTargetAudio: endSample.viewer?.jbTargetAudio ?? null,
          samples,
        });
      }

      await clearSenderCap(host);
      await ctxHost.close();
      await ctxView.close();
    }

    console.log('\n=== SUMMARY TABLE ===');
    console.table(
      results.map((r) => ({
        source: r.source,
        cap_Mbps: r.capMbps,
        delivered: r.delivered,
        fps: r.fps,
        freezes_per_min: r.freezesPerMin,
        dropped_pct: r.droppedPct,
        host_kbps: r.hostTargetKbps,
      }))
    );

    fs.writeFileSync(opts.out, JSON.stringify({ opts, packetShaping: 'None (Clumsy not installed; RTCRtpSender maxBitrate cap used)', results }, null, 2));
    console.log(`[bench] Saved results to ${opts.out}`);
  } finally {
    await browser?.close().catch(() => {});
    try { apiProc.kill('SIGKILL'); } catch {}
    try { lkProc.kill('SIGKILL'); } catch {}
    try { fs.unlinkSync(dbPath); } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
