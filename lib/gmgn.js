// lib/gmgn.js — v5 (analisis token lengkap: dev, smart money, semua timeframe)
// Semua endpoint pakai openapi.gmgn.ai (X-APIKEY), tanpa gmgn.ai Cloudflare.

const https  = require('https');
const zlib   = require('zlib');
const crypto = require('crypto');

const OPENAPI_HOST = 'openapi.gmgn.ai';
const DEX_HOST     = 'api.dexscreener.com';
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
  const raw1 = parts[1] || '', sub = raw1.toLowerCase();
  const raw2 = parts[2] || '', sub2 = raw2.toLowerCase();

  if (isAddr(raw1))          return { type: 'token',    chain: guessChain(raw1), address: raw1 };
  const c1 = resolveChain(sub);
  if (c1 && isAddr(raw2))    return { type: 'token',    chain: c1,               address: raw2 };
  if (sub === 'trending' || sub === 'trend')
                             return { type: 'trending', chain: resolveChain(sub2) || 'sol' };
  if (sub === 'smart') {
    if (isAddr(raw2))        return { type: 'smart',    chain: guessChain(raw2),  address: raw2 };
    return                          { type: 'smart',    chain: resolveChain(sub2) || 'sol', address: null };
  }
  if (sub === 'wallet' || sub === 'dompet') {
    if (isAddr(raw2))        return { type: 'wallet',   chain: guessChain(raw2),  address: raw2 };
    const cw = resolveChain(sub2), raw3 = parts[3] || '';
    if (cw && isAddr(raw3))  return { type: 'wallet',   chain: cw,                address: raw3 };
    return null;
  }
  if (c1 && !raw2)           return { type: 'trending', chain: c1 };
  return null;
}

// ── HTTP: openapi.gmgn.ai ─────────────────────────────────
function openGet(path, params) {
  const key = GMGN_API_KEY;
  if (!key) return Promise.reject(new Error(
    'GMGN_API_KEY belum di-set.\nTambahkan ke .env: GMGN_API_KEY=gmgn_2f8ac3ea53ccba6d62adb05e63d02a50'
  ));
  const qs = Object.entries({
    ...(params || {}),
    timestamp: Math.floor(Date.now() / 1000),
    client_id: crypto.randomUUID(),
  }).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: OPENAPI_HOST, path: path + '?' + qs, method: 'GET',
      headers: {
        'X-APIKEY': key, 'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'gmgn-cli/1.5.0',
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
        if (res.statusCode >= 400) return reject(new Error('GMGN API error HTTP ' + res.statusCode));
        try {
          const json = JSON.parse(body);
          if (json.code !== 0) return reject(new Error(json.message || 'code=' + json.code));
          resolve(json.data);
        } catch (_) { reject(new Error('JSON parse error')); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

// ── HTTP: DexScreener ─────────────────────────────────────
function dexGet(ca) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: DEX_HOST, path: '/latest/dex/tokens/' + ca, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate, br' },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      let stream = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
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
  if (num < 0.000001) return '$' + num.toExponential(4);
  if (num < 0.0001)   return '$' + num.toFixed(8);
  if (num < 0.01)     return '$' + num.toFixed(6);
  if (num < 1)        return '$' + num.toFixed(5);
  if (num < 1000)     return '$' + num.toFixed(4);
  return '$' + fmt(num);
}
function fmtPct(n) {
  if (n == null) return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num)) return 'N/A';
  return (num >= 0 ? '+' : '') + num.toFixed(2) + '%';
}
function pricePct(now, before) {
  if (!now || !before) return null;
  const b = parseFloat(before);
  if (!b) return null;
  return (parseFloat(now) - b) / b * 100;
}
function fmtAge(ts) {
  if (!ts) return 'N/A';
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 0)     return 'baru saja';
  if (s < 60)    return s + ' detik';
  if (s < 3600)  return Math.floor(s / 60) + ' menit';
  if (s < 86400) return Math.floor(s / 3600) + ' jam';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d + ' hari' + (h > 0 ? ' ' + h + 'j' : '');
}
function shortAddr(a) {
  if (!a || a.length <= 12) return a || 'N/A';
  return a.slice(0, isEvmAddr(a) ? 8 : 6) + '...' + a.slice(-4);
}
function chainBadge(chain) {
  const m = { sol: '🟣', eth: '🔷', bsc: '🟡', base: '🔵' };
  return (m[chain] || '⬜') + ' ' + (CHAIN_LABEL[chain] || chain.toUpperCase());
}
function pct100(n) {
  if (n == null) return null;
  const v = parseFloat(n) * 100;
  return isNaN(v) ? null : v.toFixed(1) + '%';
}
function risk(v) { return v ? '⚠️ ' + v : null; }

// ── TOKEN INFO (LENGKAP) ──────────────────────────────────
async function handleTokenInfo(chain, ca) {
  const dexChain = CHAIN_TO_DEX[chain] || chain;

  // Parallel: token info (sudah termasuk dev/stat/pool/link) + security + dex
  const [infoRes, secRes, dexRes] = await Promise.all([
    openGet('/v1/token/info', { chain, address: ca }),
    openGet('/v1/token/security', { chain, address: ca }).catch(() => null),
    dexGet(ca),
  ]);

  if (!infoRes && !dexRes) throw new Error('Token tidak ditemukan di ' + chainBadge(chain) + '.');

  const gi  = infoRes || {};
  const p   = gi.price || {};
  const dev = gi.dev   || {};
  const st  = gi.stat  || {};
  const wt  = gi.wallet_tags_stat || {};
  const lk  = gi.link  || {};
  const sec = secRes   || {};
  const pool = gi.pool  || {};

  // DexScreener pair
  let pair = null;
  if (dexRes && dexRes.pairs) {
    pair = dexRes.pairs
      .filter(x => x.chainId === dexChain)
      .sort((a, b) => (parseFloat(b.volume?.h24) || 0) - (parseFloat(a.volume?.h24) || 0))[0] || null;
  }

  // ── Identitas ────────────────────────────────────────────
  const name     = gi.name   || pair?.baseToken?.name   || 'Unknown';
  const symbol   = gi.symbol || pair?.baseToken?.symbol || '?';
  const platform = gi.launchpad_platform || gi.launchpad || (pair?.dexId ? pair.dexId.charAt(0).toUpperCase() + pair.dexId.slice(1) : '');
  const age      = gi.creation_timestamp ? fmtAge(gi.creation_timestamp) : 'N/A';

  // ── Harga & market ────────────────────────────────────────
  const curPrice  = p.price || pair?.priceUsd;
  const priceStr  = fmtPrice(curPrice);
  const mcRaw     = pair?.marketCap || null;
  const mc        = mcRaw ? '$' + fmt(mcRaw) : 'N/A';
  const athPrice  = gi.ath_price;
  const athStr    = athPrice ? fmtPrice(athPrice) : 'N/A';
  const athDropPct = (curPrice && athPrice)
    ? fmtPct((parseFloat(curPrice) - parseFloat(athPrice)) / parseFloat(athPrice) * 100)
    : null;

  // LP — pakai pool.liquidity jika ada, fallback gi.liquidity
  const liqNow  = parseFloat(pool.liquidity || gi.liquidity || 0);
  const liqInit = parseFloat(pool.initial_liquidity || 0);
  let liqStr    = liqNow > 0 ? '$' + fmt(liqNow) : 'N/A';
  if (liqInit > 0 && liqNow > 0) {
    const drain = (liqNow - liqInit) / liqInit * 100;
    liqStr += ' _(awal: $' + fmt(liqInit) + ', ' + fmtPct(drain) + ')_';
  }

  const holders = gi.holder_count ? gi.holder_count.toLocaleString() : 'N/A';

  // ── Pergerakan semua timeframe ────────────────────────────
  const ch5m  = pricePct(p.price, p.price_5m);
  const ch1h  = pricePct(p.price, p.price_1h);
  const ch6h  = pricePct(p.price, p.price_6h);
  const ch24h = pricePct(p.price, p.price_24h);

  const vol5m  = p.volume_5m  ? '$' + fmt(p.volume_5m)  : null;
  const vol1h  = p.volume_1h  ? '$' + fmt(p.volume_1h)  : (pair?.volume?.h1  ? '$' + fmt(pair.volume.h1)  : null);
  const vol6h  = p.volume_6h  ? '$' + fmt(p.volume_6h)  : null;
  const vol24h = p.volume_24h ? '$' + fmt(p.volume_24h) : (pair?.volume?.h24 ? '$' + fmt(pair.volume.h24) : null);

  // Swap — pakai swaps_Xh jika ada (lebih akurat dari buys+sells)
  function swapLine(swaps, buys, sells) {
    if (swaps == null && buys == null) return 'N/A';
    const total = swaps ?? (buys + sells);
    const detail = (buys != null && sells != null)
      ? ' (' + fmt(buys, 0) + '🟢 ' + fmt(sells, 0) + '🔴)' : '';
    return fmt(total, 0) + detail;
  }

  const swap5m  = swapLine(p.swaps_5m, p.buys_5m, p.sells_5m);
  const swap1h  = swapLine(p.swaps_1h, p.buys_1h, p.sells_1h);
  const swap6h  = p.swaps_6h != null ? fmt(p.swaps_6h, 0) : null;
  const swap24h = swapLine(p.swaps_24h, p.buys_24h, p.sells_24h);

  // ── Dev analysis ─────────────────────────────────────────
  const creatorAddr  = dev.creator_address || null;
  const creatorStatus = dev.creator_token_status === 'creator_close' ? '🚪 Sudah keluar'
    : dev.creator_token_balance && parseFloat(dev.creator_token_balance) > 0
      ? '🤝 Hold ' + fmt(parseFloat(dev.creator_token_balance), 0) + ' token'
      : dev.creator_token_status || 'N/A';
  const createdCount = st.creator_created_count || dev.twitter_create_token_count || null;
  const openCount    = dev.creator_open_count   ?? null;
  const twitterChanges = Array.isArray(dev.twitter_name_change_history) ? dev.twitter_name_change_history.length : 0;
  const deletedPosts = dev.twitter_del_post_token_count ?? null;
  const ctoFlag      = dev.cto_flag === 1;
  const devHoldRate  = pct100(st.dev_team_hold_rate);

  // ATH token dev sebelumnya
  const athToken = dev.ath_token_info;
  const devAthStr = athToken
    ? athToken.symbol + ' ($' + fmt(parseFloat(athToken.ath_mc || 0)) + ' MC)'
    : null;

  // Social links
  const twitterLink = lk.twitter_username ? 'https://x.com/' + lk.twitter_username.split('/')[0] : null;
  const websiteLink = lk.website || null;
  const tgLink      = lk.telegram || null;

  // ── Security ────────────────────────────────────────────
  const mintRenounced   = sec.renounced_mint           === true  ? '✅ Ya'
                        : sec.renounced_mint           === false ? '❌ Tidak' : 'N/A';
  const freezeRenounced = sec.renounced_freeze_account === true  ? '✅ Ya'
                        : sec.renounced_freeze_account === false ? '❌ Tidak' : 'N/A';
  const honeypot        = sec.honeypot === 1 ? '❌ Ada' : '✅ Tidak';
  const buyTax  = sec.buy_tax  != null ? parseFloat(sec.buy_tax ).toFixed(1) + '%' : '0.0%';
  const sellTax = sec.sell_tax != null ? parseFloat(sec.sell_tax).toFixed(1) + '%' : '0.0%';
  const canNotSell = sec.can_not_sell > 0 ? '⚠️ ' + sec.can_not_sell + ' wallet tidak bisa jual' : null;
  const secFlags = Array.isArray(sec.flags) && sec.flags.length > 0 ? sec.flags.join(', ') : null;
  const secAlert = sec.is_show_alert ? '⚠️ Ada peringatan keamanan' : null;

  // LP Burn
  let lpBurn = 'N/A';
  if (sec.burn_status === 'burn' || parseFloat(sec.burn_ratio || 0) >= 0.95) {
    lpBurn = '🔥 Burned';
  } else if (sec.burn_ratio != null && parseFloat(sec.burn_ratio) > 0) {
    lpBurn = (parseFloat(sec.burn_ratio) * 100).toFixed(1) + '% burned';
  } else if (sec.lock_summary?.is_locked) {
    const ld = sec.lock_summary.lock_detail?.[0];
    lpBurn = ld ? (parseFloat(ld.percent) * 100).toFixed(0) + '% locked' : '🔒 Locked';
  }

  const top10 = pct100(sec.top_10_holder_rate || st.top_10_holder_rate);

  // ── Smart Money ─────────────────────────────────────────
  const smartW    = wt.smart_wallets   ?? null;
  const renownedW = wt.renowned_wallets ?? null;
  const sniperW   = wt.sniper_wallets  ?? null;
  const freshW    = wt.fresh_wallets   ?? null;
  const bundlerW  = wt.bundler_wallets ?? null;
  const ratW      = wt.rat_trader_wallets ?? null;
  const hasSmartData = smartW != null || renownedW != null || sniperW != null;

  // Risk metrics
  const sniperHold    = pct100(st.top70_sniper_hold_rate);
  const botDegenRate  = pct100(st.bot_degen_rate);
  const bundlerRate   = pct100(st.top_bundler_trader_percentage);
  const entrapRate    = pct100(st.top_entrapment_trader_percentage);

  // ── BUILD OUTPUT ─────────────────────────────────────────
  const L = [];

  // Header
  L.push('🔍 **' + name + ' (' + symbol + ')** — ' + (CHAIN_LABEL[chain] || chain));
  L.push('📄 `' + ca + '`');
  const meta = [];
  if (platform) meta.push('🚀 ' + platform);
  meta.push('⏱️ Umur: ' + age);
  if (ctoFlag)  meta.push('🏳️ CTO');
  L.push(meta.join(' │ '));
  L.push('');

  // Social links
  const socials = [];
  if (twitterLink) socials.push('[Twitter](<' + twitterLink + '>)');
  if (websiteLink) socials.push('[Web](<' + websiteLink + '>)');
  if (tgLink)      socials.push('[Telegram](<' + tgLink + '>)');
  if (socials.length) L.push('🌐 ' + socials.join(' · '));

  // Market
  L.push('');
  L.push('📊 **Market**');
  L.push('• Harga      : ' + priceStr);
  L.push('• Market Cap : ' + mc);
  if (athStr !== 'N/A') {
    L.push('• ATH Price  : ' + athStr + (athDropPct ? ' _(' + athDropPct + ' dari ATH)_' : ''));
  }
  L.push('• Likuiditas : ' + liqStr);
  L.push('• Holders    : ' + holders);
  L.push('');

  // Pergerakan
  L.push('📈 **Pergerakan**');
  function mkRow(label, chPct, vol, swap) {
    const pStr  = chPct != null ? fmtPct(chPct) : 'N/A';
    const vStr  = vol   ? ' │ Vol: ' + vol : '';
    const swStr = swap && swap !== 'N/A' ? ' │ ' + swap + ' swap' : '';
    return '• ' + label + ': ' + pStr + vStr + swStr;
  }
  if (vol5m || ch5m != null) L.push(mkRow('5m ', ch5m, vol5m, swap5m));
  L.push(mkRow('1h ', ch1h, vol1h, swap1h));
  if (vol6h || ch6h != null) L.push(mkRow('6h ', ch6h, vol6h, swap6h));
  L.push(mkRow('24h', ch24h, vol24h, swap24h));
  L.push('');

  // Developer
  if (creatorAddr) {
    L.push('👨‍💻 **Developer**');
    L.push('• Wallet  : `' + shortAddr(creatorAddr) + '` → ' + creatorStatus);
    const devStats = [];
    if (createdCount != null) devStats.push('buat ' + createdCount + ' token');
    if (openCount    != null) devStats.push('buka ' + openCount + '× di token ini');
    if (devStats.length) L.push('• Histori : ' + devStats.join(', '));
    const devRisks = [];
    if (twitterChanges > 0) devRisks.push('⚠️ ganti nama Twitter ' + twitterChanges + '×');
    if (deletedPosts > 0)   devRisks.push('⚠️ hapus ' + deletedPosts + ' post');
    if (devRisks.length)    L.push('• Twitter : ' + devRisks.join(' · '));
    if (devHoldRate)        L.push('• Dev hold: ' + devHoldRate);
    if (devAthStr)          L.push('• ATH token dev: ' + devAthStr);
    L.push('');
  }

  // Security
  if (Object.keys(sec).length > 0) {
    L.push('🔒 **Security**');
    L.push('• Mint Renounced   : ' + mintRenounced);
    L.push('• Freeze Renounced : ' + freezeRenounced);
    L.push('• Honeypot         : ' + honeypot);
    L.push('• Buy Tax: ' + buyTax + '   │ Sell Tax: ' + sellTax);
    L.push('• LP Burn          : ' + lpBurn);
    if (top10) L.push('• Top 10 Holder    : ' + top10);
    if (canNotSell) L.push('• ' + canNotSell);
    if (secAlert)   L.push('• ' + secAlert);
    if (secFlags)   L.push('• Flags: ' + secFlags);
    L.push('');
  }

  // Smart Money & Wallet Tags
  if (hasSmartData) {
    L.push('💰 **Smart Money**');
    if (smartW    != null) L.push('• Smart Wallets  : ' + smartW);
    if (renownedW != null) L.push('• Renowned       : ' + renownedW);
    if (sniperW   != null) L.push('• Sniper         : ' + sniperW);
    if (freshW    != null) L.push('• Fresh Wallet   : ' + freshW);
    if (bundlerW  != null) L.push('• Bundler        : ' + bundlerW);
    if (ratW      != null && ratW > 0) L.push('• Rat Trader     : ' + ratW);
    L.push('');
  }

  // Risk metrics
  const riskLines = [];
  if (sniperHold)   riskLines.push('• Sniper hold : ' + sniperHold);
  if (botDegenRate) riskLines.push('• Bot/Degen   : ' + botDegenRate);
  if (bundlerRate)  riskLines.push('• Bundler %   : ' + bundlerRate);
  if (entrapRate && parseFloat(entrapRate) > 0) riskLines.push('• Entrapment  : ' + entrapRate);
  if (riskLines.length) {
    L.push('⚠️ **Risk Metrics**');
    riskLines.forEach(r => L.push(r));
    L.push('');
  }

  L.push('🔗 <https://gmgn.ai/' + chain + '/token/' + ca + '>');
  return L.join('\n');
}

// ── TRENDING ─────────────────────────────────────────────
async function handleTrending(chain) {
  const data  = await openGet('/v1/market/rank', { chain, interval: '1h', limit: 10 });
  const inner = (data && data.data) ? data.data : data;
  const list  = inner.rank || inner || [];
  if (!list.length) return '❌ Tidak ada data trending untuk ' + chainBadge(chain) + '.';

  const L = ['🔥 **Trending (1h) — ' + chainBadge(chain) + '**\n_(berdasarkan jumlah swap)_', ''];
  list.slice(0, 10).forEach((t, i) => {
    const name  = t.name || t.symbol || '?';
    const sym   = (t.symbol && t.symbol !== t.name) ? ' (' + t.symbol + ')' : '';
    const ch    = t.price_change_percent1h != null ? fmtPct(t.price_change_percent1h) + ' (1h)'
                : (t.price_change_percent != null  ? fmtPct(t.price_change_percent)   : '');
    const price = fmtPrice(t.price);
    const mc    = t.market_cap ? ' | MC: $' + fmt(t.market_cap) : '';
    const swaps = t.swaps ? ' | ' + fmt(t.swaps, 0) + ' swaps' : '';
    const bs    = (t.buys && t.sells) ? ' | ' + t.buys + '🟢 ' + t.sells + '🔴' : '';
    L.push((i + 1) + '. **' + name + sym + '** ' + ch);
    L.push('   ' + price + mc + swaps + bs);
    if (t.address) L.push('   [GMGN](<https://gmgn.ai/' + chain + '/token/' + t.address + '>)');
  });
  return L.join('\n');
}

// ── SMART MONEY ──────────────────────────────────────────
async function handleSmartMoney(chain, ca) {
  if (ca) {
    const data = await openGet('/v1/market/token_top_traders', {
      chain, address: ca, limit: 10, order_by: 'profit', direction: 'desc',
    });
    const list = (data && data.list) ? data.list : (Array.isArray(data) ? data : []);
    if (!list.length) return '🧠 **Smart Traders**\n`' + ca + '`\n\n_Tidak ada data._';

    const L = ['🧠 **Smart Traders**', '`' + ca + '`', ''];
    list.slice(0, 10).forEach((t, i) => {
      const pnl    = t.profit != null
        ? (parseFloat(t.profit) >= 0 ? '+' : '') + '$' + fmt(Math.abs(t.profit)) : 'N/A';
      const pnlPct = t.profit_change != null ? fmtPct(parseFloat(t.profit_change) * 100) : '';
      const tags   = (Array.isArray(t.tags) && t.tags.length) ? ' 🏷️ ' + t.tags.slice(0, 3).join(', ') : '';
      const name   = t.name || shortAddr(t.address);
      L.push('**' + (i + 1) + '.** ' + name + tags);
      L.push('    PnL: ' + pnl + (pnlPct ? ' ' + pnlPct : ''));
      L.push('');
    });
    return L.join('\n');
  }

  // Tanpa CA — trending token
  const data  = await openGet('/v1/market/rank', { chain, interval: '1h', limit: 10 });
  const inner = (data && data.data) ? data.data : data;
  const list  = inner.rank || inner || [];
  if (!list.length) return '💡 **Top Smart Money**\n_Data tidak tersedia._';

  const L = ['💡 **Top Smart Trades (1h) — ' + chainBadge(chain) + '**', ''];
  list.forEach((t, i) => {
    const name = t.name || t.symbol || '?';
    const ch   = t.price_change_percent1h != null ? fmtPct(t.price_change_percent1h) : '';
    const mc   = t.market_cap ? ' | MC: $' + fmt(t.market_cap) : '';
    L.push((i + 1) + '. **' + name + '** ' + ch + mc);
    if (t.address) L.push('   [GMGN](<https://gmgn.ai/' + chain + '/token/' + t.address + '>)');
  });
  return L.join('\n');
}

// ── WALLET ────────────────────────────────────────────────
async function handleWallet(chain, address) {
  const data = await openGet('/v1/user/wallet_stats', { chain, wallet_address: address, period: '7d' });
  const w    = Array.isArray(data) ? data[0] : data;
  if (!w) throw new Error('Data wallet tidak tersedia di ' + chainBadge(chain) + '.');

  const pnl7d  = w.realized_profit != null
    ? (parseFloat(w.realized_profit) >= 0 ? '+' : '') + '$' + fmt(Math.abs(w.realized_profit)) : 'N/A';
  const pnlPct = w.realized_profit_pnl != null
    ? fmtPct(parseFloat(w.realized_profit_pnl) * 100) : 'N/A';
  const winRate = w.pnl_stat?.winrate != null
    ? (parseFloat(w.pnl_stat.winrate) * 100).toFixed(1) + '%' : 'N/A';
  const buy7d  = w.buy  ?? '?';
  const sell7d = w.sell ?? '?';
  const nativeBal = w.native_balance && parseFloat(w.native_balance) > 0
    ? parseFloat(w.native_balance).toFixed(4) + (chain === 'sol' ? ' SOL' : chain === 'eth' || chain === 'base' ? ' ETH' : ' BNB')
    : null;
  const tags   = (w.common?.tags || []);
  const tagStr = tags.length ? ' 🏷️ ' + tags.join(', ') : '';

  const L = [
    '👛 **Analisis Wallet** — ' + chainBadge(chain),
    '`' + address + '`' + tagStr, '',
    '**📊 Statistik Trading (7 Hari)**',
    '• PnL 7d   : ' + pnl7d + (pnlPct !== 'N/A' ? ' (' + pnlPct + ')' : ''),
    '• Win Rate : ' + winRate,
    '• Trades   : ' + buy7d + ' buy / ' + sell7d + ' sell',
  ];
  if (nativeBal) {
    L.push(''); L.push('**💰 Saldo**'); L.push('• Native: ' + nativeBal);
  }
  L.push(''); L.push('🔗 [GMGN Wallet](<https://gmgn.ai/' + chain + '/address/' + address + '>)');
  return L.join('\n');
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
    return ['❌ Command tidak dikenal. Tersedia:','```',
      'gmgn <CA>                  — analisis token lengkap',
      'gmgn <chain> <CA>          — eth/bsc/base',
      'gmgn trending [chain]      — trending 1h',
      'gmgn smart <CA>            — top smart traders',
      'gmgn wallet [chain] <addr> — analisis wallet',
      '', 'Chain: sol  eth  bsc  base','```'].join('\n');
  } catch (err) {
    throw new Error(err?.message || 'Error tidak diketahui');
  }
}

module.exports = { detectGmgnQuery, handleGmgnCommand };
