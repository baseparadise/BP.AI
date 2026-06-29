// web.js
// Server web untuk AI coding assistant — berjalan berdampingan dengan bot.js.
// Pakai lib/ai.js yang sama, sehingga semua provider & fallback sudah otomatis.
//
// AUTH: Password sederhana via env WEB_PASSWORD.
//   - Buka URL → halaman login muncul
//   - Masukkan password → dapat cookie sesi (berlaku 7 hari)
//   - Tanpa cookie valid → semua endpoint 401
//
// Endpoint:
//   GET  /                     → halaman chat (butuh auth)
//   POST /api/login            → cek password, set cookie
//   POST /api/logout           → hapus cookie
//   POST /api/chat             → kirim pesan ke AI (butuh auth)
//   POST /api/upload           → upload file ke session (butuh auth)
//   POST /api/session/clear    → hapus history & file session (butuh auth)
//   GET  /api/session/files    → daftar file aktif (butuh auth)
//   GET  /health               → health check Railway (tanpa auth)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { askGemini, extractCodeBlocks, stripCodeBlocks } = require('./lib/ai');

// Pakai PORT utama Railway agar bisa diakses dari internet.
// start.js yang baru memberi PORT ke web.js, bukan ke bot.js.
const PORT = process.env.PORT || 3000;
const WEB_PASSWORD = process.env.WEB_PASSWORD || '';

if (!WEB_PASSWORD) {
  console.warn('[web] ⚠️  WEB_PASSWORD tidak diset — semua orang bisa login! Set env WEB_PASSWORD di Railway.');
}

// ============================================================
// AUTH TOKEN STORE (in-memory)
// Token dibuat saat login, berlaku 7 hari.
// Tidak perlu database — restart server = semua login ulang.
// ============================================================

const AUTH_COOKIE_NAME = 'bp_auth';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari

const authTokens = new Map(); // token → expiry timestamp

function createToken() {
  const token = crypto.randomBytes(32).toString('hex');
  authTokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

function isValidToken(token) {
  if (!token || !authTokens.has(token)) return false;
  if (Date.now() > authTokens.get(token)) {
    authTokens.delete(token);
    return false;
  }
  return true;
}

function revokeToken(token) {
  authTokens.delete(token);
}

function parseCookies(cookieHeader = '') {
  const result = {};
  cookieHeader.split(';').forEach((part) => {
    const [k, ...v] = part.trim().split('=');
    if (k) result[k.trim()] = decodeURIComponent(v.join('=').trim());
  });
  return result;
}

function getTokenFromReq(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[AUTH_COOKIE_NAME] || null;
}

function isAuthenticated(req) {
  // Cek cookie dulu, lalu header Authorization (untuk akses via script/API)
  const cookieToken = getTokenFromReq(req);
  if (isValidToken(cookieToken)) return true;
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return isValidToken(bearerToken);
}

// Bersihkan token kadaluarsa setiap jam
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of authTokens) {
    if (now > expiry) authTokens.delete(token);
  }
}, 60 * 60 * 1000);

// ============================================================
// SESSION STORE (in-memory)
// File disimpan SEKALI per session → pesan selanjutnya hemat token.
// ============================================================

const sessions = new Map();

setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, sess] of sessions) {
    if (sess.lastActive < cutoff) sessions.delete(id);
  }
}, 30 * 60 * 1000);

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      history: [],
      files: {},
      sentFiles: new Set(),
      createdAt: Date.now(),
      lastActive: Date.now(),
    });
  }
  const sess = sessions.get(sessionId);
  sess.lastActive = Date.now();
  return sess;
}

function makeSessionId() {
  return crypto.randomUUID();
}

// ============================================================
// MULTIPART PARSER (tanpa library eksternal)
// ============================================================

function parseMultipart(body, boundary) {
  const parts = [];
  const sep = Buffer.from('--' + boundary);
  const end = Buffer.from('--' + boundary + '--');
  let start = 0;

  while (start < body.length) {
    const sepIdx = body.indexOf(sep, start);
    if (sepIdx === -1) break;
    const headerStart = sepIdx + sep.length + 2;
    const headerEnd = body.indexOf('\r\n\r\n', headerStart);
    if (headerEnd === -1) break;
    const headers = body.slice(headerStart, headerEnd).toString();
    const dataStart = headerEnd + 4;
    const nextSep = body.indexOf(sep, dataStart);
    if (nextSep === -1) break;
    const dataEnd = nextSep - 2;
    const data = body.slice(dataStart, dataEnd);
    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: filenameMatch ? filenameMatch[1] : null,
      data,
    });
    start = nextSep;
    if (body.indexOf(end, start) === start) break;
  }
  return parts;
}

// ============================================================
// HELPERS
// ============================================================

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(body);
}

function serveHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function serveChatPage(res) {
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
    if (err) { res.writeHead(500); res.end('index.html tidak ditemukan'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}

const MAX_FILE_BYTES = 80 * 1024;
const MAX_FILES_PER_SESSION = 10;

// ============================================================
// LOGIN PAGE HTML (inline agar tidak butuh file tambahan)
// ============================================================

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BP.AI — Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:40px 36px;width:100%;max-width:360px;text-align:center}
.logo{font-size:22px;font-weight:700;color:#58a6ff;margin-bottom:4px}
.sub{font-size:13px;color:#8b949e;margin-bottom:28px}
input{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px 14px;color:#e6edf3;font-size:14px;outline:none;transition:border-color .2s}
input:focus{border-color:#58a6ff}
input::placeholder{color:#8b949e}
button{margin-top:14px;width:100%;background:#1f6feb;border:none;border-radius:8px;padding:10px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s}
button:hover{background:#388bfd}
.err{margin-top:12px;color:#f85149;font-size:13px;min-height:20px}
.lock{font-size:40px;margin-bottom:16px}
</style>
</head>
<body>
<div class="card">
  <div class="lock">🔐</div>
  <div class="logo">BP.AI</div>
  <div class="sub">Coding assistant milik baseparadise</div>
  <input type="password" id="pw" placeholder="Masukkan password" autofocus onkeydown="if(event.key==='Enter')login()"/>
  <button onclick="login()">Masuk</button>
  <div class="err" id="err"></div>
</div>
<script>
async function login(){
  const pw=document.getElementById('pw').value;
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
  const d=await r.json();
  if(r.ok){location.reload();}
  else{document.getElementById('err').textContent=d.error||'Password salah.';}
}
</script>
</body>
</html>`;

// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Session-Id, Authorization',
    });
    res.end();
    return;
  }

  // ── Health check (tanpa auth — Railway butuh ini) ─────────
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { status: 'ok', sessions: sessions.size });
    return;
  }

  // ── POST /api/login ───────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const raw = await readBody(req);
    let payload;
    try { payload = JSON.parse(raw.toString()); } catch { payload = {}; }

    const { password = '' } = payload;

    // Kalau WEB_PASSWORD tidak diset, tolak semua login agar owner tahu.
    if (!WEB_PASSWORD) {
      json(res, 500, { error: 'WEB_PASSWORD belum diset di Railway. Set dulu di Variables.' });
      return;
    }

    // Bandingkan password dengan timing-safe agar tidak rentan timing attack.
    const expected = Buffer.from(WEB_PASSWORD);
    const given = Buffer.from(String(password));
    const match = expected.length === given.length &&
      crypto.timingSafeEqual(expected, given);

    if (!match) {
      json(res, 401, { error: 'Password salah.' });
      return;
    }

    const token = createToken();
    const cookieValue = `${AUTH_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Max-Age=${TOKEN_TTL_MS / 1000}; Path=/`;
    json(res, 200, { ok: true }, { 'Set-Cookie': cookieValue });
    return;
  }

  // ── POST /api/logout ──────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const token = getTokenFromReq(req);
    if (token) revokeToken(token);
    const expired = `${AUTH_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/`;
    json(res, 200, { ok: true }, { 'Set-Cookie': expired });
    return;
  }

  // ── Auth guard: semua route di bawah butuh login ──────────
  if (!isAuthenticated(req)) {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      // Browser request → tampilkan halaman login
      serveHtml(res, LOGIN_PAGE);
    } else {
      // API request → 401 JSON
      json(res, 401, { error: 'Unauthorized. Login dulu.' });
    }
    return;
  }

  // ── GET / ────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/') {
    serveChatPage(res);
    return;
  }

  // ── POST /api/upload ─────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const sessionId = req.headers['x-session-id'] || makeSessionId();
    const sess = getSession(sessionId);
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);

    if (!boundaryMatch) {
      json(res, 400, { error: 'Content-Type multipart/form-data diperlukan.' });
      return;
    }

    const body = await readBody(req);
    const parts = parseMultipart(body, boundaryMatch[1]);
    const uploaded = [];
    const errors = [];

    for (const part of parts) {
      if (!part.filename) continue;
      if (part.data.length > MAX_FILE_BYTES) {
        errors.push(`"${part.filename}" terlalu besar (maks ${MAX_FILE_BYTES / 1024}KB).`);
        continue;
      }
      if (Object.keys(sess.files).length >= MAX_FILES_PER_SESSION) {
        errors.push(`Batas ${MAX_FILES_PER_SESSION} file per sesi tercapai.`);
        break;
      }
      sess.files[part.filename] = part.data.toString('utf-8');
      uploaded.push(part.filename);
    }

    json(res, 200, { sessionId, uploaded, errors, totalFiles: Object.keys(sess.files).length });
    return;
  }

  // ── POST /api/chat ────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const sessionId = req.headers['x-session-id'] || makeSessionId();
    const sess = getSession(sessionId);
    const raw = await readBody(req);

    let payload;
    try { payload = JSON.parse(raw.toString()); }
    catch { json(res, 400, { error: 'Body harus JSON.' }); return; }

    const { message = '', useFiles = true } = payload;
    if (!message.trim() && Object.keys(sess.files).length === 0) {
      json(res, 400, { error: 'Pesan tidak boleh kosong.' });
      return;
    }

    let finalQuestion = message;
    let historyNote = message;
    const fileNames = Object.keys(sess.files);

    if (useFiles && fileNames.length > 0) {
      const newFiles = fileNames.filter((f) => !sess.sentFiles.has(f));
      const knownFiles = fileNames.filter((f) => sess.sentFiles.has(f));

      const parts = [];
      if (message.trim()) parts.push(message);

      for (const fname of newFiles) {
        parts.push(`// === File: ${fname} ===\n${sess.files[fname]}`);
        sess.sentFiles.add(fname);
      }

      if (knownFiles.length > 0) {
        parts.push(`[File yang sudah ada di konteks sesi ini: ${knownFiles.join(', ')}]`);
      }

      if (newFiles.length > 0) {
        finalQuestion = parts.join('\n\n');
        historyNote = `${message || 'cek file'} [File baru: ${newFiles.join(', ')}${knownFiles.length ? `, File lama: ${knownFiles.join(', ')}` : ''}]`;
      } else {
        finalQuestion = [message, `[Konteks file aktif: ${knownFiles.join(', ')}]`].filter(Boolean).join('\n\n');
        historyNote = message;
      }
    }

    try {
      const { text, sources } = await askGemini(finalQuestion, sess.history, true);

      sess.history.push({ role: 'user', content: historyNote });
      sess.history.push({ role: 'assistant', content: text });

      const blocks = extractCodeBlocks ? extractCodeBlocks(text) : [];
      const explanation = stripCodeBlocks ? stripCodeBlocks(text).trim() : text;

      json(res, 200, {
        sessionId,
        text,
        explanation,
        blocks: blocks.map((b) => ({ lang: b.lang, code: b.code, filename: null })),
        sources,
        filesInContext: fileNames,
      });
    } catch (err) {
      console.error('[web] /api/chat error:', err.message);
      json(res, 500, { error: err.message || 'AI gagal merespons.' });
    }
    return;
  }

  // ── POST /api/session/clear ───────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/session/clear') {
    const sessionId = req.headers['x-session-id'];
    if (sessionId && sessions.has(sessionId)) sessions.delete(sessionId);
    json(res, 200, { cleared: true });
    return;
  }

  // ── GET /api/session/files ────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/session/files') {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId || !sessions.has(sessionId)) {
      json(res, 200, { files: [] });
      return;
    }
    const sess = getSession(sessionId);
    json(res, 200, {
      files: Object.keys(sess.files).map((name) => ({
        name,
        size: Buffer.byteLength(sess.files[name], 'utf-8'),
        inContext: sess.sentFiles.has(name),
      })),
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[web] Server jalan di port ${PORT}`);
});

module.exports = server;
