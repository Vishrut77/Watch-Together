import { icon } from './icons.js';
import { h } from './ui.js';

const MAX = 500;
const SOUND_KEY = 'wt_chat_sound';
const DEFAULT_PLACEHOLDER = 'Message room (@ to mention)';

// Web Audio API notification sound (zero external audio files)
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

['pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
  window.addEventListener(ev, () => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }, { once: true });
});

export function playMessageSound(isMention = false) {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  const now = ctx.currentTime;

  if (isMention) {
    // 3-tone bright chime for mentions: D5 (587) -> A5 (880) -> D6 (1174)
    // Richer harmonics and louder peak gain (0.7) for maximum audibility
    const notes = [
      { freq: 587.33, t: now, dur: 0.14 },
      { freq: 880.00, t: now + 0.08, dur: 0.16 },
      { freq: 1174.66, t: now + 0.16, dur: 0.32 },
    ];
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(n.freq, n.t);
      gain.gain.setValueAtTime(0.001, n.t);
      gain.gain.linearRampToValueAtTime(0.7, n.t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, n.t + n.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(n.t);
      osc.stop(n.t + n.dur + 0.02);
    }
  } else {
    // 2-tone clear pleasant chime for regular message: E5 (659) -> B5 (987)
    // Louder peak gain (0.55) with warm triangle harmonics
    const notes = [
      { freq: 659.25, t: now, dur: 0.14 },
      { freq: 987.77, t: now + 0.08, dur: 0.26 },
    ];
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(n.freq, n.t);
      gain.gain.setValueAtTime(0.001, n.t);
      gain.gain.linearRampToValueAtTime(0.55, n.t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, n.t + n.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(n.t);
      osc.stop(n.t + n.dur + 0.02);
    }
  }
}

/** Formats chat message text, wrapping valid @mentions from the roster in styled tags */
export function formatChatContent(text, roster, myId) {
  if (!text || !text.includes('@') || !roster?.length) {
    return [text];
  }
  // Sort unique candidate nicknames by length descending for longest-match matching
  const candidates = [...roster]
    .filter((p) => p && p.nickname)
    .sort((a, b) => b.nickname.length - a.nickname.length);

  const nodes = [];
  let remaining = text;

  while (remaining.length > 0) {
    let bestMatch = null;
    let bestIndex = -1;

    for (const p of candidates) {
      const esc = p.nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?:^|(?<=[^a-zA-Z0-9_.+-]))@${esc}(?=[^a-zA-Z0-9_]|$)`, 'i');
      const match = pattern.exec(remaining);
      if (match) {
        const atIdx = match.index + match[0].indexOf('@');
        if (bestIndex === -1 || atIdx < bestIndex) {
          bestIndex = atIdx;
          bestMatch = { p, length: p.nickname.length + 1, atIdx };
        }
      }
    }

    if (bestMatch && bestIndex !== -1) {
      if (bestIndex > 0) {
        nodes.push(remaining.slice(0, bestIndex));
      }
      const isMe = bestMatch.p.id === myId;
      nodes.push(h('span', { class: `mention-tag${isMe ? ' me' : ''}` }, `@${bestMatch.p.nickname}`));
      remaining = remaining.slice(bestIndex + bestMatch.length);
    } else {
      nodes.push(remaining);
      break;
    }
  }

  return nodes;
}

export class ChatPanel {
  constructor({ send, getMyId, onUnread, getRoster, getRoomName }) {
    this.send = send;
    this.getMyId = getMyId;
    this.onUnread = onUnread;
    this.getRoster = getRoster;
    this.getRoomName = getRoomName;
    this.visible = false;
    this.unread = 0;
    this.unreadBadge = 0;
    this.count = 0;
    this.baseTitle = document.title || 'WatchTogether';
    this.soundSetting = localStorage.getItem(SOUND_KEY) || 'all'; // all | mentions | mute

    this.list = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite', onscroll: () => this.onScroll() });
    this.empty = h('div', { class: 'empty' }, icon('message', 28), h('p', {}, 'No messages yet'), h('span', {}, 'Say hi — everyone in the room sees it.'));
    this.newBtn = h('button', { class: 'new-msgs', hidden: true, onclick: () => this.scrollToEnd(true) }, 'New messages ↓');
    
    // Autocomplete dropdown menu
    this.mentionMenu = h('div', { class: 'mention-menu', hidden: true });
    this.mentionMatches = [];
    this.mentionSelectedIndex = 0;
    this.mentionStartIndex = -1;

    this.input = h('input', {
      class: 'input',
      type: 'text',
      maxlength: String(MAX),
      placeholder: DEFAULT_PLACEHOLDER,
      'aria-label': 'Message',
      autocomplete: 'off',
      onkeydown: (e) => this.onInputKeyDown(e),
      oninput: () => this.onInput(),
    });
    this.counter = h('span', { class: 'counter' });
    this.sendBtn = h('button', { class: 'icon-btn send', title: 'Send', 'aria-label': 'Send message', onclick: () => this.submit() }, icon('send'));
    this.notice = h('div', { class: 'chat-notice', hidden: true });

    // Settings header
    this.settingsBtn = h('button', {
      class: 'icon-btn chat-settings-btn',
      title: 'Chat notification settings',
      'aria-label': 'Chat notification settings',
      onclick: (e) => { e.stopPropagation(); this.toggleSettingsMenu(); },
    }, icon('settings', 16));
    this.settingsMenu = h('div', { class: 'chat-settings-menu menu', hidden: true });
    this.header = h('div', { class: 'chat-header' },
      h('span', { class: 'chat-title' }, 'Chat'),
      h('div', { class: 'menu-anchor chat-settings-wrap' }, this.settingsBtn, this.settingsMenu),
    );

    this.el = h('div', { class: 'chat' },
      this.header,
      h('div', { class: 'chat-body' }, this.list, this.empty, this.newBtn),
      this.notice,
      h('div', { class: 'chat-form' }, this.mentionMenu, this.input, this.counter, this.sendBtn),
    );

    document.addEventListener('click', (e) => {
      if (!this.settingsMenu.hidden && !e.target.closest('.chat-settings-wrap')) {
        this.settingsMenu.hidden = true;
        this.settingsBtn.classList.remove('active');
      }
      if (!this.mentionMenu.hidden && !e.target.closest('.chat-form')) {
        this.hideMentionMenu();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.visible) {
        this.unreadBadge = 0;
        this.updateDocTitle();
      }
    });
  }

  toggleSettingsMenu() {
    if (!this.settingsMenu.hidden) {
      this.settingsMenu.hidden = true;
      this.settingsBtn.classList.remove('active');
      return;
    }
    const opt = (key, label) => h('button', {
      class: `menu-item${this.soundSetting === key ? ' on' : ''}`,
      onclick: () => {
        this.soundSetting = key;
        localStorage.setItem(SOUND_KEY, key);
        this.settingsMenu.hidden = true;
        this.settingsBtn.classList.remove('active');
        if (key === 'all') playMessageSound(false);
        else if (key === 'mentions') playMessageSound(true);
      },
    }, this.soundSetting === key ? icon('check', 16) : h('span', { class: 'pad' }), label);

    const items = [
      h('div', { class: 'menu-title' }, 'Notification sound'),
      opt('all', 'All messages'),
      opt('mentions', 'Only when mentioned'),
      opt('mute', 'Mute'),
    ];

    if ('Notification' in window && Notification.permission === 'default') {
      items.push(h('hr', { class: 'menu-sep' }));
      items.push(h('button', {
        class: 'menu-item',
        onclick: async () => {
          this.settingsMenu.hidden = true;
          this.settingsBtn.classList.remove('active');
          try { await Notification.requestPermission(); } catch {}
        },
      }, icon('bell', 16), 'Enable desktop alerts'));
    }

    this.settingsMenu.replaceChildren(...items);
    this.settingsMenu.hidden = false;
    this.settingsBtn.classList.add('active');
  }

  updateDocTitle() {
    const base = this.getRoomName ? this.getRoomName() : this.baseTitle;
    document.title = this.unreadBadge > 0 ? `(${this.unreadBadge}) ${base}` : base;
  }

  setVisible(v) {
    this.visible = v;
    if (v) {
      this.unread = 0;
      this.unreadBadge = 0;
      this.updateDocTitle();
      this.onUnread?.(0);
      this.scrollToEnd(false);
    }
  }

  setEnabled(enabled) {
    this.input.disabled = !enabled;
    this.sendBtn.disabled = !enabled;
    this.input.placeholder = enabled ? DEFAULT_PLACEHOLDER : 'Chat is turned off by the host';
    this.notice.hidden = enabled;
    this.notice.textContent = enabled ? '' : 'The host has turned chat off for participants.';
  }

  reset(history) {
    this.list.replaceChildren();
    this.count = 0;
    history.forEach((m) => this.add(m, true));
    this.updateEmpty();
    this.scrollToEnd(false);
  }

  add(msg, silent = false) {
    const myId = this.getMyId();
    const mine = msg.participant_id === myId;
    const mentionsMe = Array.isArray(msg.mentions) && msg.mentions.includes(myId);
    const atBottom = this.nearBottom();
    const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const contentNodes = formatChatContent(msg.text, this.getRoster?.(), myId);

    const row = msg.kind === 'announcement'
      ? h('div', { class: `msg announcement${mentionsMe ? ' mention-me' : ''}` },
          h('strong', {}, `📣 ${msg.nickname}`),
          h('p', {}, ...contentNodes),
          h('time', {}, time))
      : h('div', { class: `msg${mine ? ' mine' : ''}${mentionsMe ? ' mention-me' : ''}` },
          h('div', { class: 'msg-head' },
            h('strong', {}, mine ? 'You' : msg.nickname),
            msg.role !== 'participant' ? h('span', { class: 'role-tag' }, msg.role === 'owner' ? 'Host' : 'Co-host') : null,
            h('time', {}, time)),
          h('p', {}, ...contentNodes));

    this.list.append(row);
    this.count += 1;
    this.updateEmpty();

    if (silent) return;

    // Sounds
    if (!mine) {
      if (this.soundSetting === 'all') {
        playMessageSound(mentionsMe);
      } else if (this.soundSetting === 'mentions' && mentionsMe) {
        playMessageSound(true);
      }
    }

    // Scroll
    if (atBottom || mine) this.scrollToEnd(false);
    else this.newBtn.hidden = false;

    // Unread count & title badge
    if (!this.visible && !mine) {
      this.unread += 1;
      this.onUnread?.(this.unread);
    }
    if ((!this.visible || document.hidden) && !mine) {
      this.unreadBadge += 1;
      this.updateDocTitle();

      // Browser Desktop Notification (opt-in)
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted' && this.soundSetting !== 'mute') {
        if (this.soundSetting === 'all' || mentionsMe) {
          try {
            const n = new Notification(msg.nickname, {
              body: msg.text,
              tag: 'wt-chat',
            });
            n.onclick = () => { window.focus(); n.close(); };
          } catch {}
        }
      }
    }
  }

  system(text) {
    const atBottom = this.nearBottom();
    this.list.append(h('div', { class: 'msg system' }, text));
    this.updateEmpty();
    if (atBottom) this.scrollToEnd(false);
  }

  updateEmpty() {
    this.empty.hidden = this.list.children.length > 0;
  }

  nearBottom() {
    return this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 60;
  }

  onScroll() {
    if (this.nearBottom()) this.newBtn.hidden = true;
  }

  scrollToEnd() {
    this.list.scrollTop = this.list.scrollHeight;
    this.newBtn.hidden = true;
  }

  updateCounter() {
    const n = this.input.value.length;
    this.counter.textContent = n > MAX - 100 ? `${MAX - n}` : '';
  }

  // ---------------------------------------------------------------- autocomplete
  onInput() {
    this.updateCounter();
    this.checkMentionAutocomplete();
  }

  checkMentionAutocomplete() {
    const val = this.input.value;
    const selEnd = this.input.selectionEnd ?? val.length;
    const before = val.slice(0, selEnd);
    const atIdx = before.lastIndexOf('@');

    if (atIdx === -1 || (atIdx > 0 && !/[\s([{"']/.test(val[atIdx - 1]))) {
      this.hideMentionMenu();
      return;
    }

    const query = before.slice(atIdx + 1);
    if (/[\n\r]/.test(query)) {
      this.hideMentionMenu();
      return;
    }

    const roster = (this.getRoster?.() || []).filter((p) => p && p.nickname && p.id !== this.getMyId());
    const lower = query.toLowerCase();
    const matches = roster.filter((p) => p.nickname.toLowerCase().includes(lower));

    if (!matches.length) {
      this.hideMentionMenu();
      return;
    }

    this.mentionMatches = matches;
    this.mentionStartIndex = atIdx;
    this.mentionSelectedIndex = Math.min(this.mentionSelectedIndex, matches.length - 1);
    if (this.mentionSelectedIndex < 0) this.mentionSelectedIndex = 0;
    this.renderMentionMenu();
  }

  renderMentionMenu() {
    this.mentionMenu.replaceChildren(
      ...this.mentionMatches.map((p, idx) => h('button', {
        type: 'button',
        class: `mention-item${idx === this.mentionSelectedIndex ? ' active' : ''}`,
        onmousedown: (e) => { e.preventDefault(); this.selectMention(p); },
      },
        icon('user', 14),
        h('span', { class: 'mention-name' }, p.nickname),
        p.role !== 'participant' ? h('span', { class: 'role-tag' }, p.role === 'owner' ? 'Host' : 'Co-host') : null,
      ))
    );
    this.mentionMenu.hidden = false;
  }

  hideMentionMenu() {
    this.mentionMenu.hidden = true;
    this.mentionMatches = [];
    this.mentionSelectedIndex = 0;
    this.mentionStartIndex = -1;
  }

  selectMention(p) {
    if (!p) return;
    const val = this.input.value;
    const before = val.slice(0, this.mentionStartIndex);
    const after = val.slice(this.input.selectionEnd ?? val.length);
    const insert = `@${p.nickname} `;
    this.input.value = before + insert + after;
    const newPos = before.length + insert.length;
    this.input.setSelectionRange(newPos, newPos);
    this.input.focus();
    this.hideMentionMenu();
    this.updateCounter();
  }

  onInputKeyDown(e) {
    if (!this.mentionMenu.hidden && this.mentionMatches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.mentionSelectedIndex = (this.mentionSelectedIndex + 1) % this.mentionMatches.length;
        this.renderMentionMenu();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.mentionSelectedIndex = (this.mentionSelectedIndex - 1 + this.mentionMatches.length) % this.mentionMatches.length;
        this.renderMentionMenu();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.selectMention(this.mentionMatches[this.mentionSelectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hideMentionMenu();
        return;
      }
    }

    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      this.submit();
    }
  }

  submit() {
    this.hideMentionMenu();
    const text = this.input.value.replace(/\s+/g, ' ').trim();
    if (!text) return;
    this.send({ type: 'chat', text });
    this.input.value = '';
    this.updateCounter();
  }

  focus() {
    this.input.focus();
  }
}
