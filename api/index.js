// api/index.js
// Vercel Serverless Function — handle Discord Interactions webhook.
// Command /cp <pertanyaan> -> jawab pakai Gemini AI.
//
// PRINSIP PENTING (pelajaran dari bug sebelumnya):
// 1. Semua modul di-require di top-level HANYA kalau ringan (axios, tweetnacl,
//    discord-interactions semua aman). Modul berat/rawan gagal load tetap di-lazy-require
//    di dalam try/catch supaya kalau gagal, bot tetap bisa balas (bukan crash total).
// 2. Proses background (call Gemini + kirim followup) WAJIB di-`await`, bukan
//    fire-and-forget — kalau tidak, Vercel mematikan function sebelum followup terkirim
//    dan Discord stuck "thinking..." selamanya.
// 3. Logging detail di setiap tahap supaya kalau gagal, gampang dilacak dari Vercel Logs.

// api/index.js
const nacl = require('tweetnacl');
const axios = require('axios');
const { InteractionType, InteractionResponseType } = require('discord-interactions');
const { waitUntil } = require('@vercel/functions');

const PUBLIC_KEY = process.env.PUBLIC_KEY;
// CATATAN: gemini-1.5-flash SUDAH DIPENSIUNKAN Google (retired 2025) -> request balik 404.
// Pakai model yang masih aktif. 'gemini-2.5-flash' stabil & murah. Bisa override via env GEMINI_MODEL.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const SYSTEM_PROMPT = 'Kamu adalah asisten AI yang ramah dan membantu di server Discord. Jawab singkat, jelas, dan dalam Bahasa Indonesia.';

// Fungsi delay untuk retry logic
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async (req, res) => {
  // 1. Baca Raw Body (Wajib untuk verifikasi Discord)
  const rawBody = await readRawBody(req);
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  // 2. Verifikasi Keamanan
  if (!verifyDiscordRequest(rawBody, signature, timestamp, PUBLIC_KEY)) {
    return res.status(401).end('Invalid request signature');
  }

  const interaction = JSON.parse(rawBody.toString());

  // 3. Jawab PING (Discord handshake)
  if (interaction.type === InteractionType.PING) {
    return res.json({ type: InteractionResponseType.PONG });
  }

  // 4. Handle Slash Command /cp
  if (interaction.type === InteractionType.APPLICATION_COMMAND && interaction.data?.name === 'cp') {
    const userQuestion = interaction.data.options?.[0]?.value || 'Halo';

    // Segera kirim ACK agar tidak timeout
    res.status(200).json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });

    // Jalankan di latar belakang dengan waitUntil agar tidak terbunuh Vercel
    waitUntil(
      handleCpCommand(interaction, userQuestion)
        .catch(err => console.error('[index] Error background:', err))
    );
    
    return;
  }

  res.status(404).end('Unknown interaction');
};

// --- Helper Functions ---

async function handleCpCommand(interaction, question) {
  const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${interaction.token}`;
  try {
    const answer = await askGemini(question);
    await axios.post(webhookUrl, { content: answer });
  } catch (err) {
    // Tampilkan penyebab asli supaya gampang dilacak (status + pesan dari Google API).
    const status = err.response?.status;
    const apiMsg = err.response?.data?.error?.message || err.message;
    console.error('[handleCpCommand] Gagal:', status, apiMsg);

    let userMsg;
    if (status === 429) {
      userMsg = '⚠️ Rate limit Gemini tercapai. Coba lagi sebentar lagi.';
    } else if (status === 404) {
      userMsg = `⚠️ Model "${GEMINI_MODEL}" tidak ditemukan/sudah dipensiunkan. Set env GEMINI_MODEL ke model yang aktif.`;
    } else {
      userMsg = `⚠️ Gagal memproses jawaban AI. (${status || 'error'}: ${apiMsg})`;
    }
    await axios.post(webhookUrl, { content: userMsg });
  }
}

// Fungsi dengan Retry Logic untuk menangani 429
async function askGemini(question, retries = 0) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  
  try {
    const { data } = await axios.post(url, {
      contents: [{ role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\nPertanyaan: ${question}` }] }]
    }, { timeout: 15000 });
    
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Tidak ada jawaban.';
  } catch (err) {
    // Jika 429 (Too Many Requests), coba lagi dengan jeda (Exponential Backoff)
    if (err.response?.status === 429 && retries < 5) {
      const waitTime = (Math.pow(2, retries) * 2000) + (Math.random() * 1000);
      console.log(`[askGemini] 429 Terdeteksi, retry ke-${retries + 1} dalam ${Math.round(waitTime)}ms`);
      await sleep(waitTime);
      return askGemini(question, retries + 1);
    }
    throw err;
  }
}

function verifyDiscordRequest(rawBody, signature, timestamp, publicKey) {
  if (!signature || !timestamp || !publicKey) return false;
  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody),
      Buffer.from(signature, 'hex'),
      Buffer.from(publicKey, 'hex')
    );
  } catch {
    return false;
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
