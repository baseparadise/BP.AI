// lib/gmgn.js
// GMGN.ai API — multi-chain: sol, eth, bsc, base
//
// COMMAND:
//   gmgn <CA>                   → info token + harga + security
//   gmgn <chain> <CA>           → info token chain tertentu
//   gmgn trending [chain]       → trending 1h
//   gmgn smart [chain|CA]       → top smart traders
//   gmgn wallet [chain] <addr>  → analisis wallet

const https      = require('https');
const zlib       = require('zlib');
const { execSync } = require('child_process');

// ── Konstanta ─────────────────────────────────────────────
const GMGN_HOST = 'gmgn.ai';
const DEX_HOST  = 'api.dexscreener.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const COMMON_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://gmgn.ai/',
  'Origin': 'https://gmgn.ai',
};

const SUPPORTED_CHAINS = ['sol', 'eth', 'bsc', 'base'];
const CHAIN_ALIAS = {
  solana: 'sol', ethereum: 'eth', ether: 'eth',
  bnb: 'bsc', bnbchain: 'bsc', binance: 'bsc',
};
const CHAIN_TO_DEX = { sol: 'solana', eth: 'ethereum', bsc: 'bsc', base: 'base' };
const CHAIN_LABEL  = { sol: 'Solana', eth: 'Ethereum', bsc: 'BNB Chain', base: 'Base' };

// ── Address utils ─────────────────────────────────────────
function isSolAddr(s) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s); }
function isEvmAddr(s) { return /^0x[a-fA-F0-9]{40}$/.test(s); }
function isAddr(s)    { return isSolAddr(s) || isEvmAddr(s); }
function guessChain(a){ return isEvmAddr(a) ? 'eth' : 'sol'; }
function resolveChain(raw) {
  const l = (raw || '').toLowerCase();
  return CHAIN_ALIAS[l] || (SUPPORTED_CHAINS.includes(l) ? l : null);
}

// ── detectGmgnQuery ───────────────────────────────────────
function detectGmgnQuery(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!/^gmgn\b/i.test(t)) return null;

  const parts = t.split(/\s+/);
  const raw1  = parts[1] || '';
  const sub   = raw1.toLowerCase();
  const raw2  = parts[2] || '';
  const sub2  = raw2.toLowerCase();

  // gmgn <CA>
  if (isAddr(raw1))
    return { type: 'token', chain: guessChain(raw1), address: raw1 };

  // gmgn <chain> <CA>
  const chainFromPart1 = resolveChain(sub);
  if (chainFromPart1 && raw2 && isAddr(raw2))
    return { type: 'token', chain: chainFromPart1, address: raw2 };

  // gmgn trending [chain]
  if (sub === 'trending' || sub === 'trend')
    return { type: 'trending', chain: resolveChain(sub2) || 'sol' };

  // gmgn smart [chain|CA]
  if (sub === 'smart') {
    if (raw2 && isAddr(raw2)) return { type: 'smart', chain: guessChain(raw2), address: raw2 };
    return { type: 'smart', chain: resolveChain(sub2) || 'sol', address: null };
  }

  // gmgn wallet [chain] <addr>
  if (sub === 'wallet' || sub === 'dompet') {
    if (raw2 && isAddr(raw2)) return { type: 'wallet', chain: guessChain(raw2), address: raw2 };
    const chainW = resolveChain(sub2);
    const raw3   = parts[3] || '';
    if (chainW && raw3 && isAddr(raw3)) return { type: 'wallet', chain: chainW, address: raw3 };
    return null;
  }

  // gmgn <chain> → shortcut trending
  if (chainFromPart1 && !raw2)
    return { type: 'trending', chain: chainFromPart1 };

  return null;
}

// ── HTTP: native https (works for /api/v1/ dan DexScreener) ──
function httpsGet(host, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, path, headers: COMMON_HEADERS, timeout: timeoutMs || 12000,
    }, (res) => {
      const chunks = [];
      let stream = res;
      const enc = res.headers['content-encoding'] || '';
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 403) {
          const e = new Error('HTTP 403'); e.status = 403; return reject(e);
        }
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); }
        catch (_) { reject(new Error('JSON parse error')); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── HTTP: curl (untuk /defi/quotation/v1/rank/ yang kena 403 native) ──
function curlGet(url, timeoutSec) {
  const t   = timeoutSec || 12;
  const esc = url.replace(/'/g, "'\\''");
  const cmd = [
    'curl -s -m', t,
    "-H 'User-Agent: " + UA + "'",
    "-H 'Accept: application/json, text/plain, */*'",
    "-H 'Accept-Language: en-US,en;q=0.9'",
    "-H 'Referer: https://gmgn.ai/'",
    "-H 'Origin: https://gmgn.ai'",
    "'" + esc + "'",
  ].join(' ');
  const raw = execSync(cmd, { timeout: (t + 4) * 1000, encoding: 'utf8' });
  if (!raw || !raw.trim()) throw new Error('Response kosong');
  const first = raw.trim()[0];
  if (first !== '{' && first !== '[') throw new Error('Bukan JSON: ' + raw.slice(0, 80));
  return JSON.parse(raw);
}

function buildQS(params) {
  if (!params) return '';
  return '?' + Object.entries(params)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
}

// gmgnGet: /api/v1/ → native https; /defi/quotation/v1/rank/ → curl fallback
async function gmgnGet(path, params) {
  const url = 'https://' + GMGN_HOST + path + buildQS(params);
  try {
    return await httpsGet(GMGN_HOST, path + buildQS(params));
  } catch (e) {
    if (e.status === 403 || e.message.includes('403')) {
      // Fallback ke curl untuk path yang kena Cloudflare JA3 block
      return curlGet(url);
    }
    throw e;
  }
}

// dexGet: selalu native https (tidak ada masalah 403)
function dexGet(path) {
  return httpsGet(DEX_HOST, path, 10000);
}

// ── Format helpers ────────────────────────────────────────
function fmt(n, d) {
  d = (d === undefined) ? 2 : d;
  if (n == null) return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num)) return 'N/A';
  if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(d) + 'B';
  if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(d) + 'M';
  if (Math.abs(num) >= 1e3) return (num / 1e3).toFixed(d) + 'K';
  return num.toFixed(d);
}
function fmtPrice(n) {
  if (n == null) return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num) || num === 0) return 'N/A';
  if (num < 0.000001)  return '$' + num.toExponential(4);
  if (num < 0.0001)    return '$' + num.toFixed(8);
  if (num < 0.01)      return '$' + num.toFixed(6);
  if (num < 1)         return '$' + num.toFixed(5);
  if (num < 1000)      return '$' + num.toFixed(4);
  return '$' + fmt(num);
}
function fmtPct(n) {
  if (n == null) return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num)) return 'N/A';
  return (num >= 0 ? '+' : '') + num.toFixed(2) + '%';
}
function fmtAge(ts) {
  if (!ts) return 'N/A';
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 0)     return 'baru';
  if (s < 60)    return s + 'd';
  if (s < 3600)  return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'j';
  return Math.floor(s / 86400) + ' hari';
}
function shortAddr(a) {
  if (!a || a.length <= 12) return a || 'N/A';
  return a.slice(0, isEvmAddr(a) ? 8 : 6) + '...' + a.slice(-4);
}
function chainBadge(chain) {
  const m = { sol: '🟣', eth: '🔷', bsc: '🟡', base: '🔵' };
  return (m[chain] || '⬜') + ' ' + (CHAIN_LABEL[chain] || chain.toUpperCase());
}

// ── TOKEN INFO ────────────────────────────────────────────
// /api/v1/token_info + /defi/quotation/v1/tokens/security + DexScreener
// Semua path ini bekerja dengan native https (terverifikasi)
async function handleTokenInfo(chain, ca) {
  const dexChain = CHAIN_TO_DEX[chain] || chain;

  const [gmgnRes, secRes, dexRes] = await Promise.all([
    gmgnGet('/api/v1/token_info/' + chain + '/' + ca).catch(e => ({ _err: e.message })),
    gmgnGet('/defi/quotation/v1/tokens/security/' + chain + '/' + ca).catch(() => ({ _err: true })),
    dexGet('/latest/dex/tokens/' + ca).catch(() => ({ _err: true })),
  ]);

  const gi  = (!gmgnRes._err) ? (gmgnRes?.data  || {}) : {};
  const sec = (!secRes._err)  ? (secRes?.data?.goplus || {}) : {};

  let pair = null;
  if (!dexRes._err) {
    const pairs = (dexRes?.pairs || [])
      .filter(p => p.chainId === dexChain)
      .sort((a, b) => (parseFloat(b.volume?.h24) || 0) - (parseFloat(a.volume?.h24) || 0));
    pair = pairs[0] || null;
  }

  if (!gi.address && !pair)
    throw new Error('Token tidak ditemukan di ' + chainBadge(chain) + '. Pastikan CA dan chain benar.');

  const name   = gi.name   || pair?.baseToken?.name   || 'Unknown';
  const symbol = gi.symbol || pair?.baseToken?.symbol || '?';
  const age    = fmtAge(gi.open_timestamp || gi.creation_timestamp);
  const price  = fmtPrice(pair?.priceUsd);
  const mc     = pair?.marketCap      ? '$' + fmt(pair.marketCap)     : 'N/A';
  const fdv    = pair?.fdv            ? '$' + fmt(pair.fdv)           : 'N/A';
  const vol24h = pair?.volume?.h24    ? '$' + fmt(pair.volume.h24)    : 'N/A';
  const liq    = gi.liquidity         ? '$' + fmt(gi.liquidity)       :
                 pair?.liquidity?.usd ? '$' + fmt(pair.liquidity.usd) : 'N/A';
  const ch5m   = fmtPct(pair?.priceChange?.m5);
  const ch1h   = fmtPct(pair?.priceChange?.h1);
  const ch24h  = fmtPct(pair?.priceChange?.h24);
  const holders= gi.holder_count ? gi.holder_count.toLocaleString() : 'N/A';

  const lines = [
    '🪙 **' + name + ' (' + symbol + ')**',
    chainBadge(chain) + (age !== 'N/A' ? '  |  📅 ' + age : ''),
    '`' + ca + '`',
    '',
    '**💰 Harga & Market**',
    '• Harga: '      + price,
    '• MC: '         + mc + '  |  FDV: ' + fdv,
    '• Likuiditas: ' + liq + '  |  Vol 24h: ' + vol24h,
    '• Holder: '     + holders,
    '',
    '**📈 Perubahan Harga**',
    '• 5m: ' + ch5m + '  |  1h: ' + ch1h + '  |  24h: ' + ch24h,
    '',
  ];

  if (Object.keys(sec).length > 0) {
    lines.push('**🔒 Security (GoPlus)**');
    const items = [
      ['Honeypot',    sec.is_honeypot === '1' ? '❌ Ya' : sec.is_honeypot === '0' ? '✅ Tidak' : null],
      ['Buy Tax',     sec.buy_tax  != null ? parseFloat(sec.buy_tax).toFixed(1)  + '%' : null],
      ['Sell Tax',    sec.sell_tax != null ? parseFloat(sec.sell_tax).toFixed(1) + '%' : null],
      ['Mint Auth',   sec.mint_authority === null ? '✅ Renounced' : sec.mint_authority ? '❌ Active' : null],
      ['Freeze Auth', sec.freeze_authority === null ? '✅ Disabled' : sec.freeze_authority ? '❌ Active' : null],
      ['Owner',       sec.owner_address === '0x0000000000000000000000000000000000000000' ? '✅ Renounced' :
                      sec.owner_address ? '❌ ' + shortAddr(sec.owner_address) : null],
    ].filter(([, v]) => v != null);
    for (const [k, v] of items) lines.push('• ' + k + ': ' + v);
    lines.push('');
  } else {
    lines.push('🔒 _Security: GoPlus belum ada data untuk token ini_');
    lines.push('');
  }

  const dexUrl = pair?.url || ('https://dexscreener.com/' + dexChain + '/' + ca);
  lines.push('🔗 [GMGN](<https://gmgn.ai/' + chain + '/token/' + ca +
    '>) | [DexScreener](<' + dexUrl + '>)');
  return lines.join('\n');
}

// ── TRENDING ──────────────────────────────────────────────
// /defi/quotation/v1/rank/ → kena 403 native, pakai curl via gmgnGet fallback
async function handleTrending(chain) {
  const data = await gmgnGet('/defi/quotation/v1/rank/' + chain + '/swaps/1h',
    { limit: 10, orderby: 'swaps', direction: 'desc' });
  const list = data?.data?.rank || [];
  if (!list.length) return '❌ Tidak ada data trending untuk ' + chainBadge(chain) + '.';

  const lines = ['🔥 **Trending (1h) — ' + chainBadge(chain) + '**\n_(berdasarkan jumlah swap)_', ''];
  list.forEach((t, i) => {
    const name   = t.name   || t.symbol || '?';
    const sym    = (t.symbol && t.symbol !== t.name) ? ' (' + t.symbol + ')' : '';
    const price  = fmtPrice(t.price);
    const change = t.price_change_percent1h != null
      ? fmtPct(t.price_change_percent1h) + ' (1h)'
      : (t.price_change_percent != null ? fmtPct(t.price_change_percent) : '');
    const mc    = t.market_cap ? ' | MC: $' + fmt(t.market_cap) : '';
    const swaps = t.swaps      ? ' | ' + fmt(t.swaps, 0) + ' swaps' : '';
    const buys  = (t.buys && t.sells) ? ' | ' + t.buys + '🟢 ' + t.sells + '🔴' : '';
    lines.push((i + 1) + '. **' + name + sym + '** ' + change);
    lines.push('   ' + price + mc + swaps + buys);
    if (t.address) lines.push('   [GMGN](<https://gmgn.ai/' + chain + '/token/' + t.address + '>)');
  });
  return lines.join('\n');
}

// ── SMART MONEY ──────────────────────────────────────────
async function handleSmartMoney(chain, ca) {
  if (ca) {
    const data   = await gmgnGet('/api/v1/token_trades/' + chain + '/' + ca, { limit: 30 });
    const trades = data?.data?.history || [];
    if (!trades.length)
      return '💡 **Smart Traders — `' + shortAddr(ca) + '`**\n_Tidak ada data trades untuk token ini._';

    const makers = {};
    for (const tx of trades) {
      if (!tx.maker) continue;
      if (!makers[tx.maker]) makers[tx.maker] = { usd: 0, buy: 0, sell: 0, tags: tx.maker_tags || [] };
      makers[tx.maker].usd += parseFloat(tx.amount_usd || 0);
      if (tx.event === 'buy') makers[tx.maker].buy++;
      else makers[tx.maker].sell++;
    }
    const sorted = Object.entries(makers).sort((a, b) => b[1].usd - a[1].usd).slice(0, 10);
    const lines = [
      '💡 **Trader Terbesar — `' + shortAddr(ca) + '`** (' + chainBadge(chain) + ')',
      '_(dari trades terbaru)_', '',
    ];
    sorted.forEach(([addr, d], i) => {
      const tags = d.tags.length ? ' [' + d.tags.slice(0, 2).join(', ') + ']' : '';
      const vol  = d.usd > 0 ? ' | $' + fmt(d.usd) : '';
      lines.push((i + 1) + '. `' + shortAddr(addr) + '`' + tags + vol +
        ' (' + d.buy + 'B/' + d.sell + 'S)');
    });
    return lines.join('\n');
  }

  const data = await gmgnGet('/defi/quotation/v1/rank/' + chain + '/wallets/1h',
    { limit: 10, orderby: 'pnl', direction: 'desc' });
  const list = data?.data?.rank || [];
  if (!list.length) return '💡 **Top Smart Money**\n_Data tidak tersedia untuk ' + chainBadge(chain) + '._';

  const lines = [
    '💡 **Top Smart Traders (1h) — ' + chainBadge(chain) + '**\n_(berdasarkan PnL)_', '',
  ];
  list.forEach((w, i) => {
    const pnl = w.realized_profit != null ? ' | PnL: $' + fmt(w.realized_profit) : '';
    const wr  = w.winrate != null ? ' | WR: ' + (parseFloat(w.winrate) * 100).toFixed(0) + '%' : '';
    const b   = w.buy_1d != null ? ' | ' + w.buy_1d + ' buy' : '';
    lines.push((i + 1) + '. `' + shortAddr(w.address) + '`' + pnl + wr + b);
  });
  lines.push('\n🔗 [GMGN Wallets](<https://gmgn.ai/' + chain + '/wallets>)');
  return lines.join('\n');
}

// ── WALLET ANALYSIS ──────────────────────────────────────
async function handleWallet(chain, address) {
  const [s7, s30] = await Promise.all([
    gmgnGet('/api/v1/wallet_stat/' + chain + '/' + address + '/7d').catch(() => ({ _err: true })),
    gmgnGet('/api/v1/wallet_stat/' + chain + '/' + address + '/30d').catch(() => ({ _err: true })),
  ]);

  const d7  = (!s7._err)  ? (s7?.data  || {}) : {};
  const d30 = (!s30._err) ? (s30?.data || {}) : {};

  if (!Object.keys(d7).length && !Object.keys(d30).length)
    throw new Error('Wallet tidak ditemukan atau tidak ada aktivitas di ' + chainBadge(chain) + '.');

  const pnl7   = d7.realized_profit_7d   != null ? '$' + fmt(d7.realized_profit_7d)   : 'N/A';
  const pnl30  = d30.realized_profit_30d != null ? '$' + fmt(d30.realized_profit_30d) : 'N/A';
  const wr     = d7.winrate  != null ? (parseFloat(d7.winrate) * 100).toFixed(1) + '%' : 'N/A';
  const buy7   = d7.buy_7d   ?? '?';
  const sell7  = d7.sell_7d  ?? '?';
  const buy30  = d30.buy_30d ?? '?';
  const sell30 = d30.sell_30d?? '?';
  const nativeBal =
    chain === 'sol'                     ? (parseFloat(d7.sol_balance || 0) > 0 ? parseFloat(d7.sol_balance).toFixed(4) + ' SOL' : null) :
    (chain === 'eth' || chain === 'base')? (parseFloat(d7.eth_balance || 0) > 0 ? parseFloat(d7.eth_balance).toFixed(6) + ' ETH' : null) :
    chain === 'bsc'                     ? (parseFloat(d7.bnb_balance || 0) > 0 ? parseFloat(d7.bnb_balance).toFixed(6) + ' BNB' : null) : null;
  const totVal = d7.total_value ? '$' + fmt(d7.total_value) : null;

  const lines = [
    '👛 **Analisis Wallet** — ' + chainBadge(chain),
    '`' + address + '`',
    '',
    '**📊 Statistik Trading**',
    '• PnL 7d:     ' + pnl7,
    '• PnL 30d:    ' + pnl30,
    '• Win Rate:   ' + wr,
    '• Trades 7d:  ' + buy7 + ' buy / ' + sell7 + ' sell',
    '• Trades 30d: ' + buy30 + ' buy / ' + sell30 + ' sell',
  ];
  if (nativeBal || totVal) {
    lines.push('');
    lines.push('**💰 Saldo**');
    if (nativeBal) lines.push('• Native: ' + nativeBal);
    if (totVal)    lines.push('• Total:  ' + totVal);
  }
  lines.push('');
  lines.push('🔗 [GMGN Wallet](<https://gmgn.ai/' + chain + '/address/' + address + '>)');
  return lines.join('\n');
}

// ── DISPATCH ─────────────────────────────────────────────
async function handleGmgnCommand(query) {
  if (!query || typeof query !== 'object') return '❌ Query GMGN tidak valid.';
  const { type, chain, address } = query;
  try {
    if (type === 'token')    return await handleTokenInfo(chain, address);
    if (type === 'trending') return await handleTrending(chain);
    if (type === 'smart')    return await handleSmartMoney(chain, address);
    if (type === 'wallet')   return await handleWallet(chain, address);
    return [
      '❌ Command tidak dikenal. Tersedia:',
      '```',
      'gmgn <CA>                  — info token + harga + security',
      'gmgn <chain> <CA>          — spesifik chain (eth/bsc/base)',
      'gmgn trending [chain]      — trending 1h',
      'gmgn smart [chain|CA]      — top smart traders',
      'gmgn wallet [chain] <addr> — analisis wallet',
      '',
      'Chain: sol  eth  bsc  base',
      '```',
    ].join('\n');
  } catch (err) {
    throw new Error(err?.message || 'Error tidak diketahui');
  }
}

module.exports = { detectGmgnQuery, handleGmgnCommand };
