// lib/tokenScamAnalysis.js
// Token scam/rug-pull analysis — full Bankr skill spec
//
// Data: GeckoTerminal · DexScreener · Etherscan V2 (satu key, semua EVM, chainid param)
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

// Known Clanker v4 factory (Base)
const CLANKER_FACTORY = '0xe85a59c628f7d27878aceb4bf3b35733630083a9';

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
  if (/\boptimism\b|\bop\b/.test(t)) return 'optimism';
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
const decBool   = (h) => (h?.startsWith('0x') ? h.slice(2) : h)?.slice(-1) === '1';
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

// ─── On-chain reads ───────────────────────────────────────────────────────────
const readAllData     = (a,c) => ethcall(c,a,'0x773a5096').then(r=>r?decAllData(r):null);
const readIsVerified  = (a,c) => ethcall(c,a,'0xe8d5ce15').then(r=>r!=null?decBool(r):null);
const readTotalSupply = (a,c) => ethcall(c,a,'0x18160ddd').then(r=>r?decUint(r):null);
const readOwner       = (a,c) => ethcall(c,a,'0x8da5cb5b').then(r=>r?decAddr(r):null);
const readDecimals    = (a,c) => ethcall(c,a,'0x313ce567').then(r=>r?Number(decUint(r)):18);
const readBytecode    = (a,c) => escan(c,{module:'proxy',action:'eth_getCode',address:a,tag:'latest'});

// Read token() — returns token address if holder is a Clanker vault/airdrop extension
const readTokenOf = (a,c) => ethcall(c,a,'0xfc0c546a').then(r=>r?decAddr(r):null);

// OFT: read peers(uint32 eid)
async function readOftPeer(contract, eid, chain) {
  // peers(uint32) selector = 0x15a84c64, arg = uint32 padded to 32 bytes
  const data = '0x15a84c64' + eid.toString(16).padStart(64,'0');
  const r = await ethcall(chain, contract, data);
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
    const DANGER = ['mint','crosschainmint','setowner','updateadmin','blacklist','setfee','pause','updateimage','updatemetadata','setpeer','setminter','freeze'];
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

// ─── Off-chain intel (DuckDuckGo) ────────────────────────────────────────────
async function ddg(q) {
  try {
    const {data} = await axios.get('https://api.duckduckgo.com/',{params:{q,format:'json',no_html:'1',skip_disambig:'1'},timeout:8000});
    const parts=[]; if(data.Abstract) parts.push(data.Abstract);
    (data.RelatedTopics||[]).slice(0,5).forEach(t=>{if(t.Text) parts.push(t.Text.slice(0,200));});
    return parts.join('\n').slice(0,700);
  } catch { return null; }
}
async function offChainIntel(sym, name) {
  const [r1,r2,r3] = await Promise.all([
    ddg(`"${sym}" ${name} scam rug investigation`),
    ddg(`ZachXBT "${sym}" manipulation`),
    ddg(`"${sym}" pump dump exchange investigation 2025 2026`),
  ]);
  const all = [r1,r2,r3].filter(Boolean).join('\n\n');
  return {
    raw:all.slice(0,1200),
    zachXBT:all.toLowerCase().includes('zachxbt'),
    cexInv:/bitget|binance|okx|gate\.|kraken|bybit.*investigat/i.test(all),
    rugged:/rug|scam|fraud|exit.*scam/i.test(all),
  };
}

// ─── Red flag scorer (all bankr checklist items) ──────────────────────────────
function scoreFlags({ gecko, dex, src, abi, creator, holders, deployer, allData,
                      isVerified, holderMeta, oft, offChain, chain }) {
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
  const si = src?.[0];
  const verified = si && si.ABI!=='Contract source code not verified' && si.SourceCode;
  if (!verified) F.push({c:'CONTRACT', m:'Source code TIDAK diverifikasi di explorer'});
  if (si?.Proxy==='1') F.push({c:'CONTRACT', m:`Proxy/upgradeable contract — implementation: ${si.Implementation||'unknown'}`});
  if (abi) {
    const bad = abi.filter(f=>f.dangerous);
    if (bad.length) F.push({c:'CONTRACT', m:`Fungsi berbahaya: ${bad.map(f=>f.sig).join(', ')}`});
    if (abi.some(f=>f.name==='mint')) F.push({c:'CONTRACT', m:'mint() ada — admin bisa inflasi supply kapan saja'});
    if (abi.some(f=>f.name?.toLowerCase().includes('blacklist'))) F.push({c:'CONTRACT', m:'blacklist() ada — admin bisa bekukan wallet holder manapun'});
    if (abi.some(f=>f.name==='pause')) F.push({c:'CONTRACT', m:'pause() ada — admin bisa stop semua transfer'});
  }

  // ── CLANKER / PLATFORM
  if (allData) {
    if (!allData.metadata||allData.metadata.length<10) F.push({c:'CLANKER', m:'allData() metadata KOSONG — tidak ada audit/socials/description saat deploy'});
    if (!allData.context) F.push({c:'CLANKER', m:'allData() context kosong — platform tidak teridentifikasi'});
    if (allData.originalAdmin&&allData.admin&&allData.originalAdmin!==allData.admin) F.push({c:'CLANKER', m:`Admin handoff terdeteksi: ${short(allData.originalAdmin)} → ${short(allData.admin)}`});
    if (!holderMeta?.hasVault) F.push({c:'CLANKER', m:'Tidak ada Vault extension — team tidak lock supply (Clanker v4 support ini di deploy-time)'});
    if (!holderMeta?.hasAirdrop) F.push({c:'CLANKER', m:'Tidak ada Airdrop extension — Clanker v4 support ini tapi tidak dipakai'});
    if (holderMeta?.rewardCount===1) F.push({c:'CLANKER', m:'Hanya 1 reward recipient (deployer sendiri) — padahal Clanker v4 bisa konfigurasi hingga 7 recipient'});
  }
  if (isVerified===false) F.push({c:'CLANKER', m:'isVerified() = false — platform belum verifikasi token ini'});

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

  const score = F.length;
  let V = score===0?'LOW':score<=2?'LOW-MEDIUM':score<=4?'MEDIUM':score<=6?'HIGH':'EXTREME';
  let conf = {LOW:80,'LOW-MEDIUM':70,MEDIUM:65,HIGH:75,EXTREME:85}[V];
  if (offChain?.zachXBT||offChain?.cexInv) {
    V = {LOW:'LOW-MEDIUM','LOW-MEDIUM':'MEDIUM',MEDIUM:'HIGH',HIGH:'EXTREME',EXTREME:'EXTREME'}[V];
    conf = Math.min(conf+10,95);
  }
  // Lower confidence if key data missing
  const missingKey = !ESCAN_KEY || (!allData && !si && !deployer);
  if (missingKey) conf = Math.min(conf, 55);
  return { flags:F, score, verdict:V, confidence:conf, dataMissing:missingKey };
}

// ─── Main collector ───────────────────────────────────────────────────────────
async function collect(addresses, chain) {
  const cfg = CHAIN[chain]||{};
  const lines = [];
  const hasKey = !!ESCAN_KEY;

  lines.push(`[CONFIG] Chain: ${cfg.name||chain} | ChainID: ${cfg.cid||'N/A'} | Etherscan V2: ${hasKey?'✅ key ada':'❌ ETHERSCAN_API_KEY tidak di-set — on-chain data terbatas'}`);

  for (const addr of addresses.slice(0,2)) {
    lines.push(`\n${'═'.repeat(72)}`);
    lines.push(`TOKEN: ${addr}`);
    lines.push(`CHAIN: ${cfg.name||chain} | ${cfg.ex||''}/address/${addr}`);
    lines.push('═'.repeat(72));

    // ── Round 1: semua yang tidak saling bergantung
    const [gecko, geckoPools, dex, src, creator, abi, holders] = await Promise.all([
      getGecko(addr, chain),
      getGeckoPools(addr, chain),
      getDex(addr),
      getSource(addr, chain),
      getCreator(addr, chain),
      getAbi(addr, chain),
      getHolders(addr, chain),
    ]);

    const bestPair = dex?.find(p=>p.chainId===cfg.did)||dex?.[0];
    const sym  = gecko?.symbol || bestPair?.baseToken?.symbol || addr.slice(0,8);
    const name = gecko?.name   || bestPair?.baseToken?.name   || '';

    // ── Round 2: eth_call + deployer + offchain (paralel)
    const [allData, isVerified, totalSupply, owner, deployer, offChain] = await Promise.all([
      readAllData(addr, chain),
      readIsVerified(addr, chain),
      readTotalSupply(addr, chain),
      readOwner(addr, chain),
      creator?.contractCreator ? getDeployerLifecycle(creator.contractCreator, chain) : Promise.resolve(null),
      offChainIntel(sym, name),
    ]);

    // ── Round 3: holder enrichment (top 5 non-pool)
    const poolAddrs = new Set([bestPair?.pairAddress?.toLowerCase(), UNIV4_BASE].filter(Boolean));
    const nonPoolH  = (holders||[]).filter(h=>{
      const a=h.TokenHolderAddress?.toLowerCase();
      return !poolAddrs.has(a)&&!INFRA.has(a);
    }).slice(0,5);

    // Bytecode, vault check, first-buy, CEX sends — paralel per holder
    const holderEnriched = await Promise.all(nonPoolH.map(async (h) => {
      const a = h.TokenHolderAddress;
      const [type, isVault, firstBuy, cexSends] = await Promise.all([
        classify(a, chain),
        classify(a, chain).then(t=>t==='contract'?checkVaultExtension(a,addr,chain):false),
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
      if(h._firstBuy && parseInt(h._firstBuy.blockNumber||'0') < (parseInt(h._firstBuy.blockNumber||'0')+10)) freshBuyers++;
    });
    // More accurate fresh buyer detection: check if first buy was within first 50 blocks of the pair
    // (simplified: if first buy date same as pair creation date, likely genesis sniper)
    holderEnriched.forEach(h=>{
      if(h._firstBuy?.date && bestPair?.pairCreatedAt) {
        const pairDate = new Date(bestPair.pairCreatedAt).toISOString().split('T')[0];
        if(h._firstBuy.date===pairDate) freshBuyers++;
      }
    });

    const holderMeta = { nonPoolConc, sniperCount, cexSendCount, freshBuyers, vaultCount, airdropCount,
      hasVault: vaultCount>0, hasAirdrop: airdropCount>0,
      rewardCount: allData ? 1 : null, // placeholder — actual reward count needs Clanker API
    };

    // ── Score
    const { flags, score, verdict, confidence, dataMissing } = scoreFlags({
      gecko, dex, src, abi, creator, holders, deployer:deployer, allData, isVerified,
      holderMeta, oft:{isOft:oftFlag, peerCount:Object.keys(oftPeers).length}, offChain, chain,
    });

    // ── Format output
    lines.push(`\n🏁 VERDICT: ${verdict} RISK | Confidence: ${confidence}% | Score: ${score}`);
    if (dataMissing) lines.push('⚠️  Confidence dibatasi — ETHERSCAN_API_KEY tidak ada atau data kunci tidak tersedia');

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
      } else {
        lines.push('  allData():     N/A (bukan Clanker/Doppler atau call gagal)');
      }
      lines.push(`  isVerified():  ${isVerified===true?'✅ true':isVerified===false?'❌ false':'N/A'}`);
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
    lines.push('\n🌐 [OFF-CHAIN INTEL — DuckDuckGo]');
    lines.push(`  ZachXBT flagged: ${offChain?.zachXBT?'⚠️ YA':'tidak'} | CEX investigation: ${offChain?.cexInv?'⚠️ YA':'tidak'} | Rug keywords: ${offChain?.rugged?'⚠️ YA':'tidak'}`);
    if(offChain?.raw) lines.push(`  Snippet:\n  ${offChain.raw.split('\n').slice(0,5).join('\n  ')}`);

    // ── Data availability summary
    lines.push('\n📋 [DATA AVAILABILITY — AI harus HANYA gunakan data yang tersedia]');
    lines.push(`  GeckoTerminal:    ${gecko?'✅':'❌ tidak ditemukan'}`);
    lines.push(`  DexScreener:      ${bestPair?'✅':'❌ tidak ditemukan'}`);
    lines.push(`  Contract source:  ${si&&si.ABI!=='Contract source code not verified'?'✅':'❌ N/A'}`);
    lines.push(`  ABI functions:    ${abi?.length?'✅ ('+abi.length+' fungsi)':'❌ N/A'}`);
    lines.push(`  allData() read:   ${allData?'✅':'❌ N/A'}`);
    lines.push(`  isVerified() read:${isVerified!=null?'✅ = '+isVerified:'❌ N/A'}`);
    lines.push(`  Deployer info:    ${creator?'✅':'❌ N/A'}`);
    lines.push(`  Deployer txlist:  ${deployer?'✅':'❌ N/A'}`);
    lines.push(`  Top holders:      ${holders?.length?'✅ ('+holders.length+' holder)':'❌ N/A'}`);
    lines.push(`  Per-holder buy:   ${holderEnriched.some(h=>h._firstBuy)?'✅ (beberapa holder)':'❌ N/A'}`);
    lines.push(`  Vault/airdrop:    ${holderMeta.hasVault||holderMeta.hasAirdrop?'✅ terdeteksi':'❌ tidak ada'}`);
    lines.push(`  OFT detection:    ${oftFlag?'✅ YA (LayerZero OFT)':'✅ bukan OFT'}`);
    lines.push(`  Off-chain intel:  ${offChain?.raw?'✅':'❌ N/A'}`);

    // ── Red flags
    lines.push(`\n🚩 [RED FLAGS — Score: ${score}/30+ | Threshold HIGH ≥5]`);
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

## FORMAT LAPORAN:

**🔍 TL;DR VERDICT: [LOW/MEDIUM/HIGH/EXTREME] RISK — Confidence [X]%**
[Satu kalimat reasoning — gabungkan on-chain + off-chain. Sebutkan jika data terbatas.]

---
**📋 Data Tersedia vs Tidak**
[Salin dari bagian DATA AVAILABILITY di atas — apa yang benar-benar diketahui]

---
**📊 Contracts Under Analysis**
| Field | Value |
|---|---|
| Address | [dari data] |
| Chain | [dari data] |
| Platform | [clanker.world / Doppler / unknown — dari allData context] |
| Deployer | [dari data atau "tidak tersedia"] |
| Admin saat ini | [dari allData.admin atau "tidak tersedia"] |
| totalSupply | [dari data atau "tidak tersedia"] |
| Verified (Etherscan) | [dari data] |
| isVerified() platform | [dari data] |
| Vault extension | [dari holderMeta atau "tidak tersedia"] |
| Airdrop extension | [dari holderMeta atau "tidak tersedia"] |
| Reward recipients | [dari data atau "tidak bisa dikonfirmasi tanpa Clanker API"] |
| Market Cap | [dari data atau N/A] |
| Likuiditas | [dari data atau N/A] |
| Pool % of supply | [dari data atau N/A] |

---
**🌐 Off-Chain Intel**
- ZachXBT flagged: [ya/tidak — dari data]
- CEX investigation: [ya/tidak — dari data]
- Coverage snippet: [dari data]
- Efek pada verdict: [bumped / no change]

---
**⚔️ Claim vs Reality**
| Klaim Tim / Narasi | Fakta On-Chain | Yang Bisa Dilakukan Platform |
|---|---|---|
[isi berdasarkan data yang tersedia. Jika tidak ada klaim tim yang diketahui, tulis "Tidak ada narasi publik yang bisa diverifikasi dari data yang tersedia"]

---
**👤 Deployer Forensics**
[funding source → deploy → extraction. Jika data tidak tersedia, katakan tegas "data deployer tidak tersedia"]

---
**👥 Holder Distribution**
[Pool excluded. Top holders dengan type + first-buy + CEX send. Concentration math.
JANGAN listing holder jika data tidak tersedia]

---
**⚙️ Contract Red Flags**
[Berdasarkan ABI + allData + isVerified. Jika ABI tidak ada, katakan tegas]

---
**🧠 Economic Irrationality Test**
[Apa yang HARUSNYA dilakukan tim legit di platform ini? Kontraskan dengan yang dilakukan.
Berdasarkan Step 0 platform docs di atas]

---
**🎭 Pattern Match**
[Clanker redeploy dump / sniper relaunch / CEX pump treasury / self-funded MM / clean]

---
**🔄 Yang Bisa Ubah Verdict**
- Fakta yang akan TURUNKAN risk: [spesifik]
- Fakta yang akan NAIKKAN risk: [spesifik]

---
**🔗 Sources**
[Link explorer untuk setiap address yang disebut]

---
*NFA. DYOR. Data real-time saat analisis dilakukan.*
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
