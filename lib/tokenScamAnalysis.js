// lib/tokenScamAnalysis.js
// Token scam/rug-pull analysis — full Bankr skill spec
//
// Data: GeckoTerminal · DexScreener · Etherscan V2 (satu key, semua EVM, chainid param) · Clanker API
// LP Lock: Clanker native locker · Etherscan LP holder check (UNCX/TeamFinance/PinkSale/Mudra)
// On-chain: eth_call allData/isVerified/totalSupply/owner/peers
// Holder: bytecode classify · per-holder first-buy block · vault/airdrop detect · CEX detect
// Deployer: txlist lifecycle forensics (funded→deploy→extract)
// Off-chain: DuckDuckGo (ZachXBT · CEX investigation · rug keywords)
//
// Interface:
//   isScamAnalysisRequest(question) → boolean
//   runScamAnalysis(question)       → { applicable, addresses, chain, fullPrompt }

'use strict';
const axios = require('axios');

// ─── Etherscan V2 unified endpoint ───────────────────────────────────────────
// SATU key untuk SEMUA EVM chain via ?chainid={id}
const ESCAN_V2   = 'https://api.etherscan.io/v2/api';
const ESCAN_KEY  = process.env.ETHERSCAN_API_KEY || '';

// ─── Chain config ─────────────────────────────────────────────────────────────
const CHAIN = {
  eth:      { name:'Ethereum',    cid:1,     gid:'eth',         did:'ethereum',  ex:'https://etherscan.io',             lzEid:30101 },
  base:     { name:'Base',        cid:8453,  gid:'base',        did:'base',      ex:'https://basescan.org',             lzEid:30184 },
  bsc:      { name:'BNB Chain',   cid:56,    gid:'bsc',         did:'bsc',       ex:'https://bscscan.com',              lzEid:30102 },
  polygon:  { name:'Polygon',     cid:137,   gid:'polygon_pos', did:'polygon',   ex:'https://polygonscan.com',          lzEid:30109 },
  arbitrum: { name:'Arbitrum',    cid:42161, gid:'arbitrum',    did:'arbitrum',  ex:'https://arbiscan.io',              lzEid:30110 },
  optimism: { name:'Optimism',    cid:10,    gid:'optimism',    did:'optimism',  ex:'https://optimistic.etherscan.io',  lzEid:30111 },
  avalanche:{ name:'Avalanche',   cid:43114, gid:'avax',        did:'avalanche', ex:'https://snowtrace.io',             lzEid:30106 },
  zksync:   { name:'zkSync Era',  cid:324,   gid:'zksync',      did:'zksync',    ex:'https://explorer.zksync.io',       lzEid:30165 },
  linea:    { name:'Linea',       cid:59144, gid:'linea',       did:'linea',     ex:'https://lineascan.build',          lzEid:30183 },
  solana:   { name:'Solana',      cid:null,  gid:'solana',      did:'solana',    ex:'https://solscan.io',               lzEid:null  },
};

// Known LayerZero V2 endpoints per chain
const LZ_ENDPOINT = {
  base:     '0x1a44076050125825900e736c501f859c50fe728c',
  eth:      '0x1a44076050125825900e736c501f859c50fe728c',
  arbitrum: '0x1a44076050125825900e736c501f859c50fe728c',
};

const CLANKER_FACTORIES = {
  '0xe85a59c628f7d27878aceb4bf3b35733630083a9': 'Clanker v4',
  '0x2a787b2362021cc3eea3c24c4748a6cd5b687382': 'Clanker v3.1',
  '0x375686ac453b56c98a49b3cad82a4ca10571d3ef': 'Clanker v3.0',
  '0x256dddd03b9b94098939763dc0b4d4b732fb6bb1': 'Clanker v2 / Doppler',
  '0x1a0ad19a73752ea416c116c4c2c62c3e414c5b36': 'Clanker v1',
};

// Known CEX hot wallets — top holders sending TO these = distribution signal
const CEX_WALLETS = new Set([
  '0x28c6c06298d514db089934071355e5743bf21d60', // Binance 14
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549', // Binance 15
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d', // Binance 16
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43', // Coinbase 10
  '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b', // OKX 1
  '0x236f9f97e0e62388479bf9e5ba4889e46b0273c3', // Bybit
  '0x1ab4973a48dc892cd9971ece8e01dcc7688f8f23', // Bitget
  '0x77134cbc06cb00b66f4c7e623d5fdbf6777635ec', // Gate.io
]);

// Known infra/burn
const INFRA = new Set([
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000000',
]);


// Known LP locker contract addresses per chain
// Source: UNCX, Team.Finance, PinkSale, Mudra, DxLock official docs
const LP_LOCKERS = {
  eth: new Map([
    ['0x663a5c229c09b049e36dce11a52ba6b5f04bb07a', 'UNCX V2'],
    ['0xfd235968e65b0990584585763f837a5b5330e6de', 'UNCX V3'],
    ['0xe2fe530c047f2d85298b07d9333c05737f1435fb', 'Team.Finance'],
    ['0x71b5759d73262fbb223956913ecf4ecc51057641', 'PinkSale'],
  ]),
  bsc: new Map([
    ['0xc765bddb93b0d1c1a88282ba0fa6b2d00e3e0c83', 'UNCX V2'],
    ['0x1ae369e03b5a09bdba0e62c584d695a8b41aa15d', 'UNCX V3'],
    ['0x7ee058420e5937496f5a2096f04caa7721cf70cc', 'PinkSale V2'],
    ['0xd4fdaa22e9fbe7f28ace1c9f8f61af37b55edce7', 'Team.Finance BSC'],
    ['0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe', 'PinkSale V1'],
    ['0x40ed17221b3b2d8455f4f1a05cac6b77c5f707e3', 'Mudra'],
  ]),
  polygon: new Map([
    ['0x0da961a7b4e4e0b3ee6b28fc4946b2af7ead3cb0', 'UNCX V2'],
  ]),
  arbitrum: new Map([
    ['0xe6a394b0f0f2c52d87a8efbe6e52da44e94046e3', 'UNCX Arbitrum'],
  ]),
  base: new Map([
    // ── Clanker v4 native LP lockers (also added dynamically from clankerData.locker_address)
    ['0x63d2dfea64b3433f4071a98665bcd7ca14d93496', 'Clanker v4 Locker'],
    ['0x1166022e1becc70e7e9ab2250af1ac7842b9b420', 'Clanker v4 Locker'],
    // ── UNCX Network — LP locker service on Base
    ['0xfdd1e47665c6dc3f93e03a7dfb6d29b6e0ac1af6', 'UNCX V3 Locker (Base)'],
    ['0xadb2b42f6bd96f5c65920b9ac88619dce4166f94', 'UNCX V2 Locker (Base)'],
    // ── Team Finance on Base
    ['0xe2fe530c047f2d85298b07d9333c05737f1435fb', 'Team.Finance (Base)'],
    // ── PinkSale / DxSale on Base
    ['0x71b5759d73262fbb223956913ecf4ecc51057641', 'PinkSale (Base)'],
    ['0x1d9eec918e1bebb0c2d0427e57ee54af8437d4f5', 'DxSale Locker (Base)'],
    // ── Mudra Manager (multi-chain locker)
    ['0x40ed17221b3b2d8455f4f1a05cac6b77c5f707e3', 'Mudra (Base)'],
  ]),
};


// ─── Aerodrome/Velodrome Voter (for dynamic gauge LP detection) ───────────────
const AERO_VOTER = {
  base:     '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5', // Aerodrome Finance (Base)
  optimism: '0x41C914ee0c7E1A5edCD0295623e6dC557B5aBf3C', // Velodrome (Optimism)
};
// gauges(address) → selector = keccak256("gauges(address)")[0:4]
const SEL_GAUGES = '0x2586b9c1';

// Uniswap V3 NonFungible Position Manager addresses per chain
const UNIV3_NFPM = {
  base:     '0x827922686190790b37229fd06084350e74485b72',
  eth:      '0xc36442b4a4522e871399cd717abdd847ab11fe88',
  polygon:  '0xc36442b4a4522e871399cd717abdd847ab11fe88',
  arbitrum: '0xc36442b4a4522e871399cd717abdd847ab11fe88',
  optimism: '0xc36442b4a4522e871399cd717abdd847ab11fe88',
  bsc:      '0x7b8a01b39d58278b5de7e48c8449c9f4f5170613', // PancakeSwap V3
};

// Burn addresses (permanently locked = sent here = no one can withdraw)
const BURN_ADDRS = [
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000000',
];

// Aerodrome/Velodrome factory on Base
const AERODROME_FACTORY = '0x420dd381b31aef6683db6b902084cb0ffece40da';

// Uniswap v4 PoolManager on Base
const UNIV4_BASE = '0x498581ff718922c3f8e6a244956af099b2652b2b';

// ─── Keyword detection ────────────────────────────────────────────────────────
const KEYWORDS = [
  /\bscam\b/i,/\brug\b/i,/\brug.?pull\b/i,/\banalyz/i,/\banalisis\b/i,/\banalisa\b/i,
  /\bforensik\b/i,/\bsafe\b.*\btoken\b/i,/\blegit\b/i,/\btrust(worthy)?\b/i,
  /\bcek.?token\b/i,/\bcek.?kontrak\b/i,/\bperiksa.?token\b/i,/\bis.?this.?a\b/i,
  /\bbahaya\b/i,/\bpenipuan\b/i,/\bhodler\b/i,/\bholder\b/i,/\bdeployer\b/i,
  /\bmigrat/i,/\bon.?chain\b/i,/\bfundamental\b/i,/\brisk\b/i,/\brisiko\b/i,
  /\bwaspada\b/i,/\btoken\b/i,
];

function extractAddresses(text) {
  const m = text.match(/0x[a-fA-F0-9]{40}/g);
  return m ? [...new Set(m)] : [];
}
function detectChain(text) {
  const t = text.toLowerCase();
  if (/\bbase\b/.test(t)) return 'base';
  if (/\bsolana\b|\bsol\b/.test(t)) return 'solana';
  if (/\bpolygon\b|\bmatic\b/.test(t)) return 'polygon';
  if (/\barb(itrum)?\b/.test(t)) return 'arbitrum';
  if (/\boptimism\b|\bop-mainnet\b|\bop.chain\b/.test(t)) return 'optimism';
  if (/\bbsc\b|\bbnb\b|\bbinance\b/.test(t)) return 'bsc';
  if (/\bavalanche\b|\bavax\b/.test(t)) return 'avalanche';
  if (/\bzksync\b/.test(t)) return 'zksync';
  if (/\beth(ereum)?\b/.test(t)) return 'eth';
  return 'base';
}
function isScamAnalysisRequest(q) {
  if (!extractAddresses(q).length) return false;
  if (KEYWORDS.some((k) => k.test(q))) return true;
  return q.replace(/0x[a-fA-F0-9]{40}/g,'').trim().length < 30;
}

// ─── Formatters ───────────────────────────────────────────────────────────────
const $ = (n) => { if (n==null||n==='') return 'N/A'; const x=parseFloat(n); if(isNaN(x)) return String(n); if(x>=1e9) return '$'+(x/1e9).toFixed(2)+'B'; if(x>=1e6) return '$'+(x/1e6).toFixed(2)+'M'; if(x>=1e3) return '$'+(x/1e3).toFixed(2)+'K'; return '$'+x.toFixed(4); };
const $p = (n) => { if(n==null||n==='') return 'N/A'; const x=parseFloat(n); if(isNaN(x)) return String(n); if(x<0.000001) return '$'+x.toExponential(4); if(x<0.01) return '$'+x.toFixed(8); if(x<1) return '$'+x.toFixed(6); return '$'+x.toFixed(4); };
const short = (a) => a ? a.slice(0,6)+'…'+a.slice(-4) : 'N/A';
const ts2date = (ts) => ts ? new Date(parseInt(ts)*1000).toISOString().split('T')[0] : 'N/A';

// ─── ABI decoding ─────────────────────────────────────────────────────────────
function decStr(hex, offset) {
  const p = offset * 2;
  const len = Number(BigInt('0x' + (hex.slice(p, p+64) || '0')));
  return len ? Buffer.from(hex.slice(p+64, p+64+len*2), 'hex').toString('utf-8') : '';
}
function decAllData(raw) {
  const h = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (h.length < 320) return null;
  try {
    return {
      originalAdmin: '0x' + h.slice(24,64).toLowerCase(),
      admin:         '0x' + h.slice(88,128).toLowerCase(),
      image:    decStr(h, Number(BigInt('0x'+h.slice(128,192)))),
      metadata: decStr(h, Number(BigInt('0x'+h.slice(192,256)))),
      context:  decStr(h, Number(BigInt('0x'+h.slice(256,320)))),
    };
  } catch { return null; }
}
function decBool(h){const raw=(h?.startsWith('0x')?h.slice(2):h)||'';if(raw.length<64)return null;const l=raw.slice(-64);if(!/^0{63}[01]$/.test(l))return null;return l[63]==='1';}
const decAddr   = (h) => h ? '0x'+(h.startsWith('0x') ? h.slice(2) : h).slice(24).toLowerCase() : null;
const decUint   = (h) => { try { return BigInt('0x'+(h?.startsWith('0x') ? h.slice(2) : h)); } catch { return BigInt(0); } };

// ─── Etherscan V2 helpers ─────────────────────────────────────────────────────
async function escan(chain, params, t=10000) {
  const cfg = CHAIN[chain]; if (!cfg?.cid || !ESCAN_KEY) return null;
  try {
    const { data } = await axios.get(ESCAN_V2, { params:{ chainid:cfg.cid, apikey:ESCAN_KEY, ...params }, timeout:t });
    if (data.status==='1' && data.result) return data.result;
    if (data.result==='Contract source code not verified') return data.result;
    return null;
  } catch { return null; }
}
async function ethcall(chain, to, data, t=8000) {
  const cfg = CHAIN[chain]; if (!cfg?.cid || !ESCAN_KEY) return null;
  try {
    const { data:r } = await axios.get(ESCAN_V2, { params:{ chainid:cfg.cid, apikey:ESCAN_KEY, module:'proxy', action:'eth_call', to, data, tag:'latest' }, timeout:t });
    return (r.result && r.result!=='0x') ? r.result : null;
  } catch { return null; }
}

// ─── Public RPC — Alchemy (jika ALCHEMY_BASE_RPC di-set) atau public fallback ──
// Set ALCHEMY_BASE_RPC=https://base-mainnet.g.alchemy.com/v2/<key> di Railway env
const PUBLIC_RPC = {
  base:     process.env.ALCHEMY_BASE_RPC || 'https://mainnet.base.org',
  eth:      'https://ethereum.publicnode.com',
  bsc:      'https://bsc-dataseed.binance.org',
};
async function rpcEthCall(chain, to, data, t=8000) {
  const rpc = PUBLIC_RPC[chain];
  if (!rpc) return null;
  try {
    const { data: r } = await axios.post(rpc, {
      jsonrpc:'2.0', id:1, method:'eth_call',
      params:[{ to, data }, 'latest'],
    }, { timeout:t, headers:{'Content-Type':'application/json'} });
    return (r?.result && r.result !== '0x') ? r.result : null;
  } catch { return null; }
}

// eth_getCode via public RPC (untuk classify() tanpa Etherscan key)
async function rpcGetCode(chain, addr, t=8000) {
  const rpc = PUBLIC_RPC[chain];
  if (!rpc) return null;
  try {
    const { data: r } = await axios.post(rpc, {
      jsonrpc:'2.0', id:1, method:'eth_getCode',
      params:[addr, 'latest'],
    }, { timeout:t, headers:{'Content-Type':'application/json'} });
    return (r?.result && r.result !== '0x' && r.result !== '0x0') ? r.result : null;
  } catch { return null; }
}

// ─── On-chain reads (Etherscan primary → public RPC fallback) ─────────────────
// Semua read* function pakai ethcall() jika ada key, fallback ke rpcEthCall() agar
// Clanker detection tetap bekerja meski tanpa ETHERSCAN_API_KEY.
const callWithFallback = async (chain, addr, sel) => {
  let r = ESCAN_KEY ? await ethcall(chain, addr, sel) : null;
  if (!r) r = await rpcEthCall(chain, addr, sel);
  return r;
};
const readAllData     = async (a,c) => { const r = await callWithFallback(c,a,'0xb974b0a3'); return r ? decAllData(r) : null; };
const readIsVerified  = async (a,c) => { const r = await callWithFallback(c,a,'0x80007e83'); return r!=null ? decBool(r) : null; };
const readTotalSupply = async (a,c) => { const r = await callWithFallback(c,a,'0x18160ddd'); return r ? decUint(r) : null; };
const readOwner       = async (a,c) => { const r = await callWithFallback(c,a,'0x8da5cb5b'); return r ? decAddr(r) : null; };
const readDecimals    = async (a,c) => { const r = await callWithFallback(c,a,'0x313ce567'); return r ? Number(decUint(r)) : 18; };
const readBytecode    = async (a,c) => {
  if (ESCAN_KEY) { const r = await escan(c,{module:'proxy',action:'eth_getCode',address:a,tag:'latest'}); if (r) return r; }
  return rpcGetCode(c, a);
};

// Read token() — returns token address if holder is a Clanker vault/airdrop extension
const readTokenOf = async (a,c) => { const r = await callWithFallback(c,a,'0xfc0c546a'); return r ? decAddr(r) : null; };

// OFT: read peers(uint32 eid)
async function readOftPeer(contract, eid, chain) {
  // peers(uint32) selector = 0x15a84c64, arg = uint32 padded to 32 bytes
  const data = '0x15a84c64' + eid.toString(16).padStart(64,'0');
  let r = ESCAN_KEY ? await ethcall(chain, contract, data) : null;
  if (!r) r = await rpcEthCall(chain, contract, data);
  return r ? decAddr(r) : null;
}

// ─── Classify address ─────────────────────────────────────────────────────────
async function classify(addr, chain) {
  const code = await readBytecode(addr, chain);
  if (!code || code==='0x'||code==='0x0') return 'eoa';
  const bytes = (code.replace('0x','').length)/2;
  if (bytes===48) return 'sniper_proxy'; // EIP-7702 / minimal proxy sniper
  // Gnosis Safe: large bytecode + specific patterns
  if (bytes>4000 && code.toLowerCase().includes('fd9f1e10')) return 'safe_multisig';
  return 'contract';
}

// ─── Etherscan data fetchers ──────────────────────────────────────────────────
const getSource   = (a,c) => escan(c,{module:'contract',action:'getsourcecode',address:a});
const getCreator  = (a,c) => escan(c,{module:'contract',action:'getcontractcreation',contractaddresses:a}).then(r=>r?.[0]||null);
const getHolders  = (a,c) => escan(c,{module:'token',action:'tokenholderlist',contractaddress:a,page:1,offset:20});
const getInternalTx = (a,c,limit=5) => escan(c,{module:'account',action:'txlistinternal',address:a,page:1,offset:limit,sort:'asc'},12000);

async function getAbi(addr, chain) {
  const r = await escan(chain,{module:'contract',action:'getabi',address:addr});
  if (!r || r==='Contract source code not verified') return null;
  try {
    const DANGER = ['crosschainmint','setowner','updateadmin','blacklist','setfee','pause','updateimage','updatemetadata','setpeer','setminter','freeze'];
    return JSON.parse(r).filter(i=>i.type==='function').map(i=>({
      name:i.name||'',
      sig:`${i.name}(${(i.inputs||[]).map(x=>x.type).join(',')})`,
      mut:i.stateMutability||'',
      dangerous:DANGER.some(d=>(i.name||'').toLowerCase().includes(d)),
    }));
  } catch { return null; }
}

async function getDeployerLifecycle(deployer, chain) {
  if (!deployer) return null;
  const [txs, internal] = await Promise.all([
    escan(chain,{module:'account',action:'txlist',address:deployer,startblock:0,endblock:99999999,page:1,offset:50,sort:'asc'},15000),
    getInternalTx(deployer, chain, 10),
  ]);
  if (!txs || !Array.isArray(txs)) return null;
  const fundedBy   = internal?.[0]?.from || 'N/A';
  const firstDate  = ts2date(txs[0]?.timeStamp);
  const largeOut   = txs.filter(tx=>tx.from?.toLowerCase()===deployer.toLowerCase()&&BigInt(tx.value||0)>BigInt('50000000000000000'));
  return { nonce:txs.length, firstDate, fundedBy, largeOutCount:largeOut.length, fresh:txs.length<=5 };
}

// Per-holder: get FIRST time they received the token (block + date)
async function getHolderFirstBuy(holderAddr, tokenAddr, chain) {
  const r = await escan(chain,{module:'account',action:'tokentx',contractaddress:tokenAddr,address:holderAddr,page:1,offset:1,sort:'asc'},8000);
  if (!r || !Array.isArray(r) || !r[0]) return null;
  const tx = r[0];
  return { blockNumber:tx.blockNumber, date:ts2date(tx.timeStamp), txHash:tx.hash, from:tx.from };
}

// Check if top non-pool contract holders are Clanker vault/airdrop for this token
async function checkVaultExtension(holderAddr, tokenAddr, chain) {
  const tokenOf = await readTokenOf(holderAddr, chain);
  return tokenOf && tokenOf.toLowerCase() === tokenAddr.toLowerCase();
}

// Check if holder recently sent tokens TO known CEX deposit wallets
async function checkCexSends(holderAddr, tokenAddr, chain) {
  const r = await escan(chain,{module:'account',action:'tokentx',contractaddress:tokenAddr,address:holderAddr,page:1,offset:20,sort:'desc'},8000);
  if (!Array.isArray(r)) return null;
  const cexSends = r.filter(tx=>tx.from?.toLowerCase()===holderAddr.toLowerCase()&&CEX_WALLETS.has(tx.to?.toLowerCase()));
  return cexSends.length;
}


// -- LP Lock Detection --------------------------------------------------------
// Layer 1: Clanker native locker (locker_address from Clanker API)
// Layer 2: Vault/Airdrop supply lockup dates (from extensions.lockup)
// Layer 3: Etherscan tokenholderlist on LP pair address vs LP_LOCKERS map
async function getLpLockInfo(pairAddress, chain, clankerData, bestPair, tokenAddr) {
  const result = {
    lpLocked:      false,
    burnedPct:     null,   // % LP token yang di-burn (permanent lock)
    lpLockerName:  null,
    lpLockerAddr:  null,
    lpLockedPct:   null,
    lpLockMethod:  null,   // 'clanker_native'|'v2_burned'|'v3_nft_burned'|'lp_holder'|'timelock'|'none'
    dexType:       null,   // 'v2'|'v3'|'v4'|'aerodrome'|'unknown'
    vaultLock:     null,
    airdropLock:   null,
    notes:         [],
  };

  if (!ESCAN_KEY) {
    result.notes.push('ETHERSCAN_API_KEY tidak ada — LP lock check dibatasi');
  }

  // ── Detect DEX type from DexScreener dexId
  const dexId = (bestPair?.dexId || '').toLowerCase();
  if (dexId.includes('v3') || dexId.includes('pancakeswap-v3'))
    result.dexType = 'v3';
  else if (dexId.includes('aerodrome') || dexId.includes('velodrome'))
    result.dexType = 'aerodrome';
  else if (dexId.includes('uniswap-v4') || dexId.includes('v4') || (clankerData && (dexId === '' || dexId === 'unknown')))
    result.dexType = 'v4';
  else if (dexId.includes('v2') || dexId.includes('uniswap') || dexId.includes('pancake') || dexId.includes('sushi'))
    result.dexType = 'v2';
  else
    result.dexType = 'unknown';

  // ══════════════════════════════════════════════════════
  // LAYER A: Clanker v4 native locker (paling reliable)
  // ══════════════════════════════════════════════════════
  if (clankerData?.locker_address) {
    result.lpLocked     = true;
    result.lpLockerAddr = clankerData.locker_address;
    result.lpLockerName = 'Clanker v4 Native LP Locker (protokol)';
    result.lpLockMethod = 'clanker_native';
    result.notes.push('LP dikunci permanen oleh Clanker v4 protocol di locker_address');
  }

  // ══════════════════════════════════════════════════════
  // LAYER B: V2 / Aerodrome — balanceOf(burn) on LP token
  // Metodologi Bankr: cek berapa % LP token yang di-burn ke dead/zero address
  // ══════════════════════════════════════════════════════
  // LAYER B: V2 / Aerodrome — balanceOf(burn) via Etherscan OR public RPC
  const canLayerB = pairAddress && (result.dexType === 'v2' || result.dexType === 'aerodrome' || result.dexType === 'unknown');
  if (canLayerB) {
    // balanceOf(address) selector = 0x70a08231
    // address arg padded to 32 bytes (12 zero bytes + 20-byte address)
    const padAddr = (a) => '000000000000000000000000' + a.replace('0x','').toLowerCase();
    const callOrRpc = async (to, data) => {
      let r = ESCAN_KEY ? await ethcall(chain, to, data) : null;
      if (!r) r = await rpcEthCall(chain, to, data);
      return r;
    };
    const [deadBal, zeroBal, totalSup] = await Promise.all([
      callOrRpc(pairAddress, '0x70a08231' + padAddr(BURN_ADDRS[0])),
      callOrRpc(pairAddress, '0x70a08231' + padAddr(BURN_ADDRS[1])),
      callOrRpc(pairAddress, '0x18160ddd'),   // totalSupply()
    ]);
    if (totalSup && (deadBal || zeroBal)) {
      const total    = decUint(totalSup);
      const burned   = decUint(deadBal || '0x0') + decUint(zeroBal || '0x0');
      if (total > 0n) {
        const pct = Number(burned * 10000n / total) / 100;
        result.burnedPct = pct.toFixed(2);
        result.notes.push(`V2/Aerodrome burn check: ${pct.toFixed(2)}% LP token di burn address`);
        if (pct >= 95) {
          result.lpLocked    = true;
          result.lpLockMethod = result.lpLockMethod || 'v2_burned';
          result.lpLockerName = result.lpLockerName || 'Burn Address (permanen)';
          result.lpLockedPct  = result.burnedPct;
          result.notes.push('✅ LP terkunci permanen — ≥95% LP token di-burn ke dead/zero address');
        } else if (pct >= 50) {
          result.notes.push(`⚠️ ${pct.toFixed(1)}% LP di burn address — sebagian terkunci tapi belum semua`);
        } else if (pct > 0) {
          result.notes.push(`❌ Hanya ${pct.toFixed(1)}% LP di burn address — mayoritas belum terkunci`);
        } else {
          result.notes.push('❌ 0% LP di burn address — LP tidak terkunci via burn mechanism');
          if (!result.lpLocked) result.lpLockMethod = result.lpLockMethod || 'none';
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════
  // LAYER C: V3 — cek NFT position di burn address
  // Metodologi Bankr: find NFPM NFT positions di dead address
  // Step 1: ambil ERC-721 transfers ke burn address dari NFPM contract (Etherscan tokennfttx)
  // Step 2: untuk setiap tokenId, panggil positions(tokenId) pada NFPM → cek token0/token1
  // ══════════════════════════════════════════════════════
  if (pairAddress && ESCAN_KEY && (result.dexType === 'v3' || result.dexType === 'unknown')) {
    const nfpmAddr = UNIV3_NFPM[chain];
    if (nfpmAddr) {
      // Get ERC-721 NFT transfers to dead address from NFPM contract
      const [nftTransfersToDead, nftTransfersToZero] = await Promise.all([
        escan(chain, {
          module:'account', action:'tokennfttx',
          contractaddress: nfpmAddr,
          address: BURN_ADDRS[0],
          page:1, offset:50, sort:'asc'  // asc = oldest burns first; filter by tokenAddr below
        }, 10000),
        escan(chain, {
          module:'account', action:'tokennfttx',
          contractaddress: nfpmAddr,
          address: BURN_ADDRS[1],
          page:1, offset:10, sort:'desc'
        }, 10000),
      ]);
      const allNfts = [
        ...(nftTransfersToDead||[]).filter(t => t.to?.toLowerCase() === BURN_ADDRS[0].toLowerCase()),
        ...(nftTransfersToZero||[]).filter(t => t.to?.toLowerCase() === BURN_ADDRS[1].toLowerCase()),
      ];
      const tokenIds = [...new Set(allNfts.map(t=>t.tokenID).filter(Boolean))].slice(0,5);

      if (tokenIds.length > 0) {
        // positions(uint256 tokenId) selector = 0x99fbab88
        // Check each tokenId to see if it's for our pair/token
        // positions(uint256 tokenId) returns: nonce(32) operator(32) token0(32) token1(32) fee(32) ...
        // We filter by token0/token1 matching our tokenAddr (the token being analyzed)
        const tLow = tokenAddr ? tokenAddr.toLowerCase().replace('0x','') : null;
        const posResults = await Promise.all(tokenIds.map(async(tid) => {
          const tidHex = BigInt(tid).toString(16).padStart(64,'0');
          const raw = await ethcall(chain, nfpmAddr, '0x99fbab88' + tidHex, 10000);
          if (!raw) return null;
          const h = raw.startsWith('0x') ? raw.slice(2) : raw;
          if (h.length < 256) return null;
          // token0 at slot 2 (offset 64), token1 at slot 3 (offset 96) — each is 32 bytes
          const token0 = h.slice(64+24, 64+64).toLowerCase();  // 20-byte addr portion
          const token1 = h.slice(128+24, 128+64).toLowerCase();
          return { tid, token0, token1 };
        }));
        // Only count positions that belong to our specific token (token0 or token1 = tokenAddr)
        const matched = posResults.filter(p => p && tLow && (
          p.token0 === tLow || p.token1 === tLow
        ));
        // If tokenAddr not available, accept any burned NFPM position as likely for this token
        const confirmed = matched.length > 0 || (!tLow && tokenIds.length > 0);
        if (confirmed) {
          result.lpLocked     = true;
          result.lpLockMethod = result.lpLockMethod || 'v3_nft_burned';
          result.lpLockerName = result.lpLockerName || 'Burn Address — V3 NFT Position';
          result.lpLockedPct  = '100';
          const verifiedCount = tLow ? matched.length : tokenIds.length;
          result.notes.push(`V3 NFT check: ${verifiedCount} posisi LP token ini di burn address (NFPM ${nfpmAddr.slice(0,8)}…)`);
          if (matched.length > 0) result.notes.push(`tokenId(s) confirmed: ${matched.map(p=>p.tid).slice(0,3).join(', ')}`);
        }
      } else if (ESCAN_KEY) {
        result.notes.push('V3 NFT check: tidak ada posisi LP yang di-burn ke dead address — cek locker...');
        // Jangan set 'none' di sini — Layer C-prime cek known V3 lockers dulu
      }
    }
  }

  // ══════════════════════════════════════════════════════
  // LAYER D: Known locker contracts (UNCX/TeamFinance/PinkSale/Mudra)
  // Fallback untuk token yang tidak pakai burn mechanism
  // ══════════════════════════════════════════════════════
  // LAYER C-prime: V3 — cek NFT position di known locker (UNCX V3 / TeamFinance / dll)
  // Layer C hanya cek burned positions; C-prime cek yang di-lock di locker contract
  // Cara: tokennfttx NFPM → locker addr, lalu positions(tokenId) → filter by tokenAddr
  // ══════════════════════════════════════════════════════
  if (pairAddress && ESCAN_KEY && result.dexType === 'v3' && !result.lpLocked) {
    const cpNfpm = UNIV3_NFPM[chain];
    const cpLockers = [...(LP_LOCKERS[chain] || new Map()).entries()];
    const cpTLow = tokenAddr?.toLowerCase().replace('0x','');
    if (cpNfpm && cpLockers.length > 0 && cpTLow) {
      // Cek semua locker paralel — masing-masing ambil tokennfttx ke locker tsb
      const cpResults = await Promise.all(cpLockers.map(async ([lockerAddr, lockerName]) => {
        const nfts = await escan(chain, {
          module:'account', action:'tokennfttx',
          contractaddress: cpNfpm, address: lockerAddr,
          page:1, offset:20, sort:'desc'
        }, 10000);
        const received = (nfts||[])
          .filter(t => t.to?.toLowerCase() === lockerAddr.toLowerCase())
          .map(t => t.tokenID).filter(Boolean);
        const tids = [...new Set(received)].slice(0,3);
        if (tids.length === 0) return null;
        // Verifikasi: positions(tokenId) → token0/token1 harus cocok dengan tokenAddr
        const matches = (await Promise.all(tids.map(async tid => {
          const tidHex = BigInt(tid).toString(16).padStart(64,'0');
          const raw = await ethcall(chain, cpNfpm, '0x99fbab88' + tidHex, 10000);
          if (!raw) return null;
          const h = raw.startsWith('0x') ? raw.slice(2) : raw;
          if (h.length < 256) return null;
          const t0 = h.slice(64+24, 64+64).toLowerCase();
          const t1 = h.slice(128+24, 128+64).toLowerCase();
          return (t0 === cpTLow || t1 === cpTLow) ? tid : null;
        }))).filter(Boolean);
        return matches.length > 0 ? { lockerAddr, lockerName, matches } : null;
      }));
      const found = cpResults.find(r => r !== null);
      if (found) {
        result.lpLocked     = true;
        result.lpLockMethod = 'v3_locker';
        result.lpLockerName = found.lockerName;
        result.lpLockerAddr = found.lockerAddr;
        result.notes.push(`V3 locker: ${found.matches.length} posisi LP di ${found.lockerName} (${short(found.lockerAddr)})`);
      } else {
        result.notes.push('V3 locker check: tidak ada known locker yang memegang V3 NFT position untuk token ini');
        if (!result.lpLocked) result.lpLockMethod = result.lpLockMethod || 'none';
      }
    }
  }

  // ══════════════════════════════════════════════════════
  // LAYER D-pre: Aerodrome/Velodrome gauge detection (specific to aerodrome pools)
  // The Aerodrome Voter tracks which gauge holds LP for each pool.
  // gauges(pairAddress) → gaugeAddr → balanceOf(gaugeAddr) on LP pair = staked LP
  if (pairAddress && !result.lpLocked && result.dexType === 'aerodrome' && AERO_VOTER[chain]) {
    const voterAddr = AERO_VOTER[chain];
    const padFull = (a) => '000000000000000000000000' + a.replace('0x','').toLowerCase();
    const gaugeRaw = await rpcEthCall(chain, voterAddr, SEL_GAUGES + padFull(pairAddress));
    if (gaugeRaw && gaugeRaw.length >= 66) {
      const gaugeAddr = '0x' + gaugeRaw.slice(-40).toLowerCase();
      if (gaugeAddr !== '0x' + '0'.repeat(40)) {
        // Gauge exists — check what % of LP is staked in it
        const [gaugeBal, totalSup] = await Promise.all([
          rpcEthCall(chain, pairAddress, '0x70a08231' + padFull(gaugeAddr)),
          rpcEthCall(chain, pairAddress, '0x18160ddd'),
        ]);
        if (gaugeBal && totalSup) {
          const gBal  = decUint(gaugeBal);
          const total = decUint(totalSup);
          if (total > 0n) {
            const pct = Number(gBal * 10000n / total) / 100;
            result.gaugeStaked = { pct: pct.toFixed(1), gaugeAddr };
            result.notes.push(`Aerodrome gauge ${short(gaugeAddr)}: ${pct.toFixed(1)}% LP staked (gauge = can unstake, bukan lock permanen)`);
            if (pct >= 90) {
              // ≥90% LP in gauge = very strong signal, community is farming, dev has no LP to rug
              result.lpLocked     = true;
              result.lpLockMethod = 'gauge_staked';
              result.lpLockerName = `Aerodrome Gauge (${pct.toFixed(0)}% LP staked)`;
              result.lpLockedPct  = pct.toFixed(1);
              result.notes.push(`✅ ${pct.toFixed(0)}% LP di Aerodrome gauge — dev tidak bisa rug tanpa unstake semua LP publik`);
            } else if (pct >= 50) {
              result.notes.push(`⚠️ ${pct.toFixed(0)}% LP di gauge — sebagian terlindungi via farming, tapi dev masih bisa rug sisa ${(100-pct).toFixed(0)}%`);
            } else if (pct > 0) {
              result.notes.push(`ℹ️ ${pct.toFixed(1)}% LP di gauge — sebagian kecil LP sedang di-farm`);
            }
          }
        }
      }
    }
  }

  // LAYER D: Known locker contracts — check balanceOf on LP pair per locker address
  // Uses public RPC (no API key needed). tokenholderlist is Etherscan Pro-only, skip it.
  // SKIP untuk V3: V3 LP adalah ERC-721 NFT position, bukan ERC-20 token → balanceOf selalu 0
  if (pairAddress && !result.lpLocked && result.dexType !== 'v3') {
    const padAddr = (a) => '000000000000000000000000' + a.replace('0x','').toLowerCase();
    const sel = '0x70a08231'; // balanceOf(address)
    const checkLockerBal = async (addr) => {
      let r = ESCAN_KEY ? await ethcall(chain, pairAddress, sel + padAddr(addr)) : null;
      if (!r) r = await rpcEthCall(chain, pairAddress, sel + padAddr(addr));
      return r ? decUint(r) : 0n;
    };
    // Build locker list: LP_LOCKERS[chain] is a Map, spread entries correctly
    const chainLockerMap = LP_LOCKERS[chain] || new Map();
    const lockerEntries = [...chainLockerMap.entries()]; // Map → [[addr, name], ...]
    if (clankerData?.locker_address)
      lockerEntries.push([clankerData.locker_address.toLowerCase(), 'Clanker v4 Native LP Locker']);
    const lockerBals = await Promise.all(
      lockerEntries.map(async ([addr, name]) => {
        const bal = await checkLockerBal(addr);
        return { addr: addr.toLowerCase(), name, bal };
      })
    );
    const lpHolders = lockerBals
      .filter(e => e.bal > 0n)
      .map(e => ({ TokenHolderAddress: e.addr, TokenHolderQuantity: e.bal.toString(), _name: e.name }));
    if (lpHolders.length === 0) {
      if (result.dexType === 'v3') {
        result.notes.push('V3 pool: LP bukan ERC-20 — balanceOf per locker tidak berlaku untuk V3 NFT positions');
      } else {
        result.notes.push('Layer D: tidak ada locker yang memegang LP token — LP tidak dikunci via locker yang dikenal');
        if (!result.lpLocked) result.lpLockMethod = result.lpLockMethod || 'none';
      }
    } else if (lpHolders.length > 0) {
      // Tandai known locker yang ditemukan
      let foundKnownLocker = false;
      for (const h of lpHolders) {
        // h._name is already set from lockerEntries lookup
        result.lpLocked     = true;
        result.lpLockerName = h._name;
        result.lpLockerAddr = h.TokenHolderAddress;
        result.lpLockMethod = 'lp_holder';
        result.lpLockedPct  = null;
        result.notes.push(`Known locker: ${h._name} (${h.TokenHolderAddress}) memegang LP token`);
        foundKnownLocker = true;
        break;
      }
      // Time-lock detection: jika tidak ada known locker yang memegang LP,
      // cek apakah holder teratas adalah contract dengan timelock selectors.
      // Catatan: lpHolders hanya berisi known lockers yang punya saldo;
      // jika foundKnownLocker=false maka lpHolders kosong — blok ini siap dipakai
      // jika di masa depan sumber holder diperluas ke semua LP holders.
      if (!foundKnownLocker && lpHolders.length > 0) {
        const top = lpHolders[0];
        const topAddr = top.TokenHolderAddress?.toLowerCase();
        const topType = await classify(topAddr, chain);
        if (topType !== 'eoa') {
          // Try common time-lock selectors
          const [unlockDate, releaseTime, lpTotalSupRaw] = await Promise.all([
            ethcall(chain, topAddr, '0x6e2f5aef'), // unlockDate()
            ethcall(chain, topAddr, '0x67e404ce'), // releaseTime()
            pairAddress ? rpcEthCall(chain, pairAddress, '0x18160ddd') : Promise.resolve(null),
          ]);
          const ts = unlockDate || releaseTime;
          if (ts) {
            const unlockMs = Number(decUint(ts)) * 1000;
            const daysLeft = Math.max(0, Math.ceil((unlockMs - Date.now()) / 86400000));
            // Bug2 fix: hitung pct dengan BigInt agar akurat untuk supply besar
            const lpTotalSup = lpTotalSupRaw ? decUint(lpTotalSupRaw) : 0n;
            const holderBal  = BigInt(top.TokenHolderQuantity || '0');
            const lockedPct  = lpTotalSup > 0n
              ? (Number(holderBal * 10000n / lpTotalSup) / 100).toFixed(1)
              : null;
            result.lpLocked     = daysLeft > 0;
            result.lpLockerName = 'Time-lock contract';
            result.lpLockerAddr = topAddr;
            result.lpLockMethod = 'timelock';
            result.lpLockedPct  = lockedPct;
            result.notes.push(`Time-lock terdeteksi: unlock ${new Date(unlockMs).toISOString().split('T')[0]} (${daysLeft} hari lagi)`);
          } else {
            result.notes.push(`Top LP holder adalah contract (${short(topAddr)}) bukan locker yang dikenal`);
            result.lpLockMethod = 'none';
          }
        } else {
          result.lpLockMethod = result.lpLockMethod || 'none';
          result.notes.push('LP tidak terkunci — tidak ada burn, locker dikenal, atau time-lock ditemukan');
        }
      }
    } // end else if lpHolders.length > 0
  }

  // ══════════════════════════════════════════════════════
  // LAYER E: Supply vault/airdrop unlock dates (Clanker extensions)
  // ══════════════════════════════════════════════════════
  const FULL_SUPPLY = BigInt('100000000000000000000000000000');
  if (clankerData?.vault?.lockup) {
    const v = clankerData.vault.lockup;
    const unlockTs  = (v.startedAt + v.lockDuration) * 1000;
    const vestEnd   = v.vestDuration ? (v.startedAt + v.lockDuration + v.vestDuration) * 1000 : null;
    const daysLeft  = Math.max(0, Math.ceil((unlockTs - Date.now()) / 86400000));
    const vaultAmt  = BigInt(clankerData.vault.amount || '0');
    const pct = Number(vaultAmt * 10000n / FULL_SUPPLY) / 100;
    result.vaultLock = {
      pct:        pct.toFixed(1),
      unlockDate: new Date(unlockTs).toISOString().split('T')[0],
      daysLeft,
      vestEndDate: vestEnd ? new Date(vestEnd).toISOString().split('T')[0] : null,
      stillLocked: daysLeft > 0,
      amount:     (Number(vaultAmt) / 1e27).toFixed(2) + 'B',
    };
  }
  if (clankerData?.airdrop?.lockup) {
    const a = clankerData.airdrop.lockup;
    const unlockTs  = (a.startedAt + a.lockDuration) * 1000;
    const daysLeft  = Math.max(0, Math.ceil((unlockTs - Date.now()) / 86400000));
    const airdropAmt = BigInt(clankerData.airdrop.amount || '0');
    const pct = Number(airdropAmt * 10000n / FULL_SUPPLY) / 100;
    result.airdropLock = {
      pct:        pct.toFixed(1),
      unlockDate: new Date(unlockTs).toISOString().split('T')[0],
      daysLeft,
      stillLocked: daysLeft > 0,
      amount:     (Number(airdropAmt) / 1e27).toFixed(2) + 'B',
    };
  }

  // Pastikan lpLockMethod TIDAK pernah null — AI butuh nilai eksplisit
  if (!result.lpLockMethod) {
    if (!ESCAN_KEY) {
      result.lpLockMethod = 'no_apikey';
      result.notes.push('ETHERSCAN_API_KEY tidak tersedia di environment — Layer B/C/D memerlukan key ini');
    } else if (!pairAddress) {
      result.lpLockMethod = 'no_pair';
      result.notes.push('LP pair address tidak ditemukan — tidak bisa cek burn/NFT status');
    } else {
      result.lpLockMethod = 'unconfirmed';
      result.notes.push('Semua layer dijalankan tapi status LP tidak bisa dikonfirmasi — mungkin V3 tanpa NFPM data, atau LP holder tidak dikenal');
    }
  }

  return result;
}

// ─── OFT detection ────────────────────────────────────────────────────────────
function isOft(abi) {
  if (!abi) return false;
  const names = new Set(abi.map(f=>f.name?.toLowerCase()));
  return names.has('setpeer') && (names.has('peers') || names.has('send'));
}

async function readOftPeers(address, chain) {
  const peers = {};
  const eids = { ETH:30101, BSC:30102, Base:30184, Arbitrum:30110, Polygon:30109, Optimism:30111 };
  await Promise.all(Object.entries(eids).map(async([name,eid])=>{
    if (CHAIN[chain]?.lzEid===eid) return; // skip self
    const peer = await readOftPeer(address, eid, chain);
    if (peer && peer!=='0x0000000000000000000000000000000000000000') peers[name] = peer;
  }));
  return peers;
}

// ─── GeckoTerminal ────────────────────────────────────────────────────────────
async function getGecko(addr, chain) {
  const id = CHAIN[chain]?.gid||chain;
  try { const {data} = await axios.get(`https://api.geckoterminal.com/api/v2/networks/${id}/tokens/${addr}`,{headers:{Accept:'application/json'},timeout:10000}); return data?.data?.attributes||null; }
  catch { return null; }
}
async function getGeckoPools(addr, chain) {
  const id = CHAIN[chain]?.gid||chain;
  try { const {data} = await axios.get(`https://api.geckoterminal.com/api/v2/networks/${id}/tokens/${addr}/pools?page=1`,{headers:{Accept:'application/json'},timeout:10000}); return data?.data||[]; }
  catch { return []; }
}

// ─── DexScreener ──────────────────────────────────────────────────────────────
async function getDex(addr) {
  try { const {data} = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${addr}`,{timeout:10000}); return data?.pairs||[]; }
  catch { return []; }
}


// -- Clanker API --------------------------------------------------------------
// Fetches full deploy data: extensions.fees.recipients (reward ownership),
// vault, airdrop, devBuy, sniperTax -- langsung dari Clanker indexer.
// Endpoint: https://www.clanker.world/api/tokens?address={addr}&limit=1
// Returns null jika token bukan Clanker atau API tidak menjawab.
async function getClankerData(addr, chain) {
  const chainId = CHAIN[chain]?.cid;
  if (!chainId) return null;
  try {
    const { data } = await axios.get(
      `https://www.clanker.world/api/tokens?address=${addr}&limit=1`,
      { timeout: 10000 }
    );
    const token = (data?.data || []).find(
      t => t.contract_address?.toLowerCase() === addr.toLowerCase()
    );
    if (!token) return null;
    const ext = token.extensions || {};
    const recipients = ext.fees?.recipients || [];
    const adminAddr = (token.admin || token.msg_sender || '').toLowerCase();
    const singleSelf =
      recipients.length === 1 &&
      recipients[0].admin?.toLowerCase() === adminAddr &&
      recipients[0].recipient?.toLowerCase() === adminAddr;
    return {
      found: true,
      type: token.type || 'unknown',
      chain_id: token.chain_id,
      admin: token.admin,
      msg_sender: token.msg_sender,
      factory_address: token.factory_address,
      locker_address: token.locker_address,
      starting_market_cap: token.starting_market_cap,
      tags: token.tags || {},
      fees: ext.fees || null,
      recipients,
      recipientCount: recipients.length,
      singleSelfRecipient: singleSelf,
      hasVaultExt: !!ext.vault,
      hasAirdropExt: !!ext.airdrop,
      hasDevBuy: !!ext.devBuy,
      hasSniperTax: !!ext.sniperTax,
      vault: ext.vault || null,
      airdrop: ext.airdrop || null,
      devBuy: ext.devBuy || null,
    };
  } catch { return null; }
}
// ─── Off-chain intel (DuckDuckGo HTML scraper — lebih andal dari Instant Answer API) ──
// DDG Instant Answer API hampir SELALU return kosong untuk token crypto.
// HTML endpoint html.duckduckgo.com/html/ return hasil pencarian nyata.
async function searchWeb(query) {
  try {
    const { data } = await axios.get('https://html.duckduckgo.com/html/', {
      params: { q: query, kl: 'us-en' },
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10000,
    });
    const snippets = [];
    const stripTags = (s) => s.replace(/<[^>]+>/g, '')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/&#x27;/g,"'").replace(/&quot;/g,'"').replace(/&#x2F;/g,'/')
      .replace(/\s+/g,' ').trim();

    // Ekstrak snippet hasil pencarian — pakai string split, bukan regex literal
    // (menghindari masalah escaping regex dengan </a> dan [\s\S])
    const snipParts = data.split('class="result__snippet"');
    for (let i = 1; i < snipParts.length && snippets.length < 5; i++) {
      const tagEnd = snipParts[i].indexOf('>');
      const closeA = snipParts[i].indexOf('<' + '/a>');
      if (tagEnd >= 0 && closeA > tagEnd) {
        const text = stripTags(snipParts[i].slice(tagEnd + 1, closeA));
        if (text.length > 25) snippets.push(text.slice(0, 280));
      }
    }
    // Ekstrak judul hasil juga (tambahan konteks)
    const titleParts = data.split('class="result__a"');
    for (let i = 1; i < titleParts.length && snippets.length < 8; i++) {
      const tagEnd = titleParts[i].indexOf('>');
      const closeA = titleParts[i].indexOf('<' + '/a>');
      if (tagEnd >= 0 && closeA > tagEnd) {
        const text = stripTags(titleParts[i].slice(tagEnd + 1, closeA));
        if (text.length > 10 && !snippets.some(s => s.includes(text.slice(0, 30))))
          snippets.push(text.slice(0, 160));
      }
    }
    const result = snippets.join('\n').slice(0, 900);
    return result.length > 30 ? result : null;
  } catch { return null; }
}

async function offChainIntel(sym, name) {
  // Tiga query paralel: umum, ZachXBT, investigasi exchange
  const [r1, r2, r3] = await Promise.all([
    searchWeb(`"${sym}" ${name} scam rug crypto investigation`),
    searchWeb(`ZachXBT "${sym}" token manipulation`),
    searchWeb(`"${sym}" crypto pump dump CEX investigation ${new Date().getFullYear()-1} ${new Date().getFullYear()}`),
  ]);
  const all = [r1, r2, r3].filter(Boolean).join('\n\n');
  const hasResults = all.length > 50;
  return {
    raw: all.slice(0, 1500),
    hasResults,
    zachXBT: /zachxbt/i.test(all),
    cexInv: /bitget|binance|okx|gate\.|kraken|bybit.*investigat/i.test(all),
    rugged: /rug|scam|fraud|exit.{0,10}scam/i.test(all),
  };
}

// ─── Red flag scorer (all bankr checklist items) ──────────────────────────────
function scoreFlags({ gecko, dex, src, abi, creator, holders, deployer, allData,
                      isVerified, holderMeta, oft, offChain, chain }) {
  const lp = holderMeta?.lpLock;
  const F = [];
  const cfg = CHAIN[chain]||{};
  const best = dex?.find(p=>p.chainId===cfg.did)||dex?.[0];
  const liq  = parseFloat(best?.liquidity?.usd||0);

  // ── MARKET
  if (!gecko && !dex?.length) F.push({c:'MARKET', m:'Tidak ada di GeckoTerminal atau DexScreener'});
  if (liq>0&&liq<10000) F.push({c:'MARKET', m:`Likuiditas sangat rendah (${$(liq)}) — mudah dimanipulasi`});
  if (parseFloat(best?.priceChange?.h24||0)>500) F.push({c:'MARKET', m:`Harga naik ${parseFloat(best.priceChange.h24).toFixed(0)}% dalam 24h — tanpa fundamental jelas`});
  if (best?.pairCreatedAt && (Date.now()-best.pairCreatedAt)/3600000<24) F.push({c:'MARKET', m:`Pool dibuat ${((Date.now()-best.pairCreatedAt)/3600000).toFixed(1)} jam lalu — sangat baru`});

  // ── CONTRACT
  const si=src?.[0];const verified=si&&si.ABI!=='Contract source code not verified'&&si.SourceCode;
  const _qCl=!!(abi?.length&&JSON.stringify(abi).toLowerCase().includes('alldata'));
  if(!verified&&!_qCl)F.push({c:'CONTRACT',m:'Source code TIDAK diverifikasi di explorer'});
  if (si?.Proxy==='1') F.push({c:'CONTRACT', m:`Proxy/upgradeable contract — implementation: ${si.Implementation||'unknown'}`});
  if (abi) {
    const bad = abi.filter(f=>f.dangerous);
    if (bad.length) F.push({c:'CONTRACT', m:`Fungsi berbahaya: ${bad.map(f=>f.sig).join(', ')}`});
    // mint() — hanya flag jika BUKAN Clanker token (allData=null)
    // Clanker v4: mint(address,uint256) ada di ABI tapi restricted to factory → bukan red flag
    if (abi.some(f=>f.name==='mint') && !allData && !_isClankerFactory)
      F.push({c:'CONTRACT', m:'mint() ada — admin bisa inflasi supply kapan saja'});
    // Clanker token: mint ada tapi factory-restricted → tidak di-flag (silent)
    if (abi.some(f=>f.name?.toLowerCase().includes('blacklist'))) F.push({c:'CONTRACT', m:'blacklist() ada — admin bisa bekukan wallet holder manapun'});
    if (abi.some(f=>f.name==='pause')) F.push({c:'CONTRACT', m:'pause() ada — admin bisa stop semua transfer'});
    // ── LP withdrawal / rescue functions (high rug-pull risk)
    if (abi.some(f=>/withdraw(Liquidity|LP|All|ETH|Token)?$/i.test(f.name||'')))
      F.push({c:'CONTRACT', m:'withdrawLiquidity() / withdrawLP() ada — admin bisa tarik LP dari kontrak kapan saja ⚠️ HIGH RISK'});
    if (abi.some(f=>/^(rescue|rescueToken|rescueETH|recoverToken|recoverETH|emergencyWithdraw)$/i.test(f.name||'')))
      F.push({c:'CONTRACT', m:'rescue/recover/emergencyWithdraw() ada — admin bisa drain token/ETH dari kontrak'});
    if (abi.some(f=>f.name==='setPeer')) F.push({c:'CONTRACT', m:'setPeer() ada — admin bisa ganti peer kontrak (LayerZero bridge manipulation)'});
    if (abi.some(f=>/^set(Tax|Fee|TxLimit|MaxTx|MaxWallet|Router)$/i.test(f.name||'')))
      F.push({c:'CONTRACT', m:'setFee/setTax/setRouter() ada — admin bisa ubah parameter trading sewaktu-waktu'});
  }

  // ── CLANKER DETECTION — multi-layer
  const _cAddr=(creator?.contractCreator||'').toLowerCase();
  const _isClankerFactory=!!CLANKER_FACTORIES[_cAddr];
  const _hasClankerCtx=!!(allData?.context?.toLowerCase?.().includes('clanker'));
  const _isFarcaster=!!(allData?.context?.toLowerCase?.().includes('farcaster'));
  let _isClankerAbi=false;if(abi?.length){const s=JSON.stringify(abi).toLowerCase();_isClankerAbi=s.includes('alldata')&&s.includes('originaladmin');}
  const isClanker=_isClankerFactory||(allData!==null)||(isVerified!==null&&isVerified!==undefined)||_hasClankerCtx||_isClankerAbi;
  const isFarcasterClanker=_isFarcaster;
  if(isClanker){
    if(allData){
      if(!allData.metadata||allData.metadata.length<10)F.push({c:'CLANKER',m:'allData() metadata KOSONG'});
      if(!allData.context)F.push({c:'CLANKER',m:'allData() context kosong'});
      if(allData.originalAdmin&&allData.admin&&allData.originalAdmin!==allData.admin)F.push({c:'CLANKER',m:`Admin handoff: ${short(allData.originalAdmin)}→${short(allData.admin)}`});
    }
    if(holderMeta?.singleSelfRecipient===true)F.push({c:'CLANKER',m:'1 fee recipient=deployer sendiri — v4 support 7 recipient'});
    if(isVerified===true){}
    else if(isVerified===false&&_isFarcaster){}
    else if(isVerified===false)F.push({c:'CLANKER',m:'isVerified()=false — deploy via 3rd-party (Bankr/WarpCast/Doppler). WAJIB periksa LP lock.'});
  }

  // ── OFT
  if (oft?.isOft) {
    if (abi?.some(f=>f.name==='setPeer'&&f.mut!=='view')) F.push({c:'OFT', m:'setPeer() masih bisa dipanggil owner — risiko mint via malicious peer chain'});
    if (oft.peerCount===0) F.push({c:'OFT', m:'OFT tapi belum ada peer chain yang terkonfigurasi — bridge tidak bisa dipakai atau belum setup'});
  }

  // ── DEPLOYER
  if (deployer) {
    if (deployer.fresh) F.push({c:'DEPLOYER', m:`Wallet deployer sangat baru — nonce=${deployer.nonce}, first tx: ${deployer.firstDate}`});
    if (deployer.largeOutCount>0) F.push({c:'DEPLOYER', m:`${deployer.largeOutCount} transfer ETH besar keluar dari deployer — indikasi ekstraksi nilai post-launch`});
    if (deployer.fundedBy==='N/A') F.push({c:'DEPLOYER', m:'Sumber dana deployer tidak bisa ditelusuri'});
  }

  // ── HOLDERS
  if (holderMeta) {
    if (holderMeta.nonPoolConc>40) F.push({c:'HOLDERS', m:`Top non-pool holders menguasai ${holderMeta.nonPoolConc.toFixed(1)}% supply — konsentrasi tinggi`});
    if (holderMeta.sniperCount>1) F.push({c:'HOLDERS', m:`${holderMeta.sniperCount} holder adalah sniper proxy (48-byte bytecode) — bot di genesis`});
    if (holderMeta.cexSendCount>0) F.push({c:'HOLDERS', m:`${holderMeta.cexSendCount} top holder aktif kirim ke wallet CEX — indikasi distribusi ke exchange`});
    if (holderMeta.freshBuyers>2) F.push({c:'HOLDERS', m:`${holderMeta.freshBuyers} dari top-5 non-pool holder beli di blok awal launch — terkoordinasi`});
  }

  // ── OFFCHAIN
  if (offChain?.zachXBT) F.push({c:'OFFCHAIN', m:'⚠️ ZachXBT disebut dalam coverage — wajib cek langsung di X/Twitter'});
  if (offChain?.cexInv)  F.push({c:'OFFCHAIN', m:'⚠️ Kata kunci investigasi CEX ditemukan — risiko delisting/forced-unwind'});
  if (offChain?.rugged)  F.push({c:'OFFCHAIN', m:'Kata kunci rug/scam/exit ditemukan di coverage off-chain'});

  // ── LP LOCK (skip official Clanker — LP di Uniswap v4 PoolManager = protocol-managed)
  const _clankerLpSafe=(isVerified===true)||isFarcasterClanker;
  if(lp&&!_clankerLpSafe){
    if(lp.lpLockMethod==='none')F.push({c:'LP-LOCK',m:'LP token TIDAK dikunci — dev bisa tarik likuiditas kapan saja'});
    if(lp.lpLockMethod==='unconfirmed'||lp.lpLockMethod==='no_apikey')F.push({c:'LP-LOCK',m:`LP lock tidak dapat dikonfirmasi (${lp.lpLockMethod})`});
    if (lp.vaultLock && !lp.vaultLock.stillLocked)
      F.push({c:'LP-LOCK', m:`Supply vault sudah UNLOCK sejak ${lp.vaultLock.unlockDate} — team bisa jual token yang dilockup`});
    if (lp.airdropLock && !lp.airdropLock.stillLocked)
      F.push({c:'LP-LOCK', m:`Airdrop lock sudah EXPIRED sejak ${lp.airdropLock.unlockDate}`});
    if (lp.vaultLock && lp.vaultLock.stillLocked && lp.vaultLock.daysLeft < 7)
      F.push({c:'LP-LOCK', m:`Vault unlock dalam ${lp.vaultLock.daysLeft} hari (${lp.vaultLock.unlockDate}) — potensi sell pressure segera`});
  }

  const score = F.length;
  let V = score===0?'LOW':score<=2?'LOW-MEDIUM':score<=4?'MEDIUM':score<=6?'HIGH':'EXTREME';
  let conf = {LOW:80,'LOW-MEDIUM':70,MEDIUM:65,HIGH:75,EXTREME:85}[V];
  if (offChain?.zachXBT||offChain?.cexInv) {
    V = {LOW:'LOW-MEDIUM','LOW-MEDIUM':'MEDIUM',MEDIUM:'HIGH',HIGH:'EXTREME',EXTREME:'EXTREME'}[V];
    conf = Math.min(conf+10,95);
  }
  // Lower confidence if key forensic data is missing
  // Bug lama: kondisi berdasarkan si (source code) — jika source verified, confidence
  // tidak diturunkan meski deployer dan holders = null. Fix: basis pada deployer + holders.
  const missingDeployer = !creator?.contractCreator && !deployer;
  const missingHolders  = !holders?.length;
  const missingCoreForensics = missingDeployer && missingHolders;
  const missingOffchain = !offChain?.hasResults;
  // Turunkan confidence bertahap berdasarkan data yang hilang
  if (!ESCAN_KEY || missingCoreForensics) {
    conf = Math.min(conf, 55); // Semua data forensik hilang — confidence sangat terbatas
  } else if (missingDeployer || missingHolders) {
    conf = Math.min(conf, 62); // Sebagian data forensik hilang
  }
  if (missingOffchain && conf > 52) conf = Math.max(conf - 5, 50); // Penalti jika off-chain juga kosong
  const dataMissing = !ESCAN_KEY || missingCoreForensics;
  return { flags:F, score, verdict:V, confidence:conf, dataMissing };
}

// ─── Main collector ───────────────────────────────────────────────────────────
async function collect(addresses, chain) {
  const cfg = CHAIN[chain]||{};
  const lines = [];
  const hasKey = !!ESCAN_KEY;

  const hasRpc = !!PUBLIC_RPC[chain];
  const isAlchemy = chain === 'base' && !!process.env.ALCHEMY_BASE_RPC;
  const rpcLabel = !hasRpc ? '❌ tidak tersedia' : isAlchemy ? '✅ Alchemy (premium)' : '✅ public fallback';
  lines.push(`[CONFIG] Chain: ${cfg.name||chain} | ChainID: ${cfg.cid||'N/A'} | Etherscan V2: ${hasKey?'✅ key ada':'❌ tidak ada'} | RPC: ${rpcLabel}`);

  for (const addr of addresses.slice(0,2)) {
    lines.push(`\n${'═'.repeat(72)}`);
    lines.push(`TOKEN: ${addr}`);
    lines.push(`CHAIN: ${cfg.name||chain} | ${cfg.ex||''}/address/${addr}`);
    lines.push('═'.repeat(72));

    // ── Round 1: semua yang tidak saling bergantung
    const [gecko, geckoPools, dex, src, creator, abi, holders, clankerData] = await Promise.all([
      getGecko(addr, chain),
      getGeckoPools(addr, chain),
      getDex(addr),
      getSource(addr, chain),
      getCreator(addr, chain),
      getAbi(addr, chain),
      getHolders(addr, chain),
      getClankerData(addr, chain),
    ]);

    const bestPair = dex?.find(p=>p.chainId===cfg.did)||dex?.[0];
    // Bug5 note: tokenholderlist adalah endpoint Etherscan Pro — free key selalu null
    if (hasKey && !holders) {
      lines.push('  ⚠️ [tokenholderlist] Holder data kosong — kemungkinan butuh Etherscan Pro subscription (endpoint berbayar)');
    }
    const sym  = gecko?.symbol || bestPair?.baseToken?.symbol || addr.slice(0,8);
    const name = gecko?.name   || bestPair?.baseToken?.name   || '';

    // ── Round 2: eth_call + deployer + offchain + LP lock (paralel)
    const [allData, isVerified, totalSupply, owner, deployer, offChain, lpLock] = await Promise.all([
      readAllData(addr, chain),
      readIsVerified(addr, chain),
      readTotalSupply(addr, chain),
      readOwner(addr, chain),
      creator?.contractCreator ? getDeployerLifecycle(creator.contractCreator, chain) : Promise.resolve(null),
      offChainIntel(sym, name),
      getLpLockInfo(bestPair?.pairAddress || null, chain, clankerData, bestPair, addr),
    ]);

    // ── Round 3: holder enrichment (top 5 non-pool)
    const poolAddrs = new Set([bestPair?.pairAddress?.toLowerCase(), UNIV4_BASE].filter(Boolean));
    const nonPoolH  = (holders||[]).filter(h=>{
      const a=h.TokenHolderAddress?.toLowerCase();
      return !poolAddrs.has(a)&&!INFRA.has(a);
    }).slice(0,5);

    // Bytecode, vault check, first-buy, CEX sends — paralel per holder
    // Bug4 fix: classify() dipanggil sekali, hasilnya dipakai ulang untuk vault check
    const holderEnriched = await Promise.all(nonPoolH.map(async (h) => {
      const a = h.TokenHolderAddress;
      const type = await classify(a, chain);
      const [isVault, firstBuy, cexSends] = await Promise.all([
        type === 'contract' ? checkVaultExtension(a, addr, chain) : Promise.resolve(false),
        getHolderFirstBuy(a, addr, chain),
        checkCexSends(a, addr, chain),
      ]);
      return { ...h, _type:type, _isVault:isVault, _firstBuy:firstBuy, _cexSends:cexSends||0 };
    }));

    // OFT peers
    const oftFlag = isOft(abi);
    let oftPeers = {};
    if (oftFlag) oftPeers = await readOftPeers(addr, chain);

    // Holder meta summary
    const totalS = parseFloat(holders?.[0]?.TotalSupply||0);
    let nonPoolConc=0, poolConc=0, sniperCount=0, cexSendCount=0, freshBuyers=0, vaultCount=0, airdropCount=0;
    (holders||[]).forEach(h=>{
      const a=h.TokenHolderAddress?.toLowerCase();
      const isPool=poolAddrs.has(a); const isInfra=INFRA.has(a);
      const pct = totalS ? parseFloat(h.TokenHolderQuantity)/totalS*100 : 0;
      if(isPool||isInfra) poolConc+=pct; else nonPoolConc+=pct;
    });
    holderEnriched.forEach(h=>{
      if(h._type==='sniper_proxy') sniperCount++;
      if(h._cexSends>0) cexSendCount++;
      if(h._isVault) { if (h._firstBuy?.txHash) airdropCount++; else vaultCount++; }
      // fresh buyer = first buy on same DATE as pool creation (genesis sniper heuristic)
      if(h._firstBuy?.date && bestPair?.pairCreatedAt) {
        const pairDate = new Date(bestPair.pairCreatedAt).toISOString().split('T')[0];
        if(h._firstBuy.date === pairDate) freshBuyers++;
      }
    });

    // Prefer Clanker API data for vault/airdrop (more reliable than bytecode heuristic)
    const hasVault   = clankerData ? clankerData.hasVaultExt   : vaultCount > 0;
    const hasAirdrop = clankerData ? clankerData.hasAirdropExt : airdropCount > 0;
    const holderMeta = { nonPoolConc, sniperCount, cexSendCount, freshBuyers, vaultCount, airdropCount,
      hasVault, hasAirdrop,
      rewardCount:         clankerData ? clankerData.recipientCount    : null,
      singleSelfRecipient: clankerData ? clankerData.singleSelfRecipient : null,
      clankerTags:         clankerData ? clankerData.tags               : null,
      lpLock,
    };

    // ── Score
    const { flags, score, verdict, confidence, dataMissing } = scoreFlags({
      gecko, dex, src, abi, creator, holders, deployer:deployer, allData, isVerified,
      holderMeta, oft:{isOft:oftFlag, peerCount:Object.keys(oftPeers).length}, offChain, chain,
    });
    // lpLock is in holderMeta, scoreFlags reads it via holderMeta.lpLock

    // ── Format output
    lines.push(`\n🏁 VERDICT: ${verdict} RISK | Confidence: ${confidence}% | Score: ${score}`);
    if (dataMissing) lines.push('⚠️  Confidence dibatasi — data forensik kunci (deployer + top holders) tidak tersedia; off-chain intel: ' + (offChain?.hasResults ? '✅ ada' : '❌ kosong'));

    // ── Market
    lines.push('\n📊 [MARKET DATA]');
    if (gecko) {
      lines.push(`  Nama:        ${gecko.name} (${gecko.symbol})`);
      lines.push(`  Harga:       ${$p(gecko.price_usd)} | MCap: ${$(gecko.market_cap_usd)} | FDV: ${$(gecko.fdv_usd)}`);
      lines.push(`  Volume 24h:  ${$(gecko.volume_usd?.h24)}`);
      const pc=gecko.price_change_percentage;
      if(pc) lines.push(`  Perubahan:   1h=${pc.h1||'N/A'}%  24h=${pc.h24||'N/A'}%  7d=${pc.d7||'N/A'}%`);
      if(gecko.gt_score!=null) lines.push(`  GT Score:    ${gecko.gt_score}/100`);
      lines.push(`  GeckoTerminal: https://www.geckoterminal.com/${cfg.gid}/tokens/${addr}`);
    } else if (bestPair) {
      lines.push(`  Nama:        ${bestPair.baseToken?.name} (${bestPair.baseToken?.symbol}) [DexScreener]`);
      lines.push(`  Harga:       ${$p(bestPair.priceUsd)} | MCap: ${$(bestPair.marketCap)}`);
      lines.push(`  Volume 24h:  ${$(bestPair.volume?.h24)} | Perubahan 24h: ${bestPair.priceChange?.h24}%`);
    } else {
      lines.push('  ❌ TIDAK DITEMUKAN di GeckoTerminal maupun DexScreener');
    }
    if (bestPair) {
      lines.push(`  Likuiditas:  ${$(bestPair.liquidity?.usd)} | DEX: ${bestPair.dexId}`);
      if (bestPair.pairCreatedAt) lines.push(`  Pool dibuat: ${new Date(bestPair.pairCreatedAt).toISOString().split('T')[0]}`);
      if (bestPair.info?.websites?.[0]) lines.push(`  Website:     ${bestPair.info.websites[0].url}`);
      if (bestPair.info?.socials?.length) lines.push(`  Socials:     ${bestPair.info.socials.map(s=>s.type+':'+s.url).join(' | ')}`);
      lines.push(`  DexScreener: ${bestPair.url||'https://dexscreener.com/'+bestPair.chainId+'/'+bestPair.pairAddress}`);
    }
    if (geckoPools.length) {
      lines.push('\n💧 [POOLS]');
      geckoPools.slice(0,3).forEach((p,i)=>{
        const a=p.attributes;
        lines.push(`  #${i+1} ${a?.name||'N/A'} | Liq: ${$(a?.reserve_in_usd)} | Vol24h: ${$(a?.volume_usd?.h24)}${a?.security_indicators?.length?' | ⚠️ '+a.security_indicators.join(','):''}`);
      });
    }

    // ── On-chain reads
    lines.push('\n🔗 [ON-CHAIN READS — eth_call via Etherscan V2]');
    if (!hasKey) {
      lines.push('  ⛔ Semua on-chain reads di-skip — ETHERSCAN_API_KEY tidak ada');
    } else {
      if (allData) {
        const isClanker = !!(allData.context||allData.metadata);
        lines.push(`  Platform:      ${allData.context||'tidak teridentifikasi'}`);
        lines.push(`  originalAdmin: ${allData.originalAdmin}`);
        lines.push(`  admin:         ${allData.admin}`);
        lines.push(`  Admin berubah: ${allData.originalAdmin!==allData.admin?'⚠️ YA — handoff post-deploy':'tidak'}`);
        lines.push(`  metadata:      ${allData.metadata?.slice(0,200)||'❌ KOSONG'}`);
        lines.push(`  image:         ${allData.image?'✅ ada':'❌ kosong'}`);
        if (isClanker) {
          lines.push(`  Vault ext:     ${holderMeta.hasVault?'✅ YA':'❌ TIDAK — team tidak lock supply'}`);
          lines.push(`  Airdrop ext:   ${holderMeta.hasAirdrop?'✅ YA':'❌ TIDAK'}`);
        }
        if (clankerData) {
          const rc = clankerData.recipientCount;
          const selfFlag = clankerData.singleSelfRecipient ? ' [DEPLOYER SENDIRI — RED FLAG]' : '';
          const rcLabel = rc === 0 ? '❌ 0 (tidak ada?)'
            : rc === 1 ? ('⚠️ 1' + selfFlag)
            : ('✅ ' + rc + ' recipient berbeda');
          lines.push(`  Fee recipients: ${rcLabel}`);
          clankerData.recipients.forEach((r, i) => {
            const same = r.admin?.toLowerCase() === r.recipient?.toLowerCase() ? ' [admin=recipient]' : '';
            lines.push(`    [${i+1}] bps=${r.bps} admin=${short(r.admin)} recipient=${short(r.recipient)}${same}`);
          });
          if (clankerData.hasDevBuy && clankerData.devBuy?.amountEth)
            lines.push(`  DevBuy:         ✅ ya — ${(Number(clankerData.devBuy.amountEth)/1e18).toFixed(6)} ETH dipre-deploy`);
          if (clankerData.hasSniperTax)
            lines.push(`  SniperTax:      ✅ ya (anti-sniper fee aktif saat launch)`);
          if (clankerData.starting_market_cap)
            lines.push(`  Starting MCap:  ${(clankerData.starting_market_cap).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0})}`);
        }
      } else {
        lines.push('  allData():     N/A (bukan Clanker/Doppler atau call gagal)');
      }
      const _ivL=isVerified===true?'✅ true — resmi clanker.world (LP aman)':isVerified===false?(_isFarcaster?'⚠️ false — Farcaster (official):':'⚠️ false — 3rd-party, cek LP'):'ℹ️ null — bukan Clanker';
      lines.push(`  isVerified():  ${_ivL}`);
      if (totalSupply) {
        const ts = (Number(totalSupply)/1e18).toLocaleString('en-US',{maximumFractionDigits:0});
        lines.push(`  totalSupply(): ${ts}`);
      }
      if (owner) lines.push(`  owner():       ${owner}`);
    }

    // ── OFT
    if (oftFlag) {
      lines.push('\n🌉 [LAYERZERO OFT DETECTION]');
      lines.push(`  OFT terdeteksi: ✅ YA (ada setPeer/peers/send di ABI)`);
      lines.push(`  Peers terkonfigurasi: ${Object.keys(oftPeers).length===0?'❌ tidak ada':Object.entries(oftPeers).map(([n,a])=>`${n}=${short(a)}`).join(' | ')}`);
      lines.push(`  ⚠️ setPeer() masih callable by owner — risiko mint via malicious peer`);
    }

    // ── Contract source
    lines.push('\n📄 [CONTRACT SOURCE — Etherscan V2]');
    const si=src?.[0];
    if (si) {
      const v = si.ABI!=='Contract source code not verified'&&!!si.SourceCode;
      lines.push(`  Verified:   ${v?'✅ YES':'❌ NO — source code tidak tersedia'}`);
      lines.push(`  Nama:       ${si.ContractName||'N/A'} | Compiler: ${si.CompilerVersion||'N/A'}`);
      lines.push(`  Proxy:      ${si.Proxy==='1'?'⚠️ YES (impl: '+(si.Implementation||'unknown')+')':'NO'}`);
    } else {
      lines.push('  N/A (perlu ETHERSCAN_API_KEY atau kontrak unverified)');
    }

    // ── ABI
    if (abi?.length) {
      const bad=abi.filter(f=>f.dangerous);
      lines.push('\n⚙️  [ABI FUNCTIONS]');
      if(bad.length) lines.push(`  ⚠️ DANGEROUS: ${bad.map(f=>f.sig).join(' | ')}`);
      lines.push(`  OTHER: ${abi.filter(f=>!f.dangerous).slice(0,8).map(f=>f.sig).join(' | ')}${abi.length>8?` (+${abi.length-8} lagi)`:''}`);
    } else {
      lines.push('\n⚙️  [ABI FUNCTIONS] N/A (unverified atau no API key)');
    }
    // ── LP Lock section
    lines.push('\n🔒 [LP LOCK STATUS — Metodologi Bankr: V2 burn/V3 NFT/Clanker native]');
    if (!lpLock) {
      lines.push('  N/A (data tidak tersedia)');
    } else {
      // LP lock status
      const dexLabel = lpLock.dexType ? ` [${lpLock.dexType.toUpperCase()}]` : '';
      if (lpLock.lpLocked) {
        lines.push(`  LP Status:     ✅ LOCKED${dexLabel} — ${lpLock.lpLockerName || lpLock.lpLockMethod}`);
        if (lpLock.lpLockerAddr) lines.push(`  Locker addr:   ${lpLock.lpLockerAddr} | ${cfg.ex}/address/${lpLock.lpLockerAddr}`);
        if (lpLock.lpLockedPct) lines.push(`  LP dikunci:    ${lpLock.lpLockedPct}% dari total LP token`);
        if (lpLock.burnedPct)   lines.push(`  LP di-burn:    ${lpLock.burnedPct}% ke 0x...dead / 0x...000 (permanen)`);
      } else if (lpLock.lpLockMethod === 'none') {
        lines.push(`  LP Status:     ❌ TIDAK DIKUNCI${dexLabel} — dev bisa tarik likuiditas kapan saja`);
        if (lpLock.burnedPct)   lines.push(`  LP di-burn:    ${lpLock.burnedPct}% (tidak cukup untuk dianggap aman)`);
      } else {
        const reasonMap = {
          'no_apikey':    '❓ Tidak bisa dicek — ETHERSCAN_API_KEY tidak tersedia di environment',
          'no_pair':      '❓ Tidak bisa dicek — LP pair address tidak ditemukan di DexScreener',
          'unconfirmed':  '❓ Tidak dapat dikonfirmasi — V3 NFT check tidak return data untuk token ini',
          'gauge_staked': '⚠️ Staked di Aerodrome gauge (bukan lock permanen, bisa unstake)',
        };
        const reason = reasonMap[lpLock.lpLockMethod] || '❓ Tidak bisa dikonfirmasi';
        lines.push(`  LP Status:     ${reason}${dexLabel}`);
      }
      // Vault supply lock
      if (lpLock.vaultLock) {
        const v = lpLock.vaultLock;
        const locked = v.stillLocked ? `✅ LOCKED (${v.daysLeft} hari lagi)` : `❌ SUDAH UNLOCK sejak ${v.unlockDate}`;
        lines.push(`  Vault lock:    ${locked} | ${v.pct}% supply (${v.amount}) unlock: ${v.unlockDate}`);
        if (v.vestEndDate) lines.push(`  Vest end:      ${v.vestEndDate}`);
      }
      // Airdrop lock
      if (lpLock.airdropLock) {
        const a = lpLock.airdropLock;
        const locked = a.stillLocked ? `✅ LOCKED (${a.daysLeft} hari lagi)` : `❌ SUDAH UNLOCK sejak ${a.unlockDate}`;
        lines.push(`  Airdrop lock:  ${locked} | ${a.pct}% supply (${a.amount}) unlock: ${a.unlockDate}`);
      }
      // Notes
      lpLock.notes.forEach(n => lines.push(`  Note: ${n}`));
    }

    // ── Deployer
    lines.push('\n👤 [DEPLOYER FORENSICS — txlist]');
    if (creator) lines.push(`  Deployer: ${creator.contractCreator} | ${cfg.ex}/address/${creator.contractCreator}`);
    else lines.push('  Deployer: tidak ditemukan (getcontractcreation gagal)');
    if (deployer) {
      lines.push(`  Nonce:    ${deployer.nonce} tx${deployer.fresh?' (⚠️ FRESH WALLET)':' (established)'}`);
      lines.push(`  Pertama aktif: ${deployer.firstDate} | Didanai oleh: ${deployer.fundedBy}`);
      if(deployer.largeOutCount) lines.push(`  ⚠️ ${deployer.largeOutCount} transfer ETH besar keluar dari deployer setelah launch`);
    } else {
      lines.push('  Lifecycle: N/A (perlu API key)');
    }

    // ── Holder distribution
    lines.push('\n👥 [HOLDER DISTRIBUTION — bytecode + first-buy + CEX send]');
    if (holders?.length) {
      (holders).slice(0,15).forEach((h,i)=>{
        const a=h.TokenHolderAddress?.toLowerCase();
        const isPool=poolAddrs.has(a); const isInfra=INFRA.has(a);
        const pct=totalS?(parseFloat(h.TokenHolderQuantity)/totalS*100).toFixed(2):'?';
        const enriched=holderEnriched.find(e=>e.TokenHolderAddress?.toLowerCase()===a);
        const tags=[];
        if(isPool) tags.push('[POOL/DEX]');
        else if(isInfra) tags.push('[INFRA/BURN]');
        else {
          tags.push(`[${enriched?._type||'eoa'}]`);
          if(enriched?._isVault) tags.push('[CLANKER-VAULT]');
          if(enriched?._cexSends>0) tags.push(`[⚠️ CEX-SEND x${enriched._cexSends}]`);
          if(enriched?._firstBuy) tags.push(`[first-buy: blk${enriched._firstBuy.blockNumber} / ${enriched._firstBuy.date}]`);
        }
        lines.push(`  ${String(i+1).padStart(2)}. ${h.TokenHolderAddress} — ${pct}% ${tags.join(' ')}`);
      });
      lines.push(`\n  Non-pool concentration (top 15): ${nonPoolConc.toFixed(1)}% ${nonPoolConc>50?'⚠️ TINGGI':nonPoolConc>30?'🟡 SEDANG':'✅ NORMAL'}`);
      lines.push(`  Pool/DEX share: ~${poolConc.toFixed(1)}%`);
    } else {
      lines.push('  N/A (perlu ETHERSCAN_API_KEY)');
    }

    // ── Off-chain intel
    lines.push('\n🌐 [OFF-CHAIN INTEL — Web Search (DDG HTML)]');
    lines.push(`  Hasil pencarian: ${offChain?.hasResults?'✅ ada data':'❌ tidak ada hasil relevan'}`);
    lines.push(`  ZachXBT flagged: ${offChain?.zachXBT?'⚠️ YA':'tidak'} | CEX investigation: ${offChain?.cexInv?'⚠️ YA':'tidak'} | Rug keywords: ${offChain?.rugged?'⚠️ YA':'tidak'}`);
    if(offChain?.raw) lines.push(`  Snippet:\n  ${offChain.raw.split('\n').slice(0,6).join('\n  ')}`);
    else lines.push('  (tidak ada snippet — tidak ada coverage publik yang ditemukan)');

    // ── Data availability summary (pre-formatted table — AI HARUS salin verbatim)
    const lpStatus = !lpLock ? '❌ N/A'
      : lpLock.lpLocked ? '✅ LOCKED via ' + (lpLock.lpLockerName||lpLock.lpLockMethod)
      : lpLock.lpLockMethod === 'none'         ? '❌ TIDAK DIKUNCI — dev bisa rug'
      : lpLock.lpLockMethod === 'gauge_staked'  ? '⚠️ Staked di Aerodrome gauge (' + (lpLock.gaugeStaked?.pct||'?') + '% — bukan lock permanen)'
      : lpLock.lpLockMethod === 'no_apikey'    ? '❓ API key tidak ada — tidak bisa cek on-chain'
      : lpLock.lpLockMethod === 'no_pair'      ? '❓ Pair address tidak ditemukan'
      : lpLock.lpLockMethod === 'unconfirmed'  ? '❓ Tidak terkonfirmasi (' + (lpLock.dexType||'?') + ' pool — locker tidak dikenal)'
      : '❓ Tidak bisa dikonfirmasi';
    lines.push('\n📋 [DATA AVAILABILITY — SALIN VERBATIM, JANGAN parafrase atau ubah kata-kata]');
    lines.push(`• GeckoTerminal    : ${gecko?'✅ tersedia':'❌ tidak ditemukan'}`);
    lines.push(`• DexScreener      : ${bestPair?'✅ tersedia':'❌ tidak ditemukan'}`);
    lines.push(`• Contract source  : ${si&&si.ABI!=='Contract source code not verified'?'✅ verified':'❌ tidak tersedia'}`);
    lines.push(`• ABI functions    : ${abi?.length?'✅ tersedia ('+abi.length+' fungsi)':'❌ tidak tersedia'}`);
    lines.push(`• allData() Clanker: ${allData?'✅ tersedia':'❌ bukan Clanker'}`);
    lines.push(`• LP Lock (Bankr)  : ${lpStatus}`);
    lines.push(`• Clanker API      : ${clankerData?'✅ tersedia ('+clankerData.recipientCount+' recipient)':'❌ bukan token Clanker'}`);
    lines.push(`• isVerified()     : ${isVerified===true?'✅ true — clanker.world':isVerified===false?'⚠️ false — 3rd-party':'ℹ️ null — bukan Clanker'}`);
    lines.push(`• Clanker factory  : ${CLANKER_FACTORIES[_cAddr]||'❌ non-Clanker'}`);
    lines.push(`• Deployer / txlist: ${creator||deployer?'✅ tersedia':'❌ tidak tersedia'}`);
    lines.push(`• Top holders      : ${holders?.length?'✅ tersedia ('+holders.length+' holder)':'❌ tidak tersedia'}`);
    lines.push(`• Vault/Airdrop    : ${holderMeta.hasVault||holderMeta.hasAirdrop?'✅ terdeteksi':'❌ tidak ada'}`);
    lines.push(`• OFT detection    : ${oftFlag?'✅ YA (LayerZero OFT)':'✅ bukan OFT'}`);
    lines.push(`• Off-chain intel  : ${offChain?.hasResults?'✅ ada ('+([offChain.zachXBT&&'ZachXBT',offChain.cexInv&&'CEX',offChain.rugged&&'rug-kw'].filter(Boolean).join(', ')||'tidak ada flag')+')':'❌ tidak ada coverage publik'}`);

    // ── Red flags
    lines.push(`\n🚩 [RED FLAGS — Score: ${score} | LOW=0, LOW-MED≤2, MED≤4, HIGH≤6, EXTREME≥7]`);
    if(!flags.length) lines.push('  ✅ Tidak ada red flag terdeteksi dari data yang tersedia');
    else flags.forEach(f=>lines.push(`  ⚠️ [${f.c}] ${f.m}`));
    lines.push(`\n  VERDICT: ${verdict} RISK | Confidence: ${confidence}%`);
  }

  return lines.join('\n');
}

// ─── Platform docs (Step 0 dari bankr skill) ─────────────────────────────────
const PLATFORM_DOCS = `
## STEP 0: Platform Knowledge (wajib sebelum "Claim vs Reality")

### Clanker v4 (allData context = "clanker.world", factory 0xe85a59c628f7d27878aceb4bf3b35733630083a9)
- Supply baku: 100 MILIAR token (100_000_000_000 * 1e18)
- Semua di bawah ini BISA dikonfigurasi di SATU deploy transaction — TIDAK perlu redeploy:
  • Vault extension: lock hingga 90% supply, min 7 hari
  • Airdrop extension: distribusi hingga 90% supply, min 1 hari
  • Hingga 7 reward recipients (fee splits ke multiple wallet)
  • Safe multisig sebagai admin (bukan EOA)
  • Custom fee % (static atau dynamic)
  • Custom paired token, initial market cap
- Token bytecode IDENTIK antar deploy (factory template) — BUKAN red flag
- Jika tim bilang "perlu redeploy untuk fix tokenomics" → ini BOHONG, semua bisa di deploy-time
- Vault/Airdrop terdeteksi sebagai top holder (contract yang holds supply dengan lockup)

### Bankr / Doppler
- Deployer dapat beneficiary shares di launch
- Pool di-lock secara native
- 95/5 fee split bawaan
- TIDAK ada mekanisme migration built-in — jika migrasi terjadi, itu keputusan tim bukan fitur platform

### LayerZero OFT (ada setPeer, peers, send di ABI)
- setPeer() adalah kekuasaan admin terbesar — bisa tambah peer chain baru dan mint via _credit
- LZ V2 endpoint di Base: 0x1a44076050125825900e736c501f859c50fE728c
- Peers yang cocok di semua chain explorer = konfigurasi bridge yang legitimate
- Admin multisig + timelock untuk setPeer = lebih aman dari EOA admin

### LP Lock Detection — Metodologi Bankr (5 Layer)
- **Layer A (Clanker v4 native)**: \`locker_address\` dari Clanker API = LP terkunci permanen oleh protokol
- **Layer B (V2/Aerodrome)**: \`balanceOf(0x...dead)\` + \`balanceOf(0x...zero)\` pada LP token / totalSupply → jika ≥95% = permanently burned = aman (rug-proof)
- **Layer C (V3 NFT)**: Cari ERC-721 transfer ke burn address dari NFPM (\`0x8279...\` di Base), lalu \`positions(tokenId)\` → jika NFT posisi LP di dead address = terkunci permanen
- **Layer D (Known lockers)**: Cek top-10 LP token holder vs UNCX/TeamFinance/PinkSale/Mudra; detect time-lock via \`unlockDate()\` / \`releaseTime()\`
- **Layer E (Supply lock)**: \`vault.lockup\` + \`airdrop.lockup\` = tanggal unlock supply team (bukan LP)
- **dexType**: terdeteksi dari DexScreener dexId → 'v2'|'v3'|'v4'|'aerodrome'|'unknown'
- **Red flag**: \`lpLockMethod = 'none'\` = tidak ada burn/locker/timelock = dev bisa rug kapan saja
- **Bukti permanen (V2)**: burnedPct ≥95% = hampir seluruh LP di dead address
- **Bukti permanen (V3)**: NFT posisi LP ada di 0x...dead = tidak bisa ditarik siapapun

### Uniswap v4 PoolManager (Base)
- Alamat: 0x498581ff718922c3f8e6a244956af099b2652b2b
- JANGAN dihitung sebagai whale — ini adalah pool DEX
- Exclude dari concentration math
`;

// ─── System prompt ────────────────────────────────────────────────────────────
const SKILL_SYSTEM = `
Kamu menjalankan TOKEN SCAM / RUG-PULL ANALYSIS SKILL berdasarkan metodologi Bankr forensic.
Data real-time sudah dikumpulkan oleh sistem dan tersedia di bawah.

${PLATFORM_DOCS}

## INSTRUKSI KRITIS (baca sebelum menulis apapun):

1. **GUNAKAN HANYA DATA YANG ADA.** Cek bagian [DATA AVAILABILITY] — jika field bertanda ❌, kamu TIDAK TAHU nilainya. Tulis "tidak diketahui" atau "data tidak tersedia", JANGAN estimasi.

2. **KERJA STEP-BY-STEP** — jangan langsung ke verdict:
   a. Mulai dengan ringkasan data yang tersedia vs yang kosong
   b. Periksa setiap checklist item satu per satu
   c. Hitung score
   d. Baru tulis verdict

3. **NARRATIVE IS NOISE, ON-CHAIN IS SIGNAL.** Setiap klaim tim harus dicocokkan dengan data on-chain. Gunakan Section "Claim vs Reality" untuk ini.

4. **ON-CHAIN CLEAN ≠ TIDAK SCAM.** Kontrak bagus bisa tetap dipakai insider pump-and-dump. Off-chain intel wajib masuk ke verdict.

5. **Confidence dibatasi** jika data kunci tidak tersedia (deployer, holders, ABI semua N/A karena tidak ada API key).

6. **LP LOCK ❓ atau no_apikey/unconfirmed = BUKAN undangan tutorial.** Jika LP Lock check menunjukkan ❓, cukup tulis satu kalimat: "LP lock tidak dapat dikonfirmasi karena [alasan dari notes]." JANGAN pernah:
   - Memberikan langkah-langkah manual cara cek LP
   - Menyebut "kamu bisa buka GeckoTerminal/DexScreener/Basescan dan..."
   - Memberikan tutorial, panduan, atau instruksi apapun kepada user
   Data yang tidak ada = tidak diketahui. Titik. Lanjut ke bagian data berikutnya.

## ATURAN FORMAT — BACA SEBELUM MENULIS:

- **SKIP seksi yang datanya semua ❌.** Jika Deployer, Holder, Claim tidak ada data, JANGAN tulis seksinya sama sekali — langsung lanjut ke seksi berikutnya.
- **Jangan tulis "tidak tersedia" lebih dari sekali per seksi.** Jika semua field di seksi itu N/A, skip saja.
- **JANGAN gunakan tabel markdown (|---|---|).** Discord tidak render tabel — gunakan bullet (•) untuk semua daftar data.
- **Satu kalimat per poin.** Jangan paragraph panjang untuk hal yang simpel.

## FORMAT LAPORAN:

**🔍 VERDICT: [LOW/LOW-MEDIUM/MEDIUM/HIGH/EXTREME] RISK — Confidence [X]%**
> [1-2 kalimat ringkasan: data apa yang ada, flag utama, keterbatasan analisis]

---
**📋 Ketersediaan Data**
[SALIN VERBATIM bullet [DATA AVAILABILITY] — jangan ubah isi bullet sama sekali]

---
**📊 Token Info**
• Alamat    : [address]
• Chain     : [chain]
• Platform  : [dari allData context atau "tidak terdeteksi"]
• Verified  : [✅/❌]
• Market Cap: [nilai atau N/A]
• Likuiditas: [nilai atau N/A]
• LP Lock   : [dari LP Status]
[Hanya tampilkan baris yang ada nilainya. Skip baris N/A kecuali Market Cap dan LP Lock.]

---
**🚩 Red Flags Terdeteksi**
[Daftar flag dari [RED FLAGS]. Jika tidak ada flag → tulis "✅ Tidak ada red flag dari data yang tersedia". JANGAN ceritakan ulang flag yang sudah ada di daftar — cukup referensikan.]

---
**⚙️ Analisis Kontrak**
[HANYA jika ABI tersedia. Sebutkan fungsi berbahaya + implikasinya dalam 2-3 kalimat. Skip seksi ini jika ABI ❌.]

---
**👤 Deployer** *(skip jika data tidak tersedia)*
[funding source → deploy → extraction pattern. 2-3 kalimat.]

---
**👥 Holders** *(skip jika data tidak tersedia)*
[Top holders non-pool, concentration, sniper count, CEX send. Skip jika holder ❌.]

---
**🌐 Off-Chain**
[1-2 kalimat: ZachXBT, CEX flag, snippet jika ada. Jika tidak ada coverage → "Tidak ada coverage publik ditemukan."]

---
**🔄 Faktor Pengubah Verdict**
- Akan TURUNKAN risk: [spesifik, 1-2 item]
- Akan NAIKKAN risk: [spesifik, 1-2 item]

---
**🔗 Explorer**
[Hanya link yang relevan — token + deployer jika tersedia]

*NFA. DYOR.*
`;

// ─── Entrypoint ───────────────────────────────────────────────────────────────
async function runScamAnalysis(question) {
  const addresses = extractAddresses(question);
  const chain     = detectChain(question);
  let data = '';
  try { data = await collect(addresses, chain); }
  catch(e) { data = `[Error: ${e.message}]`; }

  const fullPrompt = [
    SKILL_SYSTEM,
    '\n\n══════════════════════════════════════════════════════════════════════',
    '[DATA REAL-TIME — ETHERSCAN V2 + GECKOTERMINAL + DEXSCREENER + OFFCHAIN]',
    '══════════════════════════════════════════════════════════════════════',
    data,
    '\n══════════════════════════════════════════════════════════════════════',
    '[PERTANYAAN USER]',
    '══════════════════════════════════════════════════════════════════════',
    question,
    '\n\nIkuti instruksi STEP-BY-STEP di atas. Bahasa Indonesia.',
    'Jika data tidak ada, katakan "tidak tersedia" — jangan estimasi.',
    'Di akhir berikan summary 4-6 bullet untuk user.',
  ].join('\n');

  return { applicable:true, addresses, chain, fullPrompt };
}

module.exports = { isScamAnalysisRequest, runScamAnalysis };
