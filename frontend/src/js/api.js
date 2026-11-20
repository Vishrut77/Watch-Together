// REST client + per-device session storage.
const BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, { body, token } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0);
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) {
    const detail = typeof data?.detail === 'string' ? data.detail : 'Something went wrong. Please try again.';
    throw new ApiError(detail, res.status);
  }
  return data;
}

export function wsUrl(code, token) {
  const origin = BASE || window.location.origin;
  return `${origin.replace(/^http/, 'ws')}/ws/rooms/${encodeURIComponent(code)}?token=${encodeURIComponent(token)}`;
}

const R = (code) => `/api/rooms/${encodeURIComponent(code)}`;

export const api = {
  listRooms: () => request('GET', '/api/rooms'),
  getRoom: (code) => request('GET', R(code)),
  createRoom: (body) => request('POST', '/api/rooms', { body }),
  joinRoom: (code, body) => request('POST', `${R(code)}/join`, { body }),
  resume: (code, token) => request('POST', `${R(code)}/resume`, { token }),
  leave: (code, token) => request('POST', `${R(code)}/leave`, { token }),
  endRoom: (code, token) => request('DELETE', R(code), { token }),
  livekitToken: (code, token) => request('POST', `${R(code)}/token`, { token }),
  mute: (code, token, pid) => request('POST', `${R(code)}/participants/${pid}/mute`, { token }),
  kick: (code, token, pid) => request('POST', `${R(code)}/participants/${pid}/kick`, { token }),
  ban: (code, token, pid) => request('POST', `${R(code)}/participants/${pid}/ban`, { token }),
  lock: (code, token) => request('POST', `${R(code)}/lock`, { token }),
  unlock: (code, token) => request('POST', `${R(code)}/unlock`, { token }),
  updateSettings: (code, token, body) => request('PATCH', `${R(code)}/settings`, { token, body }),
  grant: (code, token, pid, permissions) => request('POST', `${R(code)}/participants/${pid}/permissions`, { token, body: { permissions } }),
  revoke: (code, token, pid) => request('DELETE', `${R(code)}/participants/${pid}/permissions`, { token }),
  mediaCapabilities: () => request('GET', '/api/media/capabilities'),
  createMediaJob: (token, body) => request('POST', '/api/media/jobs', { token, body }),
  probeMediaJob: (jobId, token) => request('POST', `/api/media/jobs/${encodeURIComponent(jobId)}/probe`, { token }),
  startMediaJob: (jobId, token, body) => request('POST', `/api/media/jobs/${encodeURIComponent(jobId)}/start`, { token, body }),
  getMediaJob: (jobId, token) => request('GET', `/api/media/jobs/${encodeURIComponent(jobId)}`, { token }),
  deleteMediaJob: (jobId, token) => request('DELETE', `/api/media/jobs/${encodeURIComponent(jobId)}`, { token }),
  startMovieBot: (token, body) => request('POST', '/api/media/bot/start', { token, body }),
  stopMovieBot: (token, roomId) => request('POST', `/api/media/bot/stop?room_id=${encodeURIComponent(roomId)}`, { token }),
  botCommand: (token, body) => request('POST', '/api/media/bot/command', { token, body }),
  getBotStatus: (token, roomId) => request('GET', `/api/media/bot/status?room_id=${encodeURIComponent(roomId)}`, { token }),
  pickLocalFile: (token, roomId, fileType = 'video') => request('POST', '/api/local/pick-file', { token, body: { room_id: roomId, file_type: fileType } }),
  browseLocal: (token, roomId, path, fileType = 'video') => request('GET', `/api/local/browse?room_id=${encodeURIComponent(roomId)}&file_type=${encodeURIComponent(fileType)}${path ? `&path=${encodeURIComponent(path)}` : ''}`, { token }),
  selectLocalFile: (token, roomId, path, fileType = 'video') => request('POST', '/api/local/select-file', { token, body: { room_id: roomId, path, file_type: fileType } }),
  uploadMediaChunk: async (jobId, token, blob, signal) => {
    const res = await fetch(`${BASE}/api/media/jobs/${encodeURIComponent(jobId)}/chunk`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: blob,
      signal,
    });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch {}
      throw new ApiError(data?.detail || 'Upload chunk failed.', res.status);
    }
    return res.json();
  },
};

// ---------- device identity & saved sessions ----------
function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function getClientId() {
  let id = localStorage.getItem('wt_client_id');
  if (!id) {
    id = randomId();
    localStorage.setItem('wt_client_id', id);
  }
  return id;
}

export const getNickname = () => localStorage.getItem('wt_nickname') || '';
export const setNickname = (n) => localStorage.setItem('wt_nickname', n);

export function saveSession(code, data) {
  localStorage.setItem(`wt_session_${code}`, JSON.stringify({ token: data.session_token, invite: data.invite_token || null }));
}
export function loadSession(code) {
  try { return JSON.parse(localStorage.getItem(`wt_session_${code}`)); } catch { return null; }
}
export function clearSession(code) {
  localStorage.removeItem(`wt_session_${code}`);
}
