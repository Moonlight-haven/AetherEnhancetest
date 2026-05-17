const express = require('express');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Allocating memory stream thresholds for rendering raw master edits up to 500MB
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 } 
});

// ── CONFIGURATION VARIABLES ──
const TIKTOK_CONFIG = {
  CLIENT_KEY: "sbawsb9lzwltcl6uv2",       // Your Real Client Key
  CLIENT_SECRET: "ZV5b0rEtRT4Cmjrv0Tnc8MHdTAWyyduV",   // Your Real Client Secret
  REDIRECT_URI: "http://localhost:3000/callback"        // Must match TikTok Dev Portal exactly
};

// ── BINARY BITSTREAM MANIPULATION UTILITIES ──
function writeU32(buf, off, v) { buf.writeUInt32BE(v >>> 0, off); }
function writeU64(buf, off, v) {
  const big = typeof v === 'bigint' ? v : BigInt(v);
  buf.writeUInt32BE(Number((big >> 32n) & 0xFFFFFFFFn), off);
  buf.writeUInt32BE(Number(big & 0xFFFFFFFFn), off + 4);
}
function readMvhd(buf, box) {
  const v = buf[box.contentStart];
  let tsOff = box.contentStart + 12, durOff = box.contentStart + 16, durBytes = 4;
  if (v === 1) { tsOff = box.contentStart + 20; durOff = box.contentStart + 24; durBytes = 8; }
  const timescale = buf.readUInt32BE(tsOff);
  let duration = durBytes === 4 ? buf.readUInt32BE(durOff) : BigInt(buf.readUInt32BE(durOff)) * 0x100000000n + BigInt(buf.readUInt32BE(durOff + 4));
  return { timescale, timescaleOffset: tsOff, duration, durationOffset: durOff, durationBytes };
}
function readMdhd(buf, box) {
  const v = buf[box.contentStart];
  let tsOff = box.contentStart + 12;
  if (v === 1) tsOff = box.contentStart + 20;
  return { timescale: buf.readUInt32BE(tsOff), timescaleOffset: tsOff };
}
function* walkBoxes(buf, start, end) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    let hdrLen = 8;
    if (size === 1) { size = Number(BigInt(buf.readUInt32BE(off + 8)) * 0x100000000n + BigInt(buf.readUInt32BE(off + 12))); hdrLen = 16; }
    if (size === 0) break;
    yield { type, start: off, contentStart: off + hdrLen, contentEnd: off + size };
    off += size;
  }
}
function findBoxes(buf, type, start, end) {
  const res = []; for (const b of walkBoxes(buf, start, end)) { if (b.type === type) res.push(b); } return res;
}
function findChild(buf, parent, type) {
  for (const b of walkBoxes(buf, parent.contentStart, parent.contentEnd)) { if (b.type === type) return b; } return null;
}

function detectVideoFps(buf) {
  try {
    const moovs = findBoxes(buf, 'moov', 0, buf.length);
    for (const moov of moovs) {
      for (const box of walkBoxes(buf, moov.contentStart, moov.contentEnd)) {
        if (box.type !== 'trak') continue;
        const mdia = findChild(buf, box, 'mdia'); if (!mdia) continue;
        const mdhd = findChild(buf, mdia, 'mdhd'); if (!mdhd) continue;
        const minf = findChild(buf, mdia, 'minf'); if (!minf) continue;
        const stbl = findChild(buf, minf, 'stbl'); if (!stbl) continue;
        const stts = findChild(buf, stbl, 'stts'); if (!stts) continue;
        const m = readMdhd(buf, mdhd);
        const sttsCount = buf.readUInt32BE(stts.contentStart + 4);
        if (sttsCount > 0) {
          const sampleDelta = buf.readUInt32BE(stts.contentStart + 12);
          if (sampleDelta > 0 && m.timescale > 0) {
            const calculatedFps = Math.round(m.timescale / sampleDelta);
            if (calculatedFps > 10 && calculatedFps < 240) return calculatedFps;
          }
        }
      }
    }
  } catch (e) {}
  return 60; 
}

// ── OAUTH CALLBACK REDIRECT REDIRECT ROUTE ──
app.get('/callback', (req, res) => {
  const { code } = req.query;
  console.log(`[TikTok Login Auth] Callback received code verification parameter.`);
  if (!code) return res.send("<h2 style='color:#fe2c55; text-align:center;'>Authentication cancelled or missing authorization code parameter.</h2>");
  
  res.send(`
    <html>
      <body style="background:#050505;color:#fff;font-family:sans-serif;text-align:center;padding-top:100px;">
        <h2 style="color:#20d5ec;">Aether Authentication Code Intercepted!</h2>
        <p>Syncing security tokens back to your active studio dashboard window...</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'TIKTOK_AUTH_CODE', code: '${code}' }, '*');
            window.close();
          } else {
            document.body.innerHTML = "<h2>Communication lost with studio window. Please return to your original tab.</h2>";
          }
        </script>
      </body>
    </html>
  `);
});

// ── ENDPOINT 1: QUALITY BYPASS LAYER ──
app.post('/api/optimize-video', upload.single('video'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing file payload." });
    console.log(`[Patcher Engine] Optimizing: ${req.file.originalname}`);
    const buf = req.file.buffer;
    const fps = detectVideoFps(buf);
    let divider = fps >= 100 ? 4 : (fps >= 50 ? 2 : 1);

    if (divider > 1) {
      const moovs = findBoxes(buf, 'moov', 0, buf.length);
      const div = Math.round(divider);
      for (const moov of moovs) {
        const mvhd = findChild(buf, moov, 'mvhd');
        if (mvhd) {
          const m = readMvhd(buf, mvhd);
          writeU32(buf, m.timescaleOffset, Math.max(1, Math.floor(m.timescale / div)));
          if (m.durationBytes === 4) writeU32(buf, m.durationOffset, Math.floor(m.duration / div));
        }
        for (const box of walkBoxes(buf, moov.contentStart, moov.contentEnd)) {
          if (box.type !== 'trak') continue;
          const mdia = findChild(buf, box, 'mdia'); if (!mdia) continue;
          const mdhd = findChild(buf, mdia, 'mdhd'); if (!mdhd) continue;
          const m = readMdhd(buf, mdhd);
          writeU32(buf, m.timescaleOffset, Math.max(1, Math.floor(m.timescale / div)));
        }
      }
    }
    console.log(`[Patcher Engine] Frame Rate structural bypass logic applied successfully.`);
    res.setHeader('Content-Type', 'video/mp4');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: "Patcher operational exception error." }); }
});

// ── ENDPOINT 2: SECURE USER HANDSHAKE (WITH FIXED VERIFIER REQUIREMENT) ──
app.post('/api/tiktok/exchange-token', async (req, res) => {
  const { code, code_verifier } = req.body;
  console.log(`[Secure Handshake] Exchanging code and verifier for Access Token...`);
  try {
    const tokenResponse = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', new URLSearchParams({
      client_key: TIKTOK_CONFIG.CLIENT_KEY,
      client_secret: TIKTOK_CONFIG.CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: TIKTOK_CONFIG.REDIRECT_URI,
      code_verifier: code_verifier // Handing original verification text securely to TikTok validation node
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    
    console.log(`[Secure Handshake] Access Token successfully generated and sent to frontend.`);
    res.json(tokenResponse.data); 
  } catch (err) {
    console.error("Token exchange failed:", err.response ? err.response.data : err.message);
    res.status(500).json({ error: "TikTok Authentication Token verification dropped." });
  }
});

// ── ENDPOINT 3: DEBOUNCED @ CREATOR MENTION SEARCH PROXY ──
app.post('/api/tiktok/search-creator', async (req, res) => {
  const { access_token, query } = req.body;
  console.log(`[Mention Search] Query matching keyword: @${query}`);
  try {
    const searchResponse = await axios.post('https://open.tiktokapis.com/v2/data/creator/search', {
      keyword: query,
      cursor: 0,
      max_count: 5
    }, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json'
      }
    });
    res.json(searchResponse.data);
  } catch (err) { res.json({ creators: [] }); }
});

// ── ENDPOINT 4: HIGH RESOLUTION DIRECT MULTIPART VIDEO POST ENGINE ──
app.post('/api/tiktok/publish-post', upload.single('video'), async (req, res) => {
  const { access_token, caption, privacy_level, disable_comment, disable_duet, disable_stitch } = req.body;
  console.log(`[Publish Pipeline] Initializing direct multipart file upload track...`);
  
  try {
    if (!req.file) return res.status(400).json({ error: "Missing video file asset packet." });

    const initResponse = await axios.post('https://open.tiktokapis.com/v2/post/publish/video/init', {
      post_info: {
        title: caption,
        privacy_level: privacy_level || "PUBLIC_TO_EVERYONE",
        disable_comment: disable_comment === 'true',
        disable_duet: disable_duet === 'true',
        disable_stitch: disable_stitch === 'true',
        video_cover_timestamp_ms: 0
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: req.file.buffer.length,
        chunk_size: req.file.buffer.length,
        total_chunk_count: 1
      }
    }, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json; charset=utf-8'
      }
    });

    const { upload_url } = initResponse.data.data;
    console.log(`[Publish Pipeline] Stream session verified. Piping uncompressed binary buffers...`);

    await axios.put(upload_url, req.file.buffer, {
      headers: {
        'Content-Range': `bytes 0-${req.file.buffer.length - 1}/${req.file.buffer.length}`,
        'Content-Type': 'video/mp4'
      }
    });

    console.log(`[Publish Pipeline] Direct streaming completed successfully.`);
    res.json({ success: true, message: "Asset indexed. Video pushed live cleanly to TikTok!" });

  } catch (err) {
    console.error("Direct publish stream halted:", err.response ? err.response.data : err.message);
    res.status(500).json({ error: "TikTok Publishing session integration dropped." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Aether Platform Node Engine] Online via structural port ${PORT}`));