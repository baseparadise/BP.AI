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
// Model khusus generate gambar (Nano Banana). Override via env GEMINI_IMAGE_MODEL.
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const SYSTEM_PROMPT = [
  'Kamu adalah AI super cerdas dan serba bisa di server Discord, selevel asisten AI umum modern.',
  'Kamu PUNYA akses internet lewat Google Search. JANGAN PERNAH menolak atau bilang kamu tidak punya data real-time.',
  'Kalau pertanyaan butuh info terkini (harga kripto/saham, berita, cuaca, skor, kurs, rilis terbaru, dll),',
  'cari secara AGRESIF lewat Google Search lalu jawab dengan ANGKA/FAKTA konkret terbaru beserta waktunya.',
  'Contoh: kalau ditanya harga BTC, langsung sebutkan angkanya saat ini, jangan menyuruh user cek sendiri.',
  'Jawab dengan jelas, akurat, dan to-the-point dalam Bahasa Indonesia. Boleh detail kalau memang perlu.',
  'Selalu utamakan kebenaran faktual berdasarkan hasil pencarian, bukan tebakan.',
].join(' ');

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

// Deteksi apakah user minta dibuatkan gambar.
function isImageRequest(text) {
  const t = text.toLowerCase();
  return /\b(buat(kan)?|gambar(kan)?|lukis(kan)?|bikin(kan)?|generate|render|design|desain|sketsa|ilustrasi|foto)\b/.test(t)
    && /\b(gambar|foto|ilustrasi|logo|poster|wallpaper|sketsa|image|picture|art|artwork|desain|design)\b/.test(t);
}

async function handleCpCommand(interaction, question) {
  const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${interaction.token}`;
  try {
    // Mode gambar: kalau user minta dibuatkan gambar.
    if (isImageRequest(question)) {
      const { imageBuffer, text } = await generateImage(question);
      if (imageBuffer) {
        await sendImageFollowup(webhookUrl, imageBuffer, text || `Nih hasil gambarnya: "${question}"`);
        return;
      }
      // Kalau gagal hasilkan gambar, jatuh ke jawaban teks biasa.
    }

    const { text, sources } = await askGemini(question);
    await axios.post(webhookUrl, { content: formatAnswer(text, sources) });
  } catch (err) {
    // Tampilkan penyebab asli supaya gampang dilacak (status + pesan dari Google API).
    const status = err.response?.status;
    const apiMsg = err.response?.data?.error?.message || err.message;
    console.error('[handleCpCommand] Gagal:', status, apiMsg);

    let userMsg;
    if (status === 429) {
      userMsg = '⚠️ Rate limit Gemini tercapai. Coba lagi sebentar lagi.';
    } else if (status === 503 || status === 500) {
      userMsg = '⚠️ Server Gemini sedang sibuk/overload. Ini sementara — coba lagi beberapa saat lagi.';
    } else if (status === 404) {
      userMsg = `⚠️ Model "${GEMINI_MODEL}" tidak ditemukan/sudah dipensiunkan. Set env GEMINI_MODEL ke model yang aktif.`;
    } else {
      userMsg = `⚠️ Gagal memproses jawaban AI. (${status || 'error'}: ${apiMsg})`;
    }
    await axios.post(webhookUrl, { content: userMsg });
  }
}

// Status yang layak di-retry: rate limit (429) + error sementara di sisi server Google (500/503).
const RETRYABLE_STATUS = [429, 500, 503];
// Model cadangan kalau model utama overload. Bisa di-override via env GEMINI_FALLBACK_MODEL.
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.0-flash';

// Fungsi tanya AI dengan Google Search grounding + Retry/Backoff.
// Return { text, sources } di mana sources = [{ title, uri }].
async function askGemini(question, retries = 0, model = GEMINI_MODEL) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  try {
    const { data } = await axios.post(url, {
      contents: [{ role: 'user', parts: [{ text: question }] }],
      // System instruction biar AI agresif cari info & tidak menolak data real-time.
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      // Aktifkan Google Search supaya bisa cari info terkini + dapat sumber.
      tools: [{ google_search: {} }],
    }, { timeout: 20000 });

    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text).filter(Boolean).join('') || 'Tidak ada jawaban.';

    // Ambil sumber dari groundingMetadata (hasil pencarian).
    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    const sources = chunks
      .map((c) => c.web)
      .filter(Boolean)
      .map((w) => ({ title: w.title || w.uri, uri: w.uri }));

    return { text, sources };
  } catch (err) {
    const status = err.response?.status;

    // 429/500/503 -> coba lagi dengan jeda yang makin panjang (max 5x).
    if (RETRYABLE_STATUS.includes(status) && retries < 5) {
      const waitTime = (Math.pow(2, retries) * 2000) + (Math.random() * 1000);
      console.log(`[askGemini] ${status} terdeteksi (model=${model}), retry ke-${retries + 1} dalam ${Math.round(waitTime)}ms`);
      await sleep(waitTime);
      return askGemini(question, retries + 1, model);
    }

    // Kalau model utama tetap overload (503/500) setelah habis retry, coba sekali ke model cadangan.
    if ([500, 503].includes(status) && model === GEMINI_MODEL && FALLBACK_MODEL !== GEMINI_MODEL) {
      console.log(`[askGemini] Model utama (${model}) overload, beralih ke fallback ${FALLBACK_MODEL}`);
      return askGemini(question, 0, FALLBACK_MODEL);
    }

    throw err;
  }
}

// Gabungkan teks jawaban + daftar sumber, lalu pangkas ke batas 2000 char Discord.
function formatAnswer(text, sources = []) {
  let out = text || 'Tidak ada jawaban.';

  if (sources.length > 0) {
    // Dedupe by uri, ambil maksimal 5 sumber.
    const seen = new Set();
    const unique = [];
    for (const s of sources) {
      if (s.uri && !seen.has(s.uri)) {
        seen.add(s.uri);
        unique.push(s);
      }
      if (unique.length >= 5) break;
    }
    const list = unique.map((s, i) => `${i + 1}. [${s.title}](${s.uri})`).join('\n');
    const footer = `\n\n📚 **Sumber:**\n${list}`;

    // Pastikan total <= 2000 char; kalau kepanjangan, pangkas teks dulu.
    const maxBody = 2000 - footer.length;
    if (out.length > maxBody) out = out.slice(0, maxBody - 1) + '…';
    out += footer;
  } else if (out.length > 2000) {
    out = out.slice(0, 1999) + '…';
  }

  return out;
}

// Generate gambar pakai model image (Nano Banana). Return { imageBuffer, text }.
async function generateImage(prompt, retries = 0) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  try {
    const { data } = await axios.post(url, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }, { timeout: 30000 });

    const parts = data?.candidates?.[0]?.content?.parts || [];
    let imageBuffer = null;
    let text = '';
    for (const p of parts) {
      if (p.inlineData?.data) {
        imageBuffer = Buffer.from(p.inlineData.data, 'base64');
      } else if (p.text) {
        text += p.text;
      }
    }
    return { imageBuffer, text };
  } catch (err) {
    const status = err.response?.status;
    if (RETRYABLE_STATUS.includes(status) && retries < 3) {
      const waitTime = (Math.pow(2, retries) * 2000) + (Math.random() * 1000);
      console.log(`[generateImage] ${status} terdeteksi, retry ke-${retries + 1} dalam ${Math.round(waitTime)}ms`);
      await sleep(waitTime);
      return generateImage(prompt, retries + 1);
    }
    throw err;
  }
}

// Kirim followup ke Discord dengan lampiran gambar (multipart/form-data).
async function sendImageFollowup(webhookUrl, imageBuffer, content) {
  const form = new FormData();
  const safeContent = (content || '').slice(0, 2000);
  form.append('payload_json', JSON.stringify({
    content: safeContent,
    attachments: [{ id: 0, filename: 'hasil.png' }],
  }));
  form.append('files[0]', new Blob([imageBuffer], { type: 'image/png' }), 'hasil.png');
  await axios.post(webhookUrl, form);
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
