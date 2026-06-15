import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API = '/api/dashboard';
const modes = [
  { id:'scalp', label:'Scalper', sub:'5m / 15m / 30m' },
  { id:'day', label:'Day Trader', sub:'1H / 4H' },
  { id:'swing', label:'Swing Trader', sub:'1D / 1W' }
];
const RR_CHIPS = [[0,'All'],[2,'RR>2'],[3,'RR>3'],[5,'Elite ≥5']];
const TICKER_SYMS=['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','LINK','TON','SUI'];

function fmt(t){ if(!t) return '—'; const d=new Date(t); const s=Math.round((Date.now()-d.getTime())/1000); if(s<0) return 'now'; if(s<60) return s+'s ago'; if(s<3600) return Math.round(s/60)+'m ago'; if(s<86400) return Math.round(s/3600)+'h ago'; return d.toLocaleString(); }
const riskCls = r => r==='High'?'red':r==='Low'?'green':'yellow';

function Clock(){const[t,setT]=useState(new Date());useEffect(()=>{const id=setInterval(()=>setT(new Date()),1000);return()=>clearInterval(id);},[]);return <b>{t.toLocaleTimeString()}</b>;}
function Pill({children, tone='neutral'}) { return <span className={`pill ${tone}`}>{children}</span>; }
function Stat({label, value, sub}) { return <div className="stat"><span>{label}</span><strong>{value}</strong>{sub && <em>{sub}</em>}</div>; }
function ScoreRing({score, danger}) { return <div className={`ring ${danger?'danger':''}`} style={{'--score':score}}><b>{score}</b></div>; }
function Gauge({value,label}) { return <div className="gaugeCard"><div className="gauge"><div className="needle" style={{transform:`rotate(${(value/100)*180-90}deg)`}}/><span>{value}</span></div><b>{label}</b></div>; }
function srcBadgeCls(s){ return /LIVE/.test(s||'')?'live':/STALE/.test(s||'')?'stale':'mock'; }

function Ticker({ops}){
  const map=new Map((ops||[]).map(o=>[o.symbol,o]));
  let list=TICKER_SYMS.map(s=>map.get(s)).filter(Boolean);
  if(!list.length) list=(ops||[]).slice(0,12);
  if(!list.length) return null;
  return <div className="ticker">{list.map(o=><div className="tick" key={o.symbol}><b>{o.symbol}</b><span>{o.display?.price||o.price}</span><em className={(o.change24h||0)>=0?'green':'red'}>{(o.change24h||0)>=0?'+':''}{(o.change24h||0).toFixed(2)}%</em></div>)}</div>;
}

/* ===== Priority 1: Selected Coin Hero ===== */
function SelectedHero({op, idx, total, onPrev, onNext, pinned, onPin, onClose}){
  if(!op) return null;
  return <section className="selHero card">
    <div className="selNav">
      <div className="selNavL">
        <button onClick={onPrev} disabled={idx<=0}>‹ Prev</button>
        <span className="selPos">{idx+1} / {total}</span>
        <button onClick={onNext} disabled={idx>=total-1}>Next ›</button>
      </div>
      <div className="selNavR">
        <button className={"pinBtn "+(pinned?'on':'')} onClick={onPin}>{pinned?'📌 Pinned':'📌 Pin Coin'}</button>
        <button className="closeBtn" onClick={onClose}>✕</button>
      </div>
    </div>
    <div className="selHead">
      <div className="coinAvatar big">{op.symbol[0]}</div>
      <div className="selTitle"><h2>{op.symbol} <span>/ USDT</span></h2><p>{op.name}</p></div>
      <Pill tone={op.direction==='LONG'?'long':'short'}>{op.direction}</Pill>
      {op.elite&&<span className="eliteBadge">⭐ELITE</span>}
      {op.dataSource&&<span className={"srcBadge "+srcBadgeCls(op.dataSource)}>{op.dataSource}</span>}
    </div>
    <div className="selMetrics">
      <div><small>Alpha Score</small><b className="alpha">{op.alphaScore}</b></div>
      <div><small>Conviction</small><b>{op.conviction}</b></div>
      <div><small>Confidence</small><b>{op.confidence}%</b></div>
      <div><small>Risk / Reward</small><b className="rrBig">{op.display.rr}</b></div>
      <div><small>Current Price</small><b>{op.display.price}</b></div>
      <div><small>Risk</small><b className={riskCls(op.risk)}>{op.risk}</b></div>
    </div>
    <div className="selLevels">
      <div className="lvl zone"><span>Buy / Sell Zone</span><b>{op.display.buyZone}</b></div>
      <div className="lvl"><span>Target 1</span><b>{op.display.target1}</b><em className="green">{op.display.target1Move}</em></div>
      <div className="lvl"><span>Target 2</span><b>{op.display.target2}</b><em className="green">{op.display.target2Move}</em></div>
      <div className="lvl"><span>Stretch Target</span><b>{op.display.stretch}</b><em className="green">{op.display.stretchMove}</em></div>
      <div className="lvl danger"><span>Stop / Invalidation</span><b>{op.display.invalidation}</b><em className="red">{op.display.riskMove}</em></div>
    </div>
    <div className="selWhy">
      <h3>Why This Trade{op.warming&&<span className="warmBadge">warming up</span>}</h3>
      {Array.isArray(op.why)&&op.why.length
        ? <ul className="whyList">{op.why.map((w,i)=><li key={i}>{w}</li>)}</ul>
        : <p>Structure, momentum, volume, volatility and breakout engines agree enough to rank this setup.</p>}
      {op.historyTier&&<small className="tierNote">Engine {op.engine||'v2'} · history {op.historyTier} · class {op.history_class||'—'}{op.agreement!=null?` · agreement ${op.agreement}%`:''}</small>}
    </div>
  </section>;
}

/* ===== Priority 3: Top Longs / Top Shorts ===== */
function MiniOp({op,onSelect,active}){
  return <button className={"miniOp"+(active?' active':'')} onClick={()=>onSelect(op)}>
    <span className="coinAvatar small">{op.symbol[0]}</span>
    <div className="miniMain"><b>{op.symbol}{op.elite&&<span className="eliteBadge">⭐</span>}</b><small>α{op.alphaScore} · <span className={op.direction==='LONG'?'green':'red'}>{op.display.target1Move} T1</span></small></div>
    <b className="rrBig">{op.display.rr}</b>
    <ScoreRing score={op.conviction} danger={op.direction==='SHORT'}/>
  </button>;
}
function LongShortLists({items,onSelect,selSym}){
  const longs=items.filter(o=>o.direction==='LONG').slice(0,6);
  const shorts=items.filter(o=>o.direction==='SHORT').slice(0,6);
  return <div className="lsGrid">
    <div className="lsCol card"><h3 className="lsHead long">▲ Top Longs</h3>{longs.length?longs.map(o=><MiniOp key={o.symbol} op={o} onSelect={onSelect} active={o.symbol===selSym}/>):<p className="muted2">No longs match the current filters.</p>}</div>
    <div className="lsCol card"><h3 className="lsHead short">▼ Top Shorts</h3>{shorts.length?shorts.map(o=><MiniOp key={o.symbol} op={o} onSelect={onSelect} active={o.symbol===selSym}/>):<p className="muted2">No shorts match the current filters.</p>}</div>
  </div>;
}

function OpportunityTable({items, onSelect, selSym}) {
  return <div className="tableWrap"><table><thead><tr><th>#</th><th>Coin</th><th>Alpha</th><th>Direction</th><th>Conviction</th><th>Confidence</th><th>Risk</th><th>Zone</th><th>Target 1</th><th>R:R</th></tr></thead><tbody>{items.slice(0,12).map((op,i)=><tr key={op.symbol} className={op.symbol===selSym?'sel':''} onClick={()=>onSelect(op)}><td>{i+1}</td><td><div className="coinCell"><span className="coinAvatar small">{op.symbol[0]}</span><div><b>{op.symbol}</b><small>{op.name}</small>{op.dataSource&&<small className={"srcBadge "+srcBadgeCls(op.dataSource)}>{op.dataSource}</small>}</div></div></td><td><b className="alpha">{op.alphaScore}</b>{op.elite&&<span className="eliteBadge">⭐</span>}</td><td><Pill tone={op.direction==='LONG'?'long':'short'}>{op.direction}</Pill></td><td><ScoreRing score={op.conviction} danger={op.direction==='SHORT'} /></td><td>{op.confidence}%</td><td><span className={riskCls(op.risk)}>{op.risk}</span></td><td>{op.display.buyZone}</td><td>{op.display.target1}<small className={"mv "+(op.direction==='LONG'?'long':'short')}>{op.display.target1Move}</small></td><td><b className="rr">{op.display.rr}</b></td></tr>)}</tbody></table></div>;
}

function Analytics({a}){
  if(!a) return null;
  const rr=a.rr||{byMode:[],byClass:[]}; const wr=a.winRateByRR||[];
  return <div className="card analytics-card"><h3>📊 RR Analytics</h3>
    <div className="anSub">Avg RR by mode</div>
    {rr.byMode.map(m=><div className="macro" key={m.mode}><span style={{textTransform:'capitalize'}}>{m.mode}{m.elite?` · ${m.elite}⭐`:''}</span><b>{m.avgRR}R</b><em className="green">{m.meetsMin}/{m.count} pass</em></div>)}
    <div className="anSub">Avg RR by coin class</div>
    {rr.byClass.map(c=><div className="macro" key={c.history_class}><span>{c.history_class}</span><b>{c.avgRR}R</b><em>{c.count} coins</em></div>)}
    <div className="anSub">Win rate by RR bucket</div>
    {wr.some(b=>b.n>0)?wr.map(b=><div className="macro" key={b.bucket}><span>RR {b.bucket}</span><b>{b.win_rate!=null?Math.round(b.win_rate*100)+'%':'—'}</b><em>{b.n} setups</em></div>):<p className="muted2">Accrues as Radar Learn resolves 24h outcomes.</p>}
  </div>;
}

/* RR filter chips (Priority 4) */
function RRChips({rrMin,setRrMin}){
  return <div className="rrChips">{RR_CHIPS.map(([v,l])=><button key={v} className={rrMin===v?'active':''} onClick={()=>setRrMin(v)}>{l}</button>)}</div>;
}

function useDashboard(mode){
  const [data,setData]=useState(null);
  useEffect(()=>{ let on=true; const load=()=>fetch(`${API}?mode=${mode}`).then(r=>r.json()).then(d=>{if(on)setData(d)}).catch(()=>{}); load(); const id=setInterval(load,60000); return()=>{on=false;clearInterval(id);}; },[mode]);
  return data;
}

/* ===== Desktop App ===== */
function App(){
  const [mode,setMode]=useState('day');
  const [filter,setFilter]=useState('all');
  const [rrMin,setRrMin]=useState(0);
  const [query,setQuery]=useState('');
  const [selSym,setSelSym]=useState(null);
  const [pinned,setPinned]=useState(false);
  const data=useDashboard(mode);
  useEffect(()=>{ if(!pinned) setSelSym(null); },[mode]);
  const items=useMemo(()=>{
    let arr=data?.opportunities||[];
    if(filter==='long') arr=arr.filter(x=>x.direction==='LONG');
    if(filter==='short') arr=arr.filter(x=>x.direction==='SHORT');
    if(rrMin) arr=arr.filter(x=>(x.trade?.rr||0)>=rrMin);
    if(query.trim()){const q=query.trim().toLowerCase(); arr=arr.filter(x=>(x.symbol+' '+x.name).toLowerCase().includes(q));}
    return arr;
  },[data,filter,rrMin,query]);
  const all=data?.opportunities||[];
  const selected = all.find(o=>o.symbol===selSym) || all[0] || null;
  const idx = items.findIndex(o=>o.symbol===(selected&&selected.symbol));
  const pick=op=>setSelSym(op.symbol);
  const onPrev=()=>{ if(idx>0) setSelSym(items[idx-1].symbol); };
  const onNext=()=>{ if(idx>=0&&idx<items.length-1) setSelSym(items[idx+1].symbol); };
  const onPin=()=>setPinned(p=>{ const np=!p; if(np&&selected) setSelSym(selected.symbol); return np; });
  if(!data) return <div className="loading">Loading Alpha Radar...</div>;
  return <div className="app">
    <aside className="side"><div className="brand"><div className="radar">◎</div><div><h1>ALPHA RADAR</h1><p>Market Intelligence Terminal</p></div></div>
      <a className="active" href="/">Dashboard</a><a href="/mobile">📱 Mobile View</a><a href="/status">⚙ System Status</a>
      {['Emerging Coins','Macro Radar','Alerts','Settings'].map(n=><a key={n}>{n}</a>)}
      <div className="pro">ALPHA RADAR PRO<br/><Clock/><button>View Reports</button></div></aside>
    <main>
      <Ticker ops={data.opportunities}/>
      <header><div className="brand mobile"><div className="radar">◎</div><div><h1>ALPHA RADAR</h1><p>Intelligence Terminal</p></div></div><Stat label="Market Temp" value={data.macro.marketTemperature+'/100'}/><Stat label="Opportunities" value={data.macro.totalOpportunities}/><Stat label="Avg Confidence" value={data.macro.avgConfidence+'%'}/><Stat label="24H Win Rate" value={data.macro.winRate24h!=null?data.macro.winRate24h+'%':'—'} sub={data.macro.winRate24h!=null?'Radar Learn':'accruing'}/><a className="upgrade" href="/status">System Status</a></header>
      <div className="modeBar">{modes.map(m=><button key={m.id} className={mode===m.id?'active':''} onClick={()=>setMode(m.id)}>{m.label}<small>{m.sub}</small></button>)}</div>
      {data.dataStatus&&!data.dataStatus.live&&<div className={"dataBanner "+(/mock/.test(data.dataStatus.source||'')?"mock":"stale")}><b>⚠ {data.dataStatus.label}</b><span>{data.dataStatus.note}</span></div>}
      {data.rrFilter&&data.rrFilter.relaxed&&<div className="dataBanner stale"><b>⚠ RR filter relaxed ({data.rrFilter.minRR}R min)</b><span>{data.rrFilter.note}</span></div>}
      <SelectedHero op={selected} idx={idx} total={items.length} onPrev={onPrev} onNext={onNext} pinned={pinned} onPin={onPin} onClose={()=>{setSelSym('__none__');setPinned(false);}}/>
      <LongShortLists items={items} onSelect={pick} selSym={selected&&selected.symbol}/>
      <section className="hero card">
        <div className="liveLine"><span>v{data.version}</span><b className={"srcTag "+(data.dataStatus?.live?"live":"warn")}>{data.dataStatus?.label||('Data: '+data.dataSource)}</b><em>Updated: {new Date(data.updatedAt).toLocaleTimeString()}{data.dataStatus?.ageSeconds!=null?` (${data.dataStatus.ageSeconds}s ago)`:''}</em></div>
        <div className="sectionTitle"><h2>🏆 All Opportunities (ranked by Alpha)</h2><input className="search" type="text" placeholder="🔍 Search coin (e.g. SOL, PEPE)" value={query} onChange={e=>setQuery(e.target.value)}/></div>
        <div className="filterRow"><div className="filters"><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>All</button><button className={filter==='long'?'active':''} onClick={()=>setFilter('long')}>Long</button><button className={filter==='short'?'active danger':''} onClick={()=>setFilter('short')}>Short</button></div><RRChips rrMin={rrMin} setRrMin={setRrMin}/></div>
        <OpportunityTable items={items} onSelect={pick} selSym={selected&&selected.symbol}/>
        {items.length===0&&<p className="noResults">No coins match the current filters. Try lowering the RR filter or clearing search.</p>}
      </section>
      <div className="grid"><Gauge value={data.macro.marketTemperature} label="Bullish"/><div className="card"><h3>Score Breakdown</h3><div className="bars">{selected && Object.entries(selected.signals||{}).slice(0,6).map(([k,v])=><label key={k}><span>{k}</span><i><b style={{width:v+'%'}}/></i><em>{v}</em></label>)}</div></div><div className="card"><h3>Emerging Coin Radar</h3>{(data.emerging||[]).slice(0,3).map(e=><div className="macro" key={e.chain+e.symbol}><span>{e.symbol}<small> {e.chain}</small></span><b>{e.earlyScore}</b><em className={e.rugRisk>70?'red':'green'}>Risk {e.rugRisk}</em></div>)}{(!data.emerging||data.emerging.length===0)&&<p>DEX sources ready. Waiting for live data.</p>}</div><Gauge value={data.macro.fearGreed} label="Greed"/><div className="card"><h3>Macro Radar <small className={"srcBadge "+(data.macro.macroLive?"live":"mock")}>{data.macro.macroLive?"LIVE: Stooq":"FALLBACK: Mock"}</small></h3>{data.macro.assets.map(a=><div className="macro" key={a.label}><span>{a.label}{a.live===false&&<small className="srcBadge mock">mock</small>}</span><b>{a.value}</b><em className={a.change>0?'green':'red'}>{a.change>0?'+':''}{a.change}%</em></div>)}</div><div className="card"><h3>Narrative Radar</h3>{data.narratives.map(n=><div className="macro" key={n.narrative}><span>{n.narrative}</span><b>{n.strength}</b><em className={n.momentum>0?'green':'red'}>{n.momentum>0?'+':''}{n.momentum}</em></div>)}</div><Analytics a={data.analytics}/><div className="card"><h3>Recent Alerts</h3>{data.alerts.map(a=><div className="alert" key={a.title}><b>{a.title}</b><p>{a.text}</p><small>{a.age}</small></div>)}</div></div>
    </main>
    <nav className="bottom"><a className="active" href="/">⌂<small>Home</small></a><a href="/mobile">📱<small>Mobile</small></a><a href="/status">⚙<small>Status</small></a></nav>
  </div>;
}

/* ===== Priority 2: Dedicated Mobile Page ===== */
function BigCard({op,onSelect}){
  return <button className="bigCard" onClick={()=>onSelect(op)}>
    <div className="bcHead"><span className="coinAvatar">{op.symbol[0]}</span><div className="bcTitle"><b>{op.symbol}{op.elite&&<span className="eliteBadge">⭐</span>}</b><small>{op.name}</small></div><Pill tone={op.direction==='LONG'?'long':'short'}>{op.direction}</Pill></div>
    <div className="bcMetrics"><div><small>Alpha</small><b className="alpha">{op.alphaScore}</b></div><div><small>Conv</small><b>{op.conviction}</b></div><div><small>R:R</small><b className="rrBig">{op.display.rr}</b></div><div><small>Price</small><b>{op.display.price}</b></div></div>
    <div className="bcZone"><span>Zone {op.display.buyZone}</span><span className="green">T1 {op.display.target1} ({op.display.target1Move})</span><span className="red">Stop {op.display.invalidation} ({op.display.riskMove})</span></div>
  </button>;
}
function MobileDetail({op,onClose}){
  if(!op) return null;
  return <div className="mDetail card">
    <div className="mdHead"><b>{op.symbol} {op.direction}</b>{op.elite&&<span className="eliteBadge">⭐ELITE</span>}<button className="closeBtn" onClick={onClose}>✕</button></div>
    <div className="bcMetrics"><div><small>Alpha</small><b className="alpha">{op.alphaScore}</b></div><div><small>Conviction</small><b>{op.conviction}</b></div><div><small>Confidence</small><b>{op.confidence}%</b></div><div><small>R:R</small><b className="rrBig">{op.display.rr}</b></div></div>
    <div className="selLevels">
      <div className="lvl zone"><span>Zone</span><b>{op.display.buyZone}</b></div>
      <div className="lvl"><span>Target 1</span><b>{op.display.target1}</b><em className="green">{op.display.target1Move}</em></div>
      <div className="lvl"><span>Target 2</span><b>{op.display.target2}</b><em className="green">{op.display.target2Move}</em></div>
      <div className="lvl"><span>Stretch</span><b>{op.display.stretch}</b><em className="green">{op.display.stretchMove}</em></div>
      <div className="lvl danger"><span>Stop</span><b>{op.display.invalidation}</b><em className="red">{op.display.riskMove}</em></div>
    </div>
    <div className="selWhy"><h3>Why This Trade</h3>{Array.isArray(op.why)&&op.why.length?<ul className="whyList">{op.why.map((w,i)=><li key={i}>{w}</li>)}</ul>:<p>Signals align across the engines.</p>}</div>
  </div>;
}
function Mobile(){
  const [mode,setMode]=useState('day');
  const [rrMin,setRrMin]=useState(0);
  const [sel,setSel]=useState(null);
  const data=useDashboard(mode);
  if(!data) return <div className="loading">Loading…</div>;
  let ops=(data.opportunities||[]).filter(o=>(o.trade?.rr||0)>=rrMin);
  const best=ops[0];
  const longs=ops.filter(o=>o.direction==='LONG').slice(0,5);
  const shorts=ops.filter(o=>o.direction==='SHORT').slice(0,5);
  return <div className="mobileApp">
    <div className="mTop"><div className="brand mobile"><div className="radar">◎</div><div><h1>ALPHA RADAR</h1></div></div><a className="mStatusLink" href="/status">⚙</a></div>
    <Ticker ops={data.opportunities}/>
    {data.dataStatus&&!data.dataStatus.live&&<div className={"dataBanner "+(/mock/.test(data.dataStatus.source||'')?"mock":"stale")}><b>⚠ {data.dataStatus.label}</b></div>}
    <div className="modeBar mob">{modes.map(m=><button key={m.id} className={mode===m.id?'active':''} onClick={()=>setMode(m.id)}>{m.label}</button>)}</div>
    <RRChips rrMin={rrMin} setRrMin={setRrMin}/>
    {sel && <MobileDetail op={sel} onClose={()=>setSel(null)}/>}
    {best && <div className="mSection"><h3>🏆 Best Opportunity</h3><BigCard op={best} onSelect={setSel}/></div>}
    <div className="mSection"><h3 className="lsHead long">▲ Top Longs</h3>{longs.length?longs.map(o=><BigCard key={o.symbol} op={o} onSelect={setSel}/>):<p className="muted2">None match the filter.</p>}</div>
    <div className="mSection"><h3 className="lsHead short">▼ Top Shorts</h3>{shorts.length?shorts.map(o=><BigCard key={o.symbol} op={o} onSelect={setSel}/>):<p className="muted2">None match the filter.</p>}</div>
    <nav className="bottom"><a href="/">⌂<small>Desktop</small></a><a className="active">📱<small>Mobile</small></a><a href="/status">⚙<small>Status</small></a></nav>
  </div>;
}

/* ===== Priority 5: System Status Page ===== */
function StatusCard({title, ok, rows, note}){
  return <div className="statCard card"><div className="scHead"><span className={"dot "+(ok?'ok':'bad')}/><h3>{title}</h3></div>
    <div className="scRows">{rows.map(([k,v],i)=><div className="scRow" key={i}><span>{k}</span><b>{v==null?'—':String(v)}</b></div>)}</div>
    {note&&<p className="muted2">{note}</p>}</div>;
}
function StatusPage(){
  const [s,setS]=useState(null);
  useEffect(()=>{ let on=true; const load=()=>fetch('/api/system/status').then(r=>r.json()).then(d=>{if(on)setS(d)}).catch(()=>{}); load(); const id=setInterval(load,15000); return()=>{on=false;clearInterval(id);}; },[]);
  if(!s) return <div className="loading">Loading status…</div>;
  return <div className="statusPage">
    <header className="statusHead"><a className="back" href="/">‹ Back</a><h1>⚙ System Status</h1><span className="muted2">Updated {fmt(s.timestamp)}</span></header>
    <div className="statusGrid">
      <StatusCard title="Scanner" ok={s.scanner.ok} rows={[['Cron',s.scanner.cronEnabled?`every ${s.scanner.intervalMinutes}m`:'disabled'],['Last scan',fmt(s.scanner.lastScanAt)],['Status',s.scanner.lastScanStatus],['Source',s.scanner.source],['Universe',s.scanner.universeSize],['Duration',s.scanner.durationMs!=null?s.scanner.durationMs+'ms':'—']]} note={(s.scanner.errors||[]).length?('Errors: '+s.scanner.errors.join(', ')):null}/>
      <StatusCard title="Database" ok={s.database.ok} rows={[['Driver',s.database.driver],['Connected',s.database.ok?'yes':'no']]} note={s.database.note}/>
      <StatusCard title="API / Data Feed" ok={s.api.ok} rows={[['Live market data',s.api.liveData?'yes':'no (mock/stale)'],...Object.entries(s.api.integrations||{}).slice(0,6)]}/>
      <StatusCard title="Deep-History Backfill" ok={s.backfill.enabled&&(s.backfill.assets||0)>0} rows={s.backfill.enabled?[['Profiled assets',s.backfill.assets],['Last backfill',fmt(s.backfill.lastBackfillAt)],['Last profile',fmt(s.backfill.lastProfileAt)],...((s.backfill.classes||[]).map(c=>[c.history_class+' class',c.n]))]:[['Status',s.backfill.note]]} note={s.backfill.enabled&&(s.backfill.assets||0)===0?'No backfill yet — run npm run backfill:history':null}/>
      <StatusCard title="Radar Learn" ok={s.radarLearn.enabled} rows={s.radarLearn.enabled?[['Setups',s.radarLearn.setups],['Active',s.radarLearn.activeSetups],['Outcomes',s.radarLearn.outcomes],['Last setup',fmt(s.radarLearn.lastSetupAt)],['Last outcome',fmt(s.radarLearn.lastOutcomeAt)]]:[['Status',s.radarLearn.note]]}/>
    </div>
    <nav className="bottom"><a href="/">⌂<small>Desktop</small></a><a href="/mobile">📱<small>Mobile</small></a><a className="active">⚙<small>Status</small></a></nav>
  </div>;
}

const path=window.location.pathname;
const View = path.startsWith('/mobile') ? Mobile : path.startsWith('/status') ? StatusPage : App;
createRoot(document.getElementById('root')).render(<View/>);
