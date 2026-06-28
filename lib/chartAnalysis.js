'use strict';
const axios = require('axios');

const SYMBOL_MAP = {
  btc:'BTCUSDT',bitcoin:'BTCUSDT',eth:'ETHUSDT',ethereum:'ETHUSDT',
  bnb:'BNBUSDT',sol:'SOLUSDT',solana:'SOLUSDT',xrp:'XRPUSDT',
  ada:'ADAUSDT',doge:'DOGEUSDT',avax:'AVAXUSDT',dot:'DOTUSDT',
  link:'LINKUSDT',ltc:'LTCUSDT',uni:'UNIUSDT',atom:'ATOMUSDT',
  near:'NEARUSDT',arb:'ARBUSDT',op:'OPUSDT',inj:'INJUSDT',
  sui:'SUIUSDT',ton:'TONUSDT',pepe:'PEPEUSDT',trx:'TRXUSDT',
  xlm:'XLMUSDT',apt:'APTUSDT',shib:'SHIBUSDT',matic:'MATICUSDT',
  fil:'FILUSDT',polygon:'MATICUSDT',ripple:'XRPUSDT',cardano:'ADAUSDT',
};
const VALID_INTERVALS=['1m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'];

async function fetchOHLCV(pair,interval,limit){
  const url='https://api.binance.com/api/v3/klines?symbol='+pair+'&interval='+interval+'&limit='+limit;
  const {data}=await axios.get(url,{timeout:10000});
  return data.map(k=>({t:k[0],o:parseFloat(k[1]),h:parseFloat(k[2]),l:parseFloat(k[3]),c:parseFloat(k[4]),v:parseFloat(k[5])}));
}

function calcSMA(arr,period){
  return arr.map((_,i)=>{
    if(i<period-1)return null;
    return arr.slice(i-period+1,i+1).reduce((a,b)=>a+b,0)/period;
  });
}
function calcEMA(arr,period){
  const k=2/(period+1);
  const result=[];let ema=null;
  for(let i=0;i<arr.length;i++){
    if(i<period-1){result.push(null);continue;}
    if(ema===null)ema=arr.slice(0,period).reduce((a,b)=>a+b,0)/period;
    else ema=arr[i]*k+ema*(1-k);
    result.push(ema);
  }
  return result;
}
function calcRSI(closes,period){
  period=period||14;
  const result=new Array(period).fill(null);
  let ag=0,al=0;
  for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];if(d>0)ag+=d;else al-=d;}
  ag/=period;al/=period;
  result.push(al===0?100:100-100/(1+ag/al));
  for(let i=period+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    const g=d>0?d:0,l=d<0?-d:0;
    ag=(ag*(period-1)+g)/period;al=(al*(period-1)+l)/period;
    result.push(al===0?100:100-100/(1+ag/al));
  }
  return result;
}
function calcBB(closes,period,mult){
  period=period||20;mult=mult||2;
  const sma=calcSMA(closes,period);
  return sma.map((m,i)=>{
    if(m===null)return{upper:null,mid:null,lower:null};
    const slice=closes.slice(i-period+1,i+1);
    const std=Math.sqrt(slice.reduce((a,v)=>a+Math.pow(v-m,2),0)/period);
    return{upper:m+mult*std,mid:m,lower:m-mult*std};
  });
}
function calcMACD(closes){
  const e12=calcEMA(closes,12),e26=calcEMA(closes,26);
  const ml=e12.map((v,i)=>(v!==null&&e26[i]!==null)?v-e26[i]:null);
  const vm=ml.map(v=>v!==null?v:0);
  const sl=calcEMA(vm,9);
  return ml.map((v,i)=>({macd:v,signal:sl[i],hist:(v!==null&&sl[i]!==null)?v-sl[i]:null}));
}

function detectPatterns(ohlcv){
  const patterns=[];const n=ohlcv.length;
  if(n<3)return patterns;
  const body=c=>Math.abs(c.c-c.o),range=c=>c.h-c.l;
  const isBull=c=>c.c>c.o,isBear=c=>c.c<c.o;
  const uw=c=>c.h-Math.max(c.o,c.c),lw=c=>Math.min(c.o,c.c)-c.l;
  const last=ohlcv[n-1],prev=ohlcv[n-2],prev2=ohlcv[n-3];
  const bd=body(last),rng=range(last),uwl=uw(last),lwl=lw(last);
  if(rng>0&&bd/rng<0.1)patterns.push({label:'🔸 Doji',desc:'Ketidakpastian — potensi pembalikan arah',bias:'neutral'});
  else if(lwl>bd*2&&uwl<bd*0.5&&isBull(last))patterns.push({label:'🔨 Hammer',desc:'Pembalikan bullish — tekanan jual melemah',bias:'bullish'});
  else if(uwl>bd*2&&lwl<bd*0.5&&isBear(last))patterns.push({label:'⭐ Shooting Star',desc:'Pembalikan bearish — tekanan beli melemah',bias:'bearish'});
  else if(isBull(last)&&bd/rng>0.85)patterns.push({label:'🟩 Marubozu Bullish',desc:'Momentum beli sangat dominan',bias:'bullish'});
  else if(isBear(last)&&bd/rng>0.85)patterns.push({label:'🟥 Marubozu Bearish',desc:'Momentum jual sangat dominan',bias:'bearish'});
  if(isBear(prev)&&isBull(last)&&last.c>prev.o&&last.o<prev.c)patterns.push({label:'📗 Bullish Engulfing',desc:'Candle hijau menelan candle merah — reversal naik',bias:'bullish'});
  else if(isBull(prev)&&isBear(last)&&last.c<prev.o&&last.o>prev.c)patterns.push({label:'📕 Bearish Engulfing',desc:'Candle merah menelan candle hijau — reversal turun',bias:'bearish'});
  if(isBear(prev2)&&body(prev)<body(prev2)*0.3&&isBull(last)&&last.c>(prev2.o+prev2.c)/2)patterns.push({label:'🌟 Morning Star',desc:'Reversal bullish 3 candle — sinyal kuat naik',bias:'bullish'});
  else if(isBull(prev2)&&body(prev)<body(prev2)*0.3&&isBear(last)&&last.c<(prev2.o+prev2.c)/2)patterns.push({label:'🌆 Evening Star',desc:'Reversal bearish 3 candle — sinyal kuat turun',bias:'bearish'});
  if(isBull(prev2)&&isBull(prev)&&isBull(last)&&prev.c>prev2.c&&last.c>prev.c&&body(last)>range(last)*0.5)patterns.push({label:'💚 Three White Soldiers',desc:'3 candle hijau kuat berturut — momentum beli sangat kuat',bias:'bullish'});
  if(isBear(prev2)&&isBear(prev)&&isBear(last)&&prev.c<prev2.c&&last.c<prev.c&&body(last)>range(last)*0.5)patterns.push({label:'🖤 Three Black Crows',desc:'3 candle merah kuat berturut — momentum jual sangat kuat',bias:'bearish'});
  return patterns;
}

function analyzeAll(ohlcv,closes,rsi,macdData,sma20,sma50,bb){
  const last=closes[closes.length-1];
  const lastRSI=rsi.filter(v=>v!==null).pop();
  const lastMACD=macdData[macdData.length-1];
  const prevMACD=macdData[macdData.length-2];
  const lastBB=bb[bb.length-1];
  const sma20v=sma20.filter(v=>v!==null);
  const sma50v=sma50.filter(v=>v!==null);
  const lastSMA20=sma20v[sma20v.length-1],lastSMA50=sma50v[sma50v.length-1];
  const prevSMA20=sma20v[sma20v.length-2],prevSMA50=sma50v[sma50v.length-2];
  const signals=[];let bull=0,bear=0;
  if(lastSMA20&&lastSMA50){
    if(lastSMA20>lastSMA50){signals.push('📈 SMA20 > SMA50 → **Uptrend**');bull++;}
    else{signals.push('📉 SMA20 < SMA50 → **Downtrend**');bear++;}
    if(prevSMA20&&prevSMA50){
      if(prevSMA20<=prevSMA50&&lastSMA20>lastSMA50){signals.push('✨ **Golden Cross** terbaru! → sinyal beli kuat');bull+=2;}
      else if(prevSMA20>=prevSMA50&&lastSMA20<lastSMA50){signals.push('💀 **Death Cross** terbaru! → sinyal jual kuat');bear+=2;}
    }
    if(last>lastSMA20){signals.push('✅ Harga di atas SMA20');bull++;}else{signals.push('⚠️ Harga di bawah SMA20');bear++;}
    if(last>lastSMA50){signals.push('✅ Harga di atas SMA50');bull++;}else{signals.push('⚠️ Harga di bawah SMA50');bear++;}
  }
  if(lastRSI!==undefined){
    const rs=lastRSI.toFixed(1);
    if(lastRSI>=70){signals.push('🔴 RSI '+rs+' → **Overbought** (potensi koreksi)');bear++;}
    else if(lastRSI<=30){signals.push('🟢 RSI '+rs+' → **Oversold** (potensi rebound)');bull++;}
    else if(lastRSI>=55){signals.push('🟡 RSI '+rs+' → Agak bullish');bull+=0.5;}
    else if(lastRSI<=45){signals.push('🟡 RSI '+rs+' → Agak bearish');bear+=0.5;}
    else signals.push('🟡 RSI '+rs+' → Netral');
  }
  if(lastMACD.macd!==null&&lastMACD.signal!==null){
    if(lastMACD.macd>lastMACD.signal){
      signals.push('🟢 MACD di atas Signal → **Bullish momentum**');bull++;
      if(prevMACD&&prevMACD.macd!==null&&prevMACD.macd<=prevMACD.signal){signals.push('⚡ **MACD Bullish Crossover** baru!');bull++;}
    }else{
      signals.push('🔴 MACD di bawah Signal → **Bearish momentum**');bear++;
      if(prevMACD&&prevMACD.macd!==null&&prevMACD.macd>=prevMACD.signal){signals.push('⚡ **MACD Bearish Crossover** baru!');bear++;}
    }
  }
  if(lastBB.upper&&lastBB.lower&&lastBB.mid){
    const w=((lastBB.upper-lastBB.lower)/lastBB.mid*100).toFixed(1);
    if(last>lastBB.upper){signals.push('⚡ Di atas BB Upper ('+w+'% width) → Breakout');bear+=0.5;}
    else if(last<lastBB.lower){signals.push('⚡ Di bawah BB Lower ('+w+'% width) → Breakdown');bull+=0.5;}
    else{const p=((last-lastBB.lower)/(lastBB.upper-lastBB.lower)*100).toFixed(0);signals.push('📊 Dalam BB — posisi '+p+'% dari lower ke upper');}
    if(parseFloat(w)<3)signals.push('🔔 BB Squeeze — volatilitas rendah, potensi breakout besar');
  }
  const recent=ohlcv.slice(-30);
  const resistance=Math.max(...recent.map(c=>c.h));
  const support=Math.min(...recent.map(c=>c.l));
  let sentiment;
  if(bull>bear+2)sentiment='🟢 **BULLISH KUAT**';
  else if(bull>bear)sentiment='🟡 **BULLISH LEMAH**';
  else if(bear>bull+2)sentiment='🔴 **BEARISH KUAT**';
  else if(bear>bull)sentiment='🟠 **BEARISH LEMAH**';
  else sentiment='⚖️ **NETRAL**';
  return{signals,sentiment,support,resistance,lastRSI,lastMACD,bullScore:bull,bearScore:bear};
}

async function buildChart(pair,ohlcv,sma20,sma50,bb,interval){
  const n=Math.min(60,ohlcv.length);
  const sl=ohlcv.slice(-n),s20=sma20.slice(-n),s50=sma50.slice(-n),bbs=bb.slice(-n);
  function fmtL(t){
    const d=new Date(t);
    const m=(d.getMonth()+1).toString().padStart(2,'0'),dy=d.getDate().toString().padStart(2,'0'),h=d.getHours().toString().padStart(2,'0');
    return(interval.includes('d')||interval.includes('w')||interval==='1M')?m+'/'+dy:m+'/'+dy+' '+h+'h';
  }
  const cfg={
    type:'candlestick',
    data:{
      labels:sl.map(c=>fmtL(c.t)),
      datasets:[
        {label:pair,data:sl.map(c=>({x:c.t,o:c.o,h:c.h,l:c.l,c:c.c})),color:{up:'#26a69a',down:'#ef5350',unchanged:'#888'},borderColor:{up:'#26a69a',down:'#ef5350',unchanged:'#888'},yAxisID:'y'},
        {type:'line',label:'SMA20',data:s20,borderColor:'#4FC3F7',borderWidth:1.5,pointRadius:0,fill:false,yAxisID:'y'},
        {type:'line',label:'SMA50',data:s50,borderColor:'#FFD54F',borderWidth:1.5,pointRadius:0,fill:false,yAxisID:'y'},
        {type:'line',label:'BB Upper',data:bbs.map(b=>b.upper),borderColor:'#CE93D8',borderWidth:1,borderDash:[4,4],pointRadius:0,fill:false,yAxisID:'y'},
        {type:'line',label:'BB Lower',data:bbs.map(b=>b.lower),borderColor:'#CE93D8',borderWidth:1,borderDash:[4,4],pointRadius:0,fill:false,yAxisID:'y'},
      ],
    },
    options:{
      plugins:{
        legend:{display:true,labels:{color:'#EEE',font:{size:11}}},
        title:{display:true,text:pair+' — '+interval.toUpperCase()+' | TA Chart',color:'#FFF',font:{size:14,weight:'bold'}},
      },
      scales:{
        x:{ticks:{color:'#AAA',maxTicksLimit:10,font:{size:10}},grid:{color:'#2A2A2A'}},
        y:{ticks:{color:'#AAA',font:{size:10}},grid:{color:'#2A2A2A'}},
      },
    },
  };
  const body={width:900,height:480,backgroundColor:'#161A1E',format:'png',chart:cfg};
  const resp=await axios.post('https://quickchart.io/chart',body,{responseType:'arraybuffer',timeout:20000,headers:{'Content-Type':'application/json'}});
  return Buffer.from(resp.data);
}

function fmtPrice(v){
  if(v>=1000)return '$'+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  if(v>=1)return '$'+v.toFixed(4);
  return '$'+v.toPrecision(5);
}

async function handleChartCommand(message,symbol,interval){
  interval=(interval||'4h').toLowerCase();
  if(!VALID_INTERVALS.includes(interval))interval='4h';
  const sym=symbol.toLowerCase();
  const pair=SYMBOL_MAP[sym]||(symbol.toUpperCase()+'USDT');
  let ohlcv;
  try{ohlcv=await fetchOHLCV(pair,interval,120);}
  catch(e){
    if(e.response&&e.response.status===400){await message.reply('⚠️ Pasangan **'+pair+'** tidak ditemukan di Binance. Coba simbol lain.');return;}
    throw e;
  }
  if(!ohlcv||ohlcv.length<30){await message.reply('⚠️ Data tidak cukup untuk analisis '+pair+'.');return;}
  const closes=ohlcv.map(c=>c.c);
  const sma20=calcSMA(closes,20),sma50=calcSMA(closes,50);
  const rsi=calcRSI(closes,14),macdData=calcMACD(closes),bb=calcBB(closes,20,2);
  const analysis=analyzeAll(ohlcv,closes,rsi,macdData,sma20,sma50,bb);
  const candlePatterns=detectPatterns(ohlcv);
  let chartBuf=null;
  try{chartBuf=await buildChart(pair,ohlcv,sma20,sma50,bb,interval);}
  catch(e){console.error('[chart] QuickChart gagal:',e.message);}
  const lastClose=closes[closes.length-1],lastOpen=ohlcv[ohlcv.length-1].o;
  const pct=((lastClose-lastOpen)/lastOpen*100).toFixed(2);
  const chgStr=(pct>=0?'+':'')+pct+'%';
  const chgEmoji=pct>=0?'📈':'📉';
  let text='**📊 '+pair+' | '+interval.toUpperCase()+'** '+chgEmoji+' '+chgStr+'\n';
  text+='Harga: '+fmtPrice(lastClose)+'\n\n';
  text+='**Sentimen: '+analysis.sentiment+'** (Bull '+analysis.bullScore+' vs Bear '+analysis.bearScore+')\n\n';
  text+='**🔍 Sinyal Indikator:**\n';
  text+=analysis.signals.map(s=>'• '+s).join('\n')+'\n';
  if(candlePatterns.length>0){
    text+='\n**🕯️ Pola Candlestick:**\n';
    text+=candlePatterns.map(p=>'• '+p.label+' — '+p.desc).join('\n')+'\n';
  }else{
    text+='\n**🕯️ Pola Candlestick:** Tidak ada pola khusus terdeteksi\n';
  }
  text+='\n**📐 Support & Resistance (30 candle terakhir):**\n';
  text+='• 🛡️ Support: '+fmtPrice(analysis.support)+'\n';
  text+='• 🔺 Resistance: '+fmtPrice(analysis.resistance)+'\n';
  text+='\n_Data: Binance | Render: QuickChart.io_';
  const {AttachmentBuilder}=require('discord.js');
  const replyOpts={content:text.slice(0,2000),flags:4};
  if(chartBuf)replyOpts.files=[new AttachmentBuilder(chartBuf,{name:'chart.png'})];
  await message.reply(replyOpts);
}

module.exports={handleChartCommand,SYMBOL_MAP};
