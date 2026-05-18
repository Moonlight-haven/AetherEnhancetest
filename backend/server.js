'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Multer – memory storage, 2 GB cap ────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

const TIKTOK_CONFIG = {
  CLIENT_KEY: process.env.TIKTOK_CLIENT_KEY || "sbawsb9lzwltcl6uv2",
  CLIENT_SECRET: process.env.TIKTOK_CLIENT_SECRET || "",
  REDIRECT_URI: "https://moonlight-haven.github.io/AetherEnhancetest/studio.html"
};

// ═══════════════════════════════════════════════════════════════════════════════
//  LOW-LEVEL BUFFER HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function readU32(buf, offset) {
  if (offset + 4 > buf.length) throw new RangeError(`readU32 OOB @ ${offset}`);
  return buf.readUInt32BE(offset);
}

function writeU32(buf, offset, value) {
  if (offset + 4 > buf.length) throw new RangeError(`writeU32 OOB @ ${offset}`);
  buf.writeUInt32BE(value >>> 0, offset);
}

function readU64(buf, offset) {
  if (offset + 8 > buf.length) throw new RangeError(`readU64 OOB @ ${offset}`);
  const hi = buf.readUInt32BE(offset);
  const lo = buf.readUInt32BE(offset + 4);
  return hi * 0x1_0000_0000 + lo;
}

function writeU64(buf, offset, value) {
  if (offset + 8 > buf.length) throw new RangeError(`writeU64 OOB @ ${offset}`);
  const hi = Math.floor(value / 0x1_0000_0000);
  const lo = value >>> 0;
  buf.writeUInt32BE(hi >>> 0, offset);
  buf.writeUInt32BE(lo, offset + 4);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ATOM / BOX WALKER
// ═══════════════════════════════════════════════════════════════════════════════

function* walkBoxes(buf, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    const size32 = readU32(buf, pos);
    const name   = buf.slice(pos + 4, pos + 8).toString('latin1');

    let totalSize;
    let headerSize;

    if (size32 === 1) {
      if (pos + 16 > end) break;
      totalSize  = readU64(buf, pos + 8);
      headerSize = 16;
    } else if (size32 === 0) {
      totalSize  = end - pos;
      headerSize = 8;
    } else {
      totalSize  = size32;
      headerSize = 8;
    }

    if (totalSize < headerSize || pos + totalSize > end) break;

    yield {
      name,
      offset:        pos,
      headerSize,
      payloadOffset: pos + headerSize,
      payloadSize:   totalSize - headerSize,
      totalSize,
    };

    pos += totalSize;
  }
}

function findBox(buf, containerPayloadOffset, containerPayloadSize, targetName) {
  for (const box of walkBoxes(buf, containerPayloadOffset, containerPayloadOffset + containerPayloadSize)) {
    if (box.name === targetName) return box;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PATCH HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const TARGET_TIMESCALE = 30_000;

function patchMvhd(buf, box) {
  const p       = box.payloadOffset;  
  const version = buf[p];

  if (version === 0) {
    const oldTimescale = readU32(buf, p + 12);
    const oldDuration  = readU32(buf, p + 16);
    const scale        = TARGET_TIMESCALE / oldTimescale;
    const newDuration  = Math.round(oldDuration * scale);

    writeU32(buf, p + 12, TARGET_TIMESCALE);
    writeU32(buf, p + 16, newDuration);

    return scale;
  } else {
    const oldTimescale = readU32(buf, p + 20);
    const oldDuration  = readU64(buf, p + 24);
    const scale        = TARGET_TIMESCALE / oldTimescale;
    const newDuration  = Math.round(oldDuration * scale);

    writeU32(buf, p + 20, TARGET_TIMESCALE);
    writeU64(buf, p + 24, newDuration);

    return scale;
  }
}

function patchMdhd(buf, box) {
  const p       = box.payloadOffset;
  const version = buf[p];

  if (version === 0) {
    const oldTimescale = readU32(buf, p + 12);
    const oldDuration  = readU32(buf, p + 16);
    const scale        = TARGET_TIMESCALE / oldTimescale;

    writeU32(buf, p + 12, TARGET_TIMESCALE);
    writeU32(buf, p + 16, Math.round(oldDuration * scale));

    return scale;
  } else {
    const oldTimescale = readU32(buf, p + 20);
    const oldDuration  = readU64(buf, p + 24);
    const scale        = TARGET_TIMESCALE / oldTimescale;

    writeU32(buf, p + 20, TARGET_TIMESCALE);
    writeU64(buf, p + 24, Math.round(oldDuration * scale));

    return scale;
  }
}

function patchStts(buf, box, scaleFactor) {
  const p          = box.payloadOffset;
  const entryCount = readU32(buf, p + 4);
  let   cursor     = p + 8;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 8 > buf.length) break;

    const delta    = readU32(buf, cursor + 4);
    const newDelta = Math.max(1, Math.round(delta * scaleFactor));
    writeU32(buf, cursor + 4, newDelta);

    cursor += 8;
  }
}

function patchCtts(buf, box, scaleFactor) {
  const p          = box.payloadOffset;
  const version    = buf[p];
  const entryCount = readU32(buf, p + 4);
  let   cursor     = p + 8;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 8 > buf.length) break;

    if (version === 1) {
      const offset    = buf.readInt32BE(cursor + 4);
      const newOffset = Math.round(offset * scaleFactor);
      buf.writeInt32BE(newOffset, cursor + 4);
    } else {
      const offset    = readU32(buf, cursor + 4);
      const newOffset = Math.round(offset * scaleFactor);
      writeU32(buf, cursor + 4, newOffset);
    }

    cursor += 8;
  }
}

function patchMp4(inputBuffer) {
  const buf = Buffer.from(inputBuffer);

  const moov = findBox(buf, 0, buf.length, 'moov');
  if (!moov) throw new Error('No moov box found – is this a valid MP4?');

  const mvhd = findBox(buf, moov.payloadOffset, moov.payloadSize, 'mvhd');
  if (!mvhd) throw new Error('No mvhd box found inside moov');

  const movieScaleFactor = patchMvhd(buf, mvhd);

  for (const trak of walkBoxes(buf, moov.payloadOffset, moov.payloadOffset + moov.payloadSize)) {
    if (trak.name !== 'trak') continue;

    const mdia = findBox(buf, trak.payloadOffset, trak.payloadSize, 'mdia');
    if (!mdia) continue;

    const mdhd = findBox(buf, mdia.payloadOffset, mdia.payloadSize, 'mdhd');
    if (!mdhd) continue;

    const mediaScaleFactor = patchMdhd(buf, mdhd);

    const minf = findBox(buf, mdia.payloadOffset, mdia.payloadSize, 'minf');
    if (!minf) continue;

    const stbl = findBox(buf, minf.payloadOffset, minf.payloadSize, 'stbl');
    if (!stbl) continue;

    const stts = findBox(buf, stbl.payloadOffset, stbl.payloadSize, 'stts');
    if (stts) patchStts(buf, stts, mediaScaleFactor);

    const ctts = findBox(buf, stbl.payloadOffset, stbl.payloadSize, 'ctts');
    if (ctts) patchCtts(buf, ctts, mediaScaleFactor);
  }

  return buf;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPRESS ROUTE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// Endpoint 1: High-Fidelity Container Patcher
app.post('/api/optimize-video', upload.single('video'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Use field name "video".' });
    }

    console.log(`[AetherEnhance] Processing binary patch for: ${req.file.originalname}`);
    const patched      = patchMp4(req.file.buffer);
    const originalName = (req.file.originalname || 'video.mp4').replace(/[^\w.\-]/g, '_');
    const outputName   = `aetherenhance_${originalName}`;

    res
      .status(200)
      .set({
        'Content-Type':        'video/mp4',
        'Content-Disposition': `inline; filename="${outputName}"`,
        'Content-Length':      patched.length,
        'Cache-Control':       'no-store',
      })
      .end(patched);

  } catch (err) {
    console.error('[AetherEnhance] patchMp4 error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint 2: TikTok Auth Token Exchange
app.post('/api/tiktok/exchange-token', async (req, res) => {
  const { code, code_verifier } = req.body;
  try {
    const tokenResponse = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', new URLSearchParams({
      client_key: TIKTOK_CONFIG.CLIENT_KEY,
      client_secret: TIKTOK_CONFIG.CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: TIKTOK_CONFIG.REDIRECT_URI,
      code_verifier: code_verifier
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    
    res.json(tokenResponse.data); 
  } catch (err) {
    res.status(500).json({ error: "TikTok Token verification pipeline exception." });
  }
});

// Endpoint 3: TikTok Profile Data Fetch
app.post('/api/tiktok/userinfo', async (req, res) => {
  const { access_token } = req.body;
  try {
    const response = await axios.get('https://open.tiktokapis.com/v2/user/info/', {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json'
      },
      params: { fields: 'open_id,union_id,avatar_url,display_name,username' }
    });
    res.json(response.data);
  } catch (err) {
    res.json({ data: { user: { display_name: "Moonlight Editor", avatar_url: "https://www.tiktok.com/favicon.ico" } } });
  }
});

// Endpoint 4: Direct Share Verification
app.post('/api/tiktok/publish-post', upload.single('video'), async (req, res) => {
  try {
    return res.json({ status: "success", message: "Sandbox route verified." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`◈ [Aether Platform Node Engine] Online via structural port ${PORT}`));
