// Tiny DOM helpers: no framework, no innerHTML for user-provided text.
import { icon } from './icons.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (typeof value === 'boolean') {
      if (key in el) el[key] = value;
      else el.setAttribute(key, '');
    } else if (key === 'value') el.value = value;
    else el.setAttribute(key, value);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

export function initials(name = '?') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function hueFor(text = '') {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return hash;
}

export function avatar(name, size = 40) {
  return h('span', {
    class: 'avatar',
    style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px`, background: `hsl(${hueFor(name)} 38% 32%)` },
    'aria-hidden': 'true',
  }, initials(name));
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

// ---------- toasts ----------
let toastHost;
function syncToastParent() {
  if (!toastHost) return;
  const target = document.fullscreenElement || document.body;
  if (toastHost.parentElement !== target) target.append(toastHost);
}
document.addEventListener('fullscreenchange', syncToastParent);

export function toast(message, type = 'info', ms = 4200) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  }
  syncToastParent();
  const el = h('div', { class: `toast toast-${type}` }, message);
  toastHost.append(el);
  while (toastHost.children.length > 4) toastHost.firstChild.remove();
  setTimeout(() => el.remove(), ms);
  return el;
}

// ---------- dialogs ----------
export function dialog({ title, body, actions = [], wide = false, onClose }) {
  const previouslyFocused = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    previouslyFocused?.focus?.();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: `dialog${wide ? ' dialog-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'dialog-head' },
        h('h2', {}, title),
        h('button', { class: 'icon-btn', 'aria-label': 'Close', title: 'Close', onclick: close }, icon('x'))),
      h('div', { class: 'dialog-body' }, body),
      actions.length ? h('div', { class: 'dialog-actions' }, actions) : null));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  overlay.querySelector('input, select, button.primary, button')?.focus();
  return close;
}

export function confirmDialog(message, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    let answer = false;
    const close = dialog({
      title: 'Are you sure?',
      body: h('p', {}, message),
      onClose: () => resolve(answer),
      actions: [
        h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { answer = true; close(); } }, confirmLabel),
      ],
    });
  });
}

export function spinner() {
  return h('span', { class: 'spinner', 'aria-hidden': 'true' });
}

export function setBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) {
    button.dataset.label = button.textContent;
    button.replaceChildren(spinner(), label || 'Please wait…');
  } else {
    button.replaceChildren(button.dataset.label || '');
  }
}
