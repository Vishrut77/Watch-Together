// Client-side lightweight container probe, EBML / MP4 / RIFF parser, and codec detector.
// Zero dependencies, fast and runs locally in pure JS.

export const CODEC_NAMES = {
  'V_MPEG4/ISO/AVC': 'H.264 (AVC)',
  'avc1': 'H.264 (AVC)',
  'avc3': 'H.264 (AVC)',
  'V_MPEGH/ISO/HEVC': 'HEVC (H.265)',
  'hev1': 'HEVC (H.265)',
  'hvc1': 'HEVC (H.265)',
  'V_VP8': 'VP8',
  'vp8': 'VP8',
  'vp08': 'VP8',
  'V_VP9': 'VP9',
  'vp9': 'VP9',
  'vp09': 'VP9',
  'V_AV1': 'AV1',
  'av01': 'AV1',
  'V_MPEG2': 'MPEG-2',
  'mp4v': 'MPEG-4 Part 2',
  'A_AAC': 'AAC',
  'mp4a': 'AAC',
  'A_MPEG/L3': 'MP3',
  '.mp3': 'MP3',
  'A_AC3': 'AC3 (Dolby Digital)',
  'ac-3': 'AC3 (Dolby Digital)',
  'A_EAC3': 'E-AC3 (Dolby Digital Plus)',
  'ec-3': 'E-AC3 (Dolby Digital Plus)',
  'A_DTS': 'DTS',
  'A_TRUEHD': 'Dolby TrueHD',
  'mlpa': 'Dolby TrueHD',
  'A_OPUS': 'Opus',
  'Opus': 'Opus',
  'A_VORBIS': 'Vorbis',
  'A_FLAC': 'FLAC',
  'fLaC': 'FLAC',
  'A_PCM/INT/LIT': 'PCM',
};

export function snapFps(rawFps) {
  if (!Number.isFinite(rawFps) || rawFps <= 0) return 30;
  if (rawFps <= 24.4) return 24;
  if (rawFps <= 25.6) return 25;
  return 30;
}

// Reads variable length integer (VINT) in EBML
function readVint(buf, offset) {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    len++;
    mask >>= 1;
  }
  if (offset + len > buf.length) return null;
  let val = first & ~mask;
  for (let i = 1; i < len; i++) {
    val = (val << 8) | buf[offset + i];
  }
  return { val, len };
}

// Reads EBML Element ID
function readEbmlId(buf, offset) {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    len++;
    mask >>= 1;
  }
  if (offset + len > buf.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) {
    id = (id << 8) | buf[offset + i];
  }
  return { id: id >>> 0, len };
}

function readString(buf, offset, len) {
  const sub = buf.subarray(offset, offset + len);
  return new TextDecoder('utf-8').decode(sub);
}

function readUint(buf, offset, len) {
  let val = 0;
  for (let i = 0; i < len; i++) {
    val = (val * 256) + buf[offset + i];
  }
  return val;
}

/**
 * Probes the video file by reading only small header/moov slices and extracting
 * container, tracks, codec details, resolution, and frame rate.
 */
export async function probeMedia(file) {
  const headerSlice = file.slice(0, Math.min(file.size, 1024 * 1024));
  const ab = await headerSlice.arrayBuffer();
  const u8 = new Uint8Array(ab);

  // Check EBML (Matroska / WebM)
  if (u8.length >= 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) {
    return probeMatroska(u8, file);
  }

  // Check MP4 / ISO BMFF (ftyp box at offset 4)
  if (u8.length >= 8 && readString(u8, 4, 4) === 'ftyp') {
    const moovBuf = await findMp4Moov(u8, file);
    return probeMp4(moovBuf || u8);
  }

  // Check RIFF / AVI
  if (u8.length >= 12 && readString(u8, 0, 4) === 'RIFF' && readString(u8, 8, 4) === 'AVI ') {
    return probeAvi(u8);
  }

  return {
    container: 'unknown',
    videoCodec: null,
    audioCodec: null,
    audioCodecs: [],
    audioTracks: [],
    videoName: null,
    audioName: null,
    width: 0,
    height: 0,
    fps: 0,
    isNativeSupported: false,
    tier: 0,
  };
}

async function findMp4Moov(headU8, file) {
  // Check if moov already fits inside headU8
  let offset = 0;
  while (offset + 8 <= headU8.length) {
    let size = readUint(headU8, offset, 4);
    const type = readString(headU8, offset + 4, 4);
    let hdr = 8;
    if (size === 1 && offset + 16 <= headU8.length) {
      size = readUint(headU8, offset + 8, 8);
      hdr = 16;
    }
    if (size < 8) break;
    if (type === 'moov') {
      if (offset + size <= headU8.length) return headU8.subarray(offset, offset + size);
      const ab = await file.slice(offset, Math.min(file.size, offset + Math.min(size, 4 * 1024 * 1024))).arrayBuffer();
      return new Uint8Array(ab);
    }
    if (offset + size <= headU8.length) {
      offset += size;
    } else {
      // Jump across top-level boxes (e.g., past mdat) via tiny header reads
      let cur = offset + size;
      let steps = 0;
      while (cur + 16 <= file.size && steps++ < 32) {
        const b = new Uint8Array(await file.slice(cur, cur + 16).arrayBuffer());
        let bSize = readUint(b, 0, 4);
        const bType = readString(b, 4, 4);
        if (bSize === 1) bSize = readUint(b, 8, 8);
        else if (bSize === 0) bSize = file.size - cur;
        if (bSize < 8) break;
        if (bType === 'moov') {
          const ab = await file.slice(cur, Math.min(file.size, cur + Math.min(bSize, 4 * 1024 * 1024))).arrayBuffer();
          return new Uint8Array(ab);
        }
        cur += bSize;
      }
      break;
    }
  }
  return null;
}

function probeAvi(u8) {
  let fps = 0;
  let width = 0;
  let height = 0;
  let vFourcc = '';
  // Look for 'avih' and 'strh'/'strf' within header
  for (let i = 12; i < u8.length - 64; i++) {
    if (u8[i] === 0x61 && u8[i + 1] === 0x76 && u8[i + 2] === 0x69 && u8[i + 3] === 0x68) {
      // avih: +8 dwMicroSecPerFrame (LE uint32), +40 dwWidth, +44 dwHeight
      const usPerFrame = u8[i + 8] | (u8[i + 9] << 8) | (u8[i + 10] << 16) | (u8[i + 11] << 24);
      if (usPerFrame > 0) fps = snapFps(1_000_000 / usPerFrame);
      width = (u8[i + 40] | (u8[i + 41] << 8) | (u8[i + 42] << 16) | (u8[i + 43] << 24)) >>> 0;
      height = (u8[i + 44] | (u8[i + 45] << 8) | (u8[i + 46] << 16) | (u8[i + 47] << 24)) >>> 0;
    }
    if (u8[i] === 0x76 && u8[i + 1] === 0x69 && u8[i + 2] === 0x64 && u8[i + 3] === 0x73 && !vFourcc) {
      vFourcc = readString(u8, i + 4, 4).replace(/\0/g, '').trim();
    }
  }
  return {
    container: 'avi',
    videoCodec: vFourcc || 'avi',
    audioCodec: 'mp3',
    audioCodecs: ['mp3'],
    audioTracks: [{ index: 0, codec: 'mp3', name: 'AVI Audio', language: '' }],
    videoName: vFourcc ? `AVI (${vFourcc})` : 'AVI Video',
    audioName: 'AVI Audio',
    width,
    height,
    fps: fps || 24,
    isNativeSupported: false,
    tier: 1,
  };
}

function probeMatroska(u8) {
  let offset = 0;
  const tracks = [];
  let isDocWebM = false;

  while (offset < u8.length - 8) {
    const idInfo = readEbmlId(u8, offset);
    if (!idInfo) break;
    offset += idInfo.len;

    const sizeInfo = readVint(u8, offset);
    if (!sizeInfo) break;
    offset += sizeInfo.len;

    const elemId = idInfo.id;
    const elemEnd = offset + sizeInfo.val;

    if (elemId === 0x4282) {
      const docType = readString(u8, offset, sizeInfo.val);
      if (docType.includes('webm')) isDocWebM = true;
    }

    // EBML header or Segment container: recurse into child elements
    if (elemId === 0x1a45dfa3 || elemId === 0x18538067) {
      continue;
    }

    // Tracks: 0x1654AE6B
    if (elemId === 0x1654ae6b) {
      let tOffset = offset;
      while (tOffset < elemEnd && tOffset < u8.length) {
        const tId = readEbmlId(u8, tOffset);
        if (!tId) break;
        tOffset += tId.len;
        const tSize = readVint(u8, tOffset);
        if (!tSize) break;
        tOffset += tSize.len;
        const tEnd = tOffset + tSize.val;

        if (tId.id === 0xae) {
          const track = parseTrackEntry(u8, tOffset, tEnd);
          if (track) tracks.push(track);
        }
        tOffset = tEnd;
      }
      break;
    }

    offset = elemEnd;
  }

  const vTrack = tracks.find((t) => t.type === 'video');
  const aTracks = tracks.filter((t) => t.type === 'audio');
  const aTrack = aTracks[0];

  const vCodec = vTrack?.codec || '';
  const aCodec = aTrack?.codec || '';
  const aCodecs = aTracks.map((t) => t.codec).filter(Boolean);

  const vName = CODEC_NAMES[vCodec] || vCodec || 'Unknown Video';
  const aName = aTrack ? (CODEC_NAMES[aCodec] || aCodec || 'Audio') : 'None';

  const isWebMVideo = vCodec === 'V_VP8' || vCodec === 'V_VP9' || vCodec === 'V_AV1';
  const isH264 = vCodec === 'V_MPEG4/ISO/AVC' || vCodec === 'avc1';
  const isWebMAudio = !aCodec || aCodec === 'A_OPUS' || aCodec === 'A_VORBIS';
  const isAacAudio = !aCodec || aCodec === 'A_AAC' || aCodec === 'mp4a';

  const isNativeWebM = isDocWebM && isWebMVideo && isWebMAudio;
  const hasUnsupportedAudio = aTracks.length > 0 && aTracks.some((t) =>
    /AC3|EAC3|DTS|TRUEHD|MLP/i.test(t.codec)
  );
  const hasUnsupportedVideo = /HEVC|MPEGH|MPEG2|VC1/i.test(vCodec);

  let tier = 0;
  if (isNativeWebM) {
    tier = 0;
  } else if (!hasUnsupportedVideo && !hasUnsupportedAudio && (isWebMVideo || isH264) && (isWebMAudio || isAacAudio)) {
    tier = 1;
  } else {
    tier = hasUnsupportedVideo || hasUnsupportedAudio ? 2 : 1;
  }

  return {
    container: isDocWebM ? 'webm' : 'mkv',
    videoCodec: vCodec,
    audioCodec: aCodec,
    audioCodecs: aCodecs,
    audioTracks: aTracks.map((t, i) => ({
      index: i,
      codec: t.codec,
      name: CODEC_NAMES[t.codec] || t.codec,
      language: t.language || '',
      channels: t.channels || 0,
    })),
    videoName: vName,
    audioName: aName,
    width: vTrack?.width || 0,
    height: vTrack?.height || 0,
    fps: vTrack?.fps || 0,
    isNativeSupported: isNativeWebM,
    tier,
  };
}

function parseTrackEntry(u8, offset, end) {
  let cur = offset;
  let type = '';
  let codec = '';
  let width = 0;
  let height = 0;
  let fps = 0;
  let language = '';
  let channels = 0;

  while (cur < end && cur < u8.length) {
    const idInfo = readEbmlId(u8, cur);
    if (!idInfo) break;
    cur += idInfo.len;
    const sizeInfo = readVint(u8, cur);
    if (!sizeInfo) break;
    cur += sizeInfo.len;
    const eEnd = cur + sizeInfo.val;

    if (idInfo.id === 0x83) {
      const val = readUint(u8, cur, sizeInfo.val);
      type = val === 1 ? 'video' : val === 2 ? 'audio' : 'other';
    } else if (idInfo.id === 0x86) {
      codec = readString(u8, cur, sizeInfo.val).replace(/\0.*$/g, '');
    } else if (idInfo.id === 0x22b59c) {
      language = readString(u8, cur, sizeInfo.val).replace(/\0.*$/g, '');
    } else if (idInfo.id === 0x23e383) {
      const defaultDurNs = readUint(u8, cur, sizeInfo.val);
      if (defaultDurNs > 0) fps = snapFps(1_000_000_000 / defaultDurNs);
    } else if (idInfo.id === 0xe0) {
      let vCur = cur;
      while (vCur < eEnd && vCur < u8.length) {
        const vid = readEbmlId(u8, vCur);
        if (!vid) break;
        vCur += vid.len;
        const vsz = readVint(u8, vCur);
        if (!vsz) break;
        vCur += vsz.len;
        if (vid.id === 0xb0) width = readUint(u8, vCur, vsz.val);
        if (vid.id === 0xba) height = readUint(u8, vCur, vsz.val);
        vCur += vsz.val;
      }
    } else if (idInfo.id === 0xe1) {
      let aCur = cur;
      while (aCur < eEnd && aCur < u8.length) {
        const aid = readEbmlId(u8, aCur);
        if (!aid) break;
        aCur += aid.len;
        const asz = readVint(u8, aCur);
        if (!asz) break;
        aCur += asz.len;
        if (aid.id === 0x9f) channels = readUint(u8, aCur, asz.val);
        aCur += asz.val;
      }
    }
    cur = eEnd;
  }

  return { type, codec, width, height, fps, language, channels };
}

function probeMp4(u8) {
  const tracks = [];
  parseMp4Container(u8, 0, u8.length, tracks, null);

  const vTrack = tracks.find((t) => t.kind === 'vide');
  const aTracks = tracks.filter((t) => t.kind === 'soun');
  const aTrack = aTracks[0];

  const vCodec = vTrack?.codec || '';
  const aCodec = aTrack?.codec || '';
  const vName = CODEC_NAMES[vCodec] || vCodec || 'H.264 (AVC)';
  const aName = aTrack ? (CODEC_NAMES[aCodec] || aCodec || 'AAC') : 'None';

  const isUnsupportedV = /hev1|hvc1|mp4v/i.test(vCodec);
  const isUnsupportedA = aTracks.some((t) => /ac-3|ec-3|mlpa|dtsc|dtsh|dtsx/i.test(t.codec || ''));

  return {
    container: 'mp4',
    videoCodec: vCodec || 'avc1',
    audioCodec: aCodec,
    audioCodecs: aTracks.map((t) => t.codec).filter(Boolean),
    audioTracks: aTracks.map((t, i) => ({
      index: i,
      codec: t.codec,
      name: CODEC_NAMES[t.codec] || t.codec,
      language: t.language || '',
    })),
    videoName: vName,
    audioName: aName,
    width: vTrack?.width || 0,
    height: vTrack?.height || 0,
    fps: vTrack?.fps || 0,
    isNativeSupported: !isUnsupportedV && !isUnsupportedA,
    tier: (isUnsupportedV || isUnsupportedA) ? 2 : 0,
  };
}

function parseMp4Container(u8, start, end, tracks, curTrak) {
  let offset = start;
  while (offset + 8 <= end && offset + 8 <= u8.length) {
    let size = readUint(u8, offset, 4);
    const boxType = readString(u8, offset + 4, 4);
    let hdr = 8;
    if (size === 1 && offset + 16 <= u8.length) {
      size = readUint(u8, offset + 8, 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < 8) break;
    const boxEnd = Math.min(end, offset + size);

    if (boxType === 'trak') {
      const trak = { kind: '', codec: '', timescale: 0, width: 0, height: 0, fps: 0, language: '' };
      parseMp4Container(u8, offset + hdr, boxEnd, tracks, trak);
      tracks.push(trak);
    } else if (boxType === 'moov' || boxType === 'mdia' || boxType === 'minf' || boxType === 'stbl') {
      parseMp4Container(u8, offset + hdr, boxEnd, tracks, curTrak);
    } else if (curTrak) {
      if (boxType === 'tkhd' && offset + hdr + 84 <= boxEnd) {
        const ver = u8[offset + hdr];
        const wOff = offset + hdr + (ver === 1 ? 88 : 76);
        if (wOff + 8 <= boxEnd) {
          curTrak.width = readUint(u8, wOff, 2);
          curTrak.height = readUint(u8, wOff + 4, 2);
        }
      } else if (boxType === 'mdhd' && offset + hdr + 24 <= boxEnd) {
        const ver = u8[offset + hdr];
        const tsOff = offset + hdr + (ver === 1 ? 20 : 12);
        if (tsOff + 4 <= boxEnd) curTrak.timescale = readUint(u8, tsOff, 4);
        const langOff = offset + hdr + (ver === 1 ? 32 : 20);
        if (langOff + 2 <= boxEnd) {
          const packed = readUint(u8, langOff, 2);
          const c1 = ((packed >> 10) & 0x1f) + 0x60;
          const c2 = ((packed >> 5) & 0x1f) + 0x60;
          const c3 = (packed & 0x1f) + 0x60;
          const lang = String.fromCharCode(c1, c2, c3);
          if (/^[a-z]{3}$/.test(lang) && lang !== 'und') curTrak.language = lang;
        }
      } else if (boxType === 'hdlr' && offset + hdr + 12 <= boxEnd) {
        curTrak.kind = readString(u8, offset + hdr + 8, 4);
      } else if (boxType === 'stsd' && offset + hdr + 16 <= boxEnd) {
        const entryCodec = readString(u8, offset + hdr + 12, 4);
        curTrak.codec = entryCodec;
      } else if (boxType === 'stts' && offset + hdr + 16 <= boxEnd) {
        const count = readUint(u8, offset + hdr + 4, 4);
        if (count >= 1 && curTrak.timescale > 0) {
          const sampleDelta = readUint(u8, offset + hdr + 12, 4);
          if (sampleDelta > 0) curTrak.fps = snapFps(curTrak.timescale / sampleDelta);
        }
      }
    }
    offset += size;
  }
}

/**
 * Tests whether WebCodecs VideoDecoder supports decoding the given codec.
 */
export async function canWebCodecsDecode(codecString, width = 1280, height = 720) {
  if (typeof VideoDecoder === 'undefined' || typeof VideoDecoder.isConfigSupported !== 'function') {
    return false;
  }
  try {
    const res = await VideoDecoder.isConfigSupported({
      codec: codecString,
      codedWidth: width,
      codedHeight: height,
    });
    return res.supported === true;
  } catch {
    return false;
  }
}

export function canWebCodecsAudioDecode(codecString, sampleRate = 48000, channels = 2) {
  if (typeof AudioDecoder === 'undefined' || typeof AudioDecoder.isConfigSupported !== 'function') {
    return Promise.resolve(false);
  }
  return AudioDecoder.isConfigSupported({
    codec: codecString,
    sampleRate,
    numberOfChannels: channels,
  }).then((r) => r.supported === true).catch(() => false);
}
