// lib/gmgn.js
// GMGN.ai API integration — 6 commands: token, smart, new, trending, wallet, holder.
// API key opsional (set GMGN_API_KEY di env Railway).
// Endpoint publik pakai browser headers (Referer wajib, tanpa itu dapat 403).

const axios = require('axios');

const GMGN_KEY = () => process.env.GMGN_API_KEY || '';
const BASE = 'https://gmgn.ai';
const TIMEOUT = 15000;

// ─── Browser-like headers (wajib ada Referer untuk bypass Cloudflare) ─────────
function makeHeaders(referer) {
  const h = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://gmgn.ai',
    'Referer': referer || 'https://gmgn.ai/',
  };
  return h;
}

// Tambah API key ke params jika tersedia
function withKey(params) {
  const k = GMGN_KEY();
  return k ? { token: k, ...params } : params;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function gmgnGet(path, params = {}, referer) {
  const { data } = await axios.get(BASE + path, {
    params: withKey(params),
    headers: makeHeaders(referer),
    timeout: TIMEOUT,
  });
  const code = data?.code;
  if (code !== undefined && code !== 0 && code !== 200) {
    throw new Error(data?.msg || `GMGN error code ${code}`);
  }
  return data?.data ?? data;
}

// ─── Address & chain helpers ──────────────────────────────────────────────────
function isSolAddr(a) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a); }
function isEvmAddr(a) { return /^0x[0-9a-fA-F]{40}$/.test(a); }

function detectChain(text) {
  const t = text.toLowerCase();
  if (/\bsol(ana)?\b/.test(t)) return 'sol';
  if (/\bbase\b/.test(t))       return 'base';
  if (/\bbsc\b|\bbnb\b/.test(t)) return 'bsc';
  if (/\barb(itrum)?\b/.test(t)) return 'arb';
  if (/\bblast\b/.test(t))      return 'blast';
  if (/\beth(ereum)?\b/.test(t)) return 'eth';
  return null;
}

function guessChain(addr) {
  if (!addr) return 'sol';
  if (isSolAddr(addr) && !isEvmAddr(addr)) return 'sol';
  return 'base';
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function fmt$(n) {
  if (n == null || n === '' || isNaN(parseFloat(n))) return 'N/A';
  const v = parseFloat(n);
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  if (v < 0.01) return '$' + v.toExponential(2);
  return '$' + v.toFixed(4);
}
function fmtPct(n) {
  if (n == null || isNaN(parseFloat(n))) return 'N/A';
  const v = parseFloat(n);
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}
function fmtAge(ts) {
  if (!ts) return '?';
  const mins = Math.floor((Date.now() / 1000 - ts) / 60);
  if (mins < 60) return `${mins}m lalu`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}j lalu`;
  return `${Math.floor(hrs / 24)}h lalu`;
}
function short(addr) {
  if (!addr) return '—';
  return addr.length > 12 ? addr.slice(0, 6) + '…' + addr.slice(-4) : addr;
}
function flag(val) {
  // val bisa 0/1/true/false/"1"/"0"
  const v = val === true || val === 1 || val === '1';
  return v;
}

// ─── Fetch trending rank (semua timeframe) ────────────────────────────────────
async function fetchRank(chain, period = '1h', limit = 50, extra = {}) {
  const data = await gmgnGet(
    `/defi/quotation/v1/rank/${chain}/swaps/${period}`,
    { orderby: 'swaps', direction: 'desc', limit, ...extra },
    'https://gmgn.ai/'
  );
  return Array.isArray(data?.rank) ? data.rank : [];
}

// Cari token CA di berbagai timeframe trending
async function findTokenInRank(ca, chain) {
  const lower = ca.toLowerCase();
  for (const period of ['1h', '6h', '24h']) {
    const rank = await fetchRank(chain, period, 100).catch(() => []);
    const found = rank.find(t => (t.address || '').toLowerCase() === lower);
    if (found) return { token: found, period };
  }
  return null;
}

// ─── 1. gmgn <CA> — token info & security ────────────────────────────────────
async function getTokenInfo(ca, chain) {
  const c = chain || guessChain(ca);
  const result = await findTokenInRank(ca, c);

  if (!result) {
    const link = c === 'sol'
      ? `https://gmgn.ai/sol/token/${ca}`
      : `https://gmgn.ai/${c}/token/${ca}`;
    return [
      `⚠️ Token **${short(ca)}** tidak ditemukan di trending GMGN (1h/6h/24h).`,
      `Token mungkin tidak aktif atau belum ada data GMGN.`,
      `🔗 [Cek manual di GMGN](${link})`,
    ].join('\n');
  }

  const t = result.token;
  const sym  = t.symbol || '?';
  const name = t.name   || '?';
  const link = c === 'sol'
    ? `https://gmgn.ai/sol/token/${ca}`
    : `https://gmgn.ai/${c}/token/${ca}`;

  // Security flags (Solana style: renounced_mint + renounced_freeze_account)
  const honeypot   = flag(t.is_honeypot);
  const renounced  = flag(t.is_renounced) || (flag(t.renounced_mint) && flag(t.renounced_freeze_account));
  const openSrc    = flag(t.is_open_source);
  const mintRen    = flag(t.renounced_mint);
  const freezeRen  = flag(t.renounced_freeze_account);
  const buyTax     = (t.buy_tax  && t.buy_tax  !== '') ? t.buy_tax  + '%' : 'N/A';
  const sellTax    = (t.sell_tax && t.sell_tax !== '') ? t.sell_tax + '%' : 'N/A';
  const launchpad  = t.launchpad_platform || t.launchpad || '—';

  // Risk signals
  const snipers  = t.sniper_count    ?? 'N/A';
  const smartDgn = t.smart_degen_count ?? 'N/A';
  const bundlers = t.bundler_rate != null ? (parseFloat(t.bundler_rate) * 100).toFixed(1) + '%' : 'N/A';
  const rugRatio = t.rug_ratio    != null ? (parseFloat(t.rug_ratio)    * 100).toFixed(1) + '%' : 'N/A';
  const top10    = t.top_10_holder_rate != null ? (parseFloat(t.top_10_holder_rate) * 100).toFixed(1) + '%' : 'N/A';

  const lines = [
    `**🔍 ${name} (${sym})** — found in ${result.period} trending`,
    `\`${ca}\` | ${c.toUpperCase()} | ${launchpad}`,
    '',
    '**📊 Market**',
    `• Harga       : ${fmt$(t.price)}  ${fmtPct(t.price_change_percent1h)} (1h)`,
    `• Market Cap  : ${fmt$(t.market_cap)}`,
    `• Likuiditas  : ${fmt$(t.liquidity)}`,
    `• Volume 1h   : ${fmt$(t.volume)}`,
    `• Holders     : ${t.holder_count ?? 'N/A'}`,
    `• Umur token  : ${fmtAge(t.open_timestamp)}`,
    '',
    '**🔒 Security**',
    `• Honeypot          : ${honeypot ? '🚨 YA' : '✅ Tidak'}`,
    `• Renounced         : ${renounced ? '✅ Ya' : '⚠️ Tidak'}`,
    `• Open Source       : ${openSrc ? '✅ Ya' : '⚠️ Tidak'}`,
    ...(c === 'sol' ? [
      `• Mint Renounced    : ${mintRen ? '✅ Ya' : '⚠️ Tidak'}`,
      `• Freeze Renounced  : ${freezeRen ? '✅ Ya' : '⚠️ Tidak'}`,
    ] : []),
    `• Buy Tax           : ${buyTax}`,
    `• Sell Tax          : ${sellTax}`,
    '',
    '**⚠️ Risk Signals**',
    `• Sniper Count    : ${snipers}`,
    `• Smart Degen     : ${smartDgn}`,
    `• Bundler Rate    : ${bundlers}`,
    `• Rug Ratio       : ${rugRatio}`,
    `• Top 10 Holders  : ${top10}`,
    `• Buys/Sells (1h) : ${t.buys ?? '?'}/${t.sells ?? '?'}`,
    '',
    `🔗 [GMGN](${link})`,
    '_NFA. DYOR._',
  ];

  return lines.join('\n');
}

// ─── 2. gmgn smart [CA] — smart money ────────────────────────────────────────
async function getSmartMoney(ca, chain) {
  const c = chain || guessChain(ca);
  const k = GMGN_KEY();

  if (!ca) {
    // Tampilkan token yang banyak dibeli smart money dari trending data
    const rank = await fetchRank(c, '1h', 30);
    if (!rank.length) return `⚠️ Tidak ada data trending ${c.toUpperCase()} saat ini.`;
    // Sort by smart_degen_count
    const sorted = rank.filter(t => (t.smart_degen_count ?? 0) > 0)
      .sort((a, b) => (b.smart_degen_count ?? 0) - (a.smart_degen_count ?? 0))
      .slice(0, 10);
    if (!sorted.length) return `⚠️ Tidak ada smart money activity di ${c.toUpperCase()} saat ini.`;

    const lines = [`**🧠 Smart Money Activity (${c.toUpperCase()}, 1h)**`, ''];
    sorted.forEach((t, i) => {
      lines.push(`**${i + 1}. ${t.symbol || '?'}** — Smart: ${t.smart_degen_count} wallet`);
      lines.push(`   ${fmt$(t.price)}  ${fmtPct(t.price_change_percent1h)} (1h)  MCap: ${fmt$(t.market_cap)}`);
      lines.push(`   \`${short(t.address)}\``);
    });
    return lines.join('\n');
  }

  // Dengan CA: top traders smart money dari token spesifik
  if (!k) {
    return [
      `⚠️ **GMGN_API_KEY dibutuhkan** untuk data smart trader per token.`,
      `Set \`GMGN_API_KEY\` di Railway env terlebih dahulu.`,
      '',
      `Alternatif: gunakan \`gmgn smart\` (tanpa CA) untuk melihat token aktif smart money.`,
    ].join('\n');
  }

  const data = await gmgnGet(
    `/defi/quotation/v1/tokens/top_traders/${c}/${ca}`,
    { tag: 'smart_money', size: 10, orderby: 'profit', direction: 'desc' },
    `https://gmgn.ai/${c}/token/${ca}`
  );
  const traders = Array.isArray(data?.items) ? data.items
    : Array.isArray(data?.traders) ? data.traders
    : Array.isArray(data) ? data : [];

  if (!traders.length) return `⚠️ Tidak ada smart trader ditemukan untuk token ini.`;

  const lines = [`**🧠 Smart Traders — ${short(ca)} (${c.toUpperCase()})**`, ''];
  traders.slice(0, 10).forEach((t, i) => {
    const addr   = t.address || t.wallet_address || '?';
    const profit = fmt$(t.profit ?? t.realized_profit);
    const tags   = Array.isArray(t.tags) ? t.tags.join(', ') : '';
    lines.push(`**${i + 1}.** \`${short(addr)}\`${tags ? ' [' + tags + ']' : ''}`);
    lines.push(`   Profit: ${profit}  Beli: ${fmt$(t.bought_amount_cur)}  Jual: ${fmt$(t.sold_amount_cur)}`);
  });
  return lines.join('\n');
}

// ─── 3. gmgn new [chain] — new token launches ────────────────────────────────
async function getNewTokens(chain) {
  const c = chain || 'sol';
  const data = await gmgnGet(
    `/defi/quotation/v1/rank/${c}/new_pairs/1h`,
    { limit: 20, orderby: 'open_timestamp', direction: 'desc', min_liquidity: 1000 },
    'https://gmgn.ai/'
  );
  const tokens = Array.isArray(data?.rank) ? data.rank : (Array.isArray(data) ? data : []);
  if (!tokens.length) {
    // Fallback: gunakan trending tapi filter hanya token baru (< 2 jam)
    const rank = await fetchRank(c, '1h', 50).catch(() => []);
    const fresh = rank.filter(t => t.open_timestamp && (Date.now() / 1000 - t.open_timestamp) < 7200)
      .sort((a, b) => b.open_timestamp - a.open_timestamp)
      .slice(0, 15);
    if (!fresh.length) return `⚠️ Tidak ada token baru di ${c.toUpperCase()} saat ini.`;
    const lines = [`**🆕 Token Baru < 2 jam (${c.toUpperCase()})**`, ''];
    fresh.forEach((t, i) => {
      const sym  = t.symbol || '?';
      const age  = fmtAge(t.open_timestamp);
      const mcap = fmt$(t.market_cap);
      const liq  = fmt$(t.liquidity);
      const mint = flag(t.renounced_mint)   ? '✅ Mint' : '⚠️ Mint';
      const frz  = flag(t.renounced_freeze_account) ? '✅ Freeze' : '⚠️ Freeze';
      lines.push(`**${i + 1}. ${sym}** — ${age}  MCap: ${mcap}  Liq: ${liq}`);
      lines.push(`   ${c === 'sol' ? mint + '  ' + frz + '  ' : ''}Sniper: ${t.sniper_count ?? '?'}  \`${short(t.address)}\``);
    });
    return lines.join('\n');
  }

  const lines = [`**🆕 New Token Launches (${c.toUpperCase()}, 1h)**`, ''];
  tokens.slice(0, 15).forEach((t, i) => {
    const sym  = t.symbol || t.token_symbol || '?';
    const name = t.name   || t.token_name   || '';
    const age  = fmtAge(t.open_timestamp);
    const mcap = fmt$(t.market_cap);
    const liq  = fmt$(t.liquidity);
    const addr = t.address || t.token_address || '';
    lines.push(`**${i + 1}. ${name ? name + ' (' + sym + ')' : sym}** — ${age}`);
    lines.push(`   MCap: ${mcap}  Liq: ${liq}  \`${short(addr)}\``);
  });
  return lines.join('\n');
}

// ─── 4. gmgn trending [chain] — trending tokens ───────────────────────────────
async function getTrending(chain) {
  const c = chain || 'sol';
  const tokens = await fetchRank(c, '1h', 20);
  if (!tokens.length) return `⚠️ Tidak ada data trending di ${c.toUpperCase()} saat ini.`;

  const lines = [`**🔥 Trending (${c.toUpperCase()}, 1h)**`, ''];
  tokens.slice(0, 15).forEach((t, i) => {
    const sym   = t.symbol || '?';
    const price = fmt$(t.price);
    const ch1h  = fmtPct(t.price_change_percent1h ?? t.price_change_percent);
    const ch24  = fmtPct(t.price_change_percent);
    const mcap  = fmt$(t.market_cap);
    const smart = t.smart_degen_count ?? 0;
    const rug   = t.rug_ratio != null ? (parseFloat(t.rug_ratio) * 100).toFixed(0) + '%' : '?';
    lines.push(`**${i + 1}. ${sym}** ${price}  ${ch1h} (1h)`);
    lines.push(`   MCap: ${mcap}  Smart: ${smart}  Rug: ${rug}  Swaps: ${t.swaps ?? '?'}`);
  });
  return lines.join('\n');
}

// ─── 5. gmgn wallet <address> — wallet analysis ──────────────────────────────
async function getWalletAnalysis(address, chain) {
  const c = chain || guessChain(address);
  const k = GMGN_KEY();

  if (!k) {
    return [
      `⚠️ **GMGN_API_KEY dibutuhkan** untuk analisis wallet.`,
      `Set \`GMGN_API_KEY\` di Railway env.`,
    ].join('\n');
  }

  const data = await gmgnGet(
    `/defi/quotation/v1/smartmoney/${c}/walletNew/${address}`,
    { period: '30d' },
    `https://gmgn.ai/${c}/address/${address}`
  );
  const w = data?.wallet || data || {};

  const lines = [
    `**👛 Wallet Analysis (${c.toUpperCase()})**`,
    `\`${address}\``,
    '',
    `• Tag           : ${Array.isArray(w.tags) ? w.tags.join(', ') || '—' : (w.tags || '—')}`,
    `• Balance       : ${fmt$(w.sol_balance ?? w.eth_balance ?? w.balance)}`,
    `• PnL 7d        : ${fmt$(w.pnl_7d)}`,
    `• PnL 30d       : ${fmt$(w.pnl_30d ?? w.pnl)}`,
    `• Realized 30d  : ${fmt$(w.realized_profit_30d ?? w.realized_profit)}`,
    `• Win Rate      : ${w.winrate != null ? (parseFloat(w.winrate) * 100).toFixed(1) + '%' : 'N/A'}`,
    `• Beli 30d      : ${w.buy_30d ?? 'N/A'}  Jual: ${w.sell_30d ?? 'N/A'}`,
    '',
    `🔗 [GMGN](https://gmgn.ai/${c}/address/${address})`,
    '_NFA. DYOR._',
  ];
  return lines.join('\n');
}

// ─── 6. gmgn holder <CA> — top holders ───────────────────────────────────────
async function getHolders(ca, chain) {
  const c = chain || guessChain(ca);
  const k = GMGN_KEY();

  if (!k) {
    // Fallback: tampilkan top_10_holder_rate dari trending data
    const result = await findTokenInRank(ca, c).catch(() => null);
    if (result?.token) {
      const t = result.token;
      const top10 = t.top_10_holder_rate != null
        ? (parseFloat(t.top_10_holder_rate) * 100).toFixed(1) + '%'
        : 'N/A';
      return [
        `**👥 Holder Info — ${t.symbol || short(ca)} (${c.toUpperCase()})**`,
        `• Total Holders    : ${t.holder_count ?? 'N/A'}`,
        `• Top 10 Pegang    : ${top10} supply`,
        `• Sniper Count     : ${t.sniper_count ?? 'N/A'}`,
        `• Smart Degen      : ${t.smart_degen_count ?? 'N/A'}`,
        '',
        `ℹ️ Data detail holder (top 20 wallet) butuh \`GMGN_API_KEY\` di Railway.`,
      ].join('\n');
    }
    return `⚠️ **GMGN_API_KEY dibutuhkan** untuk data top holders lengkap.\nSet \`GMGN_API_KEY\` di Railway env.`;
  }

  const data = await gmgnGet(
    `/defi/quotation/v1/tokens/top_holders/${c}/${ca}`,
    { limit: 20, orderby: 'amount_percentage', direction: 'desc' },
    `https://gmgn.ai/${c}/token/${ca}`
  );
  const holders = Array.isArray(data?.holders) ? data.holders
    : Array.isArray(data) ? data : [];

  if (!holders.length) return `⚠️ Tidak ada data holder untuk token ini.`;

  const lines = [`**👥 Top Holders — ${short(ca)} (${c.toUpperCase()})**`, ''];
  let cum = 0;
  holders.slice(0, 15).forEach((h, i) => {
    const addr = h.address || h.wallet_address || '?';
    const pct  = parseFloat(h.amount_percentage ?? h.percent ?? 0);
    cum += pct;
    const tags = Array.isArray(h.tags) ? h.tags.join(', ') : '';
    const locked = h.is_locked ? '🔒' : '';
    lines.push(`**${i + 1}.** \`${short(addr)}\` ${locked}${tags ? '[' + tags + ']' : ''}`);
    lines.push(`   Porsi: ${pct.toFixed(2)}%  Nilai: ${fmt$(h.usd_value)}  (kum: ${cum.toFixed(1)}%)`);
  });
  return lines.join('\n');
}

// ─── Parser ───────────────────────────────────────────────────────────────────
function detectGmgnQuery(text) {
  const t = text.trim();
  if (!/^gmgn\b/i.test(t)) return null;

  const parts = t.split(/\s+/);
  const sub   = (parts[1] || '').toLowerCase();
  const arg1  = parts[2] || '';
  const chain = detectChain(t);
  const chainKeywords = ['sol','eth','base','bsc','arb','blast','solana','ethereum'];

  if (sub === 'trending') return { type: 'trending', chain };
  if (sub === 'new')      return { type: 'new', chain };

  if (sub === 'smart') {
    const ca = arg1 && !chainKeywords.includes(arg1.toLowerCase()) ? arg1 : null;
    return { type: 'smart', ca, chain: chain || (ca ? guessChain(ca) : 'sol') };
  }
  if (sub === 'wallet') {
    if (!arg1) return { type: 'wallet_help' };
    return { type: 'wallet', address: arg1, chain: chain || guessChain(arg1) };
  }
  if (sub === 'holder') {
    if (!arg1) return { type: 'holder_help' };
    return { type: 'holder', ca: arg1, chain: chain || guessChain(arg1) };
  }

  // gmgn <CA> langsung
  if (sub && (sub.length > 30 || isSolAddr(sub) || isEvmAddr(sub))) {
    return { type: 'token', ca: sub, chain: chain || guessChain(sub) };
  }

  return { type: 'help' };
}

// ─── Handler utama ────────────────────────────────────────────────────────────
async function handleGmgnCommand(query) {
  const { type, ca, address, chain } = query;
  switch (type) {
    case 'token':    return getTokenInfo(ca, chain);
    case 'smart':    return getSmartMoney(ca, chain);
    case 'new':      return getNewTokens(chain);
    case 'trending': return getTrending(chain);
    case 'wallet':   return getWalletAnalysis(address, chain);
    case 'holder':   return getHolders(ca, chain);
    case 'wallet_help':
      return '⚠️ Sertakan alamat wallet.\nContoh: `gmgn wallet 0xABC...` atau `gmgn wallet <solana-addr>`';
    case 'holder_help':
      return '⚠️ Sertakan contract address.\nContoh: `gmgn holder <CA>`';
    case 'help':
    default:
      return [
        '**📡 GMGN Commands**',
        '```',
        'gmgn <CA>              Info & security token',
        'gmgn smart             Token aktif smart money (1h)',
        'gmgn smart <CA>        Smart trader token ini  [butuh API key]',
        'gmgn new [chain]       Token baru 1h terakhir',
        'gmgn trending [chain]  Trending token 1h',
        'gmgn wallet <address>  Analisis wallet         [butuh API key]',
        'gmgn holder <CA>       Top holder token        [butuh API key]',
        '```',
        'Chain: `sol` (default) `eth` `base` `bsc` `arb` `blast`',
      ].join('\n');
  }
}

module.exports = { detectGmgnQuery, handleGmgnCommand };
