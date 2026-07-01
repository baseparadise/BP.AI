// lib/gmgn.js
// GMGN.ai API integration — detectGmgnQuery + handleGmgnCommand
// Dipakai oleh bot.js untuk menangani semua perintah "gmgn ..."

const axios = require('axios');

const GMGN_BASE = 'https://gmgn.ai/defi/quotation/v1';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://gmgn.ai/',
  'Origin': 'https://gmgn.ai',
};

const VALID_CHAINS = ['sol', 'eth', 'bsc', 'base', 'arbitrum', 'blast', 'tron'];
const CHAIN_ALIAS = {
  solana: 'sol', ethereum: 'eth', bnb: 'bsc', bnbchain: 'bsc', binance: 'bsc',
  arb: 'arbitrum', arbi: 'arbitrum', trx: 'tron',
};

function isSolanaAddr(s) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}
function isEvmAddr(s) {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}
function isAddr(s) {
  return isSolanaAddr(s) || isEvmAddr(s);
}
function guessChain(addr) {
  return isEvmAddr(addr) ? 'eth' : 'sol';
}
function resolveChain(raw) {
  const lower = (raw || '').toLowerCase();
  return CHAIN_ALIAS[lower] || (VALID_CHAINS.includes(lower) ? lower : null);
}

// ============================================================
// DETECT GMGN QUERY
// ============================================================
function detectGmgnQuery(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!/^gmgn\b/i.test(t)) return null;

  const parts = t.split(/\s+/);
  const sub  = (parts[1] || '').toLowerCase();
  const arg1 =  parts[2] || '';

  // gmgn <CA>
  if (parts.length >= 2 && isAddr(sub)) {
    return { type: 'token', chain: guessChain(sub), address: sub };
  }

  // gmgn smart [CA|chain]
  if (sub === 'smart') {
    if (arg1 && isAddr(arg1)) {
      return { type: 'smart', chain: guessChain(arg1), address: arg1 };
    }
    return { type: 'smart', chain: resolveChain(arg1) || 'sol', address: null };
  }

  // gmgn new [chain]
  if (sub === 'new' || sub === 'baru') {
    return { type: 'new', chain: resolveChain(arg1) || 'sol' };
  }

  // gmgn trending [chain]
  if (sub === 'trending' || sub === 'trend') {
    return { type: 'trending', chain: resolveChain(arg1) || 'sol' };
  }

  // gmgn wallet <address>
  if (sub === 'wallet' || sub === 'dompet') {
    if (!arg1 || !isAddr(arg1)) return null;
    return { type: 'wallet', chain: guessChain(arg1), address: arg1 };
  }

  // gmgn holder <CA>
  if (sub === 'holder' || sub === 'holders') {
    if (!arg1 || !isAddr(arg1)) return null;
    return { type: 'holder', chain: guessChain(arg1), address: arg1 };
  }

  return null;
}

// ============================================================
// UTILS FORMAT
// ============================================================
function fmt(n, d) {
  d = (d === undefined) ? 2 : d;
  if (n === undefined || n === null) return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num)) return 'N/A';
  if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(d) + 'B';
  if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(d) + 'M';
  if (Math.abs(num) >= 1e3) return (num / 1e3).toFixed(d) + 'K';
  return num.toFixed(d);
}

function fmtPrice(n) {
  if (n === undefined || n === null) return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num)) return 'N/A';
  if (num === 0) return '$0';
  if (num < 0.000001) return '$' + num.toExponential(4);
  if (num < 0.01) return '$' + num.toFixed(8);
  if (num < 1) return '$' + num.toFixed(6);
  return '$' + num.toFixed(4);
}

function fmtPct(n) {
  if (n === undefined || n === null) return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num)) return 'N/A';
  return (num >= 0 ? '+' : '') + num.toFixed(2) + '%';
}

function bool(v) {
  if (v === true  || v === 1 || v === '1' || v === 'true')  return '✅ Ya';
  if (v === false || v === 0 || v === '0' || v === 'false') return '❌ Tidak';
  return '❓ N/A';
}

function shortAddr(addr, head, tail) {
  head = head || 6; tail = tail || 4;
  if (!addr) return 'N/A';
  if (addr.length <= head + tail) return addr;
  return addr.slice(0, head) + '...' + addr.slice(-tail);
}

// ============================================================
// API HELPER
// ============================================================
async function gmgnGet(path, params) {
  params = params || {};
  const resp = await axios.get(GMGN_BASE + path, { headers: HEADERS, params, timeout: 15000 });
  return resp.data;
}

// ============================================================
// HANDLER: TOKEN INFO + SECURITY
// ============================================================
async function handleTokenInfo(chain, ca) {
  const [tokenRes, secRes] = await Promise.allSettled([
    gmgnGet('/tokens/' + chain + '/' + ca),
    gmgnGet('/tokens/security/' + chain + '/' + ca),
  ]);

  const td = tokenRes.status === 'fulfilled' ? (tokenRes.value || {}) : {};
  const sd = secRes.status   === 'fulfilled' ? (secRes.value   || {}) : {};
  const t  = td.data?.token || td.token || td.data || {};
  const s  = sd.data || sd;

  if (!Object.keys(t).length && !Object.keys(s).length) {
    throw new Error('Data token tidak ditemukan. Pastikan CA dan chain sudah benar.');
  }

  const name   = t.name   || s.name   || 'Unknown';
  const symbol = t.symbol || s.symbol || '?';
  const price  = fmtPrice(t.price || t.price_usd);
  const mc     = t.market_cap ? '$' + fmt(t.market_cap) : 'N/A';
  const vol    = t.volume_24h ? '$' + fmt(t.volume_24h) : 'N/A';
  const change = fmtPct(t.price_change_24h || t.price_change_percent);
  const liq    = t.liquidity  ? '$' + fmt(t.liquidity)  : 'N/A';

  const lines = [
    '🪙 **' + name + ' (' + symbol + ')**',
    '📊 Chain: ' + chain.toUpperCase() + ' | CA: `' + shortAddr(ca) + '`',
    '',
    '**📈 Harga & Market**',
    '• Harga: '       + price,
    '• Market Cap: '  + mc,
    '• Likuiditas: '  + liq,
    '• Volume 24h: '  + vol,
    '• Perubahan 24h: ' + change,
    '',
  ];

  const secFields = [
    ['Mint Renounced',   s.renounced_mint         ?? s.is_mint_disabled],
    ['Freeze Renounced', s.renounced_freeze_account ?? s.is_freeze_disabled],
    ['Honeypot',         s.is_honeypot             ?? s.honeypot],
    ['Buy Tax',          s.buy_tax  != null ? s.buy_tax  + '%' : null],
    ['Sell Tax',         s.sell_tax != null ? s.sell_tax + '%' : null],
    ['LP Burned',        s.lp_burned ?? s.lpBurned],
    ['Top 10 Holder',    s.top10HolderPercent != null ? s.top10HolderPercent + '%' : null],
  ].filter(([, v]) => v !== null && v !== undefined);

  if (secFields.length) {
    lines.push('**🔒 Security**');
    for (const [label, val] of secFields) {
      const display = (typeof val === 'boolean' || val === 0 || val === 1) ? bool(val) : String(val);
      lines.push('• ' + label + ': ' + display);
    }
    lines.push('');
  }

  if (t.smart_wallets != null || t.smart_money_count != null) {
    lines.push('**💡 Smart Money**');
    lines.push('• Smart Wallets: ' + (t.smart_wallets ?? t.smart_money_count ?? 0));
    if (t.renowned_count != null) lines.push('• Renowned: '      + t.renowned_count);
    if (t.fresh_wallets  != null) lines.push('• Fresh Wallets: ' + t.fresh_wallets);
    lines.push('');
  }

  lines.push('🔗 [GMGN](<https://gmgn.ai/' + chain + '/token/' + ca + '>)');
  return lines.join('\n');
}

// ============================================================
// HANDLER: SMART MONEY
// ============================================================
async function handleSmartMoney(chain, ca) {
  if (ca) {
    const data = await gmgnGet('/tokens/smart_money/' + chain + '/' + ca, { limit: 10 });
    const list = data?.data?.holders || data?.data?.wallets || data?.holders || data?.wallets || data?.data || [];
    const header = '💡 **Smart Money — Token `' + shortAddr(ca) + '`**\n';
    if (!list.length) return header + '_Tidak ada smart money ditemukan._';
    return header + list.slice(0, 10).map((w, i) => {
      const addr = w.address || w.wallet || '';
      const pnl  = w.realized_profit != null ? ' | PnL: $' + fmt(w.realized_profit) : '';
      const bag  = w.amount_cur      != null ? ' | Bag: '  + fmt(w.amount_cur)      : '';
      return (i + 1) + '. `' + shortAddr(addr) + '`' + pnl + bag;
    }).join('\n');
  }

  const data = await gmgnGet('/rank/' + chain + '/smartmoney_swaps/24h', {
    limit: 10, orderby: 'profit', direction: 'desc',
  });
  const list = data?.data?.rank || data?.rank || data?.data || [];
  const header = '💡 **Top Smart Money — ' + chain.toUpperCase() + ' (24h)**\n';
  if (!list.length) return header + '_Data tidak tersedia._';
  return header + list.slice(0, 10).map((w, i) => {
    const addr = w.address || w.wallet || '';
    const pnl  = w.realized_profit != null ? ' — PnL: $' + fmt(w.realized_profit) : '';
    const wr   = w.win_rate        != null ? ' | WR: '   + (parseFloat(w.win_rate) * 100).toFixed(0) + '%' : '';
    return (i + 1) + '. `' + shortAddr(addr) + '`' + pnl + wr;
  }).join('\n');
}

// ============================================================
// HANDLER: NEW TOKENS
// ============================================================
async function handleNewTokens(chain) {
  const data = await gmgnGet('/rank/' + chain + '/new_pairs/1h', {
    limit: 10, orderby: 'open_timestamp', direction: 'desc',
  });
  const list = data?.data?.rank || data?.rank || data?.data || [];
  if (!list.length) return '❌ Tidak ada token baru ditemukan di ' + chain.toUpperCase() + '.';

  const lines = ['🆕 **Token Baru (1h) — ' + chain.toUpperCase() + '**', ''];
  list.slice(0, 10).forEach((t, i) => {
    const name = t.name || t.symbol || '?';
    const sym  = (t.symbol && t.symbol !== name) ? ' (' + t.symbol + ')' : '';
    const mc   = t.market_cap ? ' | MC: $'  + fmt(t.market_cap) : '';
    const liq  = t.liquidity  ? ' | Liq: $' + fmt(t.liquidity)  : '';
    const ca   = t.address || t.ca || '';
    lines.push((i + 1) + '. **' + name + sym + '**' + mc + liq);
    if (ca) lines.push('   CA: `' + ca + '`');
  });
  return lines.join('\n');
}

// ============================================================
// HANDLER: TRENDING
// ============================================================
async function handleTrending(chain) {
  const data = await gmgnGet('/rank/' + chain + '/swaps/1h', {
    limit: 10, orderby: 'swaps', direction: 'desc',
  });
  const list = data?.data?.rank || data?.rank || data?.data || [];
  if (!list.length) return '❌ Tidak ada token trending di ' + chain.toUpperCase() + '.';

  const lines = ['🔥 **Trending (1h) — ' + chain.toUpperCase() + '**', ''];
  list.slice(0, 10).forEach((t, i) => {
    const name   = t.name   || t.symbol || '?';
    const sym    = (t.symbol && t.symbol !== name) ? ' (' + t.symbol + ')' : '';
    const price  = t.price  ? fmtPrice(t.price)   : '';
    const change = t.price_change_percent ? ' ' + fmtPct(t.price_change_percent) : '';
    const mc     = t.market_cap ? ' | MC: $'    + fmt(t.market_cap) : '';
    const swaps  = t.swaps      ? ' | Swaps: '  + fmt(t.swaps, 0)  : '';
    lines.push((i + 1) + '. **' + name + sym + '**' + change);
    lines.push('   ' + price + mc + swaps);
  });
  return lines.join('\n');
}

// ============================================================
// HANDLER: WALLET ANALYSIS
// ============================================================
async function handleWallet(chain, address) {
  const data   = await gmgnGet('/wallet_activity/' + chain + '/' + address, { limit: 10 });
  const stat   = data?.data?.stat       || data?.stat       || {};
  const trades = data?.data?.activities || data?.activities || [];

  const pnl7d   = stat.realized_profit_7d  != null ? '$' + fmt(stat.realized_profit_7d)  : 'N/A';
  const pnl30d  = stat.realized_profit_30d != null ? '$' + fmt(stat.realized_profit_30d) : 'N/A';
  const winRate = stat.win_rate  != null ? (parseFloat(stat.win_rate) * 100).toFixed(1) + '%' : 'N/A';
  const buy30   = stat.buy_30d   != null ? stat.buy_30d  : '?';
  const sell30  = stat.sell_30d  != null ? stat.sell_30d : '?';

  const lines = [
    '👛 **Analisis Wallet**',
    '`' + shortAddr(address, 8, 6) + '`',
    '',
    '• PnL 7d:   ' + pnl7d,
    '• PnL 30d:  ' + pnl30d,
    '• Win Rate: ' + winRate,
    '• Trades:   ' + buy30 + ' buy / ' + sell30 + ' sell (30d)',
    '',
  ];

  if (trades.length > 0) {
    lines.push('**Aktivitas Terbaru:**');
    trades.slice(0, 5).forEach((tx) => {
      const type  = (tx.event_type === 'buy' || tx.type === 'buy') ? '🟢 Buy' : '🔴 Sell';
      const token = tx.token_symbol || tx.symbol || '?';
      const amt   = tx.token_amount ? fmt(tx.token_amount) : '';
      const val   = tx.cost_usd     ? '$' + fmt(tx.cost_usd) : '';
      lines.push('• ' + type + ' ' + token + (amt ? ' (' + amt + ')' : '') + (val ? ' — ' + val : ''));
    });
    lines.push('');
  }

  lines.push('🔗 [GMGN](<https://gmgn.ai/' + chain + '/address/' + address + '>)');
  return lines.join('\n');
}

// ============================================================
// HANDLER: TOP HOLDERS
// ============================================================
async function handleHolders(chain, ca) {
  const data = await gmgnGet('/tokens/top_holders/' + chain + '/' + ca, { limit: 10 });
  const list = data?.data?.holders || data?.holders || data?.data || [];
  if (!list.length) return '❌ Tidak ada data holder untuk token ini.';

  const lines = ['🏆 **Top Holder — `' + shortAddr(ca) + '`**', ''];
  list.slice(0, 10).forEach((h, i) => {
    const addr = h.address || h.wallet || '';
    const pct  = h.percent != null ? (parseFloat(h.percent) * 100).toFixed(2) + '%' : '';
    const amt  = h.amount  != null ? fmt(h.amount) : '';
    const tag  = h.account_tag || h.tag || '';
    lines.push(
      (i + 1) + '. `' + shortAddr(addr) + '`'
      + (tag ? ' [' + tag + ']' : '')
      + (pct ? ' — '   + pct   : '')
      + (amt ? ' (' + amt + ')' : '')
    );
  });
  return lines.join('\n');
}

// ============================================================
// MAIN DISPATCH
// ============================================================
async function handleGmgnCommand(query) {
  if (!query || typeof query !== 'object') return '❌ Query GMGN tidak valid.';
  const { type, chain, address } = query;

  try {
    if (type === 'token')    return await handleTokenInfo(chain, address);
    if (type === 'smart')    return await handleSmartMoney(chain, address);
    if (type === 'new')      return await handleNewTokens(chain);
    if (type === 'trending') return await handleTrending(chain);
    if (type === 'wallet')   return await handleWallet(chain, address);
    if (type === 'holder')   return await handleHolders(chain, address);
    return '❌ Command GMGN tidak dikenal.\n'
      + 'Tersedia: `gmgn <CA>` · `gmgn trending [chain]` · `gmgn new [chain]`\n'
      + '`gmgn smart [CA]` · `gmgn wallet <addr>` · `gmgn holder <CA>`';
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Error tidak diketahui';
    throw new Error(msg);
  }
}

module.exports = { detectGmgnQuery, handleGmgnCommand };
