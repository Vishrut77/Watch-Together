import puppeteer from 'puppeteer-core';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8000';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  console.log('Starting Item 4 Verification Test (Room Lifecycle, Now Showing, Rejoin Window)...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    defaultViewport: { width: 1280, height: 720 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    // Context A: Host
    const ctxA = await browser.createBrowserContext();
    const pageA = await ctxA.newPage();

    // 1. Host creates public room
    await pageA.goto(BASE, { waitUntil: 'networkidle0' });
    await pageA.waitForSelector('input[aria-label=Nickname]');
    await pageA.type('input[aria-label=Nickname]', 'HostAlice');

    const createBtn = await pageA.$('button.primary');
    await createBtn.click();

    await pageA.waitForSelector('form.form');
    await pageA.type('input[placeholder="Friday movie night"]', 'Lifecycle Test Room');
    const submitBtn = await pageA.$('form.form button.primary');
    await submitBtn.click();

    await pageA.waitForSelector('.dock-btn.mic', { timeout: 15000 });
    const roomUrl = pageA.url();
    const roomId = roomUrl.split('/room/')[1];
    console.log(`Host created room ${roomId} at ${roomUrl}`);

    // Wait for websocket state and roster to populate
    await pageA.waitForFunction(() => {
      const room = window.__watchTogether?.room;
      return room?.me?.id && room?.roster && room.roster.length > 0;
    }, { timeout: 10000 });

    // Verify host is in roster as online
    const rosterData = await pageA.evaluate(() => {
      const room = window.__watchTogether?.room;
      return { me: room?.me, roster: room?.roster };
    });
    console.log('Roster data on pageA:', JSON.stringify(rosterData));
    const meInRoster = rosterData.roster?.find((p) => p.id === rosterData.me?.id);
    const hostOnline = meInRoster?.online === true;
    console.log('Host online in own roster:', hostOnline);
    if (!hostOnline) throw new Error('Host not online in own roster');

    // 2. Check GET /api/rooms: Room must be listed with participants_count === 1
    const resNowShowing1 = await fetch(`${BASE}/api/rooms`).then((r) => r.json());
    const publicEntry1 = resNowShowing1.find((r) => r.id === roomId);
    console.log('Now showing with 1 online:', publicEntry1);
    if (!publicEntry1 || publicEntry1.participants_count !== 1) {
      throw new Error(`Expected room ${roomId} with participants_count 1 in now showing, got: ${JSON.stringify(publicEntry1)}`);
    }

    // 3. Context B: Guest joins
    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    await pageB.goto(roomUrl, { waitUntil: 'networkidle0' });

    // Join modal
    await pageB.waitForSelector('form.form input.input', { timeout: 10000 });
    await pageB.type('form.form input.input', 'GuestBob');
    const joinBtn = await pageB.$('form.form button.primary');
    await joinBtn.click();

    await pageB.waitForSelector('.dock-btn.mic', { timeout: 15000 });
    await pageB.waitForFunction(() => window.__watchTogether?.room?.me?.id?.length > 0, { timeout: 10000 });
    const guestId = await pageB.evaluate(() => window.__watchTogether?.room?.me?.id);
    console.log(`Guest joined with id: ${guestId}`);

    // Wait for Host to see Guest in roster as online
    await pageA.waitForFunction((gid) => {
      const room = window.__watchTogether?.room;
      const p = room?.roster?.find((x) => x.id === gid);
      return p && p.online === true;
    }, {}, guestId);
    console.log('Host sees GuestBob online.');

    // 4. Guest closes tab / pagehide (simulated or page.close)
    // Send beacon /away or trigger pagehide on guest
    await pageB.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await pageB.close();
    console.log('Guest closed tab (dispatched pagehide beacon).');

    // 5. Host should see GuestBob marked offline within ~1s
    const startWait = Date.now();
    await pageA.waitForFunction((gid) => {
      const room = window.__watchTogether?.room;
      const p = room?.roster?.find((x) => x.id === gid);
      return p && p.online === false;
    }, { timeout: 4000 }, guestId);
    console.log(`Host observed Guest marked offline in ${Date.now() - startWait}ms.`);

    // 6. Context B rejoins within 15m window
    const pageB2 = await ctxB.newPage();
    await pageB2.goto(roomUrl, { waitUntil: 'networkidle0' });
    await pageB2.waitForSelector('.dock-btn.mic', { timeout: 15000 });
    await pageB2.waitForFunction(() => window.__watchTogether?.room?.me?.id?.length > 0, { timeout: 10000 });
    const rejoinedGuestId = await pageB2.evaluate(() => window.__watchTogether?.room?.me?.id);
    console.log(`Guest resumed seat within rejoin window with id: ${rejoinedGuestId}`);
    if (rejoinedGuestId !== guestId) {
      throw new Error(`Rejoined guest id mismatch: expected ${guestId}, got ${rejoinedGuestId}`);
    }

    // 7. Both users leave/close tab -> Now showing hides 0-online room
    await pageB2.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await pageB2.close();

    await pageA.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await pageA.close();

    await sleep(1000);
    const resNowShowing2 = await fetch(`${BASE}/api/rooms`).then((r) => r.json());
    const publicEntry2 = resNowShowing2.find((r) => r.id === roomId);
    console.log('Now showing after everyone closed tab:', publicEntry2);
    if (publicEntry2) {
      throw new Error(`Expected room ${roomId} to be hidden from /api/rooms when 0 online, but found: ${JSON.stringify(publicEntry2)}`);
    }

    console.log('Item 4 browser verification PASSED successfully!');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
