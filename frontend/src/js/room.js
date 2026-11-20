// The watch-party room: wires the socket, media, player, chat and panels together.
import { api, clearSession, wsUrl } from './api.js';
import { ChatPanel } from './chat.js';
import { Dock, PeoplePanel, RoomPanel, openInvite } from './controls.js';
import { Media, qualityLabel } from './livekit.js';
import { TheatrePlayer } from './player.js';
import { icon } from './icons.js';
import { avatar, copyText, h, toast } from './ui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RoomController {
  constructor(root, { code, session, onExit }) {
    this.root = root;
    this.code = code;
    this.token = session.token;
    this.inviteToken = session.invite || null;
    this.onExit = onExit;
    this.me = { id: '', nickname: '', role: 'participant', permissions: [] };
    this.room = null;
    this.roster = [];
    this.playback = null;
    this.ws = null;
    this.wsOpen = false;
    this.retry = 0;
    this.destroyed = false;
    this.ended = null;
    this.firstState = true;
    this.mediaError = null;
    this.tiles = new Map();
    this.sideTab = 'chat';
    this.peopleSig = '';

    this.media = new Media({
      isStreamer: (id) => this.playback?.streamer_id === id,
      onChange: () => this.onMediaChange(),
      onSpeaking: (speaking) => this.onSpeakingChange(speaking),
      onInfo: (msg) => toast(msg, 'info', 5000),
      onError: (msg) => toast(msg, 'error', 7000),
    });
    this.media.hooks.onDisconnected = () => this.retryMedia();

    this.chat = new ChatPanel({
      send: (m) => this.send(m),
      getMyId: () => this.me.id,
      onUnread: (n) => this.setUnread(n),
      getRoster: () => this.roster,
      getRoomName: () => this.room?.name || 'WatchTogether',
    });
    this.player = new TheatrePlayer({
      send: (m) => this.send(m),
      media: this.media,
      getMe: () => this.me,
      has: (p) => this.has(p),
      getRoomCode: () => this.code,
      getToken: () => this.token,
      onTheatre: (on) => {
        if (on) this.toggleSide(false);
        else this.chat.setVisible(this.sideTab === 'chat' && this.isSideVisible());
        this.dock?.update();
      },
    });
    this.people = new PeoplePanel(this);
    this.roomPanel = new RoomPanel(this);
    this.dock = new Dock(this);
    this.buildLayout();
  }

  // ---------------------------------------------------------------- permissions (UI hints only; the backend enforces)
  has(perm) {
    return this.me.role === 'owner' || (this.me.role === 'cohost' && this.me.permissions.includes(perm));
  }
  isHostSide() { return this.me.role === 'owner' || this.me.role === 'cohost'; }
  canActOn(p) {
    if (p.id === this.me.id || p.role === 'owner') return false;
    return this.me.role === 'owner' || (this.me.role === 'cohost' && p.role === 'participant');
  }
  myHand() { return !!this.roster.find((p) => p.id === this.me.id)?.hand_raised; }
  showRoomTab() { return this.me.role === 'owner' || this.has('manage_settings') || this.has('manage_screen_share'); }
  inviteLink() {
    const base = `${location.origin}/room/${this.code}`;
    return this.inviteToken && this.room && !this.room.is_public ? `${base}?invite=${encodeURIComponent(this.inviteToken)}` : base;
  }

  // ---------------------------------------------------------------- layout
  buildLayout() {
    this.titleEl = h('strong', { class: 'room-name' }, 'Loading…');
    this.codeBtn = h('button', { class: 'code-chip', title: 'Copy room code', onclick: async () => toast((await copyText(this.code)) ? 'Room code copied.' : 'Copy failed.', 'success') }, this.code, icon('copy', 14));
    this.conn = h('span', { class: 'conn', role: 'status' });
    this.countBtn = h('button', { class: 'pill-btn', title: 'People in the room', onclick: () => this.showSide('people') }, icon('users', 16), h('span', {}, '0'));
    this.sideToggle = h('button', { class: 'icon-btn side-toggle', title: 'Chat and people', 'aria-label': 'Open chat and people', onclick: () => this.toggleSide() }, icon('message'));
    this.top = h('header', { class: 'topbar' },
      h('div', { class: 'brand-mini' }, h('span', { class: 'logo-dot' }, icon('play', 12)), h('span', { class: 'brand-name' }, 'WatchTogether')),
      h('div', { class: 'room-id' }, this.titleEl, this.codeBtn),
      h('div', { class: 'top-right' }, this.conn, this.countBtn, h('button', { class: 'btn sm', onclick: () => openInvite(this) }, icon('link', 16), h('span', { class: 'lbl' }, 'Invite')), this.sideToggle));

    this.strip = h('div', { class: 'strip', 'aria-label': 'People in the room' });
    this.mediaNote = h('div', { class: 'media-note', hidden: true });
    this.soundBtn = h('button', { class: 'btn primary sound-btn', hidden: true, onclick: () => this.media.enableAudioPlayback() }, icon('volume', 16), 'Click to enable sound');

    this.tabChat = this.tabButton('chat', 'Chat', 'message');
    this.tabPeople = this.tabButton('people', 'People', 'users');
    this.tabRoom = this.tabButton('room', 'Room', 'shield');
    this.tabs = h('div', { class: 'side-tabs', role: 'tablist' }, this.tabChat, this.tabPeople, this.tabRoom);
    this.panels = h('div', { class: 'side-panels' }, this.chat.el, this.people.el, this.roomPanel.el);
    this.side = h('aside', { class: 'side' }, this.tabs, this.panels, h('button', { class: 'icon-btn side-close', 'aria-label': 'Close panel', onclick: () => this.toggleSide(false) }, icon('x')));

    this.backdrop = h('div', { class: 'side-backdrop', 'aria-hidden': 'true', onclick: () => this.toggleSide(false) });
    this.layout = h('main', { class: 'layout' }, this.backdrop, h('section', { class: 'stage-col' }, this.mediaNote, this.player.el, this.soundBtn, this.strip), this.side);
    this.view = h('div', { class: 'room' }, this.top, this.layout, this.dock.el);
    this.root.replaceChildren(this.view);
    document.body.classList.add('in-room');
    this.showSide('chat', false);
  }

  tabButton(id, label, ic) {
    return h('button', { class: 'side-tab', role: 'tab', dataset: { tab: id }, onclick: () => this.showSide(id) }, icon(ic, 16), label, h('span', { class: 'badge', hidden: true }));
  }

  /** Exit theatre mode first if active, then reveal the Chat panel. */
  openChat() {
    if (document.body.classList.contains('theatre')) {
      this.player.setTheatre(false);
    }
    const openDrawer = !window.matchMedia('(min-width: 981px)').matches;
    this.showSide('chat', openDrawer);
  }

  showSide(tab, open = true) {
    if (tab === 'room' && !this.showRoomTab()) tab = 'chat';
    if (open && document.body.classList.contains('theatre')) {
      this.player.setTheatre(false);
      open = !window.matchMedia('(min-width: 981px)').matches;
    }
    this.sideTab = tab;
    for (const b of this.tabs.children) {
      const on = b.dataset.tab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    this.chat.el.hidden = tab !== 'chat';
    this.people.el.hidden = tab !== 'people';
    this.roomPanel.el.hidden = tab !== 'room';
    this.chat.setVisible(tab === 'chat' && this.isSideVisible());
    if (open) this.toggleSide(true);
    if (tab === 'chat') setTimeout(() => this.chat.scrollToEnd(), 0);
  }

  isSideVisible() {
    if (document.body.classList.contains('theatre')) return false;
    return this.layout.classList.contains('side-open') || window.matchMedia('(min-width: 981px)').matches;
  }

  toggleSide(force) {
    const open = force ?? !this.layout.classList.contains('side-open');
    if (open && document.body.classList.contains('theatre')) {
      this.player.setTheatre(false);
      if (window.matchMedia('(min-width: 981px)').matches) {
        this.layout.classList.remove('side-open');
        document.body.classList.remove('side-open');
        this.chat.setVisible(this.sideTab === 'chat' && this.isSideVisible());
        this.dock?.update();
        return;
      }
    }
    this.layout.classList.toggle('side-open', open);
    document.body.classList.toggle('side-open', open);
    this.chat.setVisible(this.sideTab === 'chat' && this.isSideVisible());
    this.dock?.update();
  }

  setUnread(n) {
    const badge = this.tabChat.querySelector('.badge');
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
    this.sideToggle.classList.toggle('has-unread', n > 0);
    if (this.dock?.chatBadge) {
      this.dock.chatBadge.hidden = !n;
      this.dock.chatBadge.textContent = n > 99 ? '99+' : String(n);
    }
  }

  // ---------------------------------------------------------------- lifecycle
  start() {
    this.connectWs();
    this.heartbeat = setInterval(() => this.send({ type: 'ping' }), 20000);
    this.onAway = () => {
      if (this.code && this.token) {
        const url = `/api/rooms/${this.code}/away`;
        const blob = new Blob([JSON.stringify({ session_token: this.token })], { type: 'application/json' });
        navigator.sendBeacon?.(url, blob);
      }
    };
    window.addEventListener('pagehide', this.onAway);
    window.addEventListener('beforeunload', this.onAway);
  }

  destroy() {
    this.destroyed = true;
    document.body.classList.remove('in-room', 'side-open');
    if (this.onAway) {
      window.removeEventListener('pagehide', this.onAway);
      window.removeEventListener('beforeunload', this.onAway);
    }
    clearInterval(this.heartbeat);
    try { this.ws?.close(1000); } catch { /* ignore */ }
    this.player.destroy();
    this.media.destroy();
  }

  async leave() {
    try { await api.leave(this.code, this.token); } catch { /* leaving anyway */ }
    clearSession(this.code);
    this.destroy();
    this.onExit('/');
  }

  end(title, text) {
    if (this.destroyed) return;
    this.ended = { title, text };
    document.body.classList.remove('in-room', 'side-open');
    this.player.destroy();
    this.media.destroy();
    clearInterval(this.heartbeat);
    this.destroyed = true;
    try { this.ws?.close(1000); } catch { /* ignore */ }
    this.root.replaceChildren(h('div', { class: 'end-screen' }, h('div', { class: 'ticket-card' }, h('h1', {}, title), h('p', {}, text),
      h('button', { class: 'btn primary lg', onclick: () => this.onExit('/') }, 'Back to home'))));
  }

  // ---------------------------------------------------------------- websocket
  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    else toast('Reconnecting… try again in a moment.', 'warn');
  }

  connectWs() {
    if (this.destroyed) return;
    const ws = new WebSocket(wsUrl(this.code, this.token));
    this.ws = ws;
    ws.onopen = () => { this.wsOpen = true; this.retry = 0; this.renderConn(); };
    ws.onmessage = (e) => { try { this.onMessage(JSON.parse(e.data)); } catch (err) { console.error('bad message', err); } };
    ws.onclose = (ev) => {
      if (this.destroyed || this.ws !== ws) return;
      this.wsOpen = false;
      this.renderConn();
      this.onClosed(ev.code);
    };
  }

  async onClosed(code) {
    if (this.pendingEnd) return this.end(...this.pendingEnd);
    if (code === 4410) return this.end('This room has ended', 'The host closed the room. Thanks for watching!');
    if (code === 4403) return this.end('You were removed', 'You can’t stay in this room right now.');
    if (code === 4409) return this.end('Opened somewhere else', 'This room is open in another tab or window, so this one was disconnected.');
    if (code === 4401) {
      try {
        const data = await api.resume(this.code, this.token);
        this.token = data.session_token;
        this.persist(data);
      } catch (e) {
        clearSession(this.code);
        if (e.status === 403 || e.status === 410) return this.end(e.status === 410 ? 'This room has ended' : 'You can’t rejoin', e.message);
        this.destroy();
        return this.onExit(`/room/${this.code}`);
      }
      return this.connectWs();
    }
    const delay = Math.min(1000 * 2 ** this.retry++, 10000);
    await sleep(delay);
    this.connectWs();
  }

  persist(data) {
    localStorage.setItem(`wt_session_${this.code}`, JSON.stringify({ token: data.session_token, invite: data.invite_token || this.inviteToken }));
  }

  onMessage(m) {
    switch (m.type) {
      case 'state': return this.onState(m);
      case 'roster': this.roster = m.participants; return this.onRoster();
      case 'me':
        this.me = m.participant; this.inviteToken = m.invite_token || this.inviteToken;
        return this.onMe();
      case 'room_update': this.room = m.room; return this.onRoom();
      case 'chat': case 'announcement':
        this.chat.add(m);
        if (m.kind === 'announcement') toast(`📣 ${m.nickname}: ${m.text}`, 'info', 8000);
        return;
      case 'participant_joined': toast(`${m.nickname} joined`, 'info', 2500); return this.chat.system(`${m.nickname} joined`);
      case 'participant_left': toast(`${m.nickname} left`, 'info', 2500); return this.chat.system(`${m.nickname} left`);
      case 'reaction':
        this.player.showReaction(m.emoji, m.nickname);
        this.pulseTile(m.participant_id);
        return;
      case 'hand': if (m.raised && m.participant_id !== this.me.id) toast(`✋ ${m.nickname} raised a hand`, 'info', 3000); return;
      case 'playback':
        this.playback = m;
        this.player.applyPlayback(m);
        this.media.refresh();
        return this.onRoster();
      case 'playback_command': return this.player.handleCommand(m);
      case 'movie_stopped': toast(m.reason || 'Your movie was stopped.', 'info'); return this.player.cleanupLocal();
      case 'muted':
        this.media.setMic(false).catch(() => {});
        return toast(`${m.by} muted your microphone.`, 'info');
      case 'notice': return toast(m.text, 'info');
      case 'kicked': this.pendingEnd = ['You were removed', 'The host removed you from the room. You can rejoin if it is still open.']; return;
      case 'banned': this.pendingEnd = ['You were banned', 'The host banned you from this room.']; return;
      case 'room_closed': this.pendingEnd = ['This room has ended', 'The host closed the room. Thanks for watching!']; return;
      case 'left': this.pendingEnd = ['You left the room', 'See you next time.']; return;
      case 'replaced': this.pendingEnd = ['Opened somewhere else', 'This room is open in another tab or window, so this one was disconnected.']; return;
      case 'error':
        if (['forbidden', 'busy'].includes(m.code) && this.player.rejectAck(m.message)) return;
        return toast(m.message, 'error');
      default:
    }
  }

  onState(m) {
    this.me = m.me;
    this.room = m.room;
    this.roster = m.participants;
    this.playback = m.playback;
    this.inviteToken = m.invite_token || this.inviteToken;
    this.player.applyPlayback(m.playback);
    this.chat.reset(m.chat);
    this.onMe();
    this.onRoom();
    this.onRoster();
    if (this.firstState) {
      this.firstState = false;
      this.connectMedia();
    } else {
      this.player.onReconnected(m.playback);
    }
  }

  onMe() {
    this.tabRoom.hidden = !this.showRoomTab();
    if (this.sideTab === 'room' && !this.showRoomTab()) this.showSide('chat', false);
    this.dock.update();
    this.player.render();
    this.roomPanel.render();
    this.peopleSig = '';
    this.people.render();
  }

  onRoom() {
    this.titleEl.textContent = this.room.name;
    document.title = `${this.room.name} · WatchTogether`;
    this.chat.setEnabled(this.room.chat_enabled || this.isHostSide());
    this.dock.update();
    this.roomPanel.render();
  }

  onRoster() {
    this.countBtn.lastChild.textContent = String(this.roster.length);
    const streamer = this.playback?.streamer_id;
    if (streamer) this.player.setStreamerOnline(this.roster.some((p) => p.id === streamer && p.online));
    this.renderPeople();
    this.renderStrip();
    this.dock.update();
  }

  renderPeople() {
    const sig = JSON.stringify([this.roster, [...this.media.state.mics], this.people.open, this.me.role, this.me.permissions]);
    if (sig === this.peopleSig) return;
    this.peopleSig = sig;
    this.people.render();
  }

  // ---------------------------------------------------------------- media
  async connectMedia() {
    try {
      const t = await api.livekitToken(this.code, this.token);
      await this.media.connect(t.url, t.token);
      this.mediaError = null;
    } catch (e) {
      this.mediaError = e.status === 503
        ? 'Video and voice aren’t set up on this server yet. Chat and the room still work.'
        : `Couldn’t connect video and voice: ${e.message}`;
    }
    this.onMediaChange();
  }

  async retryMedia() {
    for (let i = 0; i < 6 && !this.destroyed && !this.media.connected; i++) {
      await sleep(Math.min(2000 * 2 ** i, 15000));
      if (this.destroyed) return;
      await this.connectMedia();
      if (this.media.connected) return;
    }
  }

  onSpeakingChange(speaking) {
    if (this.destroyed) return;
    for (const [id, tile] of this.tiles.entries()) {
      tile.el.classList.toggle('speaking', speaking.has(id));
    }
  }

  onMediaChange() {
    if (this.destroyed) return;
    if (this._mediaChangePending) return;
    this._mediaChangePending = true;
    const run = () => {
      this._mediaChangePending = false;
      if (this.destroyed) return;
      this._doMediaChange();
    };
    if (document.hidden) setTimeout(run, 16);
    else requestAnimationFrame(run);
  }

  _doMediaChange() {
    this.player.updateSources(this.media.state);
    this.dock.update();
    this.renderStrip();
    this.renderPeople();
    this.renderConn();
    this.mediaNote.hidden = !this.mediaError;
    this.mediaNote.textContent = this.mediaError || '';
    this.soundBtn.hidden = !this.media.audioBlocked;
  }

  renderConn() {
    let label, cls;
    if (!this.wsOpen) { label = 'Reconnecting…'; cls = 'warn'; }
    else if (this.mediaError) { label = 'Chat only'; cls = 'warn'; }
    else if (this.media.connection === 'connected') {
      label = `Connection: ${qualityLabel(this.media.quality)}`;
      cls = ['poor', 'lost'].includes(this.media.quality) ? 'bad' : 'good';
    } else if (this.media.connection === 'reconnecting') { label = 'Reconnecting video…'; cls = 'warn'; }
    else { label = 'Connecting…'; cls = 'warn'; }
    this.conn.className = `conn ${cls}`;
    this.conn.replaceChildren(h('i', {}), label);
  }

  // ---------------------------------------------------------------- participant strip
  renderStrip() {
    const state = this.media.state;
    const seen = new Set();
    const sharingId = state.screen?.identity;
    for (const p of this.roster) {
      seen.add(p.id);
      let t = this.tiles.get(p.id);
      if (!t) {
        t = { video: h('video', { class: 'cam', autoplay: true, muted: true, playsinline: true }), track: null };
        t.video.setAttribute('playsinline', '');
        t.video.muted = true;
        t.avatar = h('div', { class: 'tile-avatar' });
        t.name = h('span', { class: 'tile-name' });
        t.icons = h('span', { class: 'tile-icons' });
        t.el = h('div', { class: 'tile' }, t.video, t.avatar, h('div', { class: 'tile-label' }, t.name, t.icons));
        this.tiles.set(p.id, t);
        this.strip.append(t.el);
      }
      const cam = state.cameras.get(p.id);
      const track = cam && !cam.muted ? cam.track : null;
      if (t.track !== track) {
        if (t.track) { try { t.track.detach(t.video); } catch { /* ignore */ } }
        t.track = track;
        if (track) { track.attach(t.video); t.video.play?.().catch(() => {}); } else t.video.srcObject = null;
      }
      const mic = state.mics.get(p.id);
      t.el.classList.toggle('has-video', !!track);
      t.el.classList.toggle('speaking', this.media.speaking.has(p.id));
      t.el.classList.toggle('hand-raised', !!p.hand_raised);
      t.el.classList.toggle('offline', !p.online);
      if (t.avatar.dataset.name !== p.nickname) { t.avatar.dataset.name = p.nickname; t.avatar.replaceChildren(avatar(p.nickname, 44)); }
      t.name.textContent = p.id === this.me.id ? `${p.nickname} (you)` : p.nickname;
      t.icons.replaceChildren(...[
        p.role !== 'participant' ? h('span', { class: 'role-dot', title: p.role === 'owner' ? 'Host' : 'Co-host' }, '★') : null,
        p.hand_raised ? h('span', { title: 'Hand raised' }, '✋') : null,
        sharingId === p.id ? h('span', { title: 'Sharing screen' }, icon('monitor', 13)) : null,
        mic && mic.muted ? h('span', { class: 'muted-mic', title: 'Mic off' }, icon('mic-off', 13)) : null].filter(Boolean));
    }
    for (const [id, t] of this.tiles) {
      if (!seen.has(id)) {
        try { t.track?.detach(t.video); } catch { /* ignore */ }
        t.el.remove();
        this.tiles.delete(id);
      }
    }
  }

  pulseTile(id) {
    const t = this.tiles.get(id);
    if (!t?.el) return;
    t.el.classList.remove('pulse-reaction');
    void t.el.offsetWidth;
    t.el.classList.add('pulse-reaction');
    setTimeout(() => t.el?.classList.remove('pulse-reaction'), 1250);
  }
}
