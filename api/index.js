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

const PUBLIC_KEY = process.env.PUBLIC_KEY;

// ====================== ⚙️ KONFIGURASI GEMINI (edit di sini) ======================
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const SYSTEM_PROMPT =
  'Kamu adalah asisten AI yang ramah dan membantu di server Discord. Jawab singkat, jelas, dan dalam Bahasa Indonesia kecuali user bertanya dalam bahasa lain.';
// =====================================================================================

module.exports = async (req, res) => {
  console.log(`[index] incoming ${req.method} request`);

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('[index] gagal baca raw body:', err.message);
    return res.status(400).send('Bad request body');
  }

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  if (!verifyDiscordRequest(rawBody, signature, timestamp, PUBLIC_KEY)) {
    console.error('[index] signature verification GAGAL');
    return res.status(401).send('Bad request signature');
  }

  let interaction;
  try {
    interaction = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('[index] gagal parse JSON interaction:', err.message);
    return res.status(400).send('Bad JSON');
  }

  // --- Discord PING (wajib untuk verifikasi endpoint) ---
  if (interaction.type === InteractionType.PING) {
    console.log('[index] menjawab PING dengan PONG');
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  // --- Slash command /cp ---
  if (
    interaction.type === InteractionType.APPLICATION_COMMAND &&
    interaction.data?.name === 'cp'
  ) {
    console.log('[index] menerima command /cp, mengirim deferred ack...');

    res.status(200).json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });

    // WAJIB di-await (lihat poin 2 di komentar atas file).
    try {
      await handleCpCommand(interaction);
      console.log('[index] handleCpCommand selesai tanpa error');
    } catch (err) {
      console.error('[index] handleCpCommand melempar error tak terduga:', err);
    }
    return;
  }

  console.warn('[index] interaction type tidak dikenali:', interaction.type);
  return res.status(400).send('Unknown interaction');
};

/**
 * Ambil pertanyaan dari opsi command, kirim ke Gemini, lalu kirim jawabannya
 * sebagai follow-up message ke Discord.
 */
async function handleCpCommand(interaction) {
  const options = interaction.data.options || [];
  // Nama opsi di sini HARUS sama dengan yang terdaftar di Discord (lihat api/register.js).
  // Kalau command kamu sudah terdaftar duluan dengan nama opsi berbeda
  // (misal "pertanyaan" / "pesan" / "prompt"), sesuaikan baris di bawah ini.
  const question =
    options.find((o) => o.name === 'pertanyaan')?.value ||
    options.find((o) => o.name === 'pesan')?.value ||
    options.find((o) => o.name === 'prompt')?.value ||
    options[0]?.value; // fallback: ambil opsi pertama apa pun namanya

  const followupUrl = `https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${interaction.token}`;
  console.log(`[handleCpCommand] question="${question}"`);

  if (!question) {
    await sendFollowup(followupUrl, { content: '❌ Pertanyaan tidak boleh kosong.' });
    return;
  }

  let answer;
  try {
    answer = await askGemini(question);
    console.log('[handleCpCommand] Gemini berhasil menjawab, panjang jawaban=', answer.length);
  } catch (err) {
    console.error('[handleCpCommand] GAGAL panggil Gemini API:', err.response?.data || err.message);
    await sendFollowup(followupUrl, {
      content: '⚠️ Gagal mendapat jawaban dari AI. Coba lagi nanti. (Cek Vercel Logs untuk detail error)',
    });
    return;
  }

  // Discord membatasi 1 pesan maksimal 2000 karakter — potong kalau perlu.
  const chunks = splitMessage(answer, 1900);
  try {
    // Kirim chunk pertama sebagai followup utama, sisanya sebagai followup tambahan.
    await sendFollowup(followupUrl, { content: chunks[0] });
    for (let i = 1; i < chunks.length; i++) {
      await sendFollowup(followupUrl, { content: chunks[i] });
    }
    console.log('[handleCpCommand] jawaban terkirim ke Discord');
  } catch (err) {
    console.error('[handleCpCommand] GAGAL kirim follow-up ke Discord:', err.response?.data || err.message);
  }
}

/**
 * Panggil Gemini API (generateContent) dan kembalikan teks jawabannya.
 */
async function askGemini(question) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum diset di Environment Variables Vercel.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: question }],
      },
    ],
    systemInstruction: {
      role: 'system',
      parts: [{ text: SYSTEM_PROMPT }],
    },
  };

  const { data } = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) {
    console.error('[askGemini] respons Gemini tidak ada teks, full response:', JSON.stringify(data));
    throw new Error('Gemini tidak mengembalikan jawaban teks.');
  }
  return text.trim();
}

/** Potong teks panjang jadi beberapa chunk supaya tidak melebihi limit Discord. */
function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendFollowup(url, payload) {
  await axios.post(url, payload);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyDiscordRequest(rawBody, signature, timestamp, publicKey) {
  if (!signature || !timestamp || !publicKey) return false;
  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody, 'utf8'),
      Buffer.from(signature, 'hex'),
      Buffer.from(publicKey, 'hex')
    );
  } catch {
    return false;
  }
}
