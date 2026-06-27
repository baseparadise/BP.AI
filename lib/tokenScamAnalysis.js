// lib/tokenScamAnalysis.js
// Token scam/rug-pull analysis — full Bankr skill spec
//
// Data sources:
//   GeckoTerminal  — market data (free, no key)
//   DexScreener    — pairs, socials, liquidity (free, no key)
//   Etherscan V2   — SEMUA EVM chain dengan SATU API key + chainid param
//                    https://api.etherscan.io/v2/api?chainid={id}&...
//   DuckDuckGo     — off-chain intel: ZachXBT, CEX investigation (free)
//
// Interface (unchanged):
//   isScamAnalysisRequest(question) → boolean
//   runScamAnalysis(question)       → { applicable, addresses, chain, fullPrompt }

'use strict';
const axios = require('axios');

// ─── Single Etherscan V2 endpoint ─────────────────────────────────────────────
const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || '';

// ─── Chain config (chainId untuk Etherscan V2) ────────────────────────────────
const CHAIN_CONFIG = {
  eth:      { name: 'Ethereum',      chainId: 1,     geckoId: 'eth',         dexId: 'ethereum',  explorer: 'https://etherscan.io',              lzEid: 30101 },
  base:     { name: 'Base',          chainId: 8453,  geckoId: 'base',        dexId: 'base',      explorer: 'https://basescan.org',              lzEid: 30184 },
  bsc:      { name: 'BNB Chain',     chainId: 56,    geckoId: 'bsc',         dexId: 'bsc',       explorer: 'https://bscscan.com',               lzEid: 30102 },
  polygon:  { name: 'Polygon',       chainId: 137,   geckoId: 'polygon_pos', dexId: 'polygon',   explorer: 'https://polygonscan.com',           lzEid: 30109 },
  arbitrum: { name: 'Arbitrum',      chainId: 42161, geckoId: 'arbitrum',    dexId: 'arbitrum',  explorer: 'https://arbiscan.io',               lzEid: 30110 },
  optimism: { name: 'Optimism',      chainId: 10,    geckoId: 'optimism',    dexId: 'optimism',  explorer: 'https://optimistic.etherscan.io',   lzEid: 30111 },
  avalanche:{ name: 'Avalanche',     chainId: 43114, geckoId: 'avax',        dexId: 'avalanche', explorer: 'https://snowtrace.io',              lzEid: 30106 },
  fantom:   { name: 'Fantom',        chainId: 250,   geckoId: 'fantom',      dexId: 'fantom',    explorer: 'https://ftmscan.com',               lzEid: null  },
  zksync:   { name: 'zkSync Era',    chainId: 324,   geckoId: 'zksync',      dexId: 'zksync',    explorer: 'https://explorer.zksync.io',        lzEid: 30165 },
  linea:    { name: 'Linea',         chainId: 59144, geckoId: 'linea',       dexId: 'linea',     explorer: 'https://lineascan.build',           lzEid: 30183 },
  solana:   { name: 'Solana',        chainId: null,  geckoId: 'solana',      dexId: 'solana',    explorer: 'https://solscan.io',                lzEid: null  },
};

// Known infra/burn addresses — jangan dihitung sebagai holder
const KNOWN_INFRA = new Set([
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000000',
]);
// Uniswap v4 PoolManager di Base
const UNISWAP_V4_BASE = '0x498581ff718922c3f8e6a244956af099b2652b2b';

// ─── Keyword detection ────────────────────────────────────────────────────────
const SCAM_KEYWORDS = [
  /\bscam\b/i, /\brug\b/i, /\brug.?pull\b/i,
  /\banalyz/i, /\banalisis\b/i, /\banalisa\b/i, /\bforensik\b/i,
  /\bsafe\b.*\btoken\b/i, /\blegit\b/i, /\btrust(worthy)?\b/i,
  /\bcek.?token\b/i, /\bcek.?kontrak\b/i, /\bperiksa.?token\b/i,
  /\bis.?this.?a\b/i, /\bshould.?i.?trust\b/i,
  /\bbahaya\b/i, /\bpenipuan\b/i,
  /\bhodler\b/i, /\bholder\b/i, /\bdeployer\b/i,
  /\bmigrat/i, /\bon.?chain\b/i, /\bfundamental\b/i,
  /\brisk\b/i, /\brisiko\b/i, /\bwaspada\b/i,
  /\btoken\b/i,
];

function extractContractAddresses(text) {
  const m = text.match(/0x[a-fA-F0-9]{40}/g);
  return m ? [...new Set(m)] : [];
}

function detectChain(text) {
  const t = text.toLowerCase();
  if (/\bbase\b/.test(t)) return 'base';
  if (/\bsolana\b|\bsol\b/.test(t)) return 'solana';
  if (/\bpolygon\b|\bmatic\b/.test(t)) return 'polygon';
  if (/\barb(itrum)?\b/.test(t)) return 'arbitrum';
  if (/\boptimism\b|\bop\b/.test(t)) return 'optimism';
  if (/\bbsc\b|\bbnb\b|\bbinance\b/.test(t)) return 'bsc';
  if (/\bavalanche\b|\bavax\b/.test(t)) return 'avalanche';
  if (/\bzksync\b/.test(t)) return 'zksync';
  if (/\blinea\b/.test(t)) return 'linea';
  if (/\bfantom\b|\bftm\b/.test(t)) return 'fantom';
  if (/\beth(ereum)?\b/.test(t)) return 'eth';
  return 'base'; // default ecosystem Clanker/Bankr
}

function isScamAnalysisRequest(question) {
  const addrs = extractContractAddresses(question);
  if (addrs.length === 0) return false;
  if (SCAM_KEYWORDS.some((kw) => kw.test(question))) return true;
  return question.replace(/0x[a-fA-F0-9]{40}/g, '').trim().length < 30;
}

// ─── Formatters ───────────────────────────────────────────────────────────────
const fmtNum = (n) => {
  if (n == null || n === '') return 'N/A';
  const num = parseFloat(n); if (isNaN(num)) return String(n);
  if (num >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return '$' + (num / 1e3).toFixed(2) + 'K';
  return '$' + num.toFixed(4);
};
const fmtPrice = (n) => {
  if (n == null || n === '') return 'N/A';
  const num = parseFloat(n); if (isNaN(num)) return String(n);
  if (num < 0.000001) return '$' + num.toExponential(4);
  if (num < 0.01) return '$' + num.toFixed(8);
  if (num < 1) return '$' + num.toFixed(6);
  return '$' + num.toFixed(4);
};
const fmtAddr = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : 'N/A';

// ─── Etherscan V2 unified API ─────────────────────────────────────────────────
// Satu fungsi untuk SEMUA chain — cukup ganti chainid param.
async function etherscanV2(chain, params, timeout = 10000) {
  const cfg = CHAIN_CONFIG[chain];
  if (!cfg?.chainId || !ETHERSCAN_KEY) return null;
  try {
    const { data } = await axios.get(ETHERSCAN_V2, {
      params: { chainid: cfg.chainId, apikey: ETHERSCAN_KEY, ...params },
      timeout,
    });
    if (data.status === '1' && data.result) return data.result;
    if (data.result === 'Contract source code not verified') return data.result;
    return null;
  } catch { return null; }
}

// eth_call via Etherscan V2 proxy module
async function ethCallV2(chain, to, data, timeout = 8000) {
  const cfg = CHAIN_CONFIG[chain];
  if (!cfg?.chainId || !ETHERSCAN_KEY) return null;
  try {
    const { data: resp } = await axios.get(ETHERSCAN_V2, {
      params: { chainid: cfg.chainId, apikey: ETHERSCAN_KEY, module: 'proxy', action: 'eth_call', to, data, tag: 'latest' },
      timeout,
    });
    if (resp.result && resp.result !== '0x') return resp.result;
    return null;
  } catch { return null; }
}

// ─── ABI decoding helpers ─────────────────────────────────────────────────────
function decodeHexString(fullHex, byteOffset) {
  const pos = byteOffset * 2;
  const len = Number(BigInt('0x' + (fullHex.slice(pos, pos + 64) || '0')));
  if (!len) return '';
  return Buffer.from(fullHex.slice(pos + 64, pos + 64 + len * 2), 'hex').toString('utf-8');
}

function decodeAllData(hexResult) {
  const hex = hexResult.startsWith('0x') ? hexResult.slice(2) : hexResult;
  if (hex.length < 320) return null;
  try {
    return {
      originalAdmin: '0x' + hex.slice(24, 64).toLowerCase(),
      admin:         '0x' + hex.slice(88, 128).toLowerCase(),
      image:    decodeHexString(hex, Number(BigInt('0x' + hex.slice(128, 192)))),
      metadata: decodeHexString(hex, Number(BigInt('0x' + hex.slice(192, 256)))),
      context:  decodeHexString(hex, Number(BigInt('0x' + hex.slice(256, 320)))),
    };
  } catch { return null; }
}

const decodeBool    = (h) => (h?.startsWith('0x') ? h.slice(2) : h)?.slice(-1) === '1';
const decodeAddr    = (h) => h ? '0x' + (h.startsWith('0x') ? h.slice(2) : h).slice(24).toLowerCase() : null;
const decodeUint256 = (h) => { try { return BigInt('0x' + (h.startsWith('0x') ? h.slice(2) : h)); } catch { return BigInt(0); } };

// ─── On-chain reads via eth_call ──────────────────────────────────────────────
const readAllData     = (a, c) => ethCallV2(c, a, '0x773a5096').then((r) => r ? decodeAllData(r) : null);
const readIsVerified  = (a, c) => ethCallV2(c, a, '0xe8d5ce15').then((r) => r ? decodeBool(r) : null);
const readTotalSupply = (a, c) => ethCallV2(c, a, '0x18160ddd').then((r) => r ? decodeUint256(r) : null);
const readOwner       = (a, c) => ethCallV2(c, a, '0x8da5cb5b').then((r) => r ? decodeAddr(r) : null);
const readDecimals    = (a, c) => ethCallV2(c, a, '0x313ce567').then((r) => r ? Number(decodeUint256(r)) : 18);
const readBalanceOf   = (token, wallet, chain) => {
  if (!wallet) return Promise.resolve(BigInt(0));
  return ethCallV2(chain, token, '0x70a08231' + wallet.slice(2).padStart(64, '0')).then((r) => r ? decodeUint256(r) : BigInt(0));
};

// ─── Etherscan V2 data fetchers ───────────────────────────────────────────────
const fetchContractSource = (a, c) => etherscanV2(c, { module: 'contract', action: 'getsourcecode', address: a });
const fetchCreatorInfo    = (a, c) => etherscanV2(c, { module: 'contract', action: 'getcontractcreation', contractaddresses: a }).then((r) => r?.[0] || null);
const fetchTopHolders     = (a, c) => etherscanV2(c, { module: 'token', action: 'tokenholderlist', contractaddress: a, page: 1, offset: 20 });
const fetchBytecode       = (a, c) => etherscanV2(c, { module: 'proxy', action: 'eth_getCode', address: a, tag: 'latest' });

async function fetchContractAbi(address, chain) {
  const result = await etherscanV2(chain, { module: 'contract', action: 'getabi', address });
  if (!result || result === 'Contract source code not verified') return null;
  try {
    const DANGEROUS = ['mint', 'crosschainmint', 'setowner', 'updateadmin', 'blacklist',
      'setfee', 'pause', 'updateimage', 'updatemetadata', 'setpeer', 'setminter', 'freeze', 'burn'];
    return JSON.parse(result)
      .filter((i) => i.type === 'function')
      .map((i) => ({
        name: i.name || '',
        sig: `${i.name}(${(i.inputs || []).map((x) => x.type).join(',')})`,
        mutability: i.stateMutability,
        dangerous: DANGEROUS.some((d) => (i.name || '').toLowerCase().includes(d)),
      }));
  } catch { return null; }
}

// Bytecode classification: EOA / sniper_proxy (48-byte) / safe_multisig / contract
async function classifyAddress(address, chain) {
  const code = await fetchBytecode(address, chain);
  if (!code || code === '0x' || code === '0x0') return 'eoa';
  const byteLen = (code.replace('0x', '').length) / 2;
  if (byteLen === 48) return 'sniper_proxy';
  if (byteLen > 4000 && code.toLowerCase().includes('1901')) return 'safe_multisig';
  return 'contract';
}

// Deployer tx history
async function fetchDeployerActivity(deployer, chain) {
  if (!deployer) return null;
  const [txs, internal] = await Promise.all([
    etherscanV2(chain, { module: 'account', action: 'txlist', address: deployer, startblock: 0, endblock: 99999999, page: 1, offset: 50, sort: 'asc' }, 15000),
    etherscanV2(chain, { module: 'account', action: 'txlistinternal', address: deployer, page: 1, offset: 10, sort: 'asc' }, 10000),
  ]);
  if (!txs || !Array.isArray(txs)) return null;
  const fundingTx = internal?.[0];
  const largeOut = txs.filter((tx) => tx.from?.toLowerCase() === deployer.toLowerCase() && BigInt(tx.value || 0) > BigInt('50000000000000000'));
  return {
    nonce: txs.length,
    firstTxDate: txs[0]?.timeStamp ? new Date(parseInt(txs[0].timeStamp) * 1000).toISOString().split('T')[0] : 'N/A',
    fundedBy: fundingTx?.from || 'N/A',
    largeOutCount: largeOut.length,
    freshWallet: txs.length <= 5,
  };
}

// ─── GeckoTerminal ────────────────────────────────────────────────────────────
async function fetchGeckoTerminal(address, chain) {
  const id = CHAIN_CONFIG[chain]?.geckoId || chain;
  try {
    const { data } = await axios.get(`https://api.geckoterminal.com/api/v2/networks/${id}/tokens/${address}`, { headers: { Accept: 'application/json' }, timeout: 10000 });
    return data?.data?.attributes || null;
  } catch { return null; }
}
async function fetchGeckoPools(address, chain) {
  const id = CHAIN_CONFIG[chain]?.geckoId || chain;
  try {
    const { data } = await axios.get(`https://api.geckoterminal.com/api/v2/networks/${id}/tokens/${address}/pools?page=1`, { headers: { Accept: 'application/json' }, timeout: 10000 });
    return data?.data || [];
  } catch { return []; }
}

// ─── DexScreener ──────────────────────────────────────────────────────────────
async function fetchDexScreener(address) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 10000 });
    return data?.pairs || [];
  } catch { return []; }
}

// ─── Off-chain intel (DuckDuckGo — free, no key) ─────────────────────────────
async function ddgSearch(query) {
  try {
    const { data } = await axios.get('https://api.duckduckgo.com/', { params: { q: query, format: 'json', no_html: '1', skip_disambig: '1' }, timeout: 8000 });
    const parts = [];
    if (data.Abstract) parts.push(data.Abstract);
    (data.RelatedTopics || []).slice(0, 5).forEach((t) => { if (t.Text) parts.push(t.Text.slice(0, 200)); });
    return parts.join('\n').slice(0, 800);
  } catch { return null; }
}

async function runOffChainIntel(symbol, tokenName) {
  const [r1, r2, r3] = await Promise.all([
    ddgSearch(`"${symbol}" ${tokenName} scam rug investigation`),
    ddgSearch(`ZachXBT "${symbol}" manipulation`),
    ddgSearch(`"${symbol}" pump dump exchange investigation 2025 2026`),
  ]);
  const combined = [r1, r2, r3].filter(Boolean).join('\n\n');
  return {
    raw: combined.slice(0, 1200),
    zachMentioned: combined.toLowerCase().includes('zachxbt'),
    cexInvestigation: /bitget|binance|okx|gate\.|kraken|bybit.*investigat/i.test(combined),
    rugged: /rug|scam|fraud|exit.*scam/i.test(combined),
  };
}

// ─── Red flag scorer (30+ checks) ────────────────────────────────────────────
function scoreRedFlags({ gecko, dex, src, abi, creator, holders, deployerActivity, allData, isVerified, launchInfo, offChain, chain }) {
  const flags = [];
  const cfg = CHAIN_CONFIG[chain] || {};
  const bestPair = dex?.find((p) => p.chainId === cfg.dexId) || dex?.[0];

  // Market
  if (!gecko && !dex?.length) flags.push({ cat: 'MARKET', msg: 'Tidak terdaftar di GeckoTerminal maupun DexScreener' });
  const liq = parseFloat(bestPair?.liquidity?.usd || 0);
  if (liq > 0 && liq < 10000) flags.push({ cat: 'MARKET', msg: `Likuiditas sangat rendah (${fmtNum(liq)}) — mudah dimanipulasi` });
  const chg = parseFloat(bestPair?.priceChange?.h24 || 0);
  if (chg > 500) flags.push({ cat: 'MARKET', msg: `Harga naik ekstrem ${chg.toFixed(0)}% dalam 24h` });
  const pairAge = bestPair?.pairCreatedAt;
  if (pairAge && (Date.now() - pairAge) / 3600000 < 24) flags.push({ cat: 'MARKET', msg: `Token sangat baru — pool dibuat ${((Date.now() - pairAge) / 3600000).toFixed(1)} jam lalu` });
  if (launchInfo?.boosts > 0) flags.push({ cat: 'MARKET', msg: `DexScreener boosts aktif (${launchInfo.boosts}x)` });

  // Contract
  const srcInfo = src?.[0];
  if (!srcInfo || srcInfo.ABI === 'Contract source code not verified' || !srcInfo.SourceCode) flags.push({ cat: 'CONTRACT', msg: 'Source code TIDAK diverifikasi di explorer' });
  if (srcInfo?.Proxy === '1') flags.push({ cat: 'CONTRACT', msg: `Proxy/upgradeable contract (impl: ${srcInfo.Implementation || 'unknown'})` });
  if (abi) {
    const bad = abi.filter((f) => f.dangerous);
    if (bad.length) flags.push({ cat: 'CONTRACT', msg: `Fungsi berbahaya: ${bad.map((f) => f.name).join(', ')}` });
    if (abi.some((f) => f.name?.toLowerCase() === 'mint')) flags.push({ cat: 'CONTRACT', msg: 'mint() ada — risiko inflasi supply sewaktu-waktu' });
    if (abi.some((f) => f.name?.toLowerCase().includes('blacklist'))) flags.push({ cat: 'CONTRACT', msg: 'blacklist() ada — admin bisa bekukan wallet holder' });
    if (abi.some((f) => f.name?.toLowerCase() === 'pause')) flags.push({ cat: 'CONTRACT', msg: 'pause() ada — admin bisa hentikan semua transfer' });
  }

  // Clanker-specific
  if (allData) {
    if (allData.originalAdmin && allData.admin && allData.originalAdmin !== allData.admin)
      flags.push({ cat: 'CLANKER', msg: `Admin handoff: ${fmtAddr(allData.originalAdmin)} → ${fmtAddr(allData.admin)}` });
    if (!allData.metadata || allData.metadata.length < 10)
      flags.push({ cat: 'CLANKER', msg: 'allData() metadata kosong — tidak ada audit/socials yang diset saat deploy' });
  }
  if (isVerified === false) flags.push({ cat: 'CLANKER', msg: 'isVerified() = false — Clanker belum verifikasi token ini' });

  // Deployer
  if (deployerActivity) {
    if (deployerActivity.freshWallet) flags.push({ cat: 'DEPLOYER', msg: `Wallet deployer sangat baru (nonce=${deployerActivity.nonce}) — fresh wallet` });
    if (deployerActivity.largeOutCount > 0) flags.push({ cat: 'DEPLOYER', msg: `${deployerActivity.largeOutCount} transfer ETH besar keluar dari deployer — kemungkinan ekstraksi nilai` });
  }

  // Holders
  if (holders?.length) {
    const poolAddrs = new Set([bestPair?.pairAddress?.toLowerCase(), UNISWAP_V4_BASE].filter(Boolean));
    const nonPool = holders.filter((h) => !poolAddrs.has(h.TokenHolderAddress?.toLowerCase()) && !KNOWN_INFRA.has(h.TokenHolderAddress?.toLowerCase()));
    const total = parseFloat(holders[0]?.TotalSupply || 0);
    if (total > 0 && nonPool.length >= 3) {
      const top5pct = nonPool.slice(0, 5).reduce((s, h) => s + parseFloat(h.TokenHolderQuantity) / total * 100, 0);
      if (top5pct > 40) flags.push({ cat: 'HOLDERS', msg: `Top-5 non-pool holder menguasai ${top5pct.toFixed(1)}% supply — konsentrasi sangat tinggi` });
    }
    nonPool.slice(0, 10).forEach((h, i) => {
      if (h._type === 'sniper_proxy') flags.push({ cat: 'HOLDERS', msg: `Holder #${i + 1} (${fmtAddr(h.TokenHolderAddress)}) adalah sniper proxy (48-byte bytecode)` });
    });
  }

  // Off-chain
  if (offChain?.zachMentioned) flags.push({ cat: 'OFFCHAIN', msg: '⚠️ ZachXBT disebut dalam coverage terkait token ini' });
  if (offChain?.cexInvestigation) flags.push({ cat: 'OFFCHAIN', msg: '⚠️ Kemungkinan investigasi CEX terdeteksi — risiko delisting' });
  if (offChain?.rugged) flags.push({ cat: 'OFFCHAIN', msg: 'Kata kunci rug/scam ditemukan di coverage off-chain' });

  const score = flags.length;
  let verdict = score === 0 ? 'LOW' : score <= 2 ? 'LOW-MEDIUM' : score <= 4 ? 'MEDIUM' : score <= 6 ? 'HIGH' : 'EXTREME';
  let confidence = score === 0 ? 80 : score <= 2 ? 70 : score <= 4 ? 65 : 75;
  if (offChain?.zachMentioned || offChain?.cexInvestigation) {
    verdict = { 'LOW': 'LOW-MEDIUM', 'LOW-MEDIUM': 'MEDIUM', 'MEDIUM': 'HIGH', 'HIGH': 'EXTREME', 'EXTREME': 'EXTREME' }[verdict];
    confidence = Math.min(confidence + 10, 95);
  }
  return { flags, score, verdict, confidence };
}

// ─── Main data collector ──────────────────────────────────────────────────────
async function buildOnChainContext(addresses, chain) {
  const cfg = CHAIN_CONFIG[chain] || {};
  const lines = [];

  // Tampilkan info Etherscan V2
  lines.push(`[Etherscan V2 API — chainid=${cfg.chainId || 'N/A'} | key: ${ETHERSCAN_KEY ? 'ada' : '❌ tidak di-set'}]`);

  for (const address of addresses.slice(0, 2)) {
    lines.push(`\n${'═'.repeat(70)}`);
    lines.push(`CONTRACT: ${address}`);
    lines.push(`CHAIN: ${cfg.name || chain} (chainId=${cfg.chainId || 'N/A'}) | ${cfg.explorer}/address/${address}`);
    lines.push('═'.repeat(70));

    // Fetch semua data secara paralel
    const [gecko, geckoPools, dex, src, creator, abi, holders, launchInfo] = await Promise.all([
      fetchGeckoTerminal(address, chain),
      fetchGeckoPools(address, chain),
      fetchDexScreener(address),
      fetchContractSource(address, chain),
      fetchCreatorInfo(address, chain),
      fetchContractAbi(address, chain),
      fetchTopHolders(address, chain),
      // Bankr/DexScreener launch info
      (async () => {
        const pairs = await fetchDexScreener(address);
        const p = pairs?.find((x) => x.chainId === cfg.dexId) || pairs?.[0];
        return p ? { boosts: p.boosts?.active, pairCreatedAt: p.pairCreatedAt, twitter: p.info?.socials?.find((s) => s.type === 'twitter')?.url, website: p.info?.websites?.[0]?.url } : null;
      })(),
    ]);

    // eth_call reads (Clanker-specific)
    const [allData, isVerified, totalSupplyRaw, owner] = await Promise.all([
      readAllData(address, chain),
      readIsVerified(address, chain),
      readTotalSupply(address, chain),
      readOwner(address, chain),
    ]);
    const decimals = 18;
    const totalSupplyHuman = totalSupplyRaw ? Number(totalSupplyRaw / BigInt(10 ** decimals)).toLocaleString('en-US') : null;

    // Deployer forensics
    const deployerActivity = creator?.contractCreator ? await fetchDeployerActivity(creator.contractCreator, chain) : null;

    // Symbol untuk off-chain intel
    const sym = gecko?.symbol || dex?.[0]?.baseToken?.symbol || address.slice(0, 8);
    const name = gecko?.name || dex?.[0]?.baseToken?.name || '';

    // Off-chain intel + bytecode classify — paralel
    const [offChain, ...holderTypes] = await Promise.all([
      runOffChainIntel(sym, name),
      ...(holders?.slice(0, 10) || []).map((h) => classifyAddress(h.TokenHolderAddress, chain)),
    ]);
    (holders || []).slice(0, 10).forEach((h, i) => { h._type = holderTypes[i]; });

    // Score
    const { flags, score, verdict, confidence } = scoreRedFlags({ gecko, dex, src, abi, creator, holders, deployerActivity, allData, isVerified, launchInfo, offChain, chain });

    const bestPair = dex?.find((p) => p.chainId === cfg.dexId) || dex?.[0];

    // ── Verdict ──
    lines.push(`\n🏁 VERDICT: ${verdict} RISK — Confidence ${confidence}% | Red Flag Score: ${score}`);

    // ── Market data ──
    lines.push('\n📊 [MARKET DATA]');
    if (gecko) {
      lines.push(`  Nama:       ${gecko.name} (${gecko.symbol})`);
      lines.push(`  Harga:      ${fmtPrice(gecko.price_usd)}`);
      lines.push(`  Market Cap: ${fmtNum(gecko.market_cap_usd)} | FDV: ${fmtNum(gecko.fdv_usd)}`);
      lines.push(`  Volume 24h: ${fmtNum(gecko.volume_usd?.h24)}`);
      const pc = gecko.price_change_percentage;
      if (pc) lines.push(`  Perubahan:  1h=${pc.h1 || 'N/A'}%  24h=${pc.h24 || 'N/A'}%  7d=${pc.d7 || 'N/A'}%`);
      if (gecko.gt_score != null) lines.push(`  GT Score:   ${gecko.gt_score}/100`);
    } else if (bestPair) {
      lines.push(`  Nama:       ${bestPair.baseToken?.name} (${bestPair.baseToken?.symbol}) [DexScreener]`);
      lines.push(`  Harga:      ${fmtPrice(bestPair.priceUsd)} | MCap: ${fmtNum(bestPair.marketCap)}`);
      lines.push(`  Volume 24h: ${fmtNum(bestPair.volume?.h24)} | Perubahan: ${bestPair.priceChange?.h24}%`);
    } else {
      lines.push('  ❌ Tidak ditemukan di GeckoTerminal maupun DexScreener');
    }
    if (bestPair) {
      lines.push(`  Likuiditas: ${fmtNum(bestPair.liquidity?.usd)} | DEX: ${bestPair.dexId}`);
      lines.push(`  DexScreener: ${bestPair.url || 'N/A'}`);
      if (bestPair.pairCreatedAt) lines.push(`  Pool dibuat: ${new Date(bestPair.pairCreatedAt).toISOString().split('T')[0]}`);
      if (bestPair.info?.websites?.[0]) lines.push(`  Website:     ${bestPair.info.websites[0].url}`);
      if (bestPair.info?.socials?.length) lines.push(`  Socials:     ${bestPair.info.socials.map((s) => s.type + ':' + s.url).join(' | ')}`);
    }
    lines.push(`  GeckoTerminal: https://www.geckoterminal.com/${cfg.geckoId}/tokens/${address}`);

    // ── Pools ──
    if (geckoPools.length > 0) {
      lines.push('\n💧 [LIQUIDITY POOLS]');
      geckoPools.slice(0, 3).forEach((p, i) => {
        const a = p.attributes;
        lines.push(`  #${i + 1} ${a?.name || 'N/A'} | Liq: ${fmtNum(a?.reserve_in_usd)} | Vol24h: ${fmtNum(a?.volume_usd?.h24)}${a?.security_indicators?.length ? ' | ⚠️ ' + a.security_indicators.join(',') : ''}`);
      });
    }

    // ── On-chain reads ──
    lines.push('\n🔗 [ON-CHAIN READS — Etherscan V2 eth_call]');
    if (allData) {
      lines.push(`  originalAdmin: ${allData.originalAdmin}`);
      lines.push(`  admin:         ${allData.admin}`);
      lines.push(`  Admin berubah: ${allData.originalAdmin !== allData.admin ? '⚠️ YA (handoff)' : 'tidak'}`);
      lines.push(`  metadata:      ${allData.metadata?.slice(0, 150) || '❌ kosong'}`);
      lines.push(`  context:       ${allData.context?.slice(0, 100) || '❌ kosong'}`);
      lines.push(`  image:         ${allData.image ? '✅ ada' : '❌ kosong'}`);
    } else {
      lines.push('  allData(): N/A (bukan Clanker token atau API key tidak ada)');
    }
    if (isVerified !== null) lines.push(`  isVerified():  ${isVerified ? '✅ true' : '❌ false'}`);
    if (totalSupplyHuman) lines.push(`  totalSupply(): ${totalSupplyHuman}`);
    if (owner) lines.push(`  owner():       ${owner}`);

    // ── Contract source ──
    lines.push('\n📄 [CONTRACT — Etherscan V2]');
    const srcInfo = src?.[0];
    if (srcInfo) {
      const verified = srcInfo.ABI !== 'Contract source code not verified' && !!srcInfo.SourceCode;
      lines.push(`  Verified:  ${verified ? '✅ YES' : '❌ NO'} | Nama: ${srcInfo.ContractName || 'N/A'} | Compiler: ${srcInfo.CompilerVersion || 'N/A'}`);
      lines.push(`  Proxy:     ${srcInfo.Proxy === '1' ? '⚠️ YES (impl: ' + (srcInfo.Implementation || 'unknown') + ')' : 'NO'}`);
    } else {
      lines.push('  Tidak tersedia (butuh ETHERSCAN_API_KEY atau kontrak unverified)');
    }

    // ── ABI ──
    if (abi?.length) {
      const bad = abi.filter((f) => f.dangerous);
      lines.push('\n⚙️  [ABI FUNCTIONS]');
      if (bad.length) lines.push(`  ⚠️ DANGEROUS: ${bad.map((f) => f.sig).join(' | ')}`);
      lines.push(`  OTHER: ${abi.filter((f) => !f.dangerous).slice(0, 8).map((f) => f.sig).join(' | ')}`);
    } else {
      lines.push('\n⚙️  [ABI FUNCTIONS] Tidak tersedia (unverified)');
    }

    // ── Deployer forensics ──
    lines.push('\n👤 [DEPLOYER FORENSICS — Etherscan V2 txlist]');
    if (creator) lines.push(`  Deployer: ${creator.contractCreator} | TX: ${cfg.explorer}/tx/${creator.txHash}`);
    if (deployerActivity) {
      lines.push(`  Nonce: ${deployerActivity.nonce} (${deployerActivity.freshWallet ? '⚠️ FRESH WALLET' : 'established'})`);
      lines.push(`  Pertama aktif: ${deployerActivity.firstTxDate} | Didanai oleh: ${deployerActivity.fundedBy}`);
      if (deployerActivity.largeOutCount > 0) lines.push(`  ⚠️ ${deployerActivity.largeOutCount} transfer ETH besar keluar dari deployer`);
    } else {
      lines.push('  Tidak tersedia (butuh ETHERSCAN_API_KEY)');
    }

    // ── Top holders ──
    lines.push('\n👥 [TOP HOLDERS — bytecode classification]');
    if (holders?.length) {
      const poolSet = new Set([bestPair?.pairAddress?.toLowerCase(), UNISWAP_V4_BASE].filter(Boolean));
      let nonPoolConc = 0; let poolConc = 0;
      holders.slice(0, 15).forEach((h, i) => {
        const addr = h.TokenHolderAddress?.toLowerCase();
        const isPool = poolSet.has(addr);
        const isInfra = KNOWN_INFRA.has(addr);
        const pct = h.TotalSupply ? (parseFloat(h.TokenHolderQuantity) / parseFloat(h.TotalSupply) * 100).toFixed(2) : '?';
        const tag = isPool ? '[POOL]' : isInfra ? '[INFRA]' : (h._type !== 'eoa' ? `[${h._type}]` : '[EOA]');
        lines.push(`  ${String(i + 1).padStart(2)}. ${h.TokenHolderAddress} — ${pct}% ${tag}`);
        if (isPool || isInfra) poolConc += parseFloat(pct); else nonPoolConc += parseFloat(pct);
      });
      lines.push(`  Pool/DEX: ~${poolConc.toFixed(1)}% | Non-pool top-holders: ${nonPoolConc.toFixed(1)}% ${nonPoolConc > 50 ? '⚠️ TINGGI' : nonPoolConc > 30 ? '🟡 SEDANG' : '✅ OK'}`);
    } else {
      lines.push('  Tidak tersedia (butuh ETHERSCAN_API_KEY)');
    }

    // ── Off-chain intel ──
    lines.push('\n🌐 [OFF-CHAIN INTEL — DuckDuckGo]');
    lines.push(`  ZachXBT: ${offChain?.zachMentioned ? '⚠️ YA' : 'tidak'} | CEX investigation: ${offChain?.cexInvestigation ? '⚠️ YA' : 'tidak'} | Rug/scam keywords: ${offChain?.rugged ? '⚠️ YA' : 'tidak'}`);
    if (offChain?.raw) lines.push(`  Coverage snippet:\n  ${offChain.raw.split('\n').slice(0, 4).join('\n  ')}`);

    // ── Red flags ──
    lines.push(`\n🚩 [RED FLAG CHECKLIST — Score: ${score}]`);
    if (!flags.length) lines.push('  ✅ Tidak ada red flag terdeteksi dari data yang tersedia');
    else flags.forEach((f) => lines.push(`  ⚠️ [${f.cat}] ${f.msg}`));
    lines.push(`\n  → VERDICT: ${verdict} RISK | Confidence: ${confidence}% | Score: ${score}/30+`);
    if (score >= 5) lines.push('  → Score ≥5: HIGH/EXTREME risk threshold sesuai Bankr checklist');
  }

  return lines.join('\n');
}

// ─── Bankr-style system prompt ────────────────────────────────────────────────
const SKILL_SYSTEM = `
Kamu menjalankan TOKEN SCAM / RUG-PULL ANALYSIS SKILL — implementasi penuh Bankr forensic methodology.

Data sudah dikumpulkan dari: GeckoTerminal, DexScreener, Etherscan V2 API (satu key untuk semua EVM chain via chainid param), eth_call on-chain reads, deployer forensics txlist, holder bytecode classification, dan off-chain intel DuckDuckGo.

PRINSIP INTI:
- Narrative is noise. On-chain state is signal.
- On-chain clean ≠ tidak scam. Insider manipulation bisa pakai kontrak bersih.
- Jangan anggap Uniswap PoolManager sebagai whale — itu pool DEX.
- Jangan flag bytecode sama saat redeploy — factory template memang identik.
- WAJIB jalankan off-chain intel sebelum verdict — data sudah tersedia di atas.

FORMAT LAPORAN (ikuti persis):

**🔍 TL;DR VERDICT: [LOW/MEDIUM/HIGH/EXTREME] RISK — Confidence [X]%**
[Satu kalimat reasoning on-chain + off-chain]

---
**📊 Contracts Under Analysis**
| Field | Value |
|---|---|
[table lengkap: address, chain, deployer, admin, supply, isVerified, contract verified, market cap, likuiditas]

---
**🌐 Off-Chain Intel**
- ZachXBT flagged: [ya/tidak]
- CEX investigation: [ya/tidak]
- Efek pada verdict: [bumped/no change]

---
**⚔️ Claim vs Reality**
[setiap klaim tim vs on-chain fact vs apa yang bisa dilakukan tanpa redeploy]

---
**👤 Deployer Forensics**
[funding → deploy → extraction lifecycle]

---
**👥 Holder Distribution**
[pool excluded, non-pool concentration, EOA vs sniper_proxy vs contract]

---
**⚙️ Contract Red Flags**
[fungsi berbahaya + alasan, allData anomalies, proxy risks]

---
**🧠 Economic Irrationality Test**
[apa yang harusnya dilakukan tim legit vs yang benar-benar dilakukan]

---
**🎭 Pattern Match**
[Clanker redeploy dump / sniper relaunch / CEX pump treasury / self-funded MM?]

---
**🔄 Apa yang Ubah Verdict**
[fakta yang akan turunkan / naikkan risk score]

---
**🔗 Sources**
[link explorer semua contract & wallet]

---
Gunakan Bahasa Indonesia. Hanya gunakan data yang tersedia — jangan mengarang.
Di akhir berikan summary 4-6 bullet untuk user.
NFA. DYOR.
`;

// ─── Entrypoint ───────────────────────────────────────────────────────────────
async function runScamAnalysis(question) {
  const addresses = extractContractAddresses(question);
  const chain = detectChain(question);
  let onChainData = '';
  try {
    onChainData = await buildOnChainContext(addresses, chain);
  } catch (err) {
    onChainData = `[Error fetch data: ${err.message}]`;
  }
  const fullPrompt = [
    SKILL_SYSTEM,
    '\n\n═══════════════════════════════════════════════════════',
    '[DATA REAL-TIME — ETHERSCAN V2 + GECKOTERMINAL + DEXSCREENER + OFFCHAIN]',
    '═══════════════════════════════════════════════════════',
    onChainData,
    '\n═══════════════════════════════════════════════════════',
    '[PERTANYAAN USER]',
    '═══════════════════════════════════════════════════════',
    question,
    '\nBuat laporan analisis lengkap sesuai format Bankr di atas. Bahasa Indonesia.',
  ].join('\n');
  return { applicable: true, addresses, chain, fullPrompt };
}

module.exports = { isScamAnalysisRequest, runScamAnalysis };
