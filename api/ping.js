// api/ping.js
// Endpoint debug, BUKAN untuk Discord. Buka langsung di browser:
//   https://<project>.vercel.app/api/ping
// Mengecek: env vars terbaca, dan Gemini API benar-benar bisa dipanggil & menjawab —
// SEBELUM diuji lewat Discord. Kalau ada masalah, ini akan menunjukkan persis di mana.

const axios = require('axios');

module.exports = async (req, res) => {
  const report = {
    env: {
      APP_ID: !!process.env.APP_ID,
      PUBLIC_KEY: !!process.env.PUBLIC_KEY,
      DISCORD_TOKEN: !!process.env.DISCORD_TOKEN,
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    },
    gemini: null,
  };

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY tidak diset.');

    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const { data } = await axios.post(
      url,
      { contents: [{ role: 'user', parts: [{ text: 'Balas dengan satu kata: "halo"' }] }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || null;
    report.gemini = { ok: !!text, sampleAnswer: text, model };
  } catch (err) {
    report.gemini = {
      ok: false,
      error: err.response?.data || err.message,
    };
  }

  return res.status(200).json(report);
};
