const crypto = require('crypto');

const BASE = 'https://openapi.gmgn.ai';
const DEMO_KEY = 'gmgn_solbscbaseethmonadtron';

function authParams() {
  return `timestamp=${Math.floor(Date.now() / 1000)}&client_id=${crypto.randomUUID()}`;
}

async function gmgnGet(path, query, apiKey) {
  const key = apiKey || process.env.GMGN_API_KEY || DEMO_KEY;
  const url = `${BASE}${path}?${query}&${authParams()}`;
  const res = await fetch(url, {
    headers: {
      'X-APIKEY': key,
      'Accept': 'application/json',
      'User-Agent': 'gmgn-cli/1.5.0',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(json.message || `code=${json.code}`);
  return json.data;
}

// Friendly number formatting
function fmt(n, decimals = 2) {
  if (n == null || n === '' || isNaN(Number(n))) return 'N/A';
  const v = Number(n);
  if (v >= 1e9)  return (v / 1e9).toFixed(decimals) + 'B';
  if (v >= 1e6)  return (v / 1e6).toFixed(decimals) + 'M';
  if (v >= 1e3)  return (v / 1e3).toFixed(decimals) + 'K';
  return v.toFixed(decimals);
}

function fmtPrice(p) {
  if (p == null || isNaN(Number(p))) return 'N/A';
  const v = Number(p);
  if (v === 0) return '$0';
  if (v < 0.000001) return '$' + v.toExponential(3);
  if (v < 0.01)     return '$' + v.toFixed(8);
  return '$' + v.toFixed(4);
}

function fmtPct(p) {
  if (p == null || isNaN(Number(p))) return 'N/A';
  const v = Number(p);
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

function yesNo(v) {
  if (v == null) return 'N/A';
  return v ? '✅ Ya' : '❌ Tidak';
}

function shortAddr(a) {
  if (!a || a.length < 12) return a || '?';
  return a.slice(0, 6) + '...' + a.slice(-4);
}

function gmgnLink(ca) {
  return `https://gmgn.ai/sol/token/${ca}`;
}

// =============================================================
// Command: gmgn <CA>  →  token info + security
// =============================================================
async function getTokenInfo(ca, apiKey) {
  const [info, sec] = await Promise.all([
    gmgnGet('/v1/token/info',     `chain=sol&address=${ca}`, apiKey),
    gmgnGet('/v1/token/security', `chain=sol&address=${ca}`, apiKey),
  ]);

  const price   = info.price   || {};
  const stat    = info.stat    || {};
  const tags    = info.wallet_tags_stat || {};
  const dev     = info.dev     || {};

  const priceNow   = fmtPrice(price.price);
  const mc         = fmt(price.usd_market_cap || (Number(price.price || 0) * Number(info.circulating_supply || 0)));
  const liq        = '$' + fmt(info.liquidity);
  const vol1h      = '$' + fmt(price.volume_1h);
  const vol24h     = '$' + fmt(price.volume_24h);
  const ch1h       = fmtPct(price.price_change_percent1h);
  const ch24h      = fmtPct(price.price_change_percent24h);
  const holders    = fmt(info.holder_count, 0);
  const swaps1h    = fmt(price.swaps_1h, 0);
  const buys1h     = fmt(price.buys_1h, 0);
  const sells1h    = fmt(price.sells_1h, 0);
  const top10      = sec.top_10_holder_rate != null ? (Number(sec.top_10_holder_rate) * 100).toFixed(1) + '%' : 'N/A';
  const burnStatus = sec.burn_status === 'burn' ? '🔥 Burned' : 'Tidak';
  const athMc      = info.ath_price ? fmtPrice(info.ath_price) : 'N/A';
  const launchpad  = info.launchpad_platform || info.launchpad || 'Unknown';

  const smartW   = tags.smart_wallets    ?? 0;
  const renownedW = tags.renowned_wallets ?? 0;
  const freshW   = tags.fresh_wallets    ?? 0;

  const mintOk   = yesNo(sec.renounced_mint);
  const freezeOk = yesNo(sec.renounced_freeze_account);
  const honeypot = yesNo(!sec.honeypot);
  const buyTax   = sec.buy_tax  != null ? (Number(sec.buy_tax)  * 100).toFixed(1) + '%' : 'N/A';
  const sellTax  = sec.sell_tax != null ? (Number(sec.sell_tax) * 100).toFixed(1) + '%' : 'N/A';

  return [
    `🔍 **${info.name || info.symbol}** (\`${info.symbol}\`) — Solana`,
    `📄 \`${ca}\``,
    `🚀 ${launchpad}`,
    ``,
    `📊 **Market**`,
    `• Harga       : ${priceNow}`,
    `• Market Cap  : $${mc}`,
    `• ATH Price   : ${athMc}`,
    `• Likuiditas  : ${liq}`,
    `• Holders     : ${holders}`,
    ``,
    `📈 **Pergerakan**`,
    `• 1h  : ${ch1h}   │   Volume 1h  : ${vol1h}`,
    `• 24h : ${ch24h}  │   Volume 24h : ${vol24h}`,
    `• Swap 1h : ${swaps1h}  (${buys1h} beli / ${sells1h} jual)`,
    ``,
    `🔒 **Security**`,
    `• Mint Renounced   : ${mintOk}`,
    `• Freeze Renounced : ${freezeOk}`,
    `• Honeypot         : ${honeypot}`,
    `• Buy Tax          : ${buyTax}   │  Sell Tax : ${sellTax}`,
    `• LP Burn          : ${burnStatus}`,
    `• Top 10 Holder    : ${top10}`,
    ``,
    `👛 **Smart Money**`,
    `• Smart Wallets   : ${smartW}`,
    `• Renowned        : ${renownedW}`,
    `• Fresh Wallets   : ${freshW}`,
    ``,
    `🔗 <${gmgnLink(ca)}>`,
  ].join('\n');
}

// =============================================================
// Command: gmgn trending <chain>
// =============================================================
async function getTrending(chain = 'sol', apiKey) {
  const data = await gmgnGet('/v1/market/rank', `chain=${chain}&interval=1h&limit=10`, apiKey);
  // Trending response has double-nested: data.data.rank
  const inner = (data && data.data) ? data.data : data;
  const rank  = inner.rank || inner || [];

  if (!rank.length) return '⚠️ Tidak ada data trending saat ini.';

  const chainLabel = chain.toUpperCase();
  const lines = [`🔥 **Trending ${chainLabel} (1 Jam Terakhir)**\n`];
  rank.slice(0, 10).forEach((t, i) => {
    const pct = fmtPct(t.price_change_percent1h || t.price_change_percent);
    const mc  = '$' + fmt(t.market_cap);
    const vol = '$' + fmt(t.volume);
    lines.push(`**${i + 1}.** ${t.name || t.symbol} (\`${t.symbol}\`) ${pct}`);
    lines.push(`    MC: ${mc} │ Vol: ${vol} │ Swap: ${fmt(t.swaps, 0)}`);
    lines.push(`    \`${t.address}\``);
    lines.push('');
  });
  return lines.join('\n');
}

// =============================================================
// Command: gmgn new <chain>   →  recently created tokens
// =============================================================
async function getNewTokens(chain = 'sol', apiKey) {
  // Use market/rank sorted by creation time with short window
  const data = await gmgnGet(
    '/v1/market/rank',
    `chain=${chain}&interval=1h&order_by=open_timestamp&direction=desc&limit=10`,
    apiKey
  );
  const inner = (data && data.data) ? data.data : data;
  const rank  = inner.rank || inner || [];

  if (!rank.length) return '⚠️ Tidak ada data token baru saat ini.';

  const chainLabel = chain.toUpperCase();
  const lines = [`🆕 **Token Baru ${chainLabel}**\n`];
  rank.slice(0, 10).forEach((t, i) => {
    const age = t.open_timestamp
      ? Math.floor((Date.now() / 1000 - t.open_timestamp) / 60) + 'm lalu'
      : '?';
    const mc  = '$' + fmt(t.market_cap);
    const liq = '$' + fmt(t.liquidity);
    lines.push(`**${i + 1}.** ${t.name || t.symbol} (\`${t.symbol}\`) — ${age}`);
    lines.push(`    MC: ${mc} │ Liq: ${liq} │ ${t.launchpad_platform || t.launchpad || ''}`);
    lines.push(`    \`${t.address}\``);
    lines.push('');
  });
  return lines.join('\n');
}

// =============================================================
// Command: gmgn holders <CA>
// =============================================================
async function getTopHolders(ca, apiKey) {
  const data = await gmgnGet(
    '/v1/market/token_top_holders',
    `chain=sol&address=${ca}&limit=10&order_by=amount_percentage&direction=desc`,
    apiKey
  );
  const list = data.list || [];

  if (!list.length) return '⚠️ Tidak ada data holders.';

  const lines = [`👥 **Top Holders**\n\`${ca}\`\n`];
  list.forEach((h, i) => {
    const pct     = h.amount_percentage != null ? (Number(h.amount_percentage) * 100).toFixed(2) + '%' : 'N/A';
    const usd     = '$' + fmt(h.usd_value);
    const pnl     = h.profit != null ? (Number(h.profit) >= 0 ? '+' : '') + '$' + fmt(Math.abs(h.profit)) : 'N/A';
    const tagArr  = Array.isArray(h.tags) ? h.tags : [];
    const tagStr  = tagArr.length ? ` 🏷️ ${tagArr.slice(0, 2).join(', ')}` : '';
    const name    = h.name || shortAddr(h.address);
    lines.push(`**${i + 1}.** ${name}${tagStr}`);
    lines.push(`    Pegang: ${pct} (${usd}) │ PnL: ${pnl}`);
    lines.push('');
  });
  return lines.join('\n');
}

// =============================================================
// Command: gmgn smart <CA>   →  top traders (smart money)
// =============================================================
async function getSmartTraders(ca, apiKey) {
  const data = await gmgnGet(
    '/v1/market/token_top_traders',
    `chain=sol&address=${ca}&limit=10&order_by=profit&direction=desc`,
    apiKey
  );
  const list = data.list || data || [];

  if (!list.length) return '⚠️ Tidak ada data smart traders.';

  const lines = [`🧠 **Smart Traders**\n\`${ca}\`\n`];
  list.slice(0, 10).forEach((t, i) => {
    const pnl    = t.profit != null ? (Number(t.profit) >= 0 ? '+' : '') + '$' + fmt(Math.abs(t.profit)) : 'N/A';
    const pnlPct = t.profit_change != null ? fmtPct(t.profit_change * 100) : '';
    const tagArr = Array.isArray(t.tags) ? t.tags : [];
    const tagStr = tagArr.length ? ` 🏷️ ${tagArr.slice(0, 2).join(', ')}` : '';
    const name   = t.name || shortAddr(t.address);
    lines.push(`**${i + 1}.** ${name}${tagStr}`);
    lines.push(`    PnL: ${pnl} ${pnlPct}`);
    lines.push('');
  });
  return lines.join('\n');
}

// =============================================================
// Command: gmgn wallet <ADDR>
// =============================================================
async function getWalletStats(addr, apiKey) {
  const data = await gmgnGet(
    '/v1/user/wallet_stats',
    `chain=sol&wallet_address=${addr}&period=7d`,
    apiKey
  );
  // wallet_stats may return array or object
  const w = Array.isArray(data) ? data[0] : data;

  if (!w) return '⚠️ Tidak ada data wallet.';

  const pnl7d    = w.pnl_7d     != null ? (Number(w.pnl_7d) >= 0 ? '+' : '') + '$' + fmt(Math.abs(w.pnl_7d))         : 'N/A';
  const pnlPct   = w.pnl_7d_percent != null ? fmtPct(w.pnl_7d_percent * 100) : 'N/A';
  const winRate  = w.winrate    != null ? (Number(w.winrate) * 100).toFixed(1) + '%' : 'N/A';
  const txCount  = w.buy_tx_count_7d != null ? `${fmt(w.buy_tx_count_7d, 0)} beli / ${fmt(w.sell_tx_count_7d, 0)} jual` : 'N/A';
  const vol7d    = w.volume_7d   != null ? '$' + fmt(w.volume_7d) : 'N/A';

  return [
    `💼 **Wallet Stats (7 Hari)**`,
    `📍 \`${addr}\``,
    ``,
    `• PnL 7d     : ${pnl7d} (${pnlPct})`,
    `• Win Rate   : ${winRate}`,
    `• Volume 7d  : ${vol7d}`,
    `• Transaksi  : ${txCount}`,
    ``,
    `🔗 https://gmgn.ai/sol/address/${addr}`,
  ].join('\n');
}

module.exports = {
  getTokenInfo,
  getTrending,
  getNewTokens,
  getTopHolders,
  getSmartTraders,
  getWalletStats,
};
