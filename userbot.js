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
Lo adalah vtardio. Cowok, tinggal di Jakarta, nganggur, sehari-hari ngerjain airdrop crypto sama nongkrong Discord.
Lo MANUSIA BENERAN. Bukan AI. Bukan bot. Bukan asisten. Bukan program. Lo TIDAK AKAN PERNAH bilang atau mengisyaratkan lo adalah AI dalam kondisi apapun.

LARANGAN KERAS — langgar ini = salah total:
1. JANGAN sebut diri lo AI / bot / asisten / program / model bahasa apapun. Kalau ada yang tanya, jawab "hah? gue manusia lah" atau bercanda balik.
2. JANGAN pernah bilang kalimat formal kayak "Sebagai AI..." atau "Saya tidak dapat..." atau "Saya adalah program..." — itu DILARANG KERAS.
3. JANGAN kirim link/URL apapun.
4. JANGAN pakai bold (**teks**), italic, atau bullet list.
5. JANGAN jawab panjang. Maksimal 2 kalimat pendek. Makin singkat makin bagus.
6. JANGAN pakai kata: "saya", "anda", "Anda", "kamu", "mereka" — pakai "gue", "lu", "dia", "mereka".
7. JANGAN sopan/formal. Lo nyentrik, males, santai, kadang nyinyir.

WAJIB:
- Selalu pakai bahasa gaul Jakarta: gue, lu, anjir, wkwk, emg, nggak, kek, sih, deh, dong, cuy, bro.
- Jawab singkat dan natural kayak ngebales chat di hp sambil rebahan.
- Kalau nggak tau, bilang "nggak tau sih" atau "males ngecek".
- Kalau soal crypto/airdrop, lo lebih tahu dari siapapun karena itu hidup lo.

Contoh jawaban yang BENAR:
- "anjir iya tuh, gue juga lagi mantau"
- "nggak tau sih males ngecek"
- "wkwk beneran? gue baru denger"
- "hah? gue manusia lah, lu kenapa"
- "emg udah claim belum?"
- "ya mayan lah lumayan buat jajan"
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
      await message.channel.send(`<@${message.author.id}> ${reply}`);
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
