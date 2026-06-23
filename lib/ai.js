// lib/ai.js
// Otak AI dipakai bersama oleh webhook (api/index.js) dan bot gateway (bot.js).
// Berisi: tanya Gemini + Google Search grounding, generate gambar, format jawaban.

const axios = require('axios');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.0-flash';
const RETRYABLE_STATUS = [429, 500, 503];

// Parse list dipisah koma dari env, fallback ke array default kalau env kosong/tidak di-set.
function parseEnvList(envVal, fallbackArr) {
  const arr = (envVal || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return arr.length ? arr : fallbackArr;
}

// Daftar model TEKS yang akan dicoba bergiliran (rotasi) kalau salah satu kena limit/overload.
// Isi GEMINI_MODELS dengan banyak model dipisah koma, contoh:
// GEMINI_MODELS=gemini-2.5-flash,gemini-2.5-pro,gemini-2.0-flash,gemini-2.0-flash-lite,gemini-1.5-flash,gemini-1.5-pro
// Kalau GEMINI_MODELS tidak di-set, fallback ke GEMINI_MODEL + GEMINI_FALLBACK_MODEL seperti sebelumnya.
const TEXT_MODELS = [...new Set(parseEnvList(process.env.GEMINI_MODELS, [GEMINI_MODEL, FALLBACK_MODEL]))];

// Daftar model IMAGE yang akan dicoba bergiliran. Isi GEMINI_IMAGE_MODELS kalau punya lebih dari satu.
const IMAGE_MODELS = [...new Set(parseEnvList(process.env.GEMINI_IMAGE_MODELS, [GEMINI_IMAGE_MODEL]))];

// --- API key tambahan (semua OPSIONAL, fitur terkait otomatis di-skip kalau kosong) ---
// CoinGecko, Fear&Greed (alternative.me), DefiLlama: GRATIS, tidak perlu API key.
// Etherscan/BscScan/PolygonScan: daftar gratis di etherscan.io / bscscan.com / polygonscan.com.
// GitHub: tanpa token tetap bisa dipakai tapi limit rendah (60 req/jam). Pakai Personal Access Token kalau ada.
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || '';
const POLYGONSCAN_API_KEY = process.env.POLYGONSCAN_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

// Konfigurasi explorer per-chain (dipakai oleh getGasPrice / getContractSource).
const CHAIN_EXPLORERS = {
  eth: { base: 'https://api.etherscan.io/api', key: ETHERSCAN_API_KEY, name: 'Ethereum' },
  bsc: { base: 'https://api.bscscan.com/api', key: BSCSCAN_API_KEY, name: 'BNB Chain' },
  polygon: { base: 'https://api.polygonscan.com/api', key: POLYGONSCAN_API_KEY, name: 'Polygon' },
};

// Mapping simbol umum -> id CoinGecko, supaya user bisa tanya "harga btc" / "harga eth" dll.
const COINGECKO_ID_MAP = {
  btc: 'bitcoin', bitcoin: 'bitcoin',
  eth: 'ethereum', ethereum: 'ethereum',
  bnb: 'binancecoin',
  sol: 'solana', solana: 'solana',
  xrp: 'ripple',
  ada: 'cardano', cardano: 'cardano',
  doge: 'dogecoin', dogecoin: 'dogecoin',
  ton: 'the-open-network',
  trx: 'tron', tron: 'tron',
  matic: 'matic-network', polygon: 'matic-network',
  dot: 'polkadot', polkadot: 'polkadot',
  avax: 'avalanche-2', avalanche: 'avalanche-2',
  shib: 'shiba-inu',
  link: 'chainlink', chainlink: 'chainlink',
  pepe: 'pepe',
  sui: 'sui',
  arb: 'arbitrum', arbitrum: 'arbitrum',
  op: 'optimism', optimism: 'optimism',
  usdt: 'tether', usdc: 'usd-coin',
};

// Banyak API key supaya tidak gampang kena limit.
// Isi GEMINI_API_KEYS dengan beberapa key dipisah koma, contoh: "key1,key2,key3".
// GEMINI_API_KEY (tunggal) tetap didukung sebagai cadangan.
const API_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

// Mulai dari key acak biar beban tersebar antar key.
let keyCursor = API_KEYS.length ? Math.floor(Math.random() * API_KEYS.length) : 0;
console.log(`[callGemini] ${API_KEYS.length} API key & ${TEXT_MODELS.length} model teks dimuat (${TEXT_MODELS.join(', ')})`);

// Panggil Gemini dengan rotasi MODEL x KEY:
// - Untuk setiap model di daftar, coba semua key satu-satu.
// - Kalau model+key kena 429/500/503/timeout/network error -> lanjut ke kombinasi berikutnya.
// - Kalau SEMUA kombinasi model x key habis dicoba, baru backoff lalu ulangi (max `rounds` putaran).
// `models` boleh string (1 model) atau array (banyak model, urutan = urutan prioritas).
async function callGemini(models, body, timeout, rounds = 4) {
  if (API_KEYS.length === 0) {
    const e = new Error('GEMINI_API_KEYS / GEMINI_API_KEY belum di-set.');
    e.response = { status: 401, data: { error: { message: 'API key kosong.' } } };
    throw e;
  }

  const modelList = [...new Set(Array.isArray(models) ? models : [models])].filter(Boolean);
  if (modelList.length === 0) modelList.push(GEMINI_MODEL);

  let lastErr;
  for (let round = 0; round < rounds; round++) {
    for (const model of modelList) {
      // Setiap model dicoba lewat semua key sebelum pindah ke model berikutnya.
      for (let i = 0; i < API_KEYS.length; i++) {
        const key = API_KEYS[keyCursor % API_KEYS.length];
        keyCursor++;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        try {
          const { data } = await axios.post(url, body, { timeout });
          return data; // sukses
        } catch (err) {
          lastErr = err;
          const status = err.response?.status;
          const keyIdx = (keyCursor - 1) % API_KEYS.length;
          if (status === 429) {
            console.log(`[callGemini] model=${model} key#${keyIdx} kena 429 (quota/limit), coba kombinasi lain...`);
            continue;
          }
          if ([500, 503].includes(status)) {
            console.log(`[callGemini] model=${model} key#${keyIdx} server overload (${status}), coba kombinasi lain...`);
            continue;
          }
          if (!err.response || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
            console.log(`[callGemini] model=${model} key#${keyIdx} timeout/network error, coba kombinasi lain...`);
            continue;
          }
          if ([400, 404].includes(status)) {
            // Kemungkinan nama model tidak valid/tidak tersedia utk key ini -> jangan buang sisa key,
            // tapi tetap lanjut (siapa tahu key lain support model ini, mis. region/akses berbeda).
            console.log(`[callGemini] model=${model} key#${keyIdx} status ${status} (cek nama model valid?), coba kombinasi lain...`);
            continue;
          }
          // 401/403 dari key ini = key invalid/revoked utk key tsb -> lanjut ke key lain, jangan hentikan semuanya.
          console.log(`[callGemini] model=${model} key#${keyIdx} status ${status}, coba kombinasi lain...`);
          continue;
        }
      }
    }
    // Semua model x semua key habis di putaran ini -> backoff sebelum putaran berikutnya.
    const waitTime = (Math.pow(2, round) * 2000) + (Math.random() * 1000);
    console.log(`[callGemini] semua model & key sibuk/limit, backoff ${Math.round(waitTime)}ms (putaran ${round + 1}/${rounds})`);
    await sleep(waitTime);
  }
  throw lastErr;
}

const SYSTEM_PROMPT = [
  // --- Identitas umum ---
  'Kamu adalah AI super cerdas dan serba bisa di server Discord, selevel asisten AI coding/teknis kelas atas (setara Claude).',
  'Kamu PUNYA akses internet lewat Google Search. JANGAN PERNAH menolak atau bilang kamu tidak punya data real-time.',
  'Kalau pertanyaan butuh info terkini (harga kripto/saham, berita, cuaca, skor, kurs, rilis terbaru, dll),',
  'cari secara AGRESIF lewat Google Search lalu jawab dengan ANGKA/FAKTA konkret terbaru beserta waktunya.',
  'Kalau ada data tambahan yang disisipkan di prompt dengan label [DATA REAL-TIME], anggap itu sumber paling akurat dan utamakan dibanding hasil tebakan/Search.',
  'Contoh: kalau ditanya harga BTC, langsung sebutkan angkanya saat ini, jangan menyuruh user cek sendiri.',
  'Jawab dengan jelas, akurat, dan to-the-point dalam Bahasa Indonesia (kecuali user minta bahasa lain). Boleh detail kalau memang perlu.',
  'Selalu utamakan kebenaran faktual berdasarkan hasil pencarian/data real-time, bukan tebakan.',

  // --- Keahlian coding (level senior software engineer) ---
  'Kamu menguasai coding di level senior/principal engineer: JavaScript/TypeScript, Node.js, Python, Go, Rust, Java, C/C++, PHP, Solidity, SQL, Bash, dan framework populer (React, Next.js, Vue, Express, NestJS, Django, FastAPI).',
  'Saat menulis atau review kode: gunakan best practice, beri penjelasan singkat tujuan kode, perhatikan edge case, error handling, keamanan (hindari SQL injection, XSS, command injection, secret yang ke-hardcode), dan performa.',
  'Kalau diminta debug, baca error/stack trace dengan teliti, jelaskan ROOT CAUSE-nya (bukan cuma tempelan/patch), lalu beri solusi konkret dengan contoh kode yang bisa langsung dipakai.',
  'Kalau kode panjang, gunakan code block dengan bahasa yang sesuai (```js, ```python, dst) dan beri komentar pada bagian penting saja, jangan berlebihan.',
  'Kalau user minta arsitektur/desain sistem, pertimbangkan skalabilitas, biaya, dan trade-off, lalu jelaskan opsi-opsi yang ada beserta kapan masing-masing cocok dipakai.',

  // --- Keahlian crypto, trading, blockchain, smart contract ---
  'Kamu paham mendalam soal crypto & trading: analisis fundamental, analisis teknikal (support/resistance, RSI, MACD, EMA/SMA, volume, funding rate, open interest), tokenomics, market cycle, on-chain metrics, dan manajemen risiko (position sizing, stop loss, risk/reward).',
  'Kamu paham blockchain secara teknis: konsensus (PoW/PoS), Layer 1 vs Layer 2, EVM vs non-EVM chain, gas fee, mempool, bridge, oracle (Chainlink dll), DeFi (DEX, AMM, lending, yield farming, liquidity pool, impermanent loss), dan NFT.',
  'Kamu paham smart contract: Solidity (struct, modifier, mapping, events, gas optimization), standar token (ERC-20, ERC-721, ERC-1155), pola umum (proxy/upgradeable, multisig, timelock), dan celah keamanan umum (reentrancy, integer overflow/underflow, access control, flash loan attack, front-running). Kalau diminta, kamu bisa audit/review kontrak secara kasar dan menandai potensi risikonya.',
  'Untuk pertanyaan harga/market crypto, kalau ada [DATA REAL-TIME] dari CoinGecko/Fear&Greed/dll di prompt, gunakan itu sebagai sumber utama dan sebutkan waktunya. Kalau tidak ada, cari lewat Google Search.',
  'SELALU beri disclaimer singkat di akhir kalau memberi opini soal trading/investasi: ini bukan saran finansial (Not Financial Advice/NFA), keputusan & risiko ada di tangan user. Jangan jadikan disclaimer ini alasan untuk menolak menjawab — tetap beri analisis konkret duluan.',

  // --- Keahlian web ---
  'Kamu paham web modern: HTML/CSS, responsive design, SEO dasar, REST/GraphQL API, autentikasi (JWT, OAuth), keamanan web (CORS, CSRF, HTTPS), deployment (Vercel, Docker, VPS, Nginx), dan integrasi pihak ketiga (payment gateway, webhook, dll).',

  // --- Gaya menjawab ---
  'Berpikir step-by-step secara internal sebelum menjawab pertanyaan kompleks, tapi tampilkan ke user hanya hasil akhir yang rapi dan actionable — jangan tampilkan "chain of thought" mentah.',
  'Kalau pertanyaan ambigu, buat asumsi yang paling wajar, sebutkan singkat asumsinya, lalu tetap jawab lengkap — jangan cuma balik nanya kalau bisa dihindari.',
].join(' ');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deteksi apakah user minta dibuatkan gambar.
function isImageRequest(text) {
  const t = (text || '').toLowerCase();
  return /\b(buat(kan)?|gambar(kan)?|lukis(kan)?|bikin(kan)?|generate|render|design|desain|sketsa|ilustrasi|foto)\b/.test(t)
    && /\b(gambar|foto|ilustrasi|logo|poster|wallpaper|sketsa|image|picture|art|artwork|desain|design)\b/.test(t);
}

// Deteksi apakah pertanyaan menyinggung harga/market crypto.
function isCryptoPriceRequest(text) {
  const t = (text || '').toLowerCase();
  return /\b(harga|price|kurs|market\s*cap|marketcap|gas\s*fee|trending|fear\s*and\s*greed|fear\s*&\s*greed|tvl)\b/.test(t)
    && (/\b(btc|eth|bnb|sol|crypto|kripto|koin|coin|token|altcoin)\b/.test(t) || /\b(gas|tvl|trending|fear)\b/.test(t));
}

// Cari id CoinGecko dari teks user berdasarkan symbol/nama yang dikenal (lihat COINGECKO_ID_MAP).
function extractCoinIds(text) {
  const t = (text || '').toLowerCase();
  const words = t.match(/[a-z0-9-]+/g) || [];
  const ids = new Set();
  for (const w of words) {
    if (COINGECKO_ID_MAP[w]) ids.add(COINGECKO_ID_MAP[w]);
  }
  return [...ids];
}

// === API CRYPTO ===

// Harga + perubahan 24h dari CoinGecko (gratis, tanpa API key). ids: array id CoinGecko.
async function getCryptoPrice(ids, vsCurrency = 'usd') {
  if (!ids || ids.length === 0) return null;
  try {
    const url = 'https://api.coingecko.com/api/v3/simple/price';
    const { data } = await axios.get(url, {
      params: {
        ids: ids.join(','),
        vs_currencies: vsCurrency,
        include_24hr_change: true,
        include_market_cap: true,
        include_last_updated_at: true,
      },
      timeout: 8000,
    });
    return data;
  } catch (err) {
    console.error('[getCryptoPrice] gagal:', err.response?.status || err.message);
    return null;
  }
}

// Koin yang sedang trending di CoinGecko.
async function getTrendingCrypto() {
  try {
    const { data } = await axios.get('https://api.coingecko.com/api/v3/search/trending', { timeout: 8000 });
    return (data?.coins || []).slice(0, 7).map((c) => ({
      name: c.item?.name,
      symbol: c.item?.symbol,
      rank: c.item?.market_cap_rank,
    }));
  } catch (err) {
    console.error('[getTrendingCrypto] gagal:', err.response?.status || err.message);
    return null;
  }
}

// Cari pair DEX (harga, liquidity, volume, FDV) lewat DexScreener — gratis, TANPA API key.
// Cocok buat token baru/micin yang belum masuk CoinGecko. query bisa nama, simbol, atau contract address.
async function getDexScreenerInfo(query) {
  if (!query) return null;
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/search`, {
      params: { q: query },
      timeout: 8000,
    });
    const pairs = (data?.pairs || [])
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
      .slice(0, 3);
    if (pairs.length === 0) return null;
    return pairs.map((p) => ({
      chain: p.chainId,
      dex: p.dexId,
      pair: `${p.baseToken?.symbol}/${p.quoteToken?.symbol}`,
      priceUsd: p.priceUsd,
      change24h: p.priceChange?.h24,
      liquidityUsd: p.liquidity?.usd,
      volume24h: p.volume?.h24,
      fdv: p.fdv,
      url: p.url,
    }));
  } catch (err) {
    console.error('[getDexScreenerInfo] gagal:', err.response?.status || err.message);
    return null;
  }
}

// Harga + statistik 24h dari Binance public API (gratis, TANPA API key, tanpa rate limit ketat).
// Bagus buat data trading karena lebih real-time/akurat dibanding CoinGecko untuk pair yang ada di Binance.
async function getBinanceTicker(symbolPair) {
  if (!symbolPair) return null;
  try {
    const { data } = await axios.get('https://api.binance.com/api/v3/ticker/24hr', {
      params: { symbol: symbolPair.toUpperCase() }, // contoh: BTCUSDT, ETHUSDT
      timeout: 8000,
    });
    return {
      symbol: data.symbol,
      lastPrice: data.lastPrice,
      change24hPct: data.priceChangePercent,
      high24h: data.highPrice,
      low24h: data.lowPrice,
      volume24h: data.volume,
    };
  } catch (err) {
    console.error('[getBinanceTicker] gagal:', err.response?.status || err.message);
    return null;
  }
}

// Rekomendasi fee transaksi Bitcoin saat ini dari mempool.space (gratis, TANPA API key).
async function getBtcMempoolFees() {
  try {
    const { data } = await axios.get('https://mempool.space/api/v1/fees/recommended', { timeout: 8000 });
    return data; // { fastestFee, halfHourFee, hourFee, economyFee, minimumFee } dalam sat/vB
  } catch (err) {
    console.error('[getBtcMempoolFees] gagal:', err.response?.status || err.message);
    return null;
  }
}

// Crypto Fear & Greed Index dari alternative.me (gratis, tanpa API key).
async function getFearGreedIndex() {
  try {
    const { data } = await axios.get('https://api.alternative.me/fng/', { timeout: 8000 });
    const v = data?.data?.[0];
    if (!v) return null;
    return { value: v.value, classification: v.value_classification, timestamp: v.timestamp };
  } catch (err) {
    console.error('[getFearGreedIndex] gagal:', err.response?.status || err.message);
    return null;
  }
}

// Total Value Locked sebuah protokol DeFi dari DefiLlama (gratis, tanpa API key).
async function getDefiLlamaTVL(protocol) {
  if (!protocol) return null;
  try {
    const { data } = await axios.get(`https://api.llama.fi/tvl/${encodeURIComponent(protocol)}`, { timeout: 8000 });
    return typeof data === 'number' ? { protocol, tvlUsd: data } : null;
  } catch (err) {
    console.error('[getDefiLlamaTVL] gagal:', err.response?.status || err.message);
    return null;
  }
}

// === API BLOCKCHAIN (Etherscan / BscScan / PolygonScan) ===

// Gas price terkini di chain EVM tertentu. chain: 'eth' | 'bsc' | 'polygon'.
async function getGasPrice(chain = 'eth') {
  const cfg = CHAIN_EXPLORERS[chain];
  if (!cfg || !cfg.key) return null; // skip kalau API key belum di-set
  try {
    const { data } = await axios.get(cfg.base, {
      params: { module: 'gastracker', action: 'gasoracle', apikey: cfg.key },
      timeout: 8000,
    });
    if (data?.status !== '1') return null;
    return { chain: cfg.name, ...data.result };
  } catch (err) {
    console.error(`[getGasPrice:${chain}] gagal:`, err.response?.status || err.message);
    return null;
  }
}

// Ambil source code + info kontrak (untuk bantu review/audit kasar). address: alamat kontrak.
async function getContractSource(address, chain = 'eth') {
  const cfg = CHAIN_EXPLORERS[chain];
  if (!cfg || !cfg.key || !address) return null;
  try {
    const { data } = await axios.get(cfg.base, {
      params: { module: 'contract', action: 'getsourcecode', address, apikey: cfg.key },
      timeout: 10000,
    });
    const result = data?.result?.[0];
    if (!result || !result.SourceCode) return null;
    return {
      chain: cfg.name,
      name: result.ContractName,
      compiler: result.CompilerVersion,
      isProxy: result.Proxy === '1',
      sourceCode: result.SourceCode,
    };
  } catch (err) {
    console.error(`[getContractSource:${chain}] gagal:`, err.response?.status || err.message);
    return null;
  }
}

// === API CODING (GitHub) ===

// Info ringkas sebuah repo GitHub (stars, bahasa, deskripsi, dll).
async function getGitHubRepo(owner, repo) {
  if (!owner || !repo) return null;
  try {
    const headers = GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {};
    const { data } = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, { headers, timeout: 8000 });
    return {
      fullName: data.full_name,
      description: data.description,
      stars: data.stargazers_count,
      forks: data.forks_count,
      language: data.language,
      openIssues: data.open_issues_count,
      url: data.html_url,
    };
  } catch (err) {
    console.error('[getGitHubRepo] gagal:', err.response?.status || err.message);
    return null;
  }
}

// Bangun blok "[DATA REAL-TIME]" dari berbagai API di atas berdasarkan isi pertanyaan user.
// Dipanggil otomatis oleh askGemini supaya model tidak perlu menebak harga/data on-chain.
async function buildRealtimeContext(question) {
  const lines = [];

  if (isCryptoPriceRequest(question)) {
    const ids = extractCoinIds(question);

    if (ids.length > 0) {
      const prices = await getCryptoPrice(ids);
      if (prices) {
        for (const id of ids) {
          const p = prices[id];
          if (!p) continue;
          const change = p.usd_24h_change != null ? p.usd_24h_change.toFixed(2) : 'N/A';
          lines.push(`- ${id}: $${p.usd} (24h: ${change}%, market cap: $${Math.round(p.usd_market_cap || 0).toLocaleString('en-US')})`);
        }
      }
    }

    if (/\btrending\b/.test(question.toLowerCase())) {
      const trending = await getTrendingCrypto();
      if (trending?.length) {
        lines.push(`- Trending di CoinGecko: ${trending.map((c) => `${c.name} (${c.symbol?.toUpperCase()})`).join(', ')}`);
      }
    }

    if (/fear\s*(and|&)?\s*greed/.test(question.toLowerCase())) {
      const fng = await getFearGreedIndex();
      if (fng) lines.push(`- Crypto Fear & Greed Index: ${fng.value} (${fng.classification})`);
    }

    if (/\bgas\b/.test(question.toLowerCase())) {
      for (const chain of Object.keys(CHAIN_EXPLORERS)) {
        const gas = await getGasPrice(chain);
        if (gas) lines.push(`- Gas price ${gas.chain}: Safe ${gas.SafeGasPrice} / Propose ${gas.ProposeGasPrice} / Fast ${gas.FastGasPrice} Gwei`);
      }
    }

    if (/\btvl\b/.test(question.toLowerCase())) {
      // Coba tebak nama protokol dari kata sebelum/sesudah "tvl" — sederhana, model tetap bisa cross-check via Search.
      const match = question.toLowerCase().match(/tvl\s+(?:dari|di|of)?\s*([a-z0-9-]+)|([a-z0-9-]+)\s+tvl/);
      const protocol = match?.[1] || match?.[2];
      if (protocol) {
        const tvl = await getDefiLlamaTVL(protocol);
        if (tvl) lines.push(`- TVL ${tvl.protocol}: $${Math.round(tvl.tvlUsd).toLocaleString('en-US')}`);
      }
    }

    // Token baru/micin yang mungkin tidak ada di CoinGecko -> coba DexScreener (butuh contract address/nama unik di teks).
    const addressMatch = question.match(/\b0x[a-fA-F0-9]{40}\b/);
    if (addressMatch || /\bdex(screener)?\b/i.test(question)) {
      const queryTarget = addressMatch ? addressMatch[0] : ids[0] || question;
      const dexInfo = await getDexScreenerInfo(queryTarget);
      if (dexInfo?.length) {
        for (const p of dexInfo) {
          lines.push(`- [DexScreener] ${p.pair} di ${p.dex} (${p.chain}): $${p.priceUsd} (24h: ${p.change24h}%), liquidity $${Math.round(p.liquidityUsd || 0).toLocaleString('en-US')}, FDV $${Math.round(p.fdv || 0).toLocaleString('en-US')}`);
        }
      }
    }

    // BTC fee/mempool kalau disinggung.
    if (/\b(mempool|btc\s*fee|bitcoin\s*fee|fee\s*btc)\b/i.test(question)) {
      const fees = await getBtcMempoolFees();
      if (fees) lines.push(`- BTC network fee (sat/vB): fastest ${fees.fastestFee}, 30min ${fees.halfHourFee}, 1hr ${fees.hourFee}, economy ${fees.economyFee}`);
    }
  }

  // Deteksi referensi repo GitHub "owner/repo" di teks (mis. "vercel/next.js").
  const repoMatch = question.match(/\b([\w.-]+)\/([\w.-]+)\b/);
  if (repoMatch && /github|repo|library|library|package/i.test(question)) {
    const repoInfo = await getGitHubRepo(repoMatch[1], repoMatch[2]);
    if (repoInfo) {
      lines.push(`- GitHub ${repoInfo.fullName}: ⭐${repoInfo.stars}, bahasa ${repoInfo.language || '-'}, "${repoInfo.description || 'tanpa deskripsi'}"`);
    }
  }

  if (lines.length === 0) return '';
  return `\n\n[DATA REAL-TIME — sumber API langsung, gunakan ini sebagai acuan utama]\n${lines.join('\n')}\n[/DATA REAL-TIME]`;
}

// Tanya AI dengan Google Search grounding (rotasi model x key ditangani callGemini).
// Otomatis menyisipkan data real-time (harga crypto, gas fee, dll) lewat buildRealtimeContext kalau relevan.
// `model` opsional: string (dicoba duluan) atau array model custom. Default: semua TEXT_MODELS dari env.
// Return { text, sources } di mana sources = [{ title, uri }].
async function askGemini(question, model) {
  const extraContext = await buildRealtimeContext(question);
  const finalQuestion = question + extraContext;

  const body = {
    contents: [{ role: 'user', parts: [{ text: finalQuestion }] }],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    tools: [{ google_search: {} }],
  };

  // Kalau caller minta model spesifik, coba itu duluan, baru fallback ke sisa TEXT_MODELS.
  const modelsToTry = model
    ? [...new Set([...(Array.isArray(model) ? model : [model]), ...TEXT_MODELS])]
    : TEXT_MODELS;

  const data = await callGemini(modelsToTry, body, 20000);

  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text).filter(Boolean).join('') || 'Tidak ada jawaban.';

  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  const sources = chunks
    .map((c) => c.web)
    .filter(Boolean)
    .map((w) => ({ title: w.title || w.uri, uri: w.uri }));

  return { text, sources };
}

// Generate gambar pakai model image (Nano Banana dkk). Return { imageBuffer, text }.
// Rotasi model x key ditangani callGemini lewat IMAGE_MODELS (isi GEMINI_IMAGE_MODELS kalau punya >1 model image).
async function generateImage(prompt, model) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };

  const modelsToTry = model
    ? [...new Set([...(Array.isArray(model) ? model : [model]), ...IMAGE_MODELS])]
    : IMAGE_MODELS;

  const data = await callGemini(modelsToTry, body, 30000);

  const parts = data?.candidates?.[0]?.content?.parts || [];
  let imageBuffer = null;
  let text = '';
  for (const p of parts) {
    if (p.inlineData?.data) {
      imageBuffer = Buffer.from(p.inlineData.data, 'base64');
    } else if (p.text) {
      text += p.text;
    }
  }
  return { imageBuffer, text };
}

// Gabungkan teks jawaban + daftar sumber, pangkas ke batas 2000 char Discord.
function formatAnswer(text, sources = []) {
  let out = text || 'Tidak ada jawaban.';

  if (sources.length > 0) {
    const seen = new Set();
    const unique = [];
    for (const s of sources) {
      if (s.uri && !seen.has(s.uri)) {
        seen.add(s.uri);
        unique.push(s);
      }
      if (unique.length >= 5) break;
    }
    // Bungkus URL dengan <...> supaya Discord TIDAK menampilkan preview/embed besar.
    const list = unique.map((s, i) => `${i + 1}. [${s.title}](<${s.uri}>)`).join('\n');
    const footer = `\n\n📚 **Sumber:**\n${list}`;

    const maxBody = 2000 - footer.length;
    if (out.length > maxBody) out = out.slice(0, maxBody - 1) + '…';
    out += footer;
  } else if (out.length > 2000) {
    out = out.slice(0, 1999) + '…';
  }

  return out;
}

// Ubah error jadi pesan ramah Bahasa Indonesia.
function friendlyError(err) {
  const status = err.response?.status;
  const apiMsg = err.response?.data?.error?.message || err.message;
  console.error('[ai] Gagal:', status, apiMsg);

  if (status === 429) return '⚠️ Rate limit Gemini tercapai. Coba lagi sebentar lagi.';
  if (status === 503 || status === 500) return '⚠️ Server Gemini sedang sibuk/overload. Ini sementara — coba lagi beberapa saat lagi.';
  if (status === 404) return `⚠️ Model "${GEMINI_MODEL}" tidak ditemukan/sudah dipensiunkan. Set env GEMINI_MODEL ke model yang aktif.`;
  return `⚠️ Gagal memproses jawaban AI. (${status || 'error'}: ${apiMsg})`;
}

module.exports = {
  SYSTEM_PROMPT,
  GEMINI_MODEL,
  TEXT_MODELS,
  IMAGE_MODELS,
  callGemini,
  isImageRequest,
  askGemini,
  generateImage,
  formatAnswer,
  friendlyError,
  // API crypto
  isCryptoPriceRequest,
  extractCoinIds,
  getCryptoPrice,
  getTrendingCrypto,
  getFearGreedIndex,
  getDefiLlamaTVL,
  // API blockchain
  getGasPrice,
  getContractSource,
  // API coding
  getGitHubRepo,
  buildRealtimeContext,
};
