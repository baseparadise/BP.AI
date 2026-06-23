// start.js
// Entry point Railway: jalankan bot.js dan userbot.js sekaligus.

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
}

// bot.js pakai PORT (health check Railway).
run('bot.js', 'bot');

// userbot.js pakai port internal berbeda agar tidak bentrok.
const userbotPort = String((parseInt(process.env.PORT, 10) || 3000) + 1);
run('userbot.js', 'userbot', { PORT: userbotPort });
