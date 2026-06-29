// start.js
// Entry point Railway: jalankan bot.js, userbot.js, dan web.js sekaligus.
//
// Pembagian port:
//   PORT       → web.js   (di-expose Railway ke internet → web UI bisa diakses)
//   PORT + 1   → bot.js   (health check internal, tidak perlu di-expose)
//   PORT + 2   → userbot.js (internal)

// [FIX] Auto-install ethers jika belum ada (terjadi saat Railway pakai build cache lama)
const { execSync } = require('child_process');
try {
  require.resolve('ethers');
} catch (_) {
  console.log('[start] ethers belum terinstall, installing...');
  try {
    execSync('npm install ethers --no-save --quiet', { stdio: 'inherit' });
    console.log('[start] ✅ ethers berhasil diinstall');
  } catch (e) {
    console.warn('[start] ⚠️  Gagal install ethers:', e.message, '— fitur !shuffle tidak akan berfungsi');
  }
}

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

// web.js pakai PORT utama — Railway expose ini ke internet.
// Health check Railway otomatis terpenuhi via GET /health di web.js.
run('web.js', 'web', { PORT: String(basePort) });

// bot.js pakai PORT+1 untuk health check internal-nya sendiri.
// Port ini tidak perlu di-expose ke internet.
run('bot.js', 'bot', { PORT: String(basePort + 1) });

// userbot.js pakai PORT+2.
run('userbot.js', 'userbot', { PORT: String(basePort + 2) });
