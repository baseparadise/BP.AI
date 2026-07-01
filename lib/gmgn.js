// lib/gmgn.js
// GMGN.ai API integration — token info, smart money, new tokens, trending, wallet, holders.
// Set GMGN_API_KEY di env Railway. Chain default: sol (Solana), deteksi otomatis untuk EVM.

const axios = require('axios');

const GMGN_KEY  = () => process.env.GMGN_API_KEY || '';
const BASE_URL  = 'https://gmgn.ai';
const TIMEOUT   = 15000;

// ─── Chain detection ──────────────────────────────────────────────────────────
// Solana: base58, 32–44 char, tidak diawali '0x'
function isSolAddress(addr) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}
function isEvmAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

// Deteksi chain dari kata kunci dalam teks
function detectChain(text) {
  const t = text.toLowerCase();
  if (/\bsol(ana)?\b/.test(t)) return 'sol';
  if (/\bbase\b/.test(t))      return 'base';
  if (/\bbsc\b|\bbnb\b/.test(t)) return 'bsc';
  if (/\barb(itrum)?\b/.test(t)) return 'arb';
  if (/\bblast\b/.test(t))     return 'blast';
  if (/\beth(ereum)?\b/.test(t)) return 'eth';
  return null; // tidak terdeteksi dari kata kunci
}

// Tebak chain dari alamat
function guessChainFromAddress(addr) {
  if (!addr) return 'sol';
  if (isSolAddress(addr) && !isEvmAddress(addr)) return 'sol';
  return 'base'; // default EVM → Base
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function gmgnGet(path, params = {}) {
  const key = GMGN_KEY();
  const qs  = { ...(key ? { token: key } : {}), ...params };
  const url = BASE_URL + path;
  const { data } = await axios.get(url, {
    params: qs,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; BP.AI-Bot/1.0)',
      'Accept': 'application/json',
    },
    timeout: TIMEOUT,
  });
  if (data?.code !== 0 && data?.code !== undefined && data?.code !== 200) {
    throw new Error(data?.msg || `GMGN error code ${data?.code}`);
  }
  return data?.data ?? data;
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function fmt$(n) {
  if (n == null) return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num)) return 'N/A';
  if (num >= 1e9)  return '$' + (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6)  return '$' + (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3)  return '$' + (num / 1e3).toFixed(1) + 'K';
  return '$' + num.toFixed(2);
}
function fmtPct(n) {
  if (n == null) return 'N/A';
  const v = parseFloat(n);
  return isNaN(v) ? 'N/A' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}
function short(addr) {
  if (!addr) return '—';
  return addr.length > 12 ? addr.slice(0, 6) + '…' + addr.slice(-4) : addr;
}

// ─── 1. gmgn <CA> — token security & info ────────────────────────────────────
async function getTokenInfo(ca, chain) {
  const c = chain || guessChainFromAddress(ca);
  const [secData, rankData] = await Promise.allSettled([
    gmgnGet(`/defi/quotation/v1/tokens/security/${c}/${ca}`),
    gmgnGet(`/defi/quotation/v1/tokens/${c}/${ca}`),
  ]);

  const sec   = secData.status === 'fulfilled'  ? secData.value  : null;
  const token = rankData.status === 'fulfilled' ? rankData.value : null;

  const ti = token?.token || token || {};
  const si = sec?.token_security || sec || {};

  const name   = ti.name || si.token_name || 'Unknown';
  const symbol = ti.symbol || si.token_symbol || '?';
  const price  = ti.price ? fmt$(ti.price) : 'N/A';
  const mcap   = fmt$(ti.market_cap);
  const liq    = fmt$(ti.liquidity);
  const vol24  = fmt$(ti.volume_24h || ti.volume);
  const ch24   = fmtPct(ti.price_change_percent || ti.price_change_percent_1h);

  // Security flags
  const honeypot     = si.is_honeypot   === '1' || si.is_honeypot   === true;
  const openSource   = si.is_open_source === '1'|| si.is_open_source === true;
  const mintable     = si.is_mintable   === '1' || si.is_mintable   === true;
  const renounced    = si.owner_address === '0x0000000000000000000000000000000000000000'
                     || si.renounced_ownership === '1';
  const transferPausable = si.transfer_pausable === '1';
  const buyTax  = si.buy_tax  != null ? parseFloat(si.buy_tax).toFixed(1)  + '%' : 'N/A';
  const sellTax = si.sell_tax != null ? parseFloat(si.sell_tax).toFixed(1) + '%' : 'N/A';
  const holderCount = si.holder_count ?? ti.holder_count ?? 'N/A';
  const lpHolders   = si.lp_holder_count ?? 'N/A';

  const chainLink = c === 'sol'
    ? `https://solscan.io/token/${ca}`
    : `https://gmgn.ai/${c}/token/${ca}`;

  const lines = [
    `**🔍 Token Info — ${name} (${symbol})**`,
    `\`${ca}\``,
    '',
    '**📊 Market**',
    `• Harga       : ${price}`,
    `• Market Cap  : ${mcap}`,
    `• Likuiditas  : ${liq}`,
    `• Volume 24h  : ${vol24}`,
    `• Perubahan   : ${ch24}`,
    `• Holders     : ${holderCount}`,
    '',
    '**🔒 Security**',
    `• Honeypot    : ${honeypot ? '🚨 YA' : '✅ Tidak'}`,
    `• Open Source : ${openSource ? '✅ Ya' : '⚠️ Tidak'}`,
    `• Renounced   : ${renounced ? '✅ Ya' : '⚠️ Tidak'}`,
    `• Mintable    : ${mintable ? '⚠️ Ya' : '✅ Tidak'}`,
    `• Transfer Pause: ${transferPausable ? '⚠️ Ya' : '✅ Tidak'}`,
    `• Buy Tax     : ${buyTax}`,
    `• Sell Tax    : ${sellTax}`,
    `• LP Holders  : ${lpHolders}`,
    '',
    `🔗 [GMGN](${chainLink})`,
    '_NFA. DYOR._',
  ];

  return lines.join('\n');
}

// ─── 2. gmgn smart [CA] — smart money ────────────────────────────────────────
async function getSmartMoney(ca, chain) {
  const c = chain || guessChainFromAddress(ca);

  if (!ca) {
    // Tanpa CA: tampilkan leaderboard smart wallet
    const data = await gmgnGet(`/defi/quotation/v1/smartmoney/${c}/ranking`, {
      period: '7d',
      order_by: 'pnl',
      direction: 'desc',
      limit: 10,
    });
    const wallets = Array.isArray(data?.rank) ? data.rank : (Array.isArray(data) ? data : []);
    if (!wallets.length) return '⚠️ Tidak ada data smart wallet saat ini.';

    const lines = [`**🧠 Top Smart Wallets (${c.toUpperCase()}, 7d)**`, ''];
    wallets.slice(0, 10).forEach((w, i) => {
      const addr   = w.wallet_address || w.address || '?';
      const pnl    = fmt$(w.pnl_7d ?? w.pnl);
      const wr     = w.win_rate != null ? (parseFloat(w.win_rate) * 100).toFixed(0) + '%' : 'N/A';
      const txs    = w.buy_7d ?? w.txns ?? 'N/A';
      lines.push(`**${i + 1}.** \`${short(addr)}\``);
      lines.push(`   PnL: ${pnl}  Win Rate: ${wr}  Buys(7d): ${txs}`);
    });
    return lines.join('\n');
  }

  // Dengan CA: smart money trader pada token ini
  const data = await gmgnGet(`/defi/quotation/v1/tokens/top_traders/${c}/${ca}`, {
    tag: 'smart_money',
    size: 10,
    orderby: 'profit',
    direction: 'desc',
  });
  const traders = Array.isArray(data?.items) ? data.items
    : Array.isArray(data?.traders) ? data.traders
    : Array.isArray(data) ? data : [];

  if (!traders.length) return `⚠️ Tidak ada data smart money untuk token ini di ${c.toUpperCase()}.`;

  const lines = [`**🧠 Smart Money — ${short(ca)} (${c.toUpperCase()})**`, ''];
  traders.slice(0, 10).forEach((t, i) => {
    const addr   = t.address || t.wallet_address || '?';
    const profit = fmt$(t.profit ?? t.realized_profit);
    const bought = fmt$(t.bought_amount_cur ?? t.buy_volume_cur);
    const sold   = fmt$(t.sold_amount_cur ?? t.sell_volume_cur);
    const tags   = Array.isArray(t.tags) ? t.tags.join(', ') : '';
    lines.push(`**${i + 1}.** \`${short(addr)}\`${tags ? ' — ' + tags : ''}`);
    lines.push(`   Profit: ${profit}  Beli: ${bought}  Jual: ${sold}`);
  });
  return lines.join('\n');
}

// ─── 3. gmgn new — new token launches ────────────────────────────────────────
async function getNewTokens(chain) {
  const c = chain || 'sol';
  const data = await gmgnGet(`/defi/quotation/v1/rank/${c}/new_pairs/1h`, {
    limit: 20,
    min_liquidity: 1000,
    orderby: 'open_timestamp',
    direction: 'desc',
  });
  const tokens = Array.isArray(data?.rank) ? data.rank : (Array.isArray(data) ? data : []);
  if (!tokens.length) return `⚠️ Tidak ada token baru di ${c.toUpperCase()} saat ini.`;

  const lines = [`**🆕 New Token Launches (${c.toUpperCase()}, 1h terakhir)**`, ''];
  tokens.slice(0, 15).forEach((t, i) => {
    const sym  = t.symbol || t.token_symbol || '?';
    const name = t.name   || t.token_name   || '?';
    const age  = t.open_timestamp
      ? Math.round((Date.now() / 1000 - t.open_timestamp) / 60) + 'm lalu'
      : 'N/A';
    const mcap = fmt$(t.market_cap);
    const liq  = fmt$(t.liquidity);
    const addr = t.address || t.token_address || '';
    lines.push(`**${i + 1}. ${name} (${sym})** — ${age}`);
    lines.push(`   MCap: ${mcap}  Liq: ${liq}  \`${short(addr)}\``);
  });
  return lines.join('\n');
}

// ─── 4. gmgn trending — trending tokens ──────────────────────────────────────
async function getTrending(chain) {
  const c = chain || 'sol';
  const data = await gmgnGet(`/defi/quotation/v1/rank/${c}/swaps/1h`, {
    orderby: 'swaps',
    direction: 'desc',
    limit: 20,
  });
  const tokens = Array.isArray(data?.rank) ? data.rank : (Array.isArray(data) ? data : []);
  if (!tokens.length) return `⚠️ Tidak ada data trending di ${c.toUpperCase()} saat ini.`;

  const lines = [`**🔥 Trending Tokens (${c.toUpperCase()}, 1h)**`, ''];
  tokens.slice(0, 15).forEach((t, i) => {
    const sym   = t.symbol || t.token_symbol || '?';
    const price = t.price  ? fmt$(t.price)   : 'N/A';
    const ch1h  = fmtPct(t.price_change_percent_1h ?? t.price_change_percent);
    const ch24  = fmtPct(t.price_change_percent_24h);
    const vol   = fmt$(t.volume_1h ?? t.volume);
    const swaps = t.swaps ?? 'N/A';
    lines.push(`**${i + 1}. ${sym}** ${price}  ${ch1h} (1h)  ${ch24} (24h)`);
    lines.push(`   Vol: ${vol}  Swaps: ${swaps}`);
  });
  return lines.join('\n');
}

// ─── 5. gmgn wallet <address> — wallet analysis ──────────────────────────────
async function getWalletAnalysis(address, chain) {
  const c = chain || guessChainFromAddress(address);
  const data = await gmgnGet(`/defi/quotation/v1/smartmoney/${c}/walletNew/${address}`, {
    period: '30d',
  });
  const w = data?.wallet || data || {};

  const pnl7   = fmt$(w.pnl_7d);
  const pnl30  = fmt$(w.pnl_30d ?? w.pnl);
  const wr7    = w.winrate ? (parseFloat(w.winrate) * 100).toFixed(0) + '%' : 'N/A';
  const txs30  = w.buy_30d != null ? `${w.buy_30d} beli / ${w.sell_30d ?? '?'} jual` : 'N/A';
  const tags   = Array.isArray(w.tags) ? w.tags.join(', ') : (w.tags || '—');
  const balance = fmt$(w.sol_balance ?? w.eth_balance ?? w.balance);
  const realized = fmt$(w.realized_profit_30d ?? w.realized_profit);
  const unrealized = fmt$(w.unrealized_profit);

  const chainLink = c === 'sol'
    ? `https://gmgn.ai/sol/address/${address}`
    : `https://gmgn.ai/${c}/address/${address}`;

  const lines = [
    `**👛 Wallet Analysis (${c.toUpperCase()})**`,
    `\`${address}\``,
    '',
    `• Tag           : ${tags}`,
    `• Balance       : ${balance}`,
    `• PnL 7d        : ${pnl7}`,
    `• PnL 30d       : ${pnl30}`,
    `• Realized 30d  : ${realized}`,
    `• Unrealized    : ${unrealized}`,
    `• Win Rate      : ${wr7}`,
    `• Transaksi 30d : ${txs30}`,
    '',
    `🔗 [Lihat di GMGN](${chainLink})`,
    '_NFA. DYOR._',
  ];
  return lines.join('\n');
}

// ─── 6. gmgn holder <CA> — top holders ───────────────────────────────────────
async function getHolders(ca, chain) {
  const c = chain || guessChainFromAddress(ca);
  const data = await gmgnGet(`/defi/quotation/v1/tokens/top_holders/${c}/${ca}`, {
    limit: 20,
    orderby: 'amount_percentage',
    direction: 'desc',
  });
  const holders = Array.isArray(data?.holders) ? data.holders
    : Array.isArray(data) ? data : [];

  if (!holders.length) return `⚠️ Tidak ada data holder untuk token ini di ${c.toUpperCase()}.`;

  const lines = [`**👥 Top Holders — ${short(ca)} (${c.toUpperCase()})**`, ''];
  let cumulative = 0;
  holders.slice(0, 15).forEach((h, i) => {
    const addr  = h.address || h.wallet_address || '?';
    const pct   = parseFloat(h.amount_percentage ?? h.percent ?? 0);
    cumulative += pct;
    const amount = fmt$(h.usd_value ?? h.amount);
    const tags  = Array.isArray(h.tags) ? h.tags.join(', ') : '';
    const label = h.is_locked ? '🔒' : tags ? `[${tags}]` : '';
    lines.push(`**${i + 1}.** \`${short(addr)}\` ${label}`);
    lines.push(`   Porsi: ${pct.toFixed(2)}%  Nilai: ${amount}  (kumulatif: ${cumulative.toFixed(1)}%)`);
  });
  return lines.join('\n');
}

// ─── Parser command "gmgn ..." ────────────────────────────────────────────────
// Mengembalikan { type, ca, address, chain } atau null jika bukan gmgn command
function detectGmgnQuery(text) {
  const t = text.trim();
  if (!/^gmgn\b/i.test(t)) return null;

  // Ambil semua kata setelah "gmgn"
  const parts  = t.split(/\s+/);
  const sub    = (parts[1] || '').toLowerCase();
  const arg1   = parts[2] || '';
  const arg2   = parts[3] || '';

  // Chain bisa disebut di mana saja dalam teks
  const chain = detectChain(t);

  // gmgn trending [chain]
  if (sub === 'trending' || (!sub && false)) {
    return { type: 'trending', chain };
  }
  // gmgn new [chain]
  if (sub === 'new') {
    return { type: 'new', chain };
  }
  // gmgn smart [CA] [chain]
  if (sub === 'smart') {
    const ca = (arg1 && !['sol','eth','base','bsc','arb','blast'].includes(arg1.toLowerCase())) ? arg1 : null;
    return { type: 'smart', ca, chain: chain || (ca ? guessChainFromAddress(ca) : null) };
  }
  // gmgn wallet <address> [chain]
  if (sub === 'wallet') {
    if (!arg1) return { type: 'wallet_help' };
    return { type: 'wallet', address: arg1, chain: chain || guessChainFromAddress(arg1) };
  }
  // gmgn holder <CA> [chain]
  if (sub === 'holder') {
    if (!arg1) return { type: 'holder_help' };
    return { type: 'holder', ca: arg1, chain: chain || guessChainFromAddress(arg1) };
  }
  // gmgn <CA> — langsung token info
  if (sub && (isSolAddress(sub) || isEvmAddress(sub))) {
    return { type: 'token', ca: sub, chain: chain || guessChainFromAddress(sub) };
  }
  // gmgn <CA> (versi panjang, e.g. parts[1] is full address)
  if (sub && sub.length > 30) {
    return { type: 'token', ca: sub, chain: chain || guessChainFromAddress(sub) };
  }

  // Tidak cocok — kembalikan help
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
      return '⚠️ Sertakan alamat wallet.\nContoh: `gmgn wallet 0xABC...` atau `gmgn wallet <solana-address>`';
    case 'holder_help':
      return '⚠️ Sertakan contract address.\nContoh: `gmgn holder 0xABC...`';
    case 'help':
    default:
      return [
        '**📡 GMGN Commands**',
        '```',
        'gmgn <CA>              Info & security token',
        'gmgn smart             Top smart wallets aktif',
        'gmgn smart <CA>        Smart money di token ini',
        'gmgn new               Token baru 1h terakhir',
        'gmgn trending          Trending token 1h',
        'gmgn wallet <address>  Analisis wallet',
        'gmgn holder <CA>       Top holder token',
        '```',
        'Tambahkan chain: `sol` `eth` `base` `bsc` `arb` `blast`',
        'Contoh: `gmgn trending sol` atau `gmgn new base`',
      ].join('\n');
  }
}

module.exports = { detectGmgnQuery, handleGmgnCommand };
