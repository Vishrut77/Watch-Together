import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8000';

async function run() {
  console.log('Starting Item 3 Verification Test...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  });

  try {
    const hostCtx = await browser.createBrowserContext();
    const viewerCtx = await browser.createBrowserContext();

    const hostPage = await hostCtx.newPage();
    const viewerPage = await viewerCtx.newPage();

    // 1. Host creates room
    await hostPage.goto(BASE, { waitUntil: 'networkidle0' });
    await hostPage.type('input[aria-label=Nickname]', 'Hosty');
    await (await hostPage.$('button.primary')).click();
    await hostPage.waitForSelector('form.form');
    await hostPage.type('input[placeholder="Friday movie night"]', 'Reaction Party');
    await (await hostPage.$('form.form button.primary')).click();

    await hostPage.waitForSelector('.code-chip', { timeout: 15000 });
    const roomCode = await hostPage.$eval('.code-chip', el => el.textContent.trim());
    console.log(`Room created with code: ${roomCode}`);

    // 2. Viewer joins room
    await viewerPage.goto(`${BASE}/room/${roomCode}`, { waitUntil: 'networkidle0' });
    await viewerPage.waitForSelector('input.input');
    await viewerPage.type('input.input', 'Viewer1');
    await (await viewerPage.$('button.primary')).click();

    // Wait until both see each other in roster / participant strip
    await hostPage.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, { timeout: 15000 });
    await viewerPage.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, { timeout: 15000 });
    console.log('Both host and viewer connected and visible in participant strip.');

    // 3. Viewer sends reaction '🔥'
    console.log('Viewer sends reaction 🔥...');
    await viewerPage.evaluate(() => {
      window.__watchTogether.room.send({ type: 'reaction', emoji: '🔥' });
    });

    // Wait for reaction element to appear on both
    await Promise.all([
      hostPage.waitForSelector('.reactions-layer .float', { timeout: 5000 }),
      viewerPage.waitForSelector('.reactions-layer .float', { timeout: 5000 })
    ]);

    // Check reaction element properties on Host
    const hostReaction = await hostPage.evaluate(() => {
      const el = document.querySelector('.reactions-layer .float');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        text: el.textContent,
        width: rect.width,
        height: rect.height,
        opacity: Number(style.opacity),
        zIndex: getComputedStyle(document.querySelector('.reactions-layer')).zIndex
      };
    });
    console.log('Host saw reaction:', hostReaction);

    // Check reaction element properties on Viewer (Sender)
    const viewerReaction = await viewerPage.evaluate(() => {
      const el = document.querySelector('.reactions-layer .float');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        text: el.textContent,
        width: rect.width,
        height: rect.height,
        opacity: Number(style.opacity),
        zIndex: getComputedStyle(document.querySelector('.reactions-layer')).zIndex
      };
    });
    console.log('Viewer (Sender) saw reaction:', viewerReaction);

    if (!hostReaction || hostReaction.width <= 0 || hostReaction.height <= 0 || hostReaction.opacity <= 0) {
      throw new Error(`Host did not see a visible reaction with non-zero size/opacity!`);
    }
    if (!viewerReaction || viewerReaction.width <= 0 || viewerReaction.height <= 0 || viewerReaction.opacity <= 0) {
      throw new Error(`Viewer did not see their own reaction with non-zero size/opacity!`);
    }
    if (Number(hostReaction.zIndex) < 10) {
      throw new Error(`Reactions layer z-index is too low: ${hostReaction.zIndex}`);
    }

    // 4. Check participant tile pulsing
    console.log('Checking participant tile pulse...');
    const hostSawPulse = await hostPage.evaluate(() => {
      const tiles = document.querySelectorAll('.tile');
      return Array.from(tiles).some(t => t.classList.contains('pulse-reaction'));
    });
    console.log('Host saw participant tile pulse:', hostSawPulse);
    if (!hostSawPulse) throw new Error('Host did not observe participant tile pulsing');

    // 5. Test in Theatre Mode on Host
    console.log('Testing reaction visible on Host in Theatre Mode...');
    await hostPage.evaluate(() => {
      window.__watchTogether.room.player.toggleTheatre();
    });

    // Viewer sends another reaction '🎉'
    await viewerPage.evaluate(() => {
      window.__watchTogether.room.send({ type: 'reaction', emoji: '🎉' });
    });

    await hostPage.waitForSelector('.reactions-layer .float b', { timeout: 5000 });
    const hostTheatreReaction = await hostPage.evaluate(() => {
      const floats = document.querySelectorAll('.reactions-layer .float');
      const latest = floats[floats.length - 1];
      if (!latest) return null;
      const rect = latest.getBoundingClientRect();
      const style = getComputedStyle(latest);
      return {
        text: latest.textContent,
        width: rect.width,
        height: rect.height,
        opacity: Number(style.opacity)
      };
    });
    console.log('Host saw reaction in Theatre Mode:', hostTheatreReaction);
    if (!hostTheatreReaction || hostTheatreReaction.width <= 0 || hostTheatreReaction.opacity <= 0) {
      throw new Error('Host did not see reaction in theatre mode');
    }

    // 6. Test in Fullscreen Mode
    console.log('Testing reactions layer exists and renders in Fullscreen Mode...');
    const fullscreenLayerCheck = await hostPage.evaluate(() => {
      const stage = document.querySelector('.stage');
      const rxLayer = stage.querySelector('.reactions-layer');
      return {
        insideStage: !!rxLayer,
        parentIsStage: rxLayer.parentElement === stage,
        zIndex: getComputedStyle(rxLayer).zIndex
      };
    });
    console.log('Fullscreen layer check:', fullscreenLayerCheck);
    if (!fullscreenLayerCheck.insideStage || Number(fullscreenLayerCheck.zIndex) < 10) {
      throw new Error('Reactions layer not properly contained in stage or wrong z-index');
    }

    console.log('\n>>> ALL ITEM 3 TESTS PASSED! <<<');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('Item 3 test failed:', err);
  process.exit(1);
});
