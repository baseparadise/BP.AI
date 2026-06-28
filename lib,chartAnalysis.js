'use strict';
  // lib/chartAnalysis.js
  // Technical Analysis chart untuk Discord bot BP.AI
  // Menggunakan Binance API (data OHLCV) + QuickChart.io (render candlestick PNG)
  // Tidak membutuhkan npm package baru — hanya axios yang sudah ada.

  const axios = require('axios');

  // ============================================================
  // SYMBOL MAP — ticker Discord -> pair Binance
  // ============================================================
  const SYMBOL_MAP = {
    btc: 'BTCUSDT', bitcoin: 'BTCUSDT',
    eth: 'ETHUSDT', ethereum: 'ETHUSDT',
    bnb: 'BNBUSDT',
    sol: 'SOLUSDT', solana: 'SOLUSDT',
    xrp: 'XRPUSDT', ripple: 'XRPUSDT',
    ada: 'ADAUSDT', cardano: 'ADAUSDT',
    doge: 'DOGEUSDT', dogecoin: 'DOGEUSDT',
    avax: 'AVAXUSDT', avalanche: 'AVAXUSDT',
    dot: 'DOTUSDT', polkadot: 'DOTUSDT',
    link: 'LINKUSDT', chainlink: 'LINKUSDT',
    ltc: 'LTCUSDT', litecoin: 'LTCUSDT',
    uni: 'UNIUSDT', uniswap: 'UNIUSDT',
    atom: 'ATOMUSDT', cosmos: 'ATOMUSDT',
    near: 'NEARUSDT',
    arb: 'ARBUSDT', arbitrum: 'ARBUSDT',
    op: 'OPUSDT', optimism: 'OPUSDT',
    inj: 'INJUSDT', injective: 'INJUSDT',
    sui: 'SUIUSDT',
    ton: 'TONUSDT',
    pepe: 'PEPEUSDT',
    trx: 'TRXUSDT', tron: 'TRXUSDT',
    xlm: 'XLMUSDT', stellar: 'XLMUSDT',
    apt: 'APTUSDT', aptos: 'APTUSDT',
    shib: 'SHIBUSDT',
    matic: 'MATICUSDT', polygon: 'MATICUSDT',
    fil: 'FILUSDT', filecoin: 'FILUSDT',
  };

  const VALID_INTERVALS = ['1m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'];

  // ============================================================
  // FETCH OHLCV dari Binance (gratis, tanpa API key)
  // ============================================================
  async function fetchOHLCV(pair, interval, limit) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    return data.map(k => ({
      t: k[0],
      o: parseFloat(k[1]),
      h: parseFloat(k[2]),
      l: parseFloat(k[3]),
      c: parseFloat(k[4]),
      v: parseFloat(k[5]),
    }));
  }

  // ============================================================
  // INDIKATOR TEKNIKAL
  // ============================================================
  function calcSMA(arr, period) {
    return arr.map((_, i) => {
      if (i < period - 1) return null;
      return arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    });
  }

  function calcEMA(arr, period) {
    const k = 2 / (period + 1);
    const result = [];
    let ema = null;
    for (let i = 0; i < arr.length; i++) {
      if (i < period - 1) { result.push(null); continue; }
      if (ema === null) {
        ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
      } else {
        ema = arr[i] * k + ema * (1 - k);
      }
      result.push(parseFloat(ema.toFixed(8)));
    }
    return result;
  }

  function calcRSI(closes, period) {
    period = period || 14;
    const result = new Array(period).fill(null);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) avgGain += diff; else avgLoss -= diff;
    }
    avgGain /= period; avgLoss /= period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    return result;
  }

  function calcBB(closes, period, mult) {
    period = period || 20; mult = mult || 2;
    const sma = calcSMA(closes, period);
    return sma.map((m, i) => {
      if (m === null) return { upper: null, mid: null, lower: null };
      const slice = closes.slice(i - period + 1, i + 1);
      const std = Math.sqrt(slice.reduce((a, v) => a + Math.pow(v - m, 2), 0) / period);
      return { upper: m + mult * std, mid: m, lower: m - mult * std };
    });
  }

  function calcMACD(closes) {
    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    const macdLine = ema12.map((v, i) => (v !== null && ema26[i] !== null) ? v - ema26[i] : null);
    const validMacd = macdLine.map(v => v !== null ? v : 0);
    const signalLine = calcEMA(validMacd, 9);
    return macdLine.map((v, i) => ({
      macd: v,
      signal: signalLine[i],
      hist: (v !== null && signalLine[i] !== null) ? v - signalLine[i] : null,
    }));
  }

  // ============================================================
  // DETEKSI POLA CANDLESTICK
  // ============================================================
  function detectCandlePatterns(ohlcv) {
    const patterns = [];
    const n = ohlcv.length;
    if (n < 3) return patterns;

    // Helper
    const body = c => Math.abs(c.c - c.o);
    const range = c => c.h - c.l;
    const isBull = c => c.c > c.o;
    const isBear = c => c.c < c.o;
    const upperWick = c => c.h - Math.max(c.o, c.c);
    const lowerWick = c => Math.min(c.o, c.c) - c.l;

    const last = ohlcv[n - 1];
    const prev = ohlcv[n - 2];
    const prev2 = ohlcv[n - 3];

    // --- 1 candle terakhir ---
    const bd = body(last), rng = range(last);
    const uw = upperWick(last), lw = lowerWick(last);

    // Doji
    if (rng > 0 && bd / rng < 0.1) {
      patterns.push({ label: '🔸 Doji terdeteksi', desc: 'Ketidakpastian pasar, potensi pembalikan arah', bias: 'neutral' });
    }
    // Hammer (bullish reversal)
    else if (lw > bd * 2 && uw < bd * 0.5 && isBull(last)) {
      patterns.push({ label: '🔨 Hammer', desc: 'Pola pembalikan bullish — tekanan jual melemah', bias: 'bullish' });
    }
    // Shooting Star (bearish reversal)
    else if (uw > bd * 2 && lw < bd * 0.5 && isBear(last)) {
      patterns.push({ label: '⭐ Shooting Star', desc: 'Pola pembalikan bearish — tekanan beli melemah', bias: 'bearish' });
    }
    // Marubozu bullish
    else if (isBull(last) && bd / rng > 0.9) {
      patterns.push({ label: '🟩 Marubozu Bullish', desc: 'Candle kuat tanpa shadow — momentum beli dominan', bias: 'bullish' });
    }
    // Marubozu bearish
    else if (isBear(last) && bd / rng > 0.9) {
      patterns.push({ label: '🟥 Marubozu Bearish', desc: 'Candle kuat tanpa shadow — momentum jual dominan', bias: 'bearish' });
    }

    // --- 2 candle terakhir ---
    const bd2 = body(prev);
    // Bullish Engulfing
    if (isBear(prev) && isBull(last) && last.c > prev.o && last.o < prev.c) {
      patterns.push({ label: '📗 Bullish Engulfing', desc: 'Candle hijau menelan candle merah sebelumnya — sinyal reversal naik', bias: 'bullish' });
    }
    // Bearish Engulfing
    else if (isBull(prev) && isBear(last) && last.c < prev.o && last.o > prev.c) {
      patterns.push({ label: '📕 Bearish Engulfing', desc: 'Candle merah menelan candle hijau sebelumnya — sinyal reversal turun', bias: 'bearish' });
    }
    // Tweezer Bottom
    else if (Math.abs(last.l - prev.l) / last.l < 0.001 && isBear(prev) && isBull(last)) {
      patterns.push({ label: '📍 Tweezer Bottom', desc: 'Dua candle dengan low sama — support kuat, potensi rebound', bias: 'bullish' });
    }
    // Tweezer Top
    else if (Math.abs(last.h - prev.h) / last.h < 0.001 && isBull(prev) && isBear(last)) {
      patterns.push({ label: '📌 Tweezer Top', desc: 'Dua candle dengan high sama — resistance kuat, potensi koreksi', bias: 'bearish' });
    }

    // --- 3 candle terakhir ---
    // Morning Star (bullish reversal 3-bar)
    if (isBear(prev2) && body(prev) < body(prev2) * 0.3 && isBull(last) && last.c > (prev2.o + prev2.c) / 2) {
      patterns.push({ label: '🌟 Morning Star', desc: 'Pola pembalikan bullish 3 candle — sinyal kuat naik', bias: 'bullish' });
    }
    // Evening Star (bearish reversal 3-bar)
    else if (isBull(prev2) && body(prev) < body(prev2) * 0.3 && isBear(last) && last.c < (prev2.o + prev2.c) / 2) {
      patterns.push({ label: '🌆 Evening Star', desc: 'Pola pembalikan bearish 3 candle — sinyal kuat turun', bias: 'bearish' });
    }
    // Three White Soldiers
    if (isBull(prev2) && isBull(prev) && isBull(last) &&
        prev.c > prev2.c && last.c > prev.c &&
        body(prev2) > range(prev2) * 0.5 && body(prev) > range(prev) * 0.5 && body(last) > range(last) * 0.5) {
      patterns.push({ label: '💚 Three White Soldiers', desc: '3 candle hijau berturut kuat — momentum beli sangat kuat', bias: 'bullish' });
    }
    // Three Black Crows
    if (isBear(prev2) && isBear(prev) && isBear(last) &&
        prev.c < prev2.c && last.c < prev.c &&
        body(prev2) > range(prev2) * 0.5 && body(prev) > range(prev) * 0.5 && body(last) > range(last) * 0.5) {
      patterns.push({ label: '🖤 Three Black Crows', desc: '3 candle merah berturut kuat — momentum jual sangat kuat', bias: 'bearish' });
    }

    return patterns;
  }

  // ============================================================
  // ANALISIS INDIKATOR + POLA KESELURUHAN
  // ============================================================
  function analyzeAll(ohlcv, closes, rsi, macdData, sma20, sma50, bb) {
    const last = closes[closes.length - 1];
    const lastRSI = rsi.filter(v => v !== null).pop();
    const lastMACD = macdData[macdData.length - 1];
    const prevMACD = macdData[macdData.length - 2];
    const lastBB = bb[bb.length - 1];
    const lastSMA20 = sma20.filter(v => v !== null).pop();
    const lastSMA50 = sma50.filter(v => v !== null).pop();
    const prevSMA20 = sma20.filter(v => v !== null).slice(-2)[0];
    const prevSMA50 = sma50.filter(v => v !== null).slice(-2)[0];

    const signals = [];
    let bull = 0, bear = 0;

    // Trend SMA
    if (lastSMA20 && lastSMA50) {
      if (lastSMA20 > lastSMA50) {
        signals.push('📈 SMA20 > SMA50 → **Uptrend**');
        bull++;
      } else {
        signals.push('📉 SMA20 < SMA50 → **Downtrend**');
        bear++;
      }
      // Golden/Death Cross
      if (prevSMA20 && prevSMA50) {
        if (prevSMA20 <= prevSMA50 && lastSMA20 > lastSMA50) {
          signals.push('✨ **Golden Cross** terbaru! SMA20 baru saja memotong ke atas SMA50 → sinyal beli kuat');
          bull += 2;
        } else if (prevSMA20 >= prevSMA50 && lastSMA20 < lastSMA50) {
          signals.push('💀 **Death Cross** terbaru! SMA20 baru saja memotong ke bawah SMA50 → sinyal jual kuat');
          bear += 2;
        }
      }
      if (last > lastSMA20) { signals.push('✅ Harga di atas SMA20'); bull++; }
      else { signals.push('⚠️ Harga di bawah SMA20'); bear++; }
      if (last > lastSMA50) { signals.push('✅ Harga di atas SMA50'); bull++; }
      else { signals.push('⚠️ Harga di bawah SMA50'); bear++; }
    }

    // RSI
    if (lastRSI !== undefined) {
      const rsiStr = lastRSI.toFixed(1);
      if (lastRSI >= 70) { signals.push(`🔴 RSI ${rsiStr} → **Overbought** (potensi koreksi)`); bear++; }
      else if (lastRSI <= 30) { signals.push(`🟢 RSI ${rsiStr} → **Oversold** (potensi rebound)`); bull++; }
      else if (lastRSI >= 55) { signals.push(`🟡 RSI ${rsiStr} → Agak bullish`); bull += 0.5; }
      else if (lastRSI <= 45) { signals.push(`🟡 RSI ${rsiStr} → Agak bearish`); bear += 0.5; }
      else { signals.push(`🟡 RSI ${rsiStr} → Netral`); }
    }

    // MACD
    if (lastMACD.macd !== null && lastMACD.signal !== null) {
      if (lastMACD.macd > lastMACD.signal) {
        signals.push('🟢 MACD di atas Signal Line → **Bullish momentum**');
        bull++;
        if (prevMACD && prevMACD.macd !== null && prevMACD.macd <= prevMACD.signal) {
          signals.push('⚡ **MACD Bullish Crossover** baru! — sinyal beli');
          bull++;
        }
      } else {
        signals.push('🔴 MACD di bawah Signal Line → **Bearish momentum**');
        bear++;
        if (prevMACD && prevMACD.macd !== null && prevMACD.macd >= prevMACD.signal) {
          signals.push('⚡ **MACD Bearish Crossover** baru! — sinyal jual');
          bear++;
        }
      }
      if (lastMACD.hist !== null) {
        const histStr = lastMACD.hist > 0 ? '+' + lastMACD.hist.toFixed(4) : lastMACD.hist.toFixed(4);
        signals.push(`📊 Histogram MACD: ${histStr}`);
      }
    }

    // Bollinger Bands
    if (lastBB.upper && lastBB.lower && lastBB.mid) {
      const bbWidth = ((lastBB.upper - lastBB.lower) / lastBB.mid * 100).toFixed(1);
      if (last > lastBB.upper) {
        signals.push(`⚡ Harga **di atas BB Upper** (${bbWidth}% width) → Breakout / potensi overbought`);
        bear += 0.5;
      } else if (last < lastBB.lower) {
        signals.push(`⚡ Harga **di bawah BB Lower** (${bbWidth}% width) → Breakdown / potensi oversold`);
        bull += 0.5;
      } else {
        const pctB = ((last - lastBB.lower) / (lastBB.upper - lastBB.lower) * 100).toFixed(0);
        signals.push(`📊 Dalam Bollinger Bands — posisi ${pctB}% dari lower ke upper`);
      }
      if (parseFloat(bbWidth) < 3) signals.push('🔔 BB Squeeze — volatilitas rendah, potensi breakout besar segera');
    }

    // Support & Resistance dari 30 candle terakhir
    const recent = ohlcv.slice(-30);
    const highs = recent.map(c => c.h);
    const lows = recent.map(c => c.l);
    const resistance = Math.max(...highs);
    const support = Math.min(...lows);

    // Sentimen akhir
    let sentiment;
    if (bull > bear + 2) sentiment = '🟢 **BULLISH KUAT**';
    else if (bull > bear) sentiment = '🟡 **BULLISH LEMAH**';
    else if (bear > bull + 2) sentiment = '🔴 **BEARISH KUAT**';
    else if (bear > bull) sentiment = '🟠 **BEARISH LEMAH**';
    else sentiment = '⚖️ **NETRAL**';

    return { signals, sentiment, support, resistance, lastRSI, lastMACD, bullScore: bull, bearScore: bear };
  }

  // ============================================================
  // GENERATE CHART IMAGE via QuickChart.io
  // ============================================================
  async function buildChartImage(pair, ohlcv, sma20, sma50, bb, interval) {
    const n = Math.min(60, ohlcv.length);
    const slice = ohlcv.slice(-n);
    const s20 = sma20.slice(-n);
    const s50 = sma50.slice(-n);
    const bbs = bb.slice(-n);

    function fmtLabel(t) {
      const d = new Date(t);
      const mon = (d.getMonth() + 1).toString().padStart(2, '0');
      const day = d.getDate().toString().padStart(2, '0');
      const hr = d.getHours().toString().padStart(2, '0');
      return interval.includes('d') || interval.includes('w') || interval.includes('M')
        ? `${mon}/${day}`
        : `${mon}/${day} ${hr}h`;
    }

    const candleData = slice.map(c => ({ x: c.t, o: c.o, h: c.h, l: c.l, c: c.c }));
    const labels = slice.map(c => fmtLabel(c.t));

    const chartConfig = {
      type: 'candlestick',
      data: {
        labels,
        datasets: [
          {
            label: pair,
            data: candleData,
            color: { up: '#26a69a', down: '#ef5350', unchanged: '#888888' },
            borderColor: { up: '#26a69a', down: '#ef5350', unchanged: '#888888' },
            yAxisID: 'y',
          },
          {
            type: 'line',
            label: 'SMA20',
            data: s20,
            borderColor: '#4FC3F7',
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            yAxisID: 'y',
          },
          {
            type: 'line',
            label: 'SMA50',
            data: s50,
            borderColor: '#FFD54F',
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            yAxisID: 'y',
          },
          {
            type: 'line',
            label: 'BB Upper',
            data: bbs.map(b => b.upper),
            borderColor: '#CE93D8',
            borderWidth: 1,
            borderDash: [4, 4],
            pointRadius: 0,
            fill: false,
            yAxisID: 'y',
          },
          {
            type: 'line',
            label: 'BB Lower',
            data: bbs.map(b => b.lower),
            borderColor: '#CE93D8',
            borderWidth: 1,
            borderDash: [4, 4],
            pointRadius: 0,
            fill: false,
            yAxisID: 'y',
          },
        ],
      },
      options: {
        plugins: {
          legend: { display: true, labels: { color: '#EEEEEE', font: { size: 11 } } },
          title: { display: true, text: `${pair} — ${interval.toUpperCase()} | TA Chart`, color: '#FFFFFF', font: { size: 14, weight: 'bold' } },
        },
        scales: {
          x: { ticks: { color: '#AAAAAA', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: '#2A2A2A' } },
          y: { ticks: { color: '#AAAAAA', font: { size: 10 } }, grid: { color: '#2A2A2A' } },
        },
      },
    };

    const body = { width: 900, height: 480, backgroundColor: '#161A1E', format: 'png', chart: chartConfig };
    const resp = await axios.post('https://quickchart.io/chart', body, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'Content-Type': 'application/json' },
    });
    return Buffer.from(resp.data);
  }

  // ============================================================
  // FORMAT HARGA
  // ============================================================
  function fmtPrice(v) {
    if (v >= 1000) return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 1) return '$' + v.toFixed(4);
    return '$' + v.toPrecision(5);
  }

  // ============================================================
  // ENTRY POINT — dipanggil dari bot.js
  // ============================================================
  async function handleChartCommand(message, symbol, interval) {
    interval = (interval || '4h').toLowerCase();
    if (!VALID_INTERVALS.includes(interval)) interval = '4h';

    const sym = symbol.toLowerCase();
    const pair = SYMBOL_MAP[sym] || (symbol.toUpperCase() + 'USDT');

    // Cek apakah pair valid di Binance
    let ohlcv;
    try {
      ohlcv = await fetchOHLCV(pair, interval, 120);
    } catch (e) {
      if (e.response && e.response.status === 400) {
        await message.reply(`⚠️ Pasangan **${pair}** tidak ditemukan di Binance. Coba simbol lain.`);
        return;
      }
      throw e;
    }

    if (!ohlcv || ohlcv.length < 30) {
      await message.reply(`⚠️ Data tidak cukup untuk analisis ${pair}.`);
      return;
    }

    const closes = ohlcv.map(c => c.c);
    const sma20 = calcSMA(closes, 20);
    const sma50 = calcSMA(closes, 50);
    const rsi = calcRSI(closes, 14);
    const macdData = calcMACD(closes);
    const bb = calcBB(closes, 20, 2);

    const analysis = analyzeAll(ohlcv, closes, rsi, macdData, sma20, sma50, bb);
    const candlePatterns = detectCandlePatterns(ohlcv);

    // Build chart image
    let chartBuf;
    try {
      chartBuf = await buildChartImage(pair, ohlcv, sma20, sma50, bb, interval);
    } catch (e) {
      console.error('[chart] QuickChart gagal:', e.message);
      chartBuf = null;
    }

    const lastClose = closes[closes.length - 1];
    const lastOpen = ohlcv[ohlcv.length - 1].o;
    const pctChange = ((lastClose - lastOpen) / lastOpen * 100).toFixed(2);
    const changeStr = pctChange >= 0 ? '+' + pctChange + '%' : pctChange + '%';
    const changeEmoji = pctChange >= 0 ? '📈' : '📉';

    // Susun teks analisis
    let text = `**📊 ${pair} | ${interval.toUpperCase()}** ${changeEmoji} ${changeStr}\n`;
    text += `Harga: ${fmtPrice(lastClose)}\n\n`;
    text += `**Sentimen: ${analysis.sentiment}** (Bull ${analysis.bullScore} vs Bear ${analysis.bearScore})\n\n`;
    text += `**🔍 Sinyal Indikator:**\n`;
    text += analysis.signals.map(s => `• ${s}`).join('\n') + '\n';

    if (candlePatterns.length > 0) {
      text += `\n**🕯️ Pola Candlestick:**\n`;
      text += candlePatterns.map(p => `• ${p.label} — ${p.desc}`).join('\n') + '\n';
    } else {
      text += `\n**🕯️ Pola Candlestick:** Tidak ada pola khusus terdeteksi\n`;
    }

    text += `\n**📐 Support & Resistance (30 candle):**\n`;
    text += `• 🛡️ Support: ${fmtPrice(analysis.support)}\n`;
    text += `• 🔺 Resistance: ${fmtPrice(analysis.resistance)}\n`;
    text += `\n_Data: Binance | Chart: QuickChart.io_`;

    // Kirim ke Discord
    const replyOpts = { content: text.slice(0, 2000), flags: 4 }; // flags 4 = SuppressEmbeds
    if (chartBuf) {
      const { AttachmentBuilder } = require('discord.js');
      replyOpts.files = [new AttachmentBuilder(chartBuf, { name: 'chart.png' })];
    }
    await message.reply(replyOpts);
  }

  module.exports = { handleChartCommand, SYMBOL_MAP };
  