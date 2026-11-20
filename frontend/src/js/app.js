import '../css/style.css';
import '../css/room.css';
import { api, clearSession, getClientId, getNickname, loadSession, saveSession, setNickname } from './api.js';
import { RoomController } from './room.js';
import { icon } from './icons.js';
import { h, setBusy, toast } from './ui.js';

const app = document.getElementById('app');
let current = null; // active RoomController

export function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  route();
}
window.addEventListener('popstate', route);

function route() {
  if (current) {
    current.destroy();
    current = null;
  }
  document.title = 'WatchTogether';
  const url = new URL(location.href);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  let m;
  if (path === '/') return landing();
  if (path === '/create') return createView();
  if (path === '/join') return joinView(url.searchParams.get('code') || '');
  if ((m = path.match(/^\/room\/([A-Za-z0-9]+)$/))) return roomEntry(m[1].toUpperCase(), url.searchParams.get('invite'));
  return notFound();
}

const shell = (...children) => h('div', { class: 'page' }, ...children);
const brand = () => h('a', { class: 'brand', href: '/', onclick: (e) => { e.preventDefault(); navigate('/'); } }, h('span', { class: 'logo-dot' }, icon('play', 14)), 'WatchTogether');
const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);
const errorBox = () => h('p', { class: 'form-error', role: 'alert', hidden: true });
const showError = (box, msg) => { box.hidden = !msg; box.textContent = msg || ''; };

// ---------------------------------------------------------------------------- landing
async function landing() {
  const nick = h('input', { class: 'input', maxlength: '24', placeholder: 'Your nickname', value: getNickname(), 'aria-label': 'Nickname', autocomplete: 'nickname' });
  const needNick = () => {
    const n = nick.value.trim();
    if (!n) { nick.focus(); toast('Enter a nickname first so friends know who you are.', 'warn'); return null; }
    setNickname(n);
    return n;
  };
  const rooms = h('div', { class: 'room-list', 'aria-live': 'polite' }, h('p', { class: 'muted' }, 'Loading rooms…'));

  app.replaceChildren(shell(
    h('header', { class: 'site-head' }, brand(), h('a', { class: 'link', href: '#how' }, 'How it works')),
    h('section', { class: 'hero' },
      h('div', { class: 'hero-copy' },
        h('h1', {}, 'Same movie, ', h('br', {}), 'different cities.'),
        h('p', { class: 'lede' }, 'Play a film from your own computer and stream it live to friends. Chat, talk and see each other while it plays, all in one browser tab.')),
      h('div', { class: 'ticket' },
        h('div', { class: 'ticket-top' }, h('span', { class: 'ticket-label' }, 'Your seat'), nick),
        h('div', { class: 'ticket-tear', 'aria-hidden': 'true' }),
        h('div', { class: 'ticket-bottom' },
          h('button', { class: 'btn primary lg', onclick: () => { if (needNick()) navigate('/create'); } }, 'Create room'),
          h('button', { class: 'btn lg', onclick: () => { if (needNick()) navigate('/join'); } }, 'Join room')))),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Now showing'), h('button', { class: 'btn sm', onclick: () => loadRooms(rooms, needNick) }, 'Refresh')),
      rooms),
    h('section', { class: 'section', id: 'how' },
      h('h2', {}, 'How it works'),
      h('ol', { class: 'how' },
        h('li', {}, h('strong', {}, 'Make a room'), h('span', {}, 'Pick a name, public or private, and you become the host.')),
        h('li', {}, h('strong', {}, 'Send the link'), h('span', {}, 'Friends open it, enter a nickname, and they’re in. No accounts.')),
        h('li', {}, h('strong', {}, 'Choose a movie'), h('span', {}, 'Select a video on your computer. It streams from your device and is never uploaded.')))),
    h('footer', { class: 'site-foot' }, 'Only share movies you have the right to share.')));
  loadRooms(rooms, needNick);
}

async function loadRooms(box, needNick) {
  try {
    const list = await api.listRooms();
    if (!list.length) {
      box.replaceChildren(h('div', { class: 'empty' }, icon('film', 28), h('p', {}, 'No public rooms right now'), h('span', {}, 'Create one and it will show up here.')));
      return;
    }
    box.replaceChildren(...list.map((r) => h('div', { class: 'room-card' },
      h('div', {}, h('strong', {}, r.name, r.has_password ? h('span', { class: 'lock', title: 'Password protected' }, icon('lock', 13)) : null), r.description ? h('p', {}, r.description) : null),
      h('div', { class: 'room-meta' }, h('span', {}, `${r.participants_count}/${r.max_participants}`),
        h('button', { class: 'btn sm primary', disabled: r.is_locked || r.participants_count >= r.max_participants,
          onclick: () => { if (needNick()) navigate(`/room/${r.id}`); } }, r.is_locked ? 'Locked' : r.participants_count >= r.max_participants ? 'Full' : 'Join'))))); 
  } catch (e) {
    box.replaceChildren(h('p', { class: 'form-error' }, e.message));
  }
}

// ---------------------------------------------------------------------------- create
function createView() {
  const f = {
    nickname: h('input', { class: 'input', maxlength: '24', value: getNickname(), required: true, autocomplete: 'nickname' }),
    name: h('input', { class: 'input', maxlength: '60', placeholder: 'Friday movie night', required: true }),
    description: h('input', { class: 'input', maxlength: '200', placeholder: 'What are we watching? (optional)' }),
    visibility: h('select', { class: 'input' }, h('option', { value: 'public' }, 'Public: listed for anyone'), h('option', { value: 'private' }, 'Private: invite link or password only')),
    password: h('input', { class: 'input', type: 'password', minlength: '4', maxlength: '64', placeholder: 'Optional', autocomplete: 'new-password' }),
    max: h('input', { class: 'input', type: 'number', min: '2', max: '50', value: '10' }),
  };
  const err = errorBox();
  const submit = h('button', { class: 'btn primary lg', type: 'submit' }, 'Create room');
  const form = h('form', { class: 'form', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    showError(err, '');
    if (!f.nickname.value.trim()) return showError(err, 'Enter a nickname.');
    if (!f.name.value.trim()) return showError(err, 'Give the room a name.');
    setBusy(submit, true, 'Creating…');
    try {
      setNickname(f.nickname.value.trim());
      const data = await api.createRoom({
        name: f.name.value, description: f.description.value, is_public: f.visibility.value === 'public',
        password: f.password.value || null, max_participants: Number(f.max.value) || 10,
        nickname: f.nickname.value, client_id: getClientId(),
      });
      saveSession(data.room.id, data);
      navigate(`/room/${data.room.id}`);
    } catch (ex) {
      showError(err, ex.message);
      setBusy(submit, false);
    }
  } },
  field('Your nickname', f.nickname),
  field('Room name', f.name),
  field('Description', f.description),
  h('div', { class: 'two' }, field('Visibility', f.visibility), field('Max people', f.max)),
  field('Room password', f.password, 'Anyone using the room code needs it. Invite links skip it.'),
  err, submit);
  app.replaceChildren(shell(h('header', { class: 'site-head' }, brand()), h('section', { class: 'card narrow' }, h('h1', {}, 'Create a room'), form)));
  f.name.focus();
}

// ---------------------------------------------------------------------------- join
function joinView(prefill) {
  const f = {
    code: h('input', { class: 'input code', maxlength: '12', placeholder: 'ABC123', value: prefill, autocapitalize: 'characters', spellcheck: 'false', autocomplete: 'off' }),
    nickname: h('input', { class: 'input', maxlength: '24', value: getNickname(), autocomplete: 'nickname' }),
  };
  const err = errorBox();
  const submit = h('button', { class: 'btn primary lg', type: 'submit' }, 'Continue');
  const form = h('form', { class: 'form', novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    const code = f.code.value.trim().toUpperCase();
    if (!code) return showError(err, 'Enter the room code your friend sent you.');
    if (f.nickname.value.trim()) setNickname(f.nickname.value.trim());
    navigate(`/room/${code}`);
  } }, field('Room code', f.code), field('Your nickname', f.nickname), err, submit);
  app.replaceChildren(shell(h('header', { class: 'site-head' }, brand()), h('section', { class: 'card narrow' }, h('h1', {}, 'Join a room'), form)));
  f.code.focus();
}

// ---------------------------------------------------------------------------- room entry (gate → room)
async function roomEntry(code, invite) {
  app.replaceChildren(shell(h('div', { class: 'center-load' }, h('span', { class: 'spinner big' }), h('p', {}, 'Opening room…'))));

  const saved = loadSession(code);
  if (saved?.token) {
    try {
      const data = await api.resume(code, saved.token);
      saveSession(code, { session_token: data.session_token, invite_token: data.invite_token || saved.invite });
      return enterRoom(code, { token: data.session_token, invite: data.invite_token || saved.invite });
    } catch (e) {
      clearSession(code);
      if (e.status === 410) return endedPage(e.message);
    }
  }

  let info;
  try {
    info = await api.getRoom(code);
  } catch (e) {
    return app.replaceChildren(shell(h('header', { class: 'site-head' }, brand()), h('section', { class: 'card narrow' }, h('h1', {}, e.status === 410 ? 'This room has ended' : 'Room not found'), h('p', {}, e.message), h('button', { class: 'btn primary', onclick: () => navigate('/') }, 'Back to home'))));
  }

  const nick = h('input', { class: 'input', maxlength: '24', value: getNickname(), autocomplete: 'nickname' });
  const pass = h('input', { class: 'input', type: 'password', maxlength: '64', autocomplete: 'off' });
  const err = errorBox();
  const submit = h('button', { class: 'btn primary lg', type: 'submit' }, 'Join room');
  const needsPassword = info.has_password && !invite;
  const form = h('form', { class: 'form', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    showError(err, '');
    if (!nick.value.trim()) return showError(err, 'Enter a nickname so friends know who you are.');
    setBusy(submit, true, 'Joining…');
    try {
      setNickname(nick.value.trim());
      const data = await api.joinRoom(code, { nickname: nick.value, client_id: getClientId(), password: pass.value || null, invite_token: invite || null });
      saveSession(code, data);
      history.replaceState({}, '', `/room/${code}`);
      enterRoom(code, { token: data.session_token, invite: data.invite_token });
    } catch (ex) {
      showError(err, ex.message);
      setBusy(submit, false);
    }
  } },
  field('Your nickname', nick), needsPassword ? field('Room password', pass) : null, err, submit);

  app.replaceChildren(shell(h('header', { class: 'site-head' }, brand()),
    h('section', { class: 'card narrow' },
      h('p', { class: 'muted' }, 'You’re invited to'),
      h('h1', {}, info.name),
      info.description ? h('p', {}, info.description) : null,
      h('p', { class: 'muted' }, `${info.participants_count} of ${info.max_participants} seats taken${info.is_locked ? ' · locked' : ''}`),
      form)));
  nick.value ? (needsPassword ? pass.focus() : submit.focus()) : nick.focus();
}

function endedPage(message) {
  app.replaceChildren(shell(h('header', { class: 'site-head' }, brand()), h('section', { class: 'card narrow' }, h('h1', {}, 'This room has ended'), h('p', {}, message), h('button', { class: 'btn primary', onclick: () => navigate('/') }, 'Back to home'))));
}

function enterRoom(code, session) {
  current = new RoomController(app, { code, session, onExit: (path) => navigate(path) });
  current.start();
}

function notFound() {
  app.replaceChildren(shell(h('header', { class: 'site-head' }, brand()), h('section', { class: 'card narrow' }, h('h1', {}, 'Page not found'), h('button', { class: 'btn primary', onclick: () => navigate('/') }, 'Back to home'))));
}

// handy for debugging / automated tests in the browser console
Object.defineProperty(window, '__watchTogether', { get: () => ({ room: current, api }) });

route();
