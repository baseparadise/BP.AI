'use strict';
const axios = require('axios');

const SYMBOL_MAP = {
  btc:'BTCUSDT',bitcoin:'BTCUSDT',eth:'ETHUSDT',ethereum:'ETHUSDT',
  bnb:'BNBUSDT',sol:'SOLUSDT',solana:'SOLUSDT',xrp:'XRPUSDT',ripple:'XRPUSDT',
  ada:'ADAUSDT',cardano:'ADAUSDT',doge:'DOGEUSDT',dogecoin:'DOGEUSDT',
  avax:'AVAXUSDT',avalanche:'AVAXUSDT',dot:'DOTUSDT',polkadot:'DOTUSDT',
  link:'LINKUSDT',chainlink:'LINKUSDT',ltc:'LTCUSDT',litecoin:'LTCUSDT',
  uni:'UNIUSDT',atom:'ATOMUSDT',cosmos:'ATOMUSDT',near:'NEARUSDT',
  arb:'ARBUSDT',op:'OPUSDT',inj:'INJUSDT',sui:'SUIUSDT',
  ton:'TONUSDT',pepe:'PEPEUSDT',trx:'TRXUSDT',tron:'TRXUSDT',
  xlm:'XLMUSDT',stellar:'XLMUSDT',apt:'APTUSDT',shib:'SHIBUSDT',
  matic:'MATICUSDT',polygon:'MATICUSDT',fil:'FILUSDT',
};
const KRAKEN_MAP = {
  'BTCUSDT':'XBTUSD','ETHUSDT':'ETHUSD','SOLUSDT':'SOLUSD',
  'XRPUSDT':'XRPUSD','ADAUSDT':'ADAUSD','DOGEUSDT':'DOGEUSD',
  'AVAXUSDT':'AVAXUSD','LINKUSDT':'LINKUSD','DOTUSDT':'DOTUSD',
  'LTCUSDT':'LTCUSD','UNIUSDT':'UNIUSD','ATOMUSDT':'ATOMUSD',
  'NEARUSDT':'NEARUSD','ARBUSDT':'ARBUSD','OPUSDT':'OPUSD',
  'INJUSDT':'INJUSD','SUIUSDT':'SUIUSD','TRXUSDT':'TRXUSD',
  'XLMUSDT':'XLMUSD','APTUSDT':'APTUSD','MATICUSDT':'MATICUSD',
  'FILUSDT':'FILUSD','BNBUSDT':'BNBUSD',
};
const KRAKEN_INTERVAL = {
  '1m':1,'5m':5,'15m':15,'30m':30,'1h':60,'2h':60,
  '4h':240,'6h':240,'8h':240,'12h':240,'1d':1440,'3d':1440,'1w':10080,'1M':21600,
};
const VALID_INTERVALS = ['1m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'];

// ─── Data Fetching ──────────────────────────────────────────────────────────

async function fetchBinance(pair, interval, limit) {
  const url = 'https://api.binance.com/api/v3/klines?symbol='+pair+'&interval='+interval+'&limit='+limit;
  const { data } = await axios.get(url, { timeout: 8000 });
  return data.map(k => ({ t:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }));
}
async function fetchKraken(pair, interval, limit) {
  const kPair = KRAKEN_MAP[pair];
  if (!kPair) throw new Error('Pair '+pair+' tidak tersedia di Kraken');
  const kInterval = KRAKEN_INTERVAL[interval] || 240;
  const url = 'https://api.kraken.com/0/public/OHLC?pair='+kPair+'&interval='+kInterval;
  const { data } = await axios.get(url, { timeout: 8000 });
  if (data.error && data.error.length) throw new Error('Kraken: '+data.error[0]);
  const key = Object.keys(data.result).find(k => k !== 'last');
  return data.result[key].slice(-limit).map(k => ({ t:+k[0]*1000, o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[6] }));
}
async function fetchOHLCV(pair, interval, limit) {
  try { return await fetchBinance(pair, interval, limit); }
  catch(e) {
    const s = e.response && e.response.status;
    if (s === 451 || s === 403 || s === 418) {
      console.log('[chart] Binance blokir ('+s+'), fallback ke Kraken...');
      return await fetchKraken(pair, interval, limit);
    }
    throw e;
  }
}

// ─── Indicators ─────────────────────────────────────────────────────────────

function calcSMA(arr, p) {
  return arr.map((_, i) => i < p-1 ? null : arr.slice(i-p+1, i+1).reduce((a,b)=>a+b,0)/p);
}
function calcEMA(arr, p) {
  const k = 2/(p+1); let e = null; const r = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < p-1) { r.push(null); continue; }
    e = e === null ? arr.slice(0,p).reduce((a,b)=>a+b,0)/p : arr[i]*k+e*(1-k);
    r.push(e);
  }
  return r;
}
function calcRSI(closes, p) {
  p = p || 14;
  const out = new Array(p).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i]-closes[i-1]; d>0?ag+=d:al-=d; }
  ag /= p; al /= p;
  out.push(al===0 ? 100 : 100-100/(1+ag/al));
  for (let i = p+1; i < closes.length; i++) {
    const d=closes[i]-closes[i-1], g=d>0?d:0, l=d<0?-d:0;
    ag=(ag*(p-1)+g)/p; al=(al*(p-1)+l)/p;
    out.push(al===0?100:100-100/(1+ag/al));
  }
  return out;
}
function calcBB(closes, p, m) {
  p=p||20; m=m||2;
  return calcSMA(closes,p).map((mid,i) => {
    if(mid===null) return {upper:null,mid:null,lower:null};
    const s=Math.sqrt(closes.slice(i-p+1,i+1).reduce((a,v)=>a+Math.pow(v-mid,2),0)/p);
    return {upper:mid+m*s, mid, lower:mid-m*s};
  });
}
function calcMACD(closes) {
  const e12=calcEMA(closes,12), e26=calcEMA(closes,26);
  const ml=e12.map((v,i)=>v!==null&&e26[i]!==null?v-e26[i]:null);
  const sl=calcEMA(ml.map(v=>v!==null?v:0),9);
  return ml.map((v,i)=>({macd:v,signal:sl[i],hist:v!==null&&sl[i]!==null?v-sl[i]:null}));
}

// ─── Swing Point Detection ───────────────────────────────────────────────────

function detectSwings(ohlcv, win) {
  win = win || 4;
  const highs = [], lows = [];
  for (let i = win; i < ohlcv.length - win; i++) {
    const slice = ohlcv.slice(i-win, i+win+1);
    const maxH = Math.max(...slice.map(c=>c.h));
    const minL = Math.min(...slice.map(c=>c.l));
    if (ohlcv[i].h >= maxH) highs.push({ i, price:ohlcv[i].h, t:ohlcv[i].t });
    if (ohlcv[i].l <= minL) lows.push({ i, price:ohlcv[i].l, t:ohlcv[i].t });
  }
  return { highs, lows };
}

// ─── Support & Resistance ────────────────────────────────────────────────────

function calcSupportResistance(ohlcv) {
  const { highs, lows } = detectSwings(ohlcv, 4);
  function cluster(pts, tol) {
    tol = tol || 0.008;
    const groups = [];
    for (const p of pts) {
      const g = groups.find(g => Math.abs(g.price-p.price)/g.price < tol);
      if (g) { g.count++; g.price=(g.price*(g.count-1)+p.price)/g.count; }
      else groups.push({ price:p.price, count:1 });
    }
    return groups.sort((a,b)=>b.count-a.count);
  }
  const lastClose = ohlcv[ohlcv.length-1].c;
  const resistances = cluster(highs).filter(g=>g.price>lastClose).slice(0,3);
  const supports    = cluster(lows ).filter(g=>g.price<lastClose).slice(0,3);
  return { resistances, supports };
}

// ─── Fibonacci Retracement ───────────────────────────────────────────────────

function calcFibonacci(ohlcv) {
  const look = ohlcv.slice(-80);
  const swHigh = Math.max(...look.map(c=>c.h));
  const swLow  = Math.min(...look.map(c=>c.l));
  const range  = swHigh - swLow;
  const last   = ohlcv[ohlcv.length-1].c;
  // Retrace dari arah yang berlawanan dengan tren
  const isUp   = last > (swHigh+swLow)/2;
  return [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0].map(r => ({
    ratio: r,
    price: isUp ? swHigh - range*r : swLow + range*r,
    label: r===0?'Swing High':r===1?'Swing Low':'Fib '+(r*100).toFixed(1)+'%',
  }));
}

// ─── Candlestick Patterns (simple) ──────────────────────────────────────────

function detectCandlePatterns(ohlcv) {
  const out=[], n=ohlcv.length; if(n<3) return out;
  const body=c=>Math.abs(c.c-c.o), rng=c=>c.h-c.l;
  const isBull=c=>c.c>c.o, isBear=c=>c.c<c.o;
  const uw=c=>c.h-Math.max(c.o,c.c), lw=c=>Math.min(c.o,c.c)-c.l;
  const last=ohlcv[n-1],prev=ohlcv[n-2],prev2=ohlcv[n-3];
  const bd=body(last),r=rng(last);
  if(r>0&&bd/r<0.1)                                     out.push({label:'Doji',emoji:'🔸',desc:'Ketidakpastian — potensi pembalikan'});
  else if(lw(last)>bd*2&&uw(last)<bd*0.5&&isBull(last)) out.push({label:'Hammer',emoji:'🔨',desc:'Pembalikan bullish — tekanan jual melemah'});
  else if(uw(last)>bd*2&&lw(last)<bd*0.5&&isBear(last)) out.push({label:'Shooting Star',emoji:'⭐',desc:'Pembalikan bearish — tekanan beli melemah'});
  else if(isBull(last)&&bd/r>0.85)                      out.push({label:'Marubozu Bullish',emoji:'🟩',desc:'Momentum beli sangat dominan'});
  else if(isBear(last)&&bd/r>0.85)                      out.push({label:'Marubozu Bearish',emoji:'🟥',desc:'Momentum jual sangat dominan'});
  if(isBear(prev)&&isBull(last)&&last.c>prev.o&&last.o<prev.c)   out.push({label:'Bullish Engulfing',emoji:'📗',desc:'Candle hijau menelan merah — reversal naik'});
  else if(isBull(prev)&&isBear(last)&&last.c<prev.o&&last.o>prev.c) out.push({label:'Bearish Engulfing',emoji:'📕',desc:'Candle merah menelan hijau — reversal turun'});
  if(isBear(prev2)&&body(prev)<body(prev2)*0.3&&isBull(last)&&last.c>(prev2.o+prev2.c)/2) out.push({label:'Morning Star',emoji:'🌟',desc:'Reversal bullish 3 candle'});
  else if(isBull(prev2)&&body(prev)<body(prev2)*0.3&&isBear(last)&&last.c<(prev2.o+prev2.c)/2) out.push({label:'Evening Star',emoji:'🌆',desc:'Reversal bearish 3 candle'});
  if(isBull(prev2)&&isBull(prev)&&isBull(last)&&prev.c>prev2.c&&last.c>prev.c) out.push({label:'Three White Soldiers',emoji:'💚',desc:'3 candle hijau kuat — momentum beli sangat kuat'});
  if(isBear(prev2)&&isBear(prev)&&isBear(last)&&prev.c<prev2.c&&last.c<prev.c) out.push({label:'Three Black Crows',emoji:'🖤',desc:'3 candle merah kuat — momentum jual sangat kuat'});
  return out;
}

// ─── Complex Technical Patterns ─────────────────────────────────────────────

function detectComplexPatterns(ohlcv) {
  const patterns = [];
  if (ohlcv.length < 20) return patterns;
  const { highs, lows } = detectSwings(ohlcv, 3);

  // Double Top
  if (highs.length >= 2) {
    const h1=highs[highs.length-2], h2=highs[highs.length-1];
    if (h2.i > h1.i+4) {
      const diff=Math.abs(h1.price-h2.price)/h1.price;
      const trough=Math.min(...ohlcv.slice(h1.i,h2.i).map(c=>c.l));
      const pb=(h1.price-trough)/h1.price;
      if (diff<0.025&&pb>0.03) patterns.push({label:'Double Top',emoji:'🔴⛰️⛰️',desc:'Dua puncak sejajar — sinyal reversal bearish',type:'bearish'});
    }
  }
  // Double Bottom
  if (lows.length >= 2) {
    const l1=lows[lows.length-2], l2=lows[lows.length-1];
    if (l2.i > l1.i+4) {
      const diff=Math.abs(l1.price-l2.price)/l1.price;
      const peak=Math.max(...ohlcv.slice(l1.i,l2.i).map(c=>c.h));
      const rally=(peak-l1.price)/l1.price;
      if (diff<0.025&&rally>0.03) patterns.push({label:'Double Bottom',emoji:'🟢🏔️🏔️',desc:'Dua lembah sejajar — sinyal reversal bullish',type:'bullish'});
    }
  }
  // Head & Shoulders
  if (highs.length >= 3) {
    const [ls,head,rs]=highs.slice(-3);
    if (head.price>ls.price&&head.price>rs.price) {
      const sd=Math.abs(ls.price-rs.price)/ls.price;
      const ha=(head.price-Math.max(ls.price,rs.price))/head.price;
      if (sd<0.04&&ha>0.015) patterns.push({label:'Head & Shoulders',emoji:'🧠',desc:'Kepala lebih tinggi dari bahu — reversal bearish kuat',type:'bearish'});
    }
  }
  // Inverse H&S
  if (lows.length >= 3) {
    const [ls,head,rs]=lows.slice(-3);
    if (head.price<ls.price&&head.price<rs.price) {
      const sd=Math.abs(ls.price-rs.price)/ls.price;
      const hb=(Math.min(ls.price,rs.price)-head.price)/Math.min(ls.price,rs.price);
      if (sd<0.04&&hb>0.015) patterns.push({label:'Inverse H&S',emoji:'🧠',desc:'Kepala lebih rendah dari bahu — reversal bullish kuat',type:'bullish'});
    }
  }
  // Triangle
  if (highs.length >= 2 && lows.length >= 2) {
    const rH=highs.slice(-3), rL=lows.slice(-3);
    if (rH.length>=2&&rL.length>=2) {
      const highTrend=rH[rH.length-1].price-rH[0].price;
      const lowTrend=rL[rL.length-1].price-rL[0].price;
      const base=rH[0].price;
      const tol=base*0.004;
      if (highTrend<-tol&&lowTrend>tol)                     patterns.push({label:'Symmetrical Triangle',emoji:'🔺',desc:'Konvergen — potensi breakout besar',type:'neutral'});
      else if (Math.abs(highTrend)<tol&&lowTrend>tol)       patterns.push({label:'Ascending Triangle',emoji:'📐',desc:'Resistensi flat + support naik — bullish bias',type:'bullish'});
      else if (highTrend<-tol&&Math.abs(lowTrend)<tol)      patterns.push({label:'Descending Triangle',emoji:'📐',desc:'Support flat + resistensi turun — bearish bias',type:'bearish'});
    }
  }
  return patterns;
}

// ─── Analysis ────────────────────────────────────────────────────────────────

function analyzeAll(ohlcv, closes, rsi, macdData, sma20, sma50, bb) {
  const last=closes[closes.length-1];
  const lastRSI=rsi.filter(v=>v!==null).pop();
  const lastMACD=macdData[macdData.length-1], prevMACD=macdData[macdData.length-2];
  const lastBB=bb[bb.length-1];
  const s20v=sma20.filter(v=>v!==null), s50v=sma50.filter(v=>v!==null);
  const lS20=s20v[s20v.length-1], lS50=s50v[s50v.length-1];
  const pS20=s20v[s20v.length-2], pS50=s50v[s50v.length-2];
  const signals=[]; let bull=0, bear=0;
  if(lS20&&lS50){
    if(lS20>lS50){signals.push('📈 SMA20>SMA50 → **Uptrend**');bull++;}
    else{signals.push('📉 SMA20<SMA50 → **Downtrend**');bear++;}
    if(pS20&&pS50){
      if(pS20<=pS50&&lS20>lS50){signals.push('✨ **Golden Cross**! → sinyal beli kuat');bull+=2;}
      else if(pS20>=pS50&&lS20<lS50){signals.push('💀 **Death Cross**! → sinyal jual kuat');bear+=2;}
    }
    if(last>lS20){signals.push('✅ Harga di atas SMA20');bull++;}else{signals.push('⚠️ Harga di bawah SMA20');bear++;}
    if(last>lS50){signals.push('✅ Harga di atas SMA50');bull++;}else{signals.push('⚠️ Harga di bawah SMA50');bear++;}
  }
  if(lastRSI!==undefined){
    const rs=lastRSI.toFixed(1);
    if(lastRSI>=70){signals.push('🔴 RSI '+rs+' → **Overbought**');bear++;}
    else if(lastRSI<=30){signals.push('🟢 RSI '+rs+' → **Oversold**');bull++;}
    else if(lastRSI>=55){signals.push('🟡 RSI '+rs+' → Agak bullish');bull+=0.5;}
    else if(lastRSI<=45){signals.push('🟡 RSI '+rs+' → Agak bearish');bear+=0.5;}
    else signals.push('🟡 RSI '+rs+' → Netral');
  }
  if(lastMACD&&lastMACD.macd!==null&&lastMACD.signal!==null){
    if(lastMACD.macd>lastMACD.signal){
      signals.push('🟢 MACD → **Bullish momentum**');bull++;
      if(prevMACD&&prevMACD.macd!==null&&prevMACD.macd<=prevMACD.signal){signals.push('⚡ **MACD Bullish Crossover**!');bull++;}
    }else{
      signals.push('🔴 MACD → **Bearish momentum**');bear++;
      if(prevMACD&&prevMACD.macd!==null&&prevMACD.macd>=prevMACD.signal){signals.push('⚡ **MACD Bearish Crossover**!');bear++;}
    }
  }
  if(lastBB&&lastBB.upper&&lastBB.lower&&lastBB.mid){
    const w=((lastBB.upper-lastBB.lower)/lastBB.mid*100).toFixed(1);
    if(last>lastBB.upper){signals.push('⚡ Breakout BB Upper ('+w+'%)');bear+=0.5;}
    else if(last<lastBB.lower){signals.push('⚡ Breakdown BB Lower ('+w+'%)');bull+=0.5;}
    else signals.push('📊 Dalam BB — posisi '+((last-lastBB.lower)/(lastBB.upper-lastBB.lower)*100).toFixed(0)+'% dari lower ke upper');
    if(parseFloat(w)<3) signals.push('🔔 BB Squeeze — potensi breakout besar');
  }
  const recent=ohlcv.slice(-30);
  const resistance=Math.max(...recent.map(c=>c.h));
  const support=Math.min(...recent.map(c=>c.l));
  let sentiment;
  if(bull>bear+2) sentiment='🟢 **BULLISH KUAT**';
  else if(bull>bear) sentiment='🟡 **BULLISH LEMAH**';
  else if(bear>bull+2) sentiment='🔴 **BEARISH KUAT**';
  else if(bear>bull) sentiment='🟠 **BEARISH LEMAH**';
  else sentiment='⚖️ **NETRAL**';
  return {signals,sentiment,support,resistance,lastRSI,lastMACD,bullScore:bull,bearScore:bear};
}

// ─── QuickChart Helper ───────────────────────────────────────────────────────

async function qcPost(cfg, width, height) {
  const body = { version:4, width, height, backgroundColor:'#161A1E', format:'png', chart:cfg };
  try {
    const resp = await axios.post('https://api.quickchart.io/chart', body, {
      responseType:'arraybuffer', timeout:20000,
      headers:{'Content-Type':'application/json'},
    });
    return Buffer.from(resp.data);
  } catch(e) {
    if (e.response&&e.response.data) {
      const errH=e.response.headers&&e.response.headers['x-quickchart-error'];
      const errB=Buffer.isBuffer(e.response.data)?e.response.data.toString('utf8'):String(e.response.data);
      console.error('[chart] QuickChart error ('+e.response.status+'):', errH||errB.slice(0,200));
    }
    throw e;
  }
}

// ─── Main Candlestick Chart ──────────────────────────────────────────────────

async function buildMainChart(pair, ohlcv, sma20, sma50, bb, interval, candlePatterns, complexPatterns) {
  const n = Math.min(60, ohlcv.length);
  const sl=ohlcv.slice(-n), s20=sma20.slice(-n), s50=sma50.slice(-n), bbs=bb.slice(-n);

  const allPat=[...(complexPatterns||[]),...(candlePatterns||[])];
  const patStr=allPat.length>0?' | '+allPat.slice(0,2).map(p=>p.emoji+p.label).join(', '):'';

  // Support/Resistance annotations
  const { resistances, supports } = calcSupportResistance(ohlcv);
  // Fibonacci annotations
  const fibs = calcFibonacci(ohlcv);

  const annotations = {};
  resistances.forEach((r,i) => {
    annotations['r'+i]={
      type:'line',yMin:r.price,yMax:r.price,
      borderColor:'rgba(239,83,80,0.75)',borderWidth:1.5,borderDash:[5,4],
      label:{display:true,content:'R $'+fmtShort(r.price),position:'end',
        color:'rgba(239,83,80,0.9)',backgroundColor:'rgba(0,0,0,0.55)',font:{size:9}},
    };
  });
  supports.forEach((s,i) => {
    annotations['s'+i]={
      type:'line',yMin:s.price,yMax:s.price,
      borderColor:'rgba(38,166,154,0.75)',borderWidth:1.5,borderDash:[5,4],
      label:{display:true,content:'S $'+fmtShort(s.price),position:'end',
        color:'rgba(38,166,154,0.9)',backgroundColor:'rgba(0,0,0,0.55)',font:{size:9}},
    };
  });
  // Fibonacci: show only 38.2, 50, 61.8 to avoid clutter
  fibs.filter(f=>[0.382,0.5,0.618].includes(f.ratio)).forEach((f,i) => {
    annotations['fib'+i]={
      type:'line',yMin:f.price,yMax:f.price,
      borderColor:'rgba(255,213,79,0.55)',borderWidth:1,borderDash:[3,5],
      label:{display:true,content:f.label+' $'+fmtShort(f.price),position:'start',
        color:'rgba(255,213,79,0.8)',backgroundColor:'rgba(0,0,0,0.4)',font:{size:8}},
    };
  });

  const cfg = {
    type:'candlestick',
    data:{
      datasets:[
        { label:pair, data:sl.map(c=>({x:c.t,o:c.o,h:c.h,l:c.l,c:c.c})),
          color:{up:'rgba(38,166,154,1)',down:'rgba(239,83,80,1)',unchanged:'#888'},
          borderColor:{up:'rgba(38,166,154,1)',down:'rgba(239,83,80,1)',unchanged:'#888'} },
        { type:'line',label:'SMA20',data:sl.map((c,i)=>({x:c.t,y:s20[i]})),
          borderColor:'#4FC3F7',borderWidth:1.5,pointRadius:0,fill:false },
        { type:'line',label:'SMA50',data:sl.map((c,i)=>({x:c.t,y:s50[i]})),
          borderColor:'#FFD54F',borderWidth:1.5,pointRadius:0,fill:false },
        { type:'line',label:'BB Upper',data:sl.map((c,i)=>({x:c.t,y:bbs[i].upper})),
          borderColor:'rgba(206,147,216,0.6)',borderWidth:1,pointRadius:0,fill:false },
        { type:'line',label:'BB Lower',data:sl.map((c,i)=>({x:c.t,y:bbs[i].lower})),
          borderColor:'rgba(206,147,216,0.6)',borderWidth:1,pointRadius:0,fill:false },
      ],
    },
    options:{
      plugins:{
        legend:{display:true,labels:{color:'#CCC',font:{size:10}}},
        title:{display:true,text:pair+' | '+interval.toUpperCase()+' — Candlestick / SMA20 / SMA50 / BB'+patStr,
          color:'#EEE',font:{size:13,weight:'bold'}},
        annotation:{annotations},
      },
      scales:{
        x:{type:'timeseries',ticks:{color:'#888',maxTicksLimit:10,font:{size:9}},grid:{color:'#2A2A2A'}},
        y:{ticks:{color:'#888',font:{size:9}},grid:{color:'#2A2A2A'}},
      },
    },
  };
  return qcPost(cfg, 900, 500);
}

// ─── RSI Chart ───────────────────────────────────────────────────────────────

async function buildRSIChart(ohlcv, rsi, interval) {
  const n = Math.min(60, ohlcv.length);
  const sl = ohlcv.slice(-n);
  const rsiSl = rsi.slice(-n);
  const lastRSI = rsiSl.filter(v=>v!==null).pop();
  const rsiColor = lastRSI>=70?'rgba(239,83,80,0.9)':lastRSI<=30?'rgba(38,166,154,0.9)':'rgba(206,147,216,0.9)';

  const cfg = {
    type:'line',
    data:{
      datasets:[{
        label:'RSI(14)',
        data:sl.map((c,i)=>({x:c.t,y:rsiSl[i]})),
        borderColor:rsiColor,borderWidth:1.8,pointRadius:0,fill:false,
      }],
    },
    options:{
      plugins:{
        legend:{display:false},
        title:{display:true,
          text:'RSI(14) = '+lastRSI.toFixed(1)+(lastRSI>=70?' ⚠️ OVERBOUGHT':lastRSI<=30?' ⚠️ OVERSOLD':''),
          color:'#EEE',font:{size:12,weight:'bold'}},
        annotation:{annotations:{
          ob:{type:'line',yMin:70,yMax:70,borderColor:'rgba(239,83,80,0.5)',borderWidth:1,borderDash:[5,4],
            label:{display:true,content:'Overbought 70',position:'end',color:'rgba(239,83,80,0.8)',backgroundColor:'rgba(0,0,0,0.4)',font:{size:9}}},
          mid:{type:'line',yMin:50,yMax:50,borderColor:'rgba(255,255,255,0.15)',borderWidth:1},
          os:{type:'line',yMin:30,yMax:30,borderColor:'rgba(38,166,154,0.5)',borderWidth:1,borderDash:[5,4],
            label:{display:true,content:'Oversold 30',position:'end',color:'rgba(38,166,154,0.8)',backgroundColor:'rgba(0,0,0,0.4)',font:{size:9}}},
          obBox:{type:'box',yMin:70,yMax:100,backgroundColor:'rgba(239,83,80,0.07)',borderWidth:0},
          osBox:{type:'box',yMin:0,yMax:30,backgroundColor:'rgba(38,166,154,0.07)',borderWidth:0},
        }},
      },
      scales:{
        x:{type:'timeseries',ticks:{color:'#888',maxTicksLimit:8,font:{size:8}},grid:{color:'#2A2A2A'}},
        y:{min:0,max:100,ticks:{color:'#888',font:{size:8},stepSize:10},grid:{color:'#2A2A2A'}},
      },
    },
  };
  return qcPost(cfg, 900, 220);
}

// ─── MACD Chart ──────────────────────────────────────────────────────────────

async function buildMACDChart(ohlcv, macdData, interval) {
  const n = Math.min(60, ohlcv.length);
  const sl = ohlcv.slice(-n);
  const md = macdData.slice(-n);
  const lastM = md[md.length-1];
  const isBull = lastM&&lastM.macd!==null&&lastM.signal!==null&&lastM.macd>lastM.signal;
  const titleColor = isBull?'rgba(38,166,154,0.9)':'rgba(239,83,80,0.9)';

  const cfg = {
    type:'bar',
    data:{
      datasets:[
        { type:'bar',label:'Histogram',
          data:sl.map((c,i)=>({x:c.t,y:md[i]&&md[i].hist!==null?md[i].hist:null})),
          backgroundColor:md.map(m=>m&&m.hist!==null?(m.hist>=0?'rgba(38,166,154,0.55)':'rgba(239,83,80,0.55)'):'transparent') },
        { type:'line',label:'MACD',
          data:sl.map((c,i)=>({x:c.t,y:md[i]&&md[i].macd!==null?md[i].macd:null})),
          borderColor:'#4FC3F7',borderWidth:1.5,pointRadius:0,fill:false },
        { type:'line',label:'Signal',
          data:sl.map((c,i)=>({x:c.t,y:md[i]&&md[i].signal!==null?md[i].signal:null})),
          borderColor:'#FFD54F',borderWidth:1.5,pointRadius:0,fill:false },
      ],
    },
    options:{
      plugins:{
        legend:{display:true,labels:{color:'#CCC',font:{size:9}}},
        title:{display:true,
          text:'MACD(12,26,9) — '+(isBull?'Bullish Momentum ▲':'Bearish Momentum ▼'),
          color:titleColor,font:{size:12,weight:'bold'}},
        annotation:{annotations:{
          zero:{type:'line',yMin:0,yMax:0,borderColor:'rgba(255,255,255,0.2)',borderWidth:1},
        }},
      },
      scales:{
        x:{type:'timeseries',ticks:{color:'#888',maxTicksLimit:8,font:{size:8}},grid:{color:'#2A2A2A'}},
        y:{ticks:{color:'#888',font:{size:8}},grid:{color:'#2A2A2A'}},
      },
    },
  };
  return qcPost(cfg, 900, 200);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtShort(v) {
  if(v>=1000) return v.toLocaleString('en-US',{maximumFractionDigits:0});
  if(v>=1)    return v.toFixed(2);
  return v.toPrecision(4);
}
function fmtPrice(v) {
  if(v>=1000) return '$'+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  if(v>=1)    return '$'+v.toFixed(4);
  return '$'+v.toPrecision(5);
}

// ─── Main Handler ────────────────────────────────────────────────────────────

async function handleChartCommand(message, symbol, interval) {
  try {
    interval=(interval||'4h').toLowerCase();
    if(!VALID_INTERVALS.includes(interval)) interval='4h';
    const pair=SYMBOL_MAP[symbol.toLowerCase()]||(symbol.toUpperCase()+'USDT');

    let ohlcv;
    try {
      ohlcv=await fetchOHLCV(pair, interval, 120);
    } catch(e) {
      const s=e.response&&e.response.status;
      await message.reply(
        (s===400||(e.message&&e.message.includes('tidak tersedia')))
          ?'⚠️ Pasangan **'+pair+'** tidak ditemukan. Coba: btc, eth, sol, dll.'
          :'⚠️ Gagal ambil data **'+pair+'**: '+e.message
      ).catch(()=>{});
      return;
    }
    if(!ohlcv||ohlcv.length<30){
      await message.reply('⚠️ Data tidak cukup untuk **'+pair+'**.').catch(()=>{});
      return;
    }

    const closes=ohlcv.map(c=>c.c);
    const sma20=calcSMA(closes,20), sma50=calcSMA(closes,50);
    const rsi=calcRSI(closes,14), macdData=calcMACD(closes), bb=calcBB(closes,20,2);
    const analysis=analyzeAll(ohlcv,closes,rsi,macdData,sma20,sma50,bb);
    const candlePatterns=detectCandlePatterns(ohlcv);
    const complexPatterns=detectComplexPatterns(ohlcv);
    const { resistances, supports }=calcSupportResistance(ohlcv);
    const fibs=calcFibonacci(ohlcv);

    const lastClose=closes[closes.length-1], lastOpen=ohlcv[ohlcv.length-1].o;
    const pct=((lastClose-lastOpen)/lastOpen*100).toFixed(2);
    const chgStr=(pct>=0?'+':'')+pct+'%', chgEmoji=pct>=0?'📈':'📉';

    let text='**📊 '+pair+' | '+interval.toUpperCase()+'** '+chgEmoji+' '+chgStr+'\n';
    text+='Harga: **'+fmtPrice(lastClose)+'**\n\n';
    text+='Sentimen: '+analysis.sentiment+' _(Bull '+analysis.bullScore+' vs Bear '+analysis.bearScore+')_\n\n';

    if(complexPatterns.length>0){
      text+='**🔬 Pola Teknikal Kompleks:**\n';
      text+=complexPatterns.map(p=>'• '+p.emoji+' **'+p.label+'** — '+p.desc).join('\n')+'\n\n';
    }
    if(candlePatterns.length>0){
      text+='**🕯️ Pola Candlestick:**\n';
      text+=candlePatterns.map(p=>'• '+p.emoji+' '+p.label+' — '+p.desc).join('\n')+'\n\n';
    }

    text+='**🔍 Sinyal Indikator:**\n';
    text+=analysis.signals.map(s=>'• '+s).join('\n')+'\n\n';

    // S&R levels
    if(resistances.length||supports.length){
      text+='**📐 Support & Resistance:**\n';
      resistances.forEach(r=>{ text+='• 🔺 R: **'+fmtPrice(r.price)+'**\n'; });
      supports.forEach(s=>{ text+='• 🛡️ S: **'+fmtPrice(s.price)+'**\n'; });
      text+='\n';
    }

    // Fibonacci
    const keyFibs=fibs.filter(f=>[0.382,0.5,0.618].includes(f.ratio));
    if(keyFibs.length){
      text+='**🌀 Fibonacci Retracement:**\n';
      keyFibs.forEach(f=>{ text+='• '+f.label+': **'+fmtPrice(f.price)+'**\n'; });
    }

    text+='\n_Data: Binance/Kraken_';

    // Generate all 3 charts in parallel
    const { AttachmentBuilder, MessageFlags }=require('discord.js');
    let files=[];
    try {
      const [mainBuf, rsiBuf, macdBuf]=await Promise.all([
        buildMainChart(pair,ohlcv,sma20,sma50,bb,interval,candlePatterns,complexPatterns),
        buildRSIChart(ohlcv,rsi,interval),
        buildMACDChart(ohlcv,macdData,interval),
      ]);
      files=[
        new AttachmentBuilder(mainBuf,{name:'chart_main.png'}),
        new AttachmentBuilder(rsiBuf, {name:'chart_rsi.png'}),
        new AttachmentBuilder(macdBuf,{name:'chart_macd.png'}),
      ];
    } catch(e) {
      console.error('[chart] buildChart gagal ('+(e.response&&e.response.status||e.message)+')');
      text+='\n_📎 https://www.tradingview.com/chart/?symbol=BINANCE:'+pair+'_';
    }

    const opts={content:text.slice(0,2000),flags:MessageFlags.SuppressEmbeds};
    if(files.length) opts.files=files;
    await message.reply(opts).catch(async()=>{
      await message.channel.send({content:text.slice(0,2000)}).catch(()=>{});
    });

  } catch(e) {
    console.error('[chart] unexpected:', e.message);
    await message.reply('⚠️ Error: '+e.message).catch(()=>{});
  }
}

module.exports = { handleChartCommand, SYMBOL_MAP };
