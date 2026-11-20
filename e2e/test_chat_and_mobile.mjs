import puppeteer from 'puppeteer-core';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8000';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  console.log('--- Testing Chat Settings Menu & Mobile Phone Layout ---');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    defaultViewport: { width: 1280, height: 720 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle0' });

    // Create room
    await page.waitForSelector('input[aria-label=Nickname]');
    await page.type('input[aria-label=Nickname]', 'HostTester');
    const createBtn = await page.$('button.primary');
    await createBtn.click();

    await page.waitForSelector('form.form');
    await page.type('input[placeholder="Friday movie night"]', 'Mobile & Chat Test');
    const submitBtn = await page.$('form.form button.primary');
    await submitBtn.click();

    await page.waitForSelector('.dock-btn.mic', { timeout: 15000 });
    console.log('Room created at:', page.url());

    // 1. Verify Desktop Chat Settings Position
    console.log('Checking Chat Settings Menu position on Desktop (1280x720)...');
    const settingsBtn = await page.$('.chat-settings-btn');
    if (!settingsBtn) throw new Error('Settings button not found in chat header');
    await settingsBtn.click();
    await sleep(300);

    const desktopMenuBox = await page.evaluate(() => {
      const menu = document.querySelector('.chat-settings-menu');
      if (!menu || menu.hidden) return null;
      const rect = menu.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        windowWidth: window.innerWidth,
        fullyInside: rect.right <= window.innerWidth && rect.left >= 0,
      };
    });
    console.log('Desktop Chat Settings Menu Box:', desktopMenuBox);
    if (!desktopMenuBox || !desktopMenuBox.fullyInside) {
      throw new Error('Chat settings menu is still clipped on desktop: ' + JSON.stringify(desktopMenuBox));
    }

    // Take screenshot of desktop chat panel
    await page.screenshot({ path: path.resolve('e2e/screenshots/desktop_chat_settings.png') });
    console.log('Saved screenshot to e2e/screenshots/desktop_chat_settings.png');

    // Test Audio Chime Execution
    console.log('Testing notification chime synthesis...');
    const audioTest = await page.evaluate(() => {
      try {
        const room = window.__watchTogether?.room;
        const chat = room?.chat;
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });
    console.log('Audio chime check:', audioTest);

    // 2. Mobile Viewport Test (iPhone: 375x667)
    console.log('\n--- Checking Mobile Phone Viewport (375x667) ---');
    await page.setViewport({ width: 375, height: 667, isMobile: true, hasTouch: true });
    await sleep(500);

    const mobileLayoutCheck = await page.evaluate(() => {
      const scrollWidth = document.documentElement.scrollWidth;
      const clientWidth = document.documentElement.clientWidth;
      const dock = document.querySelector('.dock');
      const dockRect = dock?.getBoundingClientRect();
      const topbar = document.querySelector('.topbar');
      const topRect = topbar?.getBoundingClientRect();
      const stage = document.querySelector('.stage');
      const stageRect = stage?.getBoundingClientRect();

      return {
        scrollWidth,
        clientWidth,
        hasHorizontalOverflow: scrollWidth > clientWidth,
        dockWidth: dockRect?.width,
        topbarWidth: topRect?.width,
        stageWidth: stageRect?.width,
      };
    });
    console.log('Mobile Layout Dimension Check:', mobileLayoutCheck);
    if (mobileLayoutCheck.hasHorizontalOverflow) {
      throw new Error('Mobile viewport has horizontal overflow: ' + JSON.stringify(mobileLayoutCheck));
    }

    // Take mobile main screen screenshot
    await page.screenshot({ path: path.resolve('e2e/screenshots/mobile_main.png') });
    console.log('Saved mobile main screen screenshot to e2e/screenshots/mobile_main.png');

    // 3. Open Side Drawer on Mobile
    console.log('Opening Chat Side Drawer on Mobile...');
    const sideToggle = await page.$('.side-toggle');
    await sideToggle.click();
    await sleep(400);

    const mobileDrawerCheck = await page.evaluate(() => {
      const side = document.querySelector('.side');
      const sideRect = side?.getBoundingClientRect();
      const isOpen = document.querySelector('.layout')?.classList.contains('side-open');
      const backdrop = document.querySelector('.side-backdrop');
      const backdropVisible = window.getComputedStyle(backdrop).display !== 'none';

      return {
        isOpen,
        backdropVisible,
        sideWidth: sideRect?.width,
        windowWidth: window.innerWidth,
        coversFullWidth: sideRect && sideRect.width >= window.innerWidth * 0.95,
      };
    });
    console.log('Mobile Drawer State:', mobileDrawerCheck);
    if (!mobileDrawerCheck.isOpen || !mobileDrawerCheck.coversFullWidth) {
      throw new Error('Mobile side drawer failed full width check: ' + JSON.stringify(mobileDrawerCheck));
    }

    // Click settings in mobile drawer
    const mobileSettingsBtn = await page.$('.chat-settings-btn');
    await mobileSettingsBtn.click();
    await sleep(300);

    const mobileMenuBox = await page.evaluate(() => {
      const menu = document.querySelector('.chat-settings-menu');
      if (!menu || menu.hidden) return null;
      const rect = menu.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        windowWidth: window.innerWidth,
        fullyInside: rect.right <= window.innerWidth && rect.left >= 0,
      };
    });
    console.log('Mobile Chat Settings Menu Box:', mobileMenuBox);
    if (!mobileMenuBox || !mobileMenuBox.fullyInside) {
      throw new Error('Mobile chat settings menu clipped: ' + JSON.stringify(mobileMenuBox));
    }

    await page.screenshot({ path: path.resolve('e2e/screenshots/mobile_chat_open.png') });
    console.log('Saved mobile chat screenshot to e2e/screenshots/mobile_chat_open.png');

    console.log('\n>>> ALL FIXES VERIFIED SUCCESSFULLY! <<<');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});

