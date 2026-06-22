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

const nacl = require('tweetnacl');
const axios = require('axios');
const { InteractionType, InteractionResponseType } = require('discord-interactions');
const { waitUntil } = require('@vercel/functions'); // WAJIB: Library untuk menjaga proses tetap hidup

const PUBLIC_KEY = process.env.PUBLIC_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const SYSTEM_PROMPT = 'Kamu adalah asisten AI yang ramah dan membantu di server Discord. Jawab singkat, jelas, dan dalam Bahasa Indonesia.';

module.exports = async (req, res) => {
  const rawBody = await readRawBody(req);
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  if (!verifyDiscordRequest(rawBody, signature, timestamp, PUBLIC_KEY)) {
    return res.status(401).end('Invalid request signature');
  }

  const interaction = JSON.parse(rawBody.toString());

  if (interaction.type === InteractionType.PING) {
    return res.json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND && interaction.data?.name === 'cp') {
    const userQuestion = interaction.data.options[0].value;

    // 1. Kirim ACK segera
    res.status(200).json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });

    // 2. Gunakan waitUntil agar proses AI di latar belakang tidak dimatikan Vercel
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
    console.error(err);
    await axios.post(webhookUrl, { content: 'Gagal memproses jawaban AI.' });
  }
}

async function askGemini(question) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const { data } = await axios.post(url, {
    contents: [{ role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\n${question}` }] }]
  }, { timeout: 15000 });
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Tidak ada jawaban.';
}

function verifyDiscordRequest(rawBody, signature, timestamp, publicKey) {
  if (!signature || !timestamp || !publicKey) return false;
  return nacl.sign.detached.verify(
    Buffer.from(timestamp + rawBody),
    Buffer.from(signature, 'hex'),
    Buffer.from(publicKey, 'hex')
  );
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
