// userbot.js
// Selfbot Discord menggunakan AKUN PRIBADI (User Token).
// Merespons saat di-tag/mention dengan gaya bahasa manusia biasa.

const http = require('http');
const { Client } = require('discord.js-selfbot-v13');
const { callGemini, GEMINI_MODEL } = require('./lib/ai');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Userbot is running');
}).listen(port, () => console.log(`[userbot] Health server di port ${port}`));

// ── System prompt: vtardio, manusia beneran ─────────────────────────────────
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
9. JANGAN PERNAH menampilkan proses berpikir, "SILENT THOUGHTS", atau rencana jawaban lo.
10. Berikan HANYA jawaban akhir yang akan langsung lo kirim ke chat. 
11. JANGAN tulis teks selain respons langsung untuk user.
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

// ── Histori percakapan per channel ──────────────────────────────────────────
const history = new Map();
const bootstrapped = new Set(); // channel yang sudah di-fetch history-nya
const MAX_HISTORY = 80; // 40 pasang pesan

function getHistory(channelId) {
  if (!history.has(channelId)) history.set(channelId, []);
  return history.get(channelId);
}

function pushHistory(channelId, role, text) {
  const h = getHistory(channelId);
  h.push({ role, parts: [{ text }] });
  while (h.length > MAX_HISTORY) h.splice(0, 2);
}

// Fetch 60 pesan terakhir dari channel Discord sebagai konteks awal
async function bootstrapHistory(channel, selfId) {
  if (bootstrapped.has(channel.id)) return;
  bootstrapped.add(channel.id);
  try {
    const fetched = await channel.messages.fetch({ limit: 60 });
    // Urutkan dari lama ke baru
    const msgs = [...fetched.values()].reverse();
    const h = getHistory(channel.id);
    for (const msg of msgs) {
      if (!msg.content || msg.content.trim() === '') continue;
      const name = msg.member?.displayName || msg.author.username;
      const text = `${name}: ${msg.content.replace(/<@!?\d+>/g, '').trim()}`;
      if (!text || text.length < 3) continue;
      // Pesan dari vtardio sendiri → role model, sisanya → role user
      const role = msg.author.id === selfId ? 'model' : 'user';
      h.push({ role, parts: [{ text }] });
    }
    // Batasi supaya tidak overflow
    while (h.length > MAX_HISTORY) h.splice(0, 2);
    console.log(`[userbot] bootstrap channel ${channel.id}: ${h.length} pesan dimuat`);
  } catch (err) {
    console.warn(`[userbot] gagal fetch history channel ${channel.id}:`, err.message);
  }
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

    // Muat history channel Discord (sekali per channel sejak bot nyala)
    await bootstrapHistory(message.channel, client.user.id);
    

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
    if (reply) {
      let typingTime = reply.length * 80; 
      if (typingTime < 2000) typingTime = 2000;
      if (typingTime > 6000) typingTime = 6000;
      await sleep(typingTime); 
    clearInterval(typingInterval);

    if (!reply || !reply.trim()) {
      console.warn('[userbot] reply kosong, tidak kirim');
      return;
    }

    try {
      await message.reply(reply);
    } catch (replyErr) {
      // Fallback kalau reply gagal
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
