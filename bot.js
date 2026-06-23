// bot.js
// Bot Discord ALWAYS-ON (Gateway/WebSocket) — merespons saat di-tag/mention,
// tanpa perlu slash command. Jalankan dengan: `node bot.js`.
//
// PENTING: Bot ini HARUS di-host di tempat always-on (Railway, Fly.io, VPS, Render, dll),
// BUKAN di Vercel Serverless — karena koneksi Gateway perlu proses hidup terus.
//
// Wajib aktifkan "MESSAGE CONTENT INTENT" di Discord Developer Portal:
//   Applications -> (bot kamu) -> Bot -> Privileged Gateway Intents -> Message Content Intent.

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
} = require('./lib/ai');

// === Konfigurasi kirim/baca file ===
// Ekstensi yang dianggap "file teks" dan boleh dibaca isinya untuk diperiksa/diedit AI.
const TEXT_FILE_EXTENSIONS = [
  'js', 'ts', 'jsx', 'tsx', 'html', 'htm', 'css', 'scss', 'json',
  'py', 'sh', 'sql', 'yaml', 'yml', 'md', 'java', 'c', 'cpp', 'go',
  'rs', 'php', 'sol', 'txt', 'env', 'xml', 'csv',
];
const MAX_FILE_BYTES = 60 * 1024; // 60KB per file — cukup utk source file, aman utk context window AI.
const MAX_FILES_PER_MESSAGE = 2; // batasi jumlah file yang dibaca sekaligus per pesan.
const CODE_FILE_THRESHOLD = 500; // total panjang kode (char) sebelum otomatis dikirim sbg file.

// Health server kecil: Railway/Render mendeteksi service sebagai "hidup" lewat PORT.
// Bot Gateway sebenarnya tidak butuh HTTP, tapi ini mencegah platform menandai crash.
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running');
}).listen(port, () => console.log(`[bot] Health server di port ${port}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // supaya DM juga kebaca
});

client.once('clientReady', () => {
  console.log(`[bot] Login sebagai ${client.user.tag}`);
});

// Tangkap error level client supaya proses tidak diam-diam berhenti merespons.
client.on('error', (err) => console.error('[bot] Client error:', err));
process.on('unhandledRejection', (err) => console.error('[bot] Unhandled rejection:', err));

function getExt(filename = '') {
  const m = filename.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}

// Bungkus string/buffer jadi AttachmentBuilder siap kirim.
function makeFile(content, filename) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
  return new AttachmentBuilder(buffer, { name: filename });
}

// Download isi attachment Discord sebagai teks, dengan limit ukuran supaya tidak membebani
// context window AI atau memory bot kalau ada yang upload file besar.
async function downloadAttachmentText(attachment) {
  if (attachment.size > MAX_FILE_BYTES) {
    throw new Error(`"${attachment.name}" terlalu besar (${Math.round(attachment.size / 1024)}KB, maks ${MAX_FILE_BYTES / 1024}KB).`);
  }
  const { data } = await axios.get(attachment.url, { responseType: 'text', timeout: 15000 });
  return String(data);
}

// Putuskan apakah jawaban AI (yang berisi code block) sebaiknya dikirim sebagai file
// daripada teks biasa: kalau ada >1 file, kodenya cukup panjang, atau user eksplisit minta file.
function shouldSendAsFile(question, blocks) {
  if (!blocks.length) return false;
  if (blocks.length > 1) return true;
  const totalLen = blocks.reduce((n, b) => n + b.code.length, 0);
  if (totalLen > CODE_FILE_THRESHOLD) return true;
  return /\b(file|\.js|\.html|\.py|\.css|\.json|kirim\s*file|sebagai\s*file|buatkan\s*(file|website|web|halaman|program|script))\b/i.test(question);
}

// Kirim hasil (boleh banyak code block = banyak file) + caption penjelasan tanpa kode mentah.
async function replyWithFiles(message, text, blocks) {
  const files = blocks.map((b, i) => {
    const ext = EXT_MAP[b.lang] || (TEXT_FILE_EXTENSIONS.includes(b.lang) ? b.lang : 'txt');
    const filename = blocks.length > 1 ? `file_${i + 1}.${ext}` : `output.${ext}`;
    return makeFile(b.code, filename);
  });
  const explanation = stripCodeBlocks(text);
  await message.reply({
    content: (explanation || '📎 Ini hasilnya, dikirim sebagai file.').slice(0, 2000),
    files,
    flags: MessageFlags.SuppressEmbeds,
  });
}

client.on('messageCreate', async (message) => {
  try {
    // Abaikan pesan dari bot lain / dirinya sendiri.
    if (message.author.bot) return;

    const isDM = !message.guild;
    const mentioned = message.mentions.users.has(client.user.id);

    // Hanya respons kalau di-mention di server, ATAU di DM.
    if (!mentioned && !isDM) return;

    // Bersihkan teks: buang mention bot, sisakan pertanyaannya.
    const mentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
    const question = message.content.replace(mentionRegex, '').trim();

    // Cek apakah ada file teks yang dilampirkan user untuk diperiksa/diedit.
    const fileAttachments = [...message.attachments.values()]
      .filter((a) => TEXT_FILE_EXTENSIONS.includes(getExt(a.name)))
      .slice(0, MAX_FILES_PER_MESSAGE);

    if (!question && fileAttachments.length === 0) {
      await message.reply('Halo! Tag aku lalu tulis pertanyaanmu, lampirkan file untuk diperiksa/diperbaiki, atau minta aku buatkan gambar. 👋');
      return;
    }

    // Tampilkan indikator "sedang mengetik" selama proses.
    await message.channel.sendTyping().catch(() => {});

    // Mode gambar — skip kalau ada file dilampirkan (berarti user mau edit/cek file, bukan gambar).
    if (fileAttachments.length === 0 && isImageRequest(question)) {
      const { imageBuffer, text } = await generateImage(question);
      if (imageBuffer) {
        const file = makeFile(imageBuffer, 'hasil.png');
        await message.reply({
          content: (text || `Nih hasil gambarnya: "${question}"`).slice(0, 2000),
          files: [file],
        });
        return;
      }
      // Kalau gagal, jatuh ke jawaban teks.
    }

    // Bangun pertanyaan final: gabungkan teks user + isi file yang dilampirkan (kalau ada).
    let finalQuestion = question;
    if (fileAttachments.length > 0) {
      const parts = [];
      for (const att of fileAttachments) {
        try {
          const content = await downloadAttachmentText(att);
          parts.push(`// === File: ${att.name} ===\n${content}`);
        } catch (e) {
          parts.push(`// Gagal membaca file "${att.name}": ${e.message}`);
        }
      }
      const instruction = question
        || 'Periksa file yang dilampirkan, identifikasi error/masalahnya, lalu perbaiki dan berikan versi LENGKAP yang sudah diperbaiki dalam code block.';
      finalQuestion = `${instruction}\n\n${parts.join('\n\n')}`;
    }

    // Mode teks + pencarian + sumber.
    const { text, sources } = await askGemini(finalQuestion);
    const blocks = extractCodeBlocks(text);

    if (shouldSendAsFile(question, blocks)) {
      await replyWithFiles(message, text, blocks);
      return;
    }

    await message.reply({
      content: formatAnswer(text, sources),
      // Matikan preview link supaya tidak memenuhi layar.
      flags: MessageFlags.SuppressEmbeds,
    });
  } catch (err) {
    await message.reply(friendlyError(err)).catch(() => {});
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('[bot] DISCORD_TOKEN belum di-set. Set env DISCORD_TOKEN dengan Bot Token dari Developer Portal.');
  process.exit(1);
}

client.login(token);
