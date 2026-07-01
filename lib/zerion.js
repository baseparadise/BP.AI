// lib/zerion.js — Zerion Wallet Intelligence API
// Docs: https://developers.zerion.io
// Auth: Basic base64(ZERION_API_KEY + ":")
// Rate limit (free): 10 req/s, 10k/day

const https = require('https');

const BASE_URL = 'api.zerion.io';

// ── Auth header ────────────────────────────────────────────────────────────
function authHeader() {
  const key = process.env.ZERION_API_KEY;
  if (!key) throw new Error('ZERION_API_KEY tidak diset di environment!');
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}

// ── Generic GET ────────────────────────────────────────────────────────────
function zerionGet(path, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = Object.keys(params).length
      ? '?' + Object.entries(params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&')
      : '';
    const fullPath = '/v1' + path + qs;
    const opts = {
      hostname: BASE_URL,
      path: fullPath,
      method: 'GET',
      headers: {
        Authorization: authHeader(),
        Accept: 'application/json',
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode === 202) {
          // Data still indexing — return null so caller can handle
          resolve(null);
          return;
        }
        if (res.statusCode === 401) {
          reject(new Error('ZERION_API_KEY tidak valid atau sudah expired.'));
          return;
        }
        if (res.statusCode === 429) {
          reject(new Error('Rate limit Zerion tercapai. Coba lagi sebentar.'));
          return;
        }
        if (res.statusCode >= 400) {
          let msg = 'Zerion API error ' + res.statusCode;
          try { msg = JSON.parse(data)?.errors?.[0]?.detail || msg; } catch (_) {}
          reject(new Error(msg));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Gagal parse response Zerion: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Zerion API timeout')); });
    req.end();
  });
}

// ── Retry wrapper for 202 ──────────────────────────────────────────────────
async function zerionGetRetry(path, params = {}, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const result = await zerionGet(path, params);
    if (result !== null) return result;
    if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

// ── Formatters ─────────────────────────────────────────────────────────────
function fmtUSD(n) {
  if (n == null || isNaN(n)) return '$—';
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n < 0 ? '-' : '') + '$' + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n < 0 ? '-' : '') + '$' + abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return (n < 0 ? '-$' : '$') + abs.toFixed(2);
}

function fmtNum(n, decimals = 4) {
  if (n == null || isNaN(n)) return '—';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return parseFloat(n.toFixed(decimals)).toString();
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—%';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || '—';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

// ── Detect `balance 0xABCD` pattern ───────────────────────────────────────
function detectBalanceQuery(text) {
  const m = (text || '').trim().match(/^balance\s+(0x[a-fA-F0-9]{40})\s*$/i);
  return m ? m[1] : null;
}

// ── Chain display name map ─────────────────────────────────────────────────
const CHAIN_NAMES = {
  ethereum: 'Ethereum',
  base: 'Base',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  polygon: 'Polygon',
  'zksync-era': 'zkSync Era',
  linea: 'Linea',
  scroll: 'Scroll',
  blast: 'Blast',
  zora: 'Zora',
  avalanche: 'Avalanche',
  bnb: 'BNB',
  gnosis: 'Gnosis',
  solana: 'Solana',
  berachain: 'Berachain',
  degen: 'Degen',
  abstract: 'Abstract',
};
function chainName(id) { return CHAIN_NAMES[id] || id; }

// ── Main: fetch all wallet data and format as Discord message ──────────────
async function fetchZerionPortfolio(address) {
  const addr = address.toLowerCase();

  // Fetch in parallel: portfolio + positions + pnl
  const [portfolioRes, positionsRes, pnlRes] = await Promise.allSettled([
    zerionGetRetry('/wallets/' + addr + '/portfolio', { currency: 'usd' }),
    zerionGetRetry('/wallets/' + addr + '/positions', {
      'filter[positions]': 'no_filter',
      'filter[trash]': 'only_non_trash',
      'sort': '-value',
      'page[size]': '30',
    }),
    zerionGetRetry('/wallets/' + addr + '/pnl', { currency: 'usd' }),
  ]);

  const portfolio = portfolioRes.status === 'fulfilled' ? portfolioRes.value?.data?.attributes : null;
  const positions = positionsRes.status === 'fulfilled'
    ? (positionsRes.value?.data || []).slice(0, 20)
    : [];
  const pnl = pnlRes.status === 'fulfilled' ? pnlRes.value?.data?.attributes : null;

  if (!portfolio && positions.length === 0) {
    return '⚠️ Wallet ini belum terindeks oleh Zerion, atau tidak ada aktivitas on-chain.';
  }

  const lines = [];

  // ── Header ────────────────────────────────────────────────────────────────
  const total = portfolio?.total?.positions ?? 0;
  const change1d = portfolio?.changes?.absolute_1d ?? null;
  const pct1d = portfolio?.changes?.percent_1d ?? null;
  const changeStr = change1d != null
    ? ' (' + (change1d >= 0 ? '+' : '') + fmtUSD(change1d) + ' / ' + fmtPct(pct1d) + ' 24h)'
    : '';

  lines.push('💼 **Wallet: `' + shortAddr(address) + '`**');
  lines.push('`' + address + '`');
  lines.push('');
  lines.push('💰 **Total: ' + fmtUSD(total) + '**' + changeStr);

  // ── Distribution by type ───────────────────────────────────────────────────
  const dist = portfolio?.positions_distribution_by_type;
  if (dist) {
    const parts = [];
    if (dist.wallet)    parts.push('Wallet: ' + fmtUSD(dist.wallet));
    if (dist.deposited) parts.push('DeFi deposit: ' + fmtUSD(dist.deposited));
    if (dist.staked)    parts.push('Staked: ' + fmtUSD(dist.staked));
    if (dist.borrowed)  parts.push('Borrowed: ' + fmtUSD(dist.borrowed));
    if (parts.length)   lines.push('📂 ' + parts.join(' · '));
  }

  // ── By chain ───────────────────────────────────────────────────────────────
  const byChain = portfolio?.positions_distribution_by_chain;
  if (byChain) {
    const sorted = Object.entries(byChain)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    if (sorted.length > 0) {
      lines.push('');
      lines.push('🔗 **By Chain:**');
      sorted.forEach(([chain, val]) => {
        const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0.0';
        lines.push('  ' + chainName(chain).padEnd(10) + ' ' + fmtUSD(val).padStart(10) + '  (' + pct + '%)');
      });
    }
  }

  // ── Top token positions ────────────────────────────────────────────────────
  if (positions.length > 0) {
    lines.push('');
    lines.push('🪙 **Top Posisi:**');
    lines.push('```');
    lines.push('Token       Qty           Nilai     Type');
    lines.push('─────────────────────────────────────────');

    const topPositions = positions
      .filter(p => (p.attributes?.value ?? 0) > 0.01)
      .slice(0, 10);

    topPositions.forEach((pos) => {
      const attr = pos.attributes || {};
      const info = attr.fungible_info || {};
      const qty = attr.quantity?.float ?? 0;
      const val = attr.value ?? 0;
      const sym = (info.symbol || '?').slice(0, 8).padEnd(8);
      const qtyStr = fmtNum(qty, 4).padStart(12);
      const valStr = fmtUSD(val).padStart(10);
      const type = (attr.position_type || 'wallet').slice(0, 10);
      lines.push(sym + ' ' + qtyStr + ' ' + valStr + '  ' + type);
    });
    lines.push('```');
  }

  // ── PnL ───────────────────────────────────────────────────────────────────
  if (pnl) {
    const tg = pnl.total_gain;
    const rg = pnl.realized_gain;
    const ug = pnl.unrealized_gain;
    const tgPct = pnl.relative_total_gain_percentage;
    const tf = pnl.total_fee;

    lines.push('');
    lines.push('📈 **PnL (FIFO):**');
    lines.push('```');
    if (tg != null)  lines.push('Total       : ' + (tg >= 0 ? '+' : '') + fmtUSD(tg) + '  (' + fmtPct(tgPct) + ')');
    if (rg != null)  lines.push('Realized    : ' + (rg >= 0 ? '+' : '') + fmtUSD(rg));
    if (ug != null)  lines.push('Unrealized  : ' + (ug >= 0 ? '+' : '') + fmtUSD(ug));
    if (tf != null)  lines.push('Total Fees  : ' + fmtUSD(tf));
    lines.push('```');
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  lines.push('🔗 [Lihat di Zerion](<https://app.zerion.io/' + address + '/overview>)');

  // Discord max 2000 chars — trim if needed
  let msg = lines.join('\n');
  if (msg.length > 1950) {
    msg = msg.slice(0, 1900) + '\n... _(data terpotong, lihat link Zerion)_';
  }
  return msg;
}

module.exports = { detectBalanceQuery, fetchZerionPortfolio };
