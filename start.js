// start.js
// Entry point Railway: jalankan bot.js, userbot.js, dan web.js sekaligus.
// Masing-masing proses di-restart otomatis kalau mati.

const { spawn } = require('child_process');

function run(script, name, env = {}) {
  const proc = spawn('node', [script], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });

  proc.on('close', (code) => {
    console.error(`[${name}] proses mati (code ${code}), restart dalam 5 detik...`);
    setTimeout(() => run(script, name, env), 5000);
  });

  proc.on('error', (err) => {
    console.error(`[${name}] gagal spawn:`, err.message);
    setTimeout(() => run(script, name, env), 5000);
  });

  console.log(`[start] Menjalankan ${name} (${script})`);
}

const basePort = parseInt(process.env.PORT, 10) || 3000;

// Bot Discord gateway — pakai PORT utama untuk health check Railway.
run('bot.js', 'bot', { PORT: String(basePort) });

// Userbot — pakai port +1 agar tidak bentrok.
run('userbot.js', 'userbot', { PORT: String(basePort + 1) });

// Web UI coding assistant — pakai port +2.
// Akses via browser: https://<domain-railway>/  (kalau Railway expose port ini)
// Atau set env WEB_PORT untuk override.
run('web.js', 'web', { WEB_PORT: String(process.env.WEB_PORT || basePort + 2) });
