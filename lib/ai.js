// lib/ai.js
// Otak AI dipakai bersama oleh webhook (api/index.js) dan bot gateway (bot.js).
// Berisi: tanya Gemini + Google Search grounding, generate gambar, format jawaban.

const axios = require('axios');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.0-flash';
const RETRYABLE_STATUS = [429, 500, 503];

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

// Tanya AI dengan Google Search grounding + Retry/Backoff.
// Return { text, sources } di mana sources = [{ title, uri }].
async function askGemini(question, retries = 0, model = GEMINI_MODEL) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  try {
    const { data } = await axios.post(url, {
      contents: [{ role: 'user', parts: [{ text: question }] }],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      tools: [{ google_search: {} }],
    }, { timeout: 20000 });

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

    if (RETRYABLE_STATUS.includes(status) && retries < 5) {
      const waitTime = (Math.pow(2, retries) * 2000) + (Math.random() * 1000);
      console.log(`[askGemini] ${status} terdeteksi (model=${model}), retry ke-${retries + 1} dalam ${Math.round(waitTime)}ms`);
      await sleep(waitTime);
      return askGemini(question, retries + 1, model);
    }

    if ([500, 503].includes(status) && model === GEMINI_MODEL && FALLBACK_MODEL !== GEMINI_MODEL) {
      console.log(`[askGemini] Model utama (${model}) overload, beralih ke fallback ${FALLBACK_MODEL}`);
      return askGemini(question, 0, FALLBACK_MODEL);
    }

    throw err;
  }
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
    const list = unique.map((s, i) => `${i + 1}. [${s.title}](${s.uri})`).join('\n');
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
  isImageRequest,
  askGemini,
  generateImage,
  formatAnswer,
  friendlyError,
};
