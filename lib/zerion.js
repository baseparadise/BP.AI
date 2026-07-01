// lib/zerion.js — Zerion Wallet Intelligence API
// Docs: https://developers.zerion.io
// Auth: Basic base64(ZERION_API_KEY + ":")

const https = require('https');

const BASE_URL = 'api.zerion.io';

// Cache redirect destinations — tiap endpoint hanya redirect 1x seumur proses
const redirectCache = {};

// Cache hasil portfolio per wallet — TTL 5 menit, hemat quota bulanan
const portfolioCache = {};
const CACHE_TTL_MS = 5 * 60 * 1000;

function authHeader() {
  const key = (process.env.ZERION_API_KEY || '').trim();
  if (!key) throw new Error('`ZERION_API_KEY` belum diset di Railway environment variables!');
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}

function zerionGetOnce(path, auth) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: BASE_URL,
      path: path,
      method: 'GET',
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        'User-Agent': 'BP.AI-Bot/1.0',
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', (e) => reject(new Error('Network error: ' + e.message)));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Zerion API timeout (15s)')); });
    req.end();
  });
}

function zerionGet(path, params) {
  return new Promise(async (resolve, reject) => {
    let auth;
    try { auth = authHeader(); } catch (e) { return reject(e); }

    // Jangan encode bracket [] — Zerion pakai filter[trash] bukan filter%5Btrash%5D
    const qs = params && Object.keys(params).length
      ? '?' + Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&')
      : '';

    const originalPath = '/v1' + path + qs;
    let currentPath = redirectCache[originalPath] || originalPath;

    const maxRedirects = 5;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let resp;
      try { resp = await zerionGetOnce(currentPath, auth); }
      catch (e) { return reject(e); }

      const { status, headers, body } = resp;

      // Follow redirect & cache tujuannya agar request berikutnya langsung ke URL final
      if (status >= 300 && status < 400) {
        const location = headers.location;
        if (!location) return reject(new Error('Zerion redirect tanpa Location header'));
        if (hop === maxRedirects) return reject(new Error('Zerion terlalu banyak redirect (>5)'));
        const nextPath = location.startsWith('http')
          ? new URL(location).pathname + (new URL(location).search || '')
          : location;
        redirectCache[originalPath] = nextPath;
        currentPath = nextPath;
        continue;
      }

      if (status === 202) return resolve(null); // masih diproses, perlu polling

      if (status === 401 || status === 403)
        return reject(new Error('ZERION_API_KEY tidak valid. Cek Railway env vars.'));

      if (status === 429) {
        // Tampilkan detail body agar bisa dibedakan: monthly quota vs per-second limit
        let detail = '';
        try {
          const parsed = JSON.parse(body);
          detail = parsed?.errors?.[0]?.detail || parsed?.message || '';
        } catch (_) { detail = body.slice(0, 120); }
        return reject(new Error(
          'Rate limit Zerion (HTTP 429).' +
          (detail ? ' Detail: ' + detail : '') +
          ' Cek sisa quota di: https://zerion.io/developer'
        ));
      }

      if (status === 404)
        return reject(new Error('Wallet tidak ditemukan di Zerion.'));

      if (status >= 400) {
        let msg = 'Zerion API error HTTP ' + status;
        try { msg = JSON.parse(body)?.errors?.[0]?.detail || msg; } catch (_) {}
        return reject(new Error(msg));
      }

      const ct = headers['content-type'] || '';
      if (!ct.includes('application/json') && !ct.includes('application/vnd.api+json')) {
        return reject(new Error(
          'Zerion response bukan JSON (content-type: ' + ct + '). ' +
          'Cek ZERION_API_KEY. Preview: ' + body.slice(0, 80)
        ));
      }

      try { return resolve(JSON.parse(body)); }
      catch (e) { return reject(new Error('Gagal parse response Zerion: ' + e.message)); }
    }
  });
}

// Retry khusus untuk 202 polling (wallet baru yang belum terindeks)
// 429 TIDAK di-retry — langsung lempar error agar quota tidak terbuang
async function zerionGetRetry(path, params, maxRetries) {
  const tries = maxRetries || 2;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const result = await zerionGet(path, params);
      if (result !== null) return result;
      // 202: wallet belum terindeks, tunggu lalu coba lagi
      if (i < tries - 1) await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      // Jangan retry 429 atau auth error — langsung lempar
      if (e.message.includes('429') || e.message.includes('tidak valid')) throw e;
      lastErr = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// ── Formatters ───────────────────────────────────────────────────────────
function fmtUSD(n) {
  if (n == null || isNaN(n)) return '$—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + '$' + abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return (n < 0 ? '-$' : '$') + abs.toFixed(2);
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return parseFloat(n.toFixed(4)).toString();
  return parseFloat(n.toPrecision(4)).toString();
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—%';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || '—';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

const CHAIN_NAMES = {
  ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum',
  optimism: 'Optimism', polygon: 'Polygon', 'zksync-era': 'zkSync Era',
  linea: 'Linea', scroll: 'Scroll', blast: 'Blast', zora: 'Zora',
  avalanche: 'Avalanche', bnb: 'BNB Chain', gnosis: 'Gnosis',
  solana: 'Solana', berachain: 'Berachain', monad: 'Monad',
  hyperevm: 'HyperEVM', '0g': '0G', 'binance-smart-chain': 'BSC',
};
function chainName(id) { return CHAIN_NAMES[id] || id; }

function detectBalanceQuery(text) {
  const m = (text || '').trim().match(/^balance\s+(0x[a-fA-F0-9]{40})\s*$/i);
  return m ? m[1] : null;
}

// ── Fetch & format wallet portfolio ──────────────────────────────────────
async function fetchZerionPortfolio(address) {
  const addr = address.toLowerCase();

  authHeader(); // throws early if key missing

  // Cek cache dulu — hemat quota jika wallet sama dicek dalam 5 menit
  const cached = portfolioCache[addr];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  // Request SEQUENTIAL bukan paralel — hindari burst rate limit
  let portfolio = null, positions = [], nftMeta = null, pnl = null;

  try {
    const r = await zerionGetRetry('/wallets/' + addr + '/portfolio', { currency: 'usd' });
    portfolio = r?.data?.attributes ?? null;
  } catch (e) {
    throw e; // portfolio wajib — lempar error langsung
  }

  try {
    const r = await zerionGetRetry('/wallets/' + addr + '/positions', {
      'filter[trash]': 'only_non_trash',
      'sort': '-value',
      'page[size]': '30',
      'currency': 'usd',
    });
    positions = r?.data ?? [];
  } catch (e) {
    positions = []; // positions opsional — lanjutkan tanpa error
    console.error('[zerion] positions error:', e.message);
  }

  try {
    const r = await zerionGetRetry('/wallets/' + addr + '/nft-positions', { 'page[size]': '1' });
    nftMeta = r?.meta ?? null;
  } catch (_) {}

  try {
    const r = await zerionGetRetry('/wallets/' + addr + '/pnl', { currency: 'usd' });
    pnl = r?.data?.attributes ?? null;
  } catch (_) {}

  if (!portfolio && positions.length === 0) {
    return (
      '⚠️ **Wallet tidak ditemukan atau belum terindeks.**\n' +
      'Kemungkinan penyebab:\n' +
      '• Wallet baru / tidak ada aktivitas on-chain\n' +
      '• Zerion sedang mengindeks (coba lagi 30 detik)\n' +
      '• `ZERION_API_KEY` tidak valid\n\n' +
      '🔗 [Cek manual di Zerion](<https://app.zerion.io/' + address + '/overview>)'
    );
  }

  const lines = [];

  const total    = portfolio?.total?.positions ?? 0;
  const change1d = portfolio?.changes?.absolute_1d ?? null;
  const pct1d    = portfolio?.changes?.percent_1d ?? null;
  const changeStr = change1d != null
    ? ' (' + (change1d >= 0 ? '+' : '') + fmtUSD(change1d) + ' / ' + fmtPct(pct1d) + ' 24h)'
    : '';

  lines.push('💼 **Wallet: `' + shortAddr(address) + '`**');
  lines.push('`' + address + '`');
  lines.push('');
  lines.push('💰 **Total: ' + fmtUSD(total) + '**' + changeStr);

  const dist = portfolio?.positions_distribution_by_type;
  if (dist) {
    const parts = [];
    if (dist.wallet)    parts.push('Wallet: '   + fmtUSD(dist.wallet));
    if (dist.deposited) parts.push('DeFi: '     + fmtUSD(dist.deposited));
    if (dist.staked)    parts.push('Staked: '   + fmtUSD(dist.staked));
    if (dist.borrowed)  parts.push('Debt: '     + fmtUSD(dist.borrowed));
    if (dist.locked)    parts.push('Locked: '   + fmtUSD(dist.locked));
    if (parts.length)   lines.push('📂 ' + parts.join(' · '));
  }

  if (nftMeta?.total != null && nftMeta.total > 0)
    lines.push('🖼️ NFT: ' + nftMeta.total + ' item');

  const byChain = portfolio?.positions_distribution_by_chain;
  if (byChain) {
    const sorted = Object.entries(byChain).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (sorted.length) {
      lines.push('');
      lines.push('🔗 **By Chain:**');
      sorted.forEach(([chain, val]) => {
        const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0.0';
        lines.push('  ' + chainName(chain).padEnd(12) + fmtUSD(val).padStart(10) + '  (' + pct + '%)');
      });
    }
  }

  const topPos = positions
    .filter(p => {
      const v = p.attributes?.value;
      return v != null && v > 0.001;  // hanya token yang ada nilai USD-nya
    })
    .slice(0, 10);  // top 10 saja

  if (topPos.length) {
    lines.push('');
    lines.push('🪙 **Token & Posisi:**');
    lines.push('```');
    lines.push('Symbol     Nilai USD    Chain');
    lines.push('──────────────────────────────────');
    topPos.forEach((pos) => {
      const attr = pos.attributes || {};
      const info = attr.fungible_info || {};
      const chainId = pos.relationships?.chain?.data?.id
        || (info.implementations || [])[0]?.chain_id || '';
      const chain = chainName(chainId).slice(0, 8);
      const val  = attr.value ?? 0;
      const sym  = (info.symbol || '?').slice(0, 8).padEnd(8);
      const valS = fmtUSD(val).padStart(12);
      lines.push(sym + ' ' + valS + '  ' + chain);
    });
    lines.push('```');
  } else {
    lines.push('\n_(tidak ada posisi terdeteksi)_');
  }

  if (pnl) {
    const tg = pnl.total_gain, rg = pnl.realized_gain;
    const ug = pnl.unrealized_gain, tgPct = pnl.relative_total_gain_percentage;
    const tf = pnl.total_fee;
    lines.push('');
    lines.push('📈 **PnL (FIFO):**');
    lines.push('```');
    if (tg != null) lines.push('Total      : ' + (tg >= 0 ? '+' : '') + fmtUSD(tg) + '  (' + fmtPct(tgPct) + ')');
    if (rg != null) lines.push('Realized   : ' + (rg >= 0 ? '+' : '') + fmtUSD(rg));
    if (ug != null) lines.push('Unrealized : ' + (ug >= 0 ? '+' : '') + fmtUSD(ug));
    if (tf != null) lines.push('Fees       : ' + fmtUSD(tf));
    lines.push('```');
  }

  lines.push('');
  lines.push('🔗 [Zerion](<https://app.zerion.io/' + address + '/overview>) · [Debank](<https://debank.com/profile/' + address + '>) · [Etherscan](<https://basescan.org/address/' + address + '>)');

  let msg = lines.join('\n');
  if (msg.length > 1950) msg = msg.slice(0, 1900) + '\n_...(terpotong, lihat link Zerion)_';

  // Simpan ke cache
  portfolioCache[addr] = { ts: Date.now(), result: msg };

  return msg;
}

module.exports = { detectBalanceQuery, fetchZerionPortfolio };
