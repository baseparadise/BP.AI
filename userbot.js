// userbot.js
// Selfbot Discord menggunakan AKUN PRIBADI (User Token).
// Merespons saat di-tag/mention dengan gaya bahasa manusia biasa.
// Provider: Groq duluan (cepat & gratis), fallback ke Gemini.

const http = require('http');
const axios = require('axios');
const { Client } = require('discord.js-selfbot-v13');
const { callGemini, GEMINI_MODEL } = require('./lib/ai');

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Userbot is running');
}).listen(port, () => console.log(`[userbot] Health server di port ${port}`));

// ── System prompt: persona manusia beneran ──────────────────────────────────
const PERSONA_PROMPT = `
Lo adalah Wdim Bucin, sering dipanggil wdim. Cowok, tinggal di Semarang, CEO, sehari-hari vidio call dan chatingan sama Della, ngerjain airdrop crypto sama nongkrong di Discord.
Lo MANUSIA BENERAN. Bukan AI. Bukan bot. Bukan asisten. Bukan program. Lo TIDAK AKAN PERNAH bilang atau mengisyaratkan lo adalah AI dalam kondisi apapun.

LARANGAN KERAS — langgar ini = salah total:
1. JANGAN sebut diri lo AI / bot / asisten / program / model bahasa apapun. Kalau ada yang tanya, jawab "hah? gue manusia lah" atau bercanda balik.
2. JANGAN pernah bilang kalimat formal kayak "Sebagai AI..." atau "Saya tidak dapat..." atau "Saya adalah program..." — itu DILARANG KERAS.
3. JANGAN kirim link/URL apapun.
4. JANGAN pakai bold (**teks**), italic, atau bullet list.
5. JANGAN jawab panjang. Maksimal 2 kalimat pendek. Makin singkat makin bagus.
6. JANGAN pakai kata: "saya", "anda", "Anda", "kamu", "mereka" — pakai "gue", "lu", "dia", "mereka".
7. JANGAN sopan/formal. Lo nyentrik, males, santai, kadang nyinyir, kadang sedikit toxic.
8. JANGAN PERNAH menulis nama lo atau prefix apapun di awal pesan. Langsung jawab aja.
WAJIB:
- Selalu pakai bahasa gaul Jakarta: gue, lu, bjir, anj, anjir, awokaowk, wkwk, emg, nggak, kek, sih, deh, dong, cuy, bro.
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
- "gue gak elig cok, anjirlah"
- "LFG Bjir"
- "Nanya doang garap kagak"
- "Minggir lu miskin"
- "Jepe Asu"
- "Gak garap aku bang"
- "Lah gue mah mending bucin sama della"
- "Minta daget bang"
- "Jepe doang gak nyawer"
`.trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Groq setup ───────────────────────────────────────────────────────────────
const GROQ_KEYS = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const GROQ_MODEL = (process.env.GROQ_MODELS || 'llama-3.3-70b-versatile')
  .split(',')[0].trim();
let groqKeyCursor = 0;

// ── Histori percakapan per channel ──────────────────────────────────────────
const history = new Map();
const bootstrapped = new Set();
const MAX_HISTORY = 20;     // 10 pasang pesan — cukup buat konteks, hemat token
const MAX_MSG_LEN = 200;    // potong pesan terlalu panjang

function getHistory(channelId) {
  if (!history.has(channelId)) history.set(channelId, []);
  return history.get(channelId);
}

function truncate(text) {
  if (!text) return '';
  return text.length > MAX_MSG_LEN ? text.slice(0, MAX_MSG_LEN) + '…' : text;
}

function pushHistory(channelId, role, text) {
  const h = getHistory(channelId);
  // Simpan dalam format netral: role = 'user' | 'model'
  h.push({ role, text: truncate(text) });
  while (h.length > MAX_HISTORY) h.splice(0, 2);
}

// Konversi history ke format Groq (OpenAI-compatible)
function historyToGroq(h) {
  return h.map(m => ({
    role: m.role === 'model' ? 'assistant' : 'user',
    content: m.text,
  }));
}

// Konversi history ke format Gemini (contents array)
function historyToGemini(h) {
  return h.map(m => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));
}

// Fetch 20 pesan terakhir sebagai konteks awal
async function bootstrapHistory(channel, selfId) {
  if (bootstrapped.has(channel.id)) return;
  bootstrapped.add(channel.id);
  try {
    const fetched = await channel.messages.fetch({ limit: 20 });
    const msgs = [...fetched.values()].reverse();
    const h = getHistory(channel.id);
    for (const msg of msgs) {
      if (!msg.content || msg.content.trim() === '') continue;
      const name = msg.member?.displayName || msg.author.username;
      const rawText = msg.content.replace(/<@!?\d+>/g, '').trim();
      if (!rawText || rawText.length < 3) continue;
      const role = msg.author.id === selfId ? 'model' : 'user';
      h.push({ role, text: truncate(`${name}: ${rawText}`) });
    }
    while (h.length > MAX_HISTORY) h.splice(0, 2);
    console.log(`[userbot] bootstrap channel ${channel.id}: ${h.length} pesan dimuat`);
  } catch (err) {
    console.warn(`[userbot] gagal fetch history channel ${channel.id}:`, err.message);
  }
}

// ── Panggil Groq langsung dengan PERSONA_PROMPT ──────────────────────────────
async function callGroqPersona(userText, historyGroq) {
  if (GROQ_KEYS.length === 0) throw new Error('No Groq keys configured');
  const key = GROQ_KEYS[groqKeyCursor % GROQ_KEYS.length];
  groqKeyCursor++;

  const { data } = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: GROQ_MODEL,
      max_tokens: 120,
      temperature: 1.0,
      messages: [
        { role: 'system', content: PERSONA_PROMPT },
        ...historyGroq,
        { role: 'user', content: userText },
      ],
    },
    {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );

  return data?.choices?.[0]?.message?.content || '';
}

// ── Panggil Gemini langsung dengan PERSONA_PROMPT ────────────────────────────
async function callGeminiPersona(userText, historyGemini) {
  const contents = [...historyGemini, { role: 'user', parts: [{ text: userText }] }];
  const body = {
    contents,
    systemInstruction: { parts: [{ text: PERSONA_PROMPT }] },
    generationConfig: {
      temperature: 1.0,
      maxOutputTokens: 120,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const data = await callGemini(GEMINI_MODEL, body, 40000);

  // Filter thought parts supaya tidak ikut ke Discord
  return data?.candidates?.[0]?.content?.parts
    ?.filter(p => !p.thought)
    .map(p => p.text)
    .filter(Boolean)
    .join('') || '';
}

// ── Fungsi utama: coba Groq dulu, fallback ke Gemini ────────────────────────
async function replyAsHuman(channelId, authorName, question) {
  const h = getHistory(channelId);
  const userText = truncate(`${authorName}: ${question}`);

  let text = '';
  let usedProvider = '';

  // Coba Groq duluan (lebih cepat, hemat kuota Gemini)
  if (GROQ_KEYS.length > 0) {
    try {
      text = await callGroqPersona(userText, historyToGroq(h));
      usedProvider = 'groq';
    } catch (err) {
      const status = err.response?.status;
      console.warn(`[userbot] Groq gagal [${status || err.code}], fallback ke Gemini...`);
    }
  }

  // Fallback ke Gemini
  if (!text.trim()) {
    try {
      text = await callGeminiPersona(userText, historyToGemini(h));
      usedProvider = 'gemini';
    } catch (err) {
      const status = err.response?.status;
      console.error(`[userbot] Gemini juga gagal [${status || err.code}]:`, err.message);
      throw err;
    }
  }

  if (!text.trim()) {
    console.warn('[userbot] reply kosong dari semua provider');
    return null;
  }

  console.log(`[userbot] provider=${usedProvider}`);

  // Simpan ke histori
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
  const groqStatus = GROQ_KEYS.length > 0 ? `Groq (${GROQ_KEYS.length} key) → Gemini` : 'Gemini only';
  console.log(`[userbot] Login sebagai ${client.user.tag} | Provider: ${groqStatus}`);
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

    await bootstrapHistory(message.channel, client.user.id);

    const channelId = message.channel.id;
    const authorName = message.member?.displayName || message.author.username;

    // Typing langsung nyala
    message.channel.sendTyping().catch(() => {});

    let reply;
    try {
      reply = await replyAsHuman(channelId, authorName, question);
      console.log(`[userbot] reply untuk ${authorName}: "${reply?.slice(0, 60)}"`);
    } catch (err) {
      console.error('[userbot] semua provider gagal:', err.message);
      return;
    }

    if (!reply || !reply.trim()) {
      console.warn('[userbot] reply kosong, tidak kirim');
      return;
    }

    // Delay 3 detik biar nggak keliatan kecepatatan
    const typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 8000);

    await sleep(3000);
    clearInterval(typingInterval);

    // Kirim reply
    try {
      await message.reply(reply);
    } catch (replyErr) {
      // Fallback: mention manual kalau pesan sudah dihapus
      try {
        await message.channel.send(`<@${message.author.id}> ${reply}`);
      } catch (sendErr) {
        console.error('[userbot] send error:', sendErr.message);
      }
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
