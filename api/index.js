// api/index.js
// Vercel Serverless Function — handle Discord Interactions webhook (slash command /cp).
// Otak AI ada di lib/ai.js (dipakai bersama dengan bot.js gateway).
//
// CATATAN: Webhook ini HANYA bisa merespons slash command. Untuk merespons mention/chat
// biasa (tag bot lalu tanya), gunakan bot.js yang di-host always-on (lihat README).

const nacl = require('tweetnacl');
const axios = require('axios');
const { InteractionType, InteractionResponseType } = require('discord-interactions');
const { waitUntil } = require('@vercel/functions');
const { isImageRequest, askGemini, generateImage, formatAnswer, friendlyError } = require('../lib/ai');

const PUBLIC_KEY = process.env.PUBLIC_KEY;

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
    const userQuestion = interaction.data.options?.[0]?.value || 'Halo';

    // Segera kirim ACK agar tidak timeout.
    res.status(200).json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });

    // Jalankan di background dengan waitUntil agar tidak terbunuh Vercel.
    waitUntil(
      handleCpCommand(interaction, userQuestion)
        .catch((err) => console.error('[index] Error background:', err))
    );

    return;
  }

  res.status(404).end('Unknown interaction');
};

// --- Handler ---

async function handleCpCommand(interaction, question) {
  const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${interaction.token}`;
  try {
    if (isImageRequest(question)) {
      const { imageBuffer, text } = await generateImage(question);
      if (imageBuffer) {
        await sendImageFollowup(webhookUrl, imageBuffer, text || `Nih hasil gambarnya: "${question}"`);
        return;
      }
    }

    const { text, sources } = await askGemini(question);
    await axios.post(webhookUrl, { content: formatAnswer(text, sources) });
  } catch (err) {
    await axios.post(webhookUrl, { content: friendlyError(err) });
  }
}

// Kirim followup dengan lampiran gambar (multipart/form-data).
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

// --- Util keamanan Discord ---

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
