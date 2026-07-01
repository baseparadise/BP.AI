// lib/gmgn.js
// GMGN.ai API — multi-chain: sol, eth, bsc, base
// v4: SEMUA endpoint pakai openapi.gmgn.ai (X-APIKEY auth, tanpa Cloudflare block)
//     DexScreener sebagai data harga tambahan
//
// COMMAND:
//   gmgn <CA>                   → info token + security + smart money
//   gmgn <chain> <CA>           → info token chain tertentu
//   gmgn trending [chain]       → trending 1h
//   gmgn smart <CA>             → top smart traders token
//   gmgn wallet [chain] <addr>  → analisis wallet

const https  = require('https');
const zlib   = require('zlib');
const crypto = require('crypto');

// ── Konstanta ─────────────────────────────────────────────
const OPENAPI_HOST = 'openapi.gmgn.ai';
const DEX_HOST     = 'api.dexscreener.com';

// GMGN API key — set via env GMGN_API_KEY
const GMGN_API_KEY = process.env.GMGN_API_KEY || '';

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

  if (isAddr(raw1))
    return { type: 'token', chain: guessChain(raw1), address: raw1 };

  const chainFromPart1 = resolveChain(sub);
  if (chainFromPart1 && raw2 && isAddr(raw2))
    return { type: 'token', chain: chainFromPart1, address: raw2 };

  if (sub === 'trending' || sub === 'trend')
    return { type: 'trending', chain: resolveChain(sub2) || 'sol' };

  if (sub === 'smart') {
    if (raw2 && isAddr(raw2)) return { type: 'smart', chain: guessChain(raw2), address: raw2 };
    return { type: 'smart', chain: resolveChain(sub2) || 'sol', address: null };
  }

  if (sub === 'wallet' || sub === 'dompet') {
    if (raw2 && isAddr(raw2)) return { type: 'wallet', chain: guessChain(raw2), address: raw2 };
    const chainW = resolveChain(sub2);
    const raw3   = parts[3] || '';
    if (chainW && raw3 && isAddr(raw3)) return { type: 'wallet', chain: chainW, address: raw3 };
    return null;
  }

  if (chainFromPart1 && !raw2)
    return { type: 'trending', chain: chainFromPart1 };

  return null;
}

// ── openapi.gmgn.ai (X-APIKEY, tanpa Cloudflare) ─────────
function openGet(path, params) {
  const key = GMGN_API_KEY;
  if (!key) return Promise.reject(new Error(
    'GMGN_API_KEY belum di-set. Tambahkan ke env bot:\nGMGN_API_KEY=gmgn_2f8ac3ea53ccba6d62adb05e63d02a50'
  ));

  const qs = Object.entries({
    ...(params || {}),
    timestamp: Math.floor(Date.now() / 1000),
    client_id : crypto.randomUUID(),
  }).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: OPENAPI_HOST,
      path    : path + '?' + qs,
      method  : 'GET',
      headers : {
        'X-APIKEY'       : key,
        'Accept'         : 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent'     : 'gmgn-cli/1.5.0',
      },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      let stream = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if      (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400)
          return reject(new Error('GMGN API error HTTP ' + res.statusCode));
        try {
          const json = JSON.parse(body);
          if (json.code !== 0) return reject(new Error(json.message || 'code=' + json.code));
          resolve(json.data);
        } catch (_) {
          reject(new Error('JSON parse error: ' + body.slice(0, 120)));
        }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

// ── DexScreener (no auth needed) ─────────────────────────
function dexGet(ca) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: DEX_HOST,
      path    : '/latest/dex/tokens/' + ca,
      method  : 'GET',
      headers : { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate, br' },
      timeout : 10000,
    }, (res) => {
      const chunks = [];
      let stream = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if      (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { resolve(null); }
      });
      stream.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
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
function pricePct(now, before) {
  if (!now || !before || parseFloat(before) === 0) return 'N/A';
  const pct = (parseFloat(now) - parseFloat(before)) / parseFloat(before) * 100;
  return fmtPct(pct);
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
async function handleTokenInfo(chain, ca) {
  const dexChain = CHAIN_TO_DEX[chain] || chain;

  const [infoRes, secRes, dexRes] = await Promise.all([
    openGet('/v1/token/info', { chain, address: ca }),
    openGet('/v1/token/security', { chain, address: ca }).catch(() => null),
    dexGet(ca),
  ]);

  const gi  = infoRes || {};
  const sec = secRes  || {};
  const p   = gi.price || {};

  // DexScreener pair sebagai supplement
  let pair = null;
  if (dexRes && dexRes.pairs) {
    const filtered = dexRes.pairs
      .filter(x => x.chainId === dexChain)
      .sort((a, b) => (parseFloat(b.volume?.h24) || 0) - (parseFloat(a.volume?.h24) || 0));
    pair = filtered[0] || null;
  }

  if (!gi.address && !pair)
    throw new Error('Token tidak ditemukan di ' + chainBadge(chain) + '. Pastikan CA dan chain benar.');

  // ── Data dasar ─────────────────────────────────────────
  const name    = gi.name   || pair?.baseToken?.name   || 'Unknown';
  const symbol  = gi.symbol || pair?.baseToken?.symbol || '?';
  const price   = fmtPrice(p.price || pair?.priceUsd);

  // Market cap — gunakan dex jika gi tidak punya
  const mcRaw   = pair?.marketCap || null;
  const mc      = mcRaw ? '$' + fmt(mcRaw) : 'N/A';
  const athPriceStr = gi.ath_price ? fmtPrice(gi.ath_price) : 'N/A';
  const liq     = gi.liquidity  ? '$' + fmt(gi.liquidity)       :
                  pair?.liquidity?.usd ? '$' + fmt(pair.liquidity.usd) : 'N/A';
  const holders = gi.holder_count ? gi.holder_count.toLocaleString() : 'N/A';
  const platform = gi.launchpad_platform || gi.launchpad || (pair?.dexId ? pair.dexId.charAt(0).toUpperCase() + pair.dexId.slice(1) : '');

  // ── Volume & pergerakan (dari openapi price object) ────
  const vol1h   = p.volume_1h  ? '$' + fmt(p.volume_1h)  : (pair?.volume?.h1  ? '$' + fmt(pair.volume.h1)  : 'N/A');
  const vol24h  = p.volume_24h ? '$' + fmt(p.volume_24h) : (pair?.volume?.h24 ? '$' + fmt(pair.volume.h24) : 'N/A');
  const ch1h    = p.price && p.price_1h  ? pricePct(p.price, p.price_1h)  : (pair?.priceChange?.h1  != null ? fmtPct(pair.priceChange.h1)  : 'N/A');
  const ch24h   = p.price && p.price_24h ? pricePct(p.price, p.price_24h) : (pair?.priceChange?.h24 != null ? fmtPct(pair.priceChange.h24) : 'N/A');

  // ── Swap 1h ─────────────────────────────────────────────
  const buys1h  = p.buys_1h   ?? pair?.txns?.h1?.buys   ?? null;
  const sells1h = p.sells_1h  ?? pair?.txns?.h1?.sells  ?? null;
  const totalSwaps = (buys1h != null && sells1h != null) ? (buys1h + sells1h) : null;
  const swapStr = totalSwaps != null
    ? fmt(totalSwaps, 0) + ' (' + fmt(buys1h, 0) + ' beli / ' + fmt(sells1h, 0) + ' jual)'
    : 'N/A';

  // ── Build output ────────────────────────────────────────
  const lines = [
    '🔍 **' + name + ' (' + symbol + ')** — ' + (CHAIN_LABEL[chain] || chain),
    '📄 `' + ca + '`',
  ];
  if (platform) lines.push('🚀 ' + platform);
  lines.push('');
  lines.push('📊 **Market**');
  lines.push('• Harga       : ' + price);
  lines.push('• Market Cap  : ' + mc);
  if (athPriceStr !== 'N/A') lines.push('• ATH Price   : ' + athPriceStr);
  lines.push('• Likuiditas  : ' + liq);
  lines.push('• Holders     : ' + holders);
  lines.push('');
  lines.push('📈 **Pergerakan**');
  lines.push('• 1h: '  + ch1h  + '   │ Volume 1h : ' + vol1h);
  lines.push('• 24h: ' + ch24h + '  │ Volume 24h: ' + vol24h);
  lines.push('• Swap 1h: ' + swapStr);
  lines.push('');

  // ── Security (openapi) ───────────────────────────────────
  if (Object.keys(sec).length > 0) {
    const mintRenounced   = sec.renounced_mint           === true  ? '✅ Ya'
                          : sec.renounced_mint           === false ? '❌ Tidak' : 'N/A';
    const freezeRenounced = sec.renounced_freeze_account === true  ? '✅ Ya'
                          : sec.renounced_freeze_account === false ? '❌ Tidak' : 'N/A';
    const honeypot        = sec.honeypot === 0 ? '✅ Ya'
                          : sec.honeypot === 1 ? '❌ Tidak' : '✅ Ya';
    const buyTax  = sec.buy_tax  != null ? (parseFloat(sec.buy_tax)  * 1).toFixed(1) + '%' : '0.0%';
    const sellTax = sec.sell_tax != null ? (parseFloat(sec.sell_tax) * 1).toFixed(1) + '%' : '0.0%';

    // LP Burn
    let lpBurn = 'N/A';
    if (sec.burn_status === 'burn' || parseFloat(sec.burn_ratio || 0) >= 0.95) {
      lpBurn = '🔥 Burned';
    } else if (sec.burn_ratio != null) {
      lpBurn = (parseFloat(sec.burn_ratio) * 100).toFixed(1) + '% burned';
    } else if (sec.lock_summary?.is_locked) {
      const lockPct = sec.lock_summary.lock_detail?.[0]?.percent;
      lpBurn = lockPct ? (parseFloat(lockPct) * 100).toFixed(0) + '% locked' : '🔒 Locked';
    }

    // Top 10 Holder
    const top10Str = sec.top_10_holder_rate != null
      ? (parseFloat(sec.top_10_holder_rate) * 100).toFixed(1) + '%'
      : 'N/A';

    lines.push('🔒 **Security**');
    lines.push('• Mint Renounced   : ' + mintRenounced);
    lines.push('• Freeze Renounced : ' + freezeRenounced);
    lines.push('• Honeypot         : ' + honeypot);
    lines.push('• Buy Tax: ' + buyTax + '   │ Sell Tax: ' + sellTax);
    lines.push('• LP Burn          : ' + lpBurn);
    lines.push('• Top 10 Holder    : ' + top10Str);
    lines.push('');
  } else {
    lines.push('🔒 _Security: Data belum tersedia_');
    lines.push('');
  }

  lines.push('🔗 <https://gmgn.ai/' + chain + '/token/' + ca + '>');
  return lines.join('\n');
}

// ── TRENDING (openapi.gmgn.ai) ────────────────────────────
async function handleTrending(chain) {
  const data  = await openGet('/v1/market/rank', { chain, interval: '1h', limit: 10 });
  const inner = (data && data.data) ? data.data : data;
  const list  = inner.rank || inner || [];

  if (!list.length) return '❌ Tidak ada data trending untuk ' + chainBadge(chain) + '.';

  const lines = ['🔥 **Trending (1h) — ' + chainBadge(chain) + '**\n_(berdasarkan jumlah swap)_', ''];
  list.slice(0, 10).forEach((t, i) => {
    const name   = t.name   || t.symbol || '?';
    const sym    = (t.symbol && t.symbol !== t.name) ? ' (' + t.symbol + ')' : '';
    const ch     = t.price_change_percent1h != null ? fmtPct(t.price_change_percent1h) + ' (1h)'
                 : (t.price_change_percent  != null ? fmtPct(t.price_change_percent)   : '');
    const price  = fmtPrice(t.price);
    const mc     = t.market_cap ? ' | MC: $' + fmt(t.market_cap) : '';
    const swaps  = t.swaps ? ' | ' + fmt(t.swaps, 0) + ' swaps' : '';
    const bs     = (t.buys && t.sells) ? ' | ' + t.buys + '🟢 ' + t.sells + '🔴' : '';
    lines.push((i + 1) + '. **' + name + sym + '** ' + ch);
    lines.push('   ' + price + mc + swaps + bs);
    if (t.address) lines.push('   [GMGN](<https://gmgn.ai/' + chain + '/token/' + t.address + '>)');
  });
  return lines.join('\n');
}

// ── SMART MONEY (openapi.gmgn.ai) ────────────────────────
async function handleSmartMoney(chain, ca) {
  if (ca) {
    const data = await openGet('/v1/market/token_top_traders', {
      chain, address: ca, limit: 10, order_by: 'profit', direction: 'desc',
    });
    const list = (data && data.list) ? data.list : (Array.isArray(data) ? data : []);

    if (!list.length) return '🧠 **Smart Traders**\n`' + ca + '`\n\n_Tidak ada data smart traders._';

    const lines = ['🧠 **Smart Traders**', '`' + ca + '`', ''];
    list.slice(0, 10).forEach((t, i) => {
      const pnl    = t.profit != null
        ? (parseFloat(t.profit) >= 0 ? '+' : '') + '$' + fmt(Math.abs(t.profit))
        : 'N/A';
      const pnlPct = t.profit_change != null ? fmtPct(parseFloat(t.profit_change) * 100) : '';
      const tagArr = Array.isArray(t.tags) ? t.tags : [];
      const tagStr = tagArr.length ? ' 🏷️ ' + tagArr.slice(0, 3).join(', ') : '';
      const name   = t.name || shortAddr(t.address);
      lines.push('**' + (i + 1) + '.** ' + name + tagStr);
      lines.push('    PnL: ' + pnl + (pnlPct ? ' ' + pnlPct : ''));
      lines.push('');
    });
    return lines.join('\n');
  }

  // Tanpa CA: tampilkan trending token dengan filter smart buy terbanyak
  const data  = await openGet('/v1/market/rank', { chain, interval: '1h', limit: 10 });
  const inner = (data && data.data) ? data.data : data;
  const list  = inner.rank || inner || [];

  if (!list.length) return '💡 **Top Smart Money**\n_Data tidak tersedia untuk ' + chainBadge(chain) + '._';

  const lines = ['💡 **Top Smart Trades (1h) — ' + chainBadge(chain) + '**', ''];
  list.forEach((t, i) => {
    const name = t.name || t.symbol || '?';
    const ch   = t.price_change_percent1h != null ? fmtPct(t.price_change_percent1h) : '';
    const mc   = t.market_cap ? ' | MC: $' + fmt(t.market_cap) : '';
    lines.push((i + 1) + '. **' + name + '** ' + ch + mc);
    if (t.address) lines.push('   [GMGN](<https://gmgn.ai/' + chain + '/token/' + t.address + '>)');
  });
  return lines.join('\n');
}

// ── WALLET ANALYSIS (openapi.gmgn.ai) ────────────────────
async function handleWallet(chain, address) {
  const data = await openGet('/v1/user/wallet_stats', {
    chain, wallet_address: address, period: '7d',
  });

  if (!data) throw new Error('Wallet tidak ditemukan atau tidak ada aktivitas di ' + chainBadge(chain) + '.');

  const w = Array.isArray(data) ? data[0] : data;
  if (!w) throw new Error('Data wallet tidak tersedia di ' + chainBadge(chain) + '.');

  const pnl7d   = w.realized_profit != null
    ? (parseFloat(w.realized_profit) >= 0 ? '+' : '') + '$' + fmt(Math.abs(w.realized_profit))
    : 'N/A';
  const pnlPct  = w.realized_profit_pnl != null
    ? fmtPct(parseFloat(w.realized_profit_pnl) * 100) : 'N/A';
  const winRate = w.pnl_stat?.winrate != null
    ? (parseFloat(w.pnl_stat.winrate) * 100).toFixed(1) + '%' : 'N/A';
  const buy7d   = w.buy  ?? '?';
  const sell7d  = w.sell ?? '?';
  const nativeBal = w.native_balance && parseFloat(w.native_balance) > 0
    ? parseFloat(w.native_balance).toFixed(4) + (chain === 'sol' ? ' SOL' : chain === 'eth' || chain === 'base' ? ' ETH' : ' BNB')
    : null;

  // Tags dari common
  const tags    = w.common?.tags || [];
  const tagStr  = tags.length ? ' 🏷️ ' + tags.join(', ') : '';

  const lines = [
    '👛 **Analisis Wallet** — ' + chainBadge(chain),
    '`' + address + '`' + tagStr,
    '',
    '**📊 Statistik Trading (7 Hari)**',
    '• PnL 7d:    ' + pnl7d + (pnlPct !== 'N/A' ? ' (' + pnlPct + ')' : ''),
    '• Win Rate:  ' + winRate,
    '• Trades:    ' + buy7d + ' buy / ' + sell7d + ' sell',
  ];
  if (nativeBal) {
    lines.push('');
    lines.push('**💰 Saldo**');
    lines.push('• Native: ' + nativeBal);
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
      'gmgn <CA>                  — info token + security',
      'gmgn <chain> <CA>          — spesifik chain (eth/bsc/base)',
      'gmgn trending [chain]      — trending 1h',
      'gmgn smart <CA>            — top smart traders token',
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
