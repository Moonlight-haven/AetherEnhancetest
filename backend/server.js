'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const dotenv = require('dotenv');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

dotenv.config();

const app = express();

// Enable global CORS for your custom domain and GitHub pages layout
app.use(cors({ origin: '*' }));
app.use(express.json());

// Ensure local uploads directory exists cleanly on start
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ─── Multer Configuration – Disk-backed Engine ───────────────────────────────
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB Master headroom limit
});

// Dynamic configuration matching your variables environment
const TIKTOK_CONFIG = {
  CLIENT_KEY: process.env.TIKTOK_CLIENT_KEY || "sbawsb9lzwltcl6uv2",
  CLIENT_SECRET: process.env.TIKTOK_CLIENT_SECRET || "",
  REDIRECT_URI: process.env.REDIRECT_URI || "https://moonlight-haven.github.io/AetherEnhancetest/studio.html"
};

// ─── Storage Cleanup Helper ────────────────────────────────────────────────
function safeUnlink(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error(`[AetherEnhance] Storage cleanup failed for ${filePath}:`, err.message);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PRODUCTION ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// PATH A: Restored Legacy Flow – Process and Download Back to PC
app.post('/api/optimize-video', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  const inputPath = req.file.path;
  const outputPath = path.join(UPLOADS_DIR, `aetherenhance_${req.file.filename}.mp4`);

  console.log(`[Legacy Flow] Optimizing file for local PC return: ${req.file.originalname}`);

  ffmpeg(inputPath)
    .videoCodec('libx264')
    .outputOptions([
      '-profile:v high',
      '-level:v 4.2',
      '-pix_fmt yuv420p',
      '-crf 18',
      '-g 30',
      '-movflags +faststart'
    ])
    .audioCodec('copy')
    .format('mp4')
    .output(outputPath)
    .on('error', (err, _stdout, stderr) => {
      console.error('[FFmpeg Error]:', err.message);
      safeUnlink(inputPath);
      safeUnlink(outputPath);
      if (!res.headersSent) res.status(500).json({ error: 'FFmpeg optimization failed.' });
    })
    .on('end', () => {
      const outputName = `aetherenhance_${req.file.originalname || 'output.mp4'}`;
      res.download(outputPath, outputName, (downloadErr) => {
        safeUnlink(inputPath);
        safeUnlink(outputPath);
      });
    })
    .run();
});

// PATH B: The Direct Bypass Flow – Optimize and Upload Straight to TikTok API
app.post('/api/tiktok/publish-post', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video payload provided.' });
  }

  const accessToken = req.headers.authorization?.split(' ')[1] || req.body.access_token;
  if (!accessToken) {
    safeUnlink(req.file.path);
    return res.status(401).json({ error: 'Missing active TikTok OAuth Access Token.' });
  }

  const inputPath = req.file.path;
  const optimizedPath = path.join(UPLOADS_DIR, `publish_opt_${req.file.filename}.mp4`);

  try {
    console.log('[Bypass Flow] Step 1: Executing live FFmpeg optimization pass on cloud server...');

    // Run optimization directly inside the publishing pipeline
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoCodec('libx264')
        .outputOptions(['-profile:v high', '-level:v 4.2', '-pix_fmt yuv420p', '-crf 18', '-g 30', '-movflags +faststart'])
        .audioCodec('copy')
        .format('mp4')
        .output(optimizedPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });

    const optimizedStats = fs.statSync(optimizedPath);
    console.log('[Bypass Flow] Step 2: Requesting upload URL initialization handshake from TikTok...');

    const initResponse = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      { source: 'FILE_UPLOAD', video_size: optimizedStats.size },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8'
        }
      }
    );

    const uploadUrl = initResponse.data?.data?.upload_url;
    const publishId = initResponse.data?.data?.publish_id;

    if (!uploadUrl) {
      throw new Error(`Initialization failed: ${JSON.stringify(initResponse.data)}`);
    }

    console.log('[Bypass Flow] Step 3: Streaming high-fidelity optimized binary to TikTok servers...');
    const videoStream = fs.createReadStream(optimizedPath);
    
    await axios.put(uploadUrl, videoStream, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': optimizedStats.size
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    console.log(`[Success] Video published successfully via API loop! ID: ${publishId}`);

    // Storage cleanup
    safeUnlink(inputPath);
    safeUnlink(optimizedPath);

    return res.json({ status: 'success', message: 'Video posted directly via cloud bypass layer.', publish_id: publishId });

  } catch (err) {
    console.error('[Publish Pipeline Exception]:', err.response?.data || err.message);
    safeUnlink(inputPath);
    safeUnlink(optimizedPath);
    return res.status(500).json({ error: 'Direct API publishing pipeline failed.', detail: err.response?.data || err.message });
  }
});

// TikTok OAuth Token Exchange Endpoint
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
    res.status(500).json({ error: "Token verification pipeline exception.", detail: err.response?.data || err.message });
  }
});

// TikTok Profile Data Fetch Endpoint
app.post('/api/tiktok/userinfo', async (req, res) => {
  const { access_token } = req.body;
  try {
    const response = await axios.get('https://open.tiktokapis.com/v2/user/info/', {
      headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      params: { fields: 'open_id,union_id,avatar_url,display_name,username' }
    });
    res.json(response.data);
  } catch (err) {
    res.json({ data: { user: { display_name: "Moonlight Editor", avatar_url: "https://www.tiktok.com/favicon.ico" } } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`◈ [Aether Platform Engine] Online via cloud port ${PORT}`));
