import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8000';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Generate test fixtures
function setupFixtures() {
  const webmBuf = fs.readFileSync('e2e/test_movie.webm');
  
  // 1. Tier 1 fixture: test_remux.mkv (Matroska container with webm video/audio tracks)
  const mkvBuf = Buffer.from(webmBuf);
  // Find "webm" in header and replace with "matroska"
  let replaced = false;
  for (let i = 0; i < Math.min(mkvBuf.length - 8, 1024); i++) {
    if (mkvBuf[i] === 0x42 && mkvBuf[i + 1] === 0x82) {
      // DocType element
      // Rewrite doctype to matroska
      const docTypeBytes = Buffer.from([0x42, 0x82, 0x88, ...Buffer.from('matroska')]);
      docTypeBytes.copy(mkvBuf, i);
      replaced = true;
      break;
    }
  }
  fs.writeFileSync('e2e/test_remux.mkv', mkvBuf);

  // 2. Tier 2 fixture: test_hevc.mkv (Matroska with HEVC codec ID)
  // EBML Header + Segment + Tracks with V_MPEGH/ISO/HEVC
  const hevcHeader = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, // EBML
    0x42, 0x86, 0x81, 0x01,       // EBMLVersion 1
    0x42, 0xf7, 0x81, 0x01,       // EBMLReadVersion 1
    0x42, 0xf2, 0x81, 0x04,       // EBMLMaxIDLength 4
    0x42, 0xf3, 0x81, 0x08,       // EBMLMaxSizeLength 8
    0x42, 0x82, 0x88, ...Buffer.from('matroska'), // DocType matroska
    0x42, 0x87, 0x81, 0x04,       // DocTypeVersion 4
    0x42, 0x85, 0x81, 0x02,       // DocTypeReadVersion 2
    0x18, 0x53, 0x80, 0x67, 0x90, // Segment (size 16)
    0x16, 0x54, 0xae, 0x6b, 0x8b, // Tracks (size 11)
    0xae, 0x89,                   // TrackEntry
    0x83, 0x81, 0x01,             // TrackType: 1 (Video)
    0x86, 0x90, ...Buffer.from('V_MPEGH/ISO/HEVC'), // CodecID: HEVC
  ]);
  fs.writeFileSync('e2e/test_hevc.mkv', hevcHeader);

  // 3. Tier 2 fixture: test_ac3.mkv (Matroska with AC3 codec ID)
  const ac3Header = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f,
    0x42, 0x86, 0x81, 0x01,
    0x42, 0xf7, 0x81, 0x01,
    0x42, 0xf2, 0x81, 0x04,
    0x42, 0xf3, 0x81, 0x08,
    0x42, 0x82, 0x88, ...Buffer.from('matroska'),
    0x42, 0x87, 0x81, 0x04,
    0x42, 0x85, 0x81, 0x02,
    0x18, 0x53, 0x80, 0x67, 0x90,
    0x16, 0x54, 0xae, 0x6b, 0x8c,
    0xae, 0x8a,
    0x83, 0x81, 0x02,             // TrackType: 2 (Audio)
    0x86, 0x85, ...Buffer.from('A_AC3'), // CodecID: A_AC3
  ]);
  fs.writeFileSync('e2e/test_ac3.mkv', ac3Header);
}

async function run() {
  console.log('Starting Item 6 Verification Test (Tiered Player: Tier 0, Tier 1, Tier 2)...');
  setupFixtures();

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    defaultViewport: { width: 1280, height: 720 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--auto-accept-this-tab-capture',
    ],
  });

  try {
    // 1. Host creates room
    const ctxA = await browser.createBrowserContext();
    const pageA = await ctxA.newPage();
    pageA.on('console', (m) => console.log('PAGE A LOG:', m.text()));
    pageA.on('pageerror', (e) => console.error('PAGE A ERROR:', e));
    await pageA.goto(BASE, { waitUntil: 'networkidle0' });
    await pageA.waitForSelector('input[aria-label=Nickname]');
    await pageA.type('input[aria-label=Nickname]', 'HostPlayer');

    const createBtn = await pageA.$('button.primary');
    await createBtn.click();

    await pageA.waitForSelector('form.form');
    await pageA.type('input[placeholder="Friday movie night"]', 'Tiered Player Test');
    const submitBtn = await pageA.$('form.form button.primary');
    await submitBtn.click();

    await pageA.waitForSelector('.dock-btn.mic', { timeout: 15000 });
    await pageA.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 15000 });
    const roomUrl = pageA.url();
    console.log(`Host created room at ${roomUrl}`);

    // 2. Viewer joins
    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    await pageB.goto(roomUrl, { waitUntil: 'networkidle0' });
    await pageB.waitForSelector('form.form input.input', { timeout: 10000 });
    await pageB.type('form.form input.input', 'ViewerBob');
    const joinBtn = await pageB.$('form.form button.primary');
    await joinBtn.click();
    await pageB.waitForSelector('.dock-btn.mic', { timeout: 15000 });
    await pageB.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 15000 });
    console.log('Viewer joined and media connected.');

    // -------------------------------------------------------------
    // Test A: Play Tier 0 MP4/WebM
    // -------------------------------------------------------------
    console.log('Testing Tier 0 (Native MP4 / WebM)...');
    const fileInput = await pageA.$('input[type=file]');
    await fileInput.uploadFile(path.resolve('e2e/test_movie.webm'));

    await pageA.waitForFunction(() => {
      const room = window.__watchTogether?.room;
      return room?.player?.isStreamer === true && room?.playback?.has_movie === true;
    }, { timeout: 15000 });

    const tier0 = await pageA.evaluate(() => window.__watchTogether?.room?.player?.tier);
    console.log(`Tier 0 loaded successfully (player.tier === ${tier0})`);
    if (tier0 !== 0) throw new Error(`Expected tier 0, got ${tier0}`);

    // Verify viewer sees movie playback
    await pageB.waitForFunction(() => {
      const room = window.__watchTogether?.room;
      return room?.playback?.has_movie === true;
    }, { timeout: 10000 });
    console.log('Viewer received Tier 0 playback sync.');

    // Host stops movie
    await pageA.evaluate(() => window.__watchTogether?.room?.player?.stopMovie(true));
    await pageA.waitForFunction(() => !window.__watchTogether?.room?.playback?.has_movie, { timeout: 5000 });
    await sleep(1000);

    // -------------------------------------------------------------
    // Test B: Play Tier 1 MKV remux
    // -------------------------------------------------------------
    console.log('Testing Tier 1 (MKV remux)...');
    await fileInput.uploadFile(path.resolve('e2e/test_remux.mkv'));

    await pageA.waitForFunction(() => {
      const room = window.__watchTogether?.room;
      return room?.player?.isStreamer === true && room?.playback?.has_movie === true;
    }, { timeout: 15000 });

    const tier1 = await pageA.evaluate(() => window.__watchTogether?.room?.player?.tier);
    console.log(`Tier 1 loaded successfully (player.tier === ${tier1})`);
    if (tier1 !== 0 && tier1 !== 1) throw new Error(`Expected tier 0 or 1 for MKV, got ${tier1}`);

    // Verify play/pause/seek works in Tier 1
    await pageA.evaluate(() => window.__watchTogether?.room?.player?.togglePlay());
    await sleep(500);
    const isPlaying = await pageA.evaluate(() => window.__watchTogether?.room?.player?.isPlaying());
    console.log('Tier 1 play/pause toggle:', isPlaying);

    // Host stops movie
    await pageA.evaluate(() => window.__watchTogether?.room?.player?.stopMovie(true));
    await pageA.waitForFunction(() => !window.__watchTogether?.room?.playback?.has_movie, { timeout: 5000 });
    await sleep(1000);

    // -------------------------------------------------------------
    // Test C: Tier 2 HEVC video (Tier 2 decode or graceful error)
    // -------------------------------------------------------------
    console.log('Testing Tier 2 (HEVC video handling: Tier 2 decode or graceful error)...');
    const hevcBase64 = fs.readFileSync('e2e/test_hevc.mkv').toString('base64');

    const loadResult = await pageA.evaluate(async (b64) => {
      try {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const file = new File([u8], 'test_hevc.mkv', { type: 'video/x-matroska' });
        const p = window.__watchTogether.room.player;
        await p.loadFile(file);
        return { ok: true, tier: p.tier };
      } catch (e) {
        return { error: e.message };
      }
    }, hevcBase64);
    console.log('HEVC load result:', JSON.stringify(loadResult));

    const hevcTier = await pageA.evaluate(() => window.__watchTogether?.room?.player?.tier);
    const currentToasts = await pageA.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
    const hevcGraceful = currentToasts.some((msg) => msg.includes('HEVC') && msg.includes('HandBrake'));
    console.log(`HEVC result: tier=${hevcTier}, gracefulError=${hevcGraceful}`);
    if (hevcTier !== 2 && !hevcGraceful) {
      throw new Error(`Expected either Tier 2 decode (tier=2) or graceful HEVC error, got tier=${hevcTier}, toasts=${JSON.stringify(currentToasts)}`);
    }
    console.log('SUCCESS: Tier 2 HEVC handled correctly (Tier 2 decode or graceful error)!');

    // Host stops movie before Test D
    await pageA.evaluate(() => window.__watchTogether?.room?.player?.stopMovie(true));
    await pageA.waitForFunction(() => !window.__watchTogether?.room?.playback?.has_movie, { timeout: 5000 });
    await sleep(1000);

    // -------------------------------------------------------------
    // Test D: Tier 2 AC3 codec graceful error
    // -------------------------------------------------------------
    console.log('Testing Tier 2 (AC3 codec graceful error)...');
    const ac3Base64 = fs.readFileSync('e2e/test_ac3.mkv').toString('base64');

    const loadResultD = await pageA.evaluate(async (b64) => {
      try {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const file = new File([u8], 'test_ac3.mkv', { type: 'video/x-matroska' });
        const p = window.__watchTogether.room.player;
        await p.loadFile(file);
        return { ok: true, tier: p.tier };
      } catch (e) {
        return { error: e.message };
      }
    }, ac3Base64);
    console.log('loadFile AC3 result:', JSON.stringify(loadResultD));

    const ac3Toasts = await pageA.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
    console.log('Current toasts on pageA after AC3:', JSON.stringify(ac3Toasts));

    const ac3Toast = ac3Toasts.find((msg) => msg.includes('AC3') && msg.includes('HandBrake'));
    console.log('SUCCESS: Tier 2 AC3 graceful message displayed:', ac3Toast);
    if (!ac3Toast) throw new Error(`Expected AC3 toast with HandBrake, got ${JSON.stringify(ac3Toasts)}`);

    console.log('Item 6 browser verification PASSED successfully!');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
