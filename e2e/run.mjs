import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const BASE = 'http://127.0.0.1:8000';
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 250) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return false; }

const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(), headless: 'shell', protocolTimeout: 180000, defaultViewport: { width: 1400, height: 860 },
  args: [...chromium.args.filter((a) => !/single-process|no-zygote/.test(a)), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--auto-accept-this-tab-capture', '--auto-select-desktop-capture-source=Entire screen'],
});
async function newPerson(name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  page.nameTag = name;
  return page;
}
const clickText = (page, text) => page.evaluate((t) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t && !x.disabled); if (!b) throw new Error('no button ' + t); b.click(); }, text);
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
async function join(page, code, nick, extra = {}) {
  await page.goto(`${BASE}/room/${code}${extra.query || ''}`);
  await page.waitForSelector('input.input');
  await page.$eval('input.input', (el) => (el.value = ''));
  await page.type('input.input', nick);
  await clickText(page, 'Join room');
}
const roomReady = (page) => until(() => page.$('.dock-btn.mic:not([disabled])'), 20000);
const hs = (p, tag) => p.evaluate(() => { const r = window.__watchTogether.room; return r.player.isStreamer; }).then((v) => console.log('>> host streaming?', tag, v));
const shot = (page, n) => page.screenshot({ path: `/tmp/e2e/${n}.png` });

try {
  // ---- landing + create ----
  const host = await newPerson('Host');
  await host.goto(BASE);
  await host.waitForSelector('input[aria-label=Nickname]');
  await shot(host, '01-landing');
  await host.type('input[aria-label=Nickname]', 'Hosty');
  await clickText(host, 'Create room');
  await host.waitForSelector('form.form');
  await host.type('input[placeholder="Friday movie night"]', 'E2E Cinema');
  await clickText(host, 'Create room');
  const code = await until(() => host.$eval('.code-chip', (e) => e.textContent.trim()), 10000);
  check('1. user can create a room', /^[A-Z0-9]{6}$/.test(code), code);
  check('   host connected to media (LiveKit)', !!(await roomReady(host)));

  // ---- public directory ----
  const lobby = await newPerson('Lobby');
  await lobby.goto(BASE);
  const listed = await until(() => lobby.evaluate(() => document.body.textContent.includes('E2E Cinema')), 8000);
  check('3. public room appears in directory', !!listed);
  await shot(lobby, '02-directory');

  // ---- guests join via invite link ----
  const alice = await newPerson('Alice'); const bob = await newPerson('Bob');
  await join(alice, code, 'Alice'); await join(bob, code, 'Bob');
  check('2. participants join via link', !!(await roomReady(alice)) && !!(await roomReady(bob)));

  // ---- movie ----
  const fileInput = await host.$('input[type=file]');
  await fileInput.uploadFile('/tmp/e2e/movie.webm');
  const live = await until(() => host.evaluate(() => [...document.querySelectorAll('.chip')].map((c) => c.textContent).join('|')).then((t) => t.includes('LIVE') && t.includes('✓ Video') && t.includes('✓ Audio') && t), 20000);
  check('5. host loads local movie (no upload) & publishes video+audio', !!live, String(live));
  await clickText(host, '').catch(() => {});
  await host.click('.ctl.play');
  await sleep(2500);
  const viewer = (p) => p.evaluate(() => {
    const v = document.querySelector('.stage video.layer.on');
    const audios = [...document.querySelectorAll('audio')].filter((a) => a.srcObject && a.srcObject.getAudioTracks().some((t) => t.readyState === 'live'));
    return v ? { w: v.videoWidth, h: v.videoHeight, t: v.currentTime, paused: v.paused, audio: audios.length, aMuted: audios.map((a) => a.muted), vol: audios.map((a) => a.volume) } : null;
  });
  const a1 = await until(async () => { const s = await viewer(alice); return s && s.w > 0 && s; }, 15000);
  await sleep(2000);
  const a2 = await viewer(alice);
  check('6. participant receives movie video', !!a1 && a2.t > a1.t, a1 ? `${a1.w}x${a1.h}, t ${a1.t.toFixed(1)}→${a2.t.toFixed(1)}` : 'no video');
  check('7. participant receives movie audio (separate track)', !!a2 && a2.audio >= 1, a2 && `${a2.audio} live audio elements`);
  const b1 = await viewer(bob);
  check('   second participant also receives video', !!b1 && b1.w > 0, b1 && `${b1.w}x${b1.h}`);
  await shot(alice, '03-viewer-playing'); await shot(host, '04-host-playing');

  // ---- sync ----
  const playState = (p) => p.$eval('.ctl.play', (b) => b.dataset.playing);
  await host.click('.ctl.play');
  const paused = await until(async () => (await playState(alice)) === 'false' && (await playState(bob)) === 'false', 6000);
  check('8a. host pause syncs to viewers', !!paused);
  await host.evaluate(() => { const r = window.__watchTogether.room; r.player.handleCommand({ action: 'seek', position: 20 }); });
  const tl = await until(async () => { const t = await alice.$eval('.controls .time', (e) => e.textContent); return t === '0:20' && t; }, 8000);
  check('8b. host seek syncs to viewers', tl === '0:20', `viewer timeline ${tl || 'stuck'}`);
  await host.click('.ctl.play');
  check('8c. viewers cannot drive playback', await alice.$eval('.ctl.play', (b) => b.disabled));

  // ---- co-host controls playback ----
  const grant = await host.evaluate(async (code) => {
    const s = JSON.parse(localStorage.getItem(`wt_session_${code}`));
    const H = { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' };
    const list = await (await fetch(`/api/rooms/${code}/participants`, { headers: H })).json();
    const a = list.find((p) => p.nickname === 'Alice');
    const r = await fetch(`/api/rooms/${code}/participants/${a.id}/permissions`, { method: 'POST', headers: H, body: JSON.stringify({ permissions: ['manage_playback', 'mute_participants'] }) });
    return r.status;
  }, code);
  check('13. owner grants co-host permissions', grant === 200);
  await until(async () => !(await alice.$eval('.ctl.play', (b) => b.disabled)), 6000);
  const before = await host.evaluate(() => document.querySelector('.stage video.layer.on').currentTime);
  await alice.click('.ctl.fwd');
  await sleep(1500);
  const after = await host.evaluate(() => document.querySelector('.stage video.layer.on').currentTime);
  check('8d. co-host command reaches the streaming host (+10s skip)', after - before > 8, `${before.toFixed(1)}→${after.toFixed(1)}`);
  await alice.click('.ctl.play');
  check('8e. co-host play/pause toggles the movie for everyone', !!(await until(async () => (await playState(bob)) === 'false', 8000)));

  await hs(host, 'after-8e');
  // ---- chat ----
  await alice.click('.side-tab[data-tab=chat]');
  await alice.type('.chat-form input', 'hello from alice'); await alice.keyboard.press('Enter');
  const got = await until(() => bob.evaluate(() => [...document.querySelectorAll('.msg p')].some((p) => p.textContent === 'hello from alice')), 5000);
  const gotHost = await until(() => host.evaluate(() => [...document.querySelectorAll('.msg p')].some((p) => p.textContent === 'hello from alice')), 5000);
  check('10. chat reaches everyone in real time', !!got && !!gotHost);

  await hs(host, 'after-chat');
  // ---- camera / mic ----
  const audioBefore = await host.evaluate(() => document.querySelectorAll('audio').length);
  await bob.click('.dock-btn.cam'); await bob.click('.dock-btn.mic');
  const camTile = await until(() => host.evaluate(() => {
    const tiles = [...document.querySelectorAll('.tile.has-video')];
    return tiles.some((t) => t.querySelector('.tile-name').textContent.startsWith('Bob') && t.querySelector('video').videoWidth > 0);
  }), 15000);
  check('9a. participant camera visible to others', !!camTile);
  const audioAfter = await until(() => host.evaluate((n) => document.querySelectorAll('audio').length > n, audioBefore), 8000);
  check('9b. participant microphone reaches others', !!audioAfter);
  await shot(host, '05-host-with-camera');

  await hs(host, 'after-cam');
  // ---- hand + reaction ----
  await bob.click('.dock-btn.hand');
  await host.click('.side-tab[data-tab=people]');
  const hand = await until(() => host.evaluate(() => [...document.querySelectorAll('.person')].some((p) => p.textContent.includes('Bob') && p.textContent.includes('✋'))), 5000);
  check('   raise hand shows for others', !!hand);
  await bob.click('.dock-btn.react'); await bob.click('.emoji');
  check('   emoji reaction floats on stage', !!(await until(() => host.$('.reactions-layer .float'), 4000)));

  await hs(host, 'after-hand');
  // ---- screen share ----
  await clickText(host, 'Room').catch(() => {});
  await host.click('.side-tab[data-tab=room]');
  await host.evaluate(() => { const s = [...document.querySelectorAll('.switch-row select')][0]; s.value = 'everyone'; s.dispatchEvent(new Event('change')); });
  await sleep(800);
  await bob.click('.dock-btn.share'); await sleep(2500);
  const shareOn = await bob.$eval('.dock-btn.share', (b) => b.classList.contains('sharing'));
  const ts = await toasts(bob);
  check('11. screen sharing', shareOn, shareOn ? 'sharing' : `headless browser limitation? toasts: ${ts.join(' / ')}`);
  if (shareOn) { const seen = await until(() => alice.evaluate(() => !!document.querySelector('.chip.live.screen')), 10000); check('    others see who is sharing (indicator)', !!seen); await shot(alice, '06-screen-share'); console.log('>> stopping share'); await bob.click('.dock-btn.share'); console.log('>> share stopped'); }

  console.log('>> moderation');
  await hs(host, 'after-share');
  // ---- moderation via UI ----
  await host.click('.side-tab[data-tab=people]');
  const rowClick = async (page, nick, label) => {
    await page.evaluate((n) => { const row = [...document.querySelectorAll('.person')].find((p) => p.textContent.includes(n)); const open = row.querySelector('.person-actions'); if (!open) row.querySelector('.icon-btn').click(); }, nick);
    await sleep(250);
    return page.evaluate((n, l) => { const row = [...document.querySelectorAll('.person')].find((p) => p.textContent.includes(n)); const b = [...row.querySelectorAll('button.btn')].find((x) => x.textContent.trim() === l); if (!b) throw new Error('no ' + l); b.click(); return true; }, nick, label);
  };
  console.log('>> clicking mute');
  await rowClick(host, 'Bob', 'Mute');
  const muted = await until(async () => (await toasts(bob)).some((t) => t.includes('muted your microphone')), 5000);
  const bobMicOff = await until(() => bob.$eval('.dock-btn.mic', (b) => b.classList.contains('off')), 6000);
  check('12a. host can mute a participant (SFU + UI)', !!muted && !!bobMicOff);
  await rowClick(host, 'Bob', 'Remove');
  await host.waitForSelector('.dialog-actions .btn.danger'); await host.click('.dialog-actions .btn.danger');
  const kicked = await until(() => bob.$('.end-screen'), 6000);
  check('12b. host can remove a participant', !!kicked, kicked ? await bob.$eval('.end-screen h1', (e) => e.textContent) : '');

  await hs(host, 'after-mod');
  // ---- lock ----
  const lockStatus = await host.evaluate(async (code) => {
    const s = JSON.parse(localStorage.getItem(`wt_session_${code}`));
    const r = await fetch(`/api/rooms/${code}/lock`, { method: 'POST', headers: { Authorization: `Bearer ${s.token}` } });
    return r.status;
  }, code);
  const carol = await newPerson('Carol');
  await join(carol, code, 'Carol');
  const lockedMsg = await until(() => carol.$eval('.form-error', (e) => e.textContent), 5000);
  check('15. locked room blocks new joiners with a friendly message', lockStatus === 200 && /locked/i.test(lockedMsg || ''), lockedMsg);
  await host.evaluate(async (code) => { const s = JSON.parse(localStorage.getItem(`wt_session_${code}`)); await fetch(`/api/rooms/${code}/unlock`, { method: 'POST', headers: { Authorization: `Bearer ${s.token}` } }); }, code);

  await hs(host, 'after-lock');
  // ---- private room ----
  const priv = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Secret', is_public: false, nickname: 'P', client_id: 'private-owner-0001' }) }).then((r) => r.json());
  const noInvite = await fetch(`${BASE}/api/rooms/${priv.room.id}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'Eve', client_id: 'eve-client-0001' }) });
  const withInvite = await fetch(`${BASE}/api/rooms/${priv.room.id}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'Ann', client_id: 'ann-client-0001', invite_token: priv.invite_token }) });
  check('4. private room rejects uninvited, accepts invite', noInvite.status === 403 && withInvite.status === 200);

  await hs(host, 'after-private');
  // ---- reconnect ----
  await alice.evaluate(() => window.__watchTogether.room.ws.close());
  const back = await until(() => alice.evaluate(() => window.__watchTogether.room.wsOpen && window.__watchTogether.room.playback?.has_movie), 15000);
  check('16. dropped socket reconnects and re-syncs movie state', !!back);

  await hs(host, 'after-reconnect');
  // ---- host stops movie, viewers clean up ----
  const stopInfo = await host.evaluate(() => { const b = document.querySelector('.ctl.stop'); const r = window.__watchTogether.room; const vis = b && getComputedStyle(b).display; b.click(); return JSON.stringify({ vis, streamer: r.player.isStreamer, pb: r.playback.has_movie }); });
  console.log('>> stop click', stopInfo);
  const gone = await until(() => alice.evaluate(() => !document.querySelector('.chip.live')), 6000);
  check('   stopping the movie clears it for viewers', !!gone);

  // ---- end room ----
  await host.click('.side-tab[data-tab=room]');
  await clickText(host, 'End room for everyone'); await clickText(host, 'End room');
  const ended = await until(() => alice.$('.end-screen'), 8000);
  check('   owner ends room for everyone', !!ended);

  for (const p of [host, alice, bob, carol]) if (p.errors.length) console.log(`console errors [${p.nameTag}]:`, [...new Set(p.errors)].slice(0, 4));
} catch (e) {
  console.log('SCRIPT ERROR', e.message);
}
await browser.close();
console.log(`\n${results.filter((r) => r[1]).length}/${results.length} checks passed`);
