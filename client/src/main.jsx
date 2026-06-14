import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API = '/api/dashboard';
const modes = [
  { id:'scalp', label:'Scalper', sub:'5m / 15m / 30m' },
  { id:'day', label:'Day Trader', sub:'1H / 4H' },
  { id:'swing', label:'Swing Trader', sub:'1D / 1W' }
];

function Pill({children, tone='neutral'}) { return <span className={`pill ${tone}`}>{children}</span>; }
function Stat({label, value, sub}) { return <div className="stat"><span>{label}</span><strong>{value}</strong>{sub && <em>{sub}</em>}</div>; }
function ScoreRing({score, danger}) { return <div className={`ring ${danger?'danger':''}`} style={{'--score':score}}><b>{score}</b></div>; }
function Gauge({value,label}) { return <div className="gaugeCard"><div className="gauge"><div className="needle" style={{transform:`rotate(${(value/100)*180-90}deg)`}}/><span>{value}</span></div><b>{label}</b></div>; }

function OpportunityCard({op, onSelect}) {
  return <button className="opCard" onClick={()=>onSelect(op)}>
    <div className="coinAvatar">{op.symbol[0]}</div>
    <div className="opMain"><b>{op.symbol}</b><small>{op.name}</small></div>
    <Pill tone={op.direction==='LONG'?'long':'short'}>{op.direction}</Pill>
    <ScoreRing score={op.conviction} danger={op.direction==='SHORT'} />
    <div className="targetMini"><b>{op.display.buyZone}</b><small>Buy/Sell zone</small></div>
    <span className="chev">›</span>
  </button>;
}

function OpportunityTable({items, onSelect}) {
  return <div className="tableWrap"><table><thead><tr><th>#</th><th>Coin</th><th>Direction</th><th>Conviction</th><th>Confidence</th><th>Risk</th><th>Freshness</th><th>Consensus</th><th>Zone</th><th>Target 1</th><th>Target 2</th><th>Stretch</th></tr></thead><tbody>{items.slice(0,8).map((op,i)=><tr key={op.symbol} onClick={()=>onSelect(op)}><td>{i+1}</td><td><div className="coinCell"><span className="coinAvatar small">{op.symbol[0]}</span><div><b>{op.symbol}</b><small>{op.name}</small></div></div></td><td><Pill tone={op.direction==='LONG'?'long':'short'}>{op.direction}</Pill></td><td><ScoreRing score={op.conviction} danger={op.direction==='SHORT'} /></td><td>{op.confidence}%</td><td><span className={op.risk==='High'?'red':op.risk==='Low'?'green':'yellow'}>{op.risk}</span></td><td>{op.signals.freshness}</td><td>{op.consensus}%</td><td>{op.display.buyZone}</td><td>{op.display.target1}</td><td>{op.display.target2}</td><td>{op.display.stretch}</td></tr>)}</tbody></table></div>
}

function Detail({selected, mode}) {
  if (!selected) return null;
  return <section className="detail card">
    <div className="detailTop"><div className="coinAvatar big">{selected.symbol[0]}</div><div><h2>{selected.symbol} <span>/ USDT</span></h2><p>{selected.name}</p></div><Pill tone={selected.direction==='LONG'?'long':'short'}>{selected.direction}</Pill></div>
    <div className="detailGrid"><div><small>Conviction</small><ScoreRing score={selected.conviction} danger={selected.direction==='SHORT'} /></div><div><small>Confidence</small><b>{selected.confidence}%</b><small>Risk</small><b className={selected.risk==='High'?'red':selected.risk==='Low'?'green':'yellow'}>{selected.risk}</b></div><div><small>Mode</small><b>{modes.find(m=>m.id===mode)?.label}</b><small>Consensus</small><b>{selected.consensus}%</b></div></div>
    <div className="zone"><small>Suggested {selected.direction==='LONG'?'Buy':'Short'} Zone</small><strong>{selected.display.buyZone}</strong><p>Current price: {selected.display.price}</p></div>
    <div className="targets"><div><span>Target 1</span><b>{selected.display.target1}</b></div><div><span>Target 2</span><b>{selected.display.target2}</b></div><div><span>Stretch</span><b>{selected.display.stretch}</b></div><div className="dangerLine"><span>Invalidation</span><b>{selected.display.invalidation}</b></div></div>
    <div className="why"><h3>Why now?{selected.warming && <span className="warmBadge">warming up</span>}</h3>
      {Array.isArray(selected.why) && selected.why.length
        ? <ul className="whyList">{selected.why.map((w,i)=><li key={i}>{w}</li>)}</ul>
        : <p>Structure, momentum, volume, volatility and breakout engines agree enough to rank this setup.</p>}
      {selected.historyTier && <small className="tierNote">Engine {selected.engine||'v2'} · history {selected.historyTier}{selected.confidence!=null?` · confidence ${selected.confidence}%`:''}{selected.agreement!=null?` · agreement ${selected.agreement}%`:''}</small>}
    </div>
  </section>
}

function App(){
  const [data,setData]=useState(null); const [mode,setMode]=useState('day'); const [filter,setFilter]=useState('all'); const [selected,setSelected]=useState(null);
  useEffect(()=>{fetch(`${API}?mode=${mode}`).then(r=>r.json()).then(d=>{setData(d);setSelected(d.opportunities?.[0])}).catch(()=>{})},[mode]);
  const items=useMemo(()=>{let arr=data?.opportunities||[]; if(filter==='long') arr=arr.filter(x=>x.direction==='LONG'); if(filter==='short') arr=arr.filter(x=>x.direction==='SHORT'); return arr;},[data,filter]);
  if(!data) return <div className="loading">Loading Alpha Radar...</div>;
  return <div className="app">
    <aside className="side"><div className="brand"><div className="radar">◎</div><div><h1>ALPHA RADAR</h1><p>Market Intelligence Terminal</p></div></div>{['Dashboard','Opportunities','Emerging Coins','Macro Radar','Stablecoin Radar','Whale Radar','Alerts','Portfolio Radar','Settings'].map((n,i)=><a className={i===0?'active':''} key={n}>{n}</a>)}<div className="pro">ALPHA RADAR PRO<br/><b>02:45:18</b><button>View Reports</button></div></aside>
    <main>
      <header><div className="brand mobile"><div className="radar">◎</div><div><h1>ALPHA RADAR</h1><p>Mobile Intelligence</p></div></div><Stat label="Market Temperature" value={data.macro.marketTemperature+'/100'} sub="Bullish"/><Stat label="Total Opportunities" value={data.macro.totalOpportunities}/><Stat label="Avg Confidence" value={data.macro.avgConfidence+'%'}/><Stat label="24H Win Rate" value={data.macro.winRate24h+'%'}/><Stat label="API Status" value={data.integrations?.dexScreener==='live'?'LIVE':'READY'} sub="Full API"/><button className="upgrade">Upgrade</button></header>
      <div className="modeBar">{modes.map(m=><button key={m.id} className={mode===m.id?'active':''} onClick={()=>setMode(m.id)}>{m.label}<small>{m.sub}</small></button>)}</div>
      <section className="hero card"><div className="liveLine"><span>v{data.version}</span><b>Data: {data.dataSource}</b><em>Updated: {new Date(data.updatedAt).toLocaleTimeString()}</em></div><div className="sectionTitle"><h2>🏆 Best Opportunities Overall</h2><div className="filters"><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>All</button><button className={filter==='long'?'active':''} onClick={()=>setFilter('long')}>Long</button><button className={filter==='short'?'active danger':''} onClick={()=>setFilter('short')}>Short</button></div></div><div className="desktopOnly"><OpportunityTable items={items} onSelect={setSelected}/></div><div className="mobileOnly list">{items.slice(0,5).map(op=><OpportunityCard key={op.symbol} op={op} onSelect={setSelected}/>)}</div></section>
      <div className="grid"><Gauge value={data.macro.marketTemperature} label="Bullish"/><div className="card"><h3>Score Breakdown</h3><div className="bars">{selected && Object.entries(selected.signals).slice(0,6).map(([k,v])=><label key={k}><span>{k}</span><i><b style={{width:v+'%'}}/></i><em>{v}</em></label>)}</div></div><div className="card"><h3>Emerging Coin Radar</h3>{(data.emerging||[]).slice(0,3).map(e=><div className="macro" key={e.chain+e.symbol}><span>{e.symbol}<small> {e.chain}</small></span><b>{e.earlyScore}</b><em className={e.rugRisk>70?'red':'green'}>Risk {e.rugRisk}</em></div>)}{(!data.emerging||data.emerging.length===0)&&<p>DEX sources ready. Waiting for live data.</p>}</div><Gauge value={data.macro.fearGreed} label="Greed"/><div className="card"><h3>Macro Radar</h3>{data.macro.assets.map(a=><div className="macro" key={a.label}><span>{a.label}</span><b>{a.value}</b><em className={a.change>0?'green':'red'}>{a.change}%</em></div>)}</div><div className="card"><h3>Narrative Radar</h3>{data.narratives.map(n=><div className="macro" key={n.narrative}><span>{n.narrative}</span><b>{n.strength}</b><em className={n.momentum>0?'green':'red'}>{n.momentum>0?'+':''}{n.momentum}</em></div>)}</div><div className="card"><h3>API Integrations</h3>{data.integrations && Object.entries(data.integrations).slice(0,8).map(([k,v])=><div className="macro" key={k}><span>{k}</span><b>{v}</b></div>)}</div><div className="card"><h3>Recent Alerts</h3>{data.alerts.map(a=><div className="alert" key={a.title}><b>{a.title}</b><p>{a.text}</p><small>{a.age}</small></div>)}</div><Detail selected={selected} mode={mode}/></div>
    </main><nav className="bottom"><a>⌂<small>Home</small></a><a>🏆<small>Opps</small></a><a>◎<small>Radar</small></a><a>🔔<small>Alerts</small></a><a>☻<small>Profile</small></a></nav>
  </div>
}
createRoot(document.getElementById('root')).render(<App/>);
