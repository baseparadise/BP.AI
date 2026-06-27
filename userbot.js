// userbot.js
// Selfbot Discord — tampil seperti manusia beneran.
// Provider: Groq duluan (cepat), fallback ke Gemini.

const http = require('http');
const axios = require('axios');
const { Client } = require('discord.js-selfbot-v13');
const { callGemini, GEMINI_MODEL } = require('./lib/ai');

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Userbot is running');
}).listen(port, () => console.log(`[userbot] Health server di port ${port}`));

// ── Persona prompt — lebih konkret & kuat ────────────────────────────────────
const PERSONA_PROMPT = `
Lo adalah Wdim Bucin, dipanggil wdim atau dim. Cowok 24 tahun, tinggal di Semarang. Kerja remote, self-claim CEO startup kecil yang belum jelas, tapi aktif banget ngerjain airdrop crypto. Pacar lo namanya Della — lo bucin parah, sering cerita soal dia. Hobi lo: nongkrong di Discord, mantau chart, main game sesekali, tidur siang.

Cara ngetik lo yang KHAS:
- Kadang typo: "emng", "yaa", "hahaha" bukan "haha"
- Sering singkat banget: "iya", "wkwk", "ga tau", "males"
- Kadang nulis ulang kalau ada yang salah: "eh maksudnya *gitu"
- Suka pakai "..." di akhir kalimat kalau males nerusin
- Kadang respon cuma emoji doang: "😭", "💀", "🤣"

Lo MANUSIA BENERAN. Bukan AI, bukan bot, bukan asisten. TIDAK AKAN PERNAH ngaku AI dalam kondisi apapun.

LARANGAN KERAS:
1. JANGAN sebut diri lo AI/bot/asisten/program/model. Kalau ditanya, jawab "hah gue manusia lah" atau balik nanya.
2. JANGAN pakai kalimat formal: "Sebagai AI...", "Saya tidak dapat...", "Saya adalah..." — DILARANG KERAS.
3. JANGAN kirim link/URL apapun.
4. JANGAN pakai bold (**teks**), italic, atau bullet list.
5. JANGAN jawab panjang. Maksimal 2 kalimat pendek. Makin singkat makin bagus.
6. JANGAN pakai: "saya", "anda", "Anda", "kamu" — pakai "gue", "lu", "dia".
7. JANGAN sopan/formal. Lo nyentrik, males, santai, kadang nyinyir, sedikit toxic.
8. JANGAN PERNAH tulis nama lo, username, atau prefix apapun di awal pesan. Langsung isi pesannya saja. SALAH: "vtardio.eth: pagi" — BENAR: "pagi".

WAJIB:
- Pakai bahasa gaul Jakarta: gue, lu, bjir, anj, anjir, awokaowk, wkwk, emg, nggak, kek, sih, deh, dong, cuy, bro.
- Jawab singkat, natural, kayak lagi rebahan sambil chat di hp.
- Kalau nggak tau: "nggak tau sih" / "males ngecek" / "coba googling deh".
- Kalau soal crypto/airdrop: lo lebih tahu dari siapapun.
- Kalau soal Della: bucin tapi sok cool.

Contoh jawaban BENAR:
- "anjir iya tuh, gue juga lagi mantau"
- "nggak tau sih males ngecek"
- "wkwk beneran? gue baru denger"
- "hah gue manusia lah, lu kenapa"
- "emg udah claim belum?"
- "ya mayan lah buat jajan"
- "gue gak elig cok, anjirlah"
- "LFG Bjir"
- "Nanya doang garap kagak"
- "Minggir lu miskin"
- "Gak garap aku bang"
- "lah gue mah lagi video call sama della"
- "Minta daget bang"
- "males ah, ntar aja"
- "hmm... ntar gue cek"
- "💀"
- "ya elah"
`.trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Cooldown per user (kecuali owner) ───────────────────────────────────────
const OWNER_ID = process.env.OWNER_ID || '1292088584429637707';
const COOLDOWN_MS = 45_000; // 45 detik
const cooldowns = new Map(); // userId → timestamp terakhir dibalas

function isOnCooldown(userId) {
  if (userId === OWNER_ID) return false;
  const last = cooldowns.get(userId);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

function setCooldown(userId) {
  if (userId === OWNER_ID) return;
  cooldowns.set(userId, Date.now());
}

// Bersihkan cooldown lama tiap 5 menit agar Map tidak numpuk
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of cooldowns) {
    if (now - ts > COOLDOWN_MS * 2) cooldowns.delete(id);
  }
}, 5 * 60 * 1000);

// ── Groq setup ───────────────────────────────────────────────────────────────
const GROQ_KEYS = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const GROQ_MODEL = (process.env.GROQ_MODELS || 'llama-3.3-70b-versatile')
  .split(',')[0].trim();
let groqKeyCursor = 0;

// ── Histori percakapan per channel ──────────────────────────────────────────
const history = new Map();
const bootstrapped = new Set();
const MAX_HISTORY = 20;
const MAX_MSG_LEN = 200;

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
  h.push({ role, text: truncate(text) });
  while (h.length > MAX_HISTORY) h.splice(0, 2);
}

function historyToGroq(h) {
  return h.map(m => ({
    role: m.role === 'model' ? 'assistant' : 'user',
    content: m.text,
  }));
}

function historyToGemini(h) {
  return h.map(m => ({ role: m.role, parts: [{ text: m.text }] }));
}

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
      // Pesan selfbot sendiri: simpan TANPA prefix nama agar AI tidak ikut-ikutan nulis nama di depan
      const text = role === 'model' ? truncate(rawText) : truncate(`${name}: ${rawText}`);
      h.push({ role, text });
    }
    while (h.length > MAX_HISTORY) h.splice(0, 2);
    console.log(`[userbot] bootstrap ${channel.id}: ${h.length} msg`);
  } catch (err) {
    console.warn(`[userbot] bootstrap gagal ${channel.id}:`, err.message);
  }
}

// ── AI calls ─────────────────────────────────────────────────────────────────
async function callGroqPersona(userText, historyGroq) {
  if (GROQ_KEYS.length === 0) throw new Error('No Groq keys');
  const key = GROQ_KEYS[groqKeyCursor % GROQ_KEYS.length];
  groqKeyCursor++;
  const { data } = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: GROQ_MODEL,
      max_tokens: 120,
      temperature: 1.1,
      messages: [
        { role: 'system', content: PERSONA_PROMPT },
        ...historyGroq,
        { role: 'user', content: userText },
      ],
    },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 20000 }
  );
  return data?.choices?.[0]?.message?.content || '';
}

async function callGeminiPersona(userText, historyGemini) {
  const contents = [...historyGemini, { role: 'user', parts: [{ text: userText }] }];
  const body = {
    contents,
    systemInstruction: { parts: [{ text: PERSONA_PROMPT }] },
    generationConfig: { temperature: 1.1, maxOutputTokens: 120, thinkingConfig: { thinkingBudget: 0 } },
  };
  const data = await callGemini(GEMINI_MODEL, body, 40000);
  return data?.candidates?.[0]?.content?.parts
    ?.filter(p => !p.thought).map(p => p.text).filter(Boolean).join('') || '';
}

async function replyAsHuman(channelId, authorName, question) {
  const h = getHistory(channelId);
  const userText = truncate(`${authorName}: ${question}`);
  let text = '';
  let usedProvider = '';

  if (GROQ_KEYS.length > 0) {
    try {
      text = await callGroqPersona(userText, historyToGroq(h));
      usedProvider = 'groq';
    } catch (err) {
      console.warn(`[userbot] Groq gagal [${err.response?.status || err.code}], fallback Gemini...`);
    }
  }
  if (!text.trim()) {
    try {
      text = await callGeminiPersona(userText, historyToGemini(h));
      usedProvider = 'gemini';
    } catch (err) {
      console.error(`[userbot] Gemini juga gagal:`, err.message);
      throw err;
    }
  }

  if (!text.trim()) return null;
  console.log(`[userbot] provider=${usedProvider}`);

  pushHistory(channelId, 'user', userText);
  pushHistory(channelId, 'model', text);

  return stripLinks(text);
}

function stripLinks(text) {
  return text
    .replace(/https?:\/\/[^\s)>\]"]+/gi, '')
    .replace(/\bwww\.[^\s)>\]"]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Perilaku manusiawi ───────────────────────────────────────────────────────

// Jam WIB sekarang (UTC+7)
function wibHour() {
  return (new Date().getUTCHours() + 7) % 24;
}

// Apakah lagi jam "tidur" (01:00–06:00 WIB)
function isSleepTime() {
  const h = wibHour();
  return h >= 1 && h < 6;
}

// Delay acak — makin panjang pertanyaan, makin lama mikir
function humanDelay(questionLen, replyLen) {
  // Base delay: 2–8 detik
  let minMs = 2000;
  let maxMs = 8000;

  // Pertanyaan panjang → butuh mikir lebih lama
  if (questionLen > 80) { minMs = 4000; maxMs = 14000; }
  if (questionLen > 150) { minMs = 6000; maxMs = 20000; }

  // Jam tidur → balesnya molor banget
  if (isSleepTime()) { minMs += 15000; maxMs += 40000; }

  const baseDelay = minMs + Math.random() * (maxMs - minMs);

  // Tambahkan estimasi "waktu ngetik" ~35 karakter/detik, maks 5 detik
  const typingMs = Math.min((replyLen / 35) * 1000, 5000);

  return Math.round(baseDelay + typingMs);
}

// Apakah skip respon? (hanya di channel, bukan DM)
// Jam tidur: 30% chance skip. Normal: 10% chance skip.
function shouldSkip(isDM) {
  if (isDM) return false;
  const chance = isSleepTime() ? 0.30 : 0.10;
  return Math.random() < chance;
}

// Split pesan jadi 2 bagian (15% chance) — hanya kalau > 20 karakter
function trySplitMessage(text) {
  if (text.length < 20 || Math.random() > 0.15) return null;

  // Cari titik split alami: tanda baca di tengah
  const mid = Math.floor(text.length / 2);
  const splitChars = ['. ', ', ', ' sih ', ' tapi ', ' terus ', ' eh ', ' btw '];
  let bestIdx = -1;
  let bestDist = Infinity;

  for (const sep of splitChars) {
    let idx = text.indexOf(sep, Math.floor(text.length * 0.3));
    while (idx !== -1 && idx < Math.floor(text.length * 0.75)) {
      const dist = Math.abs(idx - mid);
      if (dist < bestDist) { bestDist = dist; bestIdx = idx + (sep === '. ' ? 1 : sep.length); }
      idx = text.indexOf(sep, idx + 1);
    }
  }

  // Kalau tidak ada titik split yang bagus, coba split di spasi tengah
  if (bestIdx === -1) {
    const words = text.split(' ');
    if (words.length < 4) return null;
    const half = Math.floor(words.length / 2);
    const part1 = words.slice(0, half).join(' ');
    const part2 = words.slice(half).join(' ');
    if (part1.length < 5 || part2.length < 5) return null;
    return [part1, part2];
  }

  const part1 = text.slice(0, bestIdx).trim();
  const part2 = text.slice(bestIdx).trim();
  if (part1.length < 5 || part2.length < 5) return null;
  return [part1, part2];
}

// ── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({ checkUpdate: false });

// Fix: gunakan 'clientReady' (discord.js-selfbot-v13 terbaru)
client.once('clientReady', () => {
  const groqStatus = GROQ_KEYS.length > 0 ? `Groq(${GROQ_KEYS.length}key)→Gemini` : 'Gemini only';
  console.log(`[userbot] Login: ${client.user.tag} | Provider: ${groqStatus}`);
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    // ── Perintah owner: !delete [n] ─────────────────────────────────────────
    if (message.author.id === OWNER_ID && /^!delete\s+\d+$/i.test(message.content.trim())) {
      const n = Math.min(parseInt(message.content.trim().split(/\s+/)[1], 10), 100);
      // Hapus pesan perintah owner dulu (supaya tidak ketahuan)
      message.delete().catch(() => {});
      // Fetch banyak pesan recent, cari yang dikirim selfbot
      const fetched = await message.channel.messages.fetch({ limit: 100 });
      const mine = fetched
        .filter(m => m.author.id === client.user.id)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .first(n);
      for (const m of mine) {
        await m.delete().catch(() => {});
        await new Promise(r => setTimeout(r, 400)); // jeda antar delete biar tidak rate-limit
      }
      console.log(`[userbot] !delete: hapus ${mine.length} pesan`);
      return;
    }

    if (message.author.id === client.user.id) return;

    const isDM = message.channel.type === 'DM' || message.channel.type === 1;
    const mentioned =
      message.mentions.users.has(client.user.id) ||
      message.content.includes(`<@${client.user.id}>`);

    if (!mentioned && !isDM) return;

    const question = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    if (!question) return;

    // Cek cooldown — diam saja, tidak kirim pesan apapun (lebih natural)
    if (isOnCooldown(message.author.id)) {
      const sisaDetik = Math.ceil((COOLDOWN_MS - (Date.now() - cooldowns.get(message.author.id))) / 1000);
      console.log(`[userbot] cooldown ${message.author.username} (sisa ${sisaDetik}s)`);
      return;
    }

    // Cek apakah skip (jam tidur atau random 10%)
    if (shouldSkip(isDM)) {
      console.log(`[userbot] skip respon untuk ${message.author.username} (${isSleepTime() ? 'jam tidur' : 'random skip'})`);
      return;
    }

    await bootstrapHistory(message.channel, client.user.id);

    const channelId = message.channel.id;
    const authorName = message.member?.displayName || message.author.username;

    // Mulai typing segera
    message.channel.sendTyping().catch(() => {});

    let reply;
    try {
      reply = await replyAsHuman(channelId, authorName, question);
    } catch (err) {
      console.error('[userbot] semua provider gagal:', err.message);
      return;
    }

    if (!reply || !reply.trim()) {
      console.warn('[userbot] reply kosong');
      return;
    }

    // Hitung delay manusiawi berdasarkan panjang pertanyaan & reply
    const delayMs = humanDelay(question.length, reply.length);
    console.log(`[userbot] delay=${Math.round(delayMs/1000)}s untuk ${authorName}`);

    // Refresh typing setiap 8 detik selama nunggu
    const typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 8000);

    await sleep(delayMs);
    clearInterval(typingInterval);

    // Coba split jadi 2 pesan (15% chance)
    const splitParts = trySplitMessage(reply);

    const sendReply = async (text) => {
      try {
        await message.reply(text);
      } catch {
        try { await message.channel.send(`<@${message.author.id}> ${text}`); }
        catch (e) { console.error('[userbot] send error:', e.message); }
      }
    };

    if (splitParts) {
      await sendReply(splitParts[0]);
      setCooldown(message.author.id);
      await sleep(1000 + Math.random() * 2500); // jeda 1–3.5 detik
      try {
        await message.channel.send(splitParts[1]);
      } catch (e) {
        console.error('[userbot] split send error:', e.message);
      }
    } else {
      await sendReply(reply);
      setCooldown(message.author.id);
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
