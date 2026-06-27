// lib/tokenScamAnalysis.js
// Token scam/rug-pull analysis — full Bankr skill spec implementation
//
// Data sources:
//   GeckoTerminal  — market data (free, no key)
//   DexScreener    — pairs, socials, liquidity (free, no key)
//   Etherscan/Basescan/etc — contract source, ABI, creator, holders, bytecode, txlist
//   Etherscan eth_call — on-chain reads: allData(), isVerified(), totalSupply(), balanceOf()
//   DuckDuckGo     — off-chain intel: ZachXBT mentions, CEX investigations (free)
//
// Interface (unchanged):
//   isScamAnalysisRequest(question) → boolean
//   runScamAnalysis(question)       → { applicable, addresses, chain, fullPrompt }

'use strict';
const axios = require('axios');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Chain config ─────────────────────────────────────────────────────────────
const CHAIN_CONFIG = {
  eth: {
    name: 'Ethereum', geckoId: 'eth', dexId: 'ethereum',
    apiBase: 'https://api.etherscan.io/api',
    apiKey: process.env.ETHERSCAN_API_KEY || '',
    explorer: 'https://etherscan.io',
    viemChain: 'mainnet', lzEid: 30101,
  },
  base: {
    name: 'Base', geckoId: 'base', dexId: 'base',
    apiBase: 'https://api.basescan.org/api',
    apiKey: process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || '',
    explorer: 'https://basescan.org',
    viemChain: 'base', lzEid: 30184,
  },
  bsc: {
    name: 'BNB Chain', geckoId: 'bsc', dexId: 'bsc',
    apiBase: 'https://api.bscscan.com/api',
    apiKey: process.env.BSCSCAN_API_KEY || '',
    explorer: 'https://bscscan.com',
    viemChain: 'bsc', lzEid: 30102,
  },
  polygon: {
    name: 'Polygon', geckoId: 'polygon_pos', dexId: 'polygon',
    apiBase: 'https://api.polygonscan.com/api',
    apiKey: process.env.POLYGONSCAN_API_KEY || '',
    explorer: 'https://polygonscan.com',
    viemChain: 'polygon', lzEid: 30109,
  },
  arbitrum: {
    name: 'Arbitrum', geckoId: 'arbitrum', dexId: 'arbitrum',
    apiBase: 'https://api.arbiscan.io/api',
    apiKey: process.env.ARBISCAN_API_KEY || '',
    explorer: 'https://arbiscan.io',
    viemChain: 'arbitrum', lzEid: 30110,
  },
  optimism: {
    name: 'Optimism', geckoId: 'optimism', dexId: 'optimism',
    apiBase: 'https://api-optimistic.etherscan.io/api',
    apiKey: process.env.OPTIMISM_API_KEY || process.env.ETHERSCAN_API_KEY || '',
    explorer: 'https://optimistic.etherscan.io',
    viemChain: 'optimism', lzEid: 30111,
  },
  solana: {
    name: 'Solana', geckoId: 'solana', dexId: 'solana',
    apiBase: null, apiKey: '', explorer: 'https://solscan.io',
    viemChain: null, lzEid: null,
  },
};

// Known pool/DEX addresses that should NOT count as whale holders
const KNOWN_POOL_PREFIXES = ['0x498581ff718922c3f8e6a244956af099b2652b2b']; // Uniswap v4 PoolManager Base
const KNOWN_INFRA = new Set([
  '0x000000000000000000000000000000000000dead', // burn
  '0x0000000000000000000000000000000000000000', // zero
]);

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
  if (/\beth(ereum)?\b/.test(t)) return 'eth';
  return 'base';
}

function isScamAnalysisRequest(question) {
  const addrs = extractContractAddresses(question);
  if (addrs.length === 0) return false;
  if (SCAM_KEYWORDS.some((kw) => kw.test(question))) return true;
  const stripped = question.replace(/0x[a-fA-F0-9]{40}/g, '').trim();
  return stripped.length < 30;
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmtNum(n) {
  if (n == null || n === '') return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num)) return String(n);
  if (num >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return '$' + (num / 1e3).toFixed(2) + 'K';
  return '$' + num.toFixed(4);
}
function fmtPrice(n) {
  if (n == null || n === '') return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num)) return String(n);
  if (num < 0.000001) return '$' + num.toExponential(4);
  if (num < 0.01) return '$' + num.toFixed(8);
  if (num < 1) return '$' + num.toFixed(6);
  return '$' + num.toFixed(4);
}
function fmtAddr(addr) {
  if (!addr) return 'N/A';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

// ─── ABI decoding helpers ─────────────────────────────────────────────────────
function decodeHexAddress(hex32) {
  // hex32 is 64 hex chars (32 bytes). Address is last 40 hex chars.
  return '0x' + hex32.slice(24).toLowerCase();
}
function decodeHexUint256(hex32) {
  return BigInt('0x' + hex32);
}
function decodeHexString(fullHex, byteOffset) {
  // byteOffset is in bytes from start of data
  const charOffset = byteOffset * 2;
  const lenHex = fullHex.slice(charOffset, charOffset + 64);
  const len = Number(BigInt('0x' + lenHex));
  if (len === 0) return '';
  const strHex = fullHex.slice(charOffset + 64, charOffset + 64 + len * 2);
  return Buffer.from(strHex, 'hex').toString('utf-8');
}

// Decode allData() → { originalAdmin, admin, image, metadata, context }
function decodeAllData(hexResult) {
  const hex = hexResult.startsWith('0x') ? hexResult.slice(2) : hexResult;
  if (hex.length < 320) return null;
  try {
    const originalAdmin = '0x' + hex.slice(24, 64).toLowerCase();
    const admin = '0x' + hex.slice(88, 128).toLowerCase();
    const offsetImage    = Number(BigInt('0x' + hex.slice(128, 192)));
    const offsetMetadata = Number(BigInt('0x' + hex.slice(192, 256)));
    const offsetContext  = Number(BigInt('0x' + hex.slice(256, 320)));
    const image    = decodeHexString(hex, offsetImage);
    const metadata = decodeHexString(hex, offsetMetadata);
    const context  = decodeHexString(hex, offsetContext);
    return { originalAdmin, admin, image, metadata, context };
  } catch {
    return null;
  }
}

// Decode bool return
function decodeBool(hexResult) {
  const hex = hexResult.startsWith('0x') ? hexResult.slice(2) : hexResult;
  return hex.slice(-1) === '1';
}

// Decode address return
function decodeAddressResult(hexResult) {
  const hex = hexResult.startsWith('0x') ? hexResult.slice(2) : hexResult;
  if (hex.length < 64) return null;
  return '0x' + hex.slice(24).toLowerCase();
}

// Decode uint256 return
function decodeUint256Result(hexResult) {
  const hex = hexResult.startsWith('0x') ? hexResult.slice(2) : hexResult;
  if (!hex || hex === '0'.repeat(64)) return BigInt(0);
  try { return BigInt('0x' + hex); } catch { return BigInt(0); }
}

// ─── Etherscan eth_call ───────────────────────────────────────────────────────
async function ethCall(chain, to, data, timeout = 8000) {
  const cfg = CHAIN_CONFIG[chain];
  if (!cfg?.apiBase) return null;
  try {
    const { data: resp } = await axios.get(cfg.apiBase, {
      params: { module: 'proxy', action: 'eth_call', to, data, tag: 'latest', apikey: cfg.apiKey },
      timeout,
    });
    if (resp.result && resp.result !== '0x') return resp.result;
    return null;
  } catch { return null; }
}

// Read allData() — Clanker v4 token
async function readAllData(address, chain) {
  const result = await ethCall(chain, address, '0x773a5096');
  if (!result) return null;
  return decodeAllData(result);
}

// Read isVerified() — Clanker platform verification
async function readIsVerified(address, chain) {
  const result = await ethCall(chain, address, '0xe8d5ce15');
  if (!result) return null;
  return decodeBool(result);
}

// Read totalSupply()
async function readTotalSupply(address, chain) {
  const result = await ethCall(chain, address, '0x18160ddd');
  if (!result) return null;
  return decodeUint256Result(result);
}

// Read decimals()
async function readDecimals(address, chain) {
  const result = await ethCall(chain, address, '0x313ce567');
  if (!result) return 18;
  return Number(decodeUint256Result(result));
}

// Read owner()
async function readOwner(address, chain) {
  const result = await ethCall(chain, address, '0x8da5cb5b');
  if (!result) return null;
  return decodeAddressResult(result);
}

// Read admin() — Clanker simple admin
async function readAdmin(address, chain) {
  // admin() selector = keccak256("admin()")[0:4] = 0xf851a440
  const result = await ethCall(chain, address, '0xf851a440');
  if (!result) return null;
  return decodeAddressResult(result);
}

// Read balanceOf(address)
async function readBalanceOf(tokenAddress, walletAddress, chain) {
  if (!walletAddress || walletAddress === '0x0000000000000000000000000000000000000000') return BigInt(0);
  const selector = '0x70a08231';
  const paddedAddr = walletAddress.slice(2).padStart(64, '0');
  const result = await ethCall(chain, tokenAddress, selector + paddedAddr);
  if (!result) return BigInt(0);
  return decodeUint256Result(result);
}

// ─── Clanker reward ownership ─────────────────────────────────────────────────
// getClankerRewardOwnership(address, chain):
// Tries to read rewardRecipients() or teamAllocation() from the token.
// Falls back to reading factory event if possible.
// Returns array of { admin, recipient } or null.
async function getClankerRewardOwnership(address, chain) {
  // Try getRewardRecipients() selector = 0x... (placeholder – Clanker API)
  // We'll check DexScreener token info for team/reward data
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 8000 });
    const pairs = data?.pairs || [];
    const pair = pairs.find((p) => p.chainId === CHAIN_CONFIG[chain]?.dexId) || pairs[0];
    if (!pair) return null;
    // DexScreener sometimes includes lock info
    const locks = pair?.liquidity?.locks || [];
    return { locks, teamUrl: pair?.profile?.links?.find((l) => l.type === 'twitter')?.url || null };
  } catch { return null; }
}

// ─── GeckoTerminal ────────────────────────────────────────────────────────────
async function fetchGeckoTerminal(address, chain) {
  const geckoChain = CHAIN_CONFIG[chain]?.geckoId || chain;
  try {
    const { data } = await axios.get(
      `https://api.geckoterminal.com/api/v2/networks/${geckoChain}/tokens/${address}`,
      { headers: { Accept: 'application/json' }, timeout: 10000 },
    );
    return data?.data?.attributes || null;
  } catch { return null; }
}

async function fetchGeckoPools(address, chain) {
  const geckoChain = CHAIN_CONFIG[chain]?.geckoId || chain;
  try {
    const { data } = await axios.get(
      `https://api.geckoterminal.com/api/v2/networks/${geckoChain}/tokens/${address}/pools?page=1`,
      { headers: { Accept: 'application/json' }, timeout: 10000 },
    );
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

// ─── Etherscan explorer helpers ───────────────────────────────────────────────
async function explorerGet(chain, params, timeout = 10000) {
  const cfg = CHAIN_CONFIG[chain];
  if (!cfg?.apiBase) return null;
  try {
    const { data } = await axios.get(cfg.apiBase, {
      params: { ...params, apikey: cfg.apiKey },
      timeout,
    });
    if (data.status === '1' && data.result) return data.result;
    if (data.result === 'Contract source code not verified') return data.result;
    return null;
  } catch { return null; }
}

async function fetchContractSource(address, chain) {
  return explorerGet(chain, { module: 'contract', action: 'getsourcecode', address });
}

async function fetchCreatorInfo(address, chain) {
  const r = await explorerGet(chain, { module: 'contract', action: 'getcontractcreation', contractaddresses: address });
  return r && r[0] ? r[0] : null;
}

async function fetchContractAbi(address, chain) {
  const result = await explorerGet(chain, { module: 'contract', action: 'getabi', address });
  if (!result || result === 'Contract source code not verified') return null;
  try {
    const abi = JSON.parse(result);
    const DANGEROUS = ['mint', 'crosschainmint', 'setowner', 'updateadmin', 'blacklist',
      'setfee', 'pause', 'updateimage', 'updatemetadata', 'setpeer', 'setminter',
      'setenforcedoptions', 'addliquidity', 'burn', 'freeze'];
    return abi.filter((i) => i.type === 'function').map((i) => {
      const name = i.name || '';
      const dangerous = DANGEROUS.some((d) => name.toLowerCase().includes(d));
      return {
        name,
        sig: `${name}(${(i.inputs || []).map((x) => x.type).join(',')})`,
        mutability: i.stateMutability || i.type,
        dangerous,
      };
    });
  } catch { return null; }
}

async function fetchTopHolders(address, chain) {
  return explorerGet(chain, {
    module: 'token', action: 'tokenholderlist',
    contractaddress: address, page: 1, offset: 20,
  });
}

// ─── Bytecode classification ──────────────────────────────────────────────────
// Returns: 'eoa' | 'sniper_proxy' | 'contract' | 'safe_multisig'
async function classifyAddress(address, chain) {
  const result = await explorerGet(chain, { module: 'proxy', action: 'eth_getCode', address, tag: 'latest' });
  if (!result || result === '0x' || result === '0x0') return 'eoa';
  const hexLen = result.replace('0x', '').length / 2;
  if (hexLen === 48) return 'sniper_proxy'; // EIP-7702 / minimal proxy pattern
  // Check for Gnosis Safe signature (version() returns something)
  if (result.toLowerCase().includes('6080604052')) {
    // Check if it's a Safe: Safe bytecode contains specific patterns
    if (result.toLowerCase().includes('1901') && hexLen > 5000) return 'safe_multisig';
    return 'contract';
  }
  return 'contract';
}

// ─── Deployer tx history / forensics ─────────────────────────────────────────
async function fetchDeployerActivity(deployerAddress, chain) {
  if (!deployerAddress) return null;
  const txs = await explorerGet(chain, {
    module: 'account', action: 'txlist',
    address: deployerAddress,
    startblock: 0, endblock: 99999999,
    page: 1, offset: 50, sort: 'asc',
  }, 15000);
  if (!txs || !Array.isArray(txs)) return null;

  const nonce = txs.length;
  const firstTx = txs[0];
  const internalTxs = await explorerGet(chain, {
    module: 'account', action: 'txlistinternal',
    address: deployerAddress, page: 1, offset: 20, sort: 'asc',
  }, 10000);

  const fundingTx = internalTxs && Array.isArray(internalTxs) ? internalTxs[0] : null;

  // Look for value-extraction: large outgoing ETH transfers after deploy
  const outgoingAfterDeploy = txs.filter((tx) =>
    tx.from?.toLowerCase() === deployerAddress?.toLowerCase() &&
    BigInt(tx.value || 0) > BigInt('50000000000000000') // >0.05 ETH
  );

  return {
    nonce,
    firstTxHash: firstTx?.hash,
    firstTxAge: firstTx?.timeStamp ? new Date(parseInt(firstTx.timeStamp) * 1000).toISOString().split('T')[0] : 'N/A',
    fundedBy: fundingTx?.from || 'N/A',
    fundingTxHash: fundingTx?.hash,
    largOutgoing: outgoingAfterDeploy.length,
    freshWallet: nonce <= 5,
  };
}

// ─── Token launch info (Bankr/Doppler) ───────────────────────────────────────
async function getTokenLaunchInfo(address, chain) {
  // Try Bankr API first
  try {
    const { data } = await axios.get(`https://api.bankr.bot/tokens/${address}`, { timeout: 6000 });
    if (data && data.deployer) return { source: 'bankr', ...data };
  } catch { /* not a bankr token */ }

  // Try DexScreener for launch metadata
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 8000 });
    const pairs = (data?.pairs || []);
    const pair = pairs.find((p) => p.chainId === CHAIN_CONFIG[chain]?.dexId) || pairs[0];
    if (pair) {
      return {
        source: 'dexscreener',
        pairCreatedAt: pair.pairCreatedAt,
        dex: pair.dexId,
        twitter: pair.info?.socials?.find((s) => s.type === 'twitter')?.url,
        website: pair.info?.websites?.[0]?.url,
        boosts: pair.boosts?.active,
      };
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Off-chain intel (DuckDuckGo) ────────────────────────────────────────────
async function ddgSearch(query) {
  try {
    const { data } = await axios.get('https://api.duckduckgo.com/', {
      params: { q: query, format: 'json', no_html: '1', skip_disambig: '1' },
      timeout: 8000,
    });
    const results = [];
    if (data.Abstract) results.push(data.Abstract);
    if (data.RelatedTopics) {
      data.RelatedTopics.slice(0, 5).forEach((t) => {
        if (t.Text) results.push(t.Text.slice(0, 200));
      });
    }
    return results.join('\n').slice(0, 800);
  } catch { return null; }
}

async function runOffChainIntel(symbol, tokenName) {
  const queries = [
    `"${symbol}" ${tokenName} scam rug investigation`,
    `ZachXBT "${symbol}" manipulation`,
    `"${symbol}" pump dump exchange investigation 2025 2026`,
  ];
  const results = await Promise.all(queries.map(ddgSearch));
  const combined = results.filter(Boolean).join('\n\n');
  const zachMentioned = combined.toLowerCase().includes('zachxbt');
  const cexInvestigation = /bitget|binance|okx|gate\.|kraken|bybit.*investigat/i.test(combined);
  const rugged = /rug|scam|fraud|exit.*scam/i.test(combined);
  return {
    raw: combined.slice(0, 1200),
    zachMentioned,
    cexInvestigation,
    rugged,
    clean: !zachMentioned && !cexInvestigation && !rugged,
  };
}

// ─── Red flag scorer ──────────────────────────────────────────────────────────
function scoreRedFlags(data) {
  const flags = [];
  const { gecko, dex, src, abi, creator, holders, deployerActivity,
          allData, isVerified, launchInfo, offChain, chain } = data;

  const cfg = CHAIN_CONFIG[chain] || {};

  // ── Market flags ──
  if (!gecko && !dex) flags.push({ cat: 'MARKET', msg: 'Tidak terdaftar di GeckoTerminal maupun DexScreener' });

  const bestPair = dex?.find((p) => p.chainId === cfg.dexId) || dex?.[0];
  const liquidity = parseFloat(bestPair?.liquidity?.usd || 0);
  if (liquidity > 0 && liquidity < 10000) flags.push({ cat: 'MARKET', msg: `Likuiditas sangat rendah ($${liquidity.toFixed(0)}) — mudah dimanipulasi` });

  const change24h = parseFloat(bestPair?.priceChange?.h24 || 0);
  if (change24h > 500) flags.push({ cat: 'MARKET', msg: `Harga naik ekstrem ${change24h.toFixed(0)}% dalam 24h tanpa fundamental jelas` });

  const pairAge = bestPair?.pairCreatedAt;
  const ageHours = pairAge ? (Date.now() - pairAge) / 3600000 : null;
  if (ageHours !== null && ageHours < 24) flags.push({ cat: 'MARKET', msg: `Token sangat baru — pool dibuat ${ageHours.toFixed(1)} jam lalu` });

  if (launchInfo?.boosts > 0) flags.push({ cat: 'MARKET', msg: `DexScreener boosts aktif (${launchInfo.boosts}x) — bisa beli perhatian artifisial` });

  // ── Contract flags ──
  const srcInfo = src && src[0];
  const isContractVerified = srcInfo && srcInfo.ABI !== 'Contract source code not verified' && srcInfo.SourceCode;
  if (!isContractVerified) flags.push({ cat: 'CONTRACT', msg: 'Kontrak TIDAK diverifikasi di explorer (source code tidak tersedia)' });
  if (srcInfo?.Proxy === '1') flags.push({ cat: 'CONTRACT', msg: `Proxy/upgradeable contract (implementation: ${srcInfo.Implementation || 'unknown'})` });

  if (abi) {
    const dangerousFns = abi.filter((f) => f.dangerous);
    if (dangerousFns.length > 0) {
      flags.push({ cat: 'CONTRACT', msg: `Fungsi berbahaya ditemukan: ${dangerousFns.map((f) => f.name).join(', ')}` });
    }
    const hasMint = abi.some((f) => f.name?.toLowerCase() === 'mint');
    if (hasMint) flags.push({ cat: 'CONTRACT', msg: 'Fungsi mint() ada dan bisa dipanggil — risiko inflasi supply' });
    const hasBlacklist = abi.some((f) => f.name?.toLowerCase().includes('blacklist'));
    if (hasBlacklist) flags.push({ cat: 'CONTRACT', msg: 'Fungsi blacklist() ada — admin bisa membekukan wallet holder' });
    const hasPause = abi.some((f) => f.name?.toLowerCase() === 'pause');
    if (hasPause) flags.push({ cat: 'CONTRACT', msg: 'Fungsi pause() ada — admin bisa hentikan semua transfer' });
  }

  // ── Clanker-specific flags ──
  if (allData) {
    if (allData.originalAdmin && allData.admin &&
        allData.originalAdmin.toLowerCase() !== allData.admin.toLowerCase()) {
      flags.push({ cat: 'CLANKER', msg: `Admin handoff terdeteksi: originalAdmin=${fmtAddr(allData.originalAdmin)} → admin=${fmtAddr(allData.admin)}` });
    }
    if (!allData.metadata || allData.metadata.length < 10) {
      flags.push({ cat: 'CLANKER', msg: 'allData() metadata kosong — tidak ada audit/socials yang diset saat deploy' });
    }
    if (!allData.context) {
      flags.push({ cat: 'CLANKER', msg: 'allData() context kosong — platform deploy tidak diidentifikasi' });
    }
  }
  if (isVerified === false) flags.push({ cat: 'CLANKER', msg: 'isVerified() = false — platform Clanker belum verifikasi token ini' });

  // ── Deployer flags ──
  if (deployerActivity) {
    if (deployerActivity.freshWallet) {
      flags.push({ cat: 'DEPLOYER', msg: `Deployer wallet sangat baru (nonce=${deployerActivity.nonce}) — tidak ada history sebelumnya` });
    }
    if (deployerActivity.largOutgoing > 0) {
      flags.push({ cat: 'DEPLOYER', msg: `${deployerActivity.largOutgoing} transfer ETH besar keluar dari deployer setelah deploy — indikasi ekstraksi nilai` });
    }
    if (!deployerActivity.fundedBy || deployerActivity.fundedBy === 'N/A') {
      flags.push({ cat: 'DEPLOYER', msg: 'Sumber dana deployer tidak dapat ditelusuri' });
    }
  }

  // ── Holder flags ──
  if (holders && holders.length > 0) {
    const POOL_ADDRESSES = ['0x498581ff718922c3f8e6a244956af099b2652b2b']; // Uniswap v4 PoolManager Base
    const nonPool = holders.filter((h) =>
      !POOL_ADDRESSES.some((p) => h.TokenHolderAddress?.toLowerCase() === p) &&
      !KNOWN_INFRA.has(h.TokenHolderAddress?.toLowerCase())
    );

    const totalSupplyNum = parseFloat(holders[0]?.TotalSupply || 0);
    if (totalSupplyNum > 0 && nonPool.length >= 3) {
      const top5pct = nonPool.slice(0, 5).reduce((sum, h) => {
        return sum + (parseFloat(h.TokenHolderQuantity) / totalSupplyNum * 100);
      }, 0);
      if (top5pct > 40) {
        flags.push({ cat: 'HOLDERS', msg: `Top 5 non-pool holder menguasai ${top5pct.toFixed(1)}% supply — konsentrasi sangat tinggi` });
      }
    }

    // Check for sniper proxies in top holders (flagged if classified)
    nonPool.slice(0, 10).forEach((h, i) => {
      if (h._type === 'sniper_proxy') {
        flags.push({ cat: 'HOLDERS', msg: `Holder #${i + 1} (${fmtAddr(h.TokenHolderAddress)}) terdeteksi sebagai sniper proxy (48-byte bytecode)` });
      }
    });
  }

  // ── Off-chain flags ──
  if (offChain) {
    if (offChain.zachMentioned) flags.push({ cat: 'OFFCHAIN', msg: '⚠️ ZachXBT disebut dalam coverage terkait token ini — perlu diperiksa langsung' });
    if (offChain.cexInvestigation) flags.push({ cat: 'OFFCHAIN', msg: '⚠️ Potensi investigasi CEX terdeteksi — risiko delisting/forced-unwind' });
    if (offChain.rugged) flags.push({ cat: 'OFFCHAIN', msg: 'Kata kunci "rug/scam/exit" ditemukan dalam coverage off-chain token ini' });
  }

  const score = flags.length;
  let verdict, confidence;
  if (score === 0) { verdict = 'LOW'; confidence = 80; }
  else if (score <= 2) { verdict = 'LOW-MEDIUM'; confidence = 70; }
  else if (score <= 4) { verdict = 'MEDIUM'; confidence = 65; }
  else if (score <= 6) { verdict = 'HIGH'; confidence = 75; }
  else { verdict = 'EXTREME'; confidence = 85; }

  // Bump for ZachXBT/CEX
  if (offChain?.zachMentioned || offChain?.cexInvestigation) {
    const map = { 'LOW': 'LOW-MEDIUM', 'LOW-MEDIUM': 'MEDIUM', 'MEDIUM': 'HIGH', 'HIGH': 'EXTREME', 'EXTREME': 'EXTREME' };
    verdict = map[verdict] || verdict;
    confidence = Math.min(confidence + 10, 95);
  }

  return { flags, score, verdict, confidence };
}

// ─── Main data fetcher ────────────────────────────────────────────────────────
async function buildOnChainContext(addresses, chain) {
  const cfg = CHAIN_CONFIG[chain];
  const lines = [];
  const allRedFlags = [];

  for (const address of addresses.slice(0, 2)) {
    lines.push(`\n${'═'.repeat(70)}`);
    lines.push(`CONTRACT: ${address}`);
    lines.push(`CHAIN: ${cfg?.name || chain} | Explorer: ${cfg?.explorer}/address/${address}`);
    lines.push('═'.repeat(70));

    // Parallel fetch — everything that doesn't depend on each other
    const [
      geckoData,
      geckoPools,
      dexPairs,
      contractSource,
      creatorInfo,
      abiFunctions,
      topHolders,
      launchInfo,
    ] = await Promise.all([
      fetchGeckoTerminal(address, chain),
      fetchGeckoPools(address, chain),
      fetchDexScreener(address),
      fetchContractSource(address, chain),
      fetchCreatorInfo(address, chain),
      fetchContractAbi(address, chain),
      fetchTopHolders(address, chain),
      getTokenLaunchInfo(address, chain),
    ]);

    // On-chain reads via eth_call
    const [allDataResult, isVerifiedResult, totalSupplyResult, ownerResult] = await Promise.all([
      readAllData(address, chain),
      readIsVerified(address, chain),
      readTotalSupply(address, chain),
      readOwner(address, chain),
    ]);

    const decimals = allDataResult ? 18 : await readDecimals(address, chain);

    // Deployer forensics (needs creatorInfo first)
    let deployerActivity = null;
    if (creatorInfo?.contractCreator) {
      deployerActivity = await fetchDeployerActivity(creatorInfo.contractCreator, chain);
    }

    // Token symbol/name for off-chain search
    const symbol = geckoData?.symbol || dexPairs?.[0]?.baseToken?.symbol || address.slice(0, 8);
    const tokenName = geckoData?.name || dexPairs?.[0]?.baseToken?.name || '';

    // Off-chain intel
    const offChain = await runOffChainIntel(symbol, tokenName);

    // Classify top holder addresses (bytecode check)
    const holderTypes = {};
    if (topHolders && Array.isArray(topHolders) && cfg?.apiBase) {
      const checkList = topHolders.slice(0, 10);
      const typeResults = await Promise.all(
        checkList.map((h) => classifyAddress(h.TokenHolderAddress, chain))
      );
      checkList.forEach((h, i) => { holderTypes[h.TokenHolderAddress?.toLowerCase()] = typeResults[i]; });
      checkList.forEach((h) => { h._type = holderTypes[h.TokenHolderAddress?.toLowerCase()]; });
    }

    // Score red flags
    const rfData = { gecko: geckoData, dex: dexPairs, src: contractSource, abi: abiFunctions,
      creator: creatorInfo, holders: topHolders, deployerActivity, allData: allDataResult,
      isVerified: isVerifiedResult, launchInfo, offChain, chain };
    const { flags, score, verdict, confidence } = scoreRedFlags(rfData);
    allRedFlags.push(...flags);

    // ── Format output ──
    const bestPair = dexPairs?.find((p) => p.chainId === cfg?.dexId) || dexPairs?.[0];
    const liquidity = parseFloat(bestPair?.liquidity?.usd || 0);
    const totalPoolPct = topHolders && bestPair?.pairAddress
      ? topHolders.filter((h) => h.TokenHolderAddress?.toLowerCase() === bestPair.pairAddress?.toLowerCase())
          .reduce((s, h) => s + parseFloat(h.TokenHolderQuantity || 0) / parseFloat(h.TotalSupply || 1) * 100, 0)
      : null;

    // Verdict
    lines.push(`\n🏁 VERDICT: ${verdict} RISK — Confidence ${confidence}%`);
    lines.push(`   Red Flag Score: ${score}/30+`);

    // Market data
    lines.push('\n📊 [MARKET DATA]');
    if (geckoData) {
      lines.push(`  Nama:        ${geckoData.name} (${geckoData.symbol})`);
      lines.push(`  Harga:       ${fmtPrice(geckoData.price_usd)}`);
      lines.push(`  Market Cap:  ${fmtNum(geckoData.market_cap_usd)}`);
      lines.push(`  FDV:         ${fmtNum(geckoData.fdv_usd)}`);
      lines.push(`  Volume 24h:  ${fmtNum(geckoData.volume_usd?.h24)}`);
      const pc = geckoData.price_change_percentage;
      if (pc) lines.push(`  Perubahan:   1h=${pc.h1 || 'N/A'}%  24h=${pc.h24 || 'N/A'}%  7d=${pc.d7 || 'N/A'}%`);
      if (geckoData.gt_score != null) lines.push(`  GT Score:    ${geckoData.gt_score}/100`);
    } else if (bestPair) {
      lines.push(`  Nama:        ${bestPair.baseToken?.name} (${bestPair.baseToken?.symbol}) [via DexScreener]`);
      lines.push(`  Harga:       ${fmtPrice(bestPair.priceUsd)}`);
      lines.push(`  Market Cap:  ${fmtNum(bestPair.marketCap)}`);
      lines.push(`  Volume 24h:  ${fmtNum(bestPair.volume?.h24)}`);
      lines.push(`  Perubahan:   ${bestPair.priceChange?.h24}% (24h)`);
    } else {
      lines.push('  ❌ Token TIDAK ditemukan di GeckoTerminal maupun DexScreener');
    }
    if (bestPair) {
      lines.push(`  Likuiditas:  ${fmtNum(bestPair.liquidity?.usd)}`);
      lines.push(`  DEX:         ${bestPair.dexId}`);
      lines.push(`  DexScreener: ${bestPair.url || 'https://dexscreener.com/' + bestPair.chainId + '/' + bestPair.pairAddress}`);
      if (bestPair.info?.websites?.[0]) lines.push(`  Website:     ${bestPair.info.websites[0].url}`);
      if (bestPair.info?.socials?.length) lines.push(`  Socials:     ${bestPair.info.socials.map((s) => s.type + ':' + s.url).join(' | ')}`);
      if (bestPair.pairCreatedAt) lines.push(`  Pool dibuat: ${new Date(bestPair.pairCreatedAt).toISOString().split('T')[0]}`);
    }
    lines.push(`  GeckoTerminal: https://www.geckoterminal.com/${cfg?.geckoId || chain}/tokens/${address}`);

    // Pools
    if (geckoPools.length > 0) {
      lines.push('\n💧 [LIQUIDITY POOLS — Top 3]');
      geckoPools.slice(0, 3).forEach((pool, i) => {
        const a = pool.attributes;
        lines.push(`  Pool ${i + 1}: ${a?.name || 'N/A'} | Likuiditas: ${fmtNum(a?.reserve_in_usd)} | Vol 24h: ${fmtNum(a?.volume_usd?.h24)}`);
        if (a?.security_indicators?.length > 0) lines.push(`    ⚠️ Security flags: ${a.security_indicators.join(', ')}`);
        if (a?.pool_created_at) lines.push(`    Dibuat: ${a.pool_created_at}`);
      });
    }

    // On-chain reads (Clanker)
    lines.push('\n🔗 [ON-CHAIN READS — eth_call]');
    if (allDataResult) {
      lines.push(`  originalAdmin: ${allDataResult.originalAdmin}`);
      lines.push(`  admin:         ${allDataResult.admin}`);
      lines.push(`  Admin berubah: ${allDataResult.originalAdmin?.toLowerCase() !== allDataResult.admin?.toLowerCase() ? '⚠️ YA (handoff terdeteksi)' : 'TIDAK'}`);
      lines.push(`  metadata:      ${allDataResult.metadata ? allDataResult.metadata.slice(0, 150) : '❌ KOSONG'}`);
      lines.push(`  context:       ${allDataResult.context ? allDataResult.context.slice(0, 100) : '❌ KOSONG'}`);
      lines.push(`  image:         ${allDataResult.image ? '✅ ada' : '❌ kosong'}`);
    } else {
      lines.push('  allData(): tidak tersedia (bukan Clanker token atau eth_call gagal)');
    }
    if (isVerifiedResult !== null) lines.push(`  isVerified():  ${isVerifiedResult ? '✅ TRUE' : '❌ FALSE'}`);
    if (totalSupplyResult !== null) {
      const supplyFmt = decimals ? Number(totalSupplyResult / BigInt(10 ** Math.min(decimals, 18))).toLocaleString('en-US') : totalSupplyResult.toString();
      lines.push(`  totalSupply(): ${supplyFmt}`);
    }
    if (ownerResult) lines.push(`  owner():       ${ownerResult}`);

    // Contract source
    lines.push('\n📄 [CONTRACT SOURCE]');
    const src = contractSource && contractSource[0];
    if (src) {
      const verified = src.ABI !== 'Contract source code not verified' && !!src.SourceCode;
      lines.push(`  Verified:   ${verified ? '✅ YES' : '❌ NO — source code TIDAK tersedia'}`);
      lines.push(`  Nama:       ${src.ContractName || 'N/A'}`);
      lines.push(`  Compiler:   ${src.CompilerVersion || 'N/A'}`);
      lines.push(`  Proxy:      ${src.Proxy === '1' ? '⚠️ YES — upgradeable' : 'NO'}`);
      if (src.Implementation) lines.push(`  Impl:       ${src.Implementation}`);
    } else {
      lines.push('  Tidak tersedia — butuh explorer API key atau kontrak tidak diverifikasi');
    }

    // ABI functions
    if (abiFunctions && abiFunctions.length > 0) {
      lines.push('\n⚙️  [CONTRACT FUNCTIONS — ⚠️ = berbahaya]');
      const dangerous = abiFunctions.filter((f) => f.dangerous);
      const safe = abiFunctions.filter((f) => !f.dangerous).slice(0, 10);
      if (dangerous.length) lines.push(`  DANGEROUS: ${dangerous.map((f) => '⚠️ ' + f.sig).join(' | ')}`);
      lines.push(`  OTHER: ${safe.map((f) => f.sig).join(' | ')} ${abiFunctions.length > 10 ? `... +${abiFunctions.length - 10} more` : ''}`);
    } else {
      lines.push('\n⚙️  [CONTRACT FUNCTIONS] Tidak tersedia (ABI unverified)');
    }

    // Deployer
    lines.push('\n👤 [DEPLOYER FORENSICS]');
    if (creatorInfo) {
      lines.push(`  Deployer:     ${creatorInfo.contractCreator}`);
      lines.push(`  Deploy TX:    ${cfg?.explorer}/tx/${creatorInfo.txHash}`);
      lines.push(`  Explorer:     ${cfg?.explorer}/address/${creatorInfo.contractCreator}`);
    }
    if (deployerActivity) {
      lines.push(`  Wallet nonce: ${deployerActivity.nonce} tx (${deployerActivity.freshWallet ? '⚠️ BARU/FRESH' : 'established'})`);
      lines.push(`  Pertama aktif:${deployerActivity.firstTxAge}`);
      lines.push(`  Didanai oleh: ${deployerActivity.fundedBy}`);
      if (deployerActivity.largOutgoing > 0) {
        lines.push(`  ⚠️ Transaksi ETH besar keluar: ${deployerActivity.largOutgoing} tx (indikasi ekstraksi nilai)`);
      }
    } else {
      lines.push('  Forensics tidak tersedia (butuh explorer API key)');
    }

    // Launch info (Bankr/Doppler)
    if (launchInfo) {
      lines.push('\n🚀 [TOKEN LAUNCH INFO]');
      lines.push(`  Source:     ${launchInfo.source}`);
      if (launchInfo.twitter) lines.push(`  Twitter:    ${launchInfo.twitter}`);
      if (launchInfo.website) lines.push(`  Website:    ${launchInfo.website}`);
      if (launchInfo.pairCreatedAt) lines.push(`  Launch:     ${new Date(launchInfo.pairCreatedAt).toISOString()}`);
      if (launchInfo.dex) lines.push(`  DEX:        ${launchInfo.dex}`);
    }

    // Holder distribution
    lines.push('\n👥 [TOP HOLDERS — dengan klasifikasi bytecode]');
    if (topHolders && Array.isArray(topHolders) && topHolders.length > 0) {
      const POOL_ADDRS = new Set([bestPair?.pairAddress?.toLowerCase()].filter(Boolean));
      const allHolders = topHolders.slice(0, 15);
      let nonPoolConc = 0;
      let poolConc = 0;

      allHolders.forEach((h, i) => {
        const addr = h.TokenHolderAddress?.toLowerCase();
        const isPool = POOL_ADDRS.has(addr) || KNOWN_POOL_PREFIXES.some((p) => addr?.startsWith(p.toLowerCase()));
        const isInfra = KNOWN_INFRA.has(addr);
        const qty = parseFloat(h.TokenHolderQuantity || 0);
        const total = parseFloat(h.TotalSupply || 1);
        const pct = total > 0 ? (qty / total * 100).toFixed(2) : '?';
        const typeLabel = h._type ? `[${h._type}]` : '';
        const poolLabel = isPool ? '[POOL/DEX]' : isInfra ? '[INFRA]' : '';
        lines.push(`  ${String(i + 1).padStart(2)}. ${h.TokenHolderAddress} — ${pct}% ${typeLabel} ${poolLabel}`);
        if (!isPool && !isInfra) nonPoolConc += parseFloat(pct);
        else poolConc += parseFloat(pct);
      });
      lines.push(`\n  Konsentrasi pool/DEX: ~${poolConc.toFixed(1)}%`);
      lines.push(`  Konsentrasi non-pool (top-${Math.min(15, allHolders.filter((h) => {
        const addr = h.TokenHolderAddress?.toLowerCase();
        const isPool = POOL_ADDRS.has(addr) || KNOWN_POOL_PREFIXES.some((p) => addr?.startsWith(p.toLowerCase()));
        return !isPool && !KNOWN_INFRA.has(addr);
      }).length)}): ${nonPoolConc.toFixed(1)}% ${nonPoolConc > 50 ? '⚠️ TINGGI' : nonPoolConc > 30 ? '🟡 SEDANG' : '✅ NORMAL'}`);
    } else {
      lines.push('  Tidak tersedia (butuh explorer API key untuk token ini)');
    }

    // Off-chain intel
    lines.push('\n🌐 [OFF-CHAIN INTEL — ZachXBT / CEX Investigation / Sentiment]');
    if (offChain?.raw) {
      lines.push(`  ZachXBT disebut: ${offChain.zachMentioned ? '⚠️ YA' : 'tidak'}`);
      lines.push(`  CEX Investigation: ${offChain.cexInvestigation ? '⚠️ YA' : 'tidak'}`);
      lines.push(`  Kata kunci rug/scam: ${offChain.rugged ? '⚠️ YA' : 'tidak'}`);
      lines.push(`  Ringkasan coverage:\n  ${offChain.raw.split('\n').slice(0, 5).join('\n  ')}`);
    } else {
      lines.push('  Tidak ada data off-chain yang bisa diambil');
    }

    // Red flags summary
    lines.push(`\n🚩 [RED FLAG CHECKLIST — Score: ${score}]`);
    if (flags.length === 0) {
      lines.push('  ✅ Tidak ada red flag yang terdeteksi dari data yang tersedia');
    } else {
      flags.forEach((f) => lines.push(`  ⚠️ [${f.cat}] ${f.msg}`));
    }
    lines.push(`\n  Verdict final: ${verdict} RISK (${confidence}% confidence)`);
    if (score >= 5) lines.push('  ⚠️ Score ≥5: HIGH/EXTREME risk threshold tercapai sesuai bankr checklist');
  }

  return lines.join('\n');
}

// ─── Full bankr-style system prompt ──────────────────────────────────────────
const SKILL_SYSTEM = `
Kamu sedang menjalankan TOKEN SCAM / RUG-PULL ANALYSIS SKILL — implementasi penuh Bankr forensic methodology.

Data real-time sudah dikumpulkan otomatis dari: GeckoTerminal, DexScreener, Etherscan eth_call (allData/isVerified/totalSupply), holder bytecode classification, deployer forensics, dan off-chain intel (ZachXBT / CEX coverage).

## PRINSIP INTI BANKR:
- **Narrative is noise. On-chain state is signal.** Setiap klaim tim harus dicek terhadap apa yang benar-benar terjadi on-chain.
- **On-chain cleanliness ≠ bukan scam.** Insider pump-and-dump bisa terjadi dengan kontrak yang bersih sempurna.
- Selalu jalankan off-chain intel sebelum verdict — data sudah disediakan di atas.
- Jangan anggap Uniswap PoolManager sebagai whale — itu pool DEX, exclud dari konsentrasi.
- Jangan flag "bytecode sama" saat redeploy sebagai red flag — factory template memang identik.

## FORMAT LAPORAN WAJIB (ikuti persis):

**🔍 TL;DR VERDICT: [LOW/MEDIUM/HIGH/EXTREME] RISK — Confidence [X]%**
[Satu kalimat reasoning yang mencakup on-chain + off-chain intel]

---
**📊 Contracts Under Analysis**
| Field | Value |
|---|---|
| Address | ... |
| Chain | ... |
| Deployer | ... |
| Admin (current) | ... |
| totalSupply | ... |
| isVerified (platform) | ... |
| Contract verified | ... |
| Vault/Airdrop extension | ... |
| Market Cap | ... |
| Likuiditas | ... |

---
**🌐 Off-Chain Intel & Coverage**
- ZachXBT flagged: [ya/tidak + detail jika ya]
- CEX investigation: [ya/tidak]
- Community sentiment: [ringkasan]
- Efek pada verdict: [bumped up/no change]

---
**⚔️ Claim vs Reality**
Untuk setiap klaim tim yang bisa diverifikasi:
- Klaim: [apa kata tim]
- On-chain: [apa yang terjadi di chain]
- Platform docs: [apa yang seharusnya bisa dilakukan tanpa redeploy]

---
**👤 Deployer Wallet Forensics**
- Funding source → deploy lifecycle → extraction (jika ada)
- Wallet nonce & age
- Fresh wallet atau established?

---
**👥 Holder Distribution**
- Identifikasi pool addresses dan exclud dari konsentrasi
- Top 5-10 real holders: % supply, wallet type (EOA/contract/sniper_proxy/safe_multisig)
- Non-pool concentration score

---
**⚙️ Contract-Level Red Flags**
- Fungsi berbahaya dengan alasan kenapa berbahaya
- allData() / isVerified() anomalies
- Proxy/upgradeable risks

---
**🧠 Economic Irrationality Test**
Apa yang SEHARUSNYA dilakukan tim legit? (vault, airdrop, multi-recipient rewards, Safe multisig, snapshot+claim contract)
Kontraskan dengan apa yang benar-benar dilakukan.

---
**🎭 Pattern Match**
Apakah ini cocok dengan template scam yang dikenal?
(Clanker redeploy dump / sniper-fronted relaunch / CEX pump dengan treasury dominan / self-funded MM short-squeeze)

---
**🔄 Apa yang Bisa Ubah Verdict**
- Fakta on-chain spesifik yang akan TURUNKAN risk score
- Fakta yang akan NAIKAN risk score

---
**🔗 Sources**
[Link explorer untuk setiap contract dan wallet yang disebut]

---
*NFA. DYOR. Analisis berdasarkan data real-time saat ini. Jangan dump seluruh report inline — berikan summary 4-6 bullet ke user.*

## PENTING:
- Gunakan HANYA data yang tersedia di bawah. JANGAN mengarang angka, address, atau klaim.
- Jika data tidak tersedia (misal ABI tidak bisa diambil karena unverified), katakan terus terang dan analisis dari data yang ada.
- Jika off-chain intel tidak menemukan apapun tentang token ini, catat "coverage bersih" dan pertahankan verdict berdasarkan on-chain saja.
- Gunakan Bahasa Indonesia.
`;

// ─── Entrypoint ───────────────────────────────────────────────────────────────
async function runScamAnalysis(question) {
  const addresses = extractContractAddresses(question);
  const chain = detectChain(question);

  let onChainData = '';
  try {
    onChainData = await buildOnChainContext(addresses, chain);
  } catch (err) {
    onChainData = `[Error saat fetch data: ${err.message}. Analisis berdasarkan data yang tersedia.]`;
  }

  const fullPrompt = [
    SKILL_SYSTEM,
    '\n\n═══════════════════════════════════════════════════════════════════════',
    '[DATA REAL-TIME DARI API — BANKR FORENSIC COLLECTOR]',
    '═══════════════════════════════════════════════════════════════════════',
    onChainData,
    '\n═══════════════════════════════════════════════════════════════════════',
    '[PERTANYAAN / REQUEST USER]',
    '═══════════════════════════════════════════════════════════════════════',
    question,
    '\n\nBerikan laporan analisis menggunakan format bankr di atas.',
    'Gunakan Bahasa Indonesia. Hanya gunakan data yang ada — jangan mengarang.',
    'Di akhir jawaban, tambahkan 4-6 bullet point summary untuk user.',
  ].join('\n');

  return { applicable: true, addresses, chain, fullPrompt };
}

module.exports = { isScamAnalysisRequest, runScamAnalysis };
