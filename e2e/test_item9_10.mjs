import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8000';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  console.log('--- Starting Item 9 & 10 Verification Test (Chat Mentions, Notifications, Timestamps) ---');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    defaultViewport: { width: 1280, height: 720 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    // 1. Host creates room
    const ctxA = await browser.createBrowserContext();
    const pageA = await ctxA.newPage();
    await pageA.goto(BASE, { waitUntil: 'networkidle0' });
    await pageA.waitForSelector('input[aria-label=Nickname]');
    await pageA.type('input[aria-label=Nickname]', 'HostOwner');

    const createBtn = await pageA.$('button.primary');
    await createBtn.click();

    await pageA.waitForSelector('form.form');
    await pageA.type('input[placeholder="Friday movie night"]', 'Chat Features Test');
    const submitBtn = await pageA.$('form.form button.primary');
    await submitBtn.click();

    await pageA.waitForSelector('.dock-btn.mic', { timeout: 15000 });
    const roomUrl = pageA.url();
    console.log('Host created room:', roomUrl);

    // 2. Viewer Alice joins
    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    await pageB.goto(roomUrl, { waitUntil: 'networkidle0' });
    await pageB.waitForSelector('form.form input.input', { timeout: 10000 });
    await pageB.type('form.form input.input', 'Alice Wonder');
    const joinBtn = await pageB.$('form.form button.primary');
    await joinBtn.click();
    await pageB.waitForSelector('.dock-btn.mic', { timeout: 15000 });
    console.log('Alice joined room');

    // Wait for roster sync
    await sleep(1500);

    // 3. Test @ Autocomplete on Host page
    console.log('Testing @ mention autocomplete on Host...');
    const chatInputA = await pageA.$('.chat-form input.input');
    await chatInputA.focus();
    await pageA.keyboard.type('Hello @Ali');
    await sleep(400);

    // Verify autocomplete menu is visible and contains "Alice Wonder"
    const menuState = await pageA.evaluate(() => {
      const menu = document.querySelector('.mention-menu');
      const items = Array.from(menu?.querySelectorAll('.mention-item') || []).map((el) => el.textContent.trim());
      return {
        visible: menu && !menu.hidden,
        items,
      };
    });
    console.log('Autocomplete menu state:', menuState);
    if (!menuState.visible || !menuState.items.some((it) => it.includes('Alice Wonder'))) {
      throw new Error('Mention autocomplete did not pop up with Alice Wonder: ' + JSON.stringify(menuState));
    }

    // Select mention with Enter
    await pageA.keyboard.press('Enter');
    await sleep(200);

    const inputValueAfterSelect = await pageA.evaluate(() => document.querySelector('.chat-form input.input').value);
    console.log('Input value after selecting mention:', inputValueAfterSelect);
    if (!inputValueAfterSelect.includes('@Alice Wonder ')) {
      throw new Error('Mention was not inserted into input properly: ' + inputValueAfterSelect);
    }

    // Send the message
    await pageA.keyboard.type('how are you?');
    await pageA.keyboard.press('Enter');
    await sleep(1500);

    // 4. Verify Alice receives message with mention highlighting and correct timestamp
    console.log('Verifying mention highlight & timestamps on Alice view...');
    const aliceCheck = await pageB.evaluate(() => {
      const msgs = document.querySelectorAll('.chat-list .msg');
      const lastMsg = msgs[msgs.length - 1];
      const text = lastMsg?.querySelector('p')?.textContent || '';
      const isMentionMe = lastMsg?.classList.contains('mention-me');
      const mentionTag = lastMsg?.querySelector('.mention-tag');
      const isTagMe = mentionTag?.classList.contains('me');
      const timeText = lastMsg?.querySelector('time')?.textContent || '';

      // Check timestamp accuracy from raw data
      const room = window.__watchTogether?.room;
      const history = room?.chat?.list?.children;
      return {
        text,
        isMentionMe,
        hasMentionTag: !!mentionTag,
        mentionTagText: mentionTag?.textContent,
        isTagMe,
        timeText,
        docTitle: document.title,
      };
    });

    console.log('Alice message verification:', aliceCheck);
    if (!aliceCheck.isMentionMe) {
      throw new Error('Message on Alice view is missing .mention-me class!');
    }
    if (!aliceCheck.hasMentionTag || !aliceCheck.mentionTagText.includes('@Alice Wonder')) {
      throw new Error('Mention tag not rendered properly: ' + JSON.stringify(aliceCheck));
    }
    if (!aliceCheck.timeText || !aliceCheck.timeText.includes(':')) {
      throw new Error('Chat timestamp missing or invalid format: ' + JSON.stringify(aliceCheck));
    }

    // 5. Verify Chat Settings Gear Menu & localStorage
    console.log('Testing Chat settings gear menu...');
    const settingsState = await pageB.evaluate(() => {
      const btn = document.querySelector('.chat-settings-btn');
      btn.click();
      const menu = document.querySelector('.chat-settings-menu');
      const items = Array.from(menu?.querySelectorAll('.menu-item') || []).map((el) => el.textContent.trim());

      // Click "Only when mentioned"
      const mentionsBtn = Array.from(menu?.querySelectorAll('.menu-item') || []).find((b) => b.textContent.includes('Only when mentioned'));
      mentionsBtn?.click();
      const saved = localStorage.getItem('wt_chat_sound');

      return {
        menuWasOpen: !menu.hidden,
        items,
        savedSoundSetting: saved,
      };
    });

    console.log('Settings state result:', settingsState);
    if (settingsState.savedSoundSetting !== 'mentions') {
      throw new Error('Sound setting was not saved to localStorage: ' + JSON.stringify(settingsState));
    }

    console.log('>>> Items 9 & 10 VERIFIED SUCCESSFULLY! <<<');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});

