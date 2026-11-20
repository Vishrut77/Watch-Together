import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8000';

async function testResolution(browser, width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.type('input[aria-label=Nickname]', `User_${width}`);
  await (await page.$('button.primary')).click();
  await page.waitForSelector('form.form');
  await page.type('input[placeholder="Friday movie night"]', `Theatre ${width}x${height}`);
  await (await page.$('form.form button.primary')).click();

  await page.waitForSelector('.stage', { timeout: 15000 });

  // Enter theatre mode with active movie
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

  await new Promise(r => setTimeout(r, 600));

  // Assert bounding box covers >=98% of viewport width and (viewport height minus dock)
  const metrics = await page.evaluate(() => {
    const stage = document.querySelector('.stage');
    const dock = document.querySelector('.dock');
    const sRect = stage.getBoundingClientRect();
    const dRect = dock.getBoundingClientRect();
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      sWidth: sRect.width,
      sHeight: sRect.height,
      dHeight: dRect.height,
      scrollY: document.body.scrollHeight,
      isTheatre: document.body.classList.contains('theatre')
    };
  });

  const widthCoverage = metrics.sWidth / metrics.vw;
  const expectedHeight = metrics.vh - metrics.dHeight;
  const heightDiff = Math.abs(metrics.sHeight - expectedHeight);

  console.log(`Resolution ${width}x${height}:`);
  console.log(`  Width coverage: ${(widthCoverage * 100).toFixed(1)}% (>= 98% required)`);
  console.log(`  Stage height: ${metrics.sHeight}px vs Expected (VH - Dock): ${expectedHeight}px (diff: ${heightDiff.toFixed(2)}px)`);
  console.log(`  Scrollable height: ${metrics.scrollY} vs ${metrics.vh}`);

  if (widthCoverage < 0.98) throw new Error(`Width coverage ${widthCoverage} is less than 98%`);
  if (heightDiff > 1.5) throw new Error(`Stage height differs from (VH - Dock) by ${heightDiff}px`);
  if (metrics.scrollY > metrics.vh) throw new Error('Scrollbars detected in theatre mode!');

  // Test Dock auto-hide when idle
  console.log(`  Testing dock auto-hide when idle...`);
  await page.evaluate(() => {
    window.__watchTogether.room.player.wake();
  });
  // Wait 3.5s for idle
  await new Promise(r => setTimeout(r, 3500));
  const dockIdle = await page.evaluate(() => {
    const dock = document.querySelector('.dock');
    const stage = document.querySelector('.stage');
    const style = getComputedStyle(dock);
    return {
      stageIdle: stage.classList.contains('idle'),
      dockOpacity: Number(style.opacity),
      dockPointerEvents: style.pointerEvents
    };
  });
  console.log('  Dock idle state:', dockIdle);
  if (!dockIdle.stageIdle || dockIdle.dockOpacity !== 0 || dockIdle.dockPointerEvents !== 'none') {
    throw new Error('Dock did not auto-hide when idle in theatre mode');
  }

  // Wake again
  await page.mouse.move(500, 300);
  const dockAwake = await page.evaluate(() => {
    const dock = document.querySelector('.dock');
    const style = getComputedStyle(dock);
    return { dockOpacity: Number(style.opacity) };
  });
  if (dockAwake.dockOpacity !== 1) throw new Error('Dock did not wake up on pointer move');

  // Test side panel disallowed in theatre mode & clicking chat exits theatre first then opens chat
  console.log(`  Testing theatre mode hides side chat and clicking chat exits theatre first...`);
  const chatBtn = await page.$('.theatre-chat-toggle');
  if (!chatBtn) throw new Error('No .theatre-chat-toggle element found');

  const sideHiddenInTheatre = await page.evaluate(() => {
    const side = document.querySelector('.side');
    // Switch to people first in state and ensure even forced side-open stays hidden in theatre
    window.__watchTogether.room.showSide('people', false);
    document.querySelector('.layout')?.classList.add('side-open');
    const style = getComputedStyle(side);
    const hidden = style.display === 'none' || side.getBoundingClientRect().width === 0;
    document.querySelector('.layout')?.classList.remove('side-open');
    return hidden;
  });
  if (!sideHiddenInTheatre) throw new Error('Side chat panel was still visible in theatre mode');

  // Verify unread badge works on theatre chat toggle
  await page.evaluate(() => {
    window.__watchTogether.room.setUnread(5);
  });
  const badgeText = await page.$eval('.theatre-chat-toggle .badge', el => el.textContent);
  const badgeVisible = await page.$eval('.theatre-chat-toggle .badge', el => !el.hidden);
  if (!badgeVisible || badgeText !== '5') throw new Error(`Badge not working: visible=${badgeVisible}, text=${badgeText}`);
  console.log('  Chat unread badge verified:', badgeText);

  // Click chat toggle: must first exit theatre mode, then show chat panel outside theatre
  await chatBtn.click();
  const afterChatClick = await page.evaluate(() => {
    const room = window.__watchTogether.room;
    const side = document.querySelector('.side');
    const chatPanel = room.chat.el;
    return {
      inTheatre: document.body.classList.contains('theatre'),
      sideTab: room.sideTab,
      sideDisplay: side ? getComputedStyle(side).display : null,
      chatHidden: chatPanel ? chatPanel.hidden : null,
      chatWidth: chatPanel ? chatPanel.getBoundingClientRect().width : 0,
      chatVisibleFlag: room.chat.visible,
    };
  });
  if (afterChatClick.inTheatre || afterChatClick.sideTab !== 'chat' || afterChatClick.sideDisplay === 'none' || afterChatClick.chatHidden || afterChatClick.chatWidth <= 0 || !afterChatClick.chatVisibleFlag) {
    throw new Error(`Clicking chat in theatre mode did not exit theatre and open chat: ${JSON.stringify(afterChatClick)}`);
  }
  console.log('  Clicking chat exited theatre mode and revealed chat panel cleanly.');

  // Re-enter theatre mode before testing Escape key exits theatre mode
  await page.evaluate(() => {
    window.__watchTogether.room.player.toggleTheatre();
  });

  // Test Esc key exits theatre mode
  console.log(`  Testing Escape key exits theatre mode...`);
  await page.keyboard.press('Escape');
  const exitedTheatre = await page.evaluate(() => !document.body.classList.contains('theatre'));
  if (!exitedTheatre) throw new Error('Escape did not exit theatre mode');
  console.log('  Escape successfully exited theatre mode.');

  // Test toggling theatre mode in fullscreen
  console.log(`  Testing toggling theatre mode in fullscreen...`);
  await page.evaluate(() => {
    const p = window.__watchTogether.room.player;
    // Enter theatre mode
    p.toggleTheatre();
    // Simulate fullscreenElement is the stage
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => p.el
    });
    // Toggle theatre while in fullscreen
    p.toggleTheatre();
  });
  const theatreToggledOff = await page.evaluate(() => !document.body.classList.contains('theatre'));
  if (!theatreToggledOff) throw new Error('Toggling theatre off in fullscreen failed');

  await page.evaluate(() => {
    window.__watchTogether.room.player.toggleTheatre();
  });
  const theatreToggledOn = await page.evaluate(() => document.body.classList.contains('theatre'));
  if (!theatreToggledOn) throw new Error('Toggling theatre on in fullscreen failed');
  console.log('  Toggling theatre mode in fullscreen works correctly.');

  await page.close();
}

async function run() {
  console.log('Starting Item 2 Verification Test...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  });

  try {
    await testResolution(browser, 1366, 768);
    await testResolution(browser, 1920, 1080);
    console.log('\n>>> ALL ITEM 2 TESTS PASSED! <<<');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('Item 2 test failed:', err);
  process.exit(1);
});
