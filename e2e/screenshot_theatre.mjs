import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8000';

async function testResolution(width, height, label) {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    defaultViewport: { width, height },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  });

  try {
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.type('input[aria-label=Nickname]', 'Hosty');
    await (await page.$('button.primary')).click();
    await page.waitForSelector('form.form');
    await page.type('input[placeholder="Friday movie night"]', 'Theatre Test');
    const submitBtn = await page.$('form.form button.primary');
    await submitBtn.click();

    await page.waitForSelector('.stage', { timeout: 15000 });

    // Enable theatre mode
    await page.evaluate(() => {
      const room = window.__watchTogether.room;
      const p = room.player;
      p.movieShown = () => true;
      p.isPlaying = () => true;
      p.view = 'movie';
      p.applyPlayback({
        has_movie: true,
        playing: true,
        position: 0,
        duration: 3600,
        server_time: Date.now()
      });
      p.toggleTheatre();
    });

    await new Promise(r => setTimeout(r, 1000));

    // Get measurements
    const metrics = await page.evaluate(() => {
      const room = document.querySelector('.room');
      const layout = document.querySelector('.layout');
      const stageCol = document.querySelector('.stage-col');
      const stage = document.querySelector('.stage');
      const dock = document.querySelector('.dock');
      const stageRect = stage.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        room: { h: room?.clientHeight, style: room ? getComputedStyle(room).gridTemplateRows : null },
        layout: { h: layout?.clientHeight, style: layout ? getComputedStyle(layout).height : null },
        stageCol: { h: stageCol?.clientHeight, style: stageCol ? getComputedStyle(stageCol).height : null },
        stage: { x: stageRect.x, y: stageRect.y, width: stageRect.width, height: stageRect.height },
        dock: { x: dockRect.x, y: dockRect.y, width: dockRect.width, height: dockRect.height, padding: dock ? getComputedStyle(dock).padding : null },
        bodyScrollHeight: document.body.scrollHeight,
        docScrollHeight: document.documentElement.scrollHeight
      };
    });
    console.log(`Resolution ${label} (${width}x${height}):`, JSON.stringify(metrics, null, 2));

    if (!fs.existsSync('e2e/screenshots')) fs.mkdirSync('e2e/screenshots', { recursive: true });
    await page.screenshot({ path: `e2e/screenshots/theatre-${label}.png` });

  } finally {
    await browser.close();
  }
}

async function run() {
  await testResolution(1366, 768, '1366x768');
  await testResolution(1920, 1080, '1920x1080');
}

run().catch(console.error);

