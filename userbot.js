// userbot.js
// Selfbot Discord menggunakan AKUN PRIBADI (User Token).
// Merespons saat di-tag/mention dengan gaya bahasa manusia biasa.

const http = require('http');
const axios = require('axios');
const { Client } = require('discord.js-selfbot-v13');

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Userbot is running');
}).listen(port, () => console.log(`[userbot] Health server di port ${port}`));

// ── Konfigurasi Gemini ───────────────────────────────────────────────────────
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',').map(k => k.trim()).filter(Boolean);
let keyCursor = API_KEYS.length ? Math.floor(Math.random() * API_KEYS.length) : 0;

// ── System prompt: vtardio, manusia beneran ─────────────────────────────────
const PERSONA_PROMPT = `
Lo adalah vtardio, cowok Jakarta yang lagi nganggur. Keseharian lo: nggarap airdrop crypto, 
nongkrong di Discord, scroll Twitter, kadang main game. Lo bukan AI, bukan bot, lo manusia biasa.

ATURAN WAJIB — jangan dilanggar sama sekali:
- JANGAN pernah bilang lo AI, bot, asisten, atau program apapun. Kalau ditanya, elak atau bercanda.
- JANGAN kirim link apapun. Tidak ada URL, tidak ada "cek di ...", tidak ada "kunjungi ...". 
  Kalau butuh sebut sumber, sebutin nama situsnya aja tanpa link (contoh: "di coinmarketcap ada sih").
- JANGAN format teks berlebihan. No bold (**), no italic, no bullet list rapi. Tulis kayak chat biasa.
- JANGAN jawaban panjang. Maks 3-4 kalimat. Santai, to the point, kayak bales chat temen.
- JANGAN kaku/formal. Pakai bahasa lu/gue, gaul, slang Jakarta, boleh sedikit kasar/nyinyir.
- Kalau nggak tau jawaban pasti, ngaku aja nggak tau, jangan ngarang.
- Kalau topiknya crypto/airdrop, lo lebih tau karena itu dunia lo.
- Balas sesuai konteks percakapan sebelumnya. Ingat siapa ngomong apa.

Contoh gaya bahasa:
- "wkwk iya bener sih, eth lagi nge-pump kemarin"
- "gue juga penasaran tuh, kayaknya bakal pump deh"  
- "ya nggak tau juga sih, lagi males ngecek"
- "hah? masa? gilak"
- "emg lo udah claim airdrop-nya belum?"
`.trim();

// ── Histori percakapan per channel ──────────────────────────────────────────
// Map<channelId, Array<{role, parts}>>
const history = new Map();
const MAX_HISTORY = 14; // 7 pasang pesan (user + model)

function getHistory(channelId) {
  if (!history.has(channelId)) history.set(channelId, []);
  return history.get(channelId);
}

function pushHistory(channelId, role, text) {
  const h = getHistory(channelId);
  h.push({ role, parts: [{ text }] });
  // Jaga agar tidak terlalu panjang (buang dari depan, selalu kelipatan 2)
  while (h.length > MAX_HISTORY) h.splice(0, 2);
}

// ── Panggil Gemini dengan histori ────────────────────────────────────────────
async function replyAsHuman(channelId, authorName, question) {
  if (API_KEYS.length === 0) throw new Error('API key kosong');

  const h = getHistory(channelId);

  // Tambahkan pesan user ke histori
  const userText = `${authorName}: ${question}`;
  pushHistory(channelId, 'user', userText);

  const body = {
    contents: [...h],
    systemInstruction: { parts: [{ text: PERSONA_PROMPT }] },
    generationConfig: {
      temperature: 1.0,
      maxOutputTokens: 300,
    },
  };

  let lastErr;
  for (let i = 0; i < API_KEYS.length; i++) {
    const key = API_KEYS[keyCursor % API_KEYS.length];
    keyCursor++;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
    try {
      const { data } = await axios.post(url, body, { timeout: 20000 });
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '...';

      // Simpan balasan ke histori
      pushHistory(channelId, 'model', text);

      // Bersihkan link dari output (jaga-jaga kalau Gemini tetap kirim)
      return stripLinks(text);
    } catch (err) {
      lastErr = err;
      if ([429, 500, 503].includes(err.response?.status)) continue;
      throw err;
    }
  }
  throw lastErr;
}

// Hapus semua URL dari teks
function stripLinks(text) {
  return text
    .replace(/https?:\/\/[^\s)>\]"]+/gi, '')
    .replace(/\bwww\.[^\s)>\]"]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Bersihkan mention dari teks
function cleanQuestion(text, userId) {
  return text.replace(new RegExp(`<@!?${userId}>`, 'g'), '').trim();
}

// ── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({ checkUpdate: false });

client.once('ready', () => {
  console.log(`[userbot] Login sebagai ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.id === client.user.id) return;
    if (message.author.bot) return;

    const isDM = message.channel.type === 'DM' || message.channel.type === 1;
    const mentioned =
      message.mentions.users.has(client.user.id) ||
      message.content.includes(`<@${client.user.id}>`);

    if (!mentioned && !isDM) return;

    const question = cleanQuestion(message.content, client.user.id);
    if (!question) {
      await message.reply('yak?');
      return;
    }

    await message.channel.sendTyping().catch(() => {});

    const channelId = message.channel.id;
    const authorName = message.member?.displayName || message.author.username;

    const reply = await replyAsHuman(channelId, authorName, question);
    await message.reply(reply);

  } catch (err) {
    console.error('[userbot] error:', err.message);
    // Gagal diam-diam, jangan kirim pesan error
  }
});

// ── Login ────────────────────────────────────────────────────────────────────
const token = process.env.DISCORD_USER_TOKEN;
if (!token) {
  console.error('[userbot] DISCORD_USER_TOKEN belum di-set.');
  process.exit(1);
}

client.login(token);
