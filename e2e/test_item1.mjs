import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8000';

async function run() {
  console.log('Starting Item 1 Verification Test...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    defaultViewport: { width: 1280, height: 720 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.error('PAGE ERROR:', err));

    // 1. Load home page and create room
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[aria-label=Nickname]');
    await page.type('input[aria-label=Nickname]', 'Host1');
    
    // Click "Create room"
    const createBtn = await page.$('button.primary');
    await createBtn.click();
    
    // Room modal
    await page.waitForSelector('form.form');
    await page.type('input[placeholder="Friday movie night"]', 'Controls Test');
    const submitBtn = await page.$('form.form button.primary');
    await submitBtn.click();

    // Wait for room to load and media to connect
    await page.waitForSelector('.dock-btn.mic:not([disabled])', { timeout: 20000 });
    console.log('Room loaded and media connected.');

    // Prepare simulated movie state
    await page.evaluate(() => {
      const room = window.__watchTogether.room;
      const p = room.player;
      p.movieShown = () => true;
      p.isPlaying = () => true;
      p.sources = { movie: { video: { kind: 'video' } } };
      p.view = 'movie';
      p.applyPlayback({
        has_movie: true,
        playing: true,
        position: 0,
        duration: 3600,
        streamer_id: 'other',
        streamer_name: 'Other',
        title: 'Big Buck Bunny',
        server_time: Date.now()
      });
      p.wake();
    });

    // Check that controls are visible initially
    let isIdle = await page.$eval('.stage', el => el.classList.contains('idle'));
    console.log('Initially idle?', isIdle);
    if (isIdle) throw new Error('Stage should NOT be idle right after wake()');

    // Wait 4 seconds with no inputs
    console.log('Waiting 4s with no input events...');
    await new Promise(r => setTimeout(r, 4000));

    isIdle = await page.$eval('.stage', el => el.classList.contains('idle'));
    console.log('After 4s idle?', isIdle);
    if (!isIdle) throw new Error('Stage SHOULD be idle after 4s without input while playing');

    // Test 30s of periodic playback broadcasts
    console.log('Testing 30s of playback broadcasts (every 2s)...');
    for (let i = 1; i <= 15; i++) {
      await page.evaluate((pos) => {
        const room = window.__watchTogether.room;
        room.player.applyPlayback({
          has_movie: true,
          playing: true,
          position: pos * 2,
          duration: 3600,
          streamer_id: room.me.id,
          streamer_name: room.me.nickname,
          title: 'Big Buck Bunny',
          server_time: Date.now()
        });
      }, i);
      await new Promise(r => setTimeout(r, 2000));
      isIdle = await page.$eval('.stage', el => el.classList.contains('idle'));
      if (!isIdle) {
        throw new Error(`Stage woke up unexpectedly on playback broadcast #${i}!`);
      }
    }
    console.log('PASS: Stage stayed idle for 30s across 15 playback broadcasts!');

    // Test mouse move wakes controls
    console.log('Moving mouse to wake controls...');
    await page.mouse.move(500, 300);
    isIdle = await page.$eval('.stage', el => el.classList.contains('idle'));
    console.log('After mouse move, idle?', isIdle);
    if (isIdle) throw new Error('Stage should NOT be idle after mouse move');

    // Test keyboard navigation focus keeps controls visible
    console.log('Testing focus inside .controls prevents auto-hide...');
    await page.focus('.ctl.play');
    await new Promise(r => setTimeout(r, 4000));
    isIdle = await page.$eval('.stage', el => el.classList.contains('idle'));
    console.log('After 4s while focused on play button, idle?', isIdle);
    if (isIdle) throw new Error('Stage should NOT be idle while control has focus');

    // Now test Mobile Viewport + Touch Emulation
    console.log('\n--- Mobile Viewport + Touch Emulation Test ---');
    const mobilePage = await browser.newPage();
    await mobilePage.emulate({
      viewport: { width: 375, height: 667, isMobile: true, hasTouch: true },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
    });

    await mobilePage.goto(BASE, { waitUntil: 'networkidle0' });
    await mobilePage.waitForSelector('input[aria-label=Nickname]');
    await mobilePage.type('input[aria-label=Nickname]', 'MobUser');
    const mobCreateBtn = await mobilePage.$('button.primary');
    await mobCreateBtn.click();
    await mobilePage.waitForSelector('form.form');
    await mobilePage.type('input[placeholder="Friday movie night"]', 'Mobile Test');
    const mobSubmitBtn = await mobilePage.$('form.form button.primary');
    await mobSubmitBtn.click();
    await mobilePage.waitForSelector('.dock-btn.mic:not([disabled])', { timeout: 20000 });
    console.log('Mobile room loaded and media connected.');

    // Simulate movie playing on mobile
    await mobilePage.evaluate(() => {
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
        streamer_id: 'other',
        streamer_name: 'Other',
        title: 'Mobile Movie',
        server_time: Date.now()
      });
      p.wake();
    });

    // Wait 3.5s for auto-hide
    console.log('Mobile: waiting 3.5s for auto-hide...');
    await new Promise(r => setTimeout(r, 3500));
    isIdle = await mobilePage.$eval('.stage', el => el.classList.contains('idle'));
    console.log('Mobile: after 3.5s idle?', isIdle);
    if (!isIdle) throw new Error('Mobile stage should be idle after 3.5s without touch');

    // Tap the video layer
    console.log('Mobile: tap video layer to toggle controls on...');
    const videoBox = await mobilePage.$eval('video.layer', el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await mobilePage.touchscreen.tap(videoBox.x, videoBox.y);
    isIdle = await mobilePage.$eval('.stage', el => el.classList.contains('idle'));
    console.log('Mobile: after tap on video, idle?', isIdle);
    if (isIdle) throw new Error('Mobile stage should wake after tap on video');

    // Tap again to toggle controls off immediately
    await new Promise(r => setTimeout(r, 600));
    console.log('Mobile: tap video layer again to toggle controls off immediately...');
    await mobilePage.touchscreen.tap(videoBox.x, videoBox.y);
    isIdle = await mobilePage.$eval('.stage', el => el.classList.contains('idle'));
    console.log('Mobile: after 2nd tap, idle?', isIdle);
    if (!isIdle) throw new Error('Mobile stage should become idle immediately on 2nd tap');

    // Tap to wake again
    await new Promise(r => setTimeout(r, 600));
    await mobilePage.touchscreen.tap(videoBox.x, videoBox.y);
    isIdle = await mobilePage.$eval('.stage', el => el.classList.contains('idle'));
    console.log('Mobile: after 3rd tap, idle?', isIdle);
    if (isIdle) throw new Error('Mobile stage should wake again');

    // Check state right after tap 3
    const debugState = await mobilePage.evaluate(() => {
      const p = window.__watchTogether.room.player;
      return {
        hasIdleTimer: !!p.idleTimer,
        isPlaying: p.isPlaying(),
        isStreamer: p.isStreamer,
        vMoviePaused: p.vMovie.paused,
        qualityHidden: p.qualityMenu.hidden,
        activeElement: document.activeElement ? `${document.activeElement.tagName}.${document.activeElement.className}` : null,
        movieShown: p.movieShown(),
        screenShown: p.screenShown()
      };
    });
    console.log('Mobile state right after tap 3:', debugState);

    // Wait 3.5s to confirm auto-hide 3s after touch
    console.log('Mobile: waiting 3.5s after touch for auto-hide...');
    await new Promise(r => setTimeout(r, 3500));
    isIdle = await mobilePage.$eval('.stage', el => el.classList.contains('idle'));
    console.log('Mobile: auto-hidden after 3.5s?', isIdle);
    if (!isIdle) throw new Error('Mobile stage should auto-hide 3s after touch while playing');

    // Test while paused: controls stay visible
    console.log('Mobile: setting to PAUSED state...');
    await mobilePage.evaluate(() => {
      const room = window.__watchTogether.room;
      const p = room.player;
      p.isPlaying = () => false;
      p.applyPlayback({
        has_movie: true,
        playing: false,
        position: 10,
        duration: 3600,
        streamer_id: room.me.id,
        streamer_name: room.me.nickname,
        title: 'Mobile Movie',
        server_time: Date.now()
      });
    });
    // Tap to wake
    await mobilePage.touchscreen.tap(videoBox.x, videoBox.y);
    isIdle = await mobilePage.$eval('.stage', el => el.classList.contains('idle'));
    console.log('Mobile paused: after tap, idle?', isIdle);
    if (isIdle) throw new Error('Mobile stage should wake when tapped while paused');

    console.log('Mobile paused: waiting 4s to verify controls STAY VISIBLE while paused...');
    await new Promise(r => setTimeout(r, 4000));
    isIdle = await mobilePage.$eval('.stage', el => el.classList.contains('idle'));
    console.log('Mobile paused: after 4s, idle?', isIdle);
    if (isIdle) throw new Error('Mobile controls should STAY VISIBLE while paused!');

    console.log('\n>>> ALL ITEM 1 TESTS PASSED! <<<');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
