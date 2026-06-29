// bot.js
// Bot Discord ALWAYS-ON (Gateway/WebSocket) — merespons saat di-tag/mention,
// tanpa perlu slash command. Jalankan dengan: `node bot.js`.
//
// PENTING: Bot ini HARUS di-host di tempat always-on (Railway, Fly.io, VPS, Render, dll),
// BUKAN di Vercel Serverless — karena koneksi Gateway perlu proses hidup terus.
//
// Wajib aktifkan "MESSAGE CONTENT INTENT" di Discord Developer Portal:
//   Applications -> (bot kamu) -> Bot -> Privileged Gateway Intents -> Message Content Intent.

const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { Client, GatewayIntentBits, Partials, AttachmentBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { handleChartCommand } = require('./lib/chartAnalysis');
const {
  isImageRequest,
  askGemini,
  generateImage,
  formatAnswer,
  friendlyError,
  extractCodeBlocks,
  stripCodeBlocks,
  EXT_MAP,
  getDefaultBranch,
  getGitHubFileContent,
  commitGitHubFile,
} = require('./lib/ai');
const { isScamAnalysisRequest, runScamAnalysis } = require('./lib/tokenScamAnalysis');

// ============================================================
// KONFIGURASI
// ============================================================

const OWNER_ID = '1292088584429637707';


const MAX_FILES_DM    = 10;
const MAX_FILES_CH    = 3;

// Batas ukuran file per-attachment (60 KB).
const MAX_FILE_BYTES = 60 * 1024;

// Batas total ukuran semua file dalam satu pesan yang dikirim ke AI.
// Jika melebihi ini, file akan diproses satu per satu agar tidak melebihi context window.
// [FIX] Turunkan threshold untuk mencegah AI truncate karena kelebihan token.
const MAX_TOTAL_BYTES_COMBINED = 30 * 1024; // 30KB total sebelum split satu-per-satu

// Discord membatasi maks 10 file per reply.
const DISCORD_MAX_FILES = 10;

// Pola yang mengindikasikan AI memberikan respons palsu/hallusinasi.
// [FIX BARU] Deteksi konten yang tidak berguna agar bisa di-retry.
const HALLUCINATION_PATTERNS = [
  /https?:\/\/github\.com\/your[-_]?repo/i,
  /github\.com\/your[-_]?project/i,
  /\byour[-_]?repo\b/i,
  /\[nama[-_ ]?repo\]/i,
  /silakan\s+kunjungi\s+tautan/i,
  /karena\s+keterbatasan\s+platform/i,
  /saya\s+tidak\s+dapat\s+mengirim\s+file/i,
  /saya\s+tidak\s+bisa\s+mengirim\s+file/i,
];

const HISTORY_FILE = path.join(require('os').tmpdir(), 'bp_ai_history.json');

// ============================================================
// MANAJEMEN RIWAYAT
// ============================================================

// Sliding window: simpan N pasang terakhir, tidak hapus semua.
// Discord dipakai sebagai "database" — bootstrap dari channel saat restart.
const MAX_HISTORY_LEN_DM      = 20;  // 10 turn untuk DM owner
const MAX_HISTORY_LEN_CHANNEL = 6;   // 3 turn untuk channel
const MAX_MSG_CHARS           = 500; // potong pesan sangat panjang agar hemat token

function truncateContent(text) {
  if (!text) return '';
  return text.length > MAX_MSG_CHARS ? text.slice(0, MAX_MSG_CHARS) + '…' : text;
}

let allHistory = {};
try {
  if (fs.existsSync(HISTORY_FILE)) {
    allHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    console.log(`[bot] Riwayat dimuat: ${Object.keys(allHistory).length} sesi dari ${HISTORY_FILE}`);
  }
} catch (e) {
  console.error('[bot] Gagal memuat riwayat, mulai dari kosong:', e.message);
  allHistory = {};
}

function saveHistory() {
  fs.writeFile(HISTORY_FILE, JSON.stringify(allHistory, null, 2), 'utf-8', (err) => {
    if (err) console.error('[bot] Gagal menyimpan riwayat:', err.message);
  });
}

function getHistory(key) {
  if (!allHistory[key]) allHistory[key] = [];
  return allHistory[key];
}

function clearHistory(key) {
  delete allHistory[key];
  delete allHistory[key + '__summary'];
  saveHistory();
}

// Summary disimpan di allHistory dengan suffix '__summary'
function getSummary(key) { return allHistory[key + '__summary'] || null; }
function setSummary(key, text) {
  if (text) allHistory[key + '__summary'] = text.replace(/\n+/g, ' ').trim().slice(0, 300);
  else delete allHistory[key + '__summary'];
  saveHistory();
}

async function summarizeDropped(key, dropped) {
  const existing = getSummary(key);
  const parts = [];
  if (existing) parts.push(`Ringkasan sebelumnya: ${existing}`);
  parts.push(...dropped.map(t => `${t.role === 'user' ? 'User' : 'AI'}: ${t.content}`));
  const convo = parts.join('\n');
  const prompt = `Buat ringkasan singkat (1-2 kalimat, bahasa yang sama dengan percakapan) untuk dijadikan konteks AI:\n\n${convo}`;
  try {
    const { text } = await askGemini(prompt, [], false);
    return text;
  } catch {
    return existing; // fallback ke summary lama jika gagal
  }
}

async function pushHistory(key, historyUserContent, assistantText, isDMOwner) {
  const history = getHistory(key);
  history.push({ role: 'user', content: truncateContent(historyUserContent) });
  history.push({ role: 'assistant', content: truncateContent(assistantText) });

  const maxLen = isDMOwner ? MAX_HISTORY_LEN_DM : MAX_HISTORY_LEN_CHANNEL;
  if (history.length > maxLen) {
    const dropped = history.splice(0, history.length - maxLen);
    const newSummary = await summarizeDropped(key, dropped);
    setSummary(key, newSummary);
  }

  saveHistory();
}

function getHistoryForAI(key, isDMOwner) {
  const history = getHistory(key);
  const maxLen = isDMOwner ? MAX_HISTORY_LEN_DM : MAX_HISTORY_LEN_CHANNEL;
  const recent = history.slice(-maxLen);
  const summary = getSummary(key);
  if (summary) {
    return [
      { role: 'user', content: `[Ringkasan percakapan sebelumnya: ${summary}]` },
      { role: 'assistant', content: 'Baik, saya sudah memahami konteks tersebut.' },
      ...recent,
    ];
  }
  return recent;
}

// Bootstrap: muat ulang konteks dari Discord saat restart
// sehingga history tidak hilang meski /tmp terhapus.
const bootstrappedChannels = new Set();

async function bootstrapHistory(key, channel, isDMOwner) {
  if (bootstrappedChannels.has(key)) return;
  bootstrappedChannels.add(key);
  if (allHistory[key] && allHistory[key].length > 0) return; // sudah ada dari file

  try {
    const botId = channel.client?.user?.id;
    const fetched = await channel.messages.fetch({ limit: 30 });
    const msgs = [...fetched.values()]
      .filter(m => m.content && m.content.trim().length > 2)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const history = getHistory(key);
    for (const msg of msgs) {
      const isBot = msg.author.id === botId;
      // Bersihkan mention dari pesan
      const content = msg.content.replace(/<@!?\d+>/g, '').trim();
      if (!content) continue;
      history.push({ role: isBot ? 'assistant' : 'user', content: truncateContent(content) });
    }
    const maxLen = isDMOwner ? MAX_HISTORY_LEN_DM : MAX_HISTORY_LEN_CHANNEL;
    while (history.length > maxLen) history.splice(0, 2);
    console.log(`[bot] bootstrap ${key}: ${history.length} pesan dimuat dari Discord`);
  } catch (e) {
    console.warn(`[bot] bootstrap gagal ${key}:`, e.message);
  }
}

// ============================================================
// EKSTENSI FILE YANG DIDUKUNG
// ============================================================

const TEXT_FILE_EXTENSIONS = [
  'js', 'ts', 'jsx', 'tsx', 'html', 'htm', 'css', 'scss',
  'json', 'jsonc', 'py', 'sh', 'bash', 'sql', 'yaml', 'yml',
  'md', 'mdx', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'php',
  'sol', 'txt', 'env', 'xml', 'csv', 'toml', 'ini', 'conf',
  'vue', 'svelte', 'kt', 'swift', 'rb', 'lua', 'r', 'dart',
];

// ============================================================
// HEALTH SERVER
// ============================================================

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running');
}).listen(port, () => console.log(`[bot] Health server di port ${port}`));

// ============================================================
// DISCORD CLIENT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  // Partials.Message + Partials.Interaction wajib agar interactionCreate
  // tetap terpicu pada pesan yang belum di-cache (termasuk tombol di guild channel).
  partials: [Partials.Channel, Partials.Message, Partials.Interaction],
});

// discord.js v14+: gunakan 'clientReady' bukan 'ready' (ready sudah deprecated).
client.once('clientReady', () => {
  console.log(`[bot] ===== v2025-06-28-INTERACTION-FIX =====`);
  console.log(`[bot] Login sebagai ${client.user.tag}`);
  console.log(`[bot] Partials: ${JSON.stringify(client.options.partials)}`);
  console.log(`[bot] interactionCreate listener count: ${client.listenerCount('interactionCreate')}`);
});
client.on('error', (err) => console.error('[bot] Client error:', err));
process.on('unhandledRejection', (err) => console.error('[bot] Unhandled rejection:', err));

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function getExt(filename = '') {
  const m = filename.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}

function makeFile(content, filename) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
  return new AttachmentBuilder(buffer, { name: filename });
}

async function downloadAttachmentText(attachment) {
  if (attachment.size > MAX_FILE_BYTES) {
    throw new Error(`"${attachment.name}" terlalu besar (${Math.round(attachment.size / 1024)}KB, maks ${MAX_FILE_BYTES / 1024}KB).`);
  }
  const { data } = await axios.get(attachment.url, { responseType: 'text', timeout: 15000 });
  return String(data);
}

// [FIX BARU] Deteksi apakah respons AI mengandung hallusinasi/konten palsu.
function containsHallucination(text) {
  return HALLUCINATION_PATTERNS.some((pattern) => pattern.test(text));
}

// [FIX BARU] Validasi code block — pastikan isinya cukup panjang dan bukan placeholder.
// Minimum 50 karakter — code yang valid pasti lebih panjang dari itu.
function isValidCodeBlock(code) {
  if (!code || code.trim().length < 50) return false;
  const lower = code.toLowerCase();
  // Deteksi placeholder yang biasa AI gunakan saat truncate
  const placeholders = ['// ...', '/* ... */', '// kode selanjutnya', '// rest of', '...omitted', '// tambahkan sisanya'];
  const placeholderCount = placeholders.filter((p) => lower.includes(p)).length;
  // Boleh ada 1 placeholder (komentar biasa), tapi lebih dari 1 curiga truncated
  if (placeholderCount > 1) return false;
  return true;
}

function shouldSendAsFile(question, blocks, isDMOwner) {
  if (!blocks.length) return false;
  if (blocks.length > 1) return true;
  const totalLen = blocks.reduce((n, b) => n + b.code.length, 0);
  if (isDMOwner && totalLen > 80) return true;
  if (totalLen > 500) return true;
  return /\b(file|\.js|\.html|\.py|\.css|\.json|kirim\s*file|sebagai\s*file|buatkan\s*(file|website|web|halaman|program|script))\b/i.test(question);
}

// Kirim jawaban sebagai file attachment.
// [FIX] Validasi setiap code block sebelum dijadikan file — skip block yang kosong/placeholder.
async function replyWithFiles(message, text, blocks, originalFileNames = []) {
  // Filter block yang tidak valid sebelum dijadikan file
  const validBlocks = blocks.filter((b) => isValidCodeBlock(b.code));

  if (validBlocks.length === 0) {
    // Tidak ada block valid — kirim sebagai teks biasa
    const explanation = stripCodeBlocks(text);
    await message.reply({
      content: (explanation || '⚠️ AI tidak menghasilkan kode yang valid. Coba kirim ulang dengan instruksi lebih spesifik.').slice(0, 2000),
      flags: MessageFlags.SuppressEmbeds,
    });
    return;
  }

  const cappedBlocks = validBlocks.slice(0, DISCORD_MAX_FILES);

  const files = cappedBlocks.map((b, i) => {
    if (originalFileNames.length === 1 && cappedBlocks.length === 1) {
      return makeFile(b.code, originalFileNames[0]);
    }
    if (originalFileNames[i]) {
      return makeFile(b.code, originalFileNames[i]);
    }
    const ext = EXT_MAP[b.lang] || (TEXT_FILE_EXTENSIONS.includes(b.lang) ? b.lang : 'txt');
    const filename = cappedBlocks.length > 1 ? `file_${i + 1}.${ext}` : `output.${ext}`;
    return makeFile(b.code, filename);
  });

  const explanation = stripCodeBlocks(text);
  const truncatedNote = blocks.length > DISCORD_MAX_FILES
    ? `\n\n⚠️ Hanya ${DISCORD_MAX_FILES} file pertama yang dikirim (Discord membatasi maks ${DISCORD_MAX_FILES} file per pesan).`
    : '';

  // [FIX] Tambah info jumlah file yang berhasil divalidasi
  const skippedNote = (blocks.length - validBlocks.length) > 0
    ? `\n⚠️ ${blocks.length - validBlocks.length} code block dilewati karena isinya tidak lengkap.`
    : '';

  await message.reply({
    content: ((explanation || '📎 Ini hasilnya, dikirim sebagai file.') + truncatedNote + skippedNote).slice(0, 2000),
    files,
    flags: MessageFlags.SuppressEmbeds,
  });
}


// ============================================================
// SPLIT PESAN PANJANG — Discord maks 2000 karakter per pesan
// Otomatis pecah jawaban panjang jadi beberapa pesan tanpa memotong di tengah kalimat.
// ============================================================

const DISCORD_MAX_CHARS = 1990;

function splitMessage(text, maxLen = DISCORD_MAX_CHARS) {
  if (!text || text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > maxLen) {
    let splitAt = -1;

    // 1. Pecah di paragraf (baris kosong)
    const paraIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (paraIdx > maxLen * 0.4) splitAt = paraIdx + 2;

    // 2. Pecah di baris baru tunggal
    if (splitAt < 0) {
      const nlIdx = remaining.lastIndexOf('\n', maxLen);
      if (nlIdx > maxLen * 0.4) splitAt = nlIdx + 1;
    }

    // 3. Pecah di akhir kalimat (. ! ?)
    if (splitAt < 0) {
      const sentMatch = remaining.slice(0, maxLen).match(/^[\s\S]*[.!?](?=\s)/);
      if (sentMatch && sentMatch[0].length > maxLen * 0.4) splitAt = sentMatch[0].length;
    }

    // 4. Pecah di spasi
    if (splitAt < 0) {
      const spaceIdx = remaining.lastIndexOf(' ', maxLen);
      if (spaceIdx > maxLen * 0.3) splitAt = spaceIdx + 1;
    }

    // 5. Fallback: potong paksa
    if (splitAt < 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks.filter(c => c.length > 0);
}

async function sendLongReply(message, text, flags = MessageFlags.SuppressEmbeds) {
  // HARD CAP: max 2 pesan Discord = 3900 karakter
  var MAX_REPLY = 3900;
  var safe = text;
  if (safe.length > MAX_REPLY) {
    var cut = safe.lastIndexOf('\n', MAX_REPLY - 1);
    safe = safe.slice(0, cut > 2000 ? cut : MAX_REPLY - 1) + '\n…';
  }
  // 1960 agar prefix "*(lanjutan X/Y)*\n" tidak dorong total > 2000
  const chunks = splitMessage(safe, 1960);
  if (chunks.length === 0) return;

  await message.reply({ content: chunks[0].slice(0, 2000), flags });

  for (let i = 1; i < chunks.length; i++) {
    await new Promise(r => setTimeout(r, 300));
    const prefix = '*(lanjutan ' + (i + 1) + '/' + chunks.length + ')*\n';
    const body = chunks[i].slice(0, 2000 - prefix.length);
    await message.channel.send({ content: prefix + body, flags });
  }
}

// ============================================================
// CRYPTO CONVERSION -- menggunakan CoinGecko API
// Contoh: "5 usdc to idr" --> "5 $USDC ke IDR = Rp 82.500"
// ============================================================
const COIN_ID_MAP = {
  btc: 'bitcoin', bitcoin: 'bitcoin',
  eth: 'ethereum', ethereum: 'ethereum',
  usdc: 'usd-coin',
  usdt: 'tether', tether: 'tether',
  bnb: 'binancecoin',
  sol: 'solana', solana: 'solana',
  xrp: 'ripple', ripple: 'ripple',
  ada: 'cardano', cardano: 'cardano',
  doge: 'dogecoin', dogecoin: 'dogecoin',
  dot: 'polkadot', polkadot: 'polkadot',
  avax: 'avalanche-2', avalanche: 'avalanche-2',
  matic: 'matic-network', polygon: 'matic-network',
  link: 'chainlink', chainlink: 'chainlink',
  ltc: 'litecoin', litecoin: 'litecoin',
  shib: 'shiba-inu', shiba: 'shiba-inu',
  uni: 'uniswap', uniswap: 'uniswap',
  atom: 'cosmos', cosmos: 'cosmos',
  near: 'near',
  apt: 'aptos', aptos: 'aptos',
  arb: 'arbitrum', arbitrum: 'arbitrum',
  op: 'optimism', optimism: 'optimism',
  inj: 'injective-protocol', injective: 'injective-protocol',
  sui: 'sui',
  ton: 'the-open-network',
  pepe: 'pepe',
  trx: 'tron', tron: 'tron',
  xlm: 'stellar', stellar: 'stellar',
  icp: 'internet-computer',
  fil: 'filecoin', filecoin: 'filecoin',
  sand: 'the-sandbox',
  axs: 'axie-infinity',
};

// vs_currencies yang didukung CoinGecko sebagai target
const SUPPORTED_VS = new Set([
  'idr','usd','eur','gbp','jpy','krw','cny','sgd','aud','myr',
  'thb','php','inr','vnd','brl','try','rub','cad','chf','hkd',
  'btc','eth','bnb','sats',
]);

// Cache dinamis untuk token yang tidak ada di COIN_ID_MAP
const dynamicCoinIdCache = {};
// Cache harga USD dari DexScreener untuk token micro-cap
const dynamicDexCache = {};

// Cari harga USD token dari DexScreener (fallback saat CoinGecko tidak kenal token)
async function resolveDexPrice(symbol) {
  const lower = symbol.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(dynamicDexCache, lower)) return dynamicDexCache[lower];
  try {
    const resp = await axios.get('https://api.dexscreener.com/latest/dex/search', {
      params: { q: symbol }, timeout: 7000
    });
    const pairs = ((resp.data && resp.data.pairs) || [])
      .filter(function(p) {
        return p.baseToken && p.baseToken.symbol &&
               p.baseToken.symbol.toLowerCase() === lower && p.priceUsd;
      })
      .sort(function(a, b) {
        return ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0);
      });
    const best = pairs[0] || null;
    if (best) {
      const price = parseFloat(best.priceUsd);
      const quoteSym = (best.quoteToken && best.quoteToken.symbol) ? best.quoteToken.symbol : '?';
      dynamicDexCache[lower] = {
        priceUsd: price,
        pair: best.baseToken.symbol + '/' + quoteSym,
        dex: best.dexId || 'dex',
        chain: best.chainId || 'chain'
      };
      console.log('[dex] Found ' + symbol.toUpperCase() + ' via DexScreener: USD ' + price +
        ' (' + (best.dexId || '') + '/' + (best.chainId || '') + ')');
    } else {
      dynamicDexCache[lower] = null;
      console.log('[dex] ' + symbol.toUpperCase() + ' tidak ditemukan di DexScreener');
    }
    return dynamicDexCache[lower];
  } catch (e) {
    console.warn('[dex] resolveDexPrice gagal untuk "' + symbol + '":', e.message);
    dynamicDexCache[lower] = null;
    return null;
  }
}

// Resolusi coin ID: hardcoded map -> cache -> CoinGecko /search
async function resolveCoinId(symbol) {
  const lower = symbol.toLowerCase();
  if (COIN_ID_MAP[lower]) return COIN_ID_MAP[lower];
  if (Object.prototype.hasOwnProperty.call(dynamicCoinIdCache, lower)) return dynamicCoinIdCache[lower];
  try {
    const cgKey = process.env.COINGECKO_API_KEY || '';
    const headers = { Accept: 'application/json' };
    if (cgKey) headers['x-cg-demo-api-key'] = cgKey;
    const resp = await axios.get(
      'https://api.coingecko.com/api/v3/search?query=' + encodeURIComponent(lower),
      { headers: headers, timeout: 6000 }
    );
    const coins = (resp.data && resp.data.coins) ? resp.data.coins : [];
    const exact = coins.find(function(c) { return c.symbol.toLowerCase() === lower; });
    const match = exact || coins[0] || null;
    dynamicCoinIdCache[lower] = match ? match.id : null;
    if (match) console.log('[crypto] Found: ' + symbol + ' -> ' + match.id + ' (' + match.name + ')');
    else console.log('[crypto] Tidak ditemukan di CoinGecko: ' + symbol.toUpperCase());
    return dynamicCoinIdCache[lower];
  } catch (e) {
    console.warn('[crypto] resolveCoinId gagal untuk "' + symbol + '":', e.message);
    dynamicCoinIdCache[lower] = null;
    return null;
  }
}

function formatCryptoAmount(amount, currency) {
  var cur = currency.toLowerCase();
  if (cur === 'btc' || cur === 'sats') {
    return amount.toFixed(8) + ' ' + cur.toUpperCase();
  }
  if (cur === 'eth' || cur === 'bnb') {
    return amount.toFixed(6) + ' ' + cur.toUpperCase();
  }
  if (cur === 'idr' || cur === 'krw' || cur === 'vnd') {
    return 'Rp ' + Math.round(amount).toLocaleString('id-ID');
  }
  if (cur === 'jpy') {
    return Math.round(amount).toLocaleString('id-ID') + ' JPY';
  }
  if (amount >= 1) {
    return amount.toFixed(2) + ' ' + cur.toUpperCase();
  }
  return amount.toPrecision(6) + ' ' + cur.toUpperCase();
}

function parseConvAmount(raw) {
  var s = raw.toLowerCase().replace(/,/g, '.');
  var mult = 1;
  if (s.endsWith('k')) { mult = 1e3; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { mult = 1e6; s = s.slice(0, -1); }
  else if (s.endsWith('b')) { mult = 1e9; s = s.slice(0, -1); }
  return parseFloat(s) * mult;
}


// ============================================================
// TWITTER USERNAME HISTORY -- menggunakan memory.lol API
// Contoh: "twit monad" atau "twit elonmusk,vitalik"
// ============================================================
function detectTwitterQuery(text) {
  const m = text.match(/^twit\s+([a-zA-Z0-9_]+(?:,[a-zA-Z0-9_]+)*)$/i);
  if (!m) return null;
  return { usernames: m[1].split(',').map(u => u.trim()) };
}

async function fetchTwitterHistory(usernames) {
  const query = usernames.join(',');

  // Jika MEMORYLOL_TOKEN diset → pakai POST untuk akses penuh (jika akun diapprove).
  // Cara dapat token: jalankan "twit login" di DM bot, lalu simpan token ke env MEMORYLOL_TOKEN.
  const mlToken = process.env.MEMORYLOL_TOKEN;
  let resp;
  if (mlToken) {
    resp = await axios.post(
      'https://api.memory.lol/v1/tw/' + encodeURIComponent(query),
      'token=' + encodeURIComponent(mlToken),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 12000 }
    );
  } else {
    resp = await axios.get(
      'https://api.memory.lol/v1/tw/' + encodeURIComponent(query),
      { timeout: 10000 }
    );
  }

  const accounts = (resp.data && resp.data.accounts) ? resp.data.accounts : [];

  // Coba Wayback Machine sebagai sumber tambahan (earliest known snapshot)
  let wbEarliest = {};
  if (usernames.length <= 2) {
    for (const uname of usernames) {
      try {
        const wbResp = await axios.get('https://web.archive.org/cdx/search/cdx', {
          params: {
            url: 'twitter.com/' + uname,
            output: 'json',
            fl: 'timestamp',
            filter: 'statuscode:200',
            limit: 1,
            from: '20060101',
          },
          timeout: 7000,
        });
        const rows = wbResp.data;
        // rows[0] = header ["timestamp"], rows[1] = first match
        if (Array.isArray(rows) && rows.length >= 2) {
          const ts = rows[1][0]; // "20110401120000"
          const y = ts.slice(0,4), mo = ts.slice(4,6), d = ts.slice(6,8);
          wbEarliest[uname.toLowerCase()] = y + '-' + mo + '-' + d;
        }
      } catch (_) { /* Wayback timeout — skip */ }
    }
  }

  if (accounts.length === 0) {
    let msg = '\u274C Tidak ada data history Twitter untuk **@' + usernames.join(', @') + '**\n';
    msg += '_(Akun tidak dikenali dalam database memory.lol)_';
    // Tambahkan info Wayback Machine jika ada
    for (const [uname, date] of Object.entries(wbEarliest)) {
      msg += '\n\n\uD83D\uDDC4\uFE0F **Wayback Machine**: username @' + uname + ' pertama diarsipkan sekitar **' + date + '**';
    }
    return msg;
  }

  const isFullAccess = !!mlToken;
  const lines = [];

  for (const acc of accounts) {
    const accId = acc.id_str || String(acc.id);
    const screenNames = acc['screen_names'] || acc['screen-names'] || {};
    const entries = Object.keys(screenNames).map(sn => {
      const dates = screenNames[sn];
      if (!dates || (Array.isArray(dates) && dates.length === 0)) {
        return { sn, label: '_(tanggal tidak diketahui)_', hasDate: false };
      }
      if (Array.isArray(dates) && dates.length === 1) {
        return { sn, label: 'terlihat: ' + dates[0], hasDate: true };
      }
      if (Array.isArray(dates) && dates.length === 2) {
        return { sn, label: dates[0] + ' \u2192 ' + dates[1], hasDate: true };
      }
      return { sn, label: String(dates), hasDate: false };
    });
    entries.sort((a, b) => (b.hasDate ? 1 : 0) - (a.hasDate ? 1 : 0));
    const nameList = entries.map(e => '  \u2022 **@' + e.sn + '** \u2014 ' + e.label).join('\n');
    let block = '\uD83C\uDD94 ID: ' + accId + '\n' + nameList;

    // Tambahkan Wayback info jika relevan
    for (const [uname, date] of Object.entries(wbEarliest)) {
      const matchedHere = Object.keys(screenNames).some(sn => sn.toLowerCase() === uname.toLowerCase());
      if (matchedHere) {
        block += '\n  \uD83D\uDDC4\uFE0F Wayback: username @' + uname + ' diarsipkan pertama ~**' + date + '**';
      }
    }
    lines.push(block);
  }

  const accessNote = isFullAccess
    ? '_(akses penuh \u2014 full history 12 tahun)_'
    : '_(akses publik \u2014 60 hari terakhir | ketik **twit login** di DM untuk akses penuh)_';

  const header = '\uD83D\uDC26 **Twitter/X Username History** untuk **@' + usernames.join(', @') + '**\n'
    + accessNote + '\n\n';
  return header + lines.join('\n\n');
}


// ============================================================
// CRYPTORANK — data harga, gainers, losers, market overview
// Commands: cr <token> | gainers | losers | market
// ============================================================
const _crCache = { currencies: null, cachedAt: 0 };
const CR_CACHE_TTL = 3 * 60 * 1000; // 3 menit

async function crFetchCurrencies() {
  const now = Date.now();
  if (_crCache.currencies && now - _crCache.cachedAt < CR_CACHE_TTL) {
    return _crCache.currencies;
  }
  const key = process.env.CRYPTORANK_API_KEY;
  if (!key) throw new Error('CRYPTORANK_API_KEY belum diset di environment.');
  const resp = await axios.get('https://api.cryptorank.io/v1/currencies', {
    params: { api_key: key, limit: 500 },
    timeout: 12000,
  });
  const data = resp.data?.data || [];
  _crCache.currencies = data;
  _crCache.cachedAt = now;
  return data;
}

function crFmt(n) {
  if (n == null) return 'N/A';
  if (Math.abs(n) >= 1e9) return '(userId) {
  const btn = new ButtonBuilder()
    .setCustomId('del_' + userId)
    .setLabel('Hapus')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder().addComponents(btn);
}

async function detectCryptoConversion(question) {
  var m = question.match(/^([\d.,]+[kmb]?)\s+([a-zA-Z]+)\s+(?:to|ke)\s+([a-zA-Z]+)$/i);
  if (!m) return null;
  var amount = parseConvAmount(m[1]);
  var from = m[2].toLowerCase();
  var to = m[3].toLowerCase();
  if (isNaN(amount) || amount <= 0) return null;
  // Resolusi: COIN_ID_MAP -> cache -> CoinGecko /search -> DexScreener
  var coinId = await resolveCoinId(from);
  if (!coinId) {
    var dexInfo = await resolveDexPrice(from);
    if (!dexInfo) return { notFound: true, from: from, to: to };
    if (!SUPPORTED_VS.has(to)) return { notFound: true, from: from, to: to };
    return { amount: amount, from: from, to: to, coinId: null, dexInfo: dexInfo };
  }
  var toIsVs = SUPPORTED_VS.has(to);
  var toCoinId = toIsVs ? null : await resolveCoinId(to);
  if (!toIsVs && !toCoinId) return null;
  return { amount: amount, from: from, to: to, coinId: coinId, toCoinId: toCoinId };
}

// Deteksi: "price btc" atau "p eth" (tanpa tag bot)
function detectPriceQuery(text) {
  var m = text.match(/^(?:price|p)\s+([a-zA-Z]+)$/i);
  if (!m) return null;
  var sym = m[1].toLowerCase();
  var coinId = COIN_ID_MAP[sym];
  if (!coinId) return null;
  return { sym: sym, coinId: coinId };
}

async function fetchCoinPrice(pq) {
  var cgKey = process.env.COINGECKO_API_KEY || '';
  var headers = { 'Accept': 'application/json' };
  if (cgKey) headers['x-cg-demo-api-key'] = cgKey;
  var url = 'https://api.coingecko.com/api/v3/simple/price'
    + '?ids=' + pq.coinId
    + '&vs_currencies=usd,idr,btc'
    + '&include_24hr_change=true'
    + '&include_market_cap=true'
    + '&precision=8';
  var resp = await axios.get(url, { headers: headers, timeout: 8000 });
  var d = resp.data[pq.coinId];
  if (!d) throw new Error('Data tidak ditemukan');
  var sym = pq.sym.toUpperCase();
  var usd = d.usd;
  var idr = d.idr;
  var chg = d.usd_24h_change;
  var mcap = d.usd_market_cap;
  var chgStr = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : 'N/A';
  var usdStr = usd >= 1 ? usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : usd.toPrecision(6);
  var idrStr = 'Rp ' + Math.round(idr).toLocaleString('id-ID');
  var mcapStr = mcap ? '$' + (mcap / 1e9).toFixed(2) + 'B' : 'N/A';
  var arrow = chg != null ? (chg >= 0 ? '**UP**' : '**DOWN**') : '';
  return '**$' + sym + '** ' + arrow + ' ' + chgStr + ' (24 jam)\n'
    + 'USD: $' + usdStr + '\n'
    + 'IDR: ' + idrStr + '\n'
    + 'Market Cap: ' + mcapStr + '\n'
    + '_(via CoinGecko)_';
}

async function fetchCryptoConversion(conv) {
  var amount = conv.amount;
  var from = conv.from;
  var to = conv.to;
  var coinId = conv.coinId;
  if (!from || !to) throw new Error('Data konversi tidak lengkap');
  var fromSym = from.toUpperCase();
  var toSym = to.toUpperCase();
  var cgKey = process.env.COINGECKO_API_KEY || '';

  // DexScreener path: token micro-cap yang tidak ada di CoinGecko
  if (conv.dexInfo) {
    var dexPriceUsd = conv.dexInfo.priceUsd;
    var targetRate = 1;
    if (to !== 'usd') {
      var rateHeaders = { 'Accept': 'application/json' };
      if (cgKey) rateHeaders['x-cg-demo-api-key'] = cgKey;
      var rateResp = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=' + to + '&precision=6',
        { headers: rateHeaders, timeout: 6000 }
      );
      var rateData = rateResp.data && rateResp.data['tether'];
      targetRate = (rateData && rateData[to]) ? rateData[to] : 1;
    }
    var priceInTarget = dexPriceUsd * targetRate;
    var resultInTarget = amount * priceInTarget;
    var dexSrc = (conv.dexInfo.dex || 'dex') + '/' + (conv.dexInfo.chain || 'chain');
    var dl1 = '**' + amount + ' $' + fromSym + ' ke ' + toSym + ' = ' + formatCryptoAmount(resultInTarget, to) + '**';
    var dl2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(priceInTarget, to);
    return dl1 + '\n' + dl2 + '\n_(via DexScreener - ' + dexSrc + ', harga real-time)_';
  }

  // CoinGecko path
  var toCoinId = conv.toCoinId || COIN_ID_MAP[to] || null;
  var toIsVsCurrency = SUPPORTED_VS.has(to);
  var ids = coinId;
  var vsCurrencies = to;
  if (!toIsVsCurrency && toCoinId) {
    ids = coinId + ',' + toCoinId;
    vsCurrencies = 'usd';
  }
  var cgUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=' + vsCurrencies + '&precision=8';
  var cgHeaders = { 'Accept': 'application/json' };
  if (cgKey) cgHeaders['x-cg-demo-api-key'] = cgKey;
  var resp = await axios.get(cgUrl, { headers: cgHeaders, timeout: 8000 });
  var data = resp.data;
  var result, line1, line2;
  if (!toIsVsCurrency && toCoinId) {
    var fromUsd = data[coinId] && data[coinId]['usd'];
    var toUsd = data[toCoinId] && data[toCoinId]['usd'];
    if (!fromUsd || !toUsd) throw new Error('Data harga tidak tersedia');
    result = (amount * fromUsd) / toUsd;
    line1 = '**' + amount + ' $' + fromSym + ' ke $' + toSym + ' = ' + formatCryptoAmount(result, to) + '**';
    line2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(fromUsd / toUsd, to);
  } else {
    var price = data[coinId] && data[coinId][to];
    if (price == null) throw new Error('Data harga tidak tersedia');
    result = amount * price;
    line1 = '**' + amount + ' $' + fromSym + ' ke ' + toSym + ' = ' + formatCryptoAmount(result, to) + '**';
    line2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(price, to);
  }
  return line1 + '\n' + line2 + '\n_(via CoinGecko, harga real-time)_';
}

// ============================================================
// GITHUB EDIT
// ============================================================

function parseGitHubFileRef(text) {
  const urlMatch = text.match(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([^/\s]+)\/([^\s?#]+)/i);
  if (urlMatch) {
    return {
      owner: urlMatch[1], repo: urlMatch[2],
      branch: urlMatch[3], path: decodeURIComponent(urlMatch[4]),
      raw: urlMatch[0],
    };
  }
  const shortMatch = text.match(/\b([\w.-]+)\/([\w.-]+):([\w\-./]+\.[a-zA-Z0-9]+)\b/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], branch: null, path: shortMatch[3], raw: shortMatch[0] };
  }
  return null;
}

function friendlyGitHubError(err, ref) {
  const status = err.response?.status;
  const apiMsg = err.response?.data?.message || err.message;
  console.error('[bot] GitHub edit gagal:', status, apiMsg);
  if (status === 404) return `⚠️ Repo/file tidak ditemukan: \`${ref.owner}/${ref.repo}\` path \`${ref.path}\`. Cek nama repo, path, dan branch-nya.`;
  if (status === 401 || status === 403) return '⚠️ Bot tidak punya izin menulis ke repo ini. Pastikan `GITHUB_TOKEN` punya scope **repo** atau permission **Contents: Read and write**.';
  if (status === 409) return '⚠️ Konflik: file sudah berubah sejak terakhir dibaca (sha mismatch). Kirim ulang permintaannya.';
  if (status === 422) return `⚠️ Gagal commit (422): ${apiMsg}. Cek apakah nama branch/path valid.`;
  return `⚠️ Gagal edit file GitHub. (${status || 'error'}: ${apiMsg})`;
}

async function handleGitHubEdit(message, ref, question, history, isDMOwner) {
  let branch = ref.branch;
  try {
    if (!branch) branch = await getDefaultBranch(ref.owner, ref.repo);
    const { content: oldContent, sha } = await getGitHubFileContent(ref.owner, ref.repo, ref.path, branch);

    const instruction = question.replace(ref.raw, '').trim()
      || 'Periksa file ini, identifikasi error/masalahnya, lalu perbaiki dan rapikan.';

    const prompt = `${instruction}\n\nIni isi file "${ref.path}" saat ini dari repo ${ref.owner}/${ref.repo} (branch ${branch}). `
      + `Berikan versi LENGKAP file yang sudah diperbaiki dalam SATU code block saja — jangan dipotong, jangan ada penjelasan di luar code block selain ringkasan singkat 1-2 kalimat sebelum code block:\n\n`
      + `\`\`\`\n${oldContent}\n\`\`\``;

    const { text } = await askGemini(prompt, history, isDMOwner);

    // [FIX] Deteksi hallusinasi di respons GitHub edit
    if (containsHallucination(text)) {
      await message.reply('⚠️ AI tidak memberikan kode yang valid. Coba kirim ulang permintaannya dengan instruksi lebih spesifik.');
      return;
    }

    const blocks = extractCodeBlocks(text);
    if (!blocks.length) {
      await message.reply('⚠️ AI tidak mengembalikan kode dalam format yang bisa diproses ke GitHub. Coba ulangi dengan instruksi yang lebih spesifik.');
      return;
    }
    const newContent = blocks.reduce((a, b) => (b.code.length > a.code.length ? b : a)).code;

    // [FIX] Validasi kode yang akan di-commit
    if (!isValidCodeBlock(newContent)) {
      await message.reply('⚠️ Kode yang dihasilkan AI terlihat tidak lengkap (terlalu pendek atau mengandung placeholder). Coba kirim ulang.');
      return;
    }

    const commitMessage = `Auto-edit via Discord bot: ${instruction.slice(0, 60)}`;
    const result = await commitGitHubFile(ref.owner, ref.repo, ref.path, newContent, commitMessage, sha, branch);
    const summary = stripCodeBlocks(text).slice(0, 600);

    // [FIX] Gunakan nama file lengkap dari path, bukan hanya pop() terakhir
    const replyFilename = ref.path.includes('/') ? ref.path.split('/').slice(-1)[0] : ref.path;

    await message.reply({
      content: [
        `✅ File **${ref.path}** di **${ref.owner}/${ref.repo}** (branch \`${branch}\`) berhasil diupdate.`,
        result.commitUrl ? `🔗 Commit: <${result.commitUrl}>` : '',
        summary,
      ].filter(Boolean).join('\n').slice(0, 2000),
      files: [makeFile(newContent, replyFilename)],
      flags: MessageFlags.SuppressEmbeds,
    });
  } catch (err) {
    await message.reply(friendlyGitHubError(err, ref)).catch(() => {});
  }
}

// ============================================================
// PROSES FILE SATU PER SATU
// [FIX BARU] Jika total ukuran file melebihi threshold, proses tiap file secara terpisah
// agar tidak melebihi context window AI dan mencegah truncate/hallusinasi.
// ============================================================

async function processSingleFile(message, att, content, question, history, isDMOwner) {
  const instruction = question
    || 'Periksa file ini, identifikasi semua error/masalahnya, lalu perbaiki dan berikan versi LENGKAP yang sudah diperbaiki dalam satu code block.';

  const finalQuestion = `${instruction}\n\n// === File: ${att.name} ===\n${content}`;

  const { text } = await askGemini(finalQuestion, history, isDMOwner);

  // Deteksi hallusinasi
  if (containsHallucination(text)) {
    await message.reply(`⚠️ AI memberikan respons yang tidak valid untuk **${att.name}**. Coba kirim file ini sendiri tanpa file lain.`);
    return;
  }

  const blocks = extractCodeBlocks(text);
  const validBlocks = blocks.filter((b) => isValidCodeBlock(b.code));

  if (validBlocks.length === 0) {
    const explanation = stripCodeBlocks(text).slice(0, 1800);
    await message.reply({
      content: (`**${att.name}:**\n${explanation || '⚠️ AI tidak menghasilkan kode valid untuk file ini.'}`).slice(0, 2000),
      flags: MessageFlags.SuppressEmbeds,
    });
    return;
  }

  const bestBlock = validBlocks.reduce((a, b) => (b.code.length > a.code.length ? b : a));
  const explanation = stripCodeBlocks(text).slice(0, 800);

  await message.reply({
    content: (`✅ **${att.name}** sudah diperbaiki.\n` + (explanation || '')).slice(0, 2000),
    files: [makeFile(bestBlock.code, att.name)],
    flags: MessageFlags.SuppressEmbeds,
  });
}

// ============================================================
// HANDLER UTAMA
// ============================================================


// ============================================================
// HANDLER UTAMA
// ============================================================

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    const isDM = !message.guild;
    const mentioned = message.mentions.users.has(client.user.id);

    // === Crypto/price tanpa tag: "5k usdc to idr" atau "price btc" ===
    if (!mentioned && !isDM) {
      var rawText = message.content.trim();
      var noTagConv = await detectCryptoConversion(rawText);
      var noTagPrice = !noTagConv ? detectPriceQuery(rawText) : null;
      if (noTagConv || noTagPrice) {
        await message.channel.sendTyping().catch(() => {});
        try {
          var noTagResult = noTagConv
            ? await fetchCryptoConversion(noTagConv)
            : await fetchCoinPrice(noTagPrice);
          await message.reply({
            content: noTagResult,
            components: [makeDeleteRow(message.author.id)],
            flags: MessageFlags.SuppressEmbeds,
          });
        } catch (e) {
          await message.reply('Gagal ambil data: ' + e.message).catch(() => {});
        }
      }
      // === CryptoRank tanpa tag: cr BTC | gainers | losers | market ===
      var noTagCr = detectCrQuery(rawText);
      if (noTagCr) {
        await message.channel.sendTyping().catch(() => {});
        try {
          var noTagCrResult = await handleCrCommand(noTagCr.type, noTagCr.symbol);
          await message.reply({
            content: noTagCrResult.slice(0, 2000),
            components: [makeDeleteRow(message.author.id)],
            flags: MessageFlags.SuppressEmbeds,
          });
        } catch (e) {
          await message.reply('Gagal ambil data CryptoRank: ' + e.message).catch(() => {});
        }
        return;
      }

            // === Twitter history tanpa tag: "twit monad" ===
      var noTagTwit = detectTwitterQuery(rawText);
      if (noTagTwit) {
        await message.channel.sendTyping().catch(() => {});
        try {
          var noTagTwitResult = await fetchTwitterHistory(noTagTwit.usernames);
          await message.reply({
            content: noTagTwitResult.slice(0, 2000),
            components: [makeDeleteRow(message.author.id)],
            flags: MessageFlags.SuppressEmbeds,
          });
        } catch (e) {
          await message.reply('Gagal ambil data Twitter: ' + e.message).catch(() => {});
        }
        return;
      }

            // === Chart command tanpa tag: C BTC / C ETH 4h / C ETH 4h 30 ===
      var chartRawMatch = rawText.match(/^c\s+([a-zA-Z]+)(?:\s+(1m|5m|15m|30m|1h|2h|4h|6h|1d|1w))?(?:\s+(\d+))?$/i);
      if (chartRawMatch) {
        await message.channel.sendTyping().catch(() => {});
        try {
          await handleChartCommand(message, chartRawMatch[1], chartRawMatch[2] || '4h', chartRawMatch[3]);
        } catch (e) {
          await message.reply('Gagal buat chart: ' + e.message).catch(() => {});
        }
        return;
      }
      return;
    }

    if (isDM && message.author.id !== OWNER_ID) {
      await message.reply('⛔ Maaf, DM bot ini hanya bisa digunakan oleh owner.');
      return;
    }

    const isDMOwner = isDM && message.author.id === OWNER_ID;
    const historyKey = isDMOwner ? `dm-${message.author.id}` : `ch-${message.channelId}`;

    // Bootstrap history dari Discord saat pertama kali aktif setelah restart
    await bootstrapHistory(historyKey, message.channel, isDMOwner);

    const mentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
    const question = message.content.replace(mentionRegex, '').trim();

    const maxFiles = isDMOwner ? MAX_FILES_DM : MAX_FILES_CH;
    const fileAttachments = [...message.attachments.values()]
      .filter((a) => TEXT_FILE_EXTENSIONS.includes(getExt(a.name)))
      .slice(0, maxFiles);

    if (!question && fileAttachments.length === 0) {
      await message.reply('Halo! Tag aku lalu tulis pertanyaanmu, lampirkan file untuk diperiksa/diperbaiki, kirim link GitHub untuk edit repo, atau minta aku buatkan gambar. 👋');
      return;
    }

    // === Perintah !delete [n] (hanya owner) ===
    if (message.author.id === OWNER_ID && /^!delete\s+\d+$/i.test(question)) {
      const n = Math.min(parseInt(question.split(/\s+/)[1], 10), 100);
      console.log(`[bot] !delete dipanggil oleh owner, n=${n}`);
      // Coba hapus pesan perintah owner
      message.delete().catch(() => {});
      // Fetch pesan recent, filter hanya pesan milik bot
      const fetched = await message.channel.messages.fetch({ limit: 100 });
      const mine = [...fetched.values()]
        .filter(m => m.author.id === client.user.id)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .slice(0, n);
      console.log(`[bot] !delete: ditemukan ${mine.length} pesan milik bot`);
      for (const m of mine) {
        await m.delete().catch(e => console.warn(`[bot] gagal hapus ${m.id}: ${e.message}`));
        await new Promise(r => setTimeout(r, 500));
      }
      console.log(`[bot] !delete: selesai hapus ${mine.length} pesan`);
      return;
    }

    // === Perintah !ClearHistory ===
    if (question.toLowerCase() === '!clearhistory') {
      const hadHistory = !!(allHistory[historyKey] && allHistory[historyKey].length > 0);
      clearHistory(historyKey);
      await message.reply(hadHistory
        ? '🗑️ Riwayat percakapan sesi ini sudah dihapus. Kita mulai dari awal!'
        : '✅ Tidak ada riwayat yang perlu dihapus untuk sesi ini.');
      return;
    }

    // === Deteksi konversi crypto (misal: "5k usdc to idr") ===
    var cryptoConv = await detectCryptoConversion(question);
    if (cryptoConv) {
      if (cryptoConv.notFound) {
        await message.reply({ content: '❌ Token **' + cryptoConv.from.toUpperCase() + '** tidak ditemukan di CoinGecko. Coba cek simbol tokennya.', flags: MessageFlags.SuppressEmbeds });
        return;
      }
      await message.channel.sendTyping().catch(() => {});
      try {
        var convResult = await fetchCryptoConversion(cryptoConv);
        await message.reply({
          content: convResult,
          components: [makeDeleteRow(message.author.id)],
          flags: MessageFlags.SuppressEmbeds,
        });
      } catch (e) {
        await message.reply('Gagal ambil harga: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Deteksi price query (misal: "price btc" atau "p eth") ===
    var priceQ = detectPriceQuery(question);
    if (priceQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var priceResult = await fetchCoinPrice(priceQ);
        await message.reply({ content: priceResult, flags: MessageFlags.SuppressEmbeds });
      } catch (e) {
        await message.reply('Gagal ambil harga: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Twitter login: "twit login" di DM untuk dapatkan token memory.lol ===
    if (isDMOwner && question.toLowerCase() === 'twit login') {
      try {
        const codeResp = await axios.post(
          'https://github.com/login/device/code',
          'client_id=b8ab5a8c1a2745d514b7',
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 10000 }
        );
        const { device_code, user_code, verification_uri, expires_in, interval } = codeResp.data;
        await message.reply(
          '\uD83D\uDD12 **Login ke memory.lol untuk akses full history**\n\n'
          + '1. Buka: **' + verification_uri + '**\n'
          + '2. Masukkan kode: **' + user_code + '**\n'
          + '3. Klik Authorize\n'
          + '4. Balik ke sini dan ketik **twit token** (bot akan cek otomatis)\n\n'
          + '_(Kode berlaku ' + Math.round(expires_in / 60) + ' menit)_'
        );
        // Simpan device_code sementara di memory untuk polling
        if (!global._twitDeviceFlow) global._twitDeviceFlow = {};
        global._twitDeviceFlow[message.author.id] = { device_code, interval: interval || 5, expires: Date.now() + expires_in * 1000 };
      } catch (e) {
        await message.reply('\u274C Gagal mulai login: ' + e.message);
      }
      return;
    }

    // === Twitter token poll: "twit token" setelah authorize ===
    if (isDMOwner && question.toLowerCase() === 'twit token') {
      const flow = global._twitDeviceFlow && global._twitDeviceFlow[message.author.id];
      if (!flow) {
        await message.reply('\u274C Tidak ada sesi login aktif. Ketik **twit login** terlebih dahulu.');
        return;
      }
      if (Date.now() > flow.expires) {
        await message.reply('\u23F0 Kode sudah kedaluwarsa. Ketik **twit login** untuk mulai ulang.');
        return;
      }
      try {
        const tokenResp = await axios.post(
          'https://github.com/login/oauth/access_token',
          'device_code=' + flow.device_code + '&client_id=b8ab5a8c1a2745d514b7&grant_type=urn:ietf:params:oauth:grant-type:device_code',
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 10000 }
        );
        const { access_token, error } = tokenResp.data;
        if (error === 'authorization_pending') {
          await message.reply('\u23F3 Belum diauthorize. Selesaikan langkah di browser dulu, lalu ketik **twit token** lagi.');
          return;
        }
        if (!access_token) {
          await message.reply('\u274C Gagal ambil token: ' + (error || 'unknown error'));
          return;
        }
        // Coba autentikasi ke memory.lol
        const mlResp = await axios.post(
          'https://api.memory.lol/v1/login/status',
          'token=' + encodeURIComponent(access_token),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        ).catch(() => null);
        delete global._twitDeviceFlow[message.author.id];
        await message.reply(
          '\u2705 Token berhasil didapat!\n\n'
          + 'Set environment variable berikut di Railway/Fly.io/host kamu:\n'
          + '```\nMEMORYLOL_TOKEN=' + access_token + '\n```\n'
          + '\u26A0\uFE0F Jika akunmu **belum diapprove** oleh pemilik memory.lol, akses tetap terbatas 60 hari.\n'
          + 'Hubungi [@travisbrown](https://twitter.com/travisbrown) untuk minta full access.'
        );
      } catch (e) {
        await message.reply('\u274C Error: ' + e.message);
      }
      return;
    }

        // === CryptoRank dengan mention: "@bot cr BTC" | "@bot gainers" ===
    var crQ = detectCrQuery(question);
    if (crQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var crResult = await handleCrCommand(crQ.type, crQ.symbol);
        await message.reply({
          content: crResult.slice(0, 2000),
          components: [makeDeleteRow(message.author.id)],
          flags: MessageFlags.SuppressEmbeds,
        });
      } catch (e) {
        await message.reply('Gagal ambil data CryptoRank: ' + e.message).catch(() => {});
      }
      return;
    }

        // === Twitter history dengan mention: "@bot twit monad" ===
    var twitQ = detectTwitterQuery(question);
    if (twitQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var twitResult = await fetchTwitterHistory(twitQ.usernames);
        await message.reply({
          content: twitResult.slice(0, 2000),
          components: [makeDeleteRow(message.author.id)],
          flags: MessageFlags.SuppressEmbeds,
        });
      } catch (e) {
        await message.reply('Gagal ambil data Twitter: ' + e.message).catch(() => {});
      }
      return;
    }

        // === Chart command dengan mention: @bot C BTC / @bot C ETH 4h / @bot C ETH 4h 30 ===
    const chartM = question.match(/^c\s+([a-zA-Z]+)(?:\s+(1m|5m|15m|30m|1h|2h|4h|6h|1d|1w))?(?:\s+(\d+))?$/i);
    if (chartM) {
      await message.channel.sendTyping().catch(() => {});
      try {
        await handleChartCommand(message, chartM[1], chartM[2] || '4h', chartM[3]);
      } catch (e) {
        await message.reply('Gagal buat chart: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Mode edit file GitHub langsung ===
    const ghRef = parseGitHubFileRef(question);
    if (ghRef) {
      await message.channel.sendTyping().catch(() => {});
      const history = getHistoryForAI(historyKey, isDMOwner);
      await handleGitHubEdit(message, ghRef, question, history, isDMOwner);
      return;
    }

    await message.channel.sendTyping().catch(() => {});

    // === Mode gambar (hanya kalau tidak ada file dilampirkan) ===
    if (fileAttachments.length === 0 && isImageRequest(question)) {
      const { imageBuffer, text } = await generateImage(question);
      if (imageBuffer) {
        await message.reply({
          content: (text || `Nih hasil gambarnya: "${question}"`).slice(0, 2000),
          files: [makeFile(imageBuffer, 'hasil.png')],
        });
        return;
      }
      // Kalau generate gambar gagal, jatuh ke mode teks biasa.
    }

    // ============================================================
    // [FIX] Cek total ukuran file sebelum gabung ke satu prompt.
    // Kalau terlalu besar, proses satu per satu agar AI tidak truncate.
    // ============================================================
    if (fileAttachments.length > 0) {
      const totalSize = fileAttachments.reduce((sum, a) => sum + a.size, 0);

      // Download semua file dulu
      const loadedFiles = [];
      for (const att of fileAttachments) {
        try {
          const content = await downloadAttachmentText(att);
          loadedFiles.push({ att, content });
        } catch (e) {
          await message.reply(`⚠️ Gagal membaca **${att.name}**: ${e.message}`).catch(() => {});
        }
      }

      if (loadedFiles.length === 0) return;

      const history = getHistoryForAI(historyKey, isDMOwner);

      // Jika total file > 30KB ATAU ada lebih dari 1 file yang masing-masing > 15KB,
      // proses satu per satu untuk hindari context overflow
      const shouldSplitProcess = totalSize > MAX_TOTAL_BYTES_COMBINED
        || (loadedFiles.length > 1 && loadedFiles.some((f) => f.att.size > 15 * 1024));

      if (shouldSplitProcess && isDMOwner) {
        // Mode split: proses tiap file terpisah
        await message.reply(
          `📂 File terlalu besar untuk diproses sekaligus (total ${Math.round(totalSize / 1024)}KB). Memproses **${loadedFiles.length} file satu per satu**...`
        ).catch(() => {});

        for (const { att, content } of loadedFiles) {
          await message.channel.sendTyping().catch(() => {});
          await processSingleFile(message, att, content, question, history, isDMOwner);
        }

        // Simpan history — hanya nama file, bukan isi
        const fileNames = loadedFiles.map((f) => f.att.name).join(', ');
        await pushHistory(historyKey, `${question || 'cek file'} [File: ${fileNames}]`, '[File diproses satu per satu]', isDMOwner);
        return;
      }

      // Proses gabung (file kecil atau channel)
      const fileParts = [];
      const fileNames = [];
      const originalFileNames = [];

      for (const { att, content } of loadedFiles) {
        fileParts.push(`// === File: ${att.name} ===\n${content}`);
        fileNames.push(att.name);
        originalFileNames.push(att.name);
      }

      const instruction = question
        || 'Periksa semua file yang dilampirkan, identifikasi semua error/masalahnya, lalu perbaiki dan berikan versi LENGKAP yang sudah diperbaiki dalam code block terpisah untuk tiap file.';

      const finalQuestion = `${instruction}\n\n${fileParts.join('\n\n')}`;
      const historyUserContent = `${instruction} [File: ${fileNames.join(', ')}]`;

      const { text, sources } = await askGemini(finalQuestion, history, isDMOwner);

      // [FIX] Deteksi hallusinasi sebelum proses respons
      if (containsHallucination(text)) {
        await message.reply(
          '⚠️ AI tidak dapat memproses file sebesar ini sekaligus. Coba kirim **satu file** saja agar hasilnya akurat.'
        );
        return;
      }

      await pushHistory(historyKey, historyUserContent, text, isDMOwner);

      const blocks = extractCodeBlocks(text);

      if (shouldSendAsFile(question, blocks, isDMOwner)) {
        await replyWithFiles(message, text, blocks, originalFileNames);
        return;
      }

      await sendLongReply(message, formatAnswer(text, sources));
      return;
    }

    // === Pertanyaan teks biasa (tanpa file) ===
    let finalQuestion = question;
    const historyUserContent = question;

    // === Token scam/analisis skill ===
    if (isScamAnalysisRequest(question)) {
      await message.channel.sendTyping().catch(() => {});
      try {
        const scamResult = await runScamAnalysis(question);
        finalQuestion = scamResult.fullPrompt;
      } catch (e) {
        console.error('[bot] scamAnalysis error:', e.message);
        // fall through to normal AI
      }
    }

    const history = getHistoryForAI(historyKey, isDMOwner);
    const { text, sources } = await askGemini(finalQuestion, history, isDMOwner);

    await pushHistory(historyKey, historyUserContent, text, isDMOwner);

    const blocks = extractCodeBlocks(text);

    if (shouldSendAsFile(question, blocks, isDMOwner)) {
      await replyWithFiles(message, text, blocks, []);
      return;
    }

    await sendLongReply(message, formatAnswer(text, sources));
  } catch (err) {
    console.error('[bot] Error di messageCreate:', err);
    await message.reply(friendlyError(err)).catch(() => {});
  }
});

// ============================================================
// LOGIN
// ============================================================

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('[bot] DISCORD_TOKEN belum di-set. Set env DISCORD_TOKEN dengan Bot Token dari Developer Portal.');
  process.exit(1);
}

// ============================================================
// TOMBOL DELETE — hanya user pengirim yang bisa klik
// ============================================================
client.on('interactionCreate', async (interaction) => {
  console.log('[btn] interactionCreate fired, type:', interaction.type, 'isButton:', interaction.isButton?.());
  try {
    if (!interaction.isButton()) return;
    console.log('[btn] customId:', interaction.customId, 'userId:', interaction.user?.id);
    if (!interaction.customId.startsWith('del_')) return;

    const ownerId = interaction.customId.slice(4);
    console.log('[btn] ownerId:', ownerId, 'clickerId:', interaction.user.id);

    if (interaction.user.id !== ownerId) {
      console.log('[btn] bukan pemilik, tolak');
      await interaction.reply({
        content: '⛔ Hanya pengirim pesan asli yang bisa menghapus ini.',
        ephemeral: true,
      });
      return;
    }

    // deferUpdate = silent ACK ke Discord (paling cepat, tidak buat pesan baru)
    console.log('[btn] deferUpdate...');
    await interaction.deferUpdate();
    console.log('[btn] deferUpdate OK, deleting message...');

    await interaction.message.delete();
    console.log('[btn] message deleted OK');
  } catch (err) {
    console.error('[btn] ERROR:', err.message, err.stack);
    // Coba reply jika belum di-acknowledge
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '⚠️ Gagal hapus: ' + err.message, ephemeral: true });
      }
    } catch (_) {}
  }
});


client.login(token);
 + (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '(userId) {
  const btn = new ButtonBuilder()
    .setCustomId('del_' + userId)
    .setLabel('Hapus')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder().addComponents(btn);
}

async function detectCryptoConversion(question) {
  var m = question.match(/^([\d.,]+[kmb]?)\s+([a-zA-Z]+)\s+(?:to|ke)\s+([a-zA-Z]+)$/i);
  if (!m) return null;
  var amount = parseConvAmount(m[1]);
  var from = m[2].toLowerCase();
  var to = m[3].toLowerCase();
  if (isNaN(amount) || amount <= 0) return null;
  // Resolusi: COIN_ID_MAP -> cache -> CoinGecko /search -> DexScreener
  var coinId = await resolveCoinId(from);
  if (!coinId) {
    var dexInfo = await resolveDexPrice(from);
    if (!dexInfo) return { notFound: true, from: from, to: to };
    if (!SUPPORTED_VS.has(to)) return { notFound: true, from: from, to: to };
    return { amount: amount, from: from, to: to, coinId: null, dexInfo: dexInfo };
  }
  var toIsVs = SUPPORTED_VS.has(to);
  var toCoinId = toIsVs ? null : await resolveCoinId(to);
  if (!toIsVs && !toCoinId) return null;
  return { amount: amount, from: from, to: to, coinId: coinId, toCoinId: toCoinId };
}

// Deteksi: "price btc" atau "p eth" (tanpa tag bot)
function detectPriceQuery(text) {
  var m = text.match(/^(?:price|p)\s+([a-zA-Z]+)$/i);
  if (!m) return null;
  var sym = m[1].toLowerCase();
  var coinId = COIN_ID_MAP[sym];
  if (!coinId) return null;
  return { sym: sym, coinId: coinId };
}

async function fetchCoinPrice(pq) {
  var cgKey = process.env.COINGECKO_API_KEY || '';
  var headers = { 'Accept': 'application/json' };
  if (cgKey) headers['x-cg-demo-api-key'] = cgKey;
  var url = 'https://api.coingecko.com/api/v3/simple/price'
    + '?ids=' + pq.coinId
    + '&vs_currencies=usd,idr,btc'
    + '&include_24hr_change=true'
    + '&include_market_cap=true'
    + '&precision=8';
  var resp = await axios.get(url, { headers: headers, timeout: 8000 });
  var d = resp.data[pq.coinId];
  if (!d) throw new Error('Data tidak ditemukan');
  var sym = pq.sym.toUpperCase();
  var usd = d.usd;
  var idr = d.idr;
  var chg = d.usd_24h_change;
  var mcap = d.usd_market_cap;
  var chgStr = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : 'N/A';
  var usdStr = usd >= 1 ? usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : usd.toPrecision(6);
  var idrStr = 'Rp ' + Math.round(idr).toLocaleString('id-ID');
  var mcapStr = mcap ? '$' + (mcap / 1e9).toFixed(2) + 'B' : 'N/A';
  var arrow = chg != null ? (chg >= 0 ? '**UP**' : '**DOWN**') : '';
  return '**$' + sym + '** ' + arrow + ' ' + chgStr + ' (24 jam)\n'
    + 'USD: $' + usdStr + '\n'
    + 'IDR: ' + idrStr + '\n'
    + 'Market Cap: ' + mcapStr + '\n'
    + '_(via CoinGecko)_';
}

async function fetchCryptoConversion(conv) {
  var amount = conv.amount;
  var from = conv.from;
  var to = conv.to;
  var coinId = conv.coinId;
  if (!from || !to) throw new Error('Data konversi tidak lengkap');
  var fromSym = from.toUpperCase();
  var toSym = to.toUpperCase();
  var cgKey = process.env.COINGECKO_API_KEY || '';

  // DexScreener path: token micro-cap yang tidak ada di CoinGecko
  if (conv.dexInfo) {
    var dexPriceUsd = conv.dexInfo.priceUsd;
    var targetRate = 1;
    if (to !== 'usd') {
      var rateHeaders = { 'Accept': 'application/json' };
      if (cgKey) rateHeaders['x-cg-demo-api-key'] = cgKey;
      var rateResp = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=' + to + '&precision=6',
        { headers: rateHeaders, timeout: 6000 }
      );
      var rateData = rateResp.data && rateResp.data['tether'];
      targetRate = (rateData && rateData[to]) ? rateData[to] : 1;
    }
    var priceInTarget = dexPriceUsd * targetRate;
    var resultInTarget = amount * priceInTarget;
    var dexSrc = (conv.dexInfo.dex || 'dex') + '/' + (conv.dexInfo.chain || 'chain');
    var dl1 = '**' + amount + ' $' + fromSym + ' ke ' + toSym + ' = ' + formatCryptoAmount(resultInTarget, to) + '**';
    var dl2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(priceInTarget, to);
    return dl1 + '\n' + dl2 + '\n_(via DexScreener - ' + dexSrc + ', harga real-time)_';
  }

  // CoinGecko path
  var toCoinId = conv.toCoinId || COIN_ID_MAP[to] || null;
  var toIsVsCurrency = SUPPORTED_VS.has(to);
  var ids = coinId;
  var vsCurrencies = to;
  if (!toIsVsCurrency && toCoinId) {
    ids = coinId + ',' + toCoinId;
    vsCurrencies = 'usd';
  }
  var cgUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=' + vsCurrencies + '&precision=8';
  var cgHeaders = { 'Accept': 'application/json' };
  if (cgKey) cgHeaders['x-cg-demo-api-key'] = cgKey;
  var resp = await axios.get(cgUrl, { headers: cgHeaders, timeout: 8000 });
  var data = resp.data;
  var result, line1, line2;
  if (!toIsVsCurrency && toCoinId) {
    var fromUsd = data[coinId] && data[coinId]['usd'];
    var toUsd = data[toCoinId] && data[toCoinId]['usd'];
    if (!fromUsd || !toUsd) throw new Error('Data harga tidak tersedia');
    result = (amount * fromUsd) / toUsd;
    line1 = '**' + amount + ' $' + fromSym + ' ke $' + toSym + ' = ' + formatCryptoAmount(result, to) + '**';
    line2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(fromUsd / toUsd, to);
  } else {
    var price = data[coinId] && data[coinId][to];
    if (price == null) throw new Error('Data harga tidak tersedia');
    result = amount * price;
    line1 = '**' + amount + ' $' + fromSym + ' ke ' + toSym + ' = ' + formatCryptoAmount(result, to) + '**';
    line2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(price, to);
  }
  return line1 + '\n' + line2 + '\n_(via CoinGecko, harga real-time)_';
}

// ============================================================
// GITHUB EDIT
// ============================================================

function parseGitHubFileRef(text) {
  const urlMatch = text.match(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([^/\s]+)\/([^\s?#]+)/i);
  if (urlMatch) {
    return {
      owner: urlMatch[1], repo: urlMatch[2],
      branch: urlMatch[3], path: decodeURIComponent(urlMatch[4]),
      raw: urlMatch[0],
    };
  }
  const shortMatch = text.match(/\b([\w.-]+)\/([\w.-]+):([\w\-./]+\.[a-zA-Z0-9]+)\b/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], branch: null, path: shortMatch[3], raw: shortMatch[0] };
  }
  return null;
}

function friendlyGitHubError(err, ref) {
  const status = err.response?.status;
  const apiMsg = err.response?.data?.message || err.message;
  console.error('[bot] GitHub edit gagal:', status, apiMsg);
  if (status === 404) return `⚠️ Repo/file tidak ditemukan: \`${ref.owner}/${ref.repo}\` path \`${ref.path}\`. Cek nama repo, path, dan branch-nya.`;
  if (status === 401 || status === 403) return '⚠️ Bot tidak punya izin menulis ke repo ini. Pastikan `GITHUB_TOKEN` punya scope **repo** atau permission **Contents: Read and write**.';
  if (status === 409) return '⚠️ Konflik: file sudah berubah sejak terakhir dibaca (sha mismatch). Kirim ulang permintaannya.';
  if (status === 422) return `⚠️ Gagal commit (422): ${apiMsg}. Cek apakah nama branch/path valid.`;
  return `⚠️ Gagal edit file GitHub. (${status || 'error'}: ${apiMsg})`;
}

async function handleGitHubEdit(message, ref, question, history, isDMOwner) {
  let branch = ref.branch;
  try {
    if (!branch) branch = await getDefaultBranch(ref.owner, ref.repo);
    const { content: oldContent, sha } = await getGitHubFileContent(ref.owner, ref.repo, ref.path, branch);

    const instruction = question.replace(ref.raw, '').trim()
      || 'Periksa file ini, identifikasi error/masalahnya, lalu perbaiki dan rapikan.';

    const prompt = `${instruction}\n\nIni isi file "${ref.path}" saat ini dari repo ${ref.owner}/${ref.repo} (branch ${branch}). `
      + `Berikan versi LENGKAP file yang sudah diperbaiki dalam SATU code block saja — jangan dipotong, jangan ada penjelasan di luar code block selain ringkasan singkat 1-2 kalimat sebelum code block:\n\n`
      + `\`\`\`\n${oldContent}\n\`\`\``;

    const { text } = await askGemini(prompt, history, isDMOwner);

    // [FIX] Deteksi hallusinasi di respons GitHub edit
    if (containsHallucination(text)) {
      await message.reply('⚠️ AI tidak memberikan kode yang valid. Coba kirim ulang permintaannya dengan instruksi lebih spesifik.');
      return;
    }

    const blocks = extractCodeBlocks(text);
    if (!blocks.length) {
      await message.reply('⚠️ AI tidak mengembalikan kode dalam format yang bisa diproses ke GitHub. Coba ulangi dengan instruksi yang lebih spesifik.');
      return;
    }
    const newContent = blocks.reduce((a, b) => (b.code.length > a.code.length ? b : a)).code;

    // [FIX] Validasi kode yang akan di-commit
    if (!isValidCodeBlock(newContent)) {
      await message.reply('⚠️ Kode yang dihasilkan AI terlihat tidak lengkap (terlalu pendek atau mengandung placeholder). Coba kirim ulang.');
      return;
    }

    const commitMessage = `Auto-edit via Discord bot: ${instruction.slice(0, 60)}`;
    const result = await commitGitHubFile(ref.owner, ref.repo, ref.path, newContent, commitMessage, sha, branch);
    const summary = stripCodeBlocks(text).slice(0, 600);

    // [FIX] Gunakan nama file lengkap dari path, bukan hanya pop() terakhir
    const replyFilename = ref.path.includes('/') ? ref.path.split('/').slice(-1)[0] : ref.path;

    await message.reply({
      content: [
        `✅ File **${ref.path}** di **${ref.owner}/${ref.repo}** (branch \`${branch}\`) berhasil diupdate.`,
        result.commitUrl ? `🔗 Commit: <${result.commitUrl}>` : '',
        summary,
      ].filter(Boolean).join('\n').slice(0, 2000),
      files: [makeFile(newContent, replyFilename)],
      flags: MessageFlags.SuppressEmbeds,
    });
  } catch (err) {
    await message.reply(friendlyGitHubError(err, ref)).catch(() => {});
  }
}

// ============================================================
// PROSES FILE SATU PER SATU
// [FIX BARU] Jika total ukuran file melebihi threshold, proses tiap file secara terpisah
// agar tidak melebihi context window AI dan mencegah truncate/hallusinasi.
// ============================================================

async function processSingleFile(message, att, content, question, history, isDMOwner) {
  const instruction = question
    || 'Periksa file ini, identifikasi semua error/masalahnya, lalu perbaiki dan berikan versi LENGKAP yang sudah diperbaiki dalam satu code block.';

  const finalQuestion = `${instruction}\n\n// === File: ${att.name} ===\n${content}`;

  const { text } = await askGemini(finalQuestion, history, isDMOwner);

  // Deteksi hallusinasi
  if (containsHallucination(text)) {
    await message.reply(`⚠️ AI memberikan respons yang tidak valid untuk **${att.name}**. Coba kirim file ini sendiri tanpa file lain.`);
    return;
  }

  const blocks = extractCodeBlocks(text);
  const validBlocks = blocks.filter((b) => isValidCodeBlock(b.code));

  if (validBlocks.length === 0) {
    const explanation = stripCodeBlocks(text).slice(0, 1800);
    await message.reply({
      content: (`**${att.name}:**\n${explanation || '⚠️ AI tidak menghasilkan kode valid untuk file ini.'}`).slice(0, 2000),
      flags: MessageFlags.SuppressEmbeds,
    });
    return;
  }

  const bestBlock = validBlocks.reduce((a, b) => (b.code.length > a.code.length ? b : a));
  const explanation = stripCodeBlocks(text).slice(0, 800);

  await message.reply({
    content: (`✅ **${att.name}** sudah diperbaiki.\n` + (explanation || '')).slice(0, 2000),
    files: [makeFile(bestBlock.code, att.name)],
    flags: MessageFlags.SuppressEmbeds,
  });
}

// ============================================================
// HANDLER UTAMA
// ============================================================


// ============================================================
// HANDLER UTAMA
// ============================================================

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    const isDM = !message.guild;
    const mentioned = message.mentions.users.has(client.user.id);

    // === Crypto/price tanpa tag: "5k usdc to idr" atau "price btc" ===
    if (!mentioned && !isDM) {
      var rawText = message.content.trim();
      var noTagConv = await detectCryptoConversion(rawText);
      var noTagPrice = !noTagConv ? detectPriceQuery(rawText) : null;
      if (noTagConv || noTagPrice) {
        await message.channel.sendTyping().catch(() => {});
        try {
          var noTagResult = noTagConv
            ? await fetchCryptoConversion(noTagConv)
            : await fetchCoinPrice(noTagPrice);
          await message.reply({
            content: noTagResult,
            components: [makeDeleteRow(message.author.id)],
            flags: MessageFlags.SuppressEmbeds,
          });
        } catch (e) {
          await message.reply('Gagal ambil data: ' + e.message).catch(() => {});
        }
      }
      // === Twitter history tanpa tag: "twit monad" ===
      var noTagTwit = detectTwitterQuery(rawText);
      if (noTagTwit) {
        await message.channel.sendTyping().catch(() => {});
        try {
          var noTagTwitResult = await fetchTwitterHistory(noTagTwit.usernames);
          await message.reply({
            content: noTagTwitResult.slice(0, 2000),
            components: [makeDeleteRow(message.author.id)],
            flags: MessageFlags.SuppressEmbeds,
          });
        } catch (e) {
          await message.reply('Gagal ambil data Twitter: ' + e.message).catch(() => {});
        }
        return;
      }

            // === Chart command tanpa tag: C BTC / C ETH 4h / C ETH 4h 30 ===
      var chartRawMatch = rawText.match(/^c\s+([a-zA-Z]+)(?:\s+(1m|5m|15m|30m|1h|2h|4h|6h|1d|1w))?(?:\s+(\d+))?$/i);
      if (chartRawMatch) {
        await message.channel.sendTyping().catch(() => {});
        try {
          await handleChartCommand(message, chartRawMatch[1], chartRawMatch[2] || '4h', chartRawMatch[3]);
        } catch (e) {
          await message.reply('Gagal buat chart: ' + e.message).catch(() => {});
        }
        return;
      }
      return;
    }

    if (isDM && message.author.id !== OWNER_ID) {
      await message.reply('⛔ Maaf, DM bot ini hanya bisa digunakan oleh owner.');
      return;
    }

    const isDMOwner = isDM && message.author.id === OWNER_ID;
    const historyKey = isDMOwner ? `dm-${message.author.id}` : `ch-${message.channelId}`;

    // Bootstrap history dari Discord saat pertama kali aktif setelah restart
    await bootstrapHistory(historyKey, message.channel, isDMOwner);

    const mentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
    const question = message.content.replace(mentionRegex, '').trim();

    const maxFiles = isDMOwner ? MAX_FILES_DM : MAX_FILES_CH;
    const fileAttachments = [...message.attachments.values()]
      .filter((a) => TEXT_FILE_EXTENSIONS.includes(getExt(a.name)))
      .slice(0, maxFiles);

    if (!question && fileAttachments.length === 0) {
      await message.reply('Halo! Tag aku lalu tulis pertanyaanmu, lampirkan file untuk diperiksa/diperbaiki, kirim link GitHub untuk edit repo, atau minta aku buatkan gambar. 👋');
      return;
    }

    // === Perintah !delete [n] (hanya owner) ===
    if (message.author.id === OWNER_ID && /^!delete\s+\d+$/i.test(question)) {
      const n = Math.min(parseInt(question.split(/\s+/)[1], 10), 100);
      console.log(`[bot] !delete dipanggil oleh owner, n=${n}`);
      // Coba hapus pesan perintah owner
      message.delete().catch(() => {});
      // Fetch pesan recent, filter hanya pesan milik bot
      const fetched = await message.channel.messages.fetch({ limit: 100 });
      const mine = [...fetched.values()]
        .filter(m => m.author.id === client.user.id)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .slice(0, n);
      console.log(`[bot] !delete: ditemukan ${mine.length} pesan milik bot`);
      for (const m of mine) {
        await m.delete().catch(e => console.warn(`[bot] gagal hapus ${m.id}: ${e.message}`));
        await new Promise(r => setTimeout(r, 500));
      }
      console.log(`[bot] !delete: selesai hapus ${mine.length} pesan`);
      return;
    }

    // === Perintah !ClearHistory ===
    if (question.toLowerCase() === '!clearhistory') {
      const hadHistory = !!(allHistory[historyKey] && allHistory[historyKey].length > 0);
      clearHistory(historyKey);
      await message.reply(hadHistory
        ? '🗑️ Riwayat percakapan sesi ini sudah dihapus. Kita mulai dari awal!'
        : '✅ Tidak ada riwayat yang perlu dihapus untuk sesi ini.');
      return;
    }

    // === Deteksi konversi crypto (misal: "5k usdc to idr") ===
    var cryptoConv = await detectCryptoConversion(question);
    if (cryptoConv) {
      if (cryptoConv.notFound) {
        await message.reply({ content: '❌ Token **' + cryptoConv.from.toUpperCase() + '** tidak ditemukan di CoinGecko. Coba cek simbol tokennya.', flags: MessageFlags.SuppressEmbeds });
        return;
      }
      await message.channel.sendTyping().catch(() => {});
      try {
        var convResult = await fetchCryptoConversion(cryptoConv);
        await message.reply({
          content: convResult,
          components: [makeDeleteRow(message.author.id)],
          flags: MessageFlags.SuppressEmbeds,
        });
      } catch (e) {
        await message.reply('Gagal ambil harga: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Deteksi price query (misal: "price btc" atau "p eth") ===
    var priceQ = detectPriceQuery(question);
    if (priceQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var priceResult = await fetchCoinPrice(priceQ);
        await message.reply({ content: priceResult, flags: MessageFlags.SuppressEmbeds });
      } catch (e) {
        await message.reply('Gagal ambil harga: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Twitter login: "twit login" di DM untuk dapatkan token memory.lol ===
    if (isDMOwner && question.toLowerCase() === 'twit login') {
      try {
        const codeResp = await axios.post(
          'https://github.com/login/device/code',
          'client_id=b8ab5a8c1a2745d514b7',
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 10000 }
        );
        const { device_code, user_code, verification_uri, expires_in, interval } = codeResp.data;
        await message.reply(
          '\uD83D\uDD12 **Login ke memory.lol untuk akses full history**\n\n'
          + '1. Buka: **' + verification_uri + '**\n'
          + '2. Masukkan kode: **' + user_code + '**\n'
          + '3. Klik Authorize\n'
          + '4. Balik ke sini dan ketik **twit token** (bot akan cek otomatis)\n\n'
          + '_(Kode berlaku ' + Math.round(expires_in / 60) + ' menit)_'
        );
        // Simpan device_code sementara di memory untuk polling
        if (!global._twitDeviceFlow) global._twitDeviceFlow = {};
        global._twitDeviceFlow[message.author.id] = { device_code, interval: interval || 5, expires: Date.now() + expires_in * 1000 };
      } catch (e) {
        await message.reply('\u274C Gagal mulai login: ' + e.message);
      }
      return;
    }

    // === Twitter token poll: "twit token" setelah authorize ===
    if (isDMOwner && question.toLowerCase() === 'twit token') {
      const flow = global._twitDeviceFlow && global._twitDeviceFlow[message.author.id];
      if (!flow) {
        await message.reply('\u274C Tidak ada sesi login aktif. Ketik **twit login** terlebih dahulu.');
        return;
      }
      if (Date.now() > flow.expires) {
        await message.reply('\u23F0 Kode sudah kedaluwarsa. Ketik **twit login** untuk mulai ulang.');
        return;
      }
      try {
        const tokenResp = await axios.post(
          'https://github.com/login/oauth/access_token',
          'device_code=' + flow.device_code + '&client_id=b8ab5a8c1a2745d514b7&grant_type=urn:ietf:params:oauth:grant-type:device_code',
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 10000 }
        );
        const { access_token, error } = tokenResp.data;
        if (error === 'authorization_pending') {
          await message.reply('\u23F3 Belum diauthorize. Selesaikan langkah di browser dulu, lalu ketik **twit token** lagi.');
          return;
        }
        if (!access_token) {
          await message.reply('\u274C Gagal ambil token: ' + (error || 'unknown error'));
          return;
        }
        // Coba autentikasi ke memory.lol
        const mlResp = await axios.post(
          'https://api.memory.lol/v1/login/status',
          'token=' + encodeURIComponent(access_token),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        ).catch(() => null);
        delete global._twitDeviceFlow[message.author.id];
        await message.reply(
          '\u2705 Token berhasil didapat!\n\n'
          + 'Set environment variable berikut di Railway/Fly.io/host kamu:\n'
          + '```\nMEMORYLOL_TOKEN=' + access_token + '\n```\n'
          + '\u26A0\uFE0F Jika akunmu **belum diapprove** oleh pemilik memory.lol, akses tetap terbatas 60 hari.\n'
          + 'Hubungi [@travisbrown](https://twitter.com/travisbrown) untuk minta full access.'
        );
      } catch (e) {
        await message.reply('\u274C Error: ' + e.message);
      }
      return;
    }

        // === Twitter history dengan mention: "@bot twit monad" ===
    var twitQ = detectTwitterQuery(question);
    if (twitQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var twitResult = await fetchTwitterHistory(twitQ.usernames);
        await message.reply({
          content: twitResult.slice(0, 2000),
          components: [makeDeleteRow(message.author.id)],
          flags: MessageFlags.SuppressEmbeds,
        });
      } catch (e) {
        await message.reply('Gagal ambil data Twitter: ' + e.message).catch(() => {});
      }
      return;
    }

        // === Chart command dengan mention: @bot C BTC / @bot C ETH 4h / @bot C ETH 4h 30 ===
    const chartM = question.match(/^c\s+([a-zA-Z]+)(?:\s+(1m|5m|15m|30m|1h|2h|4h|6h|1d|1w))?(?:\s+(\d+))?$/i);
    if (chartM) {
      await message.channel.sendTyping().catch(() => {});
      try {
        await handleChartCommand(message, chartM[1], chartM[2] || '4h', chartM[3]);
      } catch (e) {
        await message.reply('Gagal buat chart: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Mode edit file GitHub langsung ===
    const ghRef = parseGitHubFileRef(question);
    if (ghRef) {
      await message.channel.sendTyping().catch(() => {});
      const history = getHistoryForAI(historyKey, isDMOwner);
      await handleGitHubEdit(message, ghRef, question, history, isDMOwner);
      return;
    }

    await message.channel.sendTyping().catch(() => {});

    // === Mode gambar (hanya kalau tidak ada file dilampirkan) ===
    if (fileAttachments.length === 0 && isImageRequest(question)) {
      const { imageBuffer, text } = await generateImage(question);
      if (imageBuffer) {
        await message.reply({
          content: (text || `Nih hasil gambarnya: "${question}"`).slice(0, 2000),
          files: [makeFile(imageBuffer, 'hasil.png')],
        });
        return;
      }
      // Kalau generate gambar gagal, jatuh ke mode teks biasa.
    }

    // ============================================================
    // [FIX] Cek total ukuran file sebelum gabung ke satu prompt.
    // Kalau terlalu besar, proses satu per satu agar AI tidak truncate.
    // ============================================================
    if (fileAttachments.length > 0) {
      const totalSize = fileAttachments.reduce((sum, a) => sum + a.size, 0);

      // Download semua file dulu
      const loadedFiles = [];
      for (const att of fileAttachments) {
        try {
          const content = await downloadAttachmentText(att);
          loadedFiles.push({ att, content });
        } catch (e) {
          await message.reply(`⚠️ Gagal membaca **${att.name}**: ${e.message}`).catch(() => {});
        }
      }

      if (loadedFiles.length === 0) return;

      const history = getHistoryForAI(historyKey, isDMOwner);

      // Jika total file > 30KB ATAU ada lebih dari 1 file yang masing-masing > 15KB,
      // proses satu per satu untuk hindari context overflow
      const shouldSplitProcess = totalSize > MAX_TOTAL_BYTES_COMBINED
        || (loadedFiles.length > 1 && loadedFiles.some((f) => f.att.size > 15 * 1024));

      if (shouldSplitProcess && isDMOwner) {
        // Mode split: proses tiap file terpisah
        await message.reply(
          `📂 File terlalu besar untuk diproses sekaligus (total ${Math.round(totalSize / 1024)}KB). Memproses **${loadedFiles.length} file satu per satu**...`
        ).catch(() => {});

        for (const { att, content } of loadedFiles) {
          await message.channel.sendTyping().catch(() => {});
          await processSingleFile(message, att, content, question, history, isDMOwner);
        }

        // Simpan history — hanya nama file, bukan isi
        const fileNames = loadedFiles.map((f) => f.att.name).join(', ');
        await pushHistory(historyKey, `${question || 'cek file'} [File: ${fileNames}]`, '[File diproses satu per satu]', isDMOwner);
        return;
      }

      // Proses gabung (file kecil atau channel)
      const fileParts = [];
      const fileNames = [];
      const originalFileNames = [];

      for (const { att, content } of loadedFiles) {
        fileParts.push(`// === File: ${att.name} ===\n${content}`);
        fileNames.push(att.name);
        originalFileNames.push(att.name);
      }

      const instruction = question
        || 'Periksa semua file yang dilampirkan, identifikasi semua error/masalahnya, lalu perbaiki dan berikan versi LENGKAP yang sudah diperbaiki dalam code block terpisah untuk tiap file.';

      const finalQuestion = `${instruction}\n\n${fileParts.join('\n\n')}`;
      const historyUserContent = `${instruction} [File: ${fileNames.join(', ')}]`;

      const { text, sources } = await askGemini(finalQuestion, history, isDMOwner);

      // [FIX] Deteksi hallusinasi sebelum proses respons
      if (containsHallucination(text)) {
        await message.reply(
          '⚠️ AI tidak dapat memproses file sebesar ini sekaligus. Coba kirim **satu file** saja agar hasilnya akurat.'
        );
        return;
      }

      await pushHistory(historyKey, historyUserContent, text, isDMOwner);

      const blocks = extractCodeBlocks(text);

      if (shouldSendAsFile(question, blocks, isDMOwner)) {
        await replyWithFiles(message, text, blocks, originalFileNames);
        return;
      }

      await sendLongReply(message, formatAnswer(text, sources));
      return;
    }

    // === Pertanyaan teks biasa (tanpa file) ===
    let finalQuestion = question;
    const historyUserContent = question;

    // === Token scam/analisis skill ===
    if (isScamAnalysisRequest(question)) {
      await message.channel.sendTyping().catch(() => {});
      try {
        const scamResult = await runScamAnalysis(question);
        finalQuestion = scamResult.fullPrompt;
      } catch (e) {
        console.error('[bot] scamAnalysis error:', e.message);
        // fall through to normal AI
      }
    }

    const history = getHistoryForAI(historyKey, isDMOwner);
    const { text, sources } = await askGemini(finalQuestion, history, isDMOwner);

    await pushHistory(historyKey, historyUserContent, text, isDMOwner);

    const blocks = extractCodeBlocks(text);

    if (shouldSendAsFile(question, blocks, isDMOwner)) {
      await replyWithFiles(message, text, blocks, []);
      return;
    }

    await sendLongReply(message, formatAnswer(text, sources));
  } catch (err) {
    console.error('[bot] Error di messageCreate:', err);
    await message.reply(friendlyError(err)).catch(() => {});
  }
});

// ============================================================
// LOGIN
// ============================================================

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('[bot] DISCORD_TOKEN belum di-set. Set env DISCORD_TOKEN dengan Bot Token dari Developer Portal.');
  process.exit(1);
}

// ============================================================
// TOMBOL DELETE — hanya user pengirim yang bisa klik
// ============================================================
client.on('interactionCreate', async (interaction) => {
  console.log('[btn] interactionCreate fired, type:', interaction.type, 'isButton:', interaction.isButton?.());
  try {
    if (!interaction.isButton()) return;
    console.log('[btn] customId:', interaction.customId, 'userId:', interaction.user?.id);
    if (!interaction.customId.startsWith('del_')) return;

    const ownerId = interaction.customId.slice(4);
    console.log('[btn] ownerId:', ownerId, 'clickerId:', interaction.user.id);

    if (interaction.user.id !== ownerId) {
      console.log('[btn] bukan pemilik, tolak');
      await interaction.reply({
        content: '⛔ Hanya pengirim pesan asli yang bisa menghapus ini.',
        ephemeral: true,
      });
      return;
    }

    // deferUpdate = silent ACK ke Discord (paling cepat, tidak buat pesan baru)
    console.log('[btn] deferUpdate...');
    await interaction.deferUpdate();
    console.log('[btn] deferUpdate OK, deleting message...');

    await interaction.message.delete();
    console.log('[btn] message deleted OK');
  } catch (err) {
    console.error('[btn] ERROR:', err.message, err.stack);
    // Coba reply jika belum di-acknowledge
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '⚠️ Gagal hapus: ' + err.message, ephemeral: true });
      }
    } catch (_) {}
  }
});


client.login(token);
 + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1) return '(userId) {
  const btn = new ButtonBuilder()
    .setCustomId('del_' + userId)
    .setLabel('Hapus')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder().addComponents(btn);
}

async function detectCryptoConversion(question) {
  var m = question.match(/^([\d.,]+[kmb]?)\s+([a-zA-Z]+)\s+(?:to|ke)\s+([a-zA-Z]+)$/i);
  if (!m) return null;
  var amount = parseConvAmount(m[1]);
  var from = m[2].toLowerCase();
  var to = m[3].toLowerCase();
  if (isNaN(amount) || amount <= 0) return null;
  // Resolusi: COIN_ID_MAP -> cache -> CoinGecko /search -> DexScreener
  var coinId = await resolveCoinId(from);
  if (!coinId) {
    var dexInfo = await resolveDexPrice(from);
    if (!dexInfo) return { notFound: true, from: from, to: to };
    if (!SUPPORTED_VS.has(to)) return { notFound: true, from: from, to: to };
    return { amount: amount, from: from, to: to, coinId: null, dexInfo: dexInfo };
  }
  var toIsVs = SUPPORTED_VS.has(to);
  var toCoinId = toIsVs ? null : await resolveCoinId(to);
  if (!toIsVs && !toCoinId) return null;
  return { amount: amount, from: from, to: to, coinId: coinId, toCoinId: toCoinId };
}

// Deteksi: "price btc" atau "p eth" (tanpa tag bot)
function detectPriceQuery(text) {
  var m = text.match(/^(?:price|p)\s+([a-zA-Z]+)$/i);
  if (!m) return null;
  var sym = m[1].toLowerCase();
  var coinId = COIN_ID_MAP[sym];
  if (!coinId) return null;
  return { sym: sym, coinId: coinId };
}

async function fetchCoinPrice(pq) {
  var cgKey = process.env.COINGECKO_API_KEY || '';
  var headers = { 'Accept': 'application/json' };
  if (cgKey) headers['x-cg-demo-api-key'] = cgKey;
  var url = 'https://api.coingecko.com/api/v3/simple/price'
    + '?ids=' + pq.coinId
    + '&vs_currencies=usd,idr,btc'
    + '&include_24hr_change=true'
    + '&include_market_cap=true'
    + '&precision=8';
  var resp = await axios.get(url, { headers: headers, timeout: 8000 });
  var d = resp.data[pq.coinId];
  if (!d) throw new Error('Data tidak ditemukan');
  var sym = pq.sym.toUpperCase();
  var usd = d.usd;
  var idr = d.idr;
  var chg = d.usd_24h_change;
  var mcap = d.usd_market_cap;
  var chgStr = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : 'N/A';
  var usdStr = usd >= 1 ? usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : usd.toPrecision(6);
  var idrStr = 'Rp ' + Math.round(idr).toLocaleString('id-ID');
  var mcapStr = mcap ? '$' + (mcap / 1e9).toFixed(2) + 'B' : 'N/A';
  var arrow = chg != null ? (chg >= 0 ? '**UP**' : '**DOWN**') : '';
  return '**$' + sym + '** ' + arrow + ' ' + chgStr + ' (24 jam)\n'
    + 'USD: $' + usdStr + '\n'
    + 'IDR: ' + idrStr + '\n'
    + 'Market Cap: ' + mcapStr + '\n'
    + '_(via CoinGecko)_';
}

async function fetchCryptoConversion(conv) {
  var amount = conv.amount;
  var from = conv.from;
  var to = conv.to;
  var coinId = conv.coinId;
  if (!from || !to) throw new Error('Data konversi tidak lengkap');
  var fromSym = from.toUpperCase();
  var toSym = to.toUpperCase();
  var cgKey = process.env.COINGECKO_API_KEY || '';

  // DexScreener path: token micro-cap yang tidak ada di CoinGecko
  if (conv.dexInfo) {
    var dexPriceUsd = conv.dexInfo.priceUsd;
    var targetRate = 1;
    if (to !== 'usd') {
      var rateHeaders = { 'Accept': 'application/json' };
      if (cgKey) rateHeaders['x-cg-demo-api-key'] = cgKey;
      var rateResp = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=' + to + '&precision=6',
        { headers: rateHeaders, timeout: 6000 }
      );
      var rateData = rateResp.data && rateResp.data['tether'];
      targetRate = (rateData && rateData[to]) ? rateData[to] : 1;
    }
    var priceInTarget = dexPriceUsd * targetRate;
    var resultInTarget = amount * priceInTarget;
    var dexSrc = (conv.dexInfo.dex || 'dex') + '/' + (conv.dexInfo.chain || 'chain');
    var dl1 = '**' + amount + ' $' + fromSym + ' ke ' + toSym + ' = ' + formatCryptoAmount(resultInTarget, to) + '**';
    var dl2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(priceInTarget, to);
    return dl1 + '\n' + dl2 + '\n_(via DexScreener - ' + dexSrc + ', harga real-time)_';
  }

  // CoinGecko path
  var toCoinId = conv.toCoinId || COIN_ID_MAP[to] || null;
  var toIsVsCurrency = SUPPORTED_VS.has(to);
  var ids = coinId;
  var vsCurrencies = to;
  if (!toIsVsCurrency && toCoinId) {
    ids = coinId + ',' + toCoinId;
    vsCurrencies = 'usd';
  }
  var cgUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=' + vsCurrencies + '&precision=8';
  var cgHeaders = { 'Accept': 'application/json' };
  if (cgKey) cgHeaders['x-cg-demo-api-key'] = cgKey;
  var resp = await axios.get(cgUrl, { headers: cgHeaders, timeout: 8000 });
  var data = resp.data;
  var result, line1, line2;
  if (!toIsVsCurrency && toCoinId) {
    var fromUsd = data[coinId] && data[coinId]['usd'];
    var toUsd = data[toCoinId] && data[toCoinId]['usd'];
    if (!fromUsd || !toUsd) throw new Error('Data harga tidak tersedia');
    result = (amount * fromUsd) / toUsd;
    line1 = '**' + amount + ' $' + fromSym + ' ke $' + toSym + ' = ' + formatCryptoAmount(result, to) + '**';
    line2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(fromUsd / toUsd, to);
  } else {
    var price = data[coinId] && data[coinId][to];
    if (price == null) throw new Error('Data harga tidak tersedia');
    result = amount * price;
    line1 = '**' + amount + ' $' + fromSym + ' ke ' + toSym + ' = ' + formatCryptoAmount(result, to) + '**';
    line2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(price, to);
  }
  return line1 + '\n' + line2 + '\n_(via CoinGecko, harga real-time)_';
}

// ============================================================
// GITHUB EDIT
// ============================================================

function parseGitHubFileRef(text) {
  const urlMatch = text.match(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([^/\s]+)\/([^\s?#]+)/i);
  if (urlMatch) {
    return {
      owner: urlMatch[1], repo: urlMatch[2],
      branch: urlMatch[3], path: decodeURIComponent(urlMatch[4]),
      raw: urlMatch[0],
    };
  }
  const shortMatch = text.match(/\b([\w.-]+)\/([\w.-]+):([\w\-./]+\.[a-zA-Z0-9]+)\b/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], branch: null, path: shortMatch[3], raw: shortMatch[0] };
  }
  return null;
}

function friendlyGitHubError(err, ref) {
  const status = err.response?.status;
  const apiMsg = err.response?.data?.message || err.message;
  console.error('[bot] GitHub edit gagal:', status, apiMsg);
  if (status === 404) return `⚠️ Repo/file tidak ditemukan: \`${ref.owner}/${ref.repo}\` path \`${ref.path}\`. Cek nama repo, path, dan branch-nya.`;
  if (status === 401 || status === 403) return '⚠️ Bot tidak punya izin menulis ke repo ini. Pastikan `GITHUB_TOKEN` punya scope **repo** atau permission **Contents: Read and write**.';
  if (status === 409) return '⚠️ Konflik: file sudah berubah sejak terakhir dibaca (sha mismatch). Kirim ulang permintaannya.';
  if (status === 422) return `⚠️ Gagal commit (422): ${apiMsg}. Cek apakah nama branch/path valid.`;
  return `⚠️ Gagal edit file GitHub. (${status || 'error'}: ${apiMsg})`;
}

async function handleGitHubEdit(message, ref, question, history, isDMOwner) {
  let branch = ref.branch;
  try {
    if (!branch) branch = await getDefaultBranch(ref.owner, ref.repo);
    const { content: oldContent, sha } = await getGitHubFileContent(ref.owner, ref.repo, ref.path, branch);

    const instruction = question.replace(ref.raw, '').trim()
      || 'Periksa file ini, identifikasi error/masalahnya, lalu perbaiki dan rapikan.';

    const prompt = `${instruction}\n\nIni isi file "${ref.path}" saat ini dari repo ${ref.owner}/${ref.repo} (branch ${branch}). `
      + `Berikan versi LENGKAP file yang sudah diperbaiki dalam SATU code block saja — jangan dipotong, jangan ada penjelasan di luar code block selain ringkasan singkat 1-2 kalimat sebelum code block:\n\n`
      + `\`\`\`\n${oldContent}\n\`\`\``;

    const { text } = await askGemini(prompt, history, isDMOwner);

    // [FIX] Deteksi hallusinasi di respons GitHub edit
    if (containsHallucination(text)) {
      await message.reply('⚠️ AI tidak memberikan kode yang valid. Coba kirim ulang permintaannya dengan instruksi lebih spesifik.');
      return;
    }

    const blocks = extractCodeBlocks(text);
    if (!blocks.length) {
      await message.reply('⚠️ AI tidak mengembalikan kode dalam format yang bisa diproses ke GitHub. Coba ulangi dengan instruksi yang lebih spesifik.');
      return;
    }
    const newContent = blocks.reduce((a, b) => (b.code.length > a.code.length ? b : a)).code;

    // [FIX] Validasi kode yang akan di-commit
    if (!isValidCodeBlock(newContent)) {
      await message.reply('⚠️ Kode yang dihasilkan AI terlihat tidak lengkap (terlalu pendek atau mengandung placeholder). Coba kirim ulang.');
      return;
    }

    const commitMessage = `Auto-edit via Discord bot: ${instruction.slice(0, 60)}`;
    const result = await commitGitHubFile(ref.owner, ref.repo, ref.path, newContent, commitMessage, sha, branch);
    const summary = stripCodeBlocks(text).slice(0, 600);

    // [FIX] Gunakan nama file lengkap dari path, bukan hanya pop() terakhir
    const replyFilename = ref.path.includes('/') ? ref.path.split('/').slice(-1)[0] : ref.path;

    await message.reply({
      content: [
        `✅ File **${ref.path}** di **${ref.owner}/${ref.repo}** (branch \`${branch}\`) berhasil diupdate.`,
        result.commitUrl ? `🔗 Commit: <${result.commitUrl}>` : '',
        summary,
      ].filter(Boolean).join('\n').slice(0, 2000),
      files: [makeFile(newContent, replyFilename)],
      flags: MessageFlags.SuppressEmbeds,
    });
  } catch (err) {
    await message.reply(friendlyGitHubError(err, ref)).catch(() => {});
  }
}

// ============================================================
// PROSES FILE SATU PER SATU
// [FIX BARU] Jika total ukuran file melebihi threshold, proses tiap file secara terpisah
// agar tidak melebihi context window AI dan mencegah truncate/hallusinasi.
// ============================================================

async function processSingleFile(message, att, content, question, history, isDMOwner) {
  const instruction = question
    || 'Periksa file ini, identifikasi semua error/masalahnya, lalu perbaiki dan berikan versi LENGKAP yang sudah diperbaiki dalam satu code block.';

  const finalQuestion = `${instruction}\n\n// === File: ${att.name} ===\n${content}`;

  const { text } = await askGemini(finalQuestion, history, isDMOwner);

  // Deteksi hallusinasi
  if (containsHallucination(text)) {
    await message.reply(`⚠️ AI memberikan respons yang tidak valid untuk **${att.name}**. Coba kirim file ini sendiri tanpa file lain.`);
    return;
  }

  const blocks = extractCodeBlocks(text);
  const validBlocks = blocks.filter((b) => isValidCodeBlock(b.code));

  if (validBlocks.length === 0) {
    const explanation = stripCodeBlocks(text).slice(0, 1800);
    await message.reply({
      content: (`**${att.name}:**\n${explanation || '⚠️ AI tidak menghasilkan kode valid untuk file ini.'}`).slice(0, 2000),
      flags: MessageFlags.SuppressEmbeds,
    });
    return;
  }

  const bestBlock = validBlocks.reduce((a, b) => (b.code.length > a.code.length ? b : a));
  const explanation = stripCodeBlocks(text).slice(0, 800);

  await message.reply({
    content: (`✅ **${att.name}** sudah diperbaiki.\n` + (explanation || '')).slice(0, 2000),
    files: [makeFile(bestBlock.code, att.name)],
    flags: MessageFlags.SuppressEmbeds,
  });
}

// ============================================================
// HANDLER UTAMA
// ============================================================


// ============================================================
// HANDLER UTAMA
// ============================================================

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    const isDM = !message.guild;
    const mentioned = message.mentions.users.has(client.user.id);

    // === Crypto/price tanpa tag: "5k usdc to idr" atau "price btc" ===
    if (!mentioned && !isDM) {
      var rawText = message.content.trim();
      var noTagConv = await detectCryptoConversion(rawText);
      var noTagPrice = !noTagConv ? detectPriceQuery(rawText) : null;
      if (noTagConv || noTagPrice) {
        await message.channel.sendTyping().catch(() => {});
        try {
          var noTagResult = noTagConv
            ? await fetchCryptoConversion(noTagConv)
            : await fetchCoinPrice(noTagPrice);
          await message.reply({
            content: noTagResult,
            components: [makeDeleteRow(message.author.id)],
            flags: MessageFlags.SuppressEmbeds,
          });
        } catch (e) {
          await message.reply('Gagal ambil data: ' + e.message).catch(() => {});
        }
      }
      // === Twitter history tanpa tag: "twit monad" ===
      var noTagTwit = detectTwitterQuery(rawText);
      if (noTagTwit) {
        await message.channel.sendTyping().catch(() => {});
        try {
          var noTagTwitResult = await fetchTwitterHistory(noTagTwit.usernames);
          await message.reply({
            content: noTagTwitResult.slice(0, 2000),
            components: [makeDeleteRow(message.author.id)],
            flags: MessageFlags.SuppressEmbeds,
          });
        } catch (e) {
          await message.reply('Gagal ambil data Twitter: ' + e.message).catch(() => {});
        }
        return;
      }

            // === Chart command tanpa tag: C BTC / C ETH 4h / C ETH 4h 30 ===
      var chartRawMatch = rawText.match(/^c\s+([a-zA-Z]+)(?:\s+(1m|5m|15m|30m|1h|2h|4h|6h|1d|1w))?(?:\s+(\d+))?$/i);
      if (chartRawMatch) {
        await message.channel.sendTyping().catch(() => {});
        try {
          await handleChartCommand(message, chartRawMatch[1], chartRawMatch[2] || '4h', chartRawMatch[3]);
        } catch (e) {
          await message.reply('Gagal buat chart: ' + e.message).catch(() => {});
        }
        return;
      }
      return;
    }

    if (isDM && message.author.id !== OWNER_ID) {
      await message.reply('⛔ Maaf, DM bot ini hanya bisa digunakan oleh owner.');
      return;
    }

    const isDMOwner = isDM && message.author.id === OWNER_ID;
    const historyKey = isDMOwner ? `dm-${message.author.id}` : `ch-${message.channelId}`;

    // Bootstrap history dari Discord saat pertama kali aktif setelah restart
    await bootstrapHistory(historyKey, message.channel, isDMOwner);

    const mentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
    const question = message.content.replace(mentionRegex, '').trim();

    const maxFiles = isDMOwner ? MAX_FILES_DM : MAX_FILES_CH;
    const fileAttachments = [...message.attachments.values()]
      .filter((a) => TEXT_FILE_EXTENSIONS.includes(getExt(a.name)))
      .slice(0, maxFiles);

    if (!question && fileAttachments.length === 0) {
      await message.reply('Halo! Tag aku lalu tulis pertanyaanmu, lampirkan file untuk diperiksa/diperbaiki, kirim link GitHub untuk edit repo, atau minta aku buatkan gambar. 👋');
      return;
    }

    // === Perintah !delete [n] (hanya owner) ===
    if (message.author.id === OWNER_ID && /^!delete\s+\d+$/i.test(question)) {
      const n = Math.min(parseInt(question.split(/\s+/)[1], 10), 100);
      console.log(`[bot] !delete dipanggil oleh owner, n=${n}`);
      // Coba hapus pesan perintah owner
      message.delete().catch(() => {});
      // Fetch pesan recent, filter hanya pesan milik bot
      const fetched = await message.channel.messages.fetch({ limit: 100 });
      const mine = [...fetched.values()]
        .filter(m => m.author.id === client.user.id)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .slice(0, n);
      console.log(`[bot] !delete: ditemukan ${mine.length} pesan milik bot`);
      for (const m of mine) {
        await m.delete().catch(e => console.warn(`[bot] gagal hapus ${m.id}: ${e.message}`));
        await new Promise(r => setTimeout(r, 500));
      }
      console.log(`[bot] !delete: selesai hapus ${mine.length} pesan`);
      return;
    }

    // === Perintah !ClearHistory ===
    if (question.toLowerCase() === '!clearhistory') {
      const hadHistory = !!(allHistory[historyKey] && allHistory[historyKey].length > 0);
      clearHistory(historyKey);
      await message.reply(hadHistory
        ? '🗑️ Riwayat percakapan sesi ini sudah dihapus. Kita mulai dari awal!'
        : '✅ Tidak ada riwayat yang perlu dihapus untuk sesi ini.');
      return;
    }

    // === Deteksi konversi crypto (misal: "5k usdc to idr") ===
    var cryptoConv = await detectCryptoConversion(question);
    if (cryptoConv) {
      if (cryptoConv.notFound) {
        await message.reply({ content: '❌ Token **' + cryptoConv.from.toUpperCase() + '** tidak ditemukan di CoinGecko. Coba cek simbol tokennya.', flags: MessageFlags.SuppressEmbeds });
        return;
      }
      await message.channel.sendTyping().catch(() => {});
      try {
        var convResult = await fetchCryptoConversion(cryptoConv);
        await message.reply({
          content: convResult,
          components: [makeDeleteRow(message.author.id)],
          flags: MessageFlags.SuppressEmbeds,
        });
      } catch (e) {
        await message.reply('Gagal ambil harga: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Deteksi price query (misal: "price btc" atau "p eth") ===
    var priceQ = detectPriceQuery(question);
    if (priceQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var priceResult = await fetchCoinPrice(priceQ);
        await message.reply({ content: priceResult, flags: MessageFlags.SuppressEmbeds });
      } catch (e) {
        await message.reply('Gagal ambil harga: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Twitter login: "twit login" di DM untuk dapatkan token memory.lol ===
    if (isDMOwner && question.toLowerCase() === 'twit login') {
      try {
        const codeResp = await axios.post(
          'https://github.com/login/device/code',
          'client_id=b8ab5a8c1a2745d514b7',
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 10000 }
        );
        const { device_code, user_code, verification_uri, expires_in, interval } = codeResp.data;
        await message.reply(
          '\uD83D\uDD12 **Login ke memory.lol untuk akses full history**\n\n'
          + '1. Buka: **' + verification_uri + '**\n'
          + '2. Masukkan kode: **' + user_code + '**\n'
          + '3. Klik Authorize\n'
          + '4. Balik ke sini dan ketik **twit token** (bot akan cek otomatis)\n\n'
          + '_(Kode berlaku ' + Math.round(expires_in / 60) + ' menit)_'
        );
        // Simpan device_code sementara di memory untuk polling
        if (!global._twitDeviceFlow) global._twitDeviceFlow = {};
        global._twitDeviceFlow[message.author.id] = { device_code, interval: interval || 5, expires: Date.now() + expires_in * 1000 };
      } catch (e) {
        await message.reply('\u274C Gagal mulai login: ' + e.message);
      }
      return;
    }

    // === Twitter token poll: "twit token" setelah authorize ===
    if (isDMOwner && question.toLowerCase() === 'twit token') {
      const flow = global._twitDeviceFlow && global._twitDeviceFlow[message.author.id];
      if (!flow) {
        await message.reply('\u274C Tidak ada sesi login aktif. Ketik **twit login** terlebih dahulu.');
        return;
      }
      if (Date.now() > flow.expires) {
        await message.reply('\u23F0 Kode sudah kedaluwarsa. Ketik **twit login** untuk mulai ulang.');
        return;
      }
      try {
        const tokenResp = await axios.post(
          'https://github.com/login/oauth/access_token',
          'device_code=' + flow.device_code + '&client_id=b8ab5a8c1a2745d514b7&grant_type=urn:ietf:params:oauth:grant-type:device_code',
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 10000 }
        );
        const { access_token, error } = tokenResp.data;
        if (error === 'authorization_pending') {
          await message.reply('\u23F3 Belum diauthorize. Selesaikan langkah di browser dulu, lalu ketik **twit token** lagi.');
          return;
        }
        if (!access_token) {
          await message.reply('\u274C Gagal ambil token: ' + (error || 'unknown error'));
          return;
        }
        // Coba autentikasi ke memory.lol
        const mlResp = await axios.post(
          'https://api.memory.lol/v1/login/status',
          'token=' + encodeURIComponent(access_token),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        ).catch(() => null);
        delete global._twitDeviceFlow[message.author.id];
        await message.reply(
          '\u2705 Token berhasil didapat!\n\n'
          + 'Set environment variable berikut di Railway/Fly.io/host kamu:\n'
          + '```\nMEMORYLOL_TOKEN=' + access_token + '\n```\n'
          + '\u26A0\uFE0F Jika akunmu **belum diapprove** oleh pemilik memory.lol, akses tetap terbatas 60 hari.\n'
          + 'Hubungi [@travisbrown](https://twitter.com/travisbrown) untuk minta full access.'
        );
      } catch (e) {
        await message.reply('\u274C Error: ' + e.message);
      }
      return;
    }

        // === Twitter history dengan mention: "@bot twit monad" ===
    var twitQ = detectTwitterQuery(question);
    if (twitQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var twitResult = await fetchTwitterHistory(twitQ.usernames);
        await message.reply({
          content: twitResult.slice(0, 2000),
          components: [makeDeleteRow(message.author.id)],
          flags: MessageFlags.SuppressEmbeds,
        });
      } catch (e) {
        await message.reply('Gagal ambil data Twitter: ' + e.message).catch(() => {});
      }
      return;
    }

        // === Chart command dengan mention: @bot C BTC / @bot C ETH 4h / @bot C ETH 4h 30 ===
    const chartM = question.match(/^c\s+([a-zA-Z]+)(?:\s+(1m|5m|15m|30m|1h|2h|4h|6h|1d|1w))?(?:\s+(\d+))?$/i);
    if (chartM) {
      await message.channel.sendTyping().catch(() => {});
      try {
        await handleChartCommand(message, chartM[1], chartM[2] || '4h', chartM[3]);
      } catch (e) {
        await message.reply('Gagal buat chart: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Mode edit file GitHub langsung ===
    const ghRef = parseGitHubFileRef(question);
    if (ghRef) {
      await message.channel.sendTyping().catch(() => {});
      const history = getHistoryForAI(historyKey, isDMOwner);
      await handleGitHubEdit(message, ghRef, question, history, isDMOwner);
      return;
    }

    await message.channel.sendTyping().catch(() => {});

    // === Mode gambar (hanya kalau tidak ada file dilampirkan) ===
    if (fileAttachments.length === 0 && isImageRequest(question)) {
      const { imageBuffer, text } = await generateImage(question);
      if (imageBuffer) {
        await message.reply({
          content: (text || `Nih hasil gambarnya: "${question}"`).slice(0, 2000),
          files: [makeFile(imageBuffer, 'hasil.png')],
        });
        return;
      }
      // Kalau generate gambar gagal, jatuh ke mode teks biasa.
    }

    // ============================================================
    // [FIX] Cek total ukuran file sebelum gabung ke satu prompt.
    // Kalau terlalu besar, proses satu per satu agar AI tidak truncate.
    // ============================================================
    if (fileAttachments.length > 0) {
      const totalSize = fileAttachments.reduce((sum, a) => sum + a.size, 0);

      // Download semua file dulu
      const loadedFiles = [];
      for (const att of fileAttachments) {
        try {
          const content = await downloadAttachmentText(att);
          loadedFiles.push({ att, content });
        } catch (e) {
          await message.reply(`⚠️ Gagal membaca **${att.name}**: ${e.message}`).catch(() => {});
        }
      }

      if (loadedFiles.length === 0) return;

      const history = getHistoryForAI(historyKey, isDMOwner);

      // Jika total file > 30KB ATAU ada lebih dari 1 file yang masing-masing > 15KB,
      // proses satu per satu untuk hindari context overflow
      const shouldSplitProcess = totalSize > MAX_TOTAL_BYTES_COMBINED
        || (loadedFiles.length > 1 && loadedFiles.some((f) => f.att.size > 15 * 1024));

      if (shouldSplitProcess && isDMOwner) {
        // Mode split: proses tiap file terpisah
        await message.reply(
          `📂 File terlalu besar untuk diproses sekaligus (total ${Math.round(totalSize / 1024)}KB). Memproses **${loadedFiles.length} file satu per satu**...`
        ).catch(() => {});

        for (const { att, content } of loadedFiles) {
          await message.channel.sendTyping().catch(() => {});
          await processSingleFile(message, att, content, question, history, isDMOwner);
        }

        // Simpan history — hanya nama file, bukan isi
        const fileNames = loadedFiles.map((f) => f.att.name).join(', ');
        await pushHistory(historyKey, `${question || 'cek file'} [File: ${fileNames}]`, '[File diproses satu per satu]', isDMOwner);
        return;
      }

      // Proses gabung (file kecil atau channel)
      const fileParts = [];
      const fileNames = [];
      const originalFileNames = [];

      for (const { att, content } of loadedFiles) {
        fileParts.push(`// === File: ${att.name} ===\n${content}`);
        fileNames.push(att.name);
        originalFileNames.push(att.name);
      }

      const instruction = question
        || 'Periksa semua file yang dilampirkan, identifikasi semua error/masalahnya, lalu perbaiki dan berikan versi LENGKAP yang sudah diperbaiki dalam code block terpisah untuk tiap file.';

      const finalQuestion = `${instruction}\n\n${fileParts.join('\n\n')}`;
      const historyUserContent = `${instruction} [File: ${fileNames.join(', ')}]`;

      const { text, sources } = await askGemini(finalQuestion, history, isDMOwner);

      // [FIX] Deteksi hallusinasi sebelum proses respons
      if (containsHallucination(text)) {
        await message.reply(
          '⚠️ AI tidak dapat memproses file sebesar ini sekaligus. Coba kirim **satu file** saja agar hasilnya akurat.'
        );
        return;
      }

      await pushHistory(historyKey, historyUserContent, text, isDMOwner);

      const blocks = extractCodeBlocks(text);

      if (shouldSendAsFile(question, blocks, isDMOwner)) {
        await replyWithFiles(message, text, blocks, originalFileNames);
        return;
      }

      await sendLongReply(message, formatAnswer(text, sources));
      return;
    }

    // === Pertanyaan teks biasa (tanpa file) ===
    let finalQuestion = question;
    const historyUserContent = question;

    // === Token scam/analisis skill ===
    if (isScamAnalysisRequest(question)) {
      await message.channel.sendTyping().catch(() => {});
      try {
        const scamResult = await runScamAnalysis(question);
        finalQuestion = scamResult.fullPrompt;
      } catch (e) {
        console.error('[bot] scamAnalysis error:', e.message);
        // fall through to normal AI
      }
    }

    const history = getHistoryForAI(historyKey, isDMOwner);
    const { text, sources } = await askGemini(finalQuestion, history, isDMOwner);

    await pushHistory(historyKey, historyUserContent, text, isDMOwner);

    const blocks = extractCodeBlocks(text);

    if (shouldSendAsFile(question, blocks, isDMOwner)) {
      await replyWithFiles(message, text, blocks, []);
      return;
    }

    await sendLongReply(message, formatAnswer(text, sources));
  } catch (err) {
    console.error('[bot] Error di messageCreate:', err);
    await message.reply(friendlyError(err)).catch(() => {});
  }
});

// ============================================================
// LOGIN
// ============================================================

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('[bot] DISCORD_TOKEN belum di-set. Set env DISCORD_TOKEN dengan Bot Token dari Developer Portal.');
  process.exit(1);
}

// ============================================================
// TOMBOL DELETE — hanya user pengirim yang bisa klik
// ============================================================
client.on('interactionCreate', async (interaction) => {
  console.log('[btn] interactionCreate fired, type:', interaction.type, 'isButton:', interaction.isButton?.());
  try {
    if (!interaction.isButton()) return;
    console.log('[btn] customId:', interaction.customId, 'userId:', interaction.user?.id);
    if (!interaction.customId.startsWith('del_')) return;

    const ownerId = interaction.customId.slice(4);
    console.log('[btn] ownerId:', ownerId, 'clickerId:', interaction.user.id);

    if (interaction.user.id !== ownerId) {
      console.log('[btn] bukan pemilik, tolak');
      await interaction.reply({
        content: '⛔ Hanya pengirim pesan asli yang bisa menghapus ini.',
        ephemeral: true,
      });
      return;
    }

    // deferUpdate = silent ACK ke Discord (paling cepat, tidak buat pesan baru)
    console.log('[btn] deferUpdate...');
    await interaction.deferUpdate();
    console.log('[btn] deferUpdate OK, deleting message...');

    await interaction.message.delete();
    console.log('[btn] message deleted OK');
  } catch (err) {
    console.error('[btn] ERROR:', err.message, err.stack);
    // Coba reply jika belum di-acknowledge
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '⚠️ Gagal hapus: ' + err.message, ephemeral: true });
      }
    } catch (_) {}
  }
});


client.login(token);
 + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return '(userId) {
  const btn = new ButtonBuilder()
    .setCustomId('del_' + userId)
    .setLabel('Hapus')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder().addComponents(btn);
}

async function detectCryptoConversion(question) {
  var m = question.match(/^([\d.,]+[kmb]?)\s+([a-zA-Z]+)\s+(?:to|ke)\s+([a-zA-Z]+)$/i);
  if (!m) return null;
  var amount = parseConvAmount(m[1]);
  var from = m[2].toLowerCase();
  var to = m[3].toLowerCase();
  if (isNaN(amount) || amount <= 0) return null;
  // Resolusi: COIN_ID_MAP -> cache -> CoinGecko /search -> DexScreener
  var coinId = await resolveCoinId(from);
  if (!coinId) {
    var dexInfo = await resolveDexPrice(from);
    if (!dexInfo) return { notFound: true, from: from, to: to };
    if (!SUPPORTED_VS.has(to)) return { notFound: true, from: from, to: to };
    return { amount: amount, from: from, to: to, coinId: null, dexInfo: dexInfo };
  }
  var toIsVs = SUPPORTED_VS.has(to);
  var toCoinId = toIsVs ? null : await resolveCoinId(to);
  if (!toIsVs && !toCoinId) return null;
  return { amount: amount, from: from, to: to, coinId: coinId, toCoinId: toCoinId };
}

// Deteksi: "price btc" atau "p eth" (tanpa tag bot)
function detectPriceQuery(text) {
  var m = text.match(/^(?:price|p)\s+([a-zA-Z]+)$/i);
  if (!m) return null;
  var sym = m[1].toLowerCase();
  var coinId = COIN_ID_MAP[sym];
  if (!coinId) return null;
  return { sym: sym, coinId: coinId };
}

async function fetchCoinPrice(pq) {
  var cgKey = process.env.COINGECKO_API_KEY || '';
  var headers = { 'Accept': 'application/json' };
  if (cgKey) headers['x-cg-demo-api-key'] = cgKey;
  var url = 'https://api.coingecko.com/api/v3/simple/price'
    + '?ids=' + pq.coinId
    + '&vs_currencies=usd,idr,btc'
    + '&include_24hr_change=true'
    + '&include_market_cap=true'
    + '&precision=8';
  var resp = await axios.get(url, { headers: headers, timeout: 8000 });
  var d = resp.data[pq.coinId];
  if (!d) throw new Error('Data tidak ditemukan');
  var sym = pq.sym.toUpperCase();
  var usd = d.usd;
  var idr = d.idr;
  var chg = d.usd_24h_change;
  var mcap = d.usd_market_cap;
  var chgStr = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : 'N/A';
  var usdStr = usd >= 1 ? usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : usd.toPrecision(6);
  var idrStr = 'Rp ' + Math.round(idr).toLocaleString('id-ID');
  var mcapStr = mcap ? '$' + (mcap / 1e9).toFixed(2) + 'B' : 'N/A';
  var arrow = chg != null ? (chg >= 0 ? '**UP**' : '**DOWN**') : '';
  return '**$' + sym + '** ' + arrow + ' ' + chgStr + ' (24 jam)\n'
    + 'USD: $' + usdStr + '\n'
    + 'IDR: ' + idrStr + '\n'
    + 'Market Cap: ' + mcapStr + '\n'
    + '_(via CoinGecko)_';
}

async function fetchCryptoConversion(conv) {
  var amount = conv.amount;
  var from = conv.from;
  var to = conv.to;
  var coinId = conv.coinId;
  if (!from || !to) throw new Error('Data konversi tidak lengkap');
  var fromSym = from.toUpperCase();
  var toSym = to.toUpperCase();
  var cgKey = process.env.COINGECKO_API_KEY || '';

  // DexScreener path: token micro-cap yang tidak ada di CoinGecko
  if (conv.dexInfo) {
    var dexPriceUsd = conv.dexInfo.priceUsd;
    var targetRate = 1;
    if (to !== 'usd') {
      var rateHeaders = { 'Accept': 'application/json' };
      if (cgKey) rateHeaders['x-cg-demo-api-key'] = cgKey;
      var rateResp = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=' + to + '&precision=6',
        { headers: rateHeaders, timeout: 6000 }
      );
      var rateData = rateResp.data && rateResp.data['tether'];
      targetRate = (rateData && rateData[to]) ? rateData[to] : 1;
    }
    var priceInTarget = dexPriceUsd * targetRate;
    var resultInTarget = amount * priceInTarget;
    var dexSrc = (conv.dexInfo.dex || 'dex') + '/' + (conv.dexInfo.chain || 'chain');
    var dl1 = '**' + amount + ' $' + fromSym + ' ke ' + toSym + ' = ' + formatCryptoAmount(resultInTarget, to) + '**';
    var dl2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(priceInTarget, to);
    return dl1 + '\n' + dl2 + '\n_(via DexScreener - ' + dexSrc + ', harga real-time)_';
  }

  // CoinGecko path
  var toCoinId = conv.toCoinId || COIN_ID_MAP[to] || null;
  var toIsVsCurrency = SUPPORTED_VS.has(to);
  var ids = coinId;
  var vsCurrencies = to;
  if (!toIsVsCurrency && toCoinId) {
    ids = coinId + ',' + toCoinId;
    vsCurrencies = 'usd';
  }
  var cgUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=' + vsCurrencies + '&precision=8';
  var cgHeaders = { 'Accept': 'application/json' };
  if (cgKey) cgHeaders['x-cg-demo-api-key'] = cgKey;
  var resp = await axios.get(cgUrl, { headers: cgHeaders, timeout: 8000 });
  var data = resp.data;
  var result, line1, line2;
  if (!toIsVsCurrency && toCoinId) {
    var fromUsd = data[coinId] && data[coinId]['usd'];
    var toUsd = data[toCoinId] && data[toCoinId]['usd'];
    if (!fromUsd || !toUsd) throw new Error('Data harga tidak tersedia');
    result = (amount * fromUsd) / toUsd;
    line1 = '**' + amount + ' $' + fromSym + ' ke $' + toSym + ' = ' + formatCryptoAmount(result, to) + '**';
    line2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(fromUsd / toUsd, to);
  } else {
    var price = data[coinId] && data[coinId][to];
    if (price == null) throw new Error('Data harga tidak tersedia');
    result = amount * price;
    line1 = '**' + amount + ' $' + fromSym + ' ke ' + toSym + ' = ' + formatCryptoAmount(result, to) + '**';
    line2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(price, to);
  }
  return line1 + '\n' + line2 + '\n_(via CoinGecko, harga real-time)_';
}

// ============================================================
// GITHUB EDIT
// ============================================================

function parseGitHubFileRef(text) {
  const urlMatch = text.match(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([^/\s]+)\/([^\s?#]+)/i);
  if (urlMatch) {
    return {
      owner: urlMatch[1], repo: urlMatch[2],
      branch: urlMatch[3], path: decodeURIComponent(urlMatch[4]),
      raw: urlMatch[0],
    };
  }
  const shortMatch = text.match(/\b([\w.-]+)\/([\w.-]+):([\w\-./]+\.[a-zA-Z0-9]+)\b/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], branch: null, path: shortMatch[3], raw: shortMatch[0] };
  }
  return null;
}

function friendlyGitHubError(err, ref) {
  const status = err.response?.status;
  const apiMsg = err.response?.data?.message || err.message;
  console.error('[bot] GitHub edit gagal:', status, apiMsg);
  if (status === 404) return `⚠️ Repo/file tidak ditemukan: \`${ref.owner}/${ref.repo}\` path \`${ref.path}\`. Cek nama repo, path, dan branch-nya.`;
  if (status === 401 || status === 403) return '⚠️ Bot tidak punya izin menulis ke repo ini. Pastikan `GITHUB_TOKEN` punya scope **repo** atau permission **Contents: Read and write**.';
  if (status === 409) return '⚠️ Konflik: file sudah berubah sejak terakhir dibaca (sha mismatch). Kirim ulang permintaannya.';
  if (status === 422) return `⚠️ Gagal commit (422): ${apiMsg}. Cek apakah nama branch/path valid.`;
  return `⚠️ Gagal edit file GitHub. (${status || 'error'}: ${apiMsg})`;
}

async function handleGitHubEdit(message, ref, question, history, isDMOwner) {
  let branch = ref.branch;
  try {
    if (!branch) branch = await getDefaultBranch(ref.owner, ref.repo);
    const { content: oldContent, sha } = await getGitHubFileContent(ref.owner, ref.repo, ref.path, branch);

    const instruction = question.replace(ref.raw, '').trim()
      || 'Periksa file ini, identifikasi error/masalahnya, lalu perbaiki dan rapikan.';

    const prompt = `${instruction}\n\nIni isi file "${ref.path}" saat ini dari repo ${ref.owner}/${ref.repo} (branch ${branch}). `
      + `Berikan versi LENGKAP file yang sudah diperbaiki dalam SATU code block saja — jangan dipotong, jangan ada penjelasan di luar code block selain ringkasan singkat 1-2 kalimat sebelum code block:\n\n`
      + `\`\`\`\n${oldContent}\n\`\`\``;

    const { text } = await askGemini(prompt, history, isDMOwner);

    // [FIX] Deteksi hallusinasi di respons GitHub edit
    if (containsHallucination(text)) {
      await message.reply('⚠️ AI tidak memberikan kode yang valid. Coba kirim ulang permintaannya dengan instruksi lebih spesifik.');
      return;
    }

    const blocks = extractCodeBlocks(text);
    if (!blocks.length) {
      await message.reply('⚠️ AI tidak mengembalikan kode dalam format yang bisa diproses ke GitHub. Coba ulangi dengan instruksi yang lebih spesifik.');
      return;
    }
    const newContent = blocks.reduce((a, b) => (b.code.length > a.code.length ? b : a)).code;

    // [FIX] Validasi kode yang akan di-commit
    if (!isValidCodeBlock(newContent)) {
      await message.reply('⚠️ Kode yang dihasilkan AI terlihat tidak lengkap (terlalu pendek atau mengandung placeholder). Coba kirim ulang.');
      return;
    }

    const commitMessage = `Auto-edit via Discord bot: ${instruction.slice(0, 60)}`;
    const result = await commitGitHubFile(ref.owner, ref.repo, ref.path, newContent, commitMessage, sha, branch);
    const summary = stripCodeBlocks(text).slice(0, 600);

    // [FIX] Gunakan nama file lengkap dari path, bukan hanya pop() terakhir
    const replyFilename = ref.path.includes('/') ? ref.path.split('/').slice(-1)[0] : ref.path;

    await message.reply({
      content: [
        `✅ File **${ref.path}** di **${ref.owner}/${ref.repo}** (branch \`${branch}\`) berhasil diupdate.`,
        result.commitUrl ? `🔗 Commit: <${result.commitUrl}>` : '',
        summary,
      ].filter(Boolean).join('\n').slice(0, 2000),
      files: [makeFile(newContent, replyFilename)],
      flags: MessageFlags.SuppressEmbeds,
    });
  } catch (err) {
    await message.reply(friendlyGitHubError(err, ref)).catch(() => {});
  }
}

// ============================================================
// PROSES FILE SATU PER SATU
// [FIX BARU] Jika total ukuran file melebihi threshold, proses tiap file secara terpisah
// agar tidak melebihi context window AI dan mencegah truncate/hallusinasi.
// ============================================================

async function processSingleFile(message, att, content, question, history, isDMOwner) {
  const instruction = question
    || 'Periksa file ini, identifikasi semua error/masalahnya, lalu perbaiki dan berikan versi LENGKAP yang sudah diperbaiki dalam satu code block.';

  const finalQuestion = `${instruction}\n\n// === File: ${att.name} ===\n${content}`;

  const { text } = await askGemini(finalQuestion, history, isDMOwner);

  // Deteksi hallusinasi
  if (containsHallucination(text)) {
    await message.reply(`⚠️ AI memberikan respons yang tidak valid untuk **${att.name}**. Coba kirim file ini sendiri tanpa file lain.`);
    return;
  }

  const blocks = extractCodeBlocks(text);
  const validBlocks = blocks.filter((b) => isValidCodeBlock(b.code));

  if (validBlocks.length === 0) {
    const explanation = stripCodeBlocks(text).slice(0, 1800);
    await message.reply({
      content: (`**${att.name}:**\n${explanation || '⚠️ AI tidak menghasilkan kode valid untuk file ini.'}`).slice(0, 2000),
      flags: MessageFlags.SuppressEmbeds,
    });
    return;
  }

  const bestBlock = validBlocks.reduce((a, b) => (b.code.length > a.code.length ? b : a));
  const explanation = stripCodeBlocks(text).slice(0, 800);

  await message.reply({
    content: (`✅ **${att.name}** sudah diperbaiki.\n` + (explanation || '')).slice(0, 2000),
    files: [makeFile(bestBlock.code, att.name)],
    flags: MessageFlags.SuppressEmbeds,
  });
}

// ============================================================
// HANDLER UTAMA
// ============================================================


// ============================================================
// HANDLER UTAMA
// ============================================================

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    const isDM = !message.guild;
    const mentioned = message.mentions.users.has(client.user.id);

    // === Crypto/price tanpa tag: "5k usdc to idr" atau "price btc" ===
    if (!mentioned && !isDM) {
      var rawText = message.content.trim();
      var noTagConv = await detectCryptoConversion(rawText);
      var noTagPrice = !noTagConv ? detectPriceQuery(rawText) : null;
      if (noTagConv || noTagPrice) {
        await message.channel.sendTyping().catch(() => {});
        try {
          var noTagResult = noTagConv
            ? await fetchCryptoConversion(noTagConv)
            : await fetchCoinPrice(noTagPrice);
          await message.reply({
            content: noTagResult,
            components: [makeDeleteRow(message.author.id)],
            flags: MessageFlags.SuppressEmbeds,
          });
        } catch (e) {
          await message.reply('Gagal ambil data: ' + e.message).catch(() => {});
        }
      }
      // === Twitter history tanpa tag: "twit monad" ===
      var noTagTwit = detectTwitterQuery(rawText);
      if (noTagTwit) {
        await message.channel.sendTyping().catch(() => {});
        try {
          var noTagTwitResult = await fetchTwitterHistory(noTagTwit.usernames);
          await message.reply({
            content: noTagTwitResult.slice(0, 2000),
            components: [makeDeleteRow(message.author.id)],
            flags: MessageFlags.SuppressEmbeds,
          });
        } catch (e) {
          await message.reply('Gagal ambil data Twitter: ' + e.message).catch(() => {});
        }
        return;
      }

            // === Chart command tanpa tag: C BTC / C ETH 4h / C ETH 4h 30 ===
      var chartRawMatch = rawText.match(/^c\s+([a-zA-Z]+)(?:\s+(1m|5m|15m|30m|1h|2h|4h|6h|1d|1w))?(?:\s+(\d+))?$/i);
      if (chartRawMatch) {
        await message.channel.sendTyping().catch(() => {});
        try {
          await handleChartCommand(message, chartRawMatch[1], chartRawMatch[2] || '4h', chartRawMatch[3]);
        } catch (e) {
          await message.reply('Gagal buat chart: ' + e.message).catch(() => {});
        }
        return;
      }
      return;
    }

    if (isDM && message.author.id !== OWNER_ID) {
      await message.reply('⛔ Maaf, DM bot ini hanya bisa digunakan oleh owner.');
      return;
    }

    const isDMOwner = isDM && message.author.id === OWNER_ID;
    const historyKey = isDMOwner ? `dm-${message.author.id}` : `ch-${message.channelId}`;

    // Bootstrap history dari Discord saat pertama kali aktif setelah restart
    await bootstrapHistory(historyKey, message.channel, isDMOwner);

    const mentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
    const question = message.content.replace(mentionRegex, '').trim();

    const maxFiles = isDMOwner ? MAX_FILES_DM : MAX_FILES_CH;
    const fileAttachments = [...message.attachments.values()]
      .filter((a) => TEXT_FILE_EXTENSIONS.includes(getExt(a.name)))
      .slice(0, maxFiles);

    if (!question && fileAttachments.length === 0) {
      await message.reply('Halo! Tag aku lalu tulis pertanyaanmu, lampirkan file untuk diperiksa/diperbaiki, kirim link GitHub untuk edit repo, atau minta aku buatkan gambar. 👋');
      return;
    }

    // === Perintah !delete [n] (hanya owner) ===
    if (message.author.id === OWNER_ID && /^!delete\s+\d+$/i.test(question)) {
      const n = Math.min(parseInt(question.split(/\s+/)[1], 10), 100);
      console.log(`[bot] !delete dipanggil oleh owner, n=${n}`);
      // Coba hapus pesan perintah owner
      message.delete().catch(() => {});
      // Fetch pesan recent, filter hanya pesan milik bot
      const fetched = await message.channel.messages.fetch({ limit: 100 });
      const mine = [...fetched.values()]
        .filter(m => m.author.id === client.user.id)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .slice(0, n);
      console.log(`[bot] !delete: ditemukan ${mine.length} pesan milik bot`);
      for (const m of mine) {
        await m.delete().catch(e => console.warn(`[bot] gagal hapus ${m.id}: ${e.message}`));
        await new Promise(r => setTimeout(r, 500));
      }
      console.log(`[bot] !delete: selesai hapus ${mine.length} pesan`);
      return;
    }

    // === Perintah !ClearHistory ===
    if (question.toLowerCase() === '!clearhistory') {
      const hadHistory = !!(allHistory[historyKey] && allHistory[historyKey].length > 0);
      clearHistory(historyKey);
      await message.reply(hadHistory
        ? '🗑️ Riwayat percakapan sesi ini sudah dihapus. Kita mulai dari awal!'
        : '✅ Tidak ada riwayat yang perlu dihapus untuk sesi ini.');
      return;
    }

    // === Deteksi konversi crypto (misal: "5k usdc to idr") ===
    var cryptoConv = await detectCryptoConversion(question);
    if (cryptoConv) {
      if (cryptoConv.notFound) {
        await message.reply({ content: '❌ Token **' + cryptoConv.from.toUpperCase() + '** tidak ditemukan di CoinGecko. Coba cek simbol tokennya.', flags: MessageFlags.SuppressEmbeds });
        return;
      }
      await message.channel.sendTyping().catch(() => {});
      try {
        var convResult = await fetchCryptoConversion(cryptoConv);
        await message.reply({
          content: convResult,
          components: [makeDeleteRow(message.author.id)],
          flags: MessageFlags.SuppressEmbeds,
        });
      } catch (e) {
        await message.reply('Gagal ambil harga: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Deteksi price query (misal: "price btc" atau "p eth") ===
    var priceQ = detectPriceQuery(question);
    if (priceQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var priceResult = await fetchCoinPrice(priceQ);
        await message.reply({ content: priceResult, flags: MessageFlags.SuppressEmbeds });
      } catch (e) {
        await message.reply('Gagal ambil harga: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Twitter login: "twit login" di DM untuk dapatkan token memory.lol ===
    if (isDMOwner && question.toLowerCase() === 'twit login') {
      try {
        const codeResp = await axios.post(
          'https://github.com/login/device/code',
          'client_id=b8ab5a8c1a2745d514b7',
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 10000 }
        );
        const { device_code, user_code, verification_uri, expires_in, interval } = codeResp.data;
        await message.reply(
          '\uD83D\uDD12 **Login ke memory.lol untuk akses full history**\n\n'
          + '1. Buka: **' + verification_uri + '**\n'
          + '2. Masukkan kode: **' + user_code + '**\n'
          + '3. Klik Authorize\n'
          + '4. Balik ke sini dan ketik **twit token** (bot akan cek otomatis)\n\n'
          + '_(Kode berlaku ' + Math.round(expires_in / 60) + ' menit)_'
        );
        // Simpan device_code sementara di memory untuk polling
        if (!global._twitDeviceFlow) global._twitDeviceFlow = {};
        global._twitDeviceFlow[message.author.id] = { device_code, interval: interval || 5, expires: Date.now() + expires_in * 1000 };
      } catch (e) {
        await message.reply('\u274C Gagal mulai login: ' + e.message);
      }
      return;
    }

    // === Twitter token poll: "twit token" setelah authorize ===
    if (isDMOwner && question.toLowerCase() === 'twit token') {
      const flow = global._twitDeviceFlow && global._twitDeviceFlow[message.author.id];
      if (!flow) {
        await message.reply('\u274C Tidak ada sesi login aktif. Ketik **twit login** terlebih dahulu.');
        return;
      }
      if (Date.now() > flow.expires) {
        await message.reply('\u23F0 Kode sudah kedaluwarsa. Ketik **twit login** untuk mulai ulang.');
        return;
      }
      try {
        const tokenResp = await axios.post(
          'https://github.com/login/oauth/access_token',
          'device_code=' + flow.device_code + '&client_id=b8ab5a8c1a2745d514b7&grant_type=urn:ietf:params:oauth:grant-type:device_code',
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 10000 }
        );
        const { access_token, error } = tokenResp.data;
        if (error === 'authorization_pending') {
          await message.reply('\u23F3 Belum diauthorize. Selesaikan langkah di browser dulu, lalu ketik **twit token** lagi.');
          return;
        }
        if (!access_token) {
          await message.reply('\u274C Gagal ambil token: ' + (error || 'unknown error'));
          return;
        }
        // Coba autentikasi ke memory.lol
        const mlResp = await axios.post(
          'https://api.memory.lol/v1/login/status',
          'token=' + encodeURIComponent(access_token),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        ).catch(() => null);
        delete global._twitDeviceFlow[message.author.id];
        await message.reply(
          '\u2705 Token berhasil didapat!\n\n'
          + 'Set environment variable berikut di Railway/Fly.io/host kamu:\n'
          + '```\nMEMORYLOL_TOKEN=' + access_token + '\n```\n'
          + '\u26A0\uFE0F Jika akunmu **belum diapprove** oleh pemilik memory.lol, akses tetap terbatas 60 hari.\n'
          + 'Hubungi [@travisbrown](https://twitter.com/travisbrown) untuk minta full access.'
        );
      } catch (e) {
        await message.reply('\u274C Error: ' + e.message);
      }
      return;
    }

        // === Twitter history dengan mention: "@bot twit monad" ===
    var twitQ = detectTwitterQuery(question);
    if (twitQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var twitResult = await fetchTwitterHistory(twitQ.usernames);
        await message.reply({
          content: twitResult.slice(0, 2000),
          components: [makeDeleteRow(message.author.id)],
          flags: MessageFlags.SuppressEmbeds,
        });
      } catch (e) {
        await message.reply('Gagal ambil data Twitter: ' + e.message).catch(() => {});
      }
      return;
    }

        // === Chart command dengan mention: @bot C BTC / @bot C ETH 4h / @bot C ETH 4h 30 ===
    const chartM = question.match(/^c\s+([a-zA-Z]+)(?:\s+(1m|5m|15m|30m|1h|2h|4h|6h|1d|1w))?(?:\s+(\d+))?$/i);
    if (chartM) {
      await message.channel.sendTyping().catch(() => {});
      try {
        await handleChartCommand(message, chartM[1], chartM[2] || '4h', chartM[3]);
      } catch (e) {
        await message.reply('Gagal buat chart: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Mode edit file GitHub langsung ===
    const ghRef = parseGitHubFileRef(question);
    if (ghRef) {
      await message.channel.sendTyping().catch(() => {});
      const history = getHistoryForAI(historyKey, isDMOwner);
      await handleGitHubEdit(message, ghRef, question, history, isDMOwner);
      return;
    }

    await message.channel.sendTyping().catch(() => {});

    // === Mode gambar (hanya kalau tidak ada file dilampirkan) ===
    if (fileAttachments.length === 0 && isImageRequest(question)) {
      const { imageBuffer, text } = await generateImage(question);
      if (imageBuffer) {
        await message.reply({
          content: (text || `Nih hasil gambarnya: "${question}"`).slice(0, 2000),
          files: [makeFile(imageBuffer, 'hasil.png')],
        });
        return;
      }
      // Kalau generate gambar gagal, jatuh ke mode teks biasa.
    }

    // ============================================================
    // [FIX] Cek total ukuran file sebelum gabung ke satu prompt.
    // Kalau terlalu besar, proses satu per satu agar AI tidak truncate.
    // ============================================================
    if (fileAttachments.length > 0) {
      const totalSize = fileAttachments.reduce((sum, a) => sum + a.size, 0);

      // Download semua file dulu
      const loadedFiles = [];
      for (const att of fileAttachments) {
        try {
          const content = await downloadAttachmentText(att);
          loadedFiles.push({ att, content });
        } catch (e) {
          await message.reply(`⚠️ Gagal membaca **${att.name}**: ${e.message}`).catch(() => {});
        }
      }

      if (loadedFiles.length === 0) return;

      const history = getHistoryForAI(historyKey, isDMOwner);

      // Jika total file > 30KB ATAU ada lebih dari 1 file yang masing-masing > 15KB,
      // proses satu per satu untuk hindari context overflow
      const shouldSplitProcess = totalSize > MAX_TOTAL_BYTES_COMBINED
        || (loadedFiles.length > 1 && loadedFiles.some((f) => f.att.size > 15 * 1024));

      if (shouldSplitProcess && isDMOwner) {
        // Mode split: proses tiap file terpisah
        await message.reply(
          `📂 File terlalu besar untuk diproses sekaligus (total ${Math.round(totalSize / 1024)}KB). Memproses **${loadedFiles.length} file satu per satu**...`
        ).catch(() => {});

        for (const { att, content } of loadedFiles) {
          await message.channel.sendTyping().catch(() => {});
          await processSingleFile(message, att, content, question, history, isDMOwner);
        }

        // Simpan history — hanya nama file, bukan isi
        const fileNames = loadedFiles.map((f) => f.att.name).join(', ');
        await pushHistory(historyKey, `${question || 'cek file'} [File: ${fileNames}]`, '[File diproses satu per satu]', isDMOwner);
        return;
      }

      // Proses gabung (file kecil atau channel)
      const fileParts = [];
      const fileNames = [];
      const originalFileNames = [];

      for (const { att, content } of loadedFiles) {
        fileParts.push(`// === File: ${att.name} ===\n${content}`);
        fileNames.push(att.name);
        originalFileNames.push(att.name);
      }

      const instruction = question
        || 'Periksa semua file yang dilampirkan, identifikasi semua error/masalahnya, lalu perbaiki dan berikan versi LENGKAP yang sudah diperbaiki dalam code block terpisah untuk tiap file.';

      const finalQuestion = `${instruction}\n\n${fileParts.join('\n\n')}`;
      const historyUserContent = `${instruction} [File: ${fileNames.join(', ')}]`;

      const { text, sources } = await askGemini(finalQuestion, history, isDMOwner);

      // [FIX] Deteksi hallusinasi sebelum proses respons
      if (containsHallucination(text)) {
        await message.reply(
          '⚠️ AI tidak dapat memproses file sebesar ini sekaligus. Coba kirim **satu file** saja agar hasilnya akurat.'
        );
        return;
      }

      await pushHistory(historyKey, historyUserContent, text, isDMOwner);

      const blocks = extractCodeBlocks(text);

      if (shouldSendAsFile(question, blocks, isDMOwner)) {
        await replyWithFiles(message, text, blocks, originalFileNames);
        return;
      }

      await sendLongReply(message, formatAnswer(text, sources));
      return;
    }

    // === Pertanyaan teks biasa (tanpa file) ===
    let finalQuestion = question;
    const historyUserContent = question;

    // === Token scam/analisis skill ===
    if (isScamAnalysisRequest(question)) {
      await message.channel.sendTyping().catch(() => {});
      try {
        const scamResult = await runScamAnalysis(question);
        finalQuestion = scamResult.fullPrompt;
      } catch (e) {
        console.error('[bot] scamAnalysis error:', e.message);
        // fall through to normal AI
      }
    }

    const history = getHistoryForAI(historyKey, isDMOwner);
    const { text, sources } = await askGemini(finalQuestion, history, isDMOwner);

    await pushHistory(historyKey, historyUserContent, text, isDMOwner);

    const blocks = extractCodeBlocks(text);

    if (shouldSendAsFile(question, blocks, isDMOwner)) {
      await replyWithFiles(message, text, blocks, []);
      return;
    }

    await sendLongReply(message, formatAnswer(text, sources));
  } catch (err) {
    console.error('[bot] Error di messageCreate:', err);
    await message.reply(friendlyError(err)).catch(() => {});
  }
});

// ============================================================
// LOGIN
// ============================================================

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('[bot] DISCORD_TOKEN belum di-set. Set env DISCORD_TOKEN dengan Bot Token dari Developer Portal.');
  process.exit(1);
}

// ============================================================
// TOMBOL DELETE — hanya user pengirim yang bisa klik
// ============================================================
client.on('interactionCreate', async (interaction) => {
  console.log('[btn] interactionCreate fired, type:', interaction.type, 'isButton:', interaction.isButton?.());
  try {
    if (!interaction.isButton()) return;
    console.log('[btn] customId:', interaction.customId, 'userId:', interaction.user?.id);
    if (!interaction.customId.startsWith('del_')) return;

    const ownerId = interaction.customId.slice(4);
    console.log('[btn] ownerId:', ownerId, 'clickerId:', interaction.user.id);

    if (interaction.user.id !== ownerId) {
      console.log('[btn] bukan pemilik, tolak');
      await interaction.reply({
        content: '⛔ Hanya pengirim pesan asli yang bisa menghapus ini.',
        ephemeral: true,
      });
      return;
    }

    // deferUpdate = silent ACK ke Discord (paling cepat, tidak buat pesan baru)
    console.log('[btn] deferUpdate...');
    await interaction.deferUpdate();
    console.log('[btn] deferUpdate OK, deleting message...');

    await interaction.message.delete();
    console.log('[btn] message deleted OK');
  } catch (err) {
    console.error('[btn] ERROR:', err.message, err.stack);
    // Coba reply jika belum di-acknowledge
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '⚠️ Gagal hapus: ' + err.message, ephemeral: true });
      }
    } catch (_) {}
  }
});


client.login(token);
 + n.toPrecision(4);
}

function crPct(n) {
  if (n == null) return 'N/A';
  return (n >= 0 ? '🟢 +' : '🔴 ') + n.toFixed(2) + '%';
}

function detectCrQuery(text) {
  const m = text.match(/^cr\s+([a-zA-Z0-9]+)$/i);
  if (m) return { type: 'token', symbol: m[1].toUpperCase() };
  if (/^gainers$/i.test(text)) return { type: 'gainers' };
  if (/^losers$/i.test(text)) return { type: 'losers' };
  if (/^market$/i.test(text)) return { type: 'market' };
  return null;
}

async function fetchCrToken(symbol) {
  const coins = await crFetchCurrencies();
  const coin = coins.find(c => c.symbol?.toUpperCase() === symbol.toUpperCase())
    || coins.find(c => c.slug?.toLowerCase() === symbol.toLowerCase());
  if (!coin) return '\u274C Token **' + symbol + '** tidak ditemukan di CryptoRank.\n_(coba simbol yang benar, misal: cr BTC, cr ETH, cr SOL)_';
  const v = coin.values?.USD || {};
  const sup = coin.circulatingSupply ? (coin.circulatingSupply / 1e6).toFixed(2) + 'M' : 'N/A';
  const maxSup = coin.maxSupply ? (coin.maxSupply / 1e6).toFixed(2) + 'M' : '\u221E';
  return [
    '\uD83D\uDCCA **' + coin.name + ' (' + coin.symbol + ')** \u2014 Rank #' + coin.rank,
    '\uD83D\uDCB5 Harga    : **' + crFmt(v.price) + '**',
    '\uD83D\uDCC8 24h      : ' + crPct(v.percentChange24h),
    '\uD83D\uDCC5 7d       : ' + crPct(v.percentChange7d),
    '\uD83D\uDCC5 30d      : ' + crPct(v.percentChange30d),
    '\uD83D\uDCC5 3 bulan  : ' + crPct(v.percentChange3m),
    '\uD83D\uDCC5 6 bulan  : ' + crPct(v.percentChange6m),
    '\uD83D\uDCB0 Mkt Cap  : ' + crFmt(v.marketCap),
    '\uD83D\uDD04 Vol 24h  : ' + crFmt(v.volume24h),
    '\uD83E\uDE99 Supply   : ' + sup + ' / max ' + maxSup,
    '_(via CryptoRank)_',
  ].join('\n');
}

async function fetchCrGainers() {
  const coins = await crFetchCurrencies();
  const top = [...coins]
    .filter(c => c.values?.USD?.percentChange24h != null && (c.values?.USD?.marketCap || 0) > 1e6)
    .sort((a, b) => b.values.USD.percentChange24h - a.values.USD.percentChange24h)
    .slice(0, 10);
  const rows = top.map((c, i) => {
    const v = c.values.USD;
    return (i + 1) + '. **' + c.symbol + '** ' + crPct(v.percentChange24h) + ' \u2014 ' + crFmt(v.price) + ' | MCap ' + crFmt(v.marketCap);
  });
  return '\uD83D\uDE80 **Top 10 Gainers 24h** _(via CryptoRank)_\n\n' + rows.join('\n');
}

async function fetchCrLosers() {
  const coins = await crFetchCurrencies();
  const top = [...coins]
    .filter(c => c.values?.USD?.percentChange24h != null && (c.values?.USD?.marketCap || 0) > 1e6)
    .sort((a, b) => a.values.USD.percentChange24h - b.values.USD.percentChange24h)
    .slice(0, 10);
  const rows = top.map((c, i) => {
    const v = c.values.USD;
    return (i + 1) + '. **' + c.symbol + '** ' + crPct(v.percentChange24h) + ' \u2014 ' + crFmt(v.price) + ' | MCap ' + crFmt(v.marketCap);
  });
  return '\uD83D\uDCC9 **Top 10 Losers 24h** _(via CryptoRank)_\n\n' + rows.join('\n');
}

async function fetchCrMarket() {
  const key = process.env.CRYPTORANK_API_KEY;
  if (!key) throw new Error('CRYPTORANK_API_KEY belum diset.');
  const resp = await axios.get('https://api.cryptorank.io/v1/global', {
    params: { api_key: key },
    timeout: 8000,
  });
  const d = resp.data?.data || {};
  const v = d.values?.USD || {};
  const coins = await crFetchCurrencies();
  const btcPct = coins.find(c => c.symbol === 'BTC')?.values?.USD?.percentChange24h;
  const ethPct = coins.find(c => c.symbol === 'ETH')?.values?.USD?.percentChange24h;
  return [
    '\uD83C\uDF0D **Global Market Overview** _(via CryptoRank)_',
    '\uD83D\uDCB0 Total Market Cap : **' + crFmt(v.totalMarketCap) + '**',
    '\uD83D\uDD04 Volume 24h       : ' + crFmt(v.totalVolume24h),
    '\u20BF  BTC Dominance   : **' + (d.btcDominance || 0).toFixed(2) + '%** ' + (btcPct != null ? crPct(btcPct) : ''),
    '\u039E  ETH Dominance   : **' + (d.ethDominance || 0).toFixed(2) + '%** ' + (ethPct != null ? crPct(ethPct) : ''),
    '\uD83E\uDE99 Active Coins     : ' + (d.activeCurrencies || 0).toLocaleString(),
    '\uD83D\uDCCA Active Markets   : ' + (d.activeMarkets || 0).toLocaleString(),
  ].join('\n');
}

async function handleCrCommand(type, symbol) {
  if (type === 'token') return fetchCrToken(symbol);
  if (type === 'gainers') return fetchCrGainers();
  if (type === 'losers') return fetchCrLosers();
  if (type === 'market') return fetchCrMarket();
  return null;
}

// Buat tombol delete (hanya pemilik pesan yang bisa klik)
function makeDeleteRow(userId) {
  const btn = new ButtonBuilder()
    .setCustomId('del_' + userId)
    .setLabel('Hapus')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder().addComponents(btn);
}

async function detectCryptoConversion(question) {
  var m = question.match(/^([\d.,]+[kmb]?)\s+([a-zA-Z]+)\s+(?:to|ke)\s+([a-zA-Z]+)$/i);
  if (!m) return null;
  var amount = parseConvAmount(m[1]);
  var from = m[2].toLowerCase();
  var to = m[3].toLowerCase();
  if (isNaN(amount) || amount <= 0) return null;
  // Resolusi: COIN_ID_MAP -> cache -> CoinGecko /search -> DexScreener
  var coinId = await resolveCoinId(from);
  if (!coinId) {
    var dexInfo = await resolveDexPrice(from);
    if (!dexInfo) return { notFound: true, from: from, to: to };
    if (!SUPPORTED_VS.has(to)) return { notFound: true, from: from, to: to };
    return { amount: amount, from: from, to: to, coinId: null, dexInfo: dexInfo };
  }
  var toIsVs = SUPPORTED_VS.has(to);
  var toCoinId = toIsVs ? null : await resolveCoinId(to);
  if (!toIsVs && !toCoinId) return null;
  return { amount: amount, from: from, to: to, coinId: coinId, toCoinId: toCoinId };
}

// Deteksi: "price btc" atau "p eth" (tanpa tag bot)
function detectPriceQuery(text) {
  var m = text.match(/^(?:price|p)\s+([a-zA-Z]+)$/i);
  if (!m) return null;
  var sym = m[1].toLowerCase();
  var coinId = COIN_ID_MAP[sym];
  if (!coinId) return null;
  return { sym: sym, coinId: coinId };
}

async function fetchCoinPrice(pq) {
  var cgKey = process.env.COINGECKO_API_KEY || '';
  var headers = { 'Accept': 'application/json' };
  if (cgKey) headers['x-cg-demo-api-key'] = cgKey;
  var url = 'https://api.coingecko.com/api/v3/simple/price'
    + '?ids=' + pq.coinId
    + '&vs_currencies=usd,idr,btc'
    + '&include_24hr_change=true'
    + '&include_market_cap=true'
    + '&precision=8';
  var resp = await axios.get(url, { headers: headers, timeout: 8000 });
  var d = resp.data[pq.coinId];
  if (!d) throw new Error('Data tidak ditemukan');
  var sym = pq.sym.toUpperCase();
  var usd = d.usd;
  var idr = d.idr;
  var chg = d.usd_24h_change;
  var mcap = d.usd_market_cap;
  var chgStr = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : 'N/A';
  var usdStr = usd >= 1 ? usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : usd.toPrecision(6);
  var idrStr = 'Rp ' + Math.round(idr).toLocaleString('id-ID');
  var mcapStr = mcap ? '$' + (mcap / 1e9).toFixed(2) + 'B' : 'N/A';
  var arrow = chg != null ? (chg >= 0 ? '**UP**' : '**DOWN**') : '';
  return '**$' + sym + '** ' + arrow + ' ' + chgStr + ' (24 jam)\n'
    + 'USD: $' + usdStr + '\n'
    + 'IDR: ' + idrStr + '\n'
    + 'Market Cap: ' + mcapStr + '\n'
    + '_(via CoinGecko)_';
}

async function fetchCryptoConversion(conv) {
  var amount = conv.amount;
  var from = conv.from;
  var to = conv.to;
  var coinId = conv.coinId;
  if (!from || !to) throw new Error('Data konversi tidak lengkap');
  var fromSym = from.toUpperCase();
  var toSym = to.toUpperCase();
  var cgKey = process.env.COINGECKO_API_KEY || '';

  // DexScreener path: token micro-cap yang tidak ada di CoinGecko
  if (conv.dexInfo) {
    var dexPriceUsd = conv.dexInfo.priceUsd;
    var targetRate = 1;
    if (to !== 'usd') {
      var rateHeaders = { 'Accept': 'application/json' };
      if (cgKey) rateHeaders['x-cg-demo-api-key'] = cgKey;
      var rateResp = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=' + to + '&precision=6',
        { headers: rateHeaders, timeout: 6000 }
      );
      var rateData = rateResp.data && rateResp.data['tether'];
      targetRate = (rateData && rateData[to]) ? rateData[to] : 1;
    }
    var priceInTarget = dexPriceUsd * targetRate;
    var resultInTarget = amount * priceInTarget;
    var dexSrc = (conv.dexInfo.dex || 'dex') + '/' + (conv.dexInfo.chain || 'chain');
    var dl1 = '**' + amount + ' $' + fromSym + ' ke ' + toSym + ' = ' + formatCryptoAmount(resultInTarget, to) + '**';
    var dl2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(priceInTarget, to);
    return dl1 + '\n' + dl2 + '\n_(via DexScreener - ' + dexSrc + ', harga real-time)_';
  }

  // CoinGecko path
  var toCoinId = conv.toCoinId || COIN_ID_MAP[to] || null;
  var toIsVsCurrency = SUPPORTED_VS.has(to);
  var ids = coinId;
  var vsCurrencies = to;
  if (!toIsVsCurrency && toCoinId) {
    ids = coinId + ',' + toCoinId;
    vsCurrencies = 'usd';
  }
  var cgUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=' + vsCurrencies + '&precision=8';
  var cgHeaders = { 'Accept': 'application/json' };
  if (cgKey) cgHeaders['x-cg-demo-api-key'] = cgKey;
  var resp = await axios.get(cgUrl, { headers: cgHeaders, timeout: 8000 });
  var data = resp.data;
  var result, line1, line2;
  if (!toIsVsCurrency && toCoinId) {
    var fromUsd = data[coinId] && data[coinId]['usd'];
    var toUsd = data[toCoinId] && data[toCoinId]['usd'];
    if (!fromUsd || !toUsd) throw new Error('Data harga tidak tersedia');
    result = (amount * fromUsd) / toUsd;
    line1 = '**' + amount + ' $' + fromSym + ' ke $' + toSym + ' = ' + formatCryptoAmount(result, to) + '**';
    line2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(fromUsd / toUsd, to);
  } else {
    var price = data[coinId] && data[coinId][to];
    if (price == null) throw new Error('Data harga tidak tersedia');
    result = amount * price;
    line1 = '**' + amount + ' $' + fromSym + ' ke ' + toSym + ' = ' + formatCryptoAmount(result, to) + '**';
    line2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(price, to);
  }
  return line1 + '\n' + line2 + '\n_(via CoinGecko, harga real-time)_';
}

// ============================================================
// GITHUB EDIT
// ============================================================

function parseGitHubFileRef(text) {
  const urlMatch = text.match(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([^/\s]+)\/([^\s?#]+)/i);
  if (urlMatch) {
    return {
      owner: urlMatch[1], repo: urlMatch[2],
      branch: urlMatch[3], path: decodeURIComponent(urlMatch[4]),
      raw: urlMatch[0],
    };
  }
  const shortMatch = text.match(/\b([\w.-]+)\/([\w.-]+):([\w\-./]+\.[a-zA-Z0-9]+)\b/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], branch: null, path: shortMatch[3], raw: shortMatch[0] };
  }
  return null;
}

function friendlyGitHubError(err, ref) {
  const status = err.response?.status;
  const apiMsg = err.response?.data?.message || err.message;
  console.error('[bot] GitHub edit gagal:', status, apiMsg);
  if (status === 404) return `⚠️ Repo/file tidak ditemukan: \`${ref.owner}/${ref.repo}\` path \`${ref.path}\`. Cek nama repo, path, dan branch-nya.`;
  if (status === 401 || status === 403) return '⚠️ Bot tidak punya izin menulis ke repo ini. Pastikan `GITHUB_TOKEN` punya scope **repo** atau permission **Contents: Read and write**.';
  if (status === 409) return '⚠️ Konflik: file sudah berubah sejak terakhir dibaca (sha mismatch). Kirim ulang permintaannya.';
  if (status === 422) return `⚠️ Gagal commit (422): ${apiMsg}. Cek apakah nama branch/path valid.`;
  return `⚠️ Gagal edit file GitHub. (${status || 'error'}: ${apiMsg})`;
}

async function handleGitHubEdit(message, ref, question, history, isDMOwner) {
  let branch = ref.branch;
  try {
    if (!branch) branch = await getDefaultBranch(ref.owner, ref.repo);
    const { content: oldContent, sha } = await getGitHubFileContent(ref.owner, ref.repo, ref.path, branch);

    const instruction = question.replace(ref.raw, '').trim()
      || 'Periksa file ini, identifikasi error/masalahnya, lalu perbaiki dan rapikan.';

    const prompt = `${instruction}\n\nIni isi file "${ref.path}" saat ini dari repo ${ref.owner}/${ref.repo} (branch ${branch}). `
      + `Berikan versi LENGKAP file yang sudah diperbaiki dalam SATU code block saja — jangan dipotong, jangan ada penjelasan di luar code block selain ringkasan singkat 1-2 kalimat sebelum code block:\n\n`
      + `\`\`\`\n${oldContent}\n\`\`\``;

    const { text } = await askGemini(prompt, history, isDMOwner);

    // [FIX] Deteksi hallusinasi di respons GitHub edit
    if (containsHallucination(text)) {
      await message.reply('⚠️ AI tidak memberikan kode yang valid. Coba kirim ulang permintaannya dengan instruksi lebih spesifik.');
      return;
    }

    const blocks = extractCodeBlocks(text);
    if (!blocks.length) {
      await message.reply('⚠️ AI tidak mengembalikan kode dalam format yang bisa diproses ke GitHub. Coba ulangi dengan instruksi yang lebih spesifik.');
      return;
    }
    const newContent = blocks.reduce((a, b) => (b.code.length > a.code.length ? b : a)).code;

    // [FIX] Validasi kode yang akan di-commit
    if (!isValidCodeBlock(newContent)) {
      await message.reply('⚠️ Kode yang dihasilkan AI terlihat tidak lengkap (terlalu pendek atau mengandung placeholder). Coba kirim ulang.');
      return;
    }

    const commitMessage = `Auto-edit via Discord bot: ${instruction.slice(0, 60)}`;
    const result = await commitGitHubFile(ref.owner, ref.repo, ref.path, newContent, commitMessage, sha, branch);
    const summary = stripCodeBlocks(text).slice(0, 600);

    // [FIX] Gunakan nama file lengkap dari path, bukan hanya pop() terakhir
    const replyFilename = ref.path.includes('/') ? ref.path.split('/').slice(-1)[0] : ref.path;

    await message.reply({
      content: [
        `✅ File **${ref.path}** di **${ref.owner}/${ref.repo}** (branch \`${branch}\`) berhasil diupdate.`,
        result.commitUrl ? `🔗 Commit: <${result.commitUrl}>` : '',
        summary,
      ].filter(Boolean).join('\n').slice(0, 2000),
      files: [makeFile(newContent, replyFilename)],
      flags: MessageFlags.SuppressEmbeds,
    });
  } catch (err) {
    await message.reply(friendlyGitHubError(err, ref)).catch(() => {});
  }
}

// ============================================================
// PROSES FILE SATU PER SATU
// [FIX BARU] Jika total ukuran file melebihi threshold, proses tiap file secara terpisah
// agar tidak melebihi context window AI dan mencegah truncate/hallusinasi.
// ============================================================

async function processSingleFile(message, att, content, question, history, isDMOwner) {
  const instruction = question
    || 'Periksa file ini, identifikasi semua error/masalahnya, lalu perbaiki dan berikan versi LENGKAP yang sudah diperbaiki dalam satu code block.';

  const finalQuestion = `${instruction}\n\n// === File: ${att.name} ===\n${content}`;

  const { text } = await askGemini(finalQuestion, history, isDMOwner);

  // Deteksi hallusinasi
  if (containsHallucination(text)) {
    await message.reply(`⚠️ AI memberikan respons yang tidak valid untuk **${att.name}**. Coba kirim file ini sendiri tanpa file lain.`);
    return;
  }

  const blocks = extractCodeBlocks(text);
  const validBlocks = blocks.filter((b) => isValidCodeBlock(b.code));

  if (validBlocks.length === 0) {
    const explanation = stripCodeBlocks(text).slice(0, 1800);
    await message.reply({
      content: (`**${att.name}:**\n${explanation || '⚠️ AI tidak menghasilkan kode valid untuk file ini.'}`).slice(0, 2000),
      flags: MessageFlags.SuppressEmbeds,
    });
    return;
  }

  const bestBlock = validBlocks.reduce((a, b) => (b.code.length > a.code.length ? b : a));
  const explanation = stripCodeBlocks(text).slice(0, 800);

  await message.reply({
    content: (`✅ **${att.name}** sudah diperbaiki.\n` + (explanation || '')).slice(0, 2000),
    files: [makeFile(bestBlock.code, att.name)],
    flags: MessageFlags.SuppressEmbeds,
  });
}

// ============================================================
// HANDLER UTAMA
// ============================================================


// ============================================================
// HANDLER UTAMA
// ============================================================

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    const isDM = !message.guild;
    const mentioned = message.mentions.users.has(client.user.id);

    // === Crypto/price tanpa tag: "5k usdc to idr" atau "price btc" ===
    if (!mentioned && !isDM) {
      var rawText = message.content.trim();
      var noTagConv = await detectCryptoConversion(rawText);
      var noTagPrice = !noTagConv ? detectPriceQuery(rawText) : null;
      if (noTagConv || noTagPrice) {
        await message.channel.sendTyping().catch(() => {});
        try {
          var noTagResult = noTagConv
            ? await fetchCryptoConversion(noTagConv)
            : await fetchCoinPrice(noTagPrice);
          await message.reply({
            content: noTagResult,
            components: [makeDeleteRow(message.author.id)],
            flags: MessageFlags.SuppressEmbeds,
          });
        } catch (e) {
          await message.reply('Gagal ambil data: ' + e.message).catch(() => {});
        }
      }
      // === Twitter history tanpa tag: "twit monad" ===
      var noTagTwit = detectTwitterQuery(rawText);
      if (noTagTwit) {
        await message.channel.sendTyping().catch(() => {});
        try {
          var noTagTwitResult = await fetchTwitterHistory(noTagTwit.usernames);
          await message.reply({
            content: noTagTwitResult.slice(0, 2000),
            components: [makeDeleteRow(message.author.id)],
            flags: MessageFlags.SuppressEmbeds,
          });
        } catch (e) {
          await message.reply('Gagal ambil data Twitter: ' + e.message).catch(() => {});
        }
        return;
      }

            // === Chart command tanpa tag: C BTC / C ETH 4h / C ETH 4h 30 ===
      var chartRawMatch = rawText.match(/^c\s+([a-zA-Z]+)(?:\s+(1m|5m|15m|30m|1h|2h|4h|6h|1d|1w))?(?:\s+(\d+))?$/i);
      if (chartRawMatch) {
        await message.channel.sendTyping().catch(() => {});
        try {
          await handleChartCommand(message, chartRawMatch[1], chartRawMatch[2] || '4h', chartRawMatch[3]);
        } catch (e) {
          await message.reply('Gagal buat chart: ' + e.message).catch(() => {});
        }
        return;
      }
      return;
    }

    if (isDM && message.author.id !== OWNER_ID) {
      await message.reply('⛔ Maaf, DM bot ini hanya bisa digunakan oleh owner.');
      return;
    }

    const isDMOwner = isDM && message.author.id === OWNER_ID;
    const historyKey = isDMOwner ? `dm-${message.author.id}` : `ch-${message.channelId}`;

    // Bootstrap history dari Discord saat pertama kali aktif setelah restart
    await bootstrapHistory(historyKey, message.channel, isDMOwner);

    const mentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
    const question = message.content.replace(mentionRegex, '').trim();

    const maxFiles = isDMOwner ? MAX_FILES_DM : MAX_FILES_CH;
    const fileAttachments = [...message.attachments.values()]
      .filter((a) => TEXT_FILE_EXTENSIONS.includes(getExt(a.name)))
      .slice(0, maxFiles);

    if (!question && fileAttachments.length === 0) {
      await message.reply('Halo! Tag aku lalu tulis pertanyaanmu, lampirkan file untuk diperiksa/diperbaiki, kirim link GitHub untuk edit repo, atau minta aku buatkan gambar. 👋');
      return;
    }

    // === Perintah !delete [n] (hanya owner) ===
    if (message.author.id === OWNER_ID && /^!delete\s+\d+$/i.test(question)) {
      const n = Math.min(parseInt(question.split(/\s+/)[1], 10), 100);
      console.log(`[bot] !delete dipanggil oleh owner, n=${n}`);
      // Coba hapus pesan perintah owner
      message.delete().catch(() => {});
      // Fetch pesan recent, filter hanya pesan milik bot
      const fetched = await message.channel.messages.fetch({ limit: 100 });
      const mine = [...fetched.values()]
        .filter(m => m.author.id === client.user.id)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .slice(0, n);
      console.log(`[bot] !delete: ditemukan ${mine.length} pesan milik bot`);
      for (const m of mine) {
        await m.delete().catch(e => console.warn(`[bot] gagal hapus ${m.id}: ${e.message}`));
        await new Promise(r => setTimeout(r, 500));
      }
      console.log(`[bot] !delete: selesai hapus ${mine.length} pesan`);
      return;
    }

    // === Perintah !ClearHistory ===
    if (question.toLowerCase() === '!clearhistory') {
      const hadHistory = !!(allHistory[historyKey] && allHistory[historyKey].length > 0);
      clearHistory(historyKey);
      await message.reply(hadHistory
        ? '🗑️ Riwayat percakapan sesi ini sudah dihapus. Kita mulai dari awal!'
        : '✅ Tidak ada riwayat yang perlu dihapus untuk sesi ini.');
      return;
    }

    // === Deteksi konversi crypto (misal: "5k usdc to idr") ===
    var cryptoConv = await detectCryptoConversion(question);
    if (cryptoConv) {
      if (cryptoConv.notFound) {
        await message.reply({ content: '❌ Token **' + cryptoConv.from.toUpperCase() + '** tidak ditemukan di CoinGecko. Coba cek simbol tokennya.', flags: MessageFlags.SuppressEmbeds });
        return;
      }
      await message.channel.sendTyping().catch(() => {});
      try {
        var convResult = await fetchCryptoConversion(cryptoConv);
        await message.reply({
          content: convResult,
          components: [makeDeleteRow(message.author.id)],
          flags: MessageFlags.SuppressEmbeds,
        });
      } catch (e) {
        await message.reply('Gagal ambil harga: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Deteksi price query (misal: "price btc" atau "p eth") ===
    var priceQ = detectPriceQuery(question);
    if (priceQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var priceResult = await fetchCoinPrice(priceQ);
        await message.reply({ content: priceResult, flags: MessageFlags.SuppressEmbeds });
      } catch (e) {
        await message.reply('Gagal ambil harga: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Twitter login: "twit login" di DM untuk dapatkan token memory.lol ===
    if (isDMOwner && question.toLowerCase() === 'twit login') {
      try {
        const codeResp = await axios.post(
          'https://github.com/login/device/code',
          'client_id=b8ab5a8c1a2745d514b7',
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 10000 }
        );
        const { device_code, user_code, verification_uri, expires_in, interval } = codeResp.data;
        await message.reply(
          '\uD83D\uDD12 **Login ke memory.lol untuk akses full history**\n\n'
          + '1. Buka: **' + verification_uri + '**\n'
          + '2. Masukkan kode: **' + user_code + '**\n'
          + '3. Klik Authorize\n'
          + '4. Balik ke sini dan ketik **twit token** (bot akan cek otomatis)\n\n'
          + '_(Kode berlaku ' + Math.round(expires_in / 60) + ' menit)_'
        );
        // Simpan device_code sementara di memory untuk polling
        if (!global._twitDeviceFlow) global._twitDeviceFlow = {};
        global._twitDeviceFlow[message.author.id] = { device_code, interval: interval || 5, expires: Date.now() + expires_in * 1000 };
      } catch (e) {
        await message.reply('\u274C Gagal mulai login: ' + e.message);
      }
      return;
    }

    // === Twitter token poll: "twit token" setelah authorize ===
    if (isDMOwner && question.toLowerCase() === 'twit token') {
      const flow = global._twitDeviceFlow && global._twitDeviceFlow[message.author.id];
      if (!flow) {
        await message.reply('\u274C Tidak ada sesi login aktif. Ketik **twit login** terlebih dahulu.');
        return;
      }
      if (Date.now() > flow.expires) {
        await message.reply('\u23F0 Kode sudah kedaluwarsa. Ketik **twit login** untuk mulai ulang.');
        return;
      }
      try {
        const tokenResp = await axios.post(
          'https://github.com/login/oauth/access_token',
          'device_code=' + flow.device_code + '&client_id=b8ab5a8c1a2745d514b7&grant_type=urn:ietf:params:oauth:grant-type:device_code',
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 10000 }
        );
        const { access_token, error } = tokenResp.data;
        if (error === 'authorization_pending') {
          await message.reply('\u23F3 Belum diauthorize. Selesaikan langkah di browser dulu, lalu ketik **twit token** lagi.');
          return;
        }
        if (!access_token) {
          await message.reply('\u274C Gagal ambil token: ' + (error || 'unknown error'));
          return;
        }
        // Coba autentikasi ke memory.lol
        const mlResp = await axios.post(
          'https://api.memory.lol/v1/login/status',
          'token=' + encodeURIComponent(access_token),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        ).catch(() => null);
        delete global._twitDeviceFlow[message.author.id];
        await message.reply(
          '\u2705 Token berhasil didapat!\n\n'
          + 'Set environment variable berikut di Railway/Fly.io/host kamu:\n'
          + '```\nMEMORYLOL_TOKEN=' + access_token + '\n```\n'
          + '\u26A0\uFE0F Jika akunmu **belum diapprove** oleh pemilik memory.lol, akses tetap terbatas 60 hari.\n'
          + 'Hubungi [@travisbrown](https://twitter.com/travisbrown) untuk minta full access.'
        );
      } catch (e) {
        await message.reply('\u274C Error: ' + e.message);
      }
      return;
    }

        // === Twitter history dengan mention: "@bot twit monad" ===
    var twitQ = detectTwitterQuery(question);
    if (twitQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var twitResult = await fetchTwitterHistory(twitQ.usernames);
        await message.reply({
          content: twitResult.slice(0, 2000),
          components: [makeDeleteRow(message.author.id)],
          flags: MessageFlags.SuppressEmbeds,
        });
      } catch (e) {
        await message.reply('Gagal ambil data Twitter: ' + e.message).catch(() => {});
      }
      return;
    }

        // === Chart command dengan mention: @bot C BTC / @bot C ETH 4h / @bot C ETH 4h 30 ===
    const chartM = question.match(/^c\s+([a-zA-Z]+)(?:\s+(1m|5m|15m|30m|1h|2h|4h|6h|1d|1w))?(?:\s+(\d+))?$/i);
    if (chartM) {
      await message.channel.sendTyping().catch(() => {});
      try {
        await handleChartCommand(message, chartM[1], chartM[2] || '4h', chartM[3]);
      } catch (e) {
        await message.reply('Gagal buat chart: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Mode edit file GitHub langsung ===
    const ghRef = parseGitHubFileRef(question);
    if (ghRef) {
      await message.channel.sendTyping().catch(() => {});
      const history = getHistoryForAI(historyKey, isDMOwner);
      await handleGitHubEdit(message, ghRef, question, history, isDMOwner);
      return;
    }

    await message.channel.sendTyping().catch(() => {});

    // === Mode gambar (hanya kalau tidak ada file dilampirkan) ===
    if (fileAttachments.length === 0 && isImageRequest(question)) {
      const { imageBuffer, text } = await generateImage(question);
      if (imageBuffer) {
        await message.reply({
          content: (text || `Nih hasil gambarnya: "${question}"`).slice(0, 2000),
          files: [makeFile(imageBuffer, 'hasil.png')],
        });
        return;
      }
      // Kalau generate gambar gagal, jatuh ke mode teks biasa.
    }

    // ============================================================
    // [FIX] Cek total ukuran file sebelum gabung ke satu prompt.
    // Kalau terlalu besar, proses satu per satu agar AI tidak truncate.
    // ============================================================
    if (fileAttachments.length > 0) {
      const totalSize = fileAttachments.reduce((sum, a) => sum + a.size, 0);

      // Download semua file dulu
      const loadedFiles = [];
      for (const att of fileAttachments) {
        try {
          const content = await downloadAttachmentText(att);
          loadedFiles.push({ att, content });
        } catch (e) {
          await message.reply(`⚠️ Gagal membaca **${att.name}**: ${e.message}`).catch(() => {});
        }
      }

      if (loadedFiles.length === 0) return;

      const history = getHistoryForAI(historyKey, isDMOwner);

      // Jika total file > 30KB ATAU ada lebih dari 1 file yang masing-masing > 15KB,
      // proses satu per satu untuk hindari context overflow
      const shouldSplitProcess = totalSize > MAX_TOTAL_BYTES_COMBINED
        || (loadedFiles.length > 1 && loadedFiles.some((f) => f.att.size > 15 * 1024));

      if (shouldSplitProcess && isDMOwner) {
        // Mode split: proses tiap file terpisah
        await message.reply(
          `📂 File terlalu besar untuk diproses sekaligus (total ${Math.round(totalSize / 1024)}KB). Memproses **${loadedFiles.length} file satu per satu**...`
        ).catch(() => {});

        for (const { att, content } of loadedFiles) {
          await message.channel.sendTyping().catch(() => {});
          await processSingleFile(message, att, content, question, history, isDMOwner);
        }

        // Simpan history — hanya nama file, bukan isi
        const fileNames = loadedFiles.map((f) => f.att.name).join(', ');
        await pushHistory(historyKey, `${question || 'cek file'} [File: ${fileNames}]`, '[File diproses satu per satu]', isDMOwner);
        return;
      }

      // Proses gabung (file kecil atau channel)
      const fileParts = [];
      const fileNames = [];
      const originalFileNames = [];

      for (const { att, content } of loadedFiles) {
        fileParts.push(`// === File: ${att.name} ===\n${content}`);
        fileNames.push(att.name);
        originalFileNames.push(att.name);
      }

      const instruction = question
        || 'Periksa semua file yang dilampirkan, identifikasi semua error/masalahnya, lalu perbaiki dan berikan versi LENGKAP yang sudah diperbaiki dalam code block terpisah untuk tiap file.';

      const finalQuestion = `${instruction}\n\n${fileParts.join('\n\n')}`;
      const historyUserContent = `${instruction} [File: ${fileNames.join(', ')}]`;

      const { text, sources } = await askGemini(finalQuestion, history, isDMOwner);

      // [FIX] Deteksi hallusinasi sebelum proses respons
      if (containsHallucination(text)) {
        await message.reply(
          '⚠️ AI tidak dapat memproses file sebesar ini sekaligus. Coba kirim **satu file** saja agar hasilnya akurat.'
        );
        return;
      }

      await pushHistory(historyKey, historyUserContent, text, isDMOwner);

      const blocks = extractCodeBlocks(text);

      if (shouldSendAsFile(question, blocks, isDMOwner)) {
        await replyWithFiles(message, text, blocks, originalFileNames);
        return;
      }

      await sendLongReply(message, formatAnswer(text, sources));
      return;
    }

    // === Pertanyaan teks biasa (tanpa file) ===
    let finalQuestion = question;
    const historyUserContent = question;

    // === Token scam/analisis skill ===
    if (isScamAnalysisRequest(question)) {
      await message.channel.sendTyping().catch(() => {});
      try {
        const scamResult = await runScamAnalysis(question);
        finalQuestion = scamResult.fullPrompt;
      } catch (e) {
        console.error('[bot] scamAnalysis error:', e.message);
        // fall through to normal AI
      }
    }

    const history = getHistoryForAI(historyKey, isDMOwner);
    const { text, sources } = await askGemini(finalQuestion, history, isDMOwner);

    await pushHistory(historyKey, historyUserContent, text, isDMOwner);

    const blocks = extractCodeBlocks(text);

    if (shouldSendAsFile(question, blocks, isDMOwner)) {
      await replyWithFiles(message, text, blocks, []);
      return;
    }

    await sendLongReply(message, formatAnswer(text, sources));
  } catch (err) {
    console.error('[bot] Error di messageCreate:', err);
    await message.reply(friendlyError(err)).catch(() => {});
  }
});

// ============================================================
// LOGIN
// ============================================================

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('[bot] DISCORD_TOKEN belum di-set. Set env DISCORD_TOKEN dengan Bot Token dari Developer Portal.');
  process.exit(1);
}

// ============================================================
// TOMBOL DELETE — hanya user pengirim yang bisa klik
// ============================================================
client.on('interactionCreate', async (interaction) => {
  console.log('[btn] interactionCreate fired, type:', interaction.type, 'isButton:', interaction.isButton?.());
  try {
    if (!interaction.isButton()) return;
    console.log('[btn] customId:', interaction.customId, 'userId:', interaction.user?.id);
    if (!interaction.customId.startsWith('del_')) return;

    const ownerId = interaction.customId.slice(4);
    console.log('[btn] ownerId:', ownerId, 'clickerId:', interaction.user.id);

    if (interaction.user.id !== ownerId) {
      console.log('[btn] bukan pemilik, tolak');
      await interaction.reply({
        content: '⛔ Hanya pengirim pesan asli yang bisa menghapus ini.',
        ephemeral: true,
      });
      return;
    }

    // deferUpdate = silent ACK ke Discord (paling cepat, tidak buat pesan baru)
    console.log('[btn] deferUpdate...');
    await interaction.deferUpdate();
    console.log('[btn] deferUpdate OK, deleting message...');

    await interaction.message.delete();
    console.log('[btn] message deleted OK');
  } catch (err) {
    console.error('[btn] ERROR:', err.message, err.stack);
    // Coba reply jika belum di-acknowledge
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '⚠️ Gagal hapus: ' + err.message, ephemeral: true });
      }
    } catch (_) {}
  }
});


client.login(token);
