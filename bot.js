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
const { Client, GatewayIntentBits, Partials, AttachmentBuilder, MessageFlags } = require('discord.js');
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

// ============================================================
// KONFIGURASI
// ============================================================

// ID Owner — satu-satunya yang bisa pakai bot di DM.
const OWNER_ID = '1292088584429637707';

// Channel: simpan maks 2 pasang (termasuk saat owner di channel),
// setelah itu auto-clear agar tidak merusak konteks DM.
// DM owner: tidak pernah di-auto-clear — simpan seterusnya.
const MAX_CHANNEL_TURNS = 2;

// Batas file yang bisa dikirim per pesan.
// DM owner bisa kirim lebih banyak file (hingga 10, batas Discord).
const MAX_FILES_DM    = 10;  // DM owner
const MAX_FILES_CH    = 3;   // channel

// Batas ukuran file per-attachment (60 KB).
const MAX_FILE_BYTES = 60 * 1024;

// Discord membatasi maks 10 file per reply.
const DISCORD_MAX_FILES = 10;

// File JSON penyimpanan riwayat permanen.
const HISTORY_FILE = path.join(__dirname, 'conversation_history.json');

// ============================================================
// MANAJEMEN RIWAYAT
// ============================================================

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

// Simpan ke file JSON secara async agar tidak blokir event loop.
function saveHistory() {
  fs.writeFile(HISTORY_FILE, JSON.stringify(allHistory, null, 2), 'utf-8', (err) => {
    if (err) console.error('[bot] Gagal menyimpan riwayat:', err.message);
  });
}

function getHistory(key) {
  if (!allHistory[key]) allHistory[key] = [];
  return allHistory[key];
}

// Hapus riwayat sebuah sesi.
function clearHistory(key) {
  delete allHistory[key];
  saveHistory();
}

// Tambah satu pasang percakapan ke riwayat.
//
// historyUserContent : yang disimpan ke history — instruksi + nama file saja (TANPA isi file).
//                      Ini mencegah history membengkak dan token AI membengkak di pesan berikutnya.
// isDMOwner          : DM owner → tidak pernah ditrim/auto-clear.
//                      Channel (termasuk kalau owner ada di channel) → auto-clear setelah 2 pasang.
//
// Kenapa channel owner tetap di-clear?
//   Histori channel disimpan per-channel (bukan per-user), dan percakapan channel biasanya
//   hal umum/crypto. Kalau tidak di-clear, konteks channel bisa "bocor" ke sesi DM coding.
function pushHistory(key, historyUserContent, assistantText, isDMOwner) {
  const history = getHistory(key);
  history.push({ role: 'user', content: historyUserContent });
  history.push({ role: 'assistant', content: assistantText });

  if (!isDMOwner) {
    // Channel: setelah mencapai MAX_CHANNEL_TURNS pasang, hapus seluruh history key ini
    // supaya percakapan berikutnya dimulai dari awal (hemat token, konteks tetap bersih).
    if (history.length >= MAX_CHANNEL_TURNS * 2) {
      delete allHistory[key]; // pakai delete bukan [] supaya tidak ada sisa kunci kosong
    }
  }
  // DM owner: tidak pernah dihapus otomatis — tumbuh terus sampai !ClearHistory diketik.

  saveHistory();
}

// Ambil history yang akan dikirim ke AI.
function getHistoryForAI(key, isDMOwner) {
  const history = getHistory(key);
  if (isDMOwner) return history;                          // DM: seluruh history
  return history.slice(-(MAX_CHANNEL_TURNS * 2));         // Channel: 2 pasang terakhir
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
  partials: [Partials.Channel],
});

client.once('clientReady', () => console.log(`[bot] Login sebagai ${client.user.tag}`));
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

// Tentukan apakah jawaban AI harus dikirim sebagai file attachment.
// Di DM owner: threshold sangat rendah — kode apapun > 80 karakter langsung jadi file.
// Di channel: threshold normal (500 karakter atau keyword file tertentu).
function shouldSendAsFile(question, blocks, isDMOwner) {
  if (!blocks.length) return false;
  if (blocks.length > 1) return true;
  const totalLen = blocks.reduce((n, b) => n + b.code.length, 0);
  if (isDMOwner && totalLen > 80) return true;
  if (totalLen > 500) return true;
  return /\b(file|\.js|\.html|\.py|\.css|\.json|kirim\s*file|sebagai\s*file|buatkan\s*(file|website|web|halaman|program|script))\b/i.test(question);
}

// Kirim jawaban sebagai file attachment.
// originalFileNames: nama-nama file asli yang dikirim user.
//   → Kalau user kirim 1 file dan AI balas 1 code block → pakai nama file asli user persis.
//   → Kalau banyak file dan urutan cocok → pakai nama file asli per-index.
//   → Kalau tidak cocok → fallback ke output.ext.
// Discord membatasi maks 10 file per reply — selebihnya dipotong.
async function replyWithFiles(message, text, blocks, originalFileNames = []) {
  const cappedBlocks = blocks.slice(0, DISCORD_MAX_FILES);

  const files = cappedBlocks.map((b, i) => {
    // Satu file masuk, satu block keluar → pakai nama asli user.
    if (originalFileNames.length === 1 && cappedBlocks.length === 1) {
      return makeFile(b.code, originalFileNames[0]);
    }
    // Banyak file masuk → cocokkan per-index.
    if (originalFileNames[i]) {
      return makeFile(b.code, originalFileNames[i]);
    }
    // Fallback: pakai ekstensi dari bahasa code block.
    const ext = EXT_MAP[b.lang] || (TEXT_FILE_EXTENSIONS.includes(b.lang) ? b.lang : 'txt');
    const filename = cappedBlocks.length > 1 ? `file_${i + 1}.${ext}` : `output.${ext}`;
    return makeFile(b.code, filename);
  });

  const explanation = stripCodeBlocks(text);
  const truncatedNote = blocks.length > DISCORD_MAX_FILES
    ? `\n\n⚠️ Hanya ${DISCORD_MAX_FILES} file pertama yang dikirim (Discord membatasi maks ${DISCORD_MAX_FILES} file per pesan).`
    : '';

  await message.reply({
    content: ((explanation || '📎 Ini hasilnya, dikirim sebagai file.') + truncatedNote).slice(0, 2000),
    files,
    flags: MessageFlags.SuppressEmbeds,
  });
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

// History dipakai di sini supaya AI ingat konteks percakapan sebelumnya (terutama penting di DM owner).
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
    const blocks = extractCodeBlocks(text);
    if (!blocks.length) {
      await message.reply('⚠️ AI tidak mengembalikan kode dalam format yang bisa diproses ke GitHub. Coba ulangi dengan instruksi yang lebih spesifik.');
      return;
    }
    const newContent = blocks.reduce((a, b) => (b.code.length > a.code.length ? b : a)).code;
    const commitMessage = `Auto-edit via Discord bot: ${instruction.slice(0, 60)}`;
    const result = await commitGitHubFile(ref.owner, ref.repo, ref.path, newContent, commitMessage, sha, branch);
    const summary = stripCodeBlocks(text).slice(0, 600);

    await message.reply({
      content: [
        `✅ File **${ref.path}** di **${ref.owner}/${ref.repo}** (branch \`${branch}\`) berhasil diupdate.`,
        result.commitUrl ? `🔗 Commit: <${result.commitUrl}>` : '',
        summary,
      ].filter(Boolean).join('\n').slice(0, 2000),
      files: [makeFile(newContent, ref.path.split('/').pop())],
      flags: MessageFlags.SuppressEmbeds,
    });
  } catch (err) {
    await message.reply(friendlyGitHubError(err, ref)).catch(() => {});
  }
}

// ============================================================
// HANDLER UTAMA
// ============================================================

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    const isDM = !message.guild;
    const mentioned = message.mentions.users.has(client.user.id);

    if (!mentioned && !isDM) return;

    // DM: hanya owner yang boleh.
    if (isDM && message.author.id !== OWNER_ID) {
      await message.reply('⛔ Maaf, DM bot ini hanya bisa digunakan oleh owner.');
      return;
    }

    // isDMOwner ditentukan di sini (SEBELUM filter file) supaya batas jumlah file bisa berbeda.
    // Penting: isDMOwner = true HANYA kalau pesan benar-benar dari DM owner, bukan dari channel
    // meskipun yang ngetik adalah owner. Dengan begitu history channel dan DM selalu terpisah.
    const isDMOwner = isDM && message.author.id === OWNER_ID;
    const historyKey = isDMOwner ? `dm-${message.author.id}` : `ch-${message.channelId}`;

    const mentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
    const question = message.content.replace(mentionRegex, '').trim();

    // Filter attachment berdasarkan ekstensi, dengan batas berbeda per mode.
    const maxFiles = isDMOwner ? MAX_FILES_DM : MAX_FILES_CH;
    const fileAttachments = [...message.attachments.values()]
      .filter((a) => TEXT_FILE_EXTENSIONS.includes(getExt(a.name)))
      .slice(0, maxFiles);

    if (!question && fileAttachments.length === 0) {
      await message.reply('Halo! Tag aku lalu tulis pertanyaanmu, lampirkan file untuk diperiksa/diperbaiki, kirim link GitHub untuk edit repo, atau minta aku buatkan gambar. 👋');
      return;
    }

    // === Perintah !ClearHistory ===
    // Bekerja di channel maupun DM. Di DM owner, ini satu-satunya cara menghapus history.
    if (question.toLowerCase() === '!clearhistory') {
      const hadHistory = !!(allHistory[historyKey] && allHistory[historyKey].length > 0);
      clearHistory(historyKey);
      await message.reply(hadHistory
        ? '🗑️ Riwayat percakapan sesi ini sudah dihapus. Kita mulai dari awal!'
        : '✅ Tidak ada riwayat yang perlu dihapus untuk sesi ini.');
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

    // === Bangun pertanyaan untuk AI ===
    //
    // finalQuestion      → dikirim ke AI saat ini: instruksi + isi file lengkap.
    // historyUserContent → disimpan ke history: instruksi + nama file saja (TANPA isi file).
    //
    // Isi file TIDAK disimpan ke history agar:
    //   1. Token tidak membengkak di pesan-pesan berikutnya.
    //   2. History file JSON tidak tumbuh besar.
    //   3. AI tetap bisa menjawab dengan konteks yang tepat.
    let finalQuestion = question;
    let historyUserContent = question;
    const originalFileNames = []; // nama file asli untuk penamaan reply attachment

    if (fileAttachments.length > 0) {
      const fileParts = [];
      const fileNames = [];

      for (const att of fileAttachments) {
        try {
          const content = await downloadAttachmentText(att);
          fileParts.push(`// === File: ${att.name} ===\n${content}`);
          fileNames.push(att.name);
          originalFileNames.push(att.name);
        } catch (e) {
          fileParts.push(`// Gagal membaca file "${att.name}": ${e.message}`);
          fileNames.push(att.name);
        }
      }

      const instruction = question
        || 'Periksa semua file yang dilampirkan, identifikasi semua error/masalahnya, lalu perbaiki dan berikan versi LENGKAP yang sudah diperbaiki dalam code block terpisah untuk tiap file.';

      finalQuestion = `${instruction}\n\n${fileParts.join('\n\n')}`;
      historyUserContent = `${instruction} [File: ${fileNames.join(', ')}]`;
    }

    // === Ambil history & tanya AI ===
    //
    // isDMOwner diteruskan ke askGemini supaya:
    //   - System prompt coding mendalam aktif di SEMUA provider (Groq/Gemini/OpenAI).
    //   - Konteks tetap terjaga meskipun provider berganti — history selalu dikirim ulang.
    const history = getHistoryForAI(historyKey, isDMOwner);
    const { text, sources } = await askGemini(finalQuestion, history, isDMOwner);

    // Simpan ke history pakai historyUserContent (bukan finalQuestion yang berisi isi file).
    pushHistory(historyKey, historyUserContent, text, isDMOwner);

    const blocks = extractCodeBlocks(text);

    // Di DM owner: threshold rendah → hampir semua kode dikirim sebagai file.
    // Di channel: threshold normal.
    if (shouldSendAsFile(question, blocks, isDMOwner)) {
      await replyWithFiles(message, text, blocks, originalFileNames);
      return;
    }

    await message.reply({
      content: formatAnswer(text, sources),
      flags: MessageFlags.SuppressEmbeds,
    });
  } catch (err) {
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

client.login(token);
