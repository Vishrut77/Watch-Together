import puppeteer from 'puppeteer-core';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8000';
const MOVIE_PATH = path.resolve('e2e/test_movie.webm');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  console.log('Starting Item 5 Verification Test (Co-host Stream Movie Permission)...');
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
    await pageA.type('input[aria-label=Nickname]', 'HostOwner');

    const createBtn = await pageA.$('button.primary');
    await createBtn.click();

    await pageA.waitForSelector('form.form');
    await pageA.type('input[placeholder="Friday movie night"]', 'CoHost Stream Test');
    const submitBtn = await pageA.$('form.form button.primary');
    await submitBtn.click();

    await pageA.waitForSelector('.dock-btn.mic', { timeout: 15000 });
    const roomUrl = pageA.url();
    console.log(`Host created room at ${roomUrl}`);

    // 2. Viewer joins
    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    pageB.on('console', (msg) => console.log('PAGE B LOG:', msg.text()));
    pageB.on('pageerror', (err) => console.error('PAGE B ERROR:', err));
    await pageB.goto(roomUrl, { waitUntil: 'networkidle0' });
    await pageB.waitForSelector('form.form input.input', { timeout: 10000 });
    await pageB.type('form.form input.input', 'ViewerBob');
    const joinBtn = await pageB.$('form.form button.primary');
    await joinBtn.click();

    await pageB.waitForSelector('.dock-btn.mic', { timeout: 15000 });
    await pageB.waitForFunction(() => window.__watchTogether?.room?.me?.id?.length > 0, { timeout: 10000 });
    const viewerId = await pageB.evaluate(() => window.__watchTogether?.room?.me?.id);
    console.log(`Viewer joined with id: ${viewerId}`);

    // Wait for Host to see Viewer in roster
    await pageA.waitForFunction((vid) => {
      const room = window.__watchTogether?.room;
      return room?.roster?.some((p) => p.id === vid && p.online);
    }, {}, viewerId);

    // 3. Confirm Viewer does NOT see "Choose movie" initially
    const viewerCanChooseInitially = await pageB.evaluate(() => {
      const btn = document.querySelector('.stage-empty button');
      return btn && btn.textContent.includes('Choose movie');
    });
    console.log('Viewer sees Choose movie initially:', viewerCanChooseInitially);
    if (viewerCanChooseInitially) {
      throw new Error('Viewer should not see Choose movie button before being granted permission');
    }

    // 4. Host opens People panel and manages ViewerBob
    await pageA.evaluate(() => {
      const room = window.__watchTogether?.room;
      room.showSide('people');
    });

    // Wait for people panel to show ViewerBob
    await pageA.waitForSelector(`.person-main button[aria-label="Manage ViewerBob"]`, { timeout: 5000 });
    const manageBtn = await pageA.$(`.person-main button[aria-label="Manage ViewerBob"]`);
    await manageBtn.click();

    // Verify prominent permissions editor is visible
    await pageA.waitForSelector('.perm-editor', { timeout: 5000 });
    const permLabelText = await pageA.evaluate(() => {
      const labels = [...document.querySelectorAll('.perm-row')].map((el) => ({
        label: el.querySelector('.perm-label')?.textContent?.trim(),
        hint: el.querySelector('.perm-hint')?.textContent?.trim(),
        perm: el.querySelector('input')?.dataset?.perm,
      }));
      return labels;
    });
    console.log('Permissions in editor:', JSON.stringify(permLabelText));

    const streamPermEntry = permLabelText.find((p) => p.perm === 'stream_movie');
    if (!streamPermEntry || !streamPermEntry.label.includes('Stream movies from their computer')) {
      throw new Error(`Expected permission label "Stream movies from their computer", got: ${JSON.stringify(streamPermEntry)}`);
    }

    // Check ONLY "stream_movie"
    await pageA.evaluate(() => {
      const inputs = document.querySelectorAll('.perm-editor input[type=checkbox]');
      for (const input of inputs) {
        input.checked = input.dataset.perm === 'stream_movie';
      }
    });

    // Click "Make co-host" / "Save permissions"
    const savePermBtn = await pageA.$('.perm-actions button.primary');
    await savePermBtn.click();
    console.log('Host clicked save permissions with only stream_movie checked.');

    // 5. On Viewer screen: Wait for "Choose movie" button to appear!
    await pageB.waitForFunction(() => {
      const btn = document.querySelector('.stage-empty button');
      return btn && btn.textContent.includes('Choose movie');
    }, { timeout: 10000 });
    console.log('SUCCESS: "Choose movie" button appeared on Viewer screen!');

    // Wait for viewer media connection to be established
    await pageB.waitForFunction(() => window.__watchTogether?.room?.media?.connected === true, { timeout: 15000 });
    console.log('Viewer media is connected.');

    // 6. Viewer loads the test movie file
    const fileInput = await pageB.$('input[type=file]');
    await fileInput.uploadFile(MOVIE_PATH);
    console.log('Viewer uploaded test movie file.');

    // 7. Wait for Viewer to become streamer
    await pageB.waitForFunction(() => {
      const room = window.__watchTogether?.room;
      return room?.player?.isStreamer === true && room?.playback?.has_movie === true;
    }, { timeout: 15000 });
    console.log('SUCCESS: Viewer player became streamer and playback started!');

    // 8. Wait for Host to see movie playback state from Viewer
    await pageA.waitForFunction((vid) => {
      const room = window.__watchTogether?.room;
      return room?.playback?.has_movie === true && room?.playback?.streamer_id === vid;
    }, { timeout: 15000 }, viewerId);
    console.log('SUCCESS: Host sees playback state with streamer === viewer!');

    // Verify Host controls are synced and Host can drive
    const hostCanDrive = await pageA.evaluate(() => {
      const room = window.__watchTogether?.room;
      return room?.player?.canDrive();
    });
    console.log('Host canDrive:', hostCanDrive);
    if (!hostCanDrive) throw new Error('Host should be able to drive playback while co-host streams');

    // Host clicks toggle play/pause
    await pageA.evaluate(() => {
      const room = window.__watchTogether?.room;
      room.player.togglePlay();
    });

    // Wait for Viewer's player to pause in response to host command
    await pageB.waitForFunction(() => {
      const room = window.__watchTogether?.room;
      return room?.player?.vMovie?.paused === true || room?.playback?.playing === false;
    }, { timeout: 8000 });
    console.log('SUCCESS: Host togglePlay paused co-host movie playback!');

    console.log('Item 5 browser verification PASSED successfully!');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
