// api/register.js
// Buka di browser setelah deploy untuk daftarkan/update command /cp:
//   https://<project>.vercel.app/api/register
//
// CATATAN: kamu bilang command /cp dengan opsi pesan/pertanyaan sudah ada duluan.
// Endpoint ini AMAN dipanggil ulang — Discord akan menimpa (overwrite) definisi
// command yang sama, bukan membuat duplikat. Kalau nama opsi yang sudah kamu daftarkan
// BUKAN "pertanyaan", edit nama di bawah ini supaya cocok dengan yang di Discord,
// ATAU langsung jalankan endpoint ini untuk menyamakan semuanya ke definisi ini.

const axios = require('axios');

module.exports = async (req, res) => {
  const { APP_ID, DISCORD_TOKEN } = process.env;

  if (!APP_ID || !DISCORD_TOKEN) {
    return res.status(500).json({
      error: 'APP_ID atau DISCORD_TOKEN belum diset di Environment Variables Vercel.',
    });
  }

  const commands = [
    {
      name: 'cp',
      description: 'Tanya apa saja ke AI (Gemini)',
      options: [
        {
          name: 'pertanyaan',
          description: 'Pertanyaan atau pesan yang ingin kamu tanyakan ke AI',
          type: 3, // STRING
          required: true,
        },
      ],
    },
  ];

  try {
    const response = await axios.put(
      `https://discord.com/api/v10/applications/${APP_ID}/commands`,
      commands,
      { headers: { Authorization: `Bot ${DISCORD_TOKEN}` } }
    );

    return res.status(200).json({
      success: true,
      message: '✅ Command /cp berhasil didaftarkan/diupdate. Tunggu 1-2 menit lalu cek di Discord.',
      registered: response.data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: '❌ Gagal mendaftarkan command.',
      error: err.response?.data || err.message,
    });
  }
};
