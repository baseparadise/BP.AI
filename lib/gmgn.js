// lib/gmgn.js
// GMGN.ai API integration — semua endpoint sudah diverifikasi berfungsi.
// Fallback ke DexScreener untuk data yang tidak tersedia di GMGN.

const axios = require('axios');

// === KONFIGURASI ===
const GMGN_API  = 'https://gmgn.ai/api/v1';
const GMGN_DEFI = 'https://gmgn.ai/defi/quotation/v1';
const DEX_API   = 'https://api.dexscreener.com';

const BROWSER_HEADERS = {
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
// Peta chain ke chainId DexScreener
const CHAIN_TO_DEX = {
  sol: 'solana', eth: 'ethereum', bsc: 'bsc', base: 'base',
  arbitrum: 'arbitrum', blast: 'blast', tron: 'tron',
};

// ============================================================
// ADDRESS UTILS
// ============================================================
function isSolAddr(s) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s); }
function isEvmAddr(s) { return /^0x[a-fA-F0-9]{40}$/.test(s); }
function isAddr(s)    { return isSolAddr(s) || isEvmAddr(s); }
function guessChain(addr) { return isEvmAddr(addr) ? 'eth' : 'sol'; }
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
// FORMAT UTILS
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
  if (num < 0.01)     return '$' + num.toFixed(8);
  if (num < 1)        return '$' + num.toFixed(6);
  return '$' + num.toFixed(4);
}

function fmtPct(n) {
  if (n === undefined || n === null) return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num)) return 'N/A';
  return (num >= 0 ? '+' : '') + num.toFixed(2) + '%';
}

function fmtAge(ts) {
  if (!ts) return 'N/A';
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60) return secs + 'd';
  if (secs < 3600)  return Math.floor(secs / 60) + 'm';
  if (secs < 86400) return Math.floor(secs / 3600) + 'j';
  return Math.floor(secs / 86400) + ' hari';
}

function shortAddr(addr, head, tail) {
  head = head || 6; tail = tail || 4;
  if (!addr || addr.length <= head + tail) return addr || 'N/A';
  return addr.slice(0, head) + '...' + addr.slice(-tail);
}

// ============================================================
// HTTP HELPERS
// ============================================================
async function gmgnGet(path, params) {
  const resp = await axios.get(path, {
    headers: BROWSER_HEADERS, params: params || {}, timeout: 12000,
  });
  return resp.data;
}

async function dexGet(path, params) {
  const resp = await axios.get(DEX_API + path, {
    params: params || {}, timeout: 10000,
  });
  return resp.data;
}

// ============================================================
// HANDLER: TOKEN INFO (gmgn <CA>)
// GMGN: token_info + security | DexScreener: harga, MC, volume
// ============================================================
async function handleTokenInfo(chain, ca) {
  const [gmgnRes, secRes, dexRes] = await Promise.allSettled([
    gmgnGet(GMGN_API + '/token_info/' + chain + '/' + ca),
    gmgnGet(GMGN_DEFI + '/tokens/security/' + chain + '/' + ca),
    dexGet('/latest/dex/tokens/' + ca),
  ]);

  const gi = gmgnRes.status === 'fulfilled' ? (gmgnRes.value?.data || {}) : {};
  const sec = secRes.status === 'fulfilled'  ? (secRes.value?.data?.goplus || {}) : {};

  // Ambil data harga dari DexScreener (pair dengan volume tertinggi)
  let dexPair = null;
  if (dexRes.status === 'fulfilled') {
    const pairs = dexRes.value?.pairs || [];
    dexPair = pairs.sort((a, b) => (parseFloat(b.volume?.h24) || 0) - (parseFloat(a.volume?.h24) || 0))[0] || null;
  }

  if (!gi.address && !dexPair) {
    throw new Error('Data token tidak ditemukan. Cek CA dan chain-nya.');
  }

  const name     = gi.name   || dexPair?.baseToken?.name   || 'Unknown';
  const symbol   = gi.symbol || dexPair?.baseToken?.symbol || '?';
  const price    = fmtPrice(dexPair?.priceUsd || 0);
  const mc       = dexPair?.marketCap    ? '$' + fmt(dexPair.marketCap)    : 'N/A';
  const fdv      = dexPair?.fdv          ? '$' + fmt(dexPair.fdv)          : 'N/A';
  const vol24h   = dexPair?.volume?.h24  ? '$' + fmt(dexPair.volume.h24)   : 'N/A';
  const liq      = gi.liquidity          ? '$' + fmt(gi.liquidity)         :
                   dexPair?.liquidity?.usd ? '$' + fmt(dexPair.liquidity.usd) : 'N/A';
  const change5m  = dexPair?.priceChange?.m5  ? fmtPct(dexPair.priceChange.m5)  : 'N/A';
  const change1h  = dexPair?.priceChange?.h1  ? fmtPct(dexPair.priceChange.h1)  : 'N/A';
  const change24h = dexPair?.priceChange?.h24 ? fmtPct(dexPair.priceChange.h24) : 'N/A';
  const holders  = gi.holder_count ? gi.holder_count.toLocaleString() : 'N/A';
  const age      = fmtAge(gi.open_timestamp || gi.creation_timestamp);
  const top10    = dexPair ? null : null; // from GMGN trending data

  const lines = [
    '🪙 **' + name + ' (' + symbol + ')**',
    '📊 Chain: ' + chain.toUpperCase() + ' | Umur: ' + age,
    '`' + ca + '`',
    '',
    '**💰 Harga & Market**',
    '• Harga: '       + price,
    '• Market Cap: '  + mc,
    '• FDV: '         + fdv,
    '• Likuiditas: '  + liq,
    '• Volume 24h: '  + vol24h,
    '• Holder: '      + holders,
    '',
    '**📈 Perubahan Harga**',
    '• 5m: ' + change5m + '  |  1h: ' + change1h + '  |  24h: ' + change24h,
    '',
  ];

  // Security dari GoPlus
  const secHasData = Object.keys(sec).length > 0;
  if (secHasData) {
    lines.push('**🔒 Security (GoPlus)**');
    const secMap = [
      ['Mint Renounced',   sec.mint_authority === null || sec.no_mint === '1' ? true : (sec.mint_authority ? false : null)],
      ['Freeze Disabled',  sec.freeze_authority === null ? true : (sec.freeze_authority ? false : null)],
      ['Honeypot',         sec.is_honeypot === '1' ? true : (sec.is_honeypot === '0' ? false : null)],
      ['Buy Tax',          sec.buy_tax  != null ? parseFloat(sec.buy_tax) + '%'  : null],
      ['Sell Tax',         sec.sell_tax != null ? parseFloat(sec.sell_tax) + '%' : null],
      ['LP Burned',        sec.lp_holder_analysis?.find(h => h.tag === 'black_hole')?.percent > 0 ? '✅ Ya' : null],
      ['Top 10 Holder',    sec.holder_count ? fmt(parseFloat(sec.holder_count), 0) : null],
    ].filter(([, v]) => v !== null && v !== undefined);

    for (const [label, val] of secMap) {
      const display = (typeof val === 'boolean') ? (val ? '✅ Ya' : '❌ Tidak') : String(val);
      lines.push('• ' + label + ': ' + display);
    }
    lines.push('');
  } else {
    lines.push('🔒 Security: _Data GoPlus belum tersedia untuk token ini_');
    lines.push('');
  }

  const dexUrl = dexPair?.url || ('https://dexscreener.com/' + (CHAIN_TO_DEX[chain] || chain) + '/' + ca);
  lines.push('🔗 [GMGN](<https://gmgn.ai/' + chain + '/token/' + ca + '>) | [DexScreener](<' + dexUrl + '>)');
  return lines.join('\n');
}

// ============================================================
// HANDLER: SMART MONEY (gmgn smart [CA])
// ✅ Terverifikasi: /defi/quotation/v1/rank/sol/wallets/1h
// ============================================================
async function handleSmartMoney(chain, ca) {
  if (ca) {
    // Smart trader yang pernah trade token ini
    const data = await gmgnGet(GMGN_API + '/token_trades/' + chain + '/' + ca, { limit: 20 });
    const trades = data?.data?.history || [];

    if (!trades.length) return '💡 **Smart Money — `' + shortAddr(ca) + '`**\n_Tidak ada data trades._';

    // Grup per maker, hitung net position
    const makers = {};
    for (const tx of trades) {
      const addr = tx.maker;
      if (!addr) continue;
      if (!makers[addr]) makers[addr] = { buy: 0, sell: 0, usd: 0, tags: tx.maker_tags || [] };
      if (tx.event === 'buy') {
        makers[addr].buy++;
        makers[addr].usd += parseFloat(tx.amount_usd || 0);
      } else {
        makers[addr].sell++;
      }
    }

    const sorted = Object.entries(makers)
      .sort((a, b) => b[1].usd - a[1].usd)
      .slice(0, 10);

    const lines = ['💡 **Trader Terbesar — `' + shortAddr(ca) + '`**\n_(dari trades terbaru)_', ''];
    sorted.forEach(([addr, d], i) => {
      const tags = d.tags.length ? ' [' + d.tags.slice(0, 2).join(', ') + ']' : '';
      const vol  = d.usd > 0 ? ' | Vol: $' + fmt(d.usd) : '';
      const buySell = ' | ' + d.buy + 'B/' + d.sell + 'S';
      lines.push((i + 1) + '. `' + shortAddr(addr) + '`' + tags + vol + buySell);
    });
    return lines.join('\n');
  }

  // Top smart traders global
  const data = await gmgnGet(GMGN_DEFI + '/rank/' + chain + '/wallets/1h', {
    limit: 10, orderby: 'pnl', direction: 'desc',
  });
  const list = data?.data?.rank || [];
  if (!list.length) return '💡 **Top Smart Money**\n_Data tidak tersedia._';

  const lines = ['💡 **Top Smart Traders — ' + chain.toUpperCase() + ' (1h)**\n_(berdasarkan PnL)_', ''];
  list.slice(0, 10).forEach((w, i) => {
    const addr  = w.address || '';
    const pnl   = w.realized_profit != null ? ' | PnL: $' + fmt(w.realized_profit) : '';
    const wr    = w.winrate != null ? ' | WR: ' + (parseFloat(w.winrate) * 100).toFixed(0) + '%' : '';
    const buys  = w.buy_1d != null ? ' | ' + w.buy_1d + 'B' : '';
    lines.push((i + 1) + '. `' + shortAddr(addr) + '`' + pnl + wr + buys);
  });
  lines.push('\n🔗 [GMGN Smart Money](<https://gmgn.ai/' + chain + '/wallets>)');
  return lines.join('\n');
}

// ============================================================
// HANDLER: NEW TOKENS (gmgn new [chain])
// Fallback ke DexScreener karena GMGN tidak punya endpoint ini
// ============================================================
async function handleNewTokens(chain) {
  const dexChain = CHAIN_TO_DEX[chain] || chain;

  // DexScreener: ambil token profiles terbaru lalu filter by chain
  const data = await dexGet('/token-profiles/latest/v1');
  const all  = Array.isArray(data) ? data : [];

  const filtered = all
    .filter(t => (t.chainId || '').toLowerCase() === dexChain.toLowerCase())
    .slice(0, 10);

  if (!filtered.length) {
    // Fallback: search DexScreener untuk token baru di chain ini
    const s = await dexGet('/latest/dex/search', { q: dexChain.toUpperCase() });
    const pairs = (s?.pairs || [])
      .filter(p => p.chainId === dexChain)
      .sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0))
      .slice(0, 10);

    if (!pairs.length) return '❌ Tidak ada token baru ditemukan di ' + chain.toUpperCase() + '.';

    const lines = ['🆕 **Token Baru — ' + chain.toUpperCase() + '** _(via DexScreener)_', ''];
    pairs.forEach((p, i) => {
      const name  = p.baseToken?.name   || '?';
      const sym   = p.baseToken?.symbol || '?';
      const mc    = p.marketCap ? ' | MC: $' + fmt(p.marketCap) : '';
      const vol   = p.volume?.h24 ? ' | Vol: $' + fmt(p.volume.h24) : '';
      const age   = p.pairCreatedAt ? fmtAge(Math.floor(p.pairCreatedAt / 1000)) : '';
      const ca    = p.baseToken?.address || '';
      lines.push((i + 1) + '. **' + name + ' (' + sym + ')** ' + (age ? '— ' + age + ' lalu' : '') + mc + vol);
      if (ca) lines.push('   CA: `' + ca + '`');
    });
    return lines.join('\n');
  }

  const lines = ['🆕 **Token Baru — ' + chain.toUpperCase() + '** _(via DexScreener profiles)_', ''];
  filtered.forEach((t, i) => {
    const desc = t.description ? t.description.slice(0, 60) : '';
    lines.push((i + 1) + '. **' + (t.tokenAddress || '?') + '**');
    if (desc) lines.push('   ' + desc);
    lines.push('   [DexScreener](<' + (t.url || '') + '>)');
  });
  return lines.join('\n');
}

// ============================================================
// HANDLER: TRENDING (gmgn trending [chain])
// ✅ Terverifikasi: /defi/quotation/v1/rank/sol/swaps/1h
// ============================================================
async function handleTrending(chain) {
  const data = await gmgnGet(GMGN_DEFI + '/rank/' + chain + '/swaps/1h', {
    limit: 10, orderby: 'swaps', direction: 'desc',
  });
  const list = data?.data?.rank || [];
  if (!list.length) return '❌ Tidak ada token trending di ' + chain.toUpperCase() + '.';

  const lines = ['🔥 **Trending (1h) — ' + chain.toUpperCase() + '**\n_(diurutkan berdasarkan swap count)_', ''];
  list.slice(0, 10).forEach((t, i) => {
    const name   = t.name   || t.symbol || '?';
    const sym    = (t.symbol && t.symbol !== t.name) ? ' (' + t.symbol + ')' : '';
    const price  = t.price  ? fmtPrice(t.price)           : '';
    const change = t.price_change_percent1h != null
      ? ' ' + fmtPct(t.price_change_percent1h) + ' (1h)'
      : (t.price_change_percent != null ? ' ' + fmtPct(t.price_change_percent) : '');
    const mc     = t.market_cap ? ' | MC: $' + fmt(t.market_cap) : '';
    const swaps  = t.swaps      ? ' | ' + fmt(t.swaps, 0) + ' swaps' : '';
    const buys   = (t.buys && t.sells) ? ' | ' + t.buys + '🟢 ' + t.sells + '🔴' : '';
    const ca     = t.address || '';

    lines.push((i + 1) + '. **' + name + sym + '**' + change);
    lines.push('   ' + price + mc + swaps + buys);
    if (ca) lines.push('   [GMGN](<https://gmgn.ai/' + chain + '/token/' + ca + '>)');
  });
  return lines.join('\n');
}

// ============================================================
// HANDLER: WALLET ANALYSIS (gmgn wallet <addr>)
// ✅ Terverifikasi: /api/v1/wallet_stat/sol/{addr}/7d dan /30d
// ============================================================
async function handleWallet(chain, address) {
  const [stat7, stat30] = await Promise.allSettled([
    gmgnGet(GMGN_API + '/wallet_stat/' + chain + '/' + address + '/7d'),
    gmgnGet(GMGN_API + '/wallet_stat/' + chain + '/' + address + '/30d'),
  ]);

  const d7  = stat7.status  === 'fulfilled' ? (stat7.value?.data  || {}) : {};
  const d30 = stat30.status === 'fulfilled' ? (stat30.value?.data || {}) : {};

  if (!Object.keys(d7).length && !Object.keys(d30).length) {
    throw new Error('Wallet tidak ditemukan atau tidak ada aktivitas.');
  }

  const pnl7   = d7.realized_profit_7d   != null ? '$' + fmt(d7.realized_profit_7d)   : 'N/A';
  const pnl30  = d30.realized_profit_30d != null ? '$' + fmt(d30.realized_profit_30d) : 'N/A';
  const wr     = d7.winrate  != null ? (parseFloat(d7.winrate)  * 100).toFixed(1) + '%' : 'N/A';
  const buy7   = d7.buy_7d   != null ? d7.buy_7d   : '?';
  const sell7  = d7.sell_7d  != null ? d7.sell_7d  : '?';
  const buy30  = d30.buy_30d != null ? d30.buy_30d : '?';
  const sell30 = d30.sell_30d!= null ? d30.sell_30d: '?';

  // Cek saldo SOL/token
  const solBal = d7.sol_balance ? parseFloat(d7.sol_balance).toFixed(4) + ' SOL' : null;
  const totVal  = d7.total_value ? '$' + fmt(d7.total_value) : null;

  const lines = [
    '👛 **Analisis Wallet**',
    '`' + address + '`',
    '',
    '**📊 Statistik Trading**',
    '• PnL 7d:    ' + pnl7,
    '• PnL 30d:   ' + pnl30,
    '• Win Rate:  ' + wr,
    '• Trades 7d: ' + buy7 + ' buy / ' + sell7 + ' sell',
    '• Trades 30d:' + buy30 + ' buy / ' + sell30 + ' sell',
  ];

  if (solBal || totVal) {
    lines.push('');
    lines.push('**💰 Saldo**');
    if (solBal) lines.push('• SOL Balance: ' + solBal);
    if (totVal)  lines.push('• Total Value: ' + totVal);
  }

  lines.push('');
  lines.push('🔗 [GMGN Wallet](<https://gmgn.ai/' + chain + '/address/' + address + '>)');
  return lines.join('\n');
}

// ============================================================
// HANDLER: TOP HOLDERS (gmgn holder <CA>)
// Kombinasi GMGN token_info + DexScreener pair data
// ============================================================
async function handleHolders(chain, ca) {
  const [gmgnRes, dexRes] = await Promise.allSettled([
    gmgnGet(GMGN_API + '/token_info/' + chain + '/' + ca),
    dexGet('/latest/dex/tokens/' + ca),
  ]);

  const gi   = gmgnRes.status === 'fulfilled' ? (gmgnRes.value?.data || {}) : {};
  const pairs = dexRes.status  === 'fulfilled' ? (dexRes.value?.pairs || []) : [];
  const best  = pairs.sort((a, b) => (parseFloat(b.volume?.h24)||0) - (parseFloat(a.volume?.h24)||0))[0];

  if (!gi.address && !best) {
    throw new Error('Token tidak ditemukan. Cek CA-nya.');
  }

  const name    = gi.name   || best?.baseToken?.name   || '?';
  const symbol  = gi.symbol || best?.baseToken?.symbol || '?';
  const holders = gi.holder_count ? gi.holder_count.toLocaleString() : 'N/A';
  const top10   = best ? null : null;

  const lines = [
    '🏆 **Holder Info — ' + name + ' (' + symbol + ')**',
    '`' + shortAddr(ca) + '`',
    '',
    '• Total Holder: ' + holders,
  ];

  if (best) {
    const top10pct = best.info?.holders
      ? best.info.holders.filter(h => h.type !== 'pool').slice(0, 1)
      : [];
    const liq = best.liquidity?.usd ? '$' + fmt(best.liquidity.usd) : 'N/A';
    const mc  = best.marketCap ? '$' + fmt(best.marketCap) : 'N/A';
    lines.push('• Market Cap: '  + mc);
    lines.push('• Likuiditas: '  + liq);
    if (best.boosts?.active) lines.push('• 🚀 Token Boosted: ' + best.boosts.active + 'x');
  }

  // Tampilkan recent big traders dari token_trades sebagai proxy holder
  try {
    const trades = await gmgnGet(GMGN_API + '/token_trades/' + chain + '/' + ca, { limit: 30 });
    const history = trades?.data?.history || [];

    const makers = {};
    for (const tx of history) {
      if (!tx.maker) continue;
      if (!makers[tx.maker]) makers[tx.maker] = { usd: 0, buy: 0, sell: 0, tags: tx.maker_tags || [] };
      makers[tx.maker].usd += parseFloat(tx.amount_usd || 0);
      if (tx.event === 'buy') makers[tx.maker].buy++;
      else makers[tx.maker].sell++;
    }

    const sorted = Object.entries(makers)
      .sort((a, b) => b[1].usd - a[1].usd)
      .slice(0, 10);

    if (sorted.length > 0) {
      lines.push('');
      lines.push('**💸 Top Trader Terbaru:**');
      sorted.forEach(([addr, d], i) => {
        const tags = d.tags.length ? ' [' + d.tags.slice(0, 2).join(', ') + ']' : '';
        const vol  = d.usd > 0 ? ' — $' + fmt(d.usd) : '';
        const bs   = ' (' + d.buy + 'B/' + d.sell + 'S)';
        lines.push((i + 1) + '. `' + shortAddr(addr) + '`' + tags + vol + bs);
      });
    }
  } catch (_) {}

  lines.push('');
  lines.push('🔗 [GMGN](<https://gmgn.ai/' + chain + '/token/' + ca + '>)');
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
    return '❌ Command tidak dikenal.\n'
      + 'Tersedia:\n'
      + '```\n'
      + 'gmgn <CA>              Info + security + harga token\n'
      + 'gmgn trending [chain]  Token trending 1h\n'
      + 'gmgn new [chain]       Token baru\n'
      + 'gmgn smart [CA]        Top smart traders\n'
      + 'gmgn wallet <addr>     Analisis wallet\n'
      + 'gmgn holder <CA>       Info holder + top traders\n'
      + '```';
  } catch (err) {
    const msg = err?.response?.data?.message || err?.response?.data?.msg || err.message || 'Error tidak diketahui';
    throw new Error(msg);
  }
}

module.exports = { detectGmgnQuery, handleGmgnCommand };
