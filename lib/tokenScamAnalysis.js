// lib/tokenScamAnalysis.js
// Token scam/rug-pull analysis skill for cliza.ai bot
// Primary data: GeckoTerminal + DexScreener (free, no API key)
// Secondary data: Etherscan/Basescan (when API keys available)

const axios = require('axios');

// ── Chain config (for explorer APIs) ─────────────────────────────────────────
const CHAIN_CONFIG = {
  eth: {
    name: 'Ethereum',
    geckoId: 'eth',
    dexscreenerId: 'ethereum',
    apiBase: 'https://api.etherscan.io/api',
    apiKey: process.env.ETHERSCAN_API_KEY || '',
    explorerUrl: 'https://etherscan.io',
  },
  base: {
    name: 'Base',
    geckoId: 'base',
    dexscreenerId: 'base',
    apiBase: 'https://api.basescan.org/api',
    apiKey: process.env.BASESCAN_API_KEY || '',
    explorerUrl: 'https://basescan.org',
  },
  bsc: {
    name: 'BNB Chain',
    geckoId: 'bsc',
    dexscreenerId: 'bsc',
    apiBase: 'https://api.bscscan.com/api',
    apiKey: process.env.BSCSCAN_API_KEY || '',
    explorerUrl: 'https://bscscan.com',
  },
  polygon: {
    name: 'Polygon',
    geckoId: 'polygon_pos',
    dexscreenerId: 'polygon',
    apiBase: 'https://api.polygonscan.com/api',
    apiKey: process.env.POLYGONSCAN_API_KEY || '',
    explorerUrl: 'https://polygonscan.com',
  },
  arbitrum: {
    name: 'Arbitrum',
    geckoId: 'arbitrum',
    dexscreenerId: 'arbitrum',
    apiBase: 'https://api.arbiscan.io/api',
    apiKey: process.env.ARBISCAN_API_KEY || '',
    explorerUrl: 'https://arbiscan.io',
  },
  solana: {
    name: 'Solana',
    geckoId: 'solana',
    dexscreenerId: 'solana',
    apiBase: null,
    apiKey: '',
    explorerUrl: 'https://solscan.io',
  },
};

// ── Keyword detection ─────────────────────────────────────────────────────────
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

// ── Helpers ──────────────────────────────────────────────────────────────────
function extractContractAddresses(text) {
  const matches = text.match(/0x[a-fA-F0-9]{40}/g);
  return matches ? [...new Set(matches)] : [];
}

function detectChain(text) {
  const t = text.toLowerCase();
  if (/\bbase\b/.test(t)) return 'base';
  if (/\bsolana\b|\bsol\b/.test(t)) return 'solana';
  if (/\bpolygon\b|\bmatic\b/.test(t)) return 'polygon';
  if (/\barb(itrum)?\b/.test(t)) return 'arbitrum';
  if (/\bbsc\b|\bbnb\b|\bbinance\b/.test(t)) return 'bsc';
  if (/\beth(ereum)?\b/.test(t)) return 'eth';
  return 'base'; // default: Base (Clanker/Bankr ecosystem)
}

function isScamAnalysisRequest(question) {
  const addrs = extractContractAddresses(question);
  if (addrs.length === 0) return false;
  // Trigger if address + any keyword, OR if message is short (just address + "analisis token" type)
  if (SCAM_KEYWORDS.some((kw) => kw.test(question))) return true;
  // Also trigger if the message is mostly just the contract address
  const stripped = question.replace(/0x[a-fA-F0-9]{40}/g, '').trim();
  return stripped.length < 30;
}

function fmtNum(n) {
  if (!n) return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num)) return String(n);
  if (num >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return '$' + (num / 1e3).toFixed(2) + 'K';
  return '$' + num.toFixed(4);
}

function fmtPrice(n) {
  if (!n) return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num)) return String(n);
  if (num < 0.000001) return '$' + num.toExponential(4);
  if (num < 0.01) return '$' + num.toFixed(8);
  if (num < 1) return '$' + num.toFixed(6);
  return '$' + num.toFixed(4);
}

// ── GeckoTerminal API (primary — free, no key) ────────────────────────────────
async function fetchGeckoTerminal(address, chain) {
  const cfg = CHAIN_CONFIG[chain];
  const geckoChain = cfg?.geckoId || chain;
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/${geckoChain}/tokens/${address}`;
    const { data } = await axios.get(url, {
      headers: { Accept: 'application/json' },
      timeout: 10000,
    });
    return data?.data?.attributes || null;
  } catch {
    return null;
  }
}

async function fetchGeckoPools(address, chain) {
  const cfg = CHAIN_CONFIG[chain];
  const geckoChain = cfg?.geckoId || chain;
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/${geckoChain}/tokens/${address}/pools?page=1`;
    const { data } = await axios.get(url, {
      headers: { Accept: 'application/json' },
      timeout: 10000,
    });
    return data?.data || [];
  } catch {
    return [];
  }
}

// ── DexScreener API (fallback — free, no key) ─────────────────────────────────
async function fetchDexScreener(address) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      timeout: 10000,
    });
    return data?.pairs || [];
  } catch {
    return [];
  }
}

// ── Explorer API (Etherscan/Basescan — needs key) ────────────────────────────
async function explorerGet(chain, params, timeout = 10000) {
  const cfg = CHAIN_CONFIG[chain];
  if (!cfg || !cfg.apiBase) return null;
  try {
    const { data } = await axios.get(cfg.apiBase, {
      params: { ...params, apikey: cfg.apiKey },
      timeout,
    });
    if (data.status === '1' && data.result) return data.result;
    return null;
  } catch {
    return null;
  }
}

async function fetchContractSource(address, chain) {
  return explorerGet(chain, { module: 'contract', action: 'getsourcecode', address });
}

async function fetchCreatorInfo(address, chain) {
  const result = await explorerGet(chain, {
    module: 'contract',
    action: 'getcontractcreation',
    contractaddresses: address,
  });
  return result && result[0] ? result[0] : null;
}

async function fetchTopHolders(address, chain) {
  return explorerGet(chain, {
    module: 'token', action: 'tokenholderlist',
    contractaddress: address,
    page: 1, offset: 15,
  });
}

async function fetchContractAbi(address, chain) {
  const result = await explorerGet(chain, { module: 'contract', action: 'getabi', address });
  if (!result || result === 'Contract source code not verified') return null;
  try {
    const abi = JSON.parse(result);
    const DANGEROUS = [
      'mint', 'crosschainmint', 'setowner', 'updateadmin', 'blacklist',
      'setfee', 'pause', 'updatimage', 'updatemetadata', 'setpeer', 'setminter',
    ];
    return abi
      .filter((item) => item.type === 'function')
      .map((item) => {
        const name = item.name || '';
        const isDangerous = DANGEROUS.some((d) => name.toLowerCase().includes(d));
        return `${isDangerous ? '⚠️ ' : ''}${name}(${(item.inputs || []).map((i) => i.type).join(',')}) [${item.stateMutability || item.type}]`;
      })
      .slice(0, 40);
  } catch {
    return null;
  }
}

// ── Main context builder ─────────────────────────────────────────────────────
async function buildOnChainContext(addresses, chain) {
  const cfg = CHAIN_CONFIG[chain];
  const lines = [];

  for (const address of addresses.slice(0, 2)) {
    lines.push(`\n${'='.repeat(60)}`);
    lines.push(`CONTRACT: ${address}`);
    lines.push(`CHAIN: ${cfg.name} | Explorer: ${cfg.explorerUrl}/address/${address}`);
    lines.push('='.repeat(60));

    // Fetch all data in parallel
    const [
      geckoData,
      geckoPools,
      dexPairs,
      contractSource,
      creatorInfo,
      abiFunctions,
      topHolders,
    ] = await Promise.all([
      fetchGeckoTerminal(address, chain),
      fetchGeckoPools(address, chain),
      fetchDexScreener(address),
      fetchContractSource(address, chain),
      fetchCreatorInfo(address, chain),
      fetchContractAbi(address, chain),
      fetchTopHolders(address, chain),
    ]);

    // ── GeckoTerminal market data ──
    if (geckoData) {
      lines.push('\n[MARKET DATA — GeckoTerminal]');
      lines.push(`  Nama:              ${geckoData.name} (${geckoData.symbol})`);
      lines.push(`  Harga:             ${fmtPrice(geckoData.price_usd)}`);
      lines.push(`  Market Cap:        ${fmtNum(geckoData.market_cap_usd)}`);
      lines.push(`  FDV:               ${fmtNum(geckoData.fdv_usd)}`);
      lines.push(`  Volume 24h:        ${fmtNum(geckoData.volume_usd?.h24)}`);
      if (geckoData.price_change_percentage) {
        lines.push(`  Perubahan Harga:   1h: ${geckoData.price_change_percentage.h1 || 'N/A'}% | 24h: ${geckoData.price_change_percentage.h24 || 'N/A'}% | 7d: ${geckoData.price_change_percentage.d7 || 'N/A'}%`);
      }
      if (geckoData.total_supply) lines.push(`  Total Supply:      ${geckoData.total_supply}`);
      if (geckoData.image_url && geckoData.image_url !== 'missing.png') {
        lines.push(`  Image:             ${geckoData.image_url}`);
      }
      // Security alerts from GeckoTerminal
      if (geckoData.gt_score !== undefined) {
        lines.push(`  GT Security Score: ${geckoData.gt_score}/100`);
      }
      lines.push(`  GeckoTerminal:     https://www.geckoterminal.com/${cfg.geckoId}/tokens/${address}`);
    } else {
      lines.push('\n[MARKET DATA — GeckoTerminal] Tidak ditemukan di GeckoTerminal');
    }

    // ── DexScreener fallback / enrichment ──
    const bestPair = dexPairs
      .filter((p) => !chain || p.chainId === cfg.dexscreenerId)
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
      || dexPairs[0];

    if (bestPair) {
      lines.push('\n[MARKET DATA — DexScreener]');
      if (!geckoData) {
        lines.push(`  Nama:          ${bestPair.baseToken?.name} (${bestPair.baseToken?.symbol})`);
        lines.push(`  Chain:         ${bestPair.chainId}`);
        lines.push(`  Harga:         ${fmtPrice(bestPair.priceUsd)}`);
        lines.push(`  Market Cap:    ${fmtNum(bestPair.marketCap)}`);
        lines.push(`  Volume 24h:    ${fmtNum(bestPair.volume?.h24)}`);
        lines.push(`  Perubahan 24h: ${bestPair.priceChange?.h24}%`);
      }
      lines.push(`  Likuiditas:    ${fmtNum(bestPair.liquidity?.usd)}`);
      lines.push(`  DEX:           ${bestPair.dexId}`);
      lines.push(`  Pair:          ${bestPair.pairAddress}`);
      lines.push(`  DexScreener:   ${bestPair.url || 'https://dexscreener.com/' + bestPair.chainId + '/' + bestPair.pairAddress}`);
      if (bestPair.boosts?.active) lines.push(`  ⚡ Boosts Aktif: ${bestPair.boosts.active}`);
      if (bestPair.info?.websites?.length) {
        lines.push(`  Website:       ${bestPair.info.websites.map((w) => w.url).join(', ')}`);
      }
      if (bestPair.info?.socials?.length) {
        lines.push(`  Socials:       ${bestPair.info.socials.map((s) => s.type + ':' + s.url).join(' | ')}`);
      }
      // Security warnings
      if (bestPair.profile?.header) {
        lines.push(`  ⚠️ Security Warning: ${bestPair.profile.header}`);
      }
    } else {
      lines.push('\n[MARKET DATA — DexScreener] Tidak tersedia');
    }

    // ── GeckoTerminal pools ──
    if (geckoPools.length > 0) {
      lines.push('\n[LIQUIDITY POOLS — Top 3]');
      geckoPools.slice(0, 3).forEach((pool, i) => {
        const attr = pool.attributes;
        lines.push(`  Pool ${i + 1}: ${attr?.name || 'N/A'}`);
        lines.push(`    Likuiditas:  ${fmtNum(attr?.reserve_in_usd)}`);
        lines.push(`    Volume 24h:  ${fmtNum(attr?.volume_usd?.h24)}`);
        if (attr?.security_indicators?.length > 0) {
          lines.push(`    ⚠️ Security Flags: ${attr.security_indicators.join(', ')}`);
        }
        if (attr?.pool_created_at) {
          lines.push(`    Dibuat:      ${attr.pool_created_at}`);
        }
      });
    }

    // ── Contract source (from explorer API) ──
    const src = contractSource && contractSource[0];
    if (src) {
      const isVerified = src.ABI !== 'Contract source code not verified';
      lines.push('\n[CONTRACT SOURCE — Explorer]');
      lines.push(`  Verified:       ${isVerified ? '✅ YES' : '❌ NO (MERAH BESAR)'}`);
      lines.push(`  Contract Name:  ${src.ContractName || 'N/A'}`);
      lines.push(`  Compiler:       ${src.CompilerVersion || 'N/A'}`);
      lines.push(`  Proxy:          ${src.Proxy === '1' ? '⚠️ YES' : 'NO'}`);
      if (src.Implementation) lines.push(`  Implementation: ${src.Implementation}`);
    } else {
      lines.push('\n[CONTRACT SOURCE] Perlu API key explorer atau kontrak tidak diverifikasi');
    }

    // ── ABI functions ──
    if (abiFunctions && abiFunctions.length > 0) {
      lines.push('\n[CONTRACT FUNCTIONS — ⚠️ = potentially dangerous]');
      abiFunctions.forEach((fn) => lines.push(`  ${fn}`));
    } else {
      lines.push('\n[CONTRACT FUNCTIONS] ABI tidak tersedia (butuh explorer API key)');
    }

    // ── Deployer ──
    if (creatorInfo) {
      lines.push('\n[DEPLOYER INFO]');
      lines.push(`  Deployer:        ${creatorInfo.contractCreator}`);
      lines.push(`  Deploy TX:       ${cfg.explorerUrl}/tx/${creatorInfo.txHash}`);
      lines.push(`  Deployer Wallet: ${cfg.explorerUrl}/address/${creatorInfo.contractCreator}`);
    } else {
      lines.push('\n[DEPLOYER INFO] Tidak tersedia (butuh explorer API key)');
    }

    // ── Top holders ──
    if (topHolders && topHolders.length > 0) {
      lines.push('\n[TOP HOLDERS]');
      topHolders.slice(0, 15).forEach((h, i) => {
        const pct = h.TotalSupply
          ? ((parseFloat(h.TokenHolderQuantity) / parseFloat(h.TotalSupply)) * 100).toFixed(2)
          : '?';
        lines.push(`  ${String(i + 1).padStart(2)}. ${h.TokenHolderAddress} — ${pct}%`);
      });
    } else {
      lines.push('\n[TOP HOLDERS] Tidak tersedia (butuh explorer API key)');
    }
  }

  return lines.join('\n');
}

// ── Skill system prompt ──────────────────────────────────────────────────────
const SKILL_SYSTEM = `
Kamu sedang menjalankan TOKEN SCAM / RUG-PULL ANALYSIS SKILL.
Data real-time sudah diambil dari GeckoTerminal dan DexScreener API.

## PENTING:
- Gunakan HANYA data yang tersedia di bawah. JANGAN mengarang atau mengganti contract address.
- Jika data tidak tersedia, katakan terus terang "data tidak tersedia" — jangan isi dengan asumsi.
- Jika token tidak ditemukan di GeckoTerminal/DexScreener, kemungkinan baru/tidak aktif/scam.

## RED FLAG CHECKLIST (centang yang ditemukan dari data):

MARKET:
☐ Tidak terdaftar di GeckoTerminal atau DexScreener
☐ Likuiditas sangat rendah (<$10K) — mudah dimanipulasi
☐ Volume sangat tinggi tapi likuiditas rendah (wash trading?)
☐ Harga naik ekstrem dalam waktu singkat tanpa fundamental
☐ Ada security flags/warnings dari GeckoTerminal

KONTRAK:
☐ Tidak verified di explorer
☐ ABI punya fungsi berbahaya: mint, pause, blacklist, setFee, updateAdmin
☐ Proxy/upgradeable contract

NARASI:
☐ Tidak ada website atau socials yang bisa ditemukan
☐ Token baru dibuat (pool created_at baru)

## FORMAT LAPORAN WAJIB:

**🔍 VERDICT: [LOW/MEDIUM/HIGH/EXTREME] RISK — [confidence]%**

**📊 Data Token:**
- Nama: [dari data]
- Harga: [dari data]
- Market Cap: [dari data]
- Volume 24h: [dari data]
- Likuiditas: [dari data]
- Perubahan harga 24h: [dari data]

**🚩 Red Flag Ditemukan:**
[list yang relevan, atau "Tidak ditemukan red flag signifikan"]

**🔒 Contract Security:**
[verified?, fungsi berbahaya?, proxy?]

**💧 Likuiditas & Pool:**
[info pool, DEX mana, locked?]

**📝 Kesimpulan:**
[2-3 kalimat ringkasan actionable]

**🔗 Link:**
- GeckoTerminal: [link dari data]
- DexScreener: [link dari data]

*NFA. DYOR. Analisis berdasarkan data real-time saat ini.*
`;

// ── Entrypoint ────────────────────────────────────────────────────────────────
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
    '\n\n[DATA REAL-TIME DARI API]',
    onChainData,
    '\n\n[PERTANYAAN / REQUEST USER]',
    question,
    '\n\nBerikan laporan analisis menggunakan format di atas. Gunakan Bahasa Indonesia. Hanya gunakan data yang ada di atas — jangan mengarang.',
  ].join('\n');

  return { applicable: true, addresses, chain, fullPrompt };
}

module.exports = { isScamAnalysisRequest, runScamAnalysis };
