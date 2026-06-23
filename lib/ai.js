// lib/ai.js
// Otak AI dipakai bersama oleh webhook (api/index.js) dan bot gateway (bot.js).
// Berisi: tanya Gemini + Google Search grounding, generate gambar, format jawaban.

const axios = require('axios');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.0-flash';
const RETRYABLE_STATUS = [429, 500, 503];

// Banyak API key supaya tidak gampang kena limit.
// Isi GEMINI_API_KEYS dengan beberapa key dipisah koma, contoh: "key1,key2,key3".
// GEMINI_API_KEY (tunggal) tetap didukung sebagai cadangan.
const API_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

// Mulai dari key acak biar beban tersebar antar key.
let keyCursor = API_KEYS.length ? Math.floor(Math.random() * API_KEYS.length) : 0;

// Panggil Gemini dengan rotasi key: kalau satu key kena 429, langsung coba key berikutnya.
// Kalau SEMUA key kena 429/500/503, baru lakukan backoff lalu ulangi (max `rounds` putaran).
async function callGemini(model, body, timeout, rounds = 4) {
  if (API_KEYS.length === 0) {
    const e = new Error('GEMINI_API_KEYS / GEMINI_API_KEY belum di-set.');
    e.response = { status: 401, data: { error: { message: 'API key kosong.' } } };
    throw e;
  }

  let lastErr;
  for (let round = 0; round < rounds; round++) {
    // Coba setiap key satu putaran penuh.
    for (let i = 0; i < API_KEYS.length; i++) {
      const key = API_KEYS[keyCursor % API_KEYS.length];
      keyCursor++;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      try {
        const { data } = await axios.post(url, body, { timeout });
        return data;
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        if (status === 429) {
          console.log(`[callGemini] key #${(keyCursor - 1) % API_KEYS.length} kena 429, coba key lain...`);
          continue; // langsung key berikutnya
        }
        if ([500, 503].includes(status)) {
          continue; // server sibuk, coba key/putaran lain
        }
        throw err; // error lain (404/400/401) tidak usah dirotasi
      }
    }
    // Semua key habis di putaran ini -> backoff sebelum putaran berikutnya.
    const waitTime = (Math.pow(2, round) * 2000) + (Math.random() * 1000);
    console.log(`[callGemini] semua key sibuk, backoff ${Math.round(waitTime)}ms (putaran ${round + 1}/${rounds})`);
    await sleep(waitTime);
  }
  throw lastErr;
}

const SYSTEM_PROMPT = [
  'Kamu adalah AI super cerdas dan serba bisa di server Discord, selevel asisten AI umum modern.',
  'Kamu PUNYA akses internet lewat Google Search. JANGAN PERNAH menolak atau bilang kamu tidak punya data real-time.',
  'Kalau pertanyaan butuh info terkini (harga kripto/saham, berita, cuaca, skor, kurs, rilis terbaru, dll),',
  'cari secara AGRESIF lewat Google Search lalu jawab dengan ANGKA/FAKTA konkret terbaru beserta waktunya.',
  'Contoh: kalau ditanya harga BTC, langsung sebutkan angkanya saat ini, jangan menyuruh user cek sendiri.',
  'Jawab dengan jelas, akurat, dan to-the-point dalam Bahasa Indonesia. Boleh detail kalau memang perlu.',
  'Selalu utamakan kebenaran faktual berdasarkan hasil pencarian, bukan tebakan.',
].join(' ');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deteksi apakah user minta dibuatkan gambar.
function isImageRequest(text) {
  const t = (text || '').toLowerCase();
  return /\b(buat(kan)?|gambar(kan)?|lukis(kan)?|bikin(kan)?|generate|render|design|desain|sketsa|ilustrasi|foto)\b/.test(t)
    && /\b(gambar|foto|ilustrasi|logo|poster|wallpaper|sketsa|image|picture|art|artwork|desain|design)\b/.test(t);
}

// Tanya AI dengan Google Search grounding (rotasi key di callGemini).
// Return { text, sources } di mana sources = [{ title, uri }].
async function askGemini(question, model = GEMINI_MODEL) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: question }] }],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    tools: [{ google_search: {} }],
  };

  try {
    const data = await callGemini(model, body, 20000);

    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text).filter(Boolean).join('') || 'Tidak ada jawaban.';

    const chunks = candidate?.groundingMetadata?.groundingChunks || [];
    const sources = chunks
      .map((c) => c.web)
      .filter(Boolean)
      .map((w) => ({ title: w.title || w.uri, uri: w.uri }));

    return { text, sources };
  } catch (err) {
    const status = err.response?.status;
    // Kalau model utama overload, coba sekali ke model cadangan.
    if ([500, 503].includes(status) && model === GEMINI_MODEL && FALLBACK_MODEL !== GEMINI_MODEL) {
      console.log(`[askGemini] Model utama (${model}) overload, beralih ke fallback ${FALLBACK_MODEL}`);
      return askGemini(question, FALLBACK_MODEL);
    }
    throw err;
  }
}

// Generate gambar pakai model image (Nano Banana). Return { imageBuffer, text }.
// Rotasi key ditangani callGemini.
async function generateImage(prompt) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };

  const data = await callGemini(GEMINI_IMAGE_MODEL, body, 30000);

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
}

// Gabungkan teks jawaban + daftar sumber, pangkas ke batas 2000 char Discord.
function formatAnswer(text, sources = []) {
  let out = text || 'Tidak ada jawaban.';

  if (sources.length > 0) {
    const seen = new Set();
    const unique = [];
    for (const s of sources) {
      if (s.uri && !seen.has(s.uri)) {
        seen.add(s.uri);
        unique.push(s);
      }
      if (unique.length >= 5) break;
    }
    // Bungkus URL dengan <...> supaya Discord TIDAK menampilkan preview/embed besar.
    const list = unique.map((s, i) => `${i + 1}. [${s.title}](<${s.uri}>)`).join('\n');
    const footer = `\n\n📚 **Sumber:**\n${list}`;

    const maxBody = 2000 - footer.length;
    if (out.length > maxBody) out = out.slice(0, maxBody - 1) + '…';
    out += footer;
  } else if (out.length > 2000) {
    out = out.slice(0, 1999) + '…';
  }

  return out;
}

// Ubah error jadi pesan ramah Bahasa Indonesia.
function friendlyError(err) {
  const status = err.response?.status;
  const apiMsg = err.response?.data?.error?.message || err.message;
  console.error('[ai] Gagal:', status, apiMsg);

  if (status === 429) return '⚠️ Rate limit Gemini tercapai. Coba lagi sebentar lagi.';
  if (status === 503 || status === 500) return '⚠️ Server Gemini sedang sibuk/overload. Ini sementara — coba lagi beberapa saat lagi.';
  if (status === 404) return `⚠️ Model "${GEMINI_MODEL}" tidak ditemukan/sudah dipensiunkan. Set env GEMINI_MODEL ke model yang aktif.`;
  return `⚠️ Gagal memproses jawaban AI. (${status || 'error'}: ${apiMsg})`;
}

module.exports = {
  SYSTEM_PROMPT,
  GEMINI_MODEL,
  callGemini,
  isImageRequest,
  askGemini,
  generateImage,
  formatAnswer,
  friendlyError,
};
