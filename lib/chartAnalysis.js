'use strict';
const axios = require('axios');

const SYMBOL_MAP = {
  btc:'BTCUSDT',bitcoin:'BTCUSDT',eth:'ETHUSDT',ethereum:'ETHUSDT',
  bnb:'BNBUSDT',sol:'SOLUSDT',solana:'SOLUSDT',xrp:'XRPUSDT',ripple:'XRPUSDT',
  ada:'ADAUSDT',cardano:'ADAUSDT',doge:'DOGEUSDT',dogecoin:'DOGEUSDT',
  avax:'AVAXUSDT',avalanche:'AVAXUSDT',dot:'DOTUSDT',polkadot:'DOTUSDT',
  link:'LINKUSDT',chainlink:'LINKUSDT',ltc:'LTCUSDT',litecoin:'LTCUSDT',
  uni:'UNIUSDT',atom:'ATOMUSDT',cosmos:'ATOMUSDT',near:'NEARUSDT',
  arb:'ARBUSDT',arbitrum:'ARBUSDT',op:'OPUSDT',inj:'INJUSDT',
  sui:'SUIUSDT',ton:'TONUSDT',pepe:'PEPEUSDT',trx:'TRXUSDT',tron:'TRXUSDT',
  xlm:'XLMUSDT',stellar:'XLMUSDT',apt:'APTUSDT',shib:'SHIBUSDT',
  matic:'MATICUSDT',polygon:'MATICUSDT',fil:'FILUSDT',
};
const VALID_INTERVALS=['1m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'];

async function fetchOHLCV(pair,interval,limit){
  const url='https://api.binance.com/api/v3/klines?symbol='+pair+'&interval='+interval+'&limit='+limit;
  const {data}=await axios.get(url,{timeout:10000});
  return data.map(k=>({t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}));
}

function calcSMA(arr,period){
  return arr.map((_,i)=>i<period-1?null:arr.slice(i-period+1,i+1).reduce((a,b)=>a+b,0)/period);
}
function calcEMA(arr,period){
  const k=2/(period+1),result=[];let ema=null;
  for(let i=0;i<arr.length;i++){
    if(i<period-1){result.push(null);continue;}
    ema=ema===null?arr.slice(0,period).reduce((a,b)=>a+b,0)/period:arr[i]*k+ema*(1-k);
    result.push(ema);
  }
  return result;
}
function calcRSI(closes,period){
  period=period||14;
  const out=new Array(period).fill(null);
  let ag=0,al=0;
  for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];d>0?ag+=d:al-=d;}
  ag/=period;al/=period;
  out.push(al===0?100:100-100/(1+ag/al));
  for(let i=period+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1],g=d>0?d:0,l=d<0?-d:0;
    ag=(ag*(period-1)+g)/period;al=(al*(period-1)+l)/period;
    out.push(al===0?100:100-100/(1+ag/al));
  }
  return out;
}
function calcBB(closes,period,mult){
  period=period||20;mult=mult||2;
  return calcSMA(closes,period).map((m,i)=>{
    if(m===null)return{upper:null,mid:null,lower:null};
    const s=Math.sqrt(closes.slice(i-period+1,i+1).reduce((a,v)=>a+Math.pow(v-m,2),0)/period);
    return{upper:m+mult*s,mid:m,lower:m-mult*s};
  });
}
function calcMACD(closes){
  const e12=calcEMA(closes,12),e26=calcEMA(closes,26);
  const ml=e12.map((v,i)=>v!==null&&e26[i]!==null?v-e26[i]:null);
  const sl=calcEMA(ml.map(v=>v!==null?v:0),9);
  return ml.map((v,i)=>({macd:v,signal:sl[i],hist:v!==null&&sl[i]!==null?v-sl[i]:null}));
}

function detectPatterns(ohlcv){
  const out=[],n=ohlcv.length;if(n<3)return out;
  const body=c=>Math.abs(c.c-c.o),rng=c=>c.h-c.l;
  const isBull=c=>c.c>c.o,isBear=c=>c.c<c.o;
  const uw=c=>c.h-Math.max(c.o,c.c),lw=c=>Math.min(c.o,c.c)-c.l;
  const last=ohlcv[n-1],prev=ohlcv[n-2],prev2=ohlcv[n-3];
  const bd=body(last),r=rng(last);
  if(r>0&&bd/r<0.1)out.push({label:'🔸 Doji',desc:'Ketidakpastian — potensi pembalikan arah'});
  else if(lw(last)>bd*2&&uw(last)<bd*0.5&&isBull(last))out.push({label:'🔨 Hammer',desc:'Pembalikan bullish — tekanan jual melemah'});
  else if(uw(last)>bd*2&&lw(last)<bd*0.5&&isBear(last))out.push({label:'⭐ Shooting Star',desc:'Pembalikan bearish — tekanan beli melemah'});
  else if(isBull(last)&&bd/r>0.85)out.push({label:'🟩 Marubozu Bullish',desc:'Momentum beli sangat dominan'});
  else if(isBear(last)&&bd/r>0.85)out.push({label:'🟥 Marubozu Bearish',desc:'Momentum jual sangat dominan'});
  if(isBear(prev)&&isBull(last)&&last.c>prev.o&&last.o<prev.c)out.push({label:'📗 Bullish Engulfing',desc:'Candle hijau menelan candle merah — reversal naik'});
  else if(isBull(prev)&&isBear(last)&&last.c<prev.o&&last.o>prev.c)out.push({label:'📕 Bearish Engulfing',desc:'Candle merah menelan candle hijau — reversal turun'});
  if(isBear(prev2)&&body(prev)<body(prev2)*0.3&&isBull(last)&&last.c>(prev2.o+prev2.c)/2)out.push({label:'🌟 Morning Star',desc:'Reversal bullish 3 candle — sinyal kuat naik'});
  else if(isBull(prev2)&&body(prev)<body(prev2)*0.3&&isBear(last)&&last.c<(prev2.o+prev2.c)/2)out.push({label:'🌆 Evening Star',desc:'Reversal bearish 3 candle — sinyal kuat turun'});
  if(isBull(prev2)&&isBull(prev)&&isBull(last)&&prev.c>prev2.c&&last.c>prev.c&&body(last)>rng(last)*0.5)out.push({label:'💚 Three White Soldiers',desc:'3 candle hijau kuat — momentum beli sangat kuat'});
  if(isBear(prev2)&&isBear(prev)&&isBear(last)&&prev.c<prev2.c&&last.c<prev.c&&body(last)>rng(last)*0.5)out.push({label:'🖤 Three Black Crows',desc:'3 candle merah kuat — momentum jual sangat kuat'});
  return out;
}

function analyzeAll(ohlcv,closes,rsi,macdData,sma20,sma50,bb){
  const last=closes[closes.length-1];
  const lastRSI=rsi.filter(v=>v!==null).pop();
  const lastMACD=macdData[macdData.length-1],prevMACD=macdData[macdData.length-2];
  const lastBB=bb[bb.length-1];
  const s20v=sma20.filter(v=>v!==null),s50v=sma50.filter(v=>v!==null);
  const lS20=s20v[s20v.length-1],lS50=s50v[s50v.length-1];
  const pS20=s20v[s20v.length-2],pS50=s50v[s50v.length-2];
  const signals=[];let bull=0,bear=0;
  if(lS20&&lS50){
    if(lS20>lS50){signals.push('📈 SMA20 > SMA50 → **Uptrend**');bull++;}
    else{signals.push('📉 SMA20 < SMA50 → **Downtrend**');bear++;}
    if(pS20&&pS50){
      if(pS20<=pS50&&lS20>lS50){signals.push('✨ **Golden Cross** baru! → sinyal beli kuat');bull+=2;}
      else if(pS20>=pS50&&lS20<lS50){signals.push('💀 **Death Cross** baru! → sinyal jual kuat');bear+=2;}
    }
    signals.push(last>lS20?'✅ Harga di atas SMA20':'⚠️ Harga di bawah SMA20');
    last>lS20?bull++:bear++;
    signals.push(last>lS50?'✅ Harga di atas SMA50':'⚠️ Harga di bawah SMA50');
    last>lS50?bull++:bear++;
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
    if(last>lastBB.upper){signals.push('⚡ Di atas BB Upper ('+w+'%) → Breakout');bear+=0.5;}
    else if(last<lastBB.lower){signals.push('⚡ Di bawah BB Lower ('+w+'%) → Breakdown');bull+=0.5;}
    else{signals.push('📊 Dalam BB — posisi '+((last-lastBB.lower)/(lastBB.upper-lastBB.lower)*100).toFixed(0)+'% dari lower ke upper');}
    if(parseFloat(w)<3)signals.push('🔔 BB Squeeze — potensi breakout besar segera');
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

// Chart via QuickChart line (bukan candlestick — hindari HTTP 451)
async function buildChart(pair,ohlcv,sma20,sma50,bb,interval){
  const n=Math.min(60,ohlcv.length);
  const sl=ohlcv.slice(-n),s20=sma20.slice(-n),s50=sma50.slice(-n),bbs=bb.slice(-n);
  const closes=sl.map(c=>c.c);
  function fmtL(t){
    const d=new Date(t),m=(d.getMonth()+1).toString().padStart(2,'0'),dy=d.getDate().toString().padStart(2,'0'),h=d.getHours().toString().padStart(2,'0');
    return(interval.includes('d')||interval.includes('w')||interval==='1M')?m+'/'+dy:m+'/'+dy+' '+h+'h';
  }
  const labels=sl.map(c=>fmtL(c.t));
  const cfg={
    type:'bar',
    data:{
      labels,
      datasets:[
        {type:'line',label:pair+' Close',data:closes,borderColor:'#F7931A',borderWidth:2,pointRadius:0,fill:false,yAxisID:'y',order:1},
        {type:'line',label:'SMA20',data:s20,borderColor:'#4FC3F7',borderWidth:1.5,pointRadius:0,fill:false,yAxisID:'y',order:2},
        {type:'line',label:'SMA50',data:s50,borderColor:'#FFD54F',borderWidth:1.5,pointRadius:0,fill:false,yAxisID:'y',order:3},
        {type:'line',label:'BB Upper',data:bbs.map(b=>b.upper),borderColor:'rgba(206,147,216,0.8)',borderWidth:1,borderDash:[5,5],pointRadius:0,fill:false,yAxisID:'y',order:4},
        {type:'line',label:'BB Lower',data:bbs.map(b=>b.lower),borderColor:'rgba(206,147,216,0.8)',borderWidth:1,borderDash:[5,5],pointRadius:0,fill:false,backgroundColor:'rgba(206,147,216,0.07)',yAxisID:'y',order:5},
        {type:'bar',label:'Volume',data:sl.map(c=>c.v),backgroundColor:sl.map(c=>c.c>=c.o?'rgba(38,166,154,0.3)':'rgba(239,83,80,0.3)'),yAxisID:'vol',order:10},
      ],
    },
    options:{
      plugins:{
        legend:{display:true,labels:{color:'#DDD',font:{size:10}}},
        title:{display:true,text:pair+' — '+interval.toUpperCase()+' | TA Chart (Close+SMA+BB+Volume)',color:'#FFF',font:{size:13,weight:'bold'}},
      },
      scales:{
        x:{ticks:{color:'#AAA',maxTicksLimit:10,font:{size:9}},grid:{color:'#2A2A2A'}},
        y:{ticks:{color:'#AAA',font:{size:9}},grid:{color:'#2A2A2A'},position:'left'},
        vol:{display:false,position:'right',grid:{display:false}},
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
  try{
    interval=(interval||'4h').toLowerCase();
    if(!VALID_INTERVALS.includes(interval))interval='4h';
    const sym=symbol.toLowerCase();
    const pair=SYMBOL_MAP[sym]||(symbol.toUpperCase()+'USDT');
    let ohlcv;
    try{ohlcv=await fetchOHLCV(pair,interval,120);}
    catch(e){
      if(e.response&&e.response.status===400){
        await message.reply('⚠️ Pasangan **'+pair+'** tidak ditemukan di Binance. Coba simbol lain (btc, eth, sol, dll).').catch(()=>{});
        return;
      }
      throw e;
    }
    if(!ohlcv||ohlcv.length<30){
      await message.reply('⚠️ Data tidak cukup untuk analisis **'+pair+'**.').catch(()=>{});
      return;
    }
    const closes=ohlcv.map(c=>c.c);
    const sma20=calcSMA(closes,20),sma50=calcSMA(closes,50);
    const rsi=calcRSI(closes,14),macdData=calcMACD(closes),bb=calcBB(closes,20,2);
    const analysis=analyzeAll(ohlcv,closes,rsi,macdData,sma20,sma50,bb);
    const patterns=detectPatterns(ohlcv);
    const lastClose=closes[closes.length-1],lastOpen=ohlcv[ohlcv.length-1].o;
    const pct=((lastClose-lastOpen)/lastOpen*100).toFixed(2);
    const chgStr=(pct>=0?'+':'')+pct+'%',chgEmoji=pct>=0?'📈':'📉';
    let text='**📊 '+pair+' | '+interval.toUpperCase()+'** '+chgEmoji+' '+chgStr+'\n';
    text+='Harga: **'+fmtPrice(lastClose)+'**\n\n';
    text+='Sentimen: '+analysis.sentiment+' _(Bull '+analysis.bullScore+' vs Bear '+analysis.bearScore+')_\n\n';
    text+='**🔍 Sinyal Indikator:**\n';
    text+=analysis.signals.map(s=>'• '+s).join('\n')+'\n';
    if(patterns.length>0){
      text+='\n**🕯️ Pola Candlestick:**\n';
      text+=patterns.map(p=>'• '+p.label+' — '+p.desc).join('\n')+'\n';
    }else{
      text+='\n**🕯️ Pola Candlestick:** Tidak ada pola khusus terdeteksi\n';
    }
    text+='\n**📐 Support & Resistance (30 candle):**\n';
    text+='• 🛡️ Support: **'+fmtPrice(analysis.support)+'**\n';
    text+='• 🔺 Resistance: **'+fmtPrice(analysis.resistance)+'**\n';
    // Build chart (line chart — tanpa candlestick agar tidak kena HTTP 451)
    let chartBuf=null;
    try{chartBuf=await buildChart(pair,ohlcv,sma20,sma50,bb,interval);}
    catch(e){
      console.error('[chart] render gagal:',e.message);
      text+='\n_⚠️ Chart tidak tersedia. Lihat di: https://www.tradingview.com/chart/?symbol=BINANCE:'+pair+'_';
    }
    text+='\n_Data: Binance API_';
    const {AttachmentBuilder,MessageFlags}=require('discord.js');
    const opts={content:text.slice(0,2000),flags:MessageFlags.SuppressEmbeds};
    if(chartBuf)opts.files=[new AttachmentBuilder(chartBuf,{name:'chart.png'})];
    await message.reply(opts).catch(async(e)=>{
      // Fallback: kirim tanpa chart jika reply gagal
      console.error('[chart] reply gagal:',e.message);
      await message.channel.send({content:text.slice(0,2000)}).catch(()=>{});
    });
  }catch(e){
    console.error('[chart] handleChartCommand error:',e.message);
    await message.reply('⚠️ Gagal analisis: '+e.message).catch(()=>{});
  }
}

module.exports={handleChartCommand,SYMBOL_MAP};
