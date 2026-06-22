// bot.js
// Bot Discord ALWAYS-ON (Gateway/WebSocket) — merespons saat di-tag/mention,
// tanpa perlu slash command. Jalankan dengan: `node bot.js`.
//
// PENTING: Bot ini HARUS di-host di tempat always-on (Railway, Fly.io, VPS, Render, dll),
// BUKAN di Vercel Serverless — karena koneksi Gateway perlu proses hidup terus.
//
// Wajib aktifkan "MESSAGE CONTENT INTENT" di Discord Developer Portal:
//   Applications -> (bot kamu) -> Bot -> Privileged Gateway Intents -> Message Content Intent.

const http = require('http');
const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const { isImageRequest, askGemini, generateImage, formatAnswer, friendlyError } = require('./lib/ai');

// Health server kecil: Railway/Render mendeteksi service sebagai "hidup" lewat PORT.
// Bot Gateway sebenarnya tidak butuh HTTP, tapi ini mencegah platform menandai crash.
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running');
}).listen(port, () => console.log(`[bot] Health server di port ${port}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // supaya DM juga kebaca
});

client.once('clientReady', () => {
  console.log(`[bot] Login sebagai ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  try {
    // Abaikan pesan dari bot lain / dirinya sendiri.
    if (message.author.bot) return;

    const isDM = !message.guild;
    const mentioned = message.mentions.users.has(client.user.id);

    // Hanya respons kalau di-mention di server, ATAU di DM.
    if (!mentioned && !isDM) return;

    // Bersihkan teks: buang mention bot, sisakan pertanyaannya.
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
        const file = new AttachmentBuilder(imageBuffer, { name: 'hasil.png' });
        await message.reply({
          content: (text || `Nih hasil gambarnya: "${question}"`).slice(0, 2000),
          files: [file],
        });
        return;
      }
      // Kalau gagal, jatuh ke jawaban teks.
    }

    // Mode teks + pencarian + sumber.
    const { text, sources } = await askGemini(question);
    await message.reply(formatAnswer(text, sources));
  } catch (err) {
    await message.reply(friendlyError(err)).catch(() => {});
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('[bot] DISCORD_TOKEN belum di-set. Set env DISCORD_TOKEN dengan Bot Token dari Developer Portal.');
  process.exit(1);
}

client.login(token);
