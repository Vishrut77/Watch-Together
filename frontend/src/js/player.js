// The theatre: local movie playback + capture (host), remote movie / screen view (everyone),
// transport controls and the playback-state sync. The streaming host's <video> is the source of truth.
import { api } from './api.js';
import { QUALITY, SMOOTHNESS } from './livekit.js';
import { icon } from './icons.js';
import { dialog, formatTime, h, toast } from './ui.js';
import { probeMedia, snapFps } from './demuxer.js';

const SKIP = 10;
const FILE_RE = /\.(mp4|m4v|webm|mov|mkv|ogv|ogg|avi)$/i;
const FP_SLICE_BYTES = 1024 * 1024;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function sha256Hex(buffer) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure context (HTTPS or localhost) required for file hashing.');
  }
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fingerprintFile(file) {
  const size = file.size || 0;
  const headSlice = file.slice(0, Math.min(size, FP_SLICE_BYTES));
  const tailStart = Math.max(0, size - FP_SLICE_BYTES);
  const tailSlice = file.slice(tailStart, size);
  const [headBuf, tailBuf] = await Promise.all([headSlice.arrayBuffer(), tailSlice.arrayBuffer()]);
  const [head_sha256, tail_sha256] = await Promise.all([sha256Hex(headBuf), sha256Hex(tailBuf)]);
  return { name: file.name || 'movie', size, head_sha256, tail_sha256 };
}

export class TheatrePlayer {
  /**
   * @param {{send:(m:object)=>void, media:import('./livekit.js').Media, getMe:()=>object, has:(p:string)=>boolean, onTheatre:(on:boolean)=>void}} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.pb = null;
    this.offset = 0;
    this.sources = { movie: null, screen: null };
    this.view = 'movie';
    this.screenWasAvailable = false;
    this.streamerOnline = true;
    this.isStreamer = false;
    this.fileUrl = null;
    this.ack = null;
    this.scrubbing = false;
    this.quality = QUALITY[localStorage.getItem('wt_quality')] ? localStorage.getItem('wt_quality') : 'high';
    this.efficiencyMode = localStorage.getItem('wt_efficiency') === '1';
    this.detectedFps = 0;
    this.rvfcId = null;
    this.attachCount = 0;
    this.movieAttachCount = 0;
    this.viewerDisplayPos = 0;
    this.viewerTickAt = 0;
    this._prevJb = null;
    const initSmooth = SMOOTHNESS[this.deps.media?.smoothness] || SMOOTHNESS.balanced;
    this.streamDelaySec = initSmooth.ms / 1000;
    this.volume = Number(localStorage.getItem('wt_volume') ?? 1);
    this.muted = false;
    this.statsText = '';
    this.movieSeenAt = 0;
    this.sent = null;
    this.mode = null; // 'capture' | 'screen' | 'local_sync'
    this.launchMode = 'live';
    this.localSyncFingerprint = null;
    this.localViewerReady = false;
    this.localViewerMismatch = false;
    this.lastLocalSeekAt = 0;
    this.localAutoplayWarned = false;
    this.mediaJobId = null;
    this.prepAbort = null;
    this.hls = null;
    this.convertedSec = null;
    this.convInfo = null;
    this.jobPollTimer = null;
    this.lastConvToastAt = 0;
    this.abort = null;
    this.idleTimer = null;
    this.audio = null;
    this.downmix = false;
    this.build();
    this.timers = [setInterval(() => this.tick(), 250), setInterval(() => this.updateStats(), 2000)];
    this.onKey = (e) => this.handleKey(e);
    document.addEventListener('keydown', this.onKey);
    this.onFs = () => {
      this.deps.media?.requestHighQuality(document.body.classList.contains('theatre') || !!document.fullscreenElement);
      this.render();
    };
    document.addEventListener('fullscreenchange', this.onFs);
    this.applyVolume();
  }

  // ---------------------------------------------------------------- DOM
  build() {
    const btn = (cls, iconName, label, onclick) =>
      h('button', { class: `ctl ${cls}`, title: label, 'aria-label': label, onclick }, icon(iconName, 20));

    this.vMovie = h('video', { class: 'layer', playsinline: true, disablepictureinpicture: true });
    this.canvas = h('canvas', { class: 'layer canvas-layer', style: 'display: none;' });
    this.vScreen = h('video', { class: 'layer', playsinline: true, muted: true });
    this.vMovie.setAttribute('playsinline', '');
    this.vScreen.setAttribute('playsinline', '');
    this.vScreen.muted = true;

    this.fileInput = h('input', { type: 'file', accept: 'video/*,.mkv,.mov,.m4v,.avi', hidden: true,
      onchange: () => { const f = this.fileInput.files[0]; this.fileInput.value = ''; this.loadFile(f); } });
    this.viewerFileInput = h('input', { type: 'file', accept: 'video/*,.mkv,.mov,.m4v,.avi', hidden: true,
      onchange: () => { const f = this.viewerFileInput.files[0]; this.viewerFileInput.value = ''; this.loadViewerLocalFile(f); } });

    this.empty = h('div', { class: 'stage-empty' });
    this.tabs = h('div', { class: 'stage-tabs', role: 'tablist' });
    this.badges = h('div', { class: 'stage-badges' });
    this.banner = h('div', { class: 'stage-banner', hidden: true });
    this.busyEl = h('div', { class: 'stage-busy', hidden: true });
    this.reactions = h('div', { class: 'reactions-layer', 'aria-hidden': 'true' });

    this.btnPlay = btn('play', 'play', 'Play / Pause (Space)', () => this.togglePlay());
    this.btnBack = btn('back', 'back', `Back ${SKIP} seconds (←)`, () => this.skip(-SKIP));
    this.btnFwd = btn('fwd', 'forward', `Forward ${SKIP} seconds (→)`, () => this.skip(SKIP));
    this.tCur = h('span', { class: 'time' }, '0:00');
    this.tTotal = h('span', { class: 'time' }, '0:00');
    this.timeline = h('input', { class: 'range timeline', type: 'range', min: '0', max: '1000', value: '0', step: '1', 'aria-label': 'Timeline',
      oninput: () => {
        this.scrubbing = true;
        const dur = this.duration();
        let target = Number(this.timeline.value);
        if (this.timeline.max === '1000' && dur > 0) {
          target = (Number(this.timeline.value) / 1000) * dur;
        }
        const maxT = this.maxSeekableSec();
        if (this.isStreamer && target > maxT) {
          target = maxT;
          this.timeline.value = this.timeline.max === '1000' && dur ? String(Math.floor((maxT / dur) * 1000)) : String(Math.floor(maxT));
        }
        this.tCur.textContent = formatTime(target);
      },
      onchange: () => {
        this.scrubbing = false;
        const dur = this.duration();
        let target = Number(this.timeline.value);
        if (this.timeline.max === '1000' && dur > 0) {
          target = (Number(this.timeline.value) / 1000) * dur;
        }
        const maxT = this.maxSeekableSec();
        if (this.isStreamer && target > maxT) {
          target = maxT;
          this.timeline.value = this.timeline.max === '1000' && dur ? String(Math.floor((maxT / dur) * 1000)) : String(Math.floor(maxT));
          this.warnConvertedLimit();
        }
        this.seekTo(target);
      } });
    this.btnVol = btn('vol', 'volume', 'Mute / unmute movie (M)', () => { this.muted = !this.muted; this.applyVolume(); });
    this.volRange = h('input', { class: 'range volume', type: 'range', min: '0', max: '1', step: '0.05', value: String(this.volume), 'aria-label': 'Movie volume (only for you)',
      oninput: () => { this.volume = Number(this.volRange.value); this.muted = false; localStorage.setItem('wt_volume', String(this.volume)); this.applyVolume(); } });
    this.btnQuality = btn('quality', 'sliders', 'Playback & streaming settings', () => this.toggleQualityMenu());
    this.qualityMenu = h('div', { class: 'menu quality-menu', hidden: true });
    this.btnAudio = btn('audio', 'headphones', 'Change audio track', () => this.toggleAudioMenu());
    this.audioMenu = h('div', { class: 'menu audio-menu', hidden: true });
    this.btnSubtitles = btn('subtitles', 'subtitles', 'Subtitles / captions', () => this.toggleSubtitlesMenu());
    this.subtitlesMenu = h('div', { class: 'menu subtitles-menu', hidden: true });
    this.btnChange = btn('change', 'film', 'Choose a different movie', () => { this.launchMode = this.mode === 'local_sync' ? 'local_sync' : 'live'; this.fileInput.click(); });
    this.btnStop = btn('stop', 'x', 'Stop the movie for everyone', () => this.stopMovie(true));
    this.btnTheatre = btn('theatre', 'theatre', 'Theatre mode (T)', () => this.toggleTheatre());
    this.btnFull = btn('full', 'maximize', 'Fullscreen (F)', () => this.toggleFullscreen());

    this.controls = h('div', { class: 'controls' },
      h('div', { class: 'controls-row timeline-row playback-only' }, this.tCur, this.timeline, this.tTotal),
      h('div', { class: 'controls-row' },
        h('div', { class: 'grp playback-only' }, this.btnBack, this.btnPlay, this.btnFwd),
        h('div', { class: 'grp volume-grp' }, this.btnVol, this.volRange),
        h('div', { class: 'spacer' }),
        h('div', { class: 'grp host-only' }, this.btnChange, this.btnStop),
        h('div', { class: 'grp playback-only' },
          h('div', { class: 'menu-anchor' }, this.btnAudio, this.audioMenu),
          h('div', { class: 'menu-anchor' }, this.btnSubtitles, this.subtitlesMenu),
          h('div', { class: 'menu-anchor' }, this.btnQuality, this.qualityMenu)
        ),
        h('div', { class: 'grp' }, this.btnTheatre, this.btnFull)));

    this.controls.addEventListener('focusin', () => this.wake());
    this.controls.addEventListener('focusout', () => setTimeout(() => this.wake(), 50));

    this.el = h('div', { class: 'stage', tabindex: '-1',
      onpointermove: (e) => {
        if (e.pointerType !== 'touch') this.wake();
      },
      onpointerdown: (e) => {
        if (!this.qualityMenu.hidden && !e.target.closest('.quality-menu') && e.target !== this.btnQuality && !this.btnQuality.contains(e.target)) {
          this.qualityMenu.hidden = true;
          this.wake();
        }
        if (!this.audioMenu.hidden && !e.target.closest('.audio-menu') && e.target !== this.btnAudio && !this.btnAudio.contains(e.target)) {
          this.audioMenu.hidden = true;
          this.wake();
        }
        if (!this.subtitlesMenu.hidden && !e.target.closest('.subtitles-menu') && e.target !== this.btnSubtitles && !this.btnSubtitles.contains(e.target)) {
          this.subtitlesMenu.hidden = true;
          this.wake();
        }
        if (e.target.closest('.controls')) {
          this.wake();
          return;
        }
        if (e.pointerType === 'touch') {
          this._touchStart = { x: e.clientX, y: e.clientY, time: Date.now() };
        } else {
          this.wake();
        }
      },
      onpointerup: (e) => {
        if (e.pointerType === 'touch' && this._touchStart) {
          const dx = Math.abs(e.clientX - this._touchStart.x);
          const dy = Math.abs(e.clientY - this._touchStart.y);
          const dt = Date.now() - this._touchStart.time;
          this._touchStart = null;
          if (dx < 15 && dy < 15 && dt < 450) {
            // Tap the video toggles controls
            if (this.el.classList.contains('idle')) {
              this.wake();
            } else {
              this.el.classList.add('idle');
              document.body.classList.add('theatre-idle');
              clearTimeout(this.idleTimer);
            }
          }
        }
      },
      ontouchstart: (e) => {
        if (e.target.closest('.controls')) this.wake();
      },
      ondragover: (e) => {
        if (!this.canStream()) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        this.el.classList.add('drag-over');
      },
      ondragleave: (e) => {
        if (e.relatedTarget && this.el.contains(e.relatedTarget)) return;
        this.el.classList.remove('drag-over');
      },
      ondrop: (e) => {
        if (!this.canStream()) return;
        e.preventDefault();
        this.el.classList.remove('drag-over');
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
          this.loadFile(files[0]);
        }
      },
      ondblclick: (e) => { if (e.target === this.el || e.target.classList.contains('layer')) this.toggleFullscreen(); } },
      this.vMovie, this.canvas, this.vScreen, this.empty, this.tabs, this.badges, this.banner, this.busyEl, this.reactions, this.controls, this.fileInput, this.viewerFileInput);
    this.render();
  }

  // ---------------------------------------------------------------- state helpers
  me() { return this.deps.getMe(); }
  canStream() { return this.deps.has('stream_movie'); }
  get isBotActive() { return Boolean(this.pb?.has_movie && this.pb?.streamer_id?.startsWith('movie-bot-')); }
  get isBotController() { return Boolean(this.isBotActive && (this._startedBot || this.canStream())); }
  canDrive() {
    if (this.isBotActive) return this.isBotController || this.deps.has('manage_playback');
    return !!this.pb?.has_movie && (this.isStreamer || this.deps.has('manage_playback'));
  }
  movieShown() { return (this.isStreamer && !this.isBotActive) || (this.pb?.mode === 'local_sync' && this.localViewerReady) || !!(this.pb?.has_movie && remoteTrack(this.sources.movie)); }
  screenShown() { return !!this.sources.screen?.video; }
  duration() {
    if (!this.isBotActive && (this.isStreamer || (this.pb?.mode === 'local_sync' && this.localViewerReady))) {
      const vd = Number.isFinite(this.vMovie.duration) ? this.vMovie.duration : 0;
      return Math.max(vd, this.mediaProbe?.duration || 0, this.convertedSec || 0, this.pb?.duration || 0);
    }
    return this.pb?.duration || 0;
  }

  maxSeekableSec() {
    const dur = this.duration();
    if (this.convertedSec !== null && dur > 0 && this.convertedSec < dur - 0.5) {
      return Math.max(0, this.convertedSec - 0.5);
    }
    return dur || Infinity;
  }

  warnConvertedLimit() {
    if (Date.now() - this.lastConvToastAt < 2500) return;
    this.lastConvToastAt = Date.now();
    toast(`Converted up to ${formatTime(this.convertedSec || 0)} — wait for conversion to reach later parts before skipping ahead.`, 'info', 4000);
  }

  rawServerPosition() {
    const pb = this.pb;
    if (!pb?.has_movie) return 0;
    const extra = pb.playing ? (Date.now() + this.offset - pb.updated_at) / 1000 : 0;
    return Math.max(0, Math.min(pb.duration || Infinity, pb.position + extra));
  }

  currentPosition() {
    if (!this.isBotActive && (this.isStreamer || (this.pb?.mode === 'local_sync' && this.localViewerReady))) return this.vMovie.currentTime || 0;
    const pb = this.pb;
    if (!pb?.has_movie) return 0;
    const realPos = this.rawServerPosition();
    const delay = pb.playing ? this.streamDelaySec : 0;
    const targetPos = Math.max(0, Math.min(pb.duration || Infinity, realPos - delay));
    const now = performance.now();
    if (!this.viewerTickAt) {
      this.viewerDisplayPos = targetPos;
      this.viewerTickAt = now;
      return this.viewerDisplayPos;
    }
    const dt = Math.max(0, (now - this.viewerTickAt) / 1000);
    this.viewerTickAt = now;
    if (pb.playing) {
      this.viewerDisplayPos = Math.min(pb.duration || Infinity, this.viewerDisplayPos + dt);
    }
    // Snap displayed time (never seek live <video>) if drift exceeds streamDelaySec + 1.0s (or >0.5s paused).
    const maxDrift = pb.playing ? this.streamDelaySec + 1.0 : 0.5;
    if (Math.abs(this.viewerDisplayPos - realPos) > maxDrift || (pb.playing && this.viewerDisplayPos > realPos + 0.5)) {
      this.viewerDisplayPos = targetPos;
    }
    return this.viewerDisplayPos;
  }

  isPlaying() {
    if (this.isBotActive) return !!this.pb?.playing;
    return (this.isStreamer || (this.pb?.mode === 'local_sync' && this.localViewerReady))
      ? !this.vMovie.paused && !this.vMovie.ended
      : !!this.pb?.playing;
  }

  // ---------------------------------------------------------------- inputs from the room
  /** Called whenever the server sends playback state. */
  applyPlayback(msg) {
    const prevHad = !!this.pb?.has_movie;
    const prevMode = this.pb?.mode || 'live';
    const prevFp = this.pb?.fingerprint;
    const prevKey = prevFp ? `${prevFp.size}:${prevFp.head_sha256}:${prevFp.tail_sha256}` : '';
    const prevPlaying = !!this.pb?.playing;
    this.pb = msg;
    this.offset = msg.server_time - Date.now();
    if (msg.streamer_id?.startsWith('movie-bot-')) {
      this.isStreamer = false;
      this.view = 'movie';
    }
    if (msg.notice) toast(msg.notice, 'info');
    const me = this.me();
    if (this.ack && msg.has_movie && msg.streamer_id === me.id) {
      this.ack.resolve();
      this.ack = null;
    }
    const nextFp = msg.fingerprint;
    const nextKey = nextFp ? `${nextFp.size}:${nextFp.head_sha256}:${nextFp.tail_sha256}` : '';
    if (this.isStreamer && (!msg.has_movie || msg.streamer_id !== me.id)) {
      // ended or taken over elsewhere
      this.cleanupLocal();
    } else if (!this.isStreamer && this.localViewerReady && (!msg.has_movie || msg.mode !== 'local_sync' || (prevMode === 'local_sync' && nextKey && prevKey && nextKey !== prevKey))) {
      this.cleanupLocal();
    }
    if (!msg.has_movie) {
      this.movieSeenAt = 0;
      this.viewerDisplayPos = 0;
      this.viewerTickAt = 0;
      this._prevJb = null;
      this.el.classList.remove('idle');
    } else if (!this.isStreamer && msg.mode !== 'local_sync') {
      const realPos = this.rawServerPosition();
      const targetPos = Math.max(0, Math.min(msg.duration || Infinity, realPos - (msg.playing ? this.streamDelaySec : 0)));
      if (!prevHad || prevPlaying !== !!msg.playing || !msg.playing || Math.abs(this.viewerDisplayPos - targetPos) > 1.2) {
        this.viewerDisplayPos = targetPos;
      }
      this.viewerTickAt = performance.now();
    }
    if (!prevHad && msg.has_movie && !this.isStreamer) this.view = 'movie';
    if (!this.isStreamer && msg.has_movie && msg.mode === 'local_sync' && this.localViewerReady) {
      this.syncViewerLocalPlayback();
    }
    if (this.audioMenu && !this.audioMenu.hidden) this.renderAudioMenu();
    if (this.subtitlesMenu && !this.subtitlesMenu.hidden) this.renderSubtitlesMenu();
    this.render();
  }

  setStreamerOnline(online) {
    this.streamerOnline = online;
    this.render();
  }

  updateSources(sources) {
    this.sources = sources;
    if (document.body.classList.contains('theatre') || !!document.fullscreenElement) {
      this.deps.media?.requestHighQuality(true);
    }
    // Never attach our own published track or overwrite local_sync playback with remote tracks.
    if (!this.isStreamer && !this.fileUrl && this.pb?.mode !== 'local_sync') {
      this.attach(this.vMovie, remoteTrack(sources.movie), true);
    }
    this.attach(this.vScreen, sources.screen?.video || null, false);
    if (sources.movie?.video && !this.movieSeenAt) this.movieSeenAt = Date.now();
    if (!sources.movie?.video) this.movieSeenAt = 0;
    const screenNow = this.screenShown();
    if (screenNow && !this.screenWasAvailable) this.view = 'screen';
    if (!screenNow && this.screenWasAvailable) this.view = 'movie';
    this.screenWasAvailable = screenNow;
    this.render();
  }

  attach(el, track, isMovie) {
    const next = track || null;
    const nextMedia = next?.mediaStreamTrack || null;
    if (el.__lk === next) return;
    if (next && el.__lkMedia && nextMedia && el.__lkMedia === nextMedia) {
      el.__lk = next;
      return;
    }
    if (el.__lk) { try { el.__lk.detach(el); } catch { /* ignore */ } }
    el.__lk = next;
    el.__lkMedia = nextMedia;
    if (next) {
      if (isMovie) el.muted = true; // remote movie audio plays through its own element so volume stays per-viewer
      next.attach(el);
      el.play?.().catch(() => {});
      this.attachCount++;
      if (isMovie) {
        this.movieAttachCount++;
        console.debug(`[wt-player] attach movie #${this.movieAttachCount} track=${nextMedia?.id || 'unknown'}`);
      }
    } else if (el.srcObject) {
      el.srcObject = null;
      if (isMovie) console.debug('[wt-player] detach movie');
    }
  }

  /** After the socket reconnects: if I'm still streaming but the server forgot, re-announce. */
  onReconnected(pb) {
    if (this.isStreamer && (!pb.has_movie || pb.streamer_id !== this.me().id)) {
      if (this.mode === 'local_sync' && this.localSyncFingerprint) {
        this.send({ type: 'movie_start', mode: 'local_sync', title: this.title, duration: this.duration() || 0, fingerprint: this.localSyncFingerprint });
      } else {
        this.send({ type: 'movie_start', title: this.title, duration: this.duration() || 0 });
      }
      setTimeout(() => this.report(), 300);
    }
  }

  handleCommand(cmd) {
    if (!this.isStreamer) return;
    const v = this.vMovie;
    const maxT = this.maxSeekableSec();
    const clamp = (t) => {
      if (this.convertedSec !== null && t > maxT) this.warnConvertedLimit();
      return Math.max(0, Math.min(maxT, t));
    };
    if (cmd.action === 'play') v.play().catch(() => toast('Your browser blocked playback. Press play on your player once.', 'warn'));
    else if (cmd.action === 'pause') v.pause();
    else if (cmd.action === 'seek') v.currentTime = clamp(cmd.position);
    else if (cmd.action === 'skip') v.currentTime = clamp(v.currentTime + cmd.delta);
  }

  rejectAck(message) {
    if (!this.ack) return false;
    this.ack.reject(new Error(message));
    this.ack = null;
    return true;
  }

  showReaction(emoji, name) {
    const el = h('span', { class: 'float', style: { left: `${8 + Math.random() * 80}%` } }, h('b', {}, emoji), h('i', {}, name));
    this.reactions.append(el);
    setTimeout(() => el.remove(), 3800);
  }

  send(msg) { this.deps.send(msg); }

  // ---------------------------------------------------------------- transport controls
  togglePlay() {
    if (!this.canDrive()) return;
    if (this.isStreamer) {
      const v = this.vMovie;
      if (v.paused) v.play().catch(() => toast("Couldn't start playback.", 'error'));
      else v.pause();
    } else {
      this.send({ type: 'playback_command', action: this.pb.playing ? 'pause' : 'play' });
    }
  }

  skip(delta) {
    if (!this.canDrive()) return;
    const cur = this.currentPosition();
    this.seekTo(cur + delta);
  }

  seekTo(sec) {
    if (!this.canDrive()) return;
    const dur = this.duration();
    const clamped = Math.max(0, Math.min(dur || 86400, sec));
    this.viewerDisplayPos = clamped;
    this.viewerTickAt = performance.now();
    this.tCur.textContent = formatTime(clamped);
    if (dur > 0) this.timeline.value = String(Math.round(clamped));

    if (this._seekDebounce) clearTimeout(this._seekDebounce);
    this._seekDebounce = setTimeout(() => {
      this._seekDebounce = null;
      if (this.isStreamer) this.handleCommand({ action: 'seek', position: clamped });
      else this.send({ type: 'playback_command', action: 'seek', position: clamped });
    }, 150);
  }

  applyVolume() {
    const v = this.muted ? 0 : this.volume;
    if (this.audio) {
      this.audio.monitor.gain.value = v;
      this.vMovie.volume = 1;
    } else if (this.isStreamer || (this.pb?.mode === 'local_sync' && this.localViewerReady)) {
      this.vMovie.volume = v;
      this.vMovie.muted = v === 0;
    }
    this.deps.media.setMovieVolume(v);
    this.btnVol?.replaceChildren(icon(v === 0 ? 'volume-x' : 'volume', 20));
    if (this.volRange) this.volRange.value = String(this.muted ? 0 : this.volume);
  }

  toggleTheatre() {
    return this.setTheatre(!document.body.classList.contains('theatre'));
  }

  /** Set theatre mode explicitly so callers like chat navigation can exit cleanly. */
  setTheatre(on) {
    const next = !!on;
    if (next === document.body.classList.contains('theatre')) return next;
    document.body.classList.toggle('theatre', next);
    if (!next) document.body.classList.remove('theatre-idle');
    this.deps.onTheatre?.(next);
    this.deps.media?.requestHighQuality(next || !!document.fullscreenElement);
    this.render();
    return next;
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else this.el.requestFullscreen?.().catch(() => toast("Fullscreen isn't available in this browser.", 'warn'));
  }

  handleKey(e) {
    if (e.target.closest?.('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!document.body.contains(this.el)) return;
    this.wake();
    if (e.key === 'Escape') {
      if (!this.qualityMenu.hidden) {
        this.qualityMenu.hidden = true;
        this.wake();
        e.preventDefault();
        return;
      }
      if (document.body.classList.contains('theatre') && !document.fullscreenElement) {
        this.toggleTheatre();
        e.preventDefault();
        return;
      }
    }
    if (e.key === ' ') { if (this.canDrive()) { e.preventDefault(); this.togglePlay(); } }
    else if (e.key === 'ArrowLeft') this.skip(-SKIP);
    else if (e.key === 'ArrowRight') this.skip(SKIP);
    else if (e.key === 'f' || e.key === 'F') this.toggleFullscreen();
    else if (e.key === 't' || e.key === 'T') this.toggleTheatre();
    else if (e.key === 'm' || e.key === 'M') { this.muted = !this.muted; this.applyVolume(); }
  }

  wake() {
    this.el.classList.remove('idle');
    document.body.classList.remove('theatre-idle');
    clearTimeout(this.idleTimer);
    if (!this.isPlaying()) return; // while paused they stay visible
    if (!this.qualityMenu.hidden) return; // keep visible while quality menu is open
    if (this.controls.contains(document.activeElement)) return; // keep visible while a control has focus
    if (!this.movieShown() && !this.screenShown()) return; // only hide when content is shown

    this.idleTimer = setTimeout(() => {
      if (!this.isPlaying()) return;
      if (!this.qualityMenu.hidden) return;
      if (this.controls.contains(document.activeElement)) return;
      if (this.movieShown() || this.screenShown()) {
        this.el.classList.add('idle');
        document.body.classList.add('theatre-idle');
      }
    }, 3000);
  }

  // ---------------------------------------------------------------- streaming host: open, claim, capture
  async loadFile(file) {
    if (!file) return;
    const launchMode = this.launchMode || 'live';
    this.launchMode = 'live';
    if (!this.canStream()) return toast("You don't have permission to stream a movie.", 'error');
    if (!/^video\//.test(file.type) && !FILE_RE.test(file.name)) return toast("That doesn't look like a video file. Try an MP4 or WebM.", 'error');
    if (launchMode === 'live' && !this.deps.media.connected) return toast('Still connecting to the media server. Give it a few seconds and try again.', 'warn');
    this.busy(launchMode === 'local_sync' ? 'Preparing local sync…' : 'Opening movie…');
    if (launchMode === 'live') this.ensureAudioGraph()?.ctx.resume?.().catch(() => {});
    try {
      await this.cleanupLocal();
      const fp = launchMode === 'local_sync' ? await fingerprintFile(file) : null;
      await this.openLocal(file);
      if (this.isBotActive || this._startedBot) {
        return;
      }
      this.busy(launchMode === 'local_sync' ? 'Starting local sync…' : 'Starting the stream…');
      await this.claim(this.title, this.duration() || this.vMovie.duration || 0, launchMode === 'local_sync' ? { mode: 'local_sync', fingerprint: fp } : {});
      if (launchMode === 'local_sync') {
        await this.startLocalSyncHost(fp);
        toast('Local sync ready — zero video upload. Press play when everyone matches their file.', 'success');
      } else {
        await this.startCapture();
        toast("You're live. Press play when everyone is ready.", 'success');
      }
    } catch (err) {
      toast(err.message || 'Could not start the movie.', 'error', 8000);
      const had = this.isStreamer || this.fileUrl;
      await this.cleanupLocal();
      if (had) this.send({ type: 'movie_stop' });
    } finally {
      this.busy(null);
    }
  }

  async loadViewerLocalFile(file) {
    if (!file || this.isStreamer || this.pb?.mode !== 'local_sync') return;
    if (!/^video\//.test(file.type) && !FILE_RE.test(file.name)) return toast("That doesn't look like a video file.", 'error');
    this.busy('Checking file match…');
    try {
      const fp = await fingerprintFile(file);
      const expected = this.pb.fingerprint;
      const matched = !!(expected && fp.size === expected.size && fp.head_sha256 === expected.head_sha256 && fp.tail_sha256 === expected.tail_sha256);
      if (!matched) {
        this.busy(null);
        const expInfo = expected ? `${expected.name} (${formatBytes(expected.size)})` : 'host file';
        const gotInfo = `${fp.name} (${formatBytes(fp.size)})`;
        const proceed = await new Promise((resolve) => {
          let ok = false;
          const close = dialog({
            title: 'This looks like a different file or version',
            body: h('div', { class: 'steps' },
              h('p', {}, `Expected: ${expInfo}`),
              h('p', {}, `Selected: ${gotInfo}`),
              h('p', {}, 'Different cuts or encodes can drift out of sync.')),
            onClose: () => resolve(ok),
            actions: [
              h('button', { class: 'btn', onclick: () => close() }, 'Choose another file'),
              h('button', { class: 'btn primary', onclick: () => { ok = true; close(); } }, 'Load anyway'),
            ],
          });
        });
        if (!proceed) return;
        this.busy('Opening movie…');
      }
      await this.cleanupLocal();
      await this.openLocal(file);
      this.localViewerReady = true;
      this.localViewerMismatch = !matched;
      this.localAutoplayWarned = false;
      this.mode = 'local_sync';
      this.view = 'movie';
      this.applyVolume();
      const target = this.rawServerPosition();
      if (Number.isFinite(target) && target > 0) {
        this.vMovie.currentTime = target;
        this.lastLocalSeekAt = Date.now();
      }
      this.syncViewerLocalPlayback();
      this.render();
      toast(matched ? 'File matched — synced with room!' : 'Loaded different version — syncing best effort.', matched ? 'success' : 'warn');
    } catch (err) {
      toast(err.message || 'Could not open that local file.', 'error', 8000);
      await this.cleanupLocal();
    } finally {
      this.busy(null);
    }
  }

  syncViewerLocalPlayback() {
    if (this.isStreamer || this.pb?.mode !== 'local_sync' || !this.localViewerReady) return;
    const v = this.vMovie;
    if (!v || v.readyState < 1 || v.seeking) return;
    const targetPos = this.rawServerPosition();
    if (!this.pb.playing) {
      if (!v.paused) v.pause();
      if (v.playbackRate !== 1.0) v.playbackRate = 1.0;
      if (Math.abs((v.currentTime || 0) - targetPos) > 0.25 && Date.now() - this.lastLocalSeekAt > 400) {
        v.currentTime = targetPos;
        this.lastLocalSeekAt = Date.now();
      }
      return;
    }
    if (v.paused) {
      v.play().catch(() => {
        if (!this.localAutoplayWarned) {
          this.localAutoplayWarned = true;
          toast('Click the video stage once to start synced playback.', 'info');
        }
      });
    }
    const drift = (v.currentTime || 0) - targetPos;
    const abs = Math.abs(drift);
    if (abs < 0.25) {
      if (v.playbackRate !== 1.0) v.playbackRate = 1.0;
    } else if (abs <= 2.0) {
      const rate = drift > 0 ? 0.97 : 1.03;
      if (v.playbackRate !== rate) v.playbackRate = rate;
    } else {
      if (v.playbackRate !== 1.0) v.playbackRate = 1.0;
      if (Date.now() - this.lastLocalSeekAt > 600) {
        v.currentTime = targetPos;
        this.lastLocalSeekAt = Date.now();
      }
    }
  }

  async openLocal(file) {
    this.title = file.name.replace(/\.[^.]+$/, '');
    this.tier = 0;

    let probe = null;
    try {
      probe = await probeMedia(file);
    } catch {
      probe = null;
    }
    this.mediaProbe = probe;

    const vStr = `${probe?.videoCodec || ''} ${probe?.videoName || ''}`;
    const aList = probe?.audioCodecs?.length ? probe.audioCodecs : [probe?.audioCodec || ''];
    const unsupportedVideo = /\b(HEVC|HVC1|HEV1|MP4V|MPEGH|MPEG2|DIVX|XVID|WMV|WVC1|VC-?1)\b|MPEG-?4 Part 2/i.test(vStr);
    const unsupportedAudio = aList.some((c) => /AC3|EAC3|AC-3|EC-3|DTS|TRUEHD|MLP|PCM|MP2/i.test(c || ''));
    const multiAudio = (probe?.audioTracks?.length || 0) > 1;
    const isAltContainer = probe && (probe.container === 'mkv' || probe.container === 'avi');

    // Fast path (Tier 0): native MP4/WebM with supported codecs & single/zero audio track
    if (!unsupportedVideo && !unsupportedAudio && !isAltContainer && !multiAudio) {
      try {
        await this.tryNativeOpen(file);
        this.tier = 0;
        if (probe && probe.audioTracks?.length === 0) {
          toast('This file has no audio track — viewers will see video only.', 'warn', 8000);
        }
        return;
      } catch (nativeErr) {
        console.warn('[wt-player] tryNativeOpen fallback:', nativeErr?.message || nativeErr);
        return this.tryFallbackTiers(file, probe, nativeErr);
      }
    }

    // Fallback tiers (Headless Bot / Tier 1 Companion)
    return this.tryFallbackTiers(file, probe);
  }

  async tryFallbackTiers(file, probe, nativeErr = null) {
    let caps = null;
    try { caps = await api.mediaCapabilities(); } catch {}
    if (!caps?.is_local_request || !caps?.ffmpeg_available) {
      throw (nativeErr && probe?.isNativeSupported)
        ? nativeErr
        : new Error(this.explainUnsupportedError(file, probe, caps));
    }

    const codecDesc = [probe?.videoName, probe?.audioName && probe.audioName !== 'None' ? probe.audioName : null]
      .filter(Boolean)
      .join(' + ') || file.name.split('.').pop()?.toUpperCase() || 'unsupported codecs';

    const choice = await new Promise((resolve) => {
      let settled = false;
      const finish = (val) => { if (!settled) { settled = true; close(); resolve(val); } };
      let pathInput;
      let chosenFileId = null;

      const onBrowse = async () => {
        const token = this.deps.getToken?.();
        const roomId = this.deps.getRoomCode?.();
        try {
          const res = await api.pickLocalFile(token, roomId, 'video');
          if (res.status === 'selected' && res.file_id) {
            chosenFileId = res.file_id;
            pathInput.value = res.filename;
            finish({ tier: 'bot', fileId: res.file_id, path: res.filename });
          } else if (res.fallback_required) {
            this.openFolderBrowserDialog((sel) => {
              chosenFileId = sel.file_id;
              pathInput.value = sel.filename;
              finish({ tier: 'bot', fileId: sel.file_id, path: sel.filename });
            });
          }
        } catch {
          this.openFolderBrowserDialog((sel) => {
            chosenFileId = sel.file_id;
            pathInput.value = sel.filename;
            finish({ tier: 'bot', fileId: sel.file_id, path: sel.filename });
          });
        }
      };

      const isMulti = (probe?.audioTracks?.length || 0) > 1;
      const title = isMulti ? 'Multiple audio tracks detected' : 'Unsupported browser format';
      const promptText = isMulti
        ? `"${file.name}" has ${probe.audioTracks.length} audio tracks. Web browsers cannot switch audio tracks natively — stream via the Headless FFmpeg Bot to select and switch audio tracks in real time.`
        : `"${file.name}" (${codecDesc}) cannot be decoded directly by the browser.`;

      const actions = [
        h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
      ];
      if (!isMulti) {
        actions.push(h('button', { class: 'btn', onclick: () => finish({ tier: 'companion' }) }, 'Convert to HLS'));
      }
      actions.push(
        h('button', {
          class: 'btn primary',
          onclick: () => finish({ tier: 'bot', path: pathInput.value.trim(), fileId: chosenFileId }),
        }, 'Stream with Headless Bot')
      );

      const close = dialog({
        title,
        body: h('div', { class: 'form' },
          h('p', {}, promptText),
          h('p', { class: 'subtle' }, 'Choose a playback method:'),
          h('div', { class: 'field' },
            h('span', { class: 'label' }, 'Headless FFmpeg Bot (Fastest · Instant start):'),
            h('p', { class: 'subtle' }, 'If the file is on this machine, select or paste its local path for 0 upload & instant playback:'),
            h('div', { style: 'display: flex; gap: 8px; align-items: center;' },
              (pathInput = h('input', {
                class: 'input',
                type: 'text',
                style: 'flex: 1;',
                placeholder: 'Click Browse… or paste path (or leave blank to upload)',
              })),
              h('button', { class: 'btn sm', type: 'button', onclick: onBrowse }, 'Browse…')
            )
          )
        ),
        actions,
      });
    });

    if (!choice) throw new Error('Movie playback cancelled.');
    if (choice.tier === 'bot') {
      if (choice.fileId) {
        return this.startBotStream({ fileId: choice.fileId, quality: 'auto' });
      }
      if (choice.path) {
        return this.startBotStream({ filePath: choice.path, quality: 'auto' });
      }
      return this.uploadAndStartBot(file);
    }
    return this.tryTier1Companion(file, probe, nativeErr);
  }

  async uploadAndStartBot(file) {
    const token = this.deps.getToken?.();
    const roomId = this.deps.getRoomCode?.();
    const abort = new AbortController();
    this.prepAbort = abort;
    let jobId = null;
    const cancelPrep = async () => {
      abort.abort();
      if (jobId) {
        const jid = jobId;
        jobId = null;
        await api.deleteMediaJob(jid, token).catch(() => {});
      }
    };
    try {
      this.busy('Uploading movie to local bot… 0%', cancelPrep);
      const created = await api.createMediaJob(token, { room_id: roomId, filename: file.name, size: file.size });
      jobId = created.job_id;
      const chunkSize = created.chunk_size || (4 * 1024 * 1024);

      for (let offset = 0; offset < file.size; offset += chunkSize) {
        if (abort.signal.aborted) throw new Error('Movie preparation cancelled.');
        const slice = file.slice(offset, Math.min(file.size, offset + chunkSize));
        await api.uploadMediaChunk(jobId, token, slice, abort.signal);
        const pct = Math.min(99, Math.round((Math.min(file.size, offset + chunkSize) / Math.max(1, file.size)) * 100));
        this.busy(`Uploading movie to local bot… ${pct}%`, cancelPrep);
      }
      if (abort.signal.aborted) throw new Error('Movie preparation cancelled.');
      return await this.startBotStream({ jobId, quality: 'auto' });
    } finally {
      this.busy(null);
    }
  }

  openLocalPathBotDialog() {
    let pathInput;
    let qualitySelect;
    let chosenFileId = null;

    const onBrowse = async () => {
      const token = this.deps.getToken?.();
      const roomId = this.deps.getRoomCode?.();
      if (!token || !roomId) return toast('Missing room token.', 'error');
      try {
        const res = await api.pickLocalFile(token, roomId, 'video');
        if (res.status === 'selected' && res.file_id) {
          chosenFileId = res.file_id;
          pathInput.value = res.filename;
          toast(`Selected ${res.filename} (${formatTime(res.duration || 0)})`, 'info');
        } else if (res.fallback_required || res.status === 'error') {
          this.openFolderBrowserDialog((selected) => {
            chosenFileId = selected.file_id;
            pathInput.value = selected.filename;
          });
        }
      } catch (err) {
        this.openFolderBrowserDialog((selected) => {
          chosenFileId = selected.file_id;
          pathInput.value = selected.filename;
        });
      }
    };

    const close = dialog({
      title: 'Stream with Headless FFmpeg Bot',
      body: h('div', { class: 'form' },
        h('p', { class: 'subtle' }, 'Choose a local movie file (MKV, HEVC, AC3, AVI, etc.). Decodes in real time with hardware acceleration.'),
        h('label', { class: 'field' },
          h('span', { class: 'label' }, 'Local video file:'),
          h('div', { style: 'display: flex; gap: 8px; align-items: center;' },
            (pathInput = h('input', {
              class: 'input',
              type: 'text',
              style: 'flex: 1;',
              placeholder: 'Paste/drag path or click Browse…',
              value: '',
              oninput: () => { chosenFileId = null; },
            })),
            h('button', { class: 'btn', type: 'button', onclick: onBrowse }, 'Browse…')
          )
        ),
        h('label', { class: 'field' },
          h('span', { class: 'label' }, 'Quality preset:'),
          (qualitySelect = h('select', { class: 'input' },
            h('option', { value: 'auto', selected: true }, 'Auto (recommended)'),
            h('option', { value: 'high' }, 'Best · 1080p30 · 6 Mbps'),
            h('option', { value: 'balanced' }, 'Balanced · 720p30 · 3 Mbps'),
            h('option', { value: 'saver' }, 'Data saver · 480p24 · 1.2 Mbps'))))),
      actions: [
        h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            const val = pathInput.value.trim();
            if (!val && !chosenFileId) return toast('Please select or enter a file path.', 'warn');
            const q = qualitySelect.value;
            close();
            try {
              if (chosenFileId) {
                await this.startBotStream({ fileId: chosenFileId, quality: q });
              } else {
                await this.startBotStream({ filePath: val, quality: q });
              }
            } catch {}
          },
        }, 'Start Streaming'),
      ],
    });
  }

  openFolderBrowserDialog(onSelect, fileType = 'video') {
    const token = this.deps.getToken?.();
    const roomId = this.deps.getRoomCode?.();
    if (!token || !roomId) return toast('Missing room token.', 'error');

    let currentPath = '';
    const container = h('div', { class: 'folder-browser', style: 'min-width: 440px; max-height: 480px; display: flex; flex-direction: column; gap: 10px;' });

    const close = dialog({
      title: fileType === 'subtitle' ? 'Select Subtitle File' : 'Browse Local Media Files',
      body: container,
      actions: [h('button', { class: 'btn', onclick: () => close() }, 'Cancel')],
    });

    const loadDir = async (path = '') => {
      container.replaceChildren(h('p', { class: 'subtle' }, 'Loading folder contents…'));
      try {
        const res = await api.browseLocal(token, roomId, path, fileType);
        currentPath = res.current_path;

        const crumbs = h('div', { style: 'display: flex; gap: 4px; flex-wrap: wrap; font-size: 0.85rem; padding: 4px 0; border-bottom: 1px solid var(--line); align-items: center;' });
        if (res.drives?.length) {
          res.drives.forEach((drv) => {
            crumbs.appendChild(h('button', {
              class: 'btn sm',
              style: 'padding: 2px 6px;',
              onclick: () => loadDir(drv),
            }, drv));
          });
        }
        res.breadcrumbs?.forEach((b, idx) => {
          if (idx > 0) crumbs.appendChild(h('span', { class: 'subtle' }, '/'));
          crumbs.appendChild(h('button', {
            class: 'btn sm subtle',
            style: 'padding: 2px 4px; text-decoration: underline;',
            onclick: () => loadDir(b.path),
          }, b.name));
        });

        const list = h('div', { style: 'overflow-y: auto; max-height: 280px; display: flex; flex-direction: column; gap: 2px;' });

        if (res.parent_path) {
          list.appendChild(h('div', {
            class: 'browser-item folder',
            style: 'padding: 6px 8px; cursor: pointer; border-radius: 4px; display: flex; gap: 6px; align-items: center; background: rgba(255,255,255,0.03);',
            onclick: () => loadDir(res.parent_path),
          }, icon('chevron', 14), h('span', { style: 'font-weight: 500;' }, '.. (Up one level)')));
        }

        res.folders?.forEach((f) => {
          list.appendChild(h('div', {
            class: 'browser-item folder',
            style: 'padding: 6px 8px; cursor: pointer; border-radius: 4px; display: flex; gap: 6px; align-items: center;',
            onmouseenter: (e) => e.currentTarget.style.background = 'rgba(255,255,255,0.08)',
            onmouseleave: (e) => e.currentTarget.style.background = '',
            onclick: () => loadDir(f.path),
          }, icon('film', 14), h('span', {}, f.name)));
        });

        res.files?.forEach((f) => {
          const mb = (f.size / (1024 * 1024)).toFixed(1);
          list.appendChild(h('div', {
            class: 'browser-item file',
            style: 'padding: 6px 8px; cursor: pointer; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.04); margin-bottom: 2px;',
            onmouseenter: (e) => e.currentTarget.style.background = 'var(--velvet, rgba(220,50,50,0.25))',
            onmouseleave: (e) => e.currentTarget.style.background = 'rgba(255,255,255,0.04)',
            onclick: async () => {
              try {
                const sel = await api.selectLocalFile(token, roomId, f.path, fileType);
                close();
                onSelect(sel);
              } catch (err) {
                toast(err.message || 'Failed to select file.', 'error');
              }
            },
          }, h('span', { style: 'font-weight: 500;' }, f.name), h('span', { class: 'subtle', style: 'font-size: 0.8rem;' }, `${mb} MB`)));
        });

        if (!res.folders?.length && !res.files?.length) {
          list.appendChild(h('p', { class: 'subtle', style: 'padding: 12px; text-align: center;' }, 'No media files found in this folder.'));
        }

        container.replaceChildren(crumbs, list);

        if (res.recent?.length) {
          const recentBox = h('div', { style: 'margin-top: 8px; border-top: 1px solid var(--line); padding-top: 6px;' },
            h('span', { class: 'subtle', style: 'font-size: 0.8rem;' }, 'Recent files:'),
            h('div', { style: 'display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px;' },
              ...res.recent.map((rf) => h('button', {
                class: 'btn sm',
                style: 'font-size: 0.75rem; padding: 2px 6px;',
                onclick: async () => {
                  try {
                    const sel = await api.selectLocalFile(token, roomId, rf.real_path, fileType);
                    close();
                    onSelect(sel);
                  } catch (err) {
                    toast(err.message || 'Failed to select file.', 'error');
                  }
                },
              }, rf.filename))
            )
          );
          container.appendChild(recentBox);
        }
      } catch (err) {
        container.replaceChildren(h('p', { class: 'error' }, err.message || 'Failed to browse folder.'));
      }
    };

    loadDir();
  }

  async startBotStream({ fileId, filePath, jobId, quality = 'auto', audioIndex, subtitleIndex, subtitleFileId }) {
    const token = this.deps.getToken?.();
    const roomId = this.deps.getRoomCode?.();
    if (!token || !roomId) throw new Error('Missing room token.');
    this.busy('Starting Headless FFmpeg Bot…');
    try {
      const res = await api.startMovieBot(token, {
        room_id: roomId,
        file_id: fileId || undefined,
        file_path: filePath || undefined,
        job_id: jobId || undefined,
        quality,
        audio_index: audioIndex,
        subtitle_index: subtitleIndex,
        subtitle_file_id: subtitleFileId,
      });
      this._startedBot = true;
      this.isStreamer = false;
      this.view = 'movie';
      toast(`Headless bot streaming live (${res.width}x${res.height}@${res.fps}fps).`, 'success', 5000);
      return res;
    } catch (err) {
      toast(err.message || 'Failed to start bot.', 'error', 7000);
      throw err;
    } finally {
      this.busy(null);
    }
  }

  explainUnsupportedError(file, probe, caps) {
    const codecDesc = [probe?.videoName, probe?.audioName && probe.audioName !== 'None' ? probe.audioName : null]
      .filter(Boolean)
      .join(' + ') || file.name.split('.').pop()?.toUpperCase() || 'unsupported codecs';
    if (!caps?.is_local_request) {
      return `Cannot play "${file.name}" (${codecDesc}) directly in the browser. Automatic conversion requires running WatchTogether locally with ffmpeg, or convert to MP4 (H.264 + AAC) with HandBrake (free).`;
    }
    if (!caps?.ffmpeg_available) {
      return `Cannot play "${file.name}" (${codecDesc}) natively and ffmpeg was not found on this machine. Install ffmpeg or convert to MP4 (H.264 + AAC) with HandBrake (free).`;
    }
    return `Could not prepare "${file.name}" (${codecDesc}) for playback.`;
  }

  pickTracksDialog(probeInfo, fileName) {
    return new Promise((resolve) => {
      let settled = false;
      const audios = probeInfo.audio || [];
      const subs = (probeInfo.subtitles || []).filter((s) => s.text_burnable);
      let selAudio = audios[0]?.index ?? null;
      let selSub = null;

      const audioSelect = audios.length
        ? h('select', { class: 'input', onchange: (e) => { selAudio = Number(e.target.value); } },
            ...audios.map((a, i) => h('option', { value: String(a.index), selected: i === 0 },
              `Track ${i + 1}: ${(a.language || 'und').toUpperCase()} · ${a.codec.toUpperCase()} · ${a.channels}ch${a.title ? ` (${a.title})` : ''}`)))
        : null;

      const subSelect = subs.length
        ? h('select', { class: 'input', onchange: (e) => { selSub = e.target.value === '' ? null : Number(e.target.value); } },
            h('option', { value: '' }, 'No subtitles'),
            ...subs.map((s, i) => h('option', { value: String(s.index) },
              `Sub ${i + 1}: ${(s.language || 'und').toUpperCase()} · ${s.codec.toUpperCase()}${s.title ? ` (${s.title})` : ''}`)))
        : null;

      const finish = (val) => {
        if (settled) return;
        settled = true;
        close();
        resolve(val);
      };

      const close = dialog({
        title: `Select tracks — ${fileName}`,
        onClose: () => { if (!settled) { settled = true; resolve(null); } },
        body: h('div', { class: 'steps' },
          audioSelect ? h('label', { class: 'field-lbl' }, 'Audio track', audioSelect) : h('p', {}, 'No audio track detected (video only).'),
          subSelect ? h('label', { class: 'field-lbl' }, 'Burn-in subtitles (optional, re-encodes video)', subSelect) : null),
        actions: [
          h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => finish({ audio_index: selAudio, subtitle_index: selSub }) }, 'Prepare movie'),
        ],
      });
    });
  }

  async tryTier1Companion(file, probe, fallbackErr = null) {
    const token = this.deps.getToken?.();
    const roomId = this.deps.getRoomCode?.();
    let caps = null;
    try {
      caps = await api.mediaCapabilities();
    } catch {
      caps = null;
    }
    if (!caps?.available || !token || !roomId) {
      throw (fallbackErr && probe?.isNativeSupported) ? fallbackErr : new Error(this.explainUnsupportedError(file, probe, caps));
    }

    const abort = new AbortController();
    this.prepAbort = abort;
    let jobId = null;
    const cancelPrep = async () => {
      abort.abort();
      if (jobId) {
        const jid = jobId;
        jobId = null;
        await api.deleteMediaJob(jid, token).catch(() => {});
      }
    };

    try {
      this.busy('Uploading movie to local converter… 0%', cancelPrep);
      const created = await api.createMediaJob(token, { room_id: roomId, filename: file.name, size: file.size });
      jobId = created.job_id;
      const chunkSize = created.chunk_size || (4 * 1024 * 1024);

      for (let offset = 0; offset < file.size; offset += chunkSize) {
        if (abort.signal.aborted) throw new Error('Movie preparation cancelled.');
        const slice = file.slice(offset, Math.min(file.size, offset + chunkSize));
        await api.uploadMediaChunk(jobId, token, slice, abort.signal);
        const pct = Math.min(99, Math.round((Math.min(file.size, offset + chunkSize) / Math.max(1, file.size)) * 100));
        this.busy(`Uploading movie to local converter… ${pct}%`, cancelPrep);
      }

      if (abort.signal.aborted) throw new Error('Movie preparation cancelled.');
      this.busy('Inspecting audio and video streams…', cancelPrep);
      const probeInfo = await api.probeMediaJob(jobId, token);

      if (!probeInfo.has_audio) {
        toast('This file has no audio track — viewers will see video only.', 'warn', 8000);
      }
      const v0 = probeInfo.video?.[0];
      if (v0 || probeInfo.duration) {
        this.mediaProbe = {
          ...(this.mediaProbe || {}),
          duration: probeInfo.duration || this.mediaProbe?.duration || 0,
          width: v0?.width || this.mediaProbe?.width || 0,
          height: v0?.height || this.mediaProbe?.height || 0,
          fps: v0?.fps ? snapFps(v0.fps) : (this.mediaProbe?.fps || 30),
        };
      }

      let audio_index = probeInfo.audio?.[0]?.index ?? null;
      let subtitle_index = null;
      const hasBurnableSubs = (probeInfo.subtitles || []).some((s) => s.text_burnable);
      if ((probeInfo.audio?.length || 0) > 1 || hasBurnableSubs) {
        this.busy(null);
        const choice = await this.pickTracksDialog(probeInfo, file.name);
        if (!choice) {
          await cancelPrep();
          throw new Error('Movie preparation cancelled.');
        }
        audio_index = choice.audio_index;
        subtitle_index = choice.subtitle_index;
      }

      this.busy('Preparing movie… 0%', cancelPrep);
      await api.startMediaJob(jobId, token, { audio_index, subtitle_index });

      let firstStatus = null;
      while (!abort.signal.aborted) {
        const st = await api.getMediaJob(jobId, token);
        if (st.can_play && st.stream_url) {
          firstStatus = st;
          break;
        }
        if (st.status === 'error') {
          throw new Error(st.error || this.explainUnsupportedError(file, probe, caps));
        }
        if (st.status === 'cancelled') {
          throw new Error('Movie preparation cancelled.');
        }
        const actionNote = st.plan === 'remux'
          ? 'remuxing'
          : st.plan === 'audio_transcode'
            ? 'converting audio'
            : (st.encoder ? `converting via ${st.encoder}` : 'converting');
        const spd = st.speed_x ? ` · ${st.speed_x.toFixed(1)}x` : '';
        const eta = st.eta_sec != null ? ` · ~${Math.ceil(st.eta_sec)}s left` : '';
        this.busy(`Preparing movie (${actionNote})… ${Math.round(st.progress || 0)}%${spd}${eta}`, cancelPrep);
        await new Promise((r) => setTimeout(r, 250));
      }
      if (abort.signal.aborted || !firstStatus) throw new Error('Movie preparation cancelled.');

      this.mediaJobId = jobId;
      this.tier = 1;
      this.convInfo = firstStatus;
      this.convertedSec = firstStatus.status === 'ready' ? null : (firstStatus.converted_sec ?? 0);
      await this.attachHlsStream(firstStatus.stream_url, token);
      if (firstStatus.status !== 'ready') {
        this.startJobMonitor(jobId, token);
      }
    } catch (err) {
      if (jobId && jobId !== this.mediaJobId) {
        await api.deleteMediaJob(jobId, token).catch(() => {});
      }
      throw err;
    } finally {
      if (this.prepAbort === abort) this.prepAbort = null;
    }
  }

  startJobMonitor(jobId, token) {
    clearInterval(this.jobPollTimer);
    this.jobPollTimer = setInterval(async () => {
      if (this.mediaJobId !== jobId) {
        clearInterval(this.jobPollTimer);
        this.jobPollTimer = null;
        return;
      }
      try {
        const st = await api.getMediaJob(jobId, token);
        if (this.mediaJobId !== jobId) return;
        this.convInfo = st;
        if (st.duration_sec > 0 && this.mediaProbe) {
          this.mediaProbe.duration = Math.max(this.mediaProbe.duration || 0, st.duration_sec);
        }
        if (st.status === 'ready') {
          const durOk = !this.hls || !this.hls.media || !st.duration_sec
            || (Number.isFinite(this.vMovie.duration) && this.vMovie.duration >= st.duration_sec - 2.5);
          if (durOk) {
            this.convertedSec = null;
            clearInterval(this.jobPollTimer);
            this.jobPollTimer = null;
            this.report();
          } else {
            this.convertedSec = Math.min(this.vMovie.duration || 0, st.converted_sec ?? st.duration_sec);
          }
        } else if (st.status === 'error' || st.status === 'cancelled') {
          clearInterval(this.jobPollTimer);
          this.jobPollTimer = null;
          if (st.status === 'error') toast(st.error || 'Background conversion stopped.', 'error');
        } else {
          this.convertedSec = st.converted_sec ?? this.convertedSec;
        }
        this.renderTimelineRange();
        this.renderBadges();
      } catch { /* ignore transient poll errors */ }
    }, 600);
  }

  async attachHlsStream(streamUrl, token) {
    const v = this.vMovie;
    if (this.hls) {
      try { this.hls.destroy(); } catch {}
      this.hls = null;
    }
    this.attach(v, null, true);
    v.muted = false;

    const { default: Hls } = await import('hls.js');
    if (Hls.isSupported()) {
      const hls = new Hls({
        startPosition: 0,
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: Infinity,
        maxBufferLength: 30,
        liveSyncDurationCount: 100000,
        liveMaxLatencyDurationCount: 200000,
        xhrSetup: (xhr) => {
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        },
      });
      this.hls = hls;
      await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          v.removeEventListener('loadedmetadata', onMeta);
          v.removeEventListener('error', onVideoErr);
        };
        const finishOk = () => {
          if (settled || v.videoWidth === 0) return;
          settled = true;
          cleanup();
          resolve();
        };
        const finishErr = (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };
        const onMeta = () => (v.videoWidth === 0 ? finishErr(new Error('Converted stream has no video track.')) : finishOk());
        const onVideoErr = () => finishErr(new Error('Could not open converted stream.'));
        const timer = setTimeout(() => finishErr(new Error('Timed out loading converted movie.')), 20000);
        hls.on(Hls.Events.ERROR, (_ev, data) => {
          if (!data?.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
          if (settled) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
            return;
          }
          finishErr(new Error(`Could not load converted stream (${data.details || data.type}).`));
        });
        v.addEventListener('loadedmetadata', onMeta);
        v.addEventListener('error', onVideoErr);
        hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(streamUrl));
        hls.attachMedia(v);
      });
      return;
    }

    v.src = streamUrl;
    await new Promise((resolve, reject) => {
      const done = (fn, arg) => { clearTimeout(timer); v.removeEventListener('loadedmetadata', onOk); v.removeEventListener('error', onErr); fn(arg); };
      const onOk = () => (v.videoWidth === 0 ? done(reject, new Error('Converted stream has no video track.')) : done(resolve));
      const onErr = () => done(reject, new Error('Could not open converted stream.'));
      const timer = setTimeout(() => done(reject, new Error('Timed out loading converted movie.')), 20000);
      v.addEventListener('loadedmetadata', onOk);
      v.addEventListener('error', onErr);
      v.load();
    });
  }

  tryNativeOpen(file) {
    const v = this.vMovie;
    this.attach(v, null, true);
    this.fileUrl = URL.createObjectURL(file);
    v.muted = false;
    v.src = this.fileUrl;
    return new Promise((resolve, reject) => {
      const done = (fn, arg) => { clearTimeout(timer); v.removeEventListener('loadedmetadata', onOk); v.removeEventListener('error', onErr); fn(arg); };
      const onOk = () => (v.videoWidth === 0
        ? done(reject, new Error(`"${file.name}" has no picture your browser can decode (audio only, or an unsupported video codec like HEVC/H.265). Convert it to MP4 (H.264 + AAC) and try again.`))
        : done(resolve));
      const onErr = () => done(reject, new Error(codecMessage(v.error, file)));
      const timer = setTimeout(() => done(reject, new Error('The movie took too long to open. The file may be damaged or in an unsupported format.')), 25000);
      v.addEventListener('loadedmetadata', onOk);
      v.addEventListener('error', onErr);
      v.load();
    });
  }

  async tryTier1Remux(file, probe) {
    // Only read the first 4KB header to prevent Out-Of-Memory (STATUS_BREAKPOINT) crashes on large files
    const headerBuf = await file.slice(0, 4096).arrayBuffer();
    const u8 = new Uint8Array(headerBuf);
    let patched = false;
    for (let i = 0; i < Math.min(u8.length - 8, 2048); i++) {
      if (u8[i] === 0x42 && u8[i + 1] === 0x82) {
        const vLen = u8[i + 2] & 0x7f;
        const strOffset = i + 3;
        const str = new TextDecoder().decode(u8.subarray(strOffset, strOffset + vLen));
        if (str.includes('matroska')) {
          u8[strOffset] = 0x77; // 'w'
          u8[strOffset + 1] = 0x65; // 'e'
          u8[strOffset + 2] = 0x62; // 'b'
          u8[strOffset + 3] = 0x6d; // 'm'
          for (let k = 4; k < vLen; k++) u8[strOffset + k] = 0x00;
          patched = true;
          break;
        }
      }
    }

    const mime = patched ? 'video/webm' : 'video/mp4';
    const remuxBlob = patched ? new Blob([u8, file.slice(4096)], { type: mime }) : file;
    const v = this.vMovie;
    this.attach(v, null, true);
    if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
    this.fileUrl = URL.createObjectURL(remuxBlob);
    v.muted = false;
    v.src = this.fileUrl;

    return new Promise((resolve, reject) => {
      const done = (fn, arg) => { clearTimeout(timer); v.removeEventListener('loadedmetadata', onOk); v.removeEventListener('error', onErr); fn(arg); };
      const onOk = () => (v.videoWidth === 0
        ? done(reject, new Error(`This file uses ${probe.videoName || 'an unsupported codec'}, which your browser cannot decode. Convert to MP4 (H.264 + AAC) with HandBrake (free) or choose another file.`))
        : done(resolve));
      const onErr = () => done(reject, new Error(`This file uses ${probe.videoName || probe.audioName || 'an unsupported codec'}, which your browser cannot decode. Convert to MP4 (H.264 + AAC) with HandBrake (free) or choose another file.`));
      const timer = setTimeout(() => done(reject, new Error('The movie took too long to open.')), 15000);
      v.addEventListener('loadedmetadata', onOk);
      v.addEventListener('error', onErr);
      v.load();
    });
  }

  claim(title, duration, extra = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.ack) { this.ack = null; reject(new Error('The room did not answer. Check your connection and try again.')); } }, 7000);
      this.ack = { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      this.send({ type: 'movie_start', title, duration, ...extra });
    });
  }

  async startLocalSyncHost(fp) {
    this.mode = 'local_sync';
    this.localSyncFingerprint = fp;
    this.sent = null;
    this.isStreamer = true;
    this.movieSeenAt = Date.now();
    this.abort = new AbortController();
    const opts = { signal: this.abort.signal };
    const v = this.vMovie;
    for (const ev of ['play', 'pause', 'seeked', 'ended', 'loadedmetadata']) v.addEventListener(ev, () => this.report(), opts);
    v.addEventListener('error', () => { toast('Playback stopped: the movie file could not be decoded.', 'error'); this.stopMovie(true); }, opts);
    this.reportTimer = setInterval(() => { if (!v.paused) this.report(); }, 2000);
    this.applyVolume();
    this.view = 'movie';
    this.report();
    this.render();
  }

  ensureAudioGraph() {
    if (this.audio) return this.audio;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      const ctx = new Ctx({ sampleRate: 48000 });
      const src = ctx.createMediaElementSource(this.vMovie);
      const mix = ctx.createGain();
      mix.channelCount = 2;
      mix.channelCountMode = 'explicit';
      mix.channelInterpretation = 'speakers';   // standard 5.1 -> stereo downmix, includes the center channel
      const monitor = ctx.createGain();         // host's local volume only
      src.connect(mix); mix.connect(monitor); monitor.connect(ctx.destination);
      this.audio = { ctx, src, mix, monitor, dest: null };
    } catch { this.audio = null; }
    return this.audio;
  }

  buildStereoAudio() {
    const g = this.ensureAudioGraph();
    if (!g) return null;
    g.ctx.resume?.().catch(() => {});
    if (g.dest) { try { g.mix.disconnect(g.dest); } catch {} }
    g.dest = g.ctx.createMediaStreamDestination();
    g.dest.channelCount = 2;
    g.mix.connect(g.dest);
    this.downmix = true;
    return g.dest.stream.getAudioTracks()[0] || null;
  }

  async startCapture() {
    let stream = null;
    this.mode = 'capture';

    const v = this.vMovie;
    const capture = v.captureStream || v.mozCaptureStream;
    if (capture) {
      try { stream = capture.call(v); } catch { stream = null; }
    }
    if (!stream || !stream.getVideoTracks().length) {
      this.mode = 'screen';
      stream = await this.askDisplayCapture();
    } else {
      const stereo = this.buildStereoAudio();
      if (stereo) {
        stream.getAudioTracks().forEach((t) => t.stop());
        stream = new MediaStream([...stream.getVideoTracks(), stereo]);
      }
    }
    const sourceFps = snapFps(this.mediaProbe?.fps || 30);
    this.detectedFps = sourceFps;
    const sourceHeight = this.vMovie.videoHeight || this.mediaProbe?.height || 0;
    const published = await this.deps.media.publishMovie(stream, this.quality, {
      sourceFps,
      sourceHeight,
      efficiency: this.efficiencyMode,
    });
    this.sent = published;
    this.captureStream = stream;
    this.isStreamer = true;
    this.movieSeenAt = Date.now();
    this.attachStreamerListeners(stream);
    this.startFpsProbe();
    this.applyVolume();
    this.view = 'movie';
    this.report();
    if (this.mode === 'screen' && !published.audio) this.warnNoAudio();
    this.render();
  }

  startFpsProbe() {
    const v = this.vMovie;
    if (this.rvfcId && typeof v.cancelVideoFrameCallback === 'function') {
      try { v.cancelVideoFrameCallback(this.rvfcId); } catch {}
      this.rvfcId = null;
    }
    if (typeof v.requestVideoFrameCallback !== 'function') return;
    const deltas = [];
    let lastMediaTime = null;
    const onFrame = (_now, meta) => {
      if (!this.isStreamer) { this.rvfcId = null; return; }
      if (lastMediaTime !== null && meta && typeof meta.mediaTime === 'number') {
        const dt = meta.mediaTime - lastMediaTime;
        if (dt > 0.008 && dt < 0.2) deltas.push(dt);
      }
      if (meta && typeof meta.mediaTime === 'number') lastMediaTime = meta.mediaTime;
      if (deltas.length >= 10) {
        deltas.sort((a, b) => a - b);
        const med = deltas[Math.floor(deltas.length / 2)];
        const detected = snapFps(1 / med);
        if (detected !== this.detectedFps) {
          this.detectedFps = detected;
          this.deps.media.setMovieSourceFps(detected);
        }
        this.rvfcId = null;
        return;
      }
      this.rvfcId = v.requestVideoFrameCallback(onFrame);
    };
    this.rvfcId = v.requestVideoFrameCallback(onFrame);
  }

  attachStreamerListeners(stream) {
    this.abort = new AbortController();
    const opts = { signal: this.abort.signal };
    const v = this.vMovie;
    for (const ev of ['play', 'pause', 'seeked', 'ended', 'loadedmetadata']) v.addEventListener(ev, () => this.report(), opts);
    v.addEventListener('playing', () => this.checkAudio(), { ...opts, once: true });
    v.addEventListener('error', () => { toast('Playback stopped: the movie file could not be decoded.', 'error'); this.stopMovie(true); }, opts);
    this.reportTimer = setInterval(() => { if (!v.paused) this.report(); }, 2000);
    stream.addEventListener('addtrack', async (e) => {
      try { if (await this.deps.media.publishLateMovieTrack(e.track)) { this.sent = { ...this.sent, [e.track.kind]: true }; this.render(); } } catch { /* ignore */ }
    }, opts);
    for (const t of stream.getTracks()) {
      t.addEventListener('ended', () => {
        if (t.kind === 'video' && this.isStreamer) { toast('Sharing stopped.', 'info'); this.stopMovie(true); }
      }, opts);
    }
  }

  checkAudio() {
    setTimeout(() => {
      if (!this.isStreamer) return;
      const v = this.vMovie;
      const none = ('mozHasAudio' in v && v.mozHasAudio === false)
        || ('webkitAudioDecodedByteCount' in v && v.webkitAudioDecodedByteCount === 0)
        || (v.audioTracks && v.audioTracks.length === 0);
      if (none && this.sent) this.sent.audio = false;
      if (!this.sent?.audio) this.warnNoAudio(); else this.render();
    }, 1800);
  }

  warnNoAudio() {
    toast(this.mode === 'screen'
      ? "Movie audio is NOT being shared. Stop, start again, pick this tab and tick “Also share tab audio”."
      : "Movie audio is NOT being shared — this file may have no audio track, or your browser didn't capture it. Viewers will see the picture but hear nothing.", 'warn', 12000);
    this.render();
  }

  askDisplayCapture() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const go = async () => {
        try {
          const s = await navigator.mediaDevices.getDisplayMedia({
            video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 30, max: 30 } },
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            preferCurrentTab: true, selfBrowserSurface: 'include', systemAudio: 'include',
          });
          settled = true; close(); resolve(s);
        } catch {
          settled = true; close(); reject(new Error('Screen capture was cancelled, so the movie was not shared.'));
        }
      };
      const close = dialog({
        title: 'Share this tab to stream the movie',
        onClose: () => { if (!settled) reject(new Error('Screen capture was cancelled, so the movie was not shared.')); },
        body: h('div', { class: 'steps' },
          h('p', {}, "Your browser can't send the video straight from the player, so we'll use tab sharing instead."),
          h('ol', {},
            h('li', {}, 'Click “Choose tab” and pick this browser tab (Chrome or Edge: the Tab list).'),
            h('li', {}, 'Turn on “Also share tab audio” — otherwise nobody hears the movie.'),
            h('li', {}, 'After sharing starts, press Fullscreen on the player so friends see only the movie.'))),
        actions: [h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: go }, 'Choose tab')],
      });
    });
  }

  report() {
    if (!this.isStreamer) return;
    const v = this.vMovie;
    this.send({ type: 'playback_state', playing: !v.paused && !v.ended, position: v.currentTime || 0, duration: this.duration() || 0 });
  }

  async stopMovie(notify = true) {
    const was = this.isStreamer;
    const wasBot = this.isBotActive && (this.isBotController || this.me().role === 'owner');
    await this.cleanupLocal();
    if ((was || wasBot) && notify) this.send({ type: 'movie_stop' });
    else if (notify && this.me().role === 'owner' && this.pb?.has_movie) this.send({ type: 'movie_stop' });
  }

  /** Stop capture, unpublish, release the file. Safe to call repeatedly. */
  async cleanupLocal() {
    this.isStreamer = false;
    this._startedBot = false;
    this.tier = 0;
    this.detectedFps = 0;
    this.convertedSec = null;
    this.convInfo = null;
    clearInterval(this.jobPollTimer);
    this.jobPollTimer = null;
    if (this.hls) {
      try { this.hls.destroy(); } catch {}
      this.hls = null;
    }
    if (this.rvfcId && typeof this.vMovie.cancelVideoFrameCallback === 'function') {
      try { this.vMovie.cancelVideoFrameCallback(this.rvfcId); } catch {}
      this.rvfcId = null;
    }
    if (this.canvas) {
      this.canvas.style.display = 'none';
    }
    this.vMovie.style.display = '';
    clearInterval(this.reportTimer);
    this.prepAbort?.abort();
    this.prepAbort = null;
    if (this.mediaJobId) {
      const jid = this.mediaJobId;
      this.mediaJobId = null;
      const tok = this.deps.getToken?.();
      if (tok) api.deleteMediaJob(jid, tok).catch(() => {});
    }
    this.abort?.abort();
    this.abort = null;
    this.ack = null;
    try { await this.deps.media.stopMovie(); } catch { /* ignore */ }
    const v = this.vMovie;
    v.pause();
    v.removeAttribute('src');
    v.srcObject = null;
    v.load();
    if (this.fileUrl) { URL.revokeObjectURL(this.fileUrl); this.fileUrl = null; }
    if (this.audio?.dest) { try { this.audio.mix.disconnect(this.audio.dest); } catch {} this.audio.dest = null; }
    this.downmix = false;
    this.captureStream = null;
    this.sent = null;
    this.mode = null;
    this.localSyncFingerprint = null;
    this.localViewerReady = false;
    this.localViewerMismatch = false;
    this.localViewerKey = null;
    this.localAutoplayWarned = false;
    v.playbackRate = 1.0;
    this.attach(v, remoteTrack(this.sources.movie), true);
    this.render();
  }

  busy(text, onCancel = null) {
    this.busyEl.hidden = !text;
    if (!text) {
      this.busyEl.replaceChildren();
      return;
    }
    const items = [h('span', { class: 'spinner' }), h('span', {}, text)];
    if (onCancel) {
      items.push(h('button', { class: 'btn sm', onclick: () => onCancel() }, 'Cancel'));
    }
    this.busyEl.replaceChildren(...items);
  }

  // ---------------------------------------------------------------- audio & subtitles menus
  toggleAudioMenu() {
    if (!this.audioMenu.hidden) {
      this.audioMenu.hidden = true;
      this.wake();
      return;
    }
    this.qualityMenu.hidden = true;
    if (this.subtitlesMenu) this.subtitlesMenu.hidden = true;
    this.renderAudioMenu();
    this.audioMenu.hidden = false;
    this.wake();
  }

  renderAudioMenu() {
    const tracks = this.pb?.audio_tracks || [];
    const activeIdx = this.pb?.audio_index ?? 0;
    this.audioMenu.replaceChildren(
      h('div', { class: 'menu-title' }, 'Audio tracks'),
      ...tracks.map((t) => {
        const isCurrent = (t.ordinal === activeIdx || t.index === activeIdx);
        const langMap = { eng: 'English', hin: 'Hindi', jpn: 'Japanese', spa: 'Spanish', fre: 'French', ger: 'German' };
        const langName = t.title || langMap[t.language?.toLowerCase()] || (t.language && t.language !== 'und' ? t.language.toUpperCase() : `Track ${t.ordinal + 1}`);
        const chDesc = t.channels === 6 ? '5.1' : (t.channels === 1 ? 'Mono' : 'Stereo');
        const desc = `${langName} · ${t.codec.toUpperCase()} (${chDesc})${t.default ? ' · Default' : ''}`;
        return h('button', {
          class: `menu-item${isCurrent ? ' on' : ''}`,
          onclick: () => {
            this.audioMenu.hidden = true;
            this.wake();
            this.send({ type: 'playback_command', action: 'audio_track', track_index: t.ordinal });
            try { localStorage.setItem(`wt_audio_${this.pb?.title || 'movie'}`, String(t.ordinal)); } catch {}
          },
        }, isCurrent ? icon('check', 16) : h('span', { class: 'pad' }), desc);
      })
    );
  }

  toggleSubtitlesMenu() {
    if (!this.subtitlesMenu.hidden) {
      this.subtitlesMenu.hidden = true;
      this.wake();
      return;
    }
    this.qualityMenu.hidden = true;
    if (this.audioMenu) this.audioMenu.hidden = true;
    this.renderSubtitlesMenu();
    this.subtitlesMenu.hidden = false;
    this.wake();
  }

  renderSubtitlesMenu() {
    const tracks = this.pb?.subtitle_tracks || [];
    const activeIdx = this.pb?.subtitle_index ?? -1;
    const isOff = activeIdx === -1 || activeIdx === null;

    const items = [
      h('div', { class: 'menu-title' }, 'Subtitles'),
      h('button', {
        class: `menu-item${isOff ? ' on' : ''}`,
        onclick: () => {
          this.subtitlesMenu.hidden = true;
          this.wake();
          this.send({ type: 'playback_command', action: 'subtitle_track', track_index: -1 });
        },
      }, isOff ? icon('check', 16) : h('span', { class: 'pad' }), 'Off'),
    ];

    tracks.forEach((t) => {
      const isCurrent = (t.ordinal === activeIdx || t.index === activeIdx);
      const langMap = { eng: 'English', hin: 'Hindi', jpn: 'Japanese', spa: 'Spanish' };
      const langName = t.title || langMap[t.language?.toLowerCase()] || (t.language && t.language !== 'und' ? t.language.toUpperCase() : `Track ${t.ordinal + 1}`);
      const desc = `${langName} · ${t.codec.toUpperCase()}${t.default ? ' · Default' : ''}`;
      items.push(h('button', {
        class: `menu-item${isCurrent ? ' on' : ''}`,
        onclick: () => {
          this.subtitlesMenu.hidden = true;
          this.wake();
          this.send({ type: 'playback_command', action: 'subtitle_track', track_index: t.ordinal });
        },
      }, isCurrent ? icon('check', 16) : h('span', { class: 'pad' }), desc));
    });

    items.push(
      h('div', { class: 'menu-sep' }),
      h('button', {
        class: 'menu-item',
        onclick: async () => {
          this.subtitlesMenu.hidden = true;
          this.wake();
          const token = this.deps.getToken?.();
          const roomId = this.deps.getRoomCode?.();
          try {
            const res = await api.pickLocalFile(token, roomId, 'subtitle');
            if (res.status === 'selected' && res.file_id) {
              await api.botCommand(token, {
                room_id: roomId,
                action: 'subtitle_track',
                subtitle_file_id: res.file_id,
              });
            } else if (res.fallback_required) {
              this.openFolderBrowserDialog(async (sel) => {
                await api.botCommand(token, {
                  room_id: roomId,
                  action: 'subtitle_track',
                  subtitle_file_id: sel.file_id,
                });
              }, 'subtitle');
            }
          } catch {
            this.openFolderBrowserDialog(async (sel) => {
              await api.botCommand(token, {
                room_id: roomId,
                action: 'subtitle_track',
                subtitle_file_id: sel.file_id,
              });
            }, 'subtitle');
          }
        },
      }, h('span', { class: 'pad' }), 'Load external subtitle (.srt/.ass)…')
    );

    this.subtitlesMenu.replaceChildren(...items);
  }

  // ---------------------------------------------------------------- quality menu & stats
  toggleQualityMenu() {
    if (!this.qualityMenu.hidden) {
      this.qualityMenu.hidden = true;
      this.wake();
      return;
    }
    const items = [];
    if (this.isStreamer) {
      items.push(
        h('div', { class: 'menu-title' }, 'Streaming quality'),
        ...Object.entries(QUALITY).map(([key, q]) => h('button', { class: `menu-item${key === this.quality ? ' on' : ''}`, onclick: async () => {
          this.quality = key;
          localStorage.setItem('wt_quality', key);
          this.qualityMenu.hidden = true;
          this.wake();
          try {
            await this.deps.media.setMovieQuality(key, { efficiency: this.efficiencyMode, sourceFps: this.detectedFps || 30 });
            toast(`Quality set to ${q.label}.`, 'success');
          } catch (e) { toast(e.message, 'error'); }
        } }, key === this.quality ? icon('check', 16) : h('span', { class: 'pad' }), q.label)),
        h('div', { class: 'menu-sep' }),
        h('button', { class: `menu-item${this.efficiencyMode ? ' on' : ''}`, onclick: async () => {
          this.efficiencyMode = !this.efficiencyMode;
          localStorage.setItem('wt_efficiency', this.efficiencyMode ? '1' : '0');
          this.qualityMenu.hidden = true;
          this.wake();
          try {
            await this.deps.media.setMovieQuality(this.quality, { efficiency: this.efficiencyMode, sourceFps: this.detectedFps || 30 });
            toast(`Efficiency mode ${this.efficiencyMode ? 'on (AV1/VP9 — uses more CPU)' : 'off'}.`, 'success');
          } catch (e) { toast(e.message, 'error'); }
        } }, this.efficiencyMode ? icon('check', 16) : h('span', { class: 'pad' }), 'Efficiency mode (AV1/VP9 · higher CPU)'),
        h('div', { class: 'menu-sep' }),
      );
    }
    const currentSmooth = this.deps.media?.smoothness || 'balanced';
    items.push(
      h('div', { class: 'menu-title' }, 'Playback smoothness'),
      ...Object.entries(SMOOTHNESS).map(([key, opt]) => h('button', { class: `menu-item${key === currentSmooth ? ' on' : ''}`, onclick: () => {
        this.deps.media?.setMovieSmoothness(key);
        this.streamDelaySec = opt.ms / 1000;
        this.qualityMenu.hidden = true;
        this.wake();
        toast(`Smoothness set to ${opt.label}.`, 'success');
      } }, key === currentSmooth ? icon('check', 16) : h('span', { class: 'pad' }), opt.label)),
      h('p', { class: 'menu-note' }, this.isStreamer
        ? 'Fixed presets never auto-downgrade. Efficiency mode prefers AV1/VP9 (costs more CPU, auto-falls back if needed).'
        : 'Larger buffer prevents stutter on spotty connections while keeping video & audio in sync.'),
    );
    this.qualityMenu.replaceChildren(...items);
    this.qualityMenu.hidden = false;
    this.wake();
  }

  async updateStats() {
    if (this.mode === 'local_sync' && (this.isStreamer || this.localViewerReady)) {
      const w = this.vMovie.videoWidth || 0;
      const hRes = this.vMovie.videoHeight || 0;
      this.statsText = w ? `${w}×${hRes} · Local sync` : 'Local sync · 0 upload';
      this.statsLimitation = null;
      return this.renderBadges();
    }
    if (this.isStreamer) {
      const s = await this.deps.media.movieSendStats();
      const codecPart = s?.codec ? ` · ${s.codec.toUpperCase()}` : '';
      this.statsText = s ? `${s.width || '?'}×${s.height || '?'} · ${Math.round(s.fps || 0)} fps${s.bitrate ? ` · ${(s.bitrate / 1e6).toFixed(1)} Mbps` : ''}${codecPart}` : '';
      if (s?.limited && (s.limited === 'cpu' || s.limited === 'bandwidth')) {
        const info = s.limited === 'cpu'
          ? {
              reason: 'cpu',
              label: 'Quality reduced: your computer is too busy',
              title: 'Your computer is busy, so video quality was lowered to keep playback smooth.',
            }
          : {
              reason: 'bandwidth',
              label: 'Quality reduced: your upload speed is too low',
              title: 'Your upload speed is limited, so video quality was lowered to prevent buffering.',
            };
        this.statsLimitation = info;
      } else {
        this.statsLimitation = null;
      }
    } else if (this.movieShown() && this.view === 'movie') {
      const s = await this.deps.media.movieReceiveStats();
      if (s?.jitterBufferEmittedCount > 0 && s?.jitterBufferDelay >= 0) {
        if (this._prevJb) {
          const dc = s.jitterBufferEmittedCount - this._prevJb.count;
          const dd = s.jitterBufferDelay - this._prevJb.delay;
          if (dc > 0 && dd >= 0) this.streamDelaySec = Math.max(0.2, Math.min(5.0, dd / dc));
        }
        this._prevJb = { delay: s.jitterBufferDelay, count: s.jitterBufferEmittedCount };
      }
      const fpsPart = s?.fps ? ` · ${Math.round(s.fps)} fps` : '';
      this.statsText = s?.width ? `${s.width}×${s.height}${fpsPart}` : '';
      this.statsLimitation = null;
    } else {
      this.statsText = '';
      this.statsLimitation = null;
    }
    this.renderBadges();
  }

  promptQualityDowngrade() {
    // Disabled: do not suggest decreasing quality if connection or CPU is unstable
  }

  // ---------------------------------------------------------------- rendering
  tick() {
    if (!this.isStreamer && this.pb?.mode === 'local_sync' && this.localViewerReady) {
      this.syncViewerLocalPlayback();
    }
    const dur = this.duration();
    const pos = this.currentPosition();
    if (dur > 0) {
      const durStr = String(Math.round(dur));
      if (this.timeline.max !== durStr) {
        this.timeline.max = durStr;
        this.timeline.step = '1';
      }
    } else if (this.timeline.max !== '1000') {
      this.timeline.max = '1000';
    }
    if (!this.scrubbing) {
      this.tCur.textContent = formatTime(pos);
      this.timeline.value = dur > 0 ? (this.timeline.max === '1000' ? String(Math.round((pos / dur) * 1000)) : String(Math.round(pos))) : '0';
    }
    this.renderTimelineRange(pos, dur);
    this.tTotal.textContent = formatTime(dur);
    const playing = this.isPlaying();
    if (this.btnPlay.dataset.playing !== String(playing)) {
      this.btnPlay.dataset.playing = String(playing);
      this.btnPlay.replaceChildren(icon(playing ? 'pause' : 'play', 20));
    }
  }

  renderTimelineRange(pos = this.currentPosition(), dur = this.duration()) {
    const pPct = dur > 0 ? Math.min(100, Math.max(0, (pos / dur) * 100)) : 0;
    if (this.isStreamer && this.convertedSec !== null && dur > 0 && this.convertedSec < dur) {
      const cPct = Math.min(100, Math.max(pPct, (this.convertedSec / dur) * 100));
      this.timeline.dataset.convertedSec = String(Number(this.convertedSec.toFixed(2)));
      this.timeline.dataset.maxSeekSec = String(Number(this.maxSeekableSec().toFixed(2)));
      this.timeline.style.background = `linear-gradient(to right, var(--velvet) 0%, var(--velvet) ${pPct}%, rgba(224,180,90,.75) ${pPct}%, rgba(224,180,90,.75) ${cPct}%, rgba(255,255,255,.22) ${cPct}%, rgba(255,255,255,.22) 100%)`;
    } else {
      delete this.timeline.dataset.convertedSec;
      delete this.timeline.dataset.maxSeekSec;
      this.timeline.style.background = `linear-gradient(to right, var(--velvet) 0%, var(--velvet) ${pPct}%, rgba(255,255,255,.3) ${pPct}%, rgba(255,255,255,.3) 100%)`;
    }
  }

  render() {
    const movie = this.movieShown();
    const screen = this.screenShown();
    if (this.view === 'screen' && !screen) this.view = 'movie';
    if (this.view === 'movie' && !movie && screen) this.view = 'screen';
    const showing = this.view === 'screen' ? 'screen' : movie ? 'movie' : null;

    this.vMovie.classList.toggle('on', showing === 'movie');
    this.vScreen.classList.toggle('on', showing === 'screen');
    this.el.classList.toggle('is-playback', showing === 'movie');
    this.el.classList.toggle('is-host', this.isStreamer);
    this.el.classList.toggle('can-drive', this.canDrive());
    this.el.classList.toggle('can-stop', this.isStreamer || (this.isBotActive && this.isBotController) || (this.me().role === 'owner' && !!this.pb?.has_movie));
    this.el.classList.toggle('has-content', !!showing);
    for (const b of [this.btnPlay, this.btnBack, this.btnFwd, this.timeline]) b.disabled = !this.canDrive();
    this.timeline.title = this.canDrive() ? 'Seek' : 'Only the host and co-hosts can seek';
    this.btnStop.style.display = this.el.classList.contains('can-stop') ? '' : 'none';
    const showAudio = this.isBotActive && this.canDrive() && (this.pb?.audio_tracks?.length > 1 || this.pb?.audio_tracks?.length === 1);
    const showSubs = this.isBotActive && this.canDrive();
    if (this.btnAudio?.parentElement) this.btnAudio.parentElement.style.display = showAudio ? '' : 'none';
    if (this.btnSubtitles?.parentElement) this.btnSubtitles.parentElement.style.display = showSubs ? '' : 'none';
    this.btnTheatre.replaceChildren(icon('theatre', 20));
    this.btnTheatre.classList.toggle('on', document.body.classList.contains('theatre'));
    this.btnFull.replaceChildren(icon(document.fullscreenElement ? 'minimize' : 'maximize', 20));

    this.renderEmpty(showing);
    this.renderTabs(movie, screen);
    this.renderBadges();
    const hostOffline = !!this.pb?.has_movie && !this.streamerOnline && !this.isStreamer && !this.isBotActive;
    this.banner.hidden = !hostOffline;
    this.banner.textContent = hostOffline ? 'The host lost connection. Waiting for them to come back…' : '';
    this.tick();
  }

  renderEmpty(showing) {
    this.empty.hidden = !!showing;
    if (showing) return;
    const canStream = this.canStream();
    let content;
    if (this.pb?.has_movie) {
      if (this.pb.mode === 'local_sync' && !this.isStreamer) {
        const fp = this.pb.fingerprint;
        const details = fp ? `${fp.name || this.pb.title} · ${formatBytes(fp.size)}` : (this.pb.title || 'the same movie file');
        content = [
          h('div', { class: 'film-mark' }, icon('film', 34)),
          h('h3', {}, 'Local sync mode'),
          h('p', {}, `The host started “${this.pb.title || 'Movie'}” in sync-only mode. Pick the matching video file from your computer to watch together without streaming it over the network.`),
          h('small', {}, `Expected: ${details}`),
          h('button', { class: 'btn primary lg', onclick: () => this.viewerFileInput.click() }, icon('film', 18), 'Choose matching file'),
        ];
      } else {
        content = [h('span', { class: 'spinner big' }), h('h3', {}, 'Connecting to the movie…'), h('p', {}, 'This usually takes a few seconds.')];
      }
    } else if (canStream) {
      content = [
        h('div', { class: 'film-mark' }, icon('film', 34)),
        h('h3', {}, 'Choose a movie to start the show'),
        h('p', {}, 'Pick a video from your computer or drag & drop it here. It plays on your device and streams live to everyone in the room. Nothing is uploaded.'),
        h('div', { class: 'stage-actions' },
          h('button', { class: 'btn primary lg', onclick: () => { this.launchMode = 'live'; this.fileInput.click(); } }, icon('film', 18), 'Choose movie'),
          h('button', { class: 'btn lg sync-only-btn', onclick: () => { this.launchMode = 'local_sync'; this.fileInput.click(); } }, 'Everyone has the file: sync only'),
          h('button', { class: 'btn lg bot-btn', onclick: () => this.openLocalPathBotDialog() }, icon('film', 18), 'Browse… / Bot (MKV, AC3, Dual-Audio)')),
        h('small', {}, 'Works best with MP4 (H.264 + AAC) or WebM. Headless bot plays MKV/HEVC/AC3/Dual-Audio locally with 0 wait.'),
      ];
    } else {
      content = [h('div', { class: 'film-mark' }, icon('film', 34)), h('h3', {}, 'Waiting for the movie'), h('p', {}, 'The host will pick a film soon. Say hi in the chat while you wait.')];
    }
    this.empty.replaceChildren(...content);
  }

  renderTabs(movie, screen) {
    this.tabs.hidden = !(movie && screen);
    if (!(movie && screen)) return this.tabs.replaceChildren();
    const sharer = this.sources.screen?.local ? 'Your screen' : `${this.sources.screen?.name || 'Shared'}’s screen`;
    const tab = (id, label) => h('button', { class: `tab${this.view === id ? ' on' : ''}`, role: 'tab', 'aria-selected': String(this.view === id), onclick: () => { this.view = id; this.render(); } }, label);
    this.tabs.replaceChildren(tab('movie', 'Movie'), tab('screen', sharer));
  }

  renderBadges() {
    const chips = [];
    const isLocalSync = this.pb?.mode === 'local_sync';
    if (this.pb?.has_movie && this.view !== 'screen') {
      chips.push(h('span', { class: `chip live${isLocalSync ? ' sync' : ''}` }, h('i', {}), isLocalSync ? 'SYNC' : 'LIVE', this.pb.title ? h('b', {}, this.pb.title) : null));
    }
    if (this.view === 'screen' && this.screenShown()) chips.push(h('span', { class: 'chip live screen' }, icon('monitor', 14), this.sources.screen.local ? 'You are sharing your screen' : `${this.sources.screen.name} is sharing their screen`));
    if (this.isBotActive) chips.push(h('span', { class: 'chip ok', title: 'Streamed via Headless FFmpeg Bot' }, '✓ Headless Bot'));
    if (isLocalSync) {
      if (this.isStreamer) {
        chips.push(h('span', { class: 'chip ok', title: 'Local sync uses 0 video upload bandwidth' }, '✓ Sync only · 0 upload'));
      } else if (this.localViewerReady) {
        chips.push(h('span', { class: `chip ${this.localViewerMismatch ? 'bad' : 'ok'}` }, this.localViewerMismatch ? 'Different file version' : '✓ File matched'));
      }
    } else if (this.isStreamer) {
      const v = this.sent?.video, a = this.sent?.audio;
      chips.push(h('span', { class: `chip ${v ? 'ok' : 'bad'}`, title: 'Whether the movie picture is being sent' }, v ? '✓' : '✗', ' Video'));
      chips.push(h('span', { class: `chip ${a ? 'ok' : 'bad'}`, title: 'Whether the movie sound is being sent' }, a ? '✓' : '✗', ' Audio'));
      chips.push(h('span', { class: 'chip', title: this.mode === 'screen' ? 'Using tab sharing (fallback)' : 'Captured directly from the player' }, this.mode === 'screen' ? 'Tab share' : 'Direct'));
    } else if (this.sources.movie?.video && !this.sources.movie.audio && this.movieSeenAt && Date.now() - this.movieSeenAt > 5000) {
      chips.push(h('span', { class: 'chip bad', title: 'The host is not sending movie sound' }, '✗ No movie audio from host'));
    }
    if (this.statsLimitation) {
      chips.push(h('span', { class: 'chip warn', title: this.statsLimitation.title }, this.statsLimitation.label));
    }
    if (this.isStreamer && this.convInfo && this.convertedSec !== null) {
      const ci = this.convInfo;
      const spd = ci.speed_x ? ` · ${ci.speed_x.toFixed(1)}x` : '';
      const eta = ci.eta_sec != null ? ` · ~${Math.ceil(ci.eta_sec)}s left` : '';
      const act = ci.plan === 'remux' ? 'Remuxing' : ci.plan === 'audio_transcode' ? 'Audio' : 'Converting';
      chips.push(h('span', { class: 'chip conv', title: `Using ${ci.encoder || 'ffmpeg'}` }, `${act} ${Math.round(ci.progress || 0)}%${spd}${eta}`));
    } else if (this.isStreamer && this.convInfo?.status === 'ready' && this.convInfo.elapsed_sec != null) {
      const spd = this.convInfo.speed_x ? ` · ${this.convInfo.speed_x.toFixed(1)}x` : '';
      chips.push(h('span', { class: 'chip', title: `Plan: ${this.convInfo.plan || 'auto'} (${this.convInfo.encoder || 'ffmpeg'})` }, `Ready in ${this.convInfo.elapsed_sec}s${spd}`));
    }
    if (this.statsText) chips.push(h('span', { class: 'chip' }, this.statsText));
    this.badges.replaceChildren(...chips);
  }

  destroy() {
    this.timers.forEach(clearInterval);
    clearInterval(this.reportTimer);
    clearInterval(this.jobPollTimer);
    clearTimeout(this.idleTimer);
    if (this.hls) {
      try { this.hls.destroy(); } catch {}
      this.hls = null;
    }
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('fullscreenchange', this.onFs);
    this.abort?.abort();
    this.audio?.ctx.close?.().catch(() => {});
    this.audio = null;
    if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
    this.fileUrl = null;
    this.vMovie.pause();
    this.vMovie.removeAttribute('src');
    this.vMovie.srcObject = null;
    document.body.classList.remove('theatre');
    document.body.classList.remove('theatre-idle');
  }
}

function remoteTrack(movie) {
  return movie && !movie.local ? movie.video || null : null;
}

function codecMessage(error, file) {
  const name = file?.name || 'This file';
  if (error?.code === 4) return `This file uses an unsupported codec, which your browser cannot decode. Convert to MP4 (H.264 + AAC) with HandBrake (free) or choose another file.`;
  if (error?.code === 3) return `“${name}” looks damaged or uses a codec your browser cannot decode. Convert to MP4 (H.264 + AAC) with HandBrake (free) or choose another file.`;
  if (error?.code === 2) return 'A network error stopped the movie from loading.';
  return `Could not open “${name}”.`;
}
