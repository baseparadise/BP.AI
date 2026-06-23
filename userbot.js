// userbot.js
// Selfbot Discord menggunakan AKUN PRIBADI (User Token) — merespons saat di-tag/mention,
// tanpa perlu slash command. Jalankan dengan: `node userbot.js`.
//
// PENTING: Selfbot menggunakan akun pribadi MELANGGAR ToS Discord.
// Risiko: akun bisa di-terminate/banned permanen. Gunakan dengan risiko tanggung sendiri.
//
// Wajib di-host di tempat always-on (Railway, Fly.io, VPS, Render, dll).
//
// ENV yang dibutuhkan:
//   DISCORD_USER_TOKEN = User token akun pribadi (bukan bot token)
//   GEMINI_API_KEYS    = API key Gemini (sama seperti bot.js)

const http = require('http');
const { Client } = require('discord.js-selfbot-v13');
const { isImageRequest, askGemini, generateImage, formatAnswer, friendlyError } = require('./lib/ai');

// Health server kecil: Railway/Render mendeteksi service sebagai "hidup" lewat PORT.
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Userbot is running');
}).listen(port, () => console.log(`[userbot] Health server di port ${port}`));

const client = new Client({
  checkUpdate: false,
});

client.once('ready', () => {
  console.log(`[userbot] Login sebagai ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  try {
    // Abaikan pesan dari bot lain / dirinya sendiri.
    if (message.author.id === client.user.id) return;
    if (message.author.bot) return;

    const isDM = message.channel.type === 'DM' || message.channel.type === 1;
    const mentioned =
      message.mentions.users.has(client.user.id) ||
      message.content.includes(`<@${client.user.id}>`);

    // Hanya respons kalau di-mention di server, ATAU di DM.
    if (!mentioned && !isDM) return;

    // Bersihkan teks: buang mention user, sisakan pertanyaannya.
    const mentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
    const question = message.content.replace(mentionRegex, '').trim();

    if (!question) {
      await message.reply('Halo! Tag aku lalu tulis pertanyaanmu, atau minta aku buatkan gambar. 👋');
      return;
    }

    // Tampilkan indikator "sedang mengetik" selama proses.
    await message.channel.sendTyping().catch(() => {});

    // Mode gambar.
    if (isImageRequest(question)) {
      const { imageBuffer, text } = await generateImage(question);
      if (imageBuffer) {
        await message.reply({
          content: (text || `Nih hasil gambarnya: "${question}"`).slice(0, 2000),
          files: [{ attachment: imageBuffer, name: 'hasil.png' }],
        });
        return;
      }
      // Kalau gagal, jatuh ke jawaban teks.
    }

    // Mode teks + pencarian + sumber.
    const { text, sources } = await askGemini(question);
    await message.reply({
      content: formatAnswer(text, sources),
    });
  } catch (err) {
    await message.reply(friendlyError(err)).catch(() => {});
  }
});

const token = process.env.DISCORD_USER_TOKEN;
if (!token) {
  console.error('[userbot] DISCORD_USER_TOKEN belum di-set. Set env DISCORD_USER_TOKEN dengan User Token akun pribadi.');
  process.exit(1);
}

client.login(token);
