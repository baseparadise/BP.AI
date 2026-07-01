// start.js
// Entry point Railway: jalankan bot.js, userbot.js, dan web.js sekaligus.
//
// Pembagian port:
//   PORT       → web.js   (di-expose Railway ke internet → web UI bisa diakses)
//   PORT + 1   → bot.js   (health check internal, tidak perlu di-expose)
//   PORT + 2   → userbot.js (internal)

const { spawn } = require('child_process');

// Daftar proses anak untuk graceful shutdown
const _children = [];
let _shuttingDown = false;

function run(script, name, env = {}) {
  const proc = spawn('node', [script], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  _children.push(proc);

  proc.on('close', (code) => {
    if (!_shuttingDown) {
      console.error(`[${name}] proses mati (code ${code}), restart dalam 5 detik...`);
      setTimeout(() => run(script, name, env), 5000);
    }
  });

  proc.on('error', (err) => {
    console.error(`[${name}] gagal spawn:`, err.message);
    if (!_shuttingDown) setTimeout(() => run(script, name, env), 5000);
  });

  console.log(`[start] Menjalankan ${name} (${script})`);
  return proc;
}

// Graceful shutdown: teruskan signal ke semua proses anak
function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[start] Menerima ${signal}, menghentikan semua proses...`);
  _children.forEach(c => { try { c.kill(signal); } catch (_) {} });
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

const basePort = parseInt(process.env.PORT, 10) || 3000;

// web.js pakai PORT utama — Railway expose ini ke internet.
run('web.js',      'web',     { PORT: String(basePort) });

// bot.js pakai PORT+1 untuk health check internal.
run('bot.js',      'bot',     { PORT: String(basePort + 1) });

// userbot.js pakai PORT+2.
run('userbot.js',  'userbot', { PORT: String(basePort + 2) });
