// All LiveKit (WebRTC) work lives here. The rest of the app only sees `media.state`.
import { AudioPresets, ConnectionQuality, Room, RoomEvent, Track, VideoPreset, VideoQuality } from 'livekit-client';

export const QUALITY = {
  auto: { label: 'Auto (recommended for slow internet)', bitrate: 2_200_000, fps: 24, adaptive: true },
  high: { label: 'Best · up to 1080p30 · 6 Mbps', bitrate: 6_000_000, fps: 30 },
  balanced: { label: 'Balanced · 3 Mbps', bitrate: 3_000_000, fps: 30 },
  saver: { label: 'Data saver · 1.2 Mbps', bitrate: 1_200_000, fps: 24 },
};

export const AUTO_LADDER = [
  { name: '360p24',  height: 360,  bitrate:   400_000, fps: 24 },
  { name: '480p24',  height: 480,  bitrate:   700_000, fps: 24 },
  { name: '540p24',  height: 540,  bitrate: 1_000_000, fps: 24 },
  { name: '720p24-', height: 720,  bitrate: 1_500_000, fps: 24 },
  { name: '720p24',  height: 720,  bitrate: 2_200_000, fps: 24 },
  { name: '1080p24', height: 1080, bitrate: 4_000_000, fps: 24 },
  { name: '1080p30', height: 1080, bitrate: 6_000_000, fps: 30 },
];

export const SMOOTHNESS = {
  balanced: { label: 'Balanced (1.5s buffer)', ms: 1500 },
  smoothest: { label: 'Smoothest (2.5s buffer)', ms: 2500 },
};

const MOVIE = 'movie';
const MOVIE_AUDIO = 'movie-audio';
const SCREEN = 'screen';
const SCREEN_AUDIO = 'screen-audio';

export class Media {
  /**
   * @param {{isStreamer:(id:string)=>boolean, onChange:()=>void, onError:(msg:string)=>void}} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.room = null;
    this.audioHost = document.createElement('div');
    this.audioHost.style.display = 'none';
    document.body.append(this.audioHost);
    this.audioEls = new Map(); // track sid -> <audio>
    this.blocked = new Set(); // publication sids we refuse to receive (movie tracks from non-streamers)
    this.movieVolume = 1;
    this.speaking = new Set();
    this.quality = 'unknown';
    this.connection = 'disconnected';
    this.audioBlocked = false;
    this.devices = {
      audioinput: localStorage.getItem('wt_dev_audioinput') || undefined,
      videoinput: localStorage.getItem('wt_dev_videoinput') || undefined,
      audiooutput: localStorage.getItem('wt_dev_audiooutput') || undefined,
    };
    this.state = { cameras: new Map(), mics: new Map(), movie: null, screen: null };
    this.movieTracks = { video: null, audio: null, stream: null, quality: 'high' };
    this.movieOpts = { sourceFps: 30, sourceHeight: 0, efficiency: false };
    this.autoState = null;
    this.autoTimer = null;
    this.codecBlocked = new Set();
    this.lastEstimatedUploadBps = 0;
    this.screenTracks = [];
    const savedSmoothness = localStorage.getItem('wt_smoothness');
    this.smoothness = SMOOTHNESS[savedSmoothness] ? savedSmoothness : 'balanced';
  }

  get connected() {
    return this.room?.state === 'connected';
  }

  get localId() {
    return this.room?.localParticipant?.identity;
  }

  async connect(url, token) {
    await this.disconnect();
    const room = new Room({
      adaptiveStream: {
        pixelDensity: 'screen',
        pauseVideoInBackground: false,
      },
      dynacast: true, // the host stops encoding layers nobody watches
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      disconnectOnPageLeave: true,
    });
    this.room = room;
    const refresh = () => this.refresh();
    [
      RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.TrackPublished, RoomEvent.TrackUnpublished,
      RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected,
    ].forEach((ev) => room.on(ev, refresh));

    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      this.speaking = new Set(speakers.map((s) => s.identity));
      if (this.hooks.onSpeaking) this.hooks.onSpeaking(this.speaking);
      else this.hooks.onChange();
    });
    room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant.isLocal) {
        this.quality = quality;
        this.hooks.onChange();
      }
    });
    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      this.connection = state;
      this.hooks.onChange();
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      this.audioBlocked = !room.canPlaybackAudio;
      this.hooks.onChange();
    });
    room.on(RoomEvent.MediaDevicesError, (err) => this.hooks.onError(explainMediaError(err)));
    room.on(RoomEvent.Disconnected, () => {
      this.connection = 'disconnected';
      this.hooks.onDisconnected?.();
      this.refresh();
    });

    await room.connect(url, token, { autoSubscribe: true });
    this.connection = room.state;
    this.audioBlocked = !room.canPlaybackAudio;
    this.refresh();
    for (const kind of ['audiooutput']) {
      if (this.devices[kind]) room.switchActiveDevice(kind, this.devices[kind]).catch(() => {});
    }
  }

  async disconnect() {
    this._refreshPending = false;
    await this.stopMovie().catch(() => {});
    await this.stopScreen().catch(() => {});
    if (this.room) {
      const r = this.room;
      this.room = null;
      await r.disconnect().catch(() => {});
    }
    for (const el of this.audioEls.values()) el.remove();
    this.audioEls.clear();
    this.state = { cameras: new Map(), mics: new Map(), movie: null, screen: null };
  }

  destroy() {
    this.disconnect();
    this.audioHost.remove();
  }

  // ---------- derived state ----------
  refresh() {
    if (this._refreshPending) return;
    this._refreshPending = true;
    const run = () => {
      this._refreshPending = false;
      this._doRefresh();
    };
    // Background tabs throttle requestAnimationFrame; keep track & jitter-buffer sync running via timer.
    if (document.hidden) setTimeout(run, 16);
    else requestAnimationFrame(run);
  }

  _doRefresh() {
    const room = this.room;
    const next = { cameras: new Map(), mics: new Map(), movie: null, screen: null };
    const liveAudio = new Set();
    if (room) {
      const people = [room.localParticipant, ...room.remoteParticipants.values()];
      for (const p of people) {
        const id = p.identity;
        for (const pub of p.trackPublications.values()) {
          const name = pub.trackName || '';
          const track = pub.track || null;
          switch (pub.source) {
            case Track.Source.Camera:
              next.cameras.set(id, { track: track && track.kind === 'video' ? track : null, muted: pub.isMuted });
              break;
            case Track.Source.Microphone:
              next.mics.set(id, { muted: pub.isMuted });
              if (track && !p.isLocal) this.ensureAudio(pub, track, 1, liveAudio);
              break;
            case Track.Source.ScreenShare: {
              if (name === MOVIE) {
                if (!this.hooks.isStreamer(id)) { this.block(pub, true); break; }
                this.block(pub, false);
                next.movie = { ...(next.movie || {}), identity: id, local: p.isLocal, video: track, pending: !track, publication: pub };
              } else {
                next.screen = { ...(next.screen || {}), identity: id, local: p.isLocal, name: p.name || 'Someone', video: track, pending: !track, publication: pub };
              }
              break;
            }
            case Track.Source.ScreenShareAudio: {
              if (name === MOVIE_AUDIO) {
                if (!this.hooks.isStreamer(id)) { this.block(pub, true); break; }
                this.block(pub, false);
                next.movie = { ...(next.movie || {}), identity: id, local: p.isLocal, audio: track, publication: pub };
                if (track && !p.isLocal) this.ensureAudio(pub, track, this.movieVolume, liveAudio, true);
              } else {
                next.screen = { ...(next.screen || {}), identity: id, local: p.isLocal, audio: track, publication: pub };
                if (track && !p.isLocal) this.ensureAudio(pub, track, this.movieVolume, liveAudio, true);
              }
              break;
            }
            default:
          }
        }
      }
    }
    for (const [sid, el] of this.audioEls) {
      if (!liveAudio.has(sid)) {
        el.remove();
        this.audioEls.delete(sid);
      }
    }
    this.state = next;
    this.applyMovieJitterBuffer();
    this.hooks.onChange();
  }

  /** Set viewer jitter buffer preference ('balanced' = 1500ms, 'smoothest' = 2500ms). */
  setMovieSmoothness(mode) {
    this.smoothness = SMOOTHNESS[mode] ? mode : 'balanced';
    localStorage.setItem('wt_smoothness', this.smoothness);
    return this.applyMovieJitterBuffer();
  }

  /** Apply matching jitterBufferTarget (ms) on BOTH movie video & audio receivers so A/V stays synced. */
  applyMovieJitterBuffer() {
    const movie = this.state.movie;
    if (!movie || movie.local) return { video: null, audio: null };
    const targetMs = (SMOOTHNESS[this.smoothness] || SMOOTHNESS.balanced).ms;
    const out = { video: null, audio: null };
    for (const [kind, track] of [['video', movie.video], ['audio', movie.audio]]) {
      const receiver = track?.receiver;
      if (!receiver || !('jitterBufferTarget' in receiver)) continue;
      try {
        if (receiver.jitterBufferTarget !== targetMs) receiver.jitterBufferTarget = targetMs;
        out[kind] = receiver.jitterBufferTarget;
      } catch { /* ignore unsupported receiver state */ }
    }
    return out;
  }

  block(pub, shouldBlock) {
    if (pub.isLocal || typeof pub.setSubscribed !== 'function') return;
    if (shouldBlock && !this.blocked.has(pub.trackSid)) {
      this.blocked.add(pub.trackSid);
      pub.setSubscribed(false);
    } else if (!shouldBlock && this.blocked.has(pub.trackSid)) {
      this.blocked.delete(pub.trackSid);
      pub.setSubscribed(true);
    }
  }

  ensureAudio(pub, track, volume, live, isMovieLike = false) {
    if (track.kind !== 'audio') return;
    live.add(pub.trackSid);
    let el = this.audioEls.get(pub.trackSid);
    if (!el) {
      el = track.attach();
      el.dataset.movieLike = isMovieLike ? '1' : '';
      this.audioHost.append(el);
      this.audioEls.set(pub.trackSid, el);
    }
    el.volume = volume;
  }

  setMovieVolume(v) {
    this.movieVolume = v;
    for (const el of this.audioEls.values()) if (el.dataset.movieLike) el.volume = v;
  }

  async enableAudioPlayback() {
    try {
      await this.room?.startAudio();
    } catch { /* needs a user gesture; the button click provides it */ }
    this.audioBlocked = !(this.room?.canPlaybackAudio ?? true);
    this.hooks.onChange();
  }

  // ---------- camera / microphone ----------
  async setMic(on) {
    await this.guard(() => this.room.localParticipant.setMicrophoneEnabled(on, on ? this.micOptions() : undefined));
    this.refresh();
  }

  micOptions() {
    return { deviceId: this.devices.audioinput, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  }

  async setCamera(on) {
    await this.guard(() => this.room.localParticipant.setCameraEnabled(on, on ? { deviceId: this.devices.videoinput, resolution: { width: 1280, height: 720, frameRate: 30 } } : undefined));
    this.refresh();
  }

  get micOn() {
    return !!this.room?.localParticipant?.isMicrophoneEnabled;
  }
  get cameraOn() {
    return !!this.room?.localParticipant?.isCameraEnabled;
  }

  async guard(fn) {
    if (!this.connected) throw new Error('Not connected to the media server yet.');
    try {
      return await fn();
    } catch (err) {
      throw new Error(explainMediaError(err));
    }
  }

  static async listDevices(kind) {
    let list = [];
    try {
      list = await Room.getLocalDevices(kind, false);
      if (kind !== 'audiooutput' && list.some((d) => !d.label)) list = await Room.getLocalDevices(kind, true);
    } catch { /* permission denied or none */ }
    return list;
  }

  async switchDevice(kind, deviceId) {
    this.devices[kind] = deviceId;
    localStorage.setItem(`wt_dev_${kind}`, deviceId);
    if (this.connected) await this.room.switchActiveDevice(kind, deviceId);
  }

  // ---------- screen sharing (participants) ----------
  get sharingScreen() {
    return this.screenTracks.length > 0;
  }

  async startScreen() {
    if (!this.connected) throw new Error('Not connected to the media server yet.');
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Your browser can't share screens. Try Chrome, Edge or Firefox on a computer.");
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
    } catch (err) {
      if (err?.name === 'NotAllowedError') throw new Error('Screen sharing was cancelled or blocked.');
      throw new Error(explainMediaError(err));
    }
    const lp = this.room.localParticipant;
    const video = stream.getVideoTracks()[0];
    video.contentHint = 'detail';
    try {
      const pub = await lp.publishTrack(video, {
        name: SCREEN, source: Track.Source.ScreenShare,
        screenShareEncoding: { maxBitrate: 3_000_000, maxFramerate: 30 }, simulcast: true,
      });
      this.screenTracks.push(pub.track);
      const audio = stream.getAudioTracks()[0];
      if (audio) {
        const apub = await lp.publishTrack(audio, { name: SCREEN_AUDIO, source: Track.Source.ScreenShareAudio });
        this.screenTracks.push(apub.track);
      }
      video.addEventListener('ended', () => this.stopScreen());
      this.refresh();
      return { audio: !!audio };
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      this.screenTracks = [];
      throw new Error(/permission|not allowed|publish/i.test(String(err?.message))
        ? 'Screen sharing is limited to hosts in this room.'
        : `Couldn't start screen sharing: ${err?.message || err}`);
    }
  }

  async stopScreen() {
    const tracks = this.screenTracks;
    this.screenTracks = [];
    for (const t of tracks) {
      try { await this.room?.localParticipant.unpublishTrack(t, false); } catch { /* already gone */ }
      try { t.mediaStreamTrack.stop(); } catch { /* ignore */ }
    }
    this.refresh();
  }

  // ---------- movie (host) ----------
  hasVideoCodec(codec) {
    try {
      const caps = RTCRtpSender.getCapabilities?.('video')?.codecs || [];
      return caps.some((c) => c.mimeType?.toLowerCase() === `video/${codec.toLowerCase()}`);
    } catch {
      return false;
    }
  }

  isLowUploadConfig(quality = this.movieTracks.quality) {
    if (quality === 'auto' || quality === 'saver') return true;
    if (quality === 'balanced') return this.lastEstimatedUploadBps > 0 && this.lastEstimatedUploadBps < 3_000_000;
    return this.lastEstimatedUploadBps > 0 && this.lastEstimatedUploadBps < 3_000_000;
  }

  pickMovieCodec(efficiency, lowUpload) {
    if (efficiency) {
      if (this.hasVideoCodec('av1') && !this.codecBlocked.has('av1')) return 'av1';
      if (this.hasVideoCodec('vp9') && !this.codecBlocked.has('vp9')) return 'vp9';
      return lowUpload && this.hasVideoCodec('vp8') && !this.codecBlocked.has('vp8') ? 'vp8' : 'h264';
    }
    if (lowUpload) {
      if (this.hasVideoCodec('vp9') && !this.codecBlocked.has('vp9')) return 'vp9';
      if (this.hasVideoCodec('vp8') && !this.codecBlocked.has('vp8')) return 'vp8';
      return 'h264';
    }
    return 'h264';
  }

  maxAutoRungIdx(srcHeight, srcFps) {
    const h = srcHeight || 1080;
    const f = srcFps || 30;
    let best = 0;
    for (let i = 0; i < AUTO_LADDER.length; i++) {
      const r = AUTO_LADDER[i];
      if (r.height > h && h > 0) continue;
      if (r.fps > f && i > 0 && AUTO_LADDER[i - 1].height === r.height) continue;
      best = i;
    }
    return Math.max(0, best);
  }

  /** Publish a captured movie stream. Returns what was actually sent so the UI never over-promises. */
  async publishMovie(stream, quality = this.movieTracks.quality, opts = {}) {
    if (!this.connected) throw new Error('Not connected to the media server yet. Wait a moment and try again.');
    this.movieTracks.stream = stream;
    this.movieTracks.quality = QUALITY[quality] ? quality : 'high';
    this.movieOpts = {
      sourceFps: opts.sourceFps || this.movieOpts?.sourceFps || 30,
      sourceHeight: opts.sourceHeight || this.movieOpts?.sourceHeight || 0,
      efficiency: opts.efficiency ?? this.movieOpts?.efficiency ?? false,
    };
    const result = { video: false, audio: false };
    const video = stream.getVideoTracks()[0];
    if (video) {
      await this.publishMovieVideo(video, this.movieTracks.quality);
      result.video = true;
    }
    const audio = stream.getAudioTracks()[0];
    if (audio) {
      await this.publishMovieAudio(audio);
      result.audio = true;
    }
    this.refresh();
    return result;
  }

  async publishMovieVideo(track, quality) {
    const q = QUALITY[quality] || QUALITY.high;
    track.contentHint = 'motion';
    const srcSettings = track.getSettings?.() || {};
    const srcHeight = srcSettings.height || this.movieOpts.sourceHeight || 720;
    const srcFps = Math.min(30, this.movieOpts.sourceFps || 30);
    this.movieOpts.sourceHeight = srcHeight;

    const lowUpload = this.isLowUploadConfig(quality);
    const efficiency = !!this.movieOpts.efficiency;
    const codec = this.pickMovieCodec(efficiency, lowUpload);

    // Choose initial Auto ladder rung (default 720p24 2.2M, or match known upload estimate)
    let startIdx = Math.min(4, this.maxAutoRungIdx(srcHeight, srcFps));
    if (quality === 'auto' && this.lastEstimatedUploadBps > 0) {
      const budget = this.lastEstimatedUploadBps * 0.85;
      let chosen = 0;
      for (let i = 0; i <= this.maxAutoRungIdx(srcHeight, srcFps); i++) {
        if (AUTO_LADDER[i].bitrate <= budget) chosen = i;
      }
      startIdx = chosen;
    }

    const startRung = AUTO_LADDER[startIdx];
    const targetBitrate = quality === 'auto' ? startRung.bitrate : q.bitrate;
    const targetFps = Math.min(quality === 'auto' ? startRung.fps : q.fps, srcFps);
    const initialScale = quality === 'auto' && srcHeight > startRung.height
      ? Math.max(1, +(srcHeight / startRung.height).toFixed(3))
      : 1;

    const pubOpts = {
      name: MOVIE,
      source: Track.Source.ScreenShare,
      videoCodec: codec,
      degradationPreference: lowUpload ? 'balanced' : 'maintain-framerate',
      screenShareEncoding: { maxBitrate: targetBitrate, maxFramerate: targetFps },
      videoEncoding: { maxBitrate: targetBitrate, maxFramerate: targetFps },
    };

    if (lowUpload) {
      pubOpts.simulcast = false;
      pubOpts.backupCodec = false;
      if (codec === 'vp9' || codec === 'av1' || codec === 'vp8') {
        pubOpts.scalabilityMode = 'L1T3';
      }
    } else {
      pubOpts.simulcast = true;
      pubOpts.backupCodec = efficiency ? false : { codec: 'vp8' };
      pubOpts.screenShareSimulcastLayers = [new VideoPreset(960, 540, 900_000, Math.min(30, srcFps))];
      pubOpts.videoSimulcastLayers = [new VideoPreset(960, 540, 900_000, Math.min(30, srcFps))];
    }

    let pub;
    try {
      pub = await this.room.localParticipant.publishTrack(track, pubOpts);
    } catch (err) {
      // Fallback cleanly if temporal SVC mode / codec was rejected by browser/SFU
      if (pubOpts.scalabilityMode || codec !== 'h264') {
        delete pubOpts.scalabilityMode;
        pubOpts.videoCodec = 'h264';
        pub = await this.room.localParticipant.publishTrack(track, pubOpts);
      } else {
        throw err;
      }
    }

    this.movieTracks.video = pub.track;
    this.movieTracks.codec = pubOpts.videoCodec;
    this.autoState = {
      idx: startIdx,
      troubleTicks: 0,
      stableTicks: 0,
      cpuTroubleTicks: 0,
      lastRungAt: Date.now(),
      prev: null,
      codec: pubOpts.videoCodec,
      lowUpload,
    };

    if (quality === 'auto' || initialScale > 1 || lowUpload) {
      await this.applySenderParams({
        maxBitrate: targetBitrate,
        maxFramerate: targetFps,
        scaleResolutionDownBy: initialScale,
        degradationPreference: lowUpload ? 'balanced' : 'maintain-framerate',
      });
    }
    this.startHostMonitor();
  }

  async applySenderParams({ maxBitrate, maxFramerate, scaleResolutionDownBy, degradationPreference }) {
    const sender = this.movieTracks.video?.sender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!Array.isArray(params.encodings) || !params.encodings.length) return;
      if (degradationPreference) params.degradationPreference = degradationPreference;
      const enc = params.encodings.find((e) => e.active !== false) || params.encodings[0];
      if (maxBitrate) enc.maxBitrate = maxBitrate;
      if (maxFramerate) enc.maxFramerate = maxFramerate;
      if (scaleResolutionDownBy) enc.scaleResolutionDownBy = Math.max(1, scaleResolutionDownBy);
      await sender.setParameters(params);
    } catch {
      /* ignore transient negotiation error */
    }
  }

  startHostMonitor() {
    clearInterval(this.autoTimer);
    if (!this.movieTracks.video) return;
    this.autoTimer = setInterval(() => this.runHostMonitor(), 2000);
  }

  stopHostMonitor() {
    clearInterval(this.autoTimer);
    this.autoTimer = null;
    this.autoState = null;
  }

  async runHostMonitor() {
    const track = this.movieTracks.video;
    const sender = track?.sender;
    const st = this.autoState;
    if (!sender || !st || !this.connected) return;
    try {
      const raw = await sender.getStats();
      const now = Date.now();
      let availBps = 0;
      let packetLoss = 0;
      let totalSent = 0;
      let totalEncoded = 0;
      let totalEncodeTime = 0;
      let lim = 'none';
      let currentFps = 0;
      const remoteById = new Map();

      raw.forEach((v) => {
        if (v.type === 'remote-inbound-rtp') remoteById.set(v.id, v);
        if (v.type === 'candidate-pair' && v.state === 'succeeded' && v.availableOutgoingBitrate) {
          availBps = v.availableOutgoingBitrate;
        }
      });
      raw.forEach((v) => {
        if (v.type === 'outbound-rtp' && v.kind === 'video') {
          totalSent += v.framesSent || 0;
          totalEncoded += v.framesEncoded || 0;
          totalEncodeTime += v.totalEncodeTime || 0;
          if (v.qualityLimitationReason && v.qualityLimitationReason !== 'none') lim = v.qualityLimitationReason;
          if (v.framesPerSecond) currentFps = Math.max(currentFps, v.framesPerSecond);
          const ri = v.remoteId ? remoteById.get(v.remoteId) : null;
          if (ri && typeof ri.fractionLost === 'number') {
            packetLoss = Math.max(packetLoss, ri.fractionLost);
          }
        }
      });

      if (availBps > 0) this.lastEstimatedUploadBps = availBps;

      let cpuStruggling = lim === 'cpu';
      if (st.prev) {
        const dEnc = totalEncoded - st.prev.encoded;
        const dSent = totalSent - st.prev.sent;
        const dTime = totalEncodeTime - st.prev.encTime;
        const targetFps = Math.min(AUTO_LADDER[st.idx]?.fps || 24, this.movieOpts.sourceFps || 30);
        const budgetMs = 1000 / Math.max(15, targetFps);
        const encMsPerFrame = dEnc > 0 ? (dTime / dEnc) * 1000 : 0;
        if ((dEnc >= 8 && encMsPerFrame > budgetMs * 0.9) || (dEnc >= 10 && dSent >= 0 && dSent / dEnc < 0.7)) {
          cpuStruggling = true;
        }
      }
      st.prev = { t: now, sent: totalSent, encoded: totalEncoded, encTime: totalEncodeTime };

      // 1) Efficiency mode / SVC codec CPU fallback (AV1 -> VP9 -> H.264/VP8)
      if ((st.codec === 'av1' || st.codec === 'vp9') && cpuStruggling) {
        st.cpuTroubleTicks += 1;
        if (st.cpuTroubleTicks >= 2) {
          this.codecBlocked.add(st.codec);
          const failed = st.codec.toUpperCase();
          st.cpuTroubleTicks = 0;
          const nextCodec = this.pickMovieCodec(this.movieOpts.efficiency, st.lowUpload);
          this.hooks.onInfo?.(`${failed} encoding is stressing your CPU; falling back to ${nextCodec.toUpperCase()}.`);
          await this.setMovieQuality(this.movieTracks.quality, this.movieOpts);
          return;
        }
      } else {
        st.cpuTroubleTicks = 0;
      }

      // 2) Auto bitrate/resolution controller (fixed presets NEVER auto-adapt)
      if (this.movieTracks.quality !== 'auto') return;

      const srcHeight = track.mediaStreamTrack?.getSettings?.().height || this.movieOpts.sourceHeight || 1080;
      const srcFps = Math.min(30, this.movieOpts.sourceFps || 30);
      const maxIdx = this.maxAutoRungIdx(srcHeight, srcFps);
      const curRung = AUTO_LADDER[st.idx] || AUTO_LADDER[0];

      const bwLow = availBps > 0 && availBps < curRung.bitrate * 1.12;
      const trouble = bwLow || lim === 'bandwidth' || lim === 'cpu' || packetLoss > 0.03 || cpuStruggling;

      if (trouble) {
        st.stableTicks = 0;
        st.troubleTicks += 1;
        if (st.troubleTicks >= 2 && st.idx > 0) {
          let targetIdx = st.idx - 1;
          if (availBps > 0) {
            const budget = availBps * 0.85;
            targetIdx = 0;
            for (let i = 0; i < st.idx; i++) {
              if (AUTO_LADDER[i].bitrate <= budget) targetIdx = i;
            }
          }
          if (targetIdx !== st.idx) {
            await this.applyAutoRung(targetIdx, srcHeight, srcFps);
          }
          st.troubleTicks = 0;
        }
      } else {
        st.troubleTicks = 0;
        st.stableTicks += 1;
        if (st.stableTicks >= 10 && st.idx < maxIdx) {
          const nextRung = AUTO_LADDER[st.idx + 1];
          const headroomOk = availBps === 0 || availBps * 0.82 >= nextRung.bitrate;
          if (headroomOk && packetLoss < 0.01) {
            await this.applyAutoRung(st.idx + 1, srcHeight, srcFps);
          }
          st.stableTicks = 0;
        }
      }
    } catch {
      /* ignore transient stats read error */
    }
  }

  async applyAutoRung(targetIdx, srcHeight, srcFps) {
    const st = this.autoState;
    if (!st) return;
    st.idx = targetIdx;
    st.lastRungAt = Date.now();
    const rung = AUTO_LADDER[targetIdx];
    const scale = srcHeight > rung.height ? Math.max(1, +(srcHeight / rung.height).toFixed(3)) : 1;
    const maxFps = Math.min(rung.fps, srcFps || 30);
    await this.applySenderParams({
      maxBitrate: rung.bitrate,
      maxFramerate: maxFps,
      scaleResolutionDownBy: scale,
      degradationPreference: 'balanced',
    });
    const wantAudioBps = rung.bitrate < 3_000_000 ? 64_000 : 96_000;
    await this.setAudioMaxBitrate(wantAudioBps);
    this.hooks.onChange();
  }

  async setAudioMaxBitrate(bps) {
    const sender = this.movieTracks.audio?.sender;
    if (!sender) return;
    try {
      const p = sender.getParameters();
      if (Array.isArray(p.encodings) && p.encodings.length && p.encodings[0].maxBitrate !== bps) {
        p.encodings[0].maxBitrate = bps;
        await sender.setParameters(p);
      }
    } catch { /* ignore */ }
  }

  async setMovieSourceFps(fps) {
    const snapped = Math.min(30, Math.max(24, fps || 30));
    if (this.movieOpts.sourceFps === snapped) return;
    this.movieOpts.sourceFps = snapped;
    if (!this.movieTracks.video) return;
    const q = QUALITY[this.movieTracks.quality] || QUALITY.high;
    const rung = this.autoState ? AUTO_LADDER[this.autoState.idx] : null;
    const maxFps = Math.min(this.movieTracks.quality === 'auto' && rung ? rung.fps : q.fps, snapped);
    await this.applySenderParams({ maxFramerate: maxFps });
  }

  requestHighQuality(enable) {
    const pub = this.state.movie?.publication;
    if (pub && typeof pub.setVideoQuality === 'function') {
      if (enable) pub.setVideoQuality(VideoQuality.HIGH);
    }
  }

  async publishMovieAudio(track) {
    track.contentHint = 'music';
    const lowUpload = this.isLowUploadConfig(this.movieTracks.quality);
    const pub = await this.room.localParticipant.publishTrack(track, {
      name: MOVIE_AUDIO,
      source: Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: lowUpload ? 64_000 : 96_000 },
      forceStereo: true,
      dtx: false,
      red: false,
    });
    this.movieTracks.audio = pub.track;
  }

  /** A track that showed up after capture started (some browsers add audio late). */
  async publishLateMovieTrack(track) {
    if (!this.connected) return false;
    if (track.kind === 'audio' && !this.movieTracks.audio) await this.publishMovieAudio(track);
    else if (track.kind === 'video' && !this.movieTracks.video) await this.publishMovieVideo(track, this.movieTracks.quality);
    else return false;
    this.refresh();
    return true;
  }

  async setMovieQuality(quality, opts = {}) {
    const old = this.movieTracks.video;
    this.movieTracks.quality = QUALITY[quality] ? quality : 'high';
    if (opts.efficiency !== undefined) this.movieOpts.efficiency = !!opts.efficiency;
    if (opts.sourceFps) this.movieOpts.sourceFps = opts.sourceFps;
    if (!old || !this.connected) return;
    this.stopHostMonitor();
    const raw = old.mediaStreamTrack;
    await this.room.localParticipant.unpublishTrack(old, false);
    this.movieTracks.video = null;
    await this.publishMovieVideo(raw, this.movieTracks.quality);
    await this.setAudioMaxBitrate(this.isLowUploadConfig(this.movieTracks.quality) ? 64_000 : 96_000);
    this.refresh();
  }

  async stopMovie() {
    this.stopHostMonitor();
    const { video, audio, stream } = this.movieTracks;
    this.movieTracks = { video: null, audio: null, stream: null, quality: this.movieTracks.quality };
    this.codecBlocked.clear();
    for (const t of [video, audio]) {
      if (!t) continue;
      try { await this.room?.localParticipant.unpublishTrack(t, false); } catch { /* already gone */ }
    }
    stream?.getTracks().forEach((t) => t.stop());
    this.refresh();
  }

  /** Live numbers for the host's quality badge (what is really being sent). */
  async movieSendStats() {
    try {
      const track = this.movieTracks.video;
      const stats = await track?.getSenderStats?.();
      if (!stats?.length) return null;
      const active = stats.filter((s) => (s.frameWidth || 0) > 0);
      const top = (active.length ? active : stats).reduce((a, b) => ((b.frameWidth || 0) > (a.frameWidth || 0) ? b : a));
      return {
        width: top.frameWidth,
        height: top.frameHeight,
        fps: top.framesPerSecond,
        bitrate: top.targetBitrate,
        limited: top.qualityLimitationReason && top.qualityLimitationReason !== 'none' ? top.qualityLimitationReason : null,
        codec: this.movieTracks.codec || '',
        rung: this.movieTracks.quality === 'auto' && this.autoState ? AUTO_LADDER[this.autoState.idx]?.name : null,
      };
    } catch {
      return null;
    }
  }

  async movieReceiveStats() {
    try {
      const movie = this.state.movie;
      const track = movie?.video;
      if (!track) return null;
      if (!movie.local) this.applyMovieJitterBuffer();
      const s = await track.getReceiverStats?.();
      let raw = null;
      if (track.receiver?.getStats) {
        const rep = await track.receiver.getStats();
        for (const r of rep.values()) {
          if (r.type === 'inbound-rtp' && r.kind === 'video') { raw = r; break; }
        }
      }
      const videoRcv = track.receiver;
      const audioRcv = movie?.audio?.receiver;
      const jbV = videoRcv && 'jitterBufferTarget' in videoRcv ? videoRcv.jitterBufferTarget : null;
      const jbA = audioRcv && 'jitterBufferTarget' in audioRcv ? audioRcv.jitterBufferTarget : null;
      const src = raw || s;
      if (!src) return null;
      return {
        width: src.frameWidth || s?.frameWidth || s?.width || 0,
        height: src.frameHeight || s?.frameHeight || s?.height || 0,
        fps: raw?.framesPerSecond ?? s?.framesPerSecond ?? 0,
        framesDecoded: raw?.framesDecoded ?? s?.framesDecoded ?? 0,
        framesDropped: raw?.framesDropped ?? s?.framesDropped ?? 0,
        framesReceived: raw?.framesReceived ?? s?.framesReceived ?? 0,
        freezeCount: raw?.freezeCount ?? 0,
        totalFreezesDuration: raw?.totalFreezesDuration ?? 0,
        jitterBufferDelay: raw?.jitterBufferDelay ?? s?.jitterBufferDelay ?? 0,
        jitterBufferEmittedCount: raw?.jitterBufferEmittedCount ?? s?.jitterBufferEmittedCount ?? 0,
        qpSum: raw?.qpSum ?? 0,
        jbTargetVideo: jbV,
        jbTargetAudio: jbA,
      };
    } catch {
      return null;
    }
  }
}

export function qualityLabel(q) {
  return { [ConnectionQuality.Excellent]: 'Excellent', [ConnectionQuality.Good]: 'Good', [ConnectionQuality.Poor]: 'Poor', [ConnectionQuality.Lost]: 'Lost' }[q] || 'Checking…';
}

export function explainMediaError(err) {
  const name = err?.name || err?.error?.name || '';
  const msg = err?.message || String(err || '');
  if (name === 'NotAllowedError' || /permission|denied/i.test(msg)) return 'Access was blocked. Click the camera/lock icon in your browser’s address bar, allow it, then try again.';
  if (name === 'NotFoundError' || /requested device not found/i.test(msg)) return 'No camera or microphone was found. Plug one in and try again.';
  if (name === 'NotReadableError' || /could not start/i.test(msg)) return 'Your camera or microphone is being used by another app. Close it and try again.';
  if (name === 'OverconstrainedError') return 'That device can’t do what was asked. Pick another one in Devices.';
  return msg || 'Something went wrong with your camera or microphone.';
}
