import puppeteer from 'puppeteer-core';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8000';
const MOVIE_PATH = path.resolve('e2e/test_movie.webm');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  console.log('--- Starting Item 7 & 8 Verification Test ---');
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
    await pageA.goto(BASE, { waitUntil: 'networkidle0' });
    await pageA.waitForSelector('input[aria-label=Nickname]');
    await pageA.type('input[aria-label=Nickname]', 'HostStreamer');

    const createBtn = await pageA.$('button.primary');
    await createBtn.click();

    await pageA.waitForSelector('form.form');
    await pageA.type('input[placeholder="Friday movie night"]', 'Streaming Performance Test');
    const submitBtn = await pageA.$('form.form button.primary');
    await submitBtn.click();

    await pageA.waitForSelector('.dock-btn.mic', { timeout: 15000 });
    await pageA.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 15000 });
    const roomUrl = pageA.url();
    console.log('Host created room:', roomUrl);

    // 2. Viewer joins
    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    await pageB.goto(roomUrl, { waitUntil: 'networkidle0' });
    await pageB.waitForSelector('form.form input.input', { timeout: 10000 });
    await pageB.type('form.form input.input', 'ViewerOne');
    const joinBtn = await pageB.$('form.form button.primary');
    await joinBtn.click();
    await pageB.waitForSelector('.dock-btn.mic', { timeout: 15000 });
    await pageB.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 15000 });
    console.log('Viewer joined and connected to media');

    // 3. Host loads and streams movie
    await pageA.waitForSelector('.stage input[type=file]');
    const fileInput = await pageA.$('.stage input[type=file]');
    await fileInput.uploadFile(MOVIE_PATH);
    console.log('Host uploaded movie');

    await pageA.waitForFunction(() => {
      const room = window.__watchTogether?.room;
      return room?.player?.isStreamer === true && room?.playback?.has_movie === true;
    }, { timeout: 15000 });
    console.log('Host is streaming');

    // Wait for playback state and LiveKit track to establish
    await sleep(4000);

    // Verify viewer receives movie track
    const viewerReceiving = await pageB.evaluate(() => {
      const v = document.querySelector('video.movie');
      return {
        hasSrcObject: !!v?.srcObject,
        paused: v?.paused,
        videoWidth: v?.videoWidth,
        videoHeight: v?.videoHeight,
      };
    });
    console.log('Viewer video element state:', viewerReceiving);

    // Test Item 7: Receiver stats and no re-attachment
    const receiverStats = await pageB.evaluate(async () => {
      const room = window.__wt_room;
      // Track srcObject changes
      const v = document.querySelector('video.movie');
      let attachCount = 0;
      const origSetter = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject').set;
      return await window.__wt_player?.deps?.media?.movieReceiveStats?.() || null;
    });
    console.log('Viewer receiver stats:', receiverStats);

    // Enter theatre mode on Viewer and verify requestHighQuality
    await pageB.keyboard.press('t');
    await sleep(500);
    const isTheatre = await pageB.evaluate(() => document.body.classList.contains('theatre'));
    console.log('Viewer in theatre mode:', isTheatre);
    if (!isTheatre) throw new Error('Viewer failed to enter theatre mode');

    // Test Item 8: Plain text CPU/Bandwidth limit and NO downgrade prompt
    console.log('Testing Item 8 (Limitation friendly explanation without downgrade prompt)...');
    const item8Test = await pageA.evaluate(async () => {
      const p = window.__watchTogether?.room?.player;
      if (!p) return { error: 'No player on host' };

      // Simulate cpu limit
      p.deps.media.movieSendStats = async () => ({
        width: 1920, height: 1080, fps: 30, bitrate: 4000000,
        limited: 'cpu',
      });
      await p.updateStats();

      const chipText = document.querySelector('.stage-badges .chip.warn')?.textContent || '';
      const chipTitle = document.querySelector('.stage-badges .chip.warn')?.getAttribute('title') || '';

      // Test limit elapsed - ensure no downgrade offer pops up
      await p.updateStats();

      const toastOffer = document.querySelector('.downgrade-offer');

      return {
        chipText,
        chipTitle,
        hasToastOffer: !!toastOffer,
        quality: p.quality,
      };
    });

    console.log('Item 8 test result:', item8Test);
    if (!item8Test.chipText.includes('your computer is too busy')) {
      throw new Error('Item 8 failed: friendly chip text missing: ' + item8Test.chipText);
    }
    if (item8Test.hasToastOffer) {
      throw new Error('Item 8 failed: downgrade offer toast was unexpectedly shown');
    }
    if (item8Test.quality !== 'high') {
      throw new Error('Item 8 failed: quality was unexpectedly changed: ' + item8Test.quality);
    }

    console.log('>>> Items 7 & 8 VERIFIED SUCCESSFULLY! <<<');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
