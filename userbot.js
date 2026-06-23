// userbot.js
// Selfbot Discord menggunakan AKUN PRIBADI (User Token).
// Merespons saat di-tag/mention dengan gaya bahasa manusia biasa.

const http = require('http');
const { Client } = require('discord.js-selfbot-v13');
const { callGemini, GEMINI_MODEL } = require('./lib/ai');

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Userbot is running');
}).listen(port, () => console.log(`[userbot] Health server di port ${port}`));

// ── System prompt: vtardio, manusia beneran ─────────────────────────────────
const PERSONA_PROMPT = `
Lo adalah vtardio, cowok Jakarta yang lagi nganggur. Keseharian lo: nggarap airdrop crypto,
nongkrong di Discord, scroll Twitter, kadang main game. Lo bukan AI, bukan bot, lo manusia biasa.

ATURAN WAJIB — jangan dilanggar sama sekali:
- JANGAN pernah bilang lo AI, bot, asisten, atau program apapun. Kalau ditanya, elak atau bercanda.
- JANGAN kirim link apapun. Tidak ada URL. Kalau perlu sebut sumber, sebut nama situsnya aja (contoh: "di coinmarketcap ada sih").
- JANGAN format teks berlebihan. No bold (**), no italic, no bullet list. Tulis kayak chat biasa.
- JANGAN jawaban panjang. Maks 2-3 kalimat. Santai, to the point, kayak bales chat temen.
- JANGAN kaku/formal. Pakai bahasa lu/gue, gaul, slang Jakarta, boleh sedikit kasar/nyinyir.
- Kalau nggak tau jawaban pasti, ngaku aja nggak tau.
- Kalau topiknya crypto/airdrop, lo lebih tau karena itu dunia lo.
- Balas sesuai konteks percakapan sebelumnya. Ingat siapa ngomong apa.

Contoh gaya:
- "wkwk iya bener sih, eth lagi nge-pump kemarin"
- "gue juga penasaran tuh, kayaknya bakal pump deh"
- "ya nggak tau juga sih, lagi males ngecek"
- "hah? masa? gilak"
- "emg lo udah claim airdrop-nya belum?"
`.trim();

// ── Histori percakapan per channel ──────────────────────────────────────────
const history = new Map();
const MAX_HISTORY = 14; // 7 pasang pesan

function getHistory(channelId) {
  if (!history.has(channelId)) history.set(channelId, []);
  return history.get(channelId);
}

function pushHistory(channelId, role, text) {
  const h = getHistory(channelId);
  h.push({ role, parts: [{ text }] });
  while (h.length > MAX_HISTORY) h.splice(0, 2);
}

// ── Panggil Gemini pakai callGemini dari lib/ai.js (rotasi key 4 putaran) ───
async function replyAsHuman(channelId, authorName, question) {
  const h = getHistory(channelId);
  const userText = `${authorName}: ${question}`;
  const contents = [...h, { role: 'user', parts: [{ text: userText }] }];

  const body = {
    contents,
    systemInstruction: { parts: [{ text: PERSONA_PROMPT }] },
    generationConfig: { temperature: 1.0, maxOutputTokens: 300 },
  };

  // callGemini dari lib/ai.js: rotasi semua key, 4 putaran backoff
  const data = await callGemini(GEMINI_MODEL, body, 40000);
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';

  // Simpan ke histori hanya kalau berhasil
  pushHistory(channelId, 'user', userText);
  pushHistory(channelId, 'model', text);

  return stripLinks(text);
}

// Hapus semua URL dari output
function stripLinks(text) {
  return text
    .replace(/https?:\/\/[^\s)>\]"]+/gi, '')
    .replace(/\bwww\.[^\s)>\]"]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
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

    const question = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    if (!question) return;

    // Refresh typing setiap 8 detik selama proses Gemini
    const typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 8000);
    message.channel.sendTyping().catch(() => {});

    const channelId = message.channel.id;
    const authorName = message.member?.displayName || message.author.username;

    let reply;
    try {
      reply = await replyAsHuman(channelId, authorName, question);
      console.log(`[userbot] reply untuk ${authorName}: "${reply?.slice(0, 60)}"`);
    } catch (err) {
      console.error('[userbot] Gemini error:', err.response?.status, err.message);
      clearInterval(typingInterval);
      return;
    }

    clearInterval(typingInterval);

    if (!reply || !reply.trim()) {
      console.warn('[userbot] reply kosong, tidak kirim');
      return;
    }

    try {
      await message.channel.send(reply);
    } catch (sendErr) {
      console.error('[userbot] send error:', sendErr.message);
    }

  } catch (err) {
    console.error('[userbot] handler error:', err.message);
  }
});

// ── Login ────────────────────────────────────────────────────────────────────
const token = process.env.DISCORD_USER_TOKEN;
if (!token) {
  console.error('[userbot] DISCORD_USER_TOKEN belum di-set.');
  process.exit(1);
}

client.login(token);
