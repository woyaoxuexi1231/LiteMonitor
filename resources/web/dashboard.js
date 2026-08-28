"use strict";
const $ = id => document.getElementById(id);
const AUTH_REQUIRED = {{AUTH_REQUIRED}};
const HERO = new Set(["CPU.Load","CPU.Temp","GPU.Load","GPU.Temp","MEM.Load","NET.Up","NET.Down"]);
const ALWAYS_PANELS = new Set(["cpu","gpu","ram","net"]);
const ST = { ok:{label:"Healthy"}, warn:{label:"Degraded"}, crit:{label:"Critical"}, empty:{label:"No data"} };
const LEVEL = { ok:0, warn:1, crit:2 };
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

let HISTORY_DAYS = 7;
let pwd = localStorage.getItem("ws_pwd") || "";
let viewMode = "live";
let selectedDay = null;
let currentBuckets = [];
let currentPanels = [];
let currentFlags = {};
let liveItems = [];
let ramTotalGB = 0;
let busy = false;
let ws = null;
let reconnectTimer = null;
let calMonth = null;
let calOpen = false;

if (AUTH_REQUIRED) {
  $("authTag").style.display = "inline-flex";
  if (!pwd) showAuth();
}

function withPwd(url) {
  if (!pwd) return url;
  return url + (url.includes("?") ? "&" : "?") + "pwd=" + encodeURIComponent(pwd);
}
function qs() { return pwd ? "?pwd=" + encodeURIComponent(pwd) : ""; }

function sevPct(v){ if(v==null||v<0)return"neutral"; if(v>=90)return"crit"; if(v>=70)return"warn"; return"ok"; }
function sevRam(v){ if(v==null||v<0)return"neutral"; if(v>=90)return"crit"; if(v>=80)return"warn"; return"ok"; }
function sevBat(v){ if(v==null||v<0)return"neutral"; if(v<=20)return"crit"; if(v<=60)return"warn"; return"ok"; }
function sevTemp(v){ if(v==null||v<0)return"neutral"; if(v>=85)return"crit"; if(v>=75)return"warn"; return"ok"; }
function worse(a,b){ if(a==="neutral")return b; if(b==="neutral")return a; return LEVEL[a]>=LEVEL[b]?a:b; }
function sevCls(s){ return s==="neutral"?"neutral":("sev-"+s); }
function stsToSev(sts){ return sts===2?"crit":sts===1?"warn":sts===0?"ok":"neutral"; }
function pad2(n){ return String(n).padStart(2,"0"); }
function pill(t,s){ return `<span class="pill ${s}">${t}</span>`; }
function fmtPct(v){ return v==null||v<0?"—":Math.round(v)+"%"; }
function fmtTemp(v){ return v==null||v<0?"—":Math.round(v)+"°C"; }
function fmtBytes(n){
  if(n==null||n<0)return"—";
  if(n>=1e12)return(n/1e12).toFixed(2)+" TB";
  if(n>=1e9)return(n/1e9).toFixed(2)+" GB";
  if(n>=1e6)return(n/1e6).toFixed(1)+" MB";
  if(n>=1e3)return(n/1e3).toFixed(0)+" KB";
  return Math.round(n)+" B";
}
function fmtValue(v, fmt){
  if(v==null||v<0)return"—";
  if(fmt==="W")return (Math.abs(v)>=100?Math.round(v):v.toFixed(1))+" W";
  if(fmt==="MHz")return (v>=1000?(v/1000).toFixed(1)+" GHz":Math.round(v)+" MHz");
  if(fmt==="RPM")return Math.round(v)+" RPM";
  if(fmt==="FPS")return Math.round(v)+" FPS";
  if(fmt==="%")return Math.round(v)+"%";
  if(fmt==="°C")return Math.round(v)+"°C";
  return (Math.abs(v)>=100?Math.round(v):(+v).toFixed(1))+"";
}
function findItem(items,key){ return items.find(i=>i.k===key||i.k.toLowerCase()===key.toLowerCase()); }
function itemText(item){ if(!item)return"—"; return item.u? (item.v+" "+item.u): (item.v||"—"); }
function itemRaw(item){ if(!item)return null; if(typeof item.raw==="number"&&!isNaN(item.raw))return item.raw; const n=parseFloat(item.v); return isNaN(n)?null:n; }
function bucketVal(b,key){ if(!b||b.empty||!b.v)return null; const v=b.v[key]; return (v==null||v<0)?null:+v; }
function bucketBytes(b,key){ if(!b||b.empty||!b.bytes)return 0; return +(b.bytes[key]||0); }

function setLive(el,text,sev){
  el.textContent=text;
  el.className=el.className.split(" ").filter(c=>!c.startsWith("sev-")&&c!=="neutral").join(" ");
  if(sev==="neutral")el.classList.add("neutral"); else if(sev)el.classList.add("sev-"+sev);
}

function toDayKey(d){ return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }
function parseDayKey(key){ const [y,m,d]=key.split("-").map(Number); return new Date(y,m-1,d); }
function startOfDay(d){ return new Date(d.getFullYear(),d.getMonth(),d.getDate()); }
function isSameDay(a,b){ return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate(); }
function todayKey(){ return toDayKey(startOfDay(new Date())); }
function minDayKey(){ const d=startOfDay(new Date()); d.setDate(d.getDate()-HISTORY_DAYS); return toDayKey(d); }
function formatDayTitle(key){
  const d=parseDayKey(key), today=startOfDay(new Date());
  if(isSameDay(d,today))return"Today";
  const yest=new Date(today); yest.setDate(today.getDate()-1);
  if(isSameDay(d,yest))return"Yesterday";
  return DOW[d.getDay()]+" · "+MON[d.getMonth()]+" "+d.getDate();
}

function syncDayNav(){
  const isDay=viewMode==="day";
  $("dayNavWrap").classList.toggle("show", isDay);
  if(!isDay){ closeCal(); return; }
  if(!selectedDay) selectedDay=todayKey();
  const today=todayKey();
  $("dayLabelText").textContent=formatDayTitle(selectedDay);
  $("btnPrevDay").disabled=selectedDay<=minDayKey();
  $("btnNextDay").disabled=selectedDay>=today;
  $("btnToday").disabled=selectedDay===today;
  $("calHint").textContent="Last "+HISTORY_DAYS+" days";
}

function setMode(mode, dayKey){
  viewMode=mode;
  if(mode==="day") selectedDay=dayKey||selectedDay||todayKey();
  $("rangeSelector").querySelectorAll("button").forEach(b=>b.classList.toggle("on", b.dataset.mode===mode));
  syncDayNav();
  requestHisto();
}
function shiftDay(delta){
  const d=parseDayKey(selectedDay); d.setDate(d.getDate()+delta);
  const key=toDayKey(d);
  if(key>todayKey()||key<minDayKey()) return;
  setMode("day", key);
}

function closeCal(){ calOpen=false; $("calPopover").classList.remove("open"); $("btnDayLabel").classList.remove("open"); $("btnDayLabel").setAttribute("aria-expanded","false"); }
function openCal(){ const base=parseDayKey(selectedDay||todayKey()); calMonth=new Date(base.getFullYear(),base.getMonth(),1); calOpen=true; $("calPopover").classList.add("open"); $("btnDayLabel").classList.add("open"); $("btnDayLabel").setAttribute("aria-expanded","true"); renderCal(); }
function toggleCal(){ if(calOpen) closeCal(); else openCal(); }
function monthBounds(){ return { min: parseDayKey(minDayKey()), max: startOfDay(new Date()) }; }
function renderCal(){
  if(!calMonth) return;
  const {min,max}=monthBounds();
  const y=calMonth.getFullYear(), m=calMonth.getMonth();
  $("calTitle").textContent=MON[m]+" "+y;
  const first=new Date(y,m,1), startPad=first.getDay(), daysInMonth=new Date(y,m+1,0).getDate(), prevDays=new Date(y,m,0).getDate();
  const grid=$("calGrid"); grid.innerHTML="";
  const cells=[];
  for(let i=0;i<startPad;i++) cells.push({date:new Date(y,m-1,prevDays-startPad+1+i), muted:true});
  for(let d=1;d<=daysInMonth;d++) cells.push({date:new Date(y,m,d), muted:false});
  while(cells.length%7!==0){ const n=cells.length-startPad-daysInMonth+1; cells.push({date:new Date(y,m+1,n), muted:true}); }
  const today=startOfDay(new Date()), sel=selectedDay?parseDayKey(selectedDay):null;
  cells.forEach(cell=>{
    const key=toDayKey(cell.date);
    const btn=document.createElement("button");
    btn.type="button"; btn.className="cal-day"; btn.textContent=String(cell.date.getDate());
    if(cell.muted) btn.classList.add("muted");
    if(isSameDay(cell.date,today)) btn.classList.add("today");
    if(sel&&isSameDay(cell.date,sel)) btn.classList.add("sel");
    const sod=startOfDay(cell.date);
    if(sod<min||sod>max) btn.disabled=true;
    else btn.addEventListener("click",()=>{ closeCal(); setMode("day", key); });
    grid.appendChild(btn);
  });
  const monthStart=new Date(y,m,1), monthEnd=new Date(y,m+1,0);
  $("calPrev").disabled=monthEnd<min;
  $("calNext").disabled=monthStart>max;
  $("calJumpToday").disabled=selectedDay===todayKey();
}
function shiftCalMonth(delta){ if(!calMonth)return; calMonth=new Date(calMonth.getFullYear(),calMonth.getMonth()+delta,1); renderCal(); }

function showAuth(){
  const modal=$("auth-modal");
  if(modal.style.display==="flex") return;
  modal.style.display="flex";
  const inp=$("pwd-input"); inp.value=pwd; inp.classList.remove("error"); inp.focus();
}
async function savePwd(){
  const inp=$("pwd-input"); const newPwd=inp.value;
  if(AUTH_REQUIRED){
    try{
      const res=await fetch("/api/snapshot?pwd="+encodeURIComponent(newPwd));
      if(res.status===401){ inp.classList.remove("error"); void inp.offsetWidth; inp.classList.add("error"); inp.value=""; inp.placeholder="密码错误"; return; }
    }catch(e){ console.error(e); }
  }
  pwd=newPwd; localStorage.setItem("ws_pwd", pwd); $("auth-modal").style.display="none";
  if(ws){ ws.onclose=null; ws.close(); ws=null; }
  connect(); requestHisto();
}
$("pwd-input").addEventListener("keyup", e=>{ if(e.key==="Enter") savePwd(); });

function setOnline(on){ $("brandDot").classList.toggle("off", !on); $("statusText").textContent=on?"LIVE":"OFFLINE"; }

function connect(){
  if(ws) return;
  const protocol=location.protocol==="https:"?"wss://":"ws://";
  ws=new WebSocket(protocol+location.host+qs());
  ws.onopen=()=>{ setOnline(true); if(reconnectTimer){ clearInterval(reconnectTimer); reconnectTimer=null; } };
  ws.onmessage=ev=>{ try{ renderLive(JSON.parse(ev.data)); }catch(e){ console.error(e); } };
  ws.onclose=()=>{
    setOnline(false); ws=null;
    const handleReconnect=()=>{ if(!reconnectTimer) reconnectTimer=setInterval(connect,2000); };
    if(AUTH_REQUIRED){
      fetch("/api/snapshot?pwd="+encodeURIComponent(pwd)).then(res=>{
        if(res.status===401){ showAuth(); if(reconnectTimer){ clearInterval(reconnectTimer); reconnectTimer=null; } }
        else handleReconnect();
      }).catch(()=>handleReconnect());
    } else handleReconnect();
  };
  ws.onerror=()=>ws&&ws.close();
}

function renderLive(data){
  const items=data.items||[];
  liveItems=items;
  if(data.sys){
    $("sysIp").textContent=(data.sys.ip||"—")+(data.sys.port?(":"+data.sys.port):"");
    $("sysUptime").textContent=data.sys.uptime||"—";
    if(typeof data.sys.ramTotalGB==="number") ramTotalGB=data.sys.ramTotalGB;
  }
  const cpu=findItem(items,"CPU.Load"), cpuT=findItem(items,"CPU.Temp");
  const gpu=findItem(items,"GPU.Load"), gpuT=findItem(items,"GPU.Temp");
  const ram=findItem(items,"MEM.Load"), dn=findItem(items,"NET.Down"), up=findItem(items,"NET.Up");
  const cpuPct=cpu?(cpu.pct??itemRaw(cpu)):null;
  const gpuPct=gpu?(gpu.pct??itemRaw(gpu)):null;
  const ramPct=ram?(ram.pct??itemRaw(ram)):null;
  const cpuTemp=itemRaw(cpuT), gpuTemp=itemRaw(gpuT);
  setLive($("liveCpu"), cpuPct==null?"—":Math.round(cpuPct)+"%", sevPct(cpuPct));
  setLive($("liveCpuT"), fmtTemp(cpuTemp), cpuTemp==null?"neutral":sevTemp(cpuTemp));
  setLive($("liveGpu"), gpuPct==null?"—":Math.round(gpuPct)+"%", sevPct(gpuPct));
  setLive($("liveGpuT"), fmtTemp(gpuTemp), gpuTemp==null?"neutral":sevTemp(gpuTemp));
  setLive($("liveRam"), ramPct==null?"—":Math.round(ramPct)+"%", sevRam(ramPct));
  let ramSub="—";
  if(ram){
    if(ram.u&&ram.u!=="%"&&ram.v) ramSub=ram.v+" "+ram.u;
    else if(ramTotalGB>0&&ramPct!=null) ramSub=((ramPct/100)*ramTotalGB).toFixed(1)+" / "+ramTotalGB.toFixed(0)+" GB";
    else ramSub=itemText(ram);
  }
  setLive($("liveRamSub"), ramSub, ramPct==null?"neutral":sevRam(ramPct));
  setLive($("liveDn"), itemText(dn), dn?stsToSev(dn.sts):"neutral");
  setLive($("liveUp"), (dn||up)?("↑ "+itemText(up)):"—", "neutral");
  renderGroups(items);
  updatePanelInlines();
}

function renderGroups(items){
  const order=[]; const map={};
  items.forEach(it=>{
    if(HERO.has(it.k)) return;
    const gid=it.gid||"OTHER";
    if(!map[gid]){ map[gid]={ name: it.gn||gid, items:[], gidx: it.gidx??999 }; order.push(gid); }
    map[gid].items.push(it);
  });
  order.sort((a,b)=>(map[a].gidx)-(map[b].gidx));
  const root=$("groups"); root.innerHTML="";
  order.forEach(gid=>{
    const g=map[gid];
    const panel=document.createElement("div");
    panel.className="group-panel";
    panel.innerHTML=`<h3>${g.name}</h3><div class="group-grid"></div>`;
    const grid=panel.querySelector(".group-grid");
    g.items.forEach(it=>{
      const chip=document.createElement("div");
      chip.className="metric-chip";
      const sev=stsToSev(it.sts);
      chip.innerHTML=`<div class="k">${it.n||it.k}</div><div class="v ${sev==="neutral"?"":("sev-"+sev)}">${itemText(it)}</div>`;
      grid.appendChild(chip);
    });
    root.appendChild(panel);
  });
}

function levelFor(panel, b){
  if(!b||b.empty) return "empty";
  if(panel.kind==="volume") return "net";
  if(panel.kind==="value") return "ok";
  const p=bucketVal(b, panel.primary);
  const s=bucketVal(b, panel.secondary);
  if(panel.sev==="pctTemp"){
    let lv=p==null?"empty":sevPct(p);
    if(s!=null) lv=worse(lv==="empty"?"ok":lv, sevTemp(s));
    return lv==="neutral"?"ok":lv;
  }
  if(panel.sev==="ram") return p==null?"empty":sevRam(p);
  if(panel.sev==="bat") return p==null?"empty":sevBat(p);
  if(panel.sev==="temp") return p==null?"empty":sevTemp(p);
  if(panel.sev==="pct") return p==null?"empty":sevPct(p);
  return p==null?"empty":"ok";
}

function panelHasData(panel, flags){
  if(ALWAYS_PANELS.has(panel.id)) return true;
  if(panel.kind==="volume") return !!(flags[panel.a]||flags[panel.b]);
  return !!(flags[panel.primary]||(panel.secondary&&flags[panel.secondary]));
}

function ensurePanels(panels){
  const root=$("timelines");
  currentPanels=panels||[];
  const existing=new Set([...root.querySelectorAll(".metric-panel")].map(el=>el.dataset.id));
  currentPanels.forEach(p=>{
    if(existing.has(p.id)) return;
    const el=document.createElement("div");
    el.className="metric-panel";
    el.dataset.id=p.id;
    el.dataset.kind=p.kind;
    const right = p.kind==="volume"
      ? `<div class="totals" data-role="totals"><span class="dir">${p.aLabel||"A"}</span> <span data-role="totalA">—</span><span class="sep">·</span><span class="dir">${p.bLabel||"B"}</span> <span data-role="totalB">—</span></div>`
      : "";
    el.innerHTML =
      `<div class="metric-head"><div class="left"><h2>${p.title}</h2><span class="live-inline" data-role="inline">—</span></div>${right}</div>`+
      `<div class="bars ${p.kind==="volume"?"volume":""}" data-role="bars"></div>`+
      `<div class="bar-axis"><span class="axisL">—</span><span class="axisR">—</span></div>`+
      `<div class="metric-rule">${p.rule||""}</div>`+
      `<div class="bar-tip" data-role="tip"><div class="time" data-role="time">—</div><div class="status-row"><span class="status-dot ok" data-role="dot"></span><span class="status-label" data-role="label">—</span></div><div class="vals" data-role="vals"></div></div>`;
    root.appendChild(el);
    bindPanelBars(el, p);
  });
}

function liveInlineFor(panel){
  if(panel.kind==="volume"){
    return viewMode==="live"?"last 30 min":"day total";
  }
  if(panel.id==="cpu"){
    const a=$("liveCpu").textContent, b=$("liveCpuT").textContent;
    return `<span class="${$("liveCpu").className}">${a}</span><span class="sep">·</span><span class="${$("liveCpuT").className}">${b}</span>`;
  }
  if(panel.id==="gpu"){
    const a=$("liveGpu").textContent, b=$("liveGpuT").textContent;
    return `<span class="${$("liveGpu").className}">${a}</span><span class="sep">·</span><span class="${$("liveGpuT").className}">${b}</span>`;
  }
  if(panel.id==="ram"){
    return `<span class="${$("liveRam").className}">${$("liveRam").textContent}</span><span class="sep">·</span><span class="${$("liveRamSub").className}">${$("liveRamSub").textContent}</span>`;
  }
  const it=findItem(liveItems, panel.primary);
  if(!it) return "—";
  const sev=stsToSev(it.sts);
  return `<span class="${sev==="neutral"?"":("sev-"+sev)}">${itemText(it)}</span>`;
}

function updatePanelInlines(){
  currentPanels.forEach(p=>{
    const el=document.querySelector(`.metric-panel[data-id="${p.id}"]`);
    if(!el) return;
    const inline=el.querySelector('[data-role="inline"]');
    if(inline) inline.innerHTML=liveInlineFor(p);
  });
}

function renderTimelines(data){
  currentBuckets=data.buckets||[];
  currentFlags=data.flags||{};
  if(typeof data.retentionDays==="number") HISTORY_DAYS=data.retentionDays;
  ensurePanels(data.panels||[]);
  document.querySelectorAll(".axisL").forEach(el=>el.textContent=data.axisL||"—");
  document.querySelectorAll(".axisR").forEach(el=>el.textContent=data.axisR||"—");

  currentPanels.forEach(panel=>{
    const el=document.querySelector(`.metric-panel[data-id="${panel.id}"]`);
    if(!el) return;
    const show=panelHasData(panel, currentFlags);
    el.classList.toggle("hidden", !show);
    if(!show) return;
    const barsEl=el.querySelector('[data-role="bars"]');
    barsEl.innerHTML="";
    if(panel.kind==="volume"){
      const withData=currentBuckets.filter(b=>!b.empty);
      const maxBytes=Math.max(1, ...withData.map(b=>bucketBytes(b,panel.a)+bucketBytes(b,panel.b)));
      let totA=0, totB=0;
      currentBuckets.forEach((b,i)=>{
        const bar=document.createElement("div");
        if(b.empty){ bar.className="bar empty"; bar.style.height="3px"; }
        else {
          const total=bucketBytes(b,panel.a)+bucketBytes(b,panel.b);
          totA+=bucketBytes(b,panel.a); totB+=bucketBytes(b,panel.b);
          bar.className="bar"; bar.style.height=Math.max(4, Math.round((total/maxBytes)*36))+"px";
        }
        bar.dataset.i=i; barsEl.appendChild(bar);
      });
      const tA=el.querySelector('[data-role="totalA"]'); const tB=el.querySelector('[data-role="totalB"]');
      if(tA) tA.textContent=fmtBytes(totA); if(tB) tB.textContent=fmtBytes(totB);
    } else {
      currentBuckets.forEach((b,i)=>{
        const lv=levelFor(panel,b);
        const bar=document.createElement("div");
        bar.className="bar "+(lv==="net"?"ok":lv);
        bar.dataset.i=i; barsEl.appendChild(bar);
      });
    }
  });
  updatePanelInlines();
  renderStats(data.stats||{});
  $("footInfo").textContent =
    (data.bucketCount||0)+" buckets · "+(data.pointCount||0)+" samples · "+
    (viewMode==="live"?"live 30m":(selectedDay+" 24h"))+" · "+
    currentPanels.filter(p=>panelHasData(p,currentFlags)).length+" timelines";
}

function renderStats(stats){
  const row=$("statsRow"); row.innerHTML="";
  const keys=[
    ["CPU.Load","CPU",true],["CPU.Temp","CPU°",false],
    ["GPU.Load","GPU",true],["GPU.Temp","GPU°",false],
    ["MEM.Load","RAM",true],["GPU.VRAM","VRAM",true],
    ["FPS","FPS",false],["CPU.Power","CPU W",false],["GPU.Power","GPU W",false]
  ];
  keys.forEach(([key,label,isPct])=>{
    const s=stats[key]; if(!s||(s.max==null&&s.avg==null)) return;
    if((s.max??-1)<0 && (s.avg??-1)<0) return;
    const fmt = key.includes("Temp")?fmtTemp : (isPct?fmtPct:(v=>fmtValue(v, key.includes("Power")?"W":(key==="FPS"?"FPS":"auto"))));
    const sev = key.includes("Temp")?sevTemp:(isPct?(key.includes("BAT")?sevBat:(key.includes("MEM")||key.includes("VRAM")?sevRam:sevPct)):(()=>"ok"));
    const div=document.createElement("div");
    div.className="stat";
    div.innerHTML=`${label} max <span class="v ${sevCls(sev(s.max))}">${fmt(s.max)}</span>  avg <span class="v ${sevCls(sev(s.avg))}">${fmt(s.avg)}</span>`;
    row.appendChild(div);
  });
  let dn=0, up=0;
  currentBuckets.forEach(b=>{ if(!b.empty){ dn+=bucketBytes(b,"NET.Down"); up+=bucketBytes(b,"NET.Up"); } });
  if(dn>0||up>0){
    const div=document.createElement("div");
    div.className="stat";
    div.innerHTML=`NET ↓ <span class="v">${fmtBytes(dn)}</span>  ↑ <span class="v">${fmtBytes(up)}</span>  Σ <span class="v">${fmtBytes(dn+up)}</span>`;
    row.appendChild(div);
  }
}

function bucketTimeLabel(i,n){
  if(viewMode==="day") return pad2(i)+":00 – "+pad2(i===23?24:i+1)+":00";
  const mins=Math.round((1-i/n)*30);
  return mins>0? mins+" min ago":"Now";
}

function tipContent(panel,b){
  if(!b||b.empty) return [pill("No samples","neutral")];
  if(panel.kind==="volume"){
    const a=bucketBytes(b,panel.a), bb=bucketBytes(b,panel.b);
    return [pill((panel.aLabel||"A")+" "+fmtBytes(a),"neutral"), pill((panel.bLabel||"B")+" "+fmtBytes(bb),"neutral"), pill("Σ "+fmtBytes(a+bb),"neutral")];
  }
  const pills=[];
  const p=bucketVal(b,panel.primary);
  const s=bucketVal(b,panel.secondary);
  if(panel.sev==="pctTemp"){
    pills.push(pill(fmtPct(p)+" util", sevPct(p)));
    pills.push(s==null?pill("Temp unavailable","neutral"):pill(fmtTemp(s), sevTemp(s)));
  } else if(panel.sev==="temp"){
    pills.push(pill(fmtTemp(p), sevTemp(p)));
  } else if(panel.sev==="ram"||panel.sev==="pct"||panel.sev==="bat"){
    const fn = panel.sev==="ram"?sevRam:(panel.sev==="bat"?sevBat:sevPct);
    pills.push(pill(fmtPct(p), fn(p)));
  } else {
    pills.push(pill(fmtValue(p, panel.fmt||"auto"), "neutral"));
  }
  return pills;
}

function bindPanelBars(el, panel){
  const barsEl=el.querySelector('[data-role="bars"]');
  const tip=el.querySelector('[data-role="tip"]');
  barsEl.addEventListener("mousemove", e=>{
    const bar=e.target.closest(".bar"); if(!bar) return;
    barsEl.querySelectorAll(".bar").forEach(x=>x.classList.remove("on"));
    bar.classList.add("on");
    const b=currentBuckets[+bar.dataset.i]; if(!b) return;
    const i=+bar.dataset.i;
    const lv=levelFor(panel,b);
    const isVol=panel.kind==="volume";
    tip.querySelector('[data-role="time"]').textContent=bucketTimeLabel(i, currentBuckets.length);
    tip.querySelector('[data-role="dot"]').className="status-dot "+(b.empty?"empty":(isVol?"net":lv));
    const label=tip.querySelector('[data-role="label"]');
    label.textContent=b.empty?"No data":(isVol?"Traffic":(ST[lv]?ST[lv].label:lv));
    label.className="status-label "+(b.empty||isVol||lv==="empty"?"neutral":sevCls(lv));
    tip.querySelector('[data-role="vals"]').innerHTML=tipContent(panel,b).join("");
    tip.classList.add("show");
    const hr=el.getBoundingClientRect(), br=bar.getBoundingClientRect();
    let left=br.left-hr.left+br.width/2-(tip.offsetWidth||200)/2;
    left=Math.max(4, Math.min(left, hr.width-(tip.offsetWidth||200)-4));
    tip.style.left=left+"px";
    tip.style.bottom=(hr.height-(br.top-hr.top)+10)+"px";
  });
  barsEl.addEventListener("mouseleave",()=>{ tip.classList.remove("show"); barsEl.querySelectorAll(".bar").forEach(x=>x.classList.remove("on")); });
}

function setRefreshBusy(on){ const btn=$("btnRefresh"); btn.disabled=on; btn.classList.toggle("spinning",on); }

async function requestHisto(){
  if(busy) return;
  busy=true; setRefreshBusy(true);
  try{
    let url="/api/history?mode="+encodeURIComponent(viewMode);
    if(viewMode==="day") url+="&day="+encodeURIComponent(selectedDay||todayKey());
    const res=await fetch(withPwd(url));
    if(res.status===401){ showAuth(); return; }
    const data=await res.json();
    renderTimelines(data);
    syncDayNav();
  }catch(e){ console.error(e); $("footInfo").textContent="History unavailable"; }
  finally{ busy=false; setRefreshBusy(false); }
}

$("btnRefresh").addEventListener("click",()=>requestHisto());
$("btnOpenData").addEventListener("click", async()=>{ try{ await fetch(withPwd("/api/history/open")); }catch(e){} });
$("btnClearData").addEventListener("click", async()=>{
  if(!confirm("清空全部监控历史？此操作不可撤销。")) return;
  try{ await fetch(withPwd("/api/history/clear")); requestHisto(); }catch(e){}
});
$("rangeSelector").querySelectorAll("button").forEach(btn=>{
  btn.addEventListener("click",()=>{ if(btn.dataset.mode==="live") setMode("live"); else setMode("day", selectedDay||todayKey()); });
});
$("btnPrevDay").addEventListener("click",()=>shiftDay(-1));
$("btnNextDay").addEventListener("click",()=>shiftDay(1));
$("btnToday").addEventListener("click",()=>{ closeCal(); setMode("day", todayKey()); });
$("btnDayLabel").addEventListener("click", e=>{ e.stopPropagation(); toggleCal(); });
$("calPopover").addEventListener("click", e=>e.stopPropagation());
$("calPrev").addEventListener("click",()=>shiftCalMonth(-1));
$("calNext").addEventListener("click",()=>shiftCalMonth(1));
$("calJumpToday").addEventListener("click",()=>{ closeCal(); setMode("day", todayKey()); });
document.addEventListener("click",()=>{ if(calOpen) closeCal(); });
document.addEventListener("keydown", e=>{ if(e.key==="Escape"&&calOpen) closeCal(); });

function tick(){ $("clock").textContent=new Date().toLocaleTimeString("zh-CN",{hour12:false}); }
setInterval(tick,1000); tick();
connect(); requestHisto();
setInterval(requestHisto, 60000);
