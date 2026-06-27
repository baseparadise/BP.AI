// lib/tokenScamAnalysis.js
// Token scam/rug-pull analysis skill for cliza.ai bot
// Based on bankr-token-scam-analysis skill by BankrBot
// https://github.com/BankrBot/skills/tree/main/bankr-token-scam-analysis

const axios = require('axios');

// ── Chain config ─────────────────────────────────────────────────────────────
const CHAIN_CONFIG = {
  eth: {
    name: 'Ethereum',
    apiBase: 'https://api.etherscan.io/api',
    apiKey: process.env.ETHERSCAN_API_KEY || '',
    explorerUrl: 'https://etherscan.io',
  },
  base: {
    name: 'Base',
    apiBase: 'https://api.basescan.org/api',
    apiKey: process.env.BASESCAN_API_KEY || '',
    explorerUrl: 'https://basescan.org',
  },
  bsc: {
    name: 'BNB Chain',
    apiBase: 'https://api.bscscan.com/api',
    apiKey: process.env.BSCSCAN_API_KEY || '',
    explorerUrl: 'https://bscscan.com',
  },
  polygon: {
    name: 'Polygon',
    apiBase: 'https://api.polygonscan.com/api',
    apiKey: process.env.POLYGONSCAN_API_KEY || '',
    explorerUrl: 'https://polygonscan.com',
  },
  arbitrum: {
    name: 'Arbitrum',
    apiBase: 'https://api.arbiscan.io/api',
    apiKey: process.env.ARBISCAN_API_KEY || '',
    explorerUrl: 'https://arbiscan.io',
  },
};

// ── Keyword detection ─────────────────────────────────────────────────────────
const SCAM_KEYWORDS = [
  /\bscam\b/i, /\brug\b/i, /\brug.?pull\b/i,
  /\banalyz/i, /\banalisis\b/i, /\bforensik\b/i,
  /\bsafe\b.*\btoken\b/i, /\blegit\b/i, /\btrust(worthy)?\b/i,
  /\bcek.?token\b/i, /\bcek.?kontrak\b/i, /\bperiksa.?token\b/i,
  /\bis.?this.?a\b/i, /\bshould.?i.?trust\b/i,
  /\bbahaya\b/i, /\bpenipuan\b/i,
  /\bhodler\b/i, /\bholder\b/i, /\bdeployer\b/i,
  /\bmigrat/i, /\bon.?chain\b/i, /\bfundamental\b/i,
  /\brisk\b/i, /\brisiko\b/i, /\bwaspada\b/i,
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function extractContractAddresses(text) {
  const matches = text.match(/0x[a-fA-F0-9]{40}/g);
  return matches ? [...new Set(matches)] : [];
}

function detectChain(text) {
  const t = text.toLowerCase();
  if (/\bbase\b/.test(t)) return 'base';
  if (/\bpolygon\b|\bmatic\b/.test(t)) return 'polygon';
  if (/\barb(itrum)?\b/.test(t)) return 'arbitrum';
  if (/\bbsc\b|\bbnb\b|\bbinance\b/.test(t)) return 'bsc';
  if (/\beth(ereum)?\b/.test(t)) return 'eth';
  return 'base'; // default: Base (Clanker/Bankr ecosystem)
}

function isScamAnalysisRequest(question) {
  const addrs = extractContractAddresses(question);
  if (addrs.length === 0) return false;
  return SCAM_KEYWORDS.some((kw) => kw.test(question));
}

// ── Explorer API ─────────────────────────────────────────────────────────────
async function explorerGet(chain, params, timeout = 12000) {
  const cfg = CHAIN_CONFIG[chain];
  if (!cfg) return null;
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

async function fetchTokenInfo(address, chain) {
  const [tokenInfo, contractSource] = await Promise.all([
    explorerGet(chain, { module: 'token', action: 'tokeninfo', contractaddress: address }),
    explorerGet(chain, { module: 'contract', action: 'getsourcecode', address }),
  ]);
  return { tokenInfo, contractSource };
}

async function fetchCreatorInfo(address, chain) {
  const result = await explorerGet(chain, {
    module: 'contract',
    action: 'getcontractcreation',
    contractaddresses: address,
  });
  return result && result[0] ? result[0] : null;
}

async function fetchDeployerTxs(deployer, chain) {
  return explorerGet(chain, {
    module: 'account', action: 'txlist',
    address: deployer,
    startblock: 0, endblock: 99999999,
    page: 1, offset: 10, sort: 'asc',
  });
}

async function fetchTopHolders(address, chain) {
  return explorerGet(chain, {
    module: 'token', action: 'tokenholderlist',
    contractaddress: address,
    page: 1, offset: 20,
  });
}

async function fetchContractAbi(address, chain) {
  const result = await explorerGet(chain, {
    module: 'contract', action: 'getabi', address,
  });
  if (!result || result === 'Contract source code not verified') return null;
  try {
    const abi = JSON.parse(result);
    const DANGEROUS = ['mint', 'crosschainmint', 'setowner', 'updateadmin', 'blacklist',
      'setfee', 'pause', 'updatimage', 'updatemetadata', 'setpeer', 'setminter'];
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

    const [
      { tokenInfo, contractSource },
      creatorInfo,
      abiFunctions,
      topHolders,
    ] = await Promise.all([
      fetchTokenInfo(address, chain),
      fetchCreatorInfo(address, chain),
      fetchContractAbi(address, chain),
      fetchTopHolders(address, chain),
    ]);

    // Token info
    const t = tokenInfo && tokenInfo[0];
    if (t) {
      lines.push('\n[TOKEN INFO]');
      lines.push(`  Name:         ${t.tokenName} (${t.symbol})`);
      lines.push(`  Total Supply: ${t.totalSupply}`);
      lines.push(`  Decimals:     ${t.divisor}`);
      lines.push(`  Holders:      ${t.holdersCount}`);
      lines.push(`  Verified:     ${t.blueCheckmark}`);
      if (t.website) lines.push(`  Website:      ${t.website}`);
      if (t.twitter) lines.push(`  Twitter:      ${t.twitter}`);
    } else {
      lines.push('\n[TOKEN INFO] Tidak tersedia dari API');
    }

    // Contract source
    const src = contractSource && contractSource[0];
    if (src) {
      const isVerified = src.ABI !== 'Contract source code not verified';
      lines.push('\n[CONTRACT SOURCE]');
      lines.push(`  Verified:       ${isVerified ? '✅ YES' : '❌ NO'}`);
      lines.push(`  Contract Name:  ${src.ContractName || 'N/A'}`);
      lines.push(`  Compiler:       ${src.CompilerVersion || 'N/A'}`);
      lines.push(`  Proxy:          ${src.Proxy === '1' ? '⚠️ YES' : 'NO'}`);
      if (src.Implementation) lines.push(`  Implementation: ${src.Implementation}`);
    }

    // ABI functions
    if (abiFunctions && abiFunctions.length > 0) {
      lines.push('\n[CONTRACT FUNCTIONS — ⚠️ = potentially dangerous]');
      abiFunctions.forEach((fn) => lines.push(`  ${fn}`));
    } else {
      lines.push('\n[CONTRACT FUNCTIONS] ABI tidak tersedia (unverified?)');
    }

    // Deployer
    if (creatorInfo) {
      lines.push('\n[DEPLOYER INFO]');
      lines.push(`  Deployer: ${creatorInfo.contractCreator}`);
      lines.push(`  Deploy TX: ${cfg.explorerUrl}/tx/${creatorInfo.txHash}`);
      lines.push(`  Deployer Wallet: ${cfg.explorerUrl}/address/${creatorInfo.contractCreator}`);

      const deployerTxs = await fetchDeployerTxs(creatorInfo.contractCreator, chain);
      if (deployerTxs && deployerTxs.length > 0) {
        lines.push(`  First ${Math.min(deployerTxs.length, 8)} txs deployer (oldest):`);
        deployerTxs.slice(0, 8).forEach((tx) => {
          const ts = new Date(Number(tx.timeStamp) * 1000).toISOString();
          lines.push(`    [${ts}] → ${tx.to} | fn: ${tx.functionName || 'transfer'} | val: ${tx.value}`);
        });
      }
    } else {
      lines.push('\n[DEPLOYER INFO] Tidak tersedia');
    }

    // Top holders
    if (topHolders && topHolders.length > 0) {
      lines.push('\n[TOP HOLDERS]');
      topHolders.slice(0, 15).forEach((h, i) => {
        const pct = h.TotalSupply
          ? ((parseFloat(h.TokenHolderQuantity) / parseFloat(h.TotalSupply)) * 100).toFixed(2)
          : '?';
        lines.push(`  ${String(i + 1).padStart(2)}. ${h.TokenHolderAddress} — ${h.TokenHolderQuantity} (${pct}%)`);
      });
    } else {
      lines.push('\n[TOP HOLDERS] Tidak tersedia dari API (coba cek manual di explorer)');
    }
  }

  return lines.join('\n');
}

// ── Skill system prompt ──────────────────────────────────────────────────────
const SKILL_SYSTEM = `
Kamu sedang menjalankan TOKEN SCAM / RUG-PULL ANALYSIS SKILL.
Berdasarkan: bankr-token-scam-analysis by BankrBot (https://github.com/BankrBot/skills)

## PRINSIP
- Narasi tim = noise. On-chain state = signal.
- On-chain bersih ≠ tidak scam (bisa insider pump-dump dengan supply terkonsentrasi).
- Setiap klaim tim harus dicek vs data kontrak & deployer yang sebenarnya.

## RED FLAG CHECKLIST (centang yang ditemukan dari data):

KONTRAK:
☐ ABI punya fungsi berbahaya: mint, pause, blacklist, setFee, updateAdmin, updateMetadata, setPeer
☐ Tidak verified di explorer
☐ Proxy/upgradeable contract
☐ Admin bisa ubah metadata setelah launch

DEPLOYER:
☐ Wallet fresh (nonce rendah, baru dibuat sesaat sebelum deploy)
☐ Deployer langsung extract/bridge dana setelah launch
☐ Tidak ada riwayat on-chain yang menghubungkan ke tim nyata
☐ Deploy dari wallet berbeda vs klaim Twitter mereka

HOLDER:
☐ Top holder non-pool kontrol >10% supply dari wallet baru
☐ Konsentrasi tinggi (top 5 wallet pegang >30% supply)
☐ Ada wallet 48-byte (smart wallet sniper proxy)
☐ Top holder aktif kirim ke CEX hot wallet saat pump

NARASI vs REALITA:
☐ Klaim tokenomics tidak tercermin di kontrak
☐ Migration tanpa snapshot/claim contract/LP burn
☐ Akun Twitter klaim sebagai tim tapi wallet-nya tidak ada di on-chain

## FORMAT LAPORAN WAJIB:

**🔍 VERDICT: [LOW/MEDIUM/HIGH/EXTREME] RISK — [confidence]%**

**Red Flag Ditemukan:**
[list yang relevan]

**Deployer Analysis:**
[siapa, dari mana dana, apa yang dilakukan post-deploy]

**Holder Distribution:**
[konsentrasi, ada sniper wallet?, pool address]

**Contract Security:**
[verified?, fungsi berbahaya?, proxy?]

**Kesimpulan:**
[2-3 kalimat ringkasan yang actionable untuk user]

*NFA. DYOR. Analisis berdasarkan data on-chain pada saat ini.*
`;

// ── Entrypoint ────────────────────────────────────────────────────────────────
async function runScamAnalysis(question) {
  const addresses = extractContractAddresses(question);
  const chain = detectChain(question);

  let onChainData = '';
  try {
    onChainData = await buildOnChainContext(addresses, chain);
  } catch (err) {
    console.error('[tokenScamAnalysis] Error:', err.message);
    onChainData = '[Gagal fetch data on-chain dari explorer API. Analisis berdasarkan pengetahuan umum saja.]';
  }

  const fullPrompt = [
    SKILL_SYSTEM,
    '\n\n[DATA ON-CHAIN YANG SUDAH DIAMBIL DARI EXPLORER API]',
    onChainData,
    '\n\n[PERTANYAAN / REQUEST USER]',
    question,
    '\n\nBerikan laporan analisis lengkap menggunakan format di atas. Gunakan Bahasa Indonesia.',
  ].join('\n');

  return { applicable: true, addresses, chain, fullPrompt };
}

module.exports = { isScamAnalysisRequest, runScamAnalysis };
