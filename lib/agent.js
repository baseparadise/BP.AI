'use strict';
    const axios = require('axios');

    const {
    getCryptoPrice, getTrendingCrypto, getFearGreedIndex, getDefiLlamaTVL,
    getGasPrice, getDexScreenerInfo, getBtcMempoolFees, getBinanceTicker,
    sanitizeHistoryForGemini, SYSTEM_PROMPT, SYSTEM_PROMPT_DM, TEXT_MODELS,
    } = require('./ai');
    const { runScamAnalysis } = require('./tokenScamAnalysis');
    const { fetchZerionPortfolio } = require('./zerion');
    const { detectGmgnQuery, handleGmgnCommand } = require('./gmgn');

    // Keys (sama env var seperti di ai.js)
    function parseList(str, def = []) {
    return str ? str.split(',').map(s => s.trim()).filter(Boolean) : def;
    }
    const GEMINI_KEYS   = parseList(process.env.GEMINI_API_KEYS  || process.env.GEMINI_API_KEY);
    const GROQ_KEYS     = parseList(process.env.GROQ_API_KEYS    || process.env.GROQ_API_KEY);
    const OPENAI_KEYS   = parseList(process.env.OPENAI_API_KEYS  || process.env.OPENAI_API_KEY);
    const GROQ_MODELS   = parseList(process.env.GROQ_MODELS,  ['llama-3.3-70b-versatile']);
    const OPENAI_MODELS = parseList(process.env.OPENAI_MODELS, ['gpt-4o-mini']);

    const MAX_ITER    = 8;
    const TOOL_TIMEOUT = 15000; // ditingkatkan dari 12s ke 15s untuk on-chain queries

    // ─── Round-robin key counters (lebih merata dari random) ─────────────────────
    let _geminiIdx = 0;
    let _groqIdx   = 0;
    let _openaiIdx = 0;
    function nextKey(keys, counter) { return keys[counter % keys.length]; }

    // ─── Tool Registry ───────────────────────────────────────────────────────────

    const TOOLS = {
    getCryptoPrice: {
      desc: 'Ambil harga kripto terkini, market cap, dan perubahan 24h dari CoinGecko. Gunakan untuk BTC, ETH, SOL, dan coin besar.',
      params: {
        type: 'OBJECT',
        properties: {
          coin_ids: { type: 'STRING', description: 'ID coin CoinGecko dipisah koma. Contoh: "bitcoin,ethereum,solana"' },
        },
        required: ['coin_ids'],
      },
      async fn({ coin_ids }) {
        const ids = coin_ids.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const data = await getCryptoPrice(ids);
        if (!data) return 'Coin tidak ditemukan di CoinGecko.';
        const lines = Object.entries(data).map(([id, v]) => {
          const usd = v.usd ?? '?';
          const chg = v.usd_24h_change !== undefined ? ' (' + (v.usd_24h_change >= 0 ? '+' : '') + v.usd_24h_change.toFixed(2) + '% 24h)' : '';
          const mc  = v.usd_market_cap ? ' MC: $' + (v.usd_market_cap / 1e9).toFixed(2) + 'B' : '';
          return id + ': $' + usd + chg + mc;
        });
        return lines.join('\n') || 'Data tidak tersedia.';
      },
    },

    getDexPrice: {
      desc: 'Cari data token dari DEX — harga, volume, liquidity, market cap, contract address. Cocok untuk altcoin/memecoin/token DeFi yang tidak ada di CoinGecko.',
      params: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'Simbol token atau contract address. Contoh: "PEPE", "0x532f27101...", "So11111111111111111111111111111111111111112"' },
        },
        required: ['query'],
      },
      async fn({ query }) {
        const data = await getDexScreenerInfo(query);
        if (!data) return 'Token "' + query + '" tidak ditemukan di DexScreener.';
        return JSON.stringify(data, null, 2).slice(0, 3000);
      },
    },

    getBinancePrice: {
      desc: 'Ambil harga spot Binance real-time. Untuk major crypto (BTC, ETH, BNB, SOL, XRP dll). Simbol harus format XYZUSDT.',
      params: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING', description: 'Pasangan Binance. Contoh: "BTCUSDT", "ETHUSDT", "SOLUSDT"' },
        },
        required: ['symbol'],
      },
      async fn({ symbol }) {
        const sym = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : symbol.toUpperCase() + 'USDT';
        const data = await getBinanceTicker(sym);
        if (!data) return 'Symbol "' + symbol + '" tidak ditemukan di Binance.';
        return JSON.stringify(data, null, 2);
      },
    },

    getTrendingTokens: {
      desc: 'Ambil daftar token kripto yang sedang trending hari ini berdasarkan pencarian CoinGecko.',
      params: { type: 'OBJECT', properties: {}, required: [] },
      async fn() {
        const data = await getTrendingCrypto();
        if (!data || !data.length) return 'Gagal ambil data trending atau tidak ada data.';
        return 'Trending hari ini (CoinGecko):\n' +
          data.map((c, i) => `${i + 1}. ${c.name} (${(c.symbol || '').toUpperCase()}) — rank #${c.rank || '?'}`).join('\n');
      },
    },

    getFearGreed: {
      desc: 'Ambil Bitcoin Fear & Greed Index saat ini (0=Extreme Fear, 100=Extreme Greed). Menunjukkan sentimen pasar crypto secara keseluruhan.',
      params: { type: 'OBJECT', properties: {}, required: [] },
      async fn() {
        const data = await getFearGreedIndex();
        if (!data) return 'Gagal ambil Fear & Greed Index.';
        return `Fear & Greed Index: ${data.value}/100 (${data.classification})`;
      },
    },

    getEthGasPrice: {
      desc: 'Ambil harga gas Ethereum (ETH) terkini dalam Gwei — slow, standard, fast.',
      params: { type: 'OBJECT', properties: {}, required: [] },
      async fn() {
        const data = await getGasPrice('eth');
        if (!data) return 'Gagal ambil gas price Ethereum.';
        return `Gas price ${data.chain}: Slow ${data.SafeGasPrice} / Standard ${data.ProposeGasPrice} / Fast ${data.FastGasPrice} Gwei`;
      },
    },

    getDefiTVL: {
      desc: 'Ambil Total Value Locked (TVL) protocol DeFi dari DefiLlama. Harus isi nama protocol.',
      params: {
        type: 'OBJECT',
        properties: {
          protocol: { type: 'STRING', description: 'Slug protocol DeFi. Contoh: "uniswap", "aave", "lido", "curve", "makerdao".' },
        },
        required: ['protocol'],
      },
      async fn({ protocol } = {}) {
        if (!protocol) return 'Tolong sebutkan nama protocol DeFi-nya. Contoh: uniswap, aave, lido.';
        const data = await getDefiLlamaTVL(protocol);
        if (!data) return `Protocol "${protocol}" tidak ditemukan di DefiLlama. Coba pakai slug resminya.`;
        return `TVL ${data.protocol}: $${Math.round(data.tvlUsd).toLocaleString('en-US')}`;
      },
    },

    getBtcFees: {
      desc: 'Ambil estimasi fee transaksi Bitcoin dari mempool — fastest, half-hour, hour.',
      params: { type: 'OBJECT', properties: {}, required: [] },
      async fn() {
        const data = await getBtcMempoolFees();
        if (!data) return 'Gagal ambil BTC fees dari mempool.';
        return `BTC fee (sat/vB): Fastest ${data.fastestFee} / 30min ${data.halfHourFee} / 1hr ${data.hourFee} / Economy ${data.economyFee}`;
      },
    },

    analyzeTokenSecurity: {
      desc: 'Analisis keamanan token EVM — cek rug pull, honeypot, top holder, liquidity, LP lock. Butuh contract address (0x...). Chain default: base.',
      params: {
        type: 'OBJECT',
        properties: {
          contract_address: { type: 'STRING', description: 'Contract address token EVM. Contoh: "0x532f27101965dd16442E59d40670FaF5eBB142E4"' },
          chain: { type: 'STRING', description: 'Blockchain. Contoh: "base", "ethereum", "bsc". Default: "base"' },
        },
        required: ['contract_address'],
      },
      async fn({ contract_address, chain = 'base' }) {
        // runScamAnalysis menerima string pertanyaan, bukan address langsung
        const result = await runScamAnalysis(`${contract_address} ${chain}`);
        if (!result || !result.fullPrompt) return 'Gagal analisis token — data on-chain tidak tersedia.';
        // Kembalikan fullPrompt (data on-chain yang dikumpulkan) agar agent bisa format jawabannya
        return result.fullPrompt.slice(0, 5000);
      },
    },

    getWalletPortfolio: {
      desc: 'Ambil portofolio lengkap wallet EVM — semua token dan total nilai USD dari Zerion.',
      params: {
        type: 'OBJECT',
        properties: {
          address: { type: 'STRING', description: 'Wallet address (0x...) atau ENS. Contoh: "0x742d35Cc..." atau "vitalik.eth"' },
        },
        required: ['address'],
      },
      async fn({ address }) {
        const data = await fetchZerionPortfolio(address);
        return data ? String(data).slice(0, 4000) : 'Gagal ambil portfolio wallet.';
      },
    },

    getOnchainData: {
      desc: 'Ambil data on-chain dari GMGN — info token Solana/EVM (holder, smart money flow, dev activity, market cap kecil), daftar smart trader aktif, atau token trending on-chain. Gunakan saat DexScreener tidak cukup atau user tanya soal Solana memecoin/altcoin.',
      params: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: 'Sub-perintah GMGN. Format: "<CA>" untuk info token spesifik, "trending sol" untuk trending Solana, "trending eth/base/bsc" untuk chain lain, "smart sol" untuk top smart traders Solana, "smart eth" untuk ETH, "wallet <address>" untuk aktivitas wallet tertentu.',
          },
        },
        required: ['query'],
      },
      async fn({ query }) {
        const q = String(query).trim();
        const parsed = detectGmgnQuery('gmgn ' + q);
        if (!parsed) {
          return 'Format query tidak valid. Contoh: "trending sol", "smart eth", atau contract address token.';
        }
        const data = await handleGmgnCommand(parsed);
        return data ? String(data).slice(0, 5000) : 'Data GMGN tidak tersedia.';
      },
    },
    };

    // ─── Execute Tool ─────────────────────────────────────────────────────────────

    async function executeTool(name, args) {
    const tool = TOOLS[name];
    if (!tool) return 'Error: tool "' + name + '" tidak dikenal.';
    try {
      const result = await Promise.race([
        tool.fn(args || {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TOOL_TIMEOUT)),
      ]);
      return String(result).slice(0, 6000);
    } catch (e) {
      console.error('[agent] tool "' + name + '" error:', e.message);
      return 'Error ' + name + ': ' + e.message;
    }
    }

    // ─── Schema helpers ───────────────────────────────────────────────────────────

    const GEMINI_TOOL_DEFS = [{
    function_declarations: Object.entries(TOOLS).map(([name, t]) => ({
      name,
      description: t.desc,
      parameters: t.params,
    })),
    }];

    const OAI_TOOL_DEFS = Object.entries(TOOLS).map(([name, t]) => ({
    type: 'function',
    function: {
      name,
      description: t.desc,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.params.properties || {}).map(([k, v]) => [
            k, { type: (v.type || 'STRING').toLowerCase(), description: v.description },
          ])
        ),
        required: t.params.required || [],
      },
    },
    }));

    // ─── Gemini Agent ─────────────────────────────────────────────────────────────

    async function runGeminiAgent(question, history, systemPrompt, onToolCall, overrideSystemPrompt) {
    if (overrideSystemPrompt) systemPrompt = overrideSystemPrompt;
    if (!GEMINI_KEYS.length) throw new Error('no Gemini keys');
    const key   = nextKey(GEMINI_KEYS, _geminiIdx++); // round-robin antar 13 key
    const model = (Array.isArray(TEXT_MODELS) && TEXT_MODELS[0]) || 'gemini-2.0-flash';
    const url   = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;

    const safe = sanitizeHistoryForGemini(history);
    const contents = [
      ...safe.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content || '' }] })),
      { role: 'user', parts: [{ text: question }] },
    ];

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const { data } = await axios.post(url, {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools: GEMINI_TOOL_DEFS,
        tool_config: { function_calling_config: { mode: 'AUTO' } },
        generationConfig: { maxOutputTokens: 8192 },
      }, { timeout: 90000 });

      const candidate = data?.candidates?.[0];
      if (!candidate) throw new Error('Gemini response kosong');

      const parts   = candidate.content?.parts || [];
      const fnCalls = parts.filter(p => p.functionCall);
      const texts   = parts.filter(p => p.text && p.text.trim());

      if (!fnCalls.length) return texts.map(p => p.text).join('\n').trim();

      contents.push({ role: 'model', parts });

      const toolResults = await Promise.all(fnCalls.map(async fc => {
        const { name, args } = fc.functionCall;
        if (onToolCall) await onToolCall(name, args).catch(() => {});
        console.log('[agent/gemini] \u2192 ' + name + '(' + JSON.stringify(args || {}).slice(0, 80) + ')');
        const result = await executeTool(name, args || {});
        return { functionResponse: { name, response: { content: result } } };
      }));

      contents.push({ role: 'user', parts: toolResults });
    }
    throw new Error('Agent loop melebihi batas iterasi');
    }

    // ─── OpenAI / Groq Agent ──────────────────────────────────────────────────────

    async function runOAIAgent(apiUrl, keys, models, question, history, systemPrompt, onToolCall, keyCounter, overrideSystemPrompt, isDMOwner) {
    if (overrideSystemPrompt) systemPrompt = overrideSystemPrompt;
    if (!keys.length) throw new Error('no keys');
    const key   = nextKey(keys, keyCounter); // round-robin via external counter
    const model = models[0];

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content || '' })),
      { role: 'user', content: question },
    ];

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const { data } = await axios.post(apiUrl, {
        model, messages, tools: OAI_TOOL_DEFS, tool_choice: 'auto',
        max_tokens: isDMOwner ? 8192 : 4096,
      }, {
        timeout: 90000,
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      });

      const msg = data?.choices?.[0]?.message;
      if (!msg) throw new Error('Response kosong');
      messages.push(msg);
      if (!msg.tool_calls?.length) return msg.content || '';

      await Promise.all(msg.tool_calls.map(async tc => {
        const name = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        if (onToolCall) await onToolCall(name, args).catch(() => {});
        console.log('[agent/oai] \u2192 ' + name + '(' + JSON.stringify(args).slice(0, 80) + ')');
        const result = await executeTool(name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }));
    }
    throw new Error('Agent loop melebihi batas iterasi');
    }

    // ─── Main runAgent ────────────────────────────────────────────────────────────

    const AGENT_ADDENDUM = '\n\n--- AGENT MODE ---\n' +
    'Kamu memiliki tools real-time berikut. Panggil tools SEBELUM menjawab jika data terkini dibutuhkan:\n' +
    '\u2022 getCryptoPrice \u2192 harga & market cap CoinGecko (coin besar/mainstream)\n' +
    '\u2022 getBinancePrice \u2192 harga spot Binance real-time (format: BTCUSDT)\n' +
    '\u2022 getDexPrice \u2192 harga dari DEX (altcoin/memecoin kecil, bisa pakai CA)\n' +
    '\u2022 getOnchainData \u2192 data on-chain GMGN: info token Sol/EVM, smart money, trending per chain\n' +
    '\u2022 getTrendingTokens \u2192 token trending CoinGecko hari ini\n' +
    '\u2022 getFearGreed \u2192 sentimen pasar (Fear & Greed Index)\n' +
    '\u2022 getEthGasPrice / getBtcFees \u2192 biaya transaksi real-time\n' +
    '\u2022 getDefiTVL \u2192 TVL protocol DeFi dari DefiLlama\n' +
    '\u2022 analyzeTokenSecurity \u2192 audit keamanan token EVM (perlu CA 0x...) — honeypot, rug, LP lock\n' +
    '\u2022 getWalletPortfolio \u2192 semua aset wallet EVM via Zerion\n' +
    '\nSTRATEGI TOOLS:\n' +
    '- Token Solana/Base kecil atau memecoin: getOnchainData terlebih dahulu, getDexPrice sebagai pelengkap.\n' +
    '- Analisis token EVM: selalu coba analyzeTokenSecurity untuk cek honeypot/rug.\n' +
    '- Sentimen pasar: gabungkan getFearGreed + getTrendingTokens + getCryptoPrice secara paralel.\n' +
    '- Panggil beberapa tools SEKALIGUS (parallel) jika data saling melengkapi.\n' +
    'Format jawaban akhir sesuai aturan Discord (tanpa tabel pipe, tanpa HTML).';

    async function runAgent(question, history = [], isDMOwner = false, onToolCall = null, overrideSystemPrompt = null) {
    // DM owner pakai pair-programmer prompt agar lebih dalam dan teknikal
    const basePrompt = isDMOwner ? (SYSTEM_PROMPT_DM || SYSTEM_PROMPT) : SYSTEM_PROMPT;
    const systemPrompt = (basePrompt || '') + AGENT_ADDENDUM;
    let lastErr;

    if (GEMINI_KEYS.length) {
      try {
        const text = await runGeminiAgent(question, history, systemPrompt, onToolCall, overrideSystemPrompt);
        return { text, sources: [] };
      } catch (e) {
        lastErr = e;
        console.log('[agent] Gemini gagal:', e.message?.slice(0, 120));
      }
    }

    if (GROQ_KEYS.length) {
      try {
        const text = await runOAIAgent(
          'https://api.groq.com/openai/v1/chat/completions',
          GROQ_KEYS, GROQ_MODELS, question, history, systemPrompt, onToolCall, _groqIdx++, overrideSystemPrompt, isDMOwner,
        );
        return { text, sources: [] };
      } catch (e) {
        lastErr = e;
        console.log('[agent] Groq gagal:', e.message?.slice(0, 120));
      }
    }

    if (OPENAI_KEYS.length) {
      try {
        const text = await runOAIAgent(
          'https://api.openai.com/v1/chat/completions',
          OPENAI_KEYS, OPENAI_MODELS, question, history, systemPrompt, onToolCall, _openaiIdx++, overrideSystemPrompt, isDMOwner,
        );
        return { text, sources: [] };
      } catch (e) {
        lastErr = e;
        console.log('[agent] OpenAI gagal:', e.message?.slice(0, 120));
      }
    }

    throw lastErr || new Error('Semua provider agent gagal');
    }

    module.exports = { runAgent };
    