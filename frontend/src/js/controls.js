// Bottom dock, device picker, people list, room-control panel, invite dialog.
import { api } from './api.js';
import { Media } from './livekit.js';
import { icon } from './icons.js';
import { avatar, confirmDialog, copyText, dialog, h, toast } from './ui.js';

const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🔥', '😢', '🎉'];
const PERM_CONFIG = {
  stream_movie: {
    label: 'Stream movies from their computer',
    hint: 'Can pick a video file on their device and stream it live to everyone in the room',
  },
  manage_playback: {
    label: 'Control movie playback',
    hint: 'Can play, pause, seek, and scrub the movie timeline for everyone',
  },
  manage_screen_share: {
    label: 'Manage screen sharing',
    hint: 'Can share their screen and control screen sharing mode',
  },
  mute_participants: {
    label: 'Mute participants',
    hint: 'Can mute other people’s microphones',
  },
  remove_participants: {
    label: 'Remove & ban participants',
    hint: 'Can remove or ban disruptive participants from the room',
  },
  manage_settings: {
    label: 'Manage room settings',
    hint: 'Can lock/unlock room, toggle chat/cameras, and change room visibility',
  },
};

const run = async (fn, okMsg) => {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'success');
    return r;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
};

// ------------------------------------------------------------------ dock
export class Dock {
  constructor(rc) {
    this.rc = rc;
    const b = (cls, label, onclick) => h('button', { class: `dock-btn ${cls}`, title: label, 'aria-label': label, onclick });
    this.mic = b('mic', 'Turn microphone on/off', () => this.toggle('mic'));
    this.cam = b('cam', 'Turn camera on/off', () => this.toggle('cam'));
    this.share = b('share', 'Share your screen', () => this.toggle('share'));
    this.hand = b('hand', 'Raise or lower your hand', () => rc.send({ type: 'hand', raised: !rc.myHand() }));
    this.react = b('react', 'Send a reaction', () => { this.pop.hidden = !this.pop.hidden; });
    this.pop = h('div', { class: 'menu reactions-pop', hidden: true }, REACTIONS.map((e) => h('button', { class: 'emoji', 'aria-label': `React ${e}`, onclick: () => { rc.send({ type: 'reaction', emoji: e }); this.pop.hidden = true; } }, e)));
    this.devices = b('devices', 'Choose camera, microphone and speakers', () => openDevices(rc));
    this.chatBadge = h('span', { class: 'badge', hidden: true });
    this.chat = b('chat dock-chat theatre-chat-toggle', 'Exit theatre mode and open chat', () => this.rc.openChat());
    this.chat.append(this.chatBadge);
    this.leave = b('leave', 'Leave the room', () => rc.leave());
    this.el = h('footer', { class: 'dock' },
      h('div', { class: 'dock-grp' }, this.mic, this.cam, this.share),
      h('div', { class: 'dock-grp' }, this.hand, h('div', { class: 'menu-anchor' }, this.react, this.pop), this.devices, this.chat),
      h('div', { class: 'dock-grp' }, this.leave));
    document.addEventListener('click', (e) => { if (!this.react.contains(e.target) && !this.pop.contains(e.target)) this.pop.hidden = true; });
    this.update();
  }

  async toggle(kind) {
    const m = this.rc.media;
    this.setBusy(kind, true);
    try {
      if (kind === 'mic') await m.setMic(!m.micOn);
      if (kind === 'cam') await m.setCamera(!m.cameraOn);
      if (kind === 'share') {
        if (m.sharingScreen) await m.stopScreen();
        else {
          const r = await m.startScreen();
          if (!r.audio) toast('Sharing your screen without sound. To share audio, choose a browser tab and tick “Also share tab audio”.', 'info', 8000);
        }
      }
    } catch (e) {
      toast(e.message, 'error', 7000);
    } finally {
      this.setBusy(kind, false);
      this.update();
    }
  }

  setBusy(kind, on) {
    this[kind].disabled = on;
  }

  update() {
    const rc = this.rc;
    const m = rc.media;
    const ready = m.connected;
    const camAllowed = rc.room?.camera_enabled || rc.isHostSide();
    const shareAllowed = rc.room?.screen_share_mode === 'everyone' || rc.isHostSide();
    const set = (el, on, iconOn, iconOff, disabled, title) => {
      el.replaceChildren(icon(on ? iconOn : iconOff, 20));
      el.classList.toggle('off', !on);
      el.classList.toggle('on', on);
      el.disabled = disabled;
      if (title) el.title = title;
    };
    set(this.mic, m.micOn, 'mic', 'mic-off', !ready, ready ? (m.micOn ? 'Mute your microphone' : 'Unmute your microphone') : 'Connecting to voice…');
    set(this.cam, m.cameraOn, 'video', 'video-off', !ready || !camAllowed, !camAllowed ? 'The host turned cameras off' : m.cameraOn ? 'Turn your camera off' : 'Turn your camera on');
    set(this.share, m.sharingScreen, 'monitor', 'monitor', !ready || !shareAllowed, !shareAllowed ? 'Screen sharing is limited to hosts' : m.sharingScreen ? 'Stop sharing your screen' : 'Share your screen');
    this.share.classList.toggle('sharing', m.sharingScreen);
    const handUp = rc.myHand();
    this.hand.replaceChildren(icon('hand', 20));
    this.hand.classList.toggle('on', handUp);
    this.hand.title = handUp ? 'Lower your hand' : 'Raise your hand';
    this.hand.setAttribute('aria-pressed', String(handUp));
    this.react.replaceChildren(icon('smile', 20));
    this.devices.replaceChildren(icon('settings', 20));
    this.chat.replaceChildren(icon('message', 20), this.chatBadge);
    this.chat.classList.toggle('on', !!(rc.layout?.classList.contains('side-open') && rc.sideTab === 'chat'));
    this.leave.replaceChildren(icon('logout', 20), h('span', { class: 'lbl' }, 'Leave'));
    const labels = { mic: m.micOn ? 'Mic on' : 'Mic off', cam: m.cameraOn ? 'Camera on' : 'Camera off', share: m.sharingScreen ? 'Stop sharing' : 'Share', hand: handUp ? 'Hand up' : 'Hand', react: 'React', devices: 'Devices', chat: 'Chat' };
    for (const [k, t] of Object.entries(labels)) {
      const el = this[k];
      el.querySelector('.lbl')?.remove();
      el.append(h('span', { class: 'lbl' }, t));
    }
  }
}

// ------------------------------------------------------------------ devices
export async function openDevices(rc) {
  const m = rc.media;
  const sinkOk = 'setSinkId' in HTMLMediaElement.prototype;
  const kinds = [
    ['videoinput', 'Camera'],
    ['audioinput', 'Microphone'],
    ['audiooutput', 'Speakers'],
  ];
  const selects = {};
  const body = h('div', { class: 'form' }, h('p', { class: 'muted' }, 'Choose what you want to use. Movie sound always plays through your speakers, separate from your microphone.'));
  for (const [kind, label] of kinds) {
    const sel = h('select', { class: 'input', 'aria-label': label, disabled: kind === 'audiooutput' && !sinkOk,
      onchange: async () => { try { await m.switchDevice(kind, sel.value); toast(`${label} changed.`, 'success'); } catch (e) { toast(e.message, 'error'); } } });
    selects[kind] = sel;
    body.append(h('label', { class: 'field' }, h('span', {}, label), sel,
      kind === 'audiooutput' && !sinkOk ? h('small', {}, 'Your browser always uses the system default speakers.') : null));
  }
  dialog({ title: 'Devices', body, actions: [] });
  for (const [kind] of kinds) {
    const list = await Media.listDevices(kind);
    const sel = selects[kind];
    sel.replaceChildren(...(list.length
      ? list.filter((d) => d.deviceId).map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === (m.devices[kind] || m.room?.getActiveDevice?.(kind)) }, d.label || `${kind} ${i + 1}`))
      : [h('option', { value: '' }, 'None found')]));
    if (!list.length && kind !== 'audiooutput') sel.disabled = true;
  }
}

// ------------------------------------------------------------------ invite
export function openInvite(rc) {
  const link = rc.inviteLink();
  const row = (label, value) => h('div', { class: 'copy-row' }, h('div', {}, h('small', {}, label), h('code', {}, value)),
    h('button', { class: 'btn', onclick: async () => toast((await copyText(value)) ? 'Copied.' : 'Copy failed. Select the text and copy it.', 'success') }, icon('copy', 16), 'Copy'));
  const needsToken = !rc.room.is_public && !rc.inviteToken;
  dialog({
    title: 'Invite friends',
    body: h('div', { class: 'form' },
      needsToken ? h('p', { class: 'muted' }, 'This room is private. Ask the host for the invite link, or share the code if the room has a password.') : row('Invite link', link),
      row('Room code', rc.code),
      rc.room.has_password ? h('small', { class: 'muted' }, 'This room has a password. Friends using only the code need it. The invite link skips it.') : null),
  });
}

// ------------------------------------------------------------------ people
export class PeoplePanel {
  constructor(rc) {
    this.rc = rc;
    this.open = null; // participant id with expanded actions
    this.el = h('div', { class: 'people' });
  }

  render() {
    const rc = this.rc;
    const rows = rc.roster.map((p) => this.row(p));
    this.el.replaceChildren(h('div', { class: 'panel-head' }, `${rc.roster.length} in the room`), ...rows);
  }

  row(p) {
    const rc = this.rc;
    const me = p.id === rc.me.id;
    const media = rc.media.state;
    const mic = media.mics.get(p.id);
    const canAct = !me && rc.canActOn(p);
    const role = p.role === 'owner' ? 'Host' : p.role === 'cohost' ? 'Co-host' : null;
    const row = h('div', { class: `person${p.online ? '' : ' offline'}` },
      h('div', { class: 'person-main' },
        avatar(p.nickname, 34),
        h('div', { class: 'person-name' }, h('strong', {}, p.nickname, me ? h('span', { class: 'you' }, ' (you)') : null), role ? h('span', { class: 'role-tag' }, role) : null, !p.online ? h('small', {}, 'reconnecting…') : null),
        p.hand_raised ? h('span', { title: 'Hand raised' }, '✋') : null,
        mic ? h('span', { class: `mini ${mic.muted ? 'off' : ''}`, title: mic.muted ? 'Mic off' : 'Mic on' }, icon(mic.muted ? 'mic-off' : 'mic', 14)) : null,
        canAct ? h('button', { class: 'icon-btn', title: 'Manage', 'aria-label': `Manage ${p.nickname}`, 'aria-expanded': String(this.open === p.id), onclick: () => { this.open = this.open === p.id ? null : p.id; this.render(); } }, icon('more')) : null));
    if (canAct && this.open === p.id) row.append(this.actions(p));
    return row;
  }

  actions(p) {
    const rc = this.rc;
    const btns = [];
    const act = (label, fn, danger = false) => btns.push(h('button', { class: `btn sm${danger ? ' danger' : ''}`, onclick: fn }, label));
    if (rc.has('mute_participants')) act('Mute', () => run(() => api.mute(rc.code, rc.token, p.id), `Muted ${p.nickname}.`));
    if (rc.has('remove_participants')) {
      act('Remove', async () => { if (await confirmDialog(`Remove ${p.nickname} from the room? They can rejoin.`, 'Remove', true)) run(() => api.kick(rc.code, rc.token, p.id)); }, true);
      act('Ban', async () => { if (await confirmDialog(`Ban ${p.nickname}? They won't be able to rejoin from this device.`, 'Ban', true)) run(() => api.ban(rc.code, rc.token, p.id)); }, true);
    }
    const wrap = h('div', { class: 'person-actions' }, h('div', { class: 'btn-row' }, btns));
    if (rc.me.role === 'owner') wrap.append(this.permEditor(p));
    return wrap;
  }

  permEditor(p) {
    const rc = this.rc;
    const checks = Object.entries(PERM_CONFIG).map(([key, item]) =>
      h('label', { class: 'perm-row check' },
        h('input', { type: 'checkbox', class: 'perm-checkbox', checked: p.permissions.includes(key), dataset: { perm: key } }),
        h('div', { class: 'perm-info' },
          h('strong', { class: 'perm-label' }, item.label),
          h('small', { class: 'perm-hint' }, item.hint))));
    const box = h('div', { class: 'perm-editor' },
      h('div', { class: 'perm-editor-head' },
        h('strong', {}, p.role === 'cohost' ? 'Co-host permissions' : 'Promote to co-host'),
        h('small', { class: 'muted' }, 'Select what this co-host is allowed to do in this room:')),
      h('div', { class: 'perm-list' }, checks));
    const selected = () => [...box.querySelectorAll('input:checked')].map((i) => i.dataset.perm);
    const row = h('div', { class: 'btn-row perm-actions' },
      h('button', { class: 'btn sm primary', onclick: async () => {
        const perms = selected();
        if (!perms.length) return toast('Pick at least one permission, or use “Revoke co-host”.', 'warn');
        await run(() => api.grant(rc.code, rc.token, p.id, perms), `${p.nickname} is now a co-host.`);
      } }, p.role === 'cohost' ? 'Save permissions' : 'Make co-host'),
      p.role === 'cohost' ? h('button', { class: 'btn sm', onclick: () => run(() => api.revoke(rc.code, rc.token, p.id), 'Co-host permissions revoked.') }, 'Revoke co-host') : null);
    box.append(row);
    return box;
  }
}

// ------------------------------------------------------------------ room controls
export class RoomPanel {
  constructor(rc) {
    this.rc = rc;
    this.el = h('div', { class: 'room-controls' });
  }

  render() {
    const rc = this.rc;
    const r = rc.room;
    const canSettings = rc.has('manage_settings');
    const canScreen = rc.has('manage_screen_share') || canSettings;
    const patch = (body, msg) => run(() => api.updateSettings(rc.code, rc.token, body), msg);

    const toggle = (label, hint, on, disabled, onchange) =>
      h('label', { class: 'switch-row' }, h('span', {}, h('strong', {}, label), h('small', {}, hint)),
        h('input', { type: 'checkbox', role: 'switch', checked: on, disabled, onchange: (e) => onchange(e.target.checked) }));
    const select = (label, value, options, disabled, onchange) =>
      h('label', { class: 'switch-row' }, h('span', {}, h('strong', {}, label)),
        h('select', { class: 'input compact', disabled, onchange: (e) => onchange(e.target.value) }, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t))));

    const announce = h('input', { class: 'input', maxlength: '500', placeholder: 'Announce something to everyone', 'aria-label': 'Announcement',
      onkeydown: (e) => { if (e.key === 'Enter') send(); } });
    const send = () => { const t = announce.value.trim(); if (t) { rc.send({ type: 'announce', text: t }); announce.value = ''; } };

    this.el.replaceChildren(
      h('div', { class: 'panel-head' }, 'Room controls'),
      h('div', { class: 'ctl-card' },
        toggle('Lock room', 'Nobody new can join while locked', r.is_locked, !canSettings, (v) => run(() => (v ? api.lock(rc.code, rc.token) : api.unlock(rc.code, rc.token)), v ? 'Room locked.' : 'Room unlocked.')),
        toggle('Participant chat', 'Hosts can always chat', r.chat_enabled, !canSettings, (v) => patch({ chat_enabled: v })),
        toggle('Participant cameras', 'Hosts can always use theirs', r.camera_enabled, !canSettings, (v) => patch({ camera_enabled: v })),
        select('Who can share screens', r.screen_share_mode, [['hosts_only', 'Hosts only'], ['everyone', 'Everyone']], !canScreen, (v) => patch({ screen_share_mode: v })),
        select('Visibility', r.is_public ? 'public' : 'private', [['public', 'Public (listed)'], ['private', 'Private (invite only)']], !canSettings, (v) => patch({ is_public: v === 'public' }))),
      canSettings ? h('div', { class: 'ctl-card' }, h('strong', {}, 'Announcement'), h('div', { class: 'inline' }, announce, h('button', { class: 'btn', onclick: send }, 'Send'))) : null,
      h('div', { class: 'ctl-card' }, h('button', { class: 'btn', onclick: () => openInvite(rc) }, icon('link', 16), 'Invite friends')),
      rc.me.role === 'owner' ? h('div', { class: 'ctl-card danger-zone' },
        h('button', { class: 'btn danger', onclick: async () => {
          if (await confirmDialog('End the room for everyone? Everyone is disconnected and the room is closed for good.', 'End room', true)) {
            await run(() => api.endRoom(rc.code, rc.token));
          }
        } }, 'End room for everyone')) : null);
  }
}
