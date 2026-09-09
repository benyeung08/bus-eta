"use strict";
/* ============================================================
   香港出行易 · 交通查閱  —  單檔網頁應用
   資料源：data.gov.hk 開放資料（免 API key）
   ============================================================ */

const $  = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>[...r.querySelectorAll(s)];
const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep = ms => new Promise(r=>setTimeout(r,ms));

/* ---------------- 網路層：直連 + CORS 代理備援 ---------------- */
const PROXIES = [
  {n:'直連',        f:u=>u},
  {n:'AllOrigins',  f:u=>'https://api.allorigins.win/raw?url='+encodeURIComponent(u)},
  {n:'CodeTabs',    f:u=>'https://api.codetabs.com/v1/proxy?quest='+encodeURIComponent(u)},
  {n:'corsproxy',   f:u=>'https://corsproxy.io/?url='+encodeURIComponent(u)},
];
const SETTINGS = Object.assign({
  proxy:'auto', customProxy:'', refresh:20, theme:'auto',
  autoNearby:1, nearRadius:700, nearRoutes:1
}, JSON.parse(localStorage.getItem('hkT.set')||'{}'));
function saveSettings(){ localStorage.setItem('hkT.set', JSON.stringify(SETTINGS)); }

function proxyOrder(){
  if(SETTINGS.customProxy) return [{n:'自訂',f:u=>SETTINGS.customProxy+encodeURIComponent(u)}, ...PROXIES];
  if(SETTINGS.proxy && SETTINGS.proxy!=='auto'){ const i=+SETTINGS.proxy; return [PROXIES[i], ...PROXIES.filter((_,j)=>j!==i)]; }
  return PROXIES.slice();
}
let LAST_PROXY = '直連';

async function getJSON(url, {timeout=20000, tries=null}={}){
  const order = tries || proxyOrder();
  let lastErr;
  for(const p of order){
    const ac = new AbortController();
    const t = setTimeout(()=>ac.abort(), timeout);
    try{
      const r = await fetch(p.f(url), {cache:'no-store', signal:ac.signal, headers:{'Accept':'application/json, text/plain, */*'}});
      clearTimeout(t);
      // 404/410 = 網址本身不對，換代理也一樣；403/429 可能是代理被擋或限速，值得換一條試
      if(r.status===404 || r.status===410) throw Object.assign(new Error('HTTP '+r.status+'（端點不存在）'), {fatal:true});
      if(!r.ok) throw new Error('HTTP '+r.status);
      const txt = await r.text();
      let j; try{ j = JSON.parse(txt); }catch(e){ throw new Error('非 JSON 回應'); }
      LAST_PROXY = p.n;
      return j;
    }catch(e){ clearTimeout(t); lastErr = e; if(e.fatal) break; }
  }
  throw lastErr || new Error('無法連線');
}
/* 多端點備援：逐一嘗試，全失敗才丟錯 */
async function getJSONAny(urls, opts){
  let last;
  for(const u of [].concat(urls)){
    try{ return await getJSON(u, opts); }catch(e){ last = e; }
  }
  throw last || new Error('所有端點皆失敗');
}
/* 純文字（CSV） */
async function getText(url, {timeout=30000, tries=null}={}){
  const order = tries || proxyOrder();
  let lastErr;
  for(const p of order){
    const ac = new AbortController();
    const t = setTimeout(()=>ac.abort(), timeout);
    try{
      const r = await fetch(p.f(url), {cache:'no-store', signal:ac.signal,
                                       headers:{'Accept':'text/csv, text/plain, */*'}});
      clearTimeout(t);
      if(r.status===404 || r.status===410) throw Object.assign(new Error('HTTP '+r.status), {fatal:true});
      if(!r.ok) throw new Error('HTTP '+r.status);
      let txt = await r.text();
      if(!txt || txt.length<10) throw new Error('空白回應');
      // 部分代理會把純文字包成 JSON 字串或 {contents:…}，解開後才是有用的 CSV
      const tr = txt.trim();
      if(tr[0]==='"' && tr[tr.length-1]==='"'){
        try{ const v = JSON.parse(tr); if(typeof v==='string') txt = v; }catch(e){}
      } else if(tr[0]==='{'){
        try{
          const v = JSON.parse(tr);
          for(const k of ['contents','content','data','body','text'])
            if(typeof v[k]==='string' && v[k].length>10){ txt = v[k]; break; }
        }catch(e){}
      }
      LAST_PROXY = p.n;
      return txt;
    }catch(e){ clearTimeout(t); lastErr = e; if(e.fatal) break; }
  }
  throw lastErr || new Error('無法連線');
}
/* POST JSON：港鐵巴士到站 API 只接受 POST */
async function postJSON(url, body, {timeout=20000, tries=null}={}){
  const order = tries || proxyOrder();
  let lastErr;
  for(const p of order){
    const ac = new AbortController();
    const t = setTimeout(()=>ac.abort(), timeout);
    try{
      const r = await fetch(p.f(url), {
        method:'POST', cache:'no-store', signal:ac.signal,
        headers:{'Content-Type':'application/json','Accept':'application/json'},
        body: JSON.stringify(body)
      });
      clearTimeout(t);
      const txt = await r.text();
      let j; try{ j = JSON.parse(txt); }catch(e){ throw new Error('非 JSON 回應'); }
      LAST_PROXY = p.n;
      return j;
    }catch(e){ clearTimeout(t); lastErr = e; }
  }
  throw lastErr || new Error('無法連線');
}
async function cachedText(url, ttl, opts){
  const hit = await DB.get(url, ttl);
  if(typeof hit==='string') return hit;
  try{
    const t = await getText(url, opts || {timeout:30000});
    await DB.set(url, t);
    return t;
  }catch(e){
    const stale = await DB.getStale(url);
    if(typeof stale==='string') return stale;
    throw e;
  }
}
/* ---- CSV 解析（港鐵開放資料用 CSV，欄位名可能中英混用） ---- */
function parseCSV(text){
  const rows = []; let row = [], cur = '', q = false;
  for(let i=0;i<text.length;i++){
    const c = text[i];
    if(q){
      if(c==='"'){ if(text[i+1]==='"'){ cur+='"'; i++; } else q=false; }
      else cur += c;
    } else {
      if(c==='"') q = true;
      else if(c===','){ row.push(cur); cur=''; }
      else if(c==='\n'){ row.push(cur); rows.push(row); row=[]; cur=''; }
      else if(c==='\r'){ /* 略過 */ }
      else cur += c;
    }
  }
  if(cur!=='' || row.length){ row.push(cur); rows.push(row); }
  return rows.filter(r=>r.some(c=>String(c).trim()!==''));
}
/* 寬容欄位比對：去掉非英數字元後看是否包含關鍵字 */
function csvCol(headers, ...keys){
  const nm = h => String(h||'').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g,'');
  const hs = headers.map(nm);
  for(const k of keys){
    const nk = nm(k);
    for(let i=0;i<hs.length;i++) if(hs[i]===nk || hs[i].includes(nk)) return i;
  }
  return -1;
}

/* ---------------- 快取層（IndexedDB，供大量路線資料） ---------------- */
const DB=(function(){
  let dbp=null;
  function open(){
    if(dbp) return dbp;
    dbp = new Promise((res,rej)=>{
      const rq = indexedDB.open('hkTransport',1);
      rq.onupgradeneeded = e => e.target.result.createObjectStore('c');
      rq.onsuccess = e => res(e.target.result);
      rq.onerror = () => rej(rq.error);
    }).catch(()=>null);
    return dbp;
  }
  return {
    async get(k, ttlMs){
      try{
        const db = await open(); if(!db) return null;
        return await new Promise(res=>{
          const rq = db.transaction('c','readonly').objectStore('c').get(k);
          rq.onsuccess=()=>{ const v=rq.result; res(v && (Date.now()-v.t<ttlMs) ? v.d : null); };
          rq.onerror=()=>res(null);
        });
      }catch(e){ return null; }
    },
    /* 網路失敗時退回舊快取，避免整頁無資料可用 */
    async getStale(k){
      try{
        const db = await open(); if(!db) return null;
        return await new Promise(res=>{
          const rq = db.transaction('c','readonly').objectStore('c').get(k);
          rq.onsuccess=()=>res(rq.result ? rq.result.d : null);
          rq.onerror=()=>res(null);
        });
      }catch(e){ return null; }
    },
    async set(k,d){
      try{
        const db = await open(); if(!db) return;
        db.transaction('c','readwrite').objectStore('c').put({t:Date.now(),d}, k);
      }catch(e){}
    },
    async clear(){
      try{ const db=await open(); if(!db) return; db.transaction('c','readwrite').objectStore('c').clear(); }catch(e){}
      localStorage.removeItem('hkT.set');
    }
  };
})();

/* ---------------- API 端點 ---------------- */
const EP = {
  kmbRoute:'https://data.etabus.gov.hk/v1/transport/kmb/route/',
  kmbStop :'https://data.etabus.gov.hk/v1/transport/kmb/stop/',
  kmbRS   :'https://data.etabus.gov.hk/v1/transport/kmb/route-stop/',
  kmbStopEta:(s)=>`https://data.etabus.gov.hk/v1/transport/kmb/stop-eta/${s}`,
  kmbEta  :(s,r,st)=>`https://data.etabus.gov.hk/v1/transport/kmb/eta/${s}/${r}/${st}`,

  ctbRoute:['https://rt.data.gov.hk/v2/transport/citybus/route/CTB',
            'https://rt.data.gov.hk/v2/transport/citybus/route/ctb'],
  ctbStop :'https://rt.data.gov.hk/v2/transport/citybus/stop',
  ctbRS   :(r,d)=>`https://rt.data.gov.hk/v2/transport/citybus/route-stop/CTB/${encodeURIComponent(r)}/${d}`,
  ctbEta  :(s,r)=>`https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/${s}/${encodeURIComponent(r)}`,
  ctbStopRoute:[ (s)=>`https://rt.data.gov.hk/v1.1/transport/batch/stoproute/CTB/${s}`,
                 (s)=>`https://rt.data.gov.hk/v2/transport/citybus/stop-route/CTB/${s}` ],

  nlbRoute:'https://rt.data.gov.hk/v2/transport/nlb/route.php?action=list',
  nlbRS   :(id)=>`https://rt.data.gov.hk/v2/transport/nlb/stop.php?action=list&routeId=${id}`,
  nlbEta  :(r,s)=>`https://rt.data.gov.hk/v2/transport/nlb/stop.php?action=estimatedArrivals&routeId=${r}&stopId=${s}&language=zh`,

  gmbRoute:'https://data.etagmb.gov.hk/route',
  gmbStop :'https://data.etagmb.gov.hk/stop',
  gmbRS   :(id)=>`https://data.etagmb.gov.hk/route-stop/${id}`,
  gmbRS2  :(id,seq)=>`https://data.etagmb.gov.hk/route-stop/${id}/${seq}`,
  gmbEta  :(r,s)=>`https://data.etagmb.gov.hk/eta/route-stop/${r}/${s}`,
  // 「個別小巴站的路線」正確端點是 /stop-route/（/stop/ 只回傳該站基本資料）
  gmbStopRoute:[ (s)=>`https://data.etagmb.gov.hk/stop-route/${s}`,
                 (s)=>`https://data.etagmb.gov.hk/stop/${s}` ],
  // 官方只有「路線＋站」的到站端點（hkbus/hk-bus-eta 用法），沒有整站批次端點
  gmbEtaAlts:(r,s)=>[`https://data.etagmb.gov.hk/eta/route-stop/${r}/${s}`],

  mtrSched:(line,sta)=>`https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=${line}&sta=${sta}&lang=TC`,

  /* 港鐵巴士／接駁巴士：路線與車站只有 CSV，到站是 POST API，與其他營辦商不同 */
  mtrbRouteCsv:'https://opendata.mtr.com.hk/data/mtr_bus_routes.csv',
  mtrbStopCsv :'https://opendata.mtr.com.hk/data/mtr_bus_stops.csv',
  mtrbEta     :'https://rt.data.gov.hk/v1/transport/mtr/bus/getSchedule',

  /* 輕鐵：到站 API（station_id 為數字編號），車站 CSV 有編號／名稱／路線，但沒有座標 */
  lrtEta      :(raw)=>`https://rt.data.gov.hk/v1/transport/mtr/lrt/getSchedule?station_id=${encodeURIComponent(raw)}&with_special=1`,
  /* CSV 抓不到時的備援路線清單（取自港鐵 API 規格書） */
  MTRB_FALLBACK:['506','K12','K14','K17','K18','K51','K51A','K52','K52A','K53','K54','K54A',
                 'K58','K65','K65A','K66','K68','K73','K74','K75A','K75P','K76'],
  mtrSchedAlts:(line,sta)=>[`https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=${line}&sta=${sta}&lang=TC`,
                            `https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=${line}&sta=${sta}&lang=tc`],
};
const CO_NAME = {KMB:'九巴/龍運', CTB:'城巴', NLB:'嶼巴', GMB:'專線小巴', MTRB:'港鐵巴士',
                 MTR:'港鐵重鐵', LRT:'輕鐵', FERRY:'渡輪'};
const CO_CLS  = {KMB:'kmb', CTB:'ctb', NLB:'nlb', GMB:'gmb', MTRB:'mtrb', MTR:'mtr', LRT:'lrt', FERRY:'ferry'};

/* ---------------- 港鐵內建資料（車站、所屬線、座標） ---------------- */
/* [代碼, 中文, 英文, 緯度, 經度] */
const MTR_LINES = [
  {code:'ISL', name:'港島綫', color:'#0075C1', st:[
    ['KET','堅尼地城',22.28121,114.1284],['HKU','香港大學',22.28405,114.13556],['SYP','西營盤',22.28551,114.1427],
    ['SHW','上環',22.2866,114.15201],['CEN','中環',22.28215,114.15768],['ADM','金鐘',22.27942,114.16435],
    ['WAC','灣仔',22.27755,114.17263],['CAB','銅鑼灣',22.28019,114.18424],['TIH','天后',22.28224,114.19185],
    ['FOH','炮台山',22.28791,114.19359],['NOP','北角',22.29118,114.20039],['QUB','鰂魚涌',22.28857,114.2087],
    ['TAK','太古',22.28465,114.21648],['SWH','西灣河',22.28218,114.22182],['SKW','筲箕灣',22.27923,114.22895],
    ['HFC','杏花邨',22.27664,114.23971],['CHW','柴灣',22.26458,114.23711]]},
  {code:'TWL', name:'荃灣綫', color:'#E1002A', st:[
    ['CEN','中環',22.28215,114.15768],['ADM','金鐘',22.27942,114.16435],['TST','尖沙咀',22.2977,114.17218],
    ['JOR','佐敦',22.30481,114.17165],['YMT','油麻地',22.31283,114.17066],['MOK','旺角',22.3193,114.16935],
    ['PRE','太子',22.32441,114.16828],['SSP','深水埗',22.33089,114.16212],['CSW','長沙灣',22.33555,114.15605],
    ['LCK','荔枝角',22.33725,114.14796],['MEF','美孚',22.33793,114.13639],['LAK','荔景',22.34834,114.12619],
    ['KWF','葵芳',22.3568,114.12779],['KWH','葵興',22.36307,114.13122],['TWH','大窩口',22.37076,114.12501],
    ['TSW','荃灣',22.37352,114.11808]]},
  {code:'KTL', name:'觀塘綫', color:'#00A650', st:[
    ['WHA','黃埔',22.30481,114.18983],['HOM','何文田',22.30939,114.18259],['YMT','油麻地',22.31283,114.17066],
    ['MOK','旺角',22.3193,114.16935],['PRE','太子',22.32441,114.16828],['SKM','石硤尾',22.33179,114.16882],
    ['KOT','九龍塘',22.33712,114.17578],['LOF','樂富',22.33801,114.18703],['WTS','黃大仙',22.34168,114.19387],
    ['DIH','鑽石山',22.34003,114.20165],['CHH','彩虹',22.33497,114.20904],['KOB','九龍灣',22.32346,114.214],
    ['NTK','牛頭角',22.3155,114.21898],['KWT','觀塘',22.31209,114.2265],['LAT','藍田',22.30683,114.23274],
    ['YAT','油塘',22.298,114.237],['TIK','調景嶺',22.30426,114.25264]]},
  {code:'TKL', name:'將軍澳綫', color:'#7A3285', st:[
    ['NOP','北角',22.29118,114.20039],['QUB','鰂魚涌',22.28857,114.2087],['YAT','油塘',22.298,114.237],
    ['TIK','調景嶺',22.30426,114.25264],['TKO','將軍澳',22.30744,114.26001],['HAH','坑口',22.31574,114.26431],
    ['POA','寶琳',22.32256,114.25787],['LHP','康城',22.29559,114.26873]], br:['LHP'], x:[['TKO','LHP']]},
  {code:'TCL', name:'東涌綫', color:'#F79433', st:[
    ['HOK','香港',22.28467,114.15822],['KOW','九龍',22.30426,114.16144],['OLY','奧運',22.31779,114.16025],
    ['NAC','南昌',22.32688,114.1535],['LAK','荔景',22.34834,114.12619],['TSY','青衣',22.3584,114.10728],
    ['SUN','欣澳',22.33211,114.02904],['TUC','東涌',22.28918,113.94127]]},
  {code:'AEL', name:'機場快綫', color:'#00888F', st:[
    ['HOK','香港',22.28467,114.15822],['KOW','九龍',22.30426,114.16144],['TSY','青衣',22.3584,114.10728],
    ['AIR','機場',22.31592,113.93648],['AWE','博覽館',22.32175,113.94123]]},
  {code:'DRL', name:'迪士尼綫', color:'#F576A6', st:[
    ['SUN','欣澳',22.33211,114.02904],['DIS','迪士尼',22.31549,114.04485]]},
  {code:'EAL', name:'東鐵綫', color:'#5CB7E8', st:[
    ['ADM','金鐘',22.27942,114.16435],['EXC','會展',22.28165,114.17531],['HUH','紅磡',22.30299,114.18218],
    ['MKK','旺角東',22.32202,114.17259],['KOT','九龍塘',22.33712,114.17578],['TAW','大圍',22.37276,114.17869],
    ['SHT','沙田',22.38213,114.18691],['FOT','火炭',22.39582,114.1985],['RAC','馬場',22.3995,114.2050],
    ['UNI','大學',22.41366,114.21004],['TAP','大埔墟',22.44458,114.17039],['TWO','太和',22.45107,114.16118],
    ['FAN','粉嶺',22.4921,114.13867],['SHS','上水',22.50162,114.12753],['LOW','羅湖',22.52764,114.11323],
    ['LMC','落馬洲',22.51447,114.06569]], br:['LMC'], x:[['SHS','LMC']]},
  {code:'TML', name:'屯馬綫', color:'#923011', st:[
    ['WKS','烏溪沙',22.42915,114.24385],['MOS','馬鞍山',22.42491,114.23198],['HEO','恆安',22.41786,114.22588],
    ['TSH','大水坑',22.40819,114.2226],['SHM','石門',22.38788,114.20852],['CIO','第一城',22.38296,114.20363],
    ['STW','沙田圍',22.37691,114.19481],['CKT','車公廟',22.37477,114.18589],['TAW','大圍',22.37276,114.17869],
    ['HIK','顯徑',22.36372,114.17074],['DIH','鑽石山',22.34003,114.20165],['KAT','啟德',22.33042,114.19935],
    ['SUW','宋皇臺',22.32562,114.19061],['TKW','土瓜灣',22.31791,114.18762],['HOM','何文田',22.30939,114.18259],
    ['HUH','紅磡',22.30299,114.18218],['ETS','尖東',22.29531,114.17465],['AUS','柯士甸',22.30491,114.16632],
    ['NAC','南昌',22.32688,114.1535],['MEF','美孚',22.33793,114.13639],['TWW','荃灣西',22.36839,114.10966],
    ['KSR','錦上路',22.43513,114.06318],['YUL','元朗',22.44607,114.03517],['LOP','朗屏',22.44763,114.02545],
    ['TIS','天水圍',22.44788,114.00447],['SIH','兆康',22.41153,113.9788],['TUM','屯門',22.39511,113.97319]]},
  {code:'SIL', name:'南港島綫', color:'#BAC533', st:[
    ['ADM','金鐘',22.27942,114.16435],['OCP','海洋公園',22.2487,114.17432],['WCH','黃竹坑',22.24798,114.16799],
    ['LET','利東',22.24184,114.156],['SOH','海怡半島',22.24284,114.14884]]},
];
const MTR_ST = {};   // code -> {tc, lines:[], lat, lng}
MTR_LINES.forEach(L=>L.st.forEach(([c,tc,lat,lng])=>{
  if(!MTR_ST[c]) MTR_ST[c]={tc, lat, lng, lines:[]};
  if(!MTR_ST[c].lines.includes(L.code)) MTR_ST[c].lines.push(L.code);
}));
const lineOf = c => MTR_LINES.find(L=>L.code===c);
/* 各綫平均每站行車分鐘（依實際行車時間估算）；換綫步行分鐘；站內步行轉乘分鐘 */
const LINE_MIN     = {ISL:2.1, TWL:2.0, KTL:2.1, TKL:2.4, TCL:3.0, AEL:8.0, DRL:4.0, EAL:2.8, TML:2.6, SIL:2.3};
const TRANSFER_MIN = 5;
const hopMin = ln => LINE_MIN[ln] || 2.2;
/* 付費區內／站內步行轉乘：[站A, 站B, 分鐘] */
const WALK_LINKS = {};
[['CEN','HOK',7]].forEach(([a,b,c])=>{ (WALK_LINKS[a] ||= []).push([b,c]); (WALK_LINKS[b] ||= []).push([a,c]); });

/* ---------------- 通用小工具 ---------------- */
function dist(a,b,c,d){ // 米（Haversine）
  const R=6371000, r=Math.PI/180;
  const dLat=(c-a)*r, dLng=(d-b)*r;
  const h=Math.sin(dLat/2)**2 + Math.cos(a*r)*Math.cos(c*r)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
function nowMs(){ return Date.now(); }
function minsTo(iso){
  if(!iso) return null;
  let d = new Date(iso);
  if(isNaN(d)) { // 2023-07-20 12:34:56 （視為香港時間）
    const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if(!m) return null;
    d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]||'00'}+08:00`);
    if(isNaN(d)) return null;
  }
  return Math.round((d.getTime()-nowMs())/60000);
}
function hhmm(iso){
  let d=new Date(iso);
  if(isNaN(d)){
    const m=String(iso).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if(!m) return '';
    return m[4]+':'+m[5];
  }
  return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}
function toMin(v){
  if(v===null || v===undefined || v==='') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function etaHtml(min, iso){
  const m = toMin(min);
  if(m===null) return '<span class="eta none">暫無班次</span>';
  if(m<=-1)    return '<span class="eta none">已過站</span>';
  if(m<=0)     return '<span class="eta soon">即將抵達</span>';
  const cls = m<=5?'soon':(m<=15?'mid':'');
  return `<span class="eta ${cls}">${m} 分</span>` +
         (iso?`<span class="tiny muted" style="margin-left:5px">${hhmm(iso)}</span>`:'');
}
const norm = s => String(s||'').toLowerCase().replace(/\s+/g,'').replace(/[（）()]/g,'');

/* 限制同時併發數，避免對開放資料 API 造成壓力／觸發 429 */
async function pool(items, n, fn){
  const out = new Array(items.length);
  let k = 0;
  const workers = Array.from({length:Math.min(n, items.length)}, async ()=>{
    for(;;){
      const i = k++; if(i>=items.length) return;
      try{ out[i] = await fn(items[i], i); }
      catch(e){ out[i] = undefined; }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ============================================================
   資料載入：九巴 / 城巴 / 小巴 / 嶼巴
   ============================================================ */
const D = {
  KMB:{route:null, stop:null, rs:null, stopById:null, routesAtStop:null, seqOf:null, ready:false},
  CTB:{route:null, stop:null, stopById:null, ready:false},
  GMB:{route:null, stop:null, stopById:null, ready:false},
  NLB:{route:null, ready:false},
  MTRB:{},
  MTR :{route:null, stop:null, stopById:null, routesAtStop:null, ready:false},
  LRT :{route:null, stop:null, stopById:null, routesAtStop:null, ready:false},
  FERRY:{route:null, stop:null, stopById:null, routesAtStop:null, ready:false},
};
let busDataLoaded = false, loading = false;
const loadListeners = [];
function onLoad(fn){ loadListeners.push(fn); }

/* 不同 API 會把清單包在不同欄位，統一解析成陣列 */
const ARR_KEYS = ['data','stops','routes','route_list','route_stops','estimatedArrivals','stopList','stop','route','eta'];
function asArray(x, depth){
  if(x===null || x===undefined) return [];
  if(Array.isArray(x)) return x;
  if(typeof x!=='object' || (depth||0)>3) return [x];
  for(const k of ARR_KEYS) if(Array.isArray(x[k])) return x[k];      // data / stops / routes …
  for(const k of ARR_KEYS) if(x[k] && typeof x[k]==='object'){        // data:{routes:[…]}
    const r = asArray(x[k], (depth||0)+1); if(r.length) return r;
  }
  for(const k of Object.keys(x)){                                    // 其它未知欄位
    const v = x[k];
    if(Array.isArray(v) && v.length && typeof v[0]==='object') return v;
  }
  return [x];
}
/* 欄位別名：不同營辦商對同一欄位命名不一 */
const pick = (o, ...ks)=>{ for(const k of ks){ const v=o?.[k]; if(v!==undefined && v!==null && v!=='') return v; } return undefined; };
/* 只取最外層的資料陣列，不遞迴（避免把物件內的 eta 子陣列誤當清單本體） */
function plainArr(j){
  if(!j) return [];
  if(Array.isArray(j)) return j;
  const d = j.data;
  if(Array.isArray(d)) return d;
  if(d && typeof d==='object'){
    for(const k of ['routes','route_stops','stops','route_list','stopList','estimatedArrivals','eta'])
      if(Array.isArray(d[k])) return d[k];
  }
  for(const k of ['routes','stops','eta','estimatedArrivals'])
    if(Array.isArray(j[k])) return j[k];
  return [];
}

async function cachedGet(url, ttl, opts){
  const hit = await DB.get(url, ttl);
  if(hit) return hit;
  try{
    const j = await getJSON(url, opts || {timeout:60000});   // 大量清單檔需要長超時
    await DB.set(url, j);
    return j;
  }catch(e){
    const stale = await DB.getStale(url);
    if(stale) return stale;                                   // 退回舊快取
    throw e;
  }
}
/* 端點可能換版／大小寫不同，逐一嘗試 */
async function cachedGetAny(urls, ttl, opts){
  let last;
  for(const u of [].concat(urls)){
    try{ return await cachedGet(u, ttl, opts || {timeout:20000}); }catch(e){ last=e; }
  }
  throw last || new Error('所有端點皆失敗');
}

async function loadBusData(force){
  if(loading) return;
  loading = true;
  const steps = [
    ['九巴路線', ()=>cachedGet(EP.kmbRoute, 12*3600e3)],
    ['九巴車站', ()=>cachedGet(EP.kmbStop , 12*3600e3)],
    ['九巴路線-站', ()=>cachedGet(EP.kmbRS  , 12*3600e3)],
    ['城巴路線', ()=>cachedGetAny(EP.ctbRoute, 12*3600e3)],
    ['城巴車站', ()=>cachedGet(EP.ctbStop , 12*3600e3)],
    ['小巴路線', ()=>cachedGet(EP.gmbRoute, 12*3600e3)],
    ['小巴車站', ()=>cachedGet(EP.gmbStop , 12*3600e3)],
    ['嶼巴路線', ()=>cachedGet(EP.nlbRoute, 12*3600e3)],
  ];
  const results = {};
  let doneN = 0;
  const tick = ()=> setBanner('stopMsg', `載入資料中…（${doneN}/${steps.length}）`);
  tick();
  // 平行下載（限量 4），但 IndexedDB 寫入仍逐筆
  await pool(steps, 4, async ([label, fn])=>{
    try{ results[label] = await fn(); }
    catch(e){ results[label] = null; console.warn(label, e); }
    finally{ doneN++; tick(); }
  });
  _allStopsCache = null;
  // KMB
  try{
    const R=results['九巴路線'], S=results['九巴車站'], RS=results['九巴路線-站'];
    if(R) D.KMB.route = asArray(R.data).map(r=>({co:'KMB', route:r.route, bound:r.bound, service_type:r.service_type,
              orig:r.orig_tc, dest:r.dest_tc, orig_en:r.orig_en, dest_en:r.dest_en}));
    if(S){
      D.KMB.stop = asArray(S.data).map(s=>({co:'KMB', id:s.stop, tc:s.name_tc, en:s.name_en, lat:+s.lat, lng:+s.long}));
      D.KMB.stopById = new Map(D.KMB.stop.map(s=>[s.id,s]));
    }
    if(RS){
      D.KMB.rs = asArray(RS.data);
      const key = r=>`${r.route}|${r.bound}|${r.service_type}`;
      const routesAtStop = new Map(), seqOf = new Map();
      for(const r of D.KMB.rs){
        const k = key(r);
        const sq = +pick(r,'seq','sequence','stopSeq');
        if(!Number.isFinite(sq)) continue;
        const stopId = String(pick(r,'stop','stop_id','stopId'));
        if(!seqOf.has(k)) seqOf.set(k, new Map());
        seqOf.get(k).set(stopId, sq);
        if(!routesAtStop.has(stopId)) routesAtStop.set(stopId, []);
        routesAtStop.get(stopId).push({co:'KMB', route:r.route, bound:r.bound, service_type:r.service_type, seq:sq, k});
      }
      D.KMB.routesAtStop = routesAtStop; D.KMB.seqOf = seqOf;
    }
    D.KMB.ready = !!(D.KMB.route && D.KMB.stop);
  }catch(e){ console.warn(e); }
  // CTB
  try{
    const R=results['城巴路線'], S=results['城巴車站'];
    if(R) D.CTB.route = asArray(R.data).map(r=>({co:'CTB', route:pick(r,'route','routeNo'),
              bound:pick(r,'bound','dir'),
              orig:pick(r,'orig_tc','origName_tc'), dest:pick(r,'dest_tc','destName_tc')}));
    if(S){
      D.CTB.stop = asArray(S.data).map(s=>({co:'CTB', id:String(pick(s,'stop','stop_id','stopId')),
              tc:pick(s,'name_tc','stopName_c'), en:pick(s,'name_en','stopName_e'),
              lat:+pick(s,'lat','latitude'), lng:+pick(s,'long','lng','longitude')}));
      D.CTB.stopById = new Map(D.CTB.stop.map(s=>[s.id,s]));
    }
    D.CTB.ready = !!(D.CTB.route && D.CTB.stop);
  }catch(e){ console.warn(e); }
  // GMB
  try{
    const R=results['小巴路線'], S=results['小巴車站'];
    if(R) D.GMB.route = gmbRoutesFrom(R);
    if(S){
      D.GMB.stop = gmbStopsFrom(S);
      D.GMB.stopById = new Map(D.GMB.stop.map(s=>[s.id,s]));
    }
    D.GMB.ready = !!(D.GMB.route && D.GMB.stop);
  }catch(e){ console.warn(e); }
  // NLB
  try{
    const R=results['嶼巴路線'];
    if(R) D.NLB.route = asArray(pick(R,'routes','data')).map(r=>({co:'NLB',
              route:String(pick(r,'routeNo','route_no','route')),
              id:String(pick(r,'routeId','route_id')),
              orig:pick(r,'routeName_c','routeName')||''})).filter(r=>r.route && r.id);
    D.NLB.ready = !!D.NLB.route;
  }catch(e){ console.warn(e); }

  busDataLoaded = true; loading = false;
  setBanner('stopMsg', '', false);
  loadListeners.forEach(f=>{ try{f();}catch(e){} });
  // 港鐵巴士用 CSV，不下載也能用其他營辦商，所以主流程不等它；
  // 但先記住 promise，讓「附近」可以在需要時等它完成
  ensureMtrBus();
  ensureLrt();
}

/* ---------- 專線小巴／港鐵巴士：內建資料（GitHub 開放資料） ----------
   兩家官方資料源（data.etagmb.gov.hk、opendata.mtr.com.hk）常被 CORS 擋下，
   且小巴的「站→路線」要逐站打 API。改為內建下列資料，達成零請求：
     · 車站名稱與 WGS84 座標
     · 每條路線的停靠順序（同時供路線頁使用）
     · 小巴的 gtfsId 與站序（到站 API 必備，否則查不到／查錯站）
   資料以 gzip + base64 存放，用 DecompressionStream 解開；
   若瀏覽器不支援則回傳 null，自動退回原本的 API 流程。 */
const EMB_GMB  = "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";
const EMB_MTRB = "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";

async function gunzipB64(b64){
  try{
    if(typeof DecompressionStream === 'undefined' || typeof Blob === 'undefined') return null;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const txt = await new Response(stream).text();
    return (txt && txt.length>100) ? txt : null;
  }catch(e){ return null; }
}

/* ---------- 專線小巴（內建） ---------- */
async function loadGmbEmbedded(){
  const txt = await gunzipB64(EMB_GMB);
  if(!txt) return false;
  const parts = txt.split('\n@@\n');
  if(parts.length < 2) return false;
  const routes = [], rsAt = new Map(), rmap = new Map();
  for(const line of parts[0].split('\n')){
    const [route, gtfs, bound, orig, dest, stopStr] = line.split('|');
    if(!route || !stopStr) continue;
    const stops = stopStr.split(',');
    routes.push({co:'GMB', route, gtfs, bound, orig, dest});
    if(!rmap.has(route)) rmap.set(route, {co:'GMB', route, gtfs, bound, orig, dest, stops});
    stops.forEach((sid, i)=>{
      if(!rsAt.has(sid)) rsAt.set(sid, []);
      if(!rsAt.get(sid).some(x=>x.route===route))
        rsAt.get(sid).push({route, gtfs, bound, seq:i});   // seq 供到站 API 篩選正確的站
    });
  }
  const stopList = [];
  for(const line of parts[1].split('\n')){
    const [id, tc, la, lo] = line.split('|');
    if(!id) continue;
    stopList.push({co:'GMB', id, tc, lat:+la, lng:+lo});
  }
  if(!stopList.length) return false;
  D.GMB.stop         = stopList;
  D.GMB.stopById     = new Map(stopList.map(s=>[s.id, s]));
  D.GMB.routesAtStop = rsAt;
  D.GMB.routeMap     = rmap;
  if(!D.GMB.route || !D.GMB.route.length) D.GMB.route = [...rmap.values()];
  D.GMB.ready        = true;
  _allStopsCache     = null;
  return true;
}

/* ---------- 港鐵巴士（內建） ----------
   注意：官方 CSV 中同一實體站因路線／方向不同會有多個編號
   （例如「輕鐵市中心站」有 506-D030、K51-D200、K52-nU120…），
   已依座標合併為 379 個站位，並記住每條路線各自對應的編號。 */
async function loadMtrbEmbedded(){
  const txt = await gunzipB64(EMB_MTRB);
  if(!txt) return false;
  const parts = txt.split('\n@@\n');
  if(parts.length < 2) return false;
  const routes = [], rsAt = new Map(), rmap = new Map();
  for(const line of parts[0].split('\n')){
    const [route, bound, orig, dest, stopStr] = line.split('|');
    if(!route || !stopStr) continue;
    const stops = stopStr.split(',');
    routes.push({co:'MTRB', route, bound, orig, dest});
    if(!rmap.has(route)) rmap.set(route, {co:'MTRB', route, bound, orig, dest, stops});
  }
  const stopList = [];
  for(const line of parts[1].split('\n')){
    const [id, tc, la, lo, pairs] = line.split('|');
    if(!id) continue;
    const list = [];
    if(pairs) for(const p of pairs.split(',')){
      const [r, sid] = p.split('>');
      if(r) list.push({route:r, bound:'', sid: sid || id});
    }
    stopList.push({co:'MTRB', id, tc, lat:+la, lng:+lo});
    rsAt.set(id, list);
  }
  if(!stopList.length) return false;
  D.MTRB.stop         = stopList;
  D.MTRB.stopById     = new Map(stopList.map(s=>[s.id, s]));
  D.MTRB.routesAtStop = rsAt;
  D.MTRB.route        = [...rmap.values()];
  D.MTRB.ready        = true;
  _allStopsCache      = null;
  return true;
}

/* ---------- 渡輪 ----------
   三家渡輪營辦商的碼頭與定期航班時刻表，取自 hkbus 專案整理之開放資料。
   注意：渡輪<b>沒有</b>實時到站 API，下列為時刻表推算的下一班，僅供參考。 */
const FERRY_CO = {hkkf:'港九小輪', sunferry:'新渡輪', fortuneferry:'富裕小輪'};
/* [碼頭編號, 營辦商, 中文名, lat, lng] */
const FERRY_PIERS = [
['101101','sunferry','新興海傍街長洲渡輪碼頭',22.20861,114.02848],
['101102','sunferry','民光街中環五號碼頭',22.28764,114.15937],
['101107','sunferry','大嶼山梅窩碼頭路梅窩渡輪碼頭',22.26505,114.00215],
['101108','sunferry','民光街中環六號碼頭 (西面泊位）',22.28726,114.16025],
['101109','sunferry','露坪街坪洲渡輪碼頭',22.28453,114.03714],
['101110','sunferry','北角（西）渡輪碼頭(近北角海濱花園)',22.29382,114.19986],
['101111','sunferry','華信街紅磡（北）渡輪碼頭',22.30112,114.19025],
['101112','sunferry','新碼頭街九龍城渡輪碼頭',22.31787,114.19427],
['101113','fortuneferry','屯門渡輪碼頭Ｄ泊位（海翠花園對出）',22.37208,113.96608],
['101114','fortuneferry','東涌發展碼頭東泊位',22.29416,113.94041],
['101117','fortuneferry','大嶼山沙螺灣碼頭',22.29375,113.90401],
['101120','fortuneferry','大嶼山大澳海濱長廊登岸梯級',22.2524,113.86066],
['101320','fortuneferry','榮業街觀塘渡輪碼頭',22.30618,114.22143],
['101349','fortuneferry','北角（東）渡輪碼頭(近北角海濱花園)',22.29419,114.20086],
['101355','fortuneferry','啟德承豐道跑道公園碼頭一號梯台',22.30977,114.21301],
['101357','fortuneferry','紅磡（南）渡輪碼頭',22.30031,114.18933],
['101358','fortuneferry','中環八號碼頭(西面泊位）',22.28664,114.16206],
['KF1','hkkf','中環4號渡輪碼頭',22.28801,114.15839],
['KF2','hkkf','中環6號渡輪碼頭',22.28746,114.16033],
['KF3','hkkf','榕樹灣渡輪碼頭',22.22652,114.1091],
['KF4','hkkf','坪洲渡輪碼頭',22.28459,114.03716],
['KF5','hkkf','索罟灣公衆碼頭',22.20609,114.13154],
['KF6','hkkf','喜靈洲碼頭',22.25799,114.02779]
];
/* [營辦商, 路線號, 起點, 終點, [停靠碼頭], {服務日代碼:[開出時間]} ] */
const FERRY_ROUTES = [
['fortuneferry','7000004','大澳','東涌',["101120","101117","101114"],{"480":["1100","1500","1700"]}],
['fortuneferry','7000004','東涌','大澳',["101114","101117","101120"],{"480":["1200","1600"]}],
['fortuneferry','7021','啟德','北角',["101355","101320","101349"],{"288":["1025","1125","1225","1325","1425","1525","1625","1725","1825","1925"],"448":["1025","1125","1225","1325","1425","1525","1625","1725","1825","1925"]}],
['fortuneferry','7021','北角','啟德',["101349","101320","101355"],{"288":["0900","1000","1100","1200","1300","1400","1500","1600","1700","1800","1900"],"448":["0700","0800","0900","1000","1100","1200","1300","1400","1500","1600","1700","1800","1900"]}],
['fortuneferry','7025','大澳','屯門',["101120","101117","101114","101113"],{"287":["0930","1130","1400","1600","1800","1900"],"288":["0930","1130","1400","1600","1800","1900"],"448":["0930","1130","1400","1600","1800","1900"]}],
['fortuneferry','7025','屯門','大澳',["101113","101114","101117","101120"],{"287":["0800","0900","1100","1245","1515","1730"],"288":["0800","0900","0915","1100","1245","1515","1730"],"448":["0800","0900","0915","1100","1245","1515","1730"]}],
['fortuneferry','7056','觀塘','北角',["101320","101349"],{"287":["0715","0745","0815","0845","0915","0945","1015","1045","1115","1145","1215","1245","1315","1345","1415","1445","1515","1545","1615","1645","1715","1745","1815","1845","1915","1945"],"288":["0815","0845"]}],
['fortuneferry','7056','北角','觀塘',["101349","101320"],{"287":["0700","0730","0800","0830","0900","0930","1000","1030","1100","1130","1200","1230","1300","1330","1400","1430","1500","1530","1600","1630","1700","1730","1800","1830","1900","1930"],"288":["0800","0830"]}],
['fortuneferry','7059','中環','紅磡',["101358","101357"],{"319":["0750","0830","0910","0950","1030","1110","1150","1310","1400","1440","1600","1640","1720","1800","1840","1920"],"448":["0830","0910","0950","1030","1110","1150","1310","1400","1440","1520","1600","1640","1720","1800"]}],
['fortuneferry','7059','紅磡','中環',["101357","101358"],{"319":["0730","0810","0850","0930","1010","1050","1130","1250","1330","1420","1500","1620","1700","1740","1820","1900"],"448":["0810","0850","0930","1010","1050","1130","1250","1330","1420","1500","1540","1620","1700","1740","1820"]}],
['sunferry','CCCE','長洲','中環',["101101","101102"],{"287":["1630"],"319":["0510","0550","0620","0640","0700","0715","0745","0750","0755","0810","0820","0840","0900","0930","1000","1045","1115","1145","1215","1245","1315","1345","1415","1445","1515","1545","1615","1645","1715","1740","1820","1900","1930","2000","2030","2100","2130","2200","2230","2300","2330","2345","2620"],"448":["0510","0600","0630","0700","0730","0800","0830","0900","0930","1000","1030","1100","1130","1200","1230","1300","1330","1400","1430","1500","1530","1600","1630","1700","1730","1800","1830","1900","1930","2000","2030","2100","2130","2200","2230","2300","2330","2620"]}],
['sunferry','CECC','中環','長洲',["101102","101101"],{"287":["1830","1915","1940"],"288":["1930"],"319":["0415","0610","0700","0740","0800","0840","0900","0945","1015","1045","1115","1145","1215","1245","1315","1345","1415","1445","1515","1545","1615","1645","1720","1740","1800","1820","1845","1900","2000","2030","2100","2130","2200","2230","2300","2330","2345","2430","2530"],"448":["0415","0630","0700","0730","0800","0830","0900","0930","1000","1030","1100","1130","1200","1230","1300","1330","1400","1430","1500","1530","1600","1630","1700","1730","1800","1830","1900","1930","2000","2030","2100","2130","2200","2230","2300","2330","2355","2430","2530"]}],
['sunferry','CEMW','中環','梅窩',["101108","101107"],{"319":["0610","0700","0740","0830","0900","0950","1030","1110","1150","1230","1310","1350","1430","1510","1550","1630","1720","1740","1800","1830","1900","1930","2000","2040","2120","2200","2245","2330","2430","2700"],"448":["0700","0800","0830","0900","0940","1020","1100","1200","1300","1340","1420","1500","1540","1620","1700","1740","1820","1900","1940","2020","2100","2140","2220","2300","2340","2430","2700"]}],
['sunferry','HHNP','紅磡','北角',["101111","101110"],{"287":["0705","0735","0805","0835","0905","0935","1005","1035","1105","1135","1205","1235","1305","1335","1405","1435","1505","1535","1605","1635","1705","1735","1805","1835","1905","1935"],"480":["0805","0835","0905","0935","1005","1035","1135","1235","1335","1435","1505","1535","1605","1635","1705","1735","1805","1835","1905","1935"]}],
['sunferry','IICHCMUW','長洲','梅窩',["101101","101107"],{}],
['sunferry','IIMUWPEC','梅窩','坪洲',["101107","101109"],{}],
['sunferry','IIPECMUW','坪洲','梅窩',["101109","101107"],{"511":["2345"]}],
['sunferry','KCNP','九龍城','北角',["101112","101110"],{"287":["0705","0735","0805","0835","0905","0935","1005","1105","1205","1305","1405","1435","1505","1535","1605","1635","1705","1735","1805","1835","1905","1935"],"480":["0805","0835","0905","0935","1005","1035","1105","1135","1205","1235","1305","1335","1405","1435","1505","1535","1605","1635","1705","1735","1805","1835","1905","1935"]}],
['hkkf','KF1','中環4號渡輪碼頭','索罟灣公衆碼頭',["KF1","KF5"],{"319":["0720","0835","1020","1150","1350","1520","1650","1845","2020","2150","2330"],"448":["0720","0835","1020","1150","1250","1350","1435","1520","1605","1650","1735","1845","1920","2020","2150","2330"]}],
['hkkf','KF1','索罟灣公衆碼頭','中環4號渡輪碼頭',["KF5","KF1"],{"319":["0640","0800","0935","1105","1240","1435","1605","1735","1935","2105","2240"],"448":["0645","0800","0935","1105","1240","1350","1435","1520","1605","1650","1735","1835","1935","2020","2105","2240"]}],
['hkkf','KF2','中環4號渡輪碼頭','榕樹灣渡輪碼頭',["KF1","KF3"],{"319":["0630","0700","0730","0750","0810","0830","0850","0910","0930","1010","1100","1200","1300","1345","1430","1515","1550","1630","1720","1740","1800","1820","1840","1900","1930","2000","2030","2100","2130","2230","2330","2430"],"448":["0730","0800","0830","0900","0930","1000","1030","1100","1130","1200","1230","1300","1330","1400","1430","1500","1600","1630","1700","1730","1800","1830","1900","1930","2000","2030","2130","2230","2330","2430"],"480":["0230"]}],
['hkkf','KF2','榕樹灣渡輪碼頭','中環4號渡輪碼頭',["KF3","KF1"],{"319":["0530","0620","0640","0700","0720","0740","0800","0820","0840","0900","0920","0940","1030","1120","1200","1300","1345","1430","1515","1600","1630","1715","1750","1810","1830","1850","1920","2000","2030","2130","2230","2330"],"448":["0530","0640","0730","0800","0830","0900","0930","1000","1030","1100","1130","1200","1230","1300","1330","1400","1430","1530","1600","1630","1700","1730","1800","1830","1900","1930","2000","2030","2130","2230","2330"]}],
['hkkf','KF3','中環6號渡輪碼頭','坪洲渡輪碼頭',["KF2","KF4"],{"319":["0710","0740","0800","0830","0915","1000","1045","1130","1215","1310","1345","1430","1515","1610","1645","1730","1800","1830","1900","1930","2000","2030","2115","2200","2245","2330","2430","2700"],"448":["0700","0750","0840","0930","1020","1105","1200","1245","1340","1430","1520","1610","1700","1750","1840","1930","2020","2115","2200","2250","2340","2430","2700"]}],
['hkkf','KF3','坪洲渡輪碼頭','中環6號渡輪碼頭',["KF4","KF2"],{"319":["0530","0615","0700","0725","0745","0820","0835","0915","1000","1045","1130","1215","1300","1345","1430","1515","1600","1655","1725","1815","1850","1945","2030","2115","2205","2245","2330","2740"],"448":["0530","0630","0700","0750","0840","0930","1020","1110","1150","1250","1330","1430","1520","1610","1750","1840","1930","2020","2115","2200","2250","2335","2740"]}],
['hkkf','KF4','喜靈洲碼頭','坪洲渡輪碼頭',["KF6","KF4"],{}],
['hkkf','KF4','坪洲渡輪碼頭','喜靈洲碼頭',["KF4","KF6"],{}],
['sunferry','MWCE','梅窩','中環',["101107","101108"],{"319":["0555","0620","0650","0715","0745","0805","0830","0900","0930","1000","1040","1130","1210","1250","1330","1410","1450","1530","1610","1650","1730","1810","1840","1940","2030","2130","2240","2330","2740"],"448":["0620","0705","0800","0840","0920","1000","1040","1120","1200","1240","1320","1400","1440","1520","1600","1640","1720","1800","1840","1920","2000","2040","2120","2200","2250","2330","2740"]}],
['sunferry','NPHH','北角','紅磡',["101110","101111"],{"287":["0723","0753","0823","0853","0923","0953","1023","1123","1223","1323","1423","1453","1523","1553","1623","1653","1723","1753","1823","1853","1923"],"480":["0823","0853","0923","0953","1023","1053","1123","1153","1223","1253","1323","1353","1423","1453","1523","1553","1623","1653","1723","1753","1823","1853","1923"]}],
['sunferry','NPKC','北角','九龍城',["101110","101112"],{"287":["0717","0747","0817","0847","0917","0947","1017","1047","1147","1247","1347","1447","1517","1547","1617","1647","1717","1747","1817","1847","1917"],"480":["0817","0847","0917","0947","1017","1047","1117","1147","1247","1317","1347","1417","1447","1517","1547","1617","1647","1717","1747","1817","1847","1917"]}]
];
/* 香港公眾假期（YYYYMMDD），用來判斷該用哪一份時刻表 */
const FERRY_HOLIDAYS = ["20250101","20250129","20250130","20250131","20250404","20250418","20250419","20250421","20250501","20250505","20250531","20250701","20251001","20251007","20251029","20251225","20251226","20260101","20260217","20260218","20260219","20260403","20260404","20260406","20260407","20260501","20260525","20260619","20260701","20260926","20261001","20261019","20261225","20261226","20270101","20270206","20270208","20270209","20270326","20270327","20270329","20270405","20270501","20270513","20270609","20270701","20270916","20271001","20271008","20271225","20271227"];
/* 服務日代碼：低 7 位元為星期遮罩，高位為假期版本。
   星期位元依序為 [一,二,三,四,五,六,日]，權重 [64,1,2,4,8,16,32] */
const FERRY_DAYBIT = [64,1,2,4,8,16,32];

/* ---------- 渡輪 ---------- */
function buildFerry(){
  if(D.FERRY.ready) return;
  const rsAt = new Map();
  const stops = FERRY_PIERS.map(([id, op, tc, la, lo])=>({co:'FERRY', id, tc, en:'', lat:la, lng:lo, op}));
  const routeSet = new Set();
  for(const [, route, , , pierIds] of FERRY_ROUTES){
    routeSet.add(route);
    for(const p of pierIds){
      if(!rsAt.has(p)) rsAt.set(p, []);
      if(!rsAt.get(p).some(x=>x.route===route)) rsAt.get(p).push({route, bound:''});
    }
  }
  D.FERRY.stop         = stops;
  D.FERRY.stopById     = new Map(stops.map(x=>[x.id, x]));
  D.FERRY.routesAtStop = rsAt;
  const rmap = new Map();
  for(const [op, route, orig, dest] of FERRY_ROUTES){
    if(!rmap.has(route)) rmap.set(route, {co:'FERRY', route, op, bound:'', orig, dest});
  }
  D.FERRY.route        = [...rmap.values()];
  D.FERRY.ready        = stops.length>0;
  if(stops.length) _allStopsCache = null;
}
/* 今天的服務日遮罩（0=週一 … 6=週日） */
function ferryTodayMask(){
  const d = new Date();
  const idx = (d.getDay()+6) % 7;          // JS: 0=週日 → 轉為 0=週一
  return FERRY_DAYBIT[idx];
}
function ferryIsHoliday(){
  const d = new Date();
  const s = '' + d.getFullYear()
          + String(d.getMonth()+1).padStart(2,'0')
          + String(d.getDate()).padStart(2,'0');
  return FERRY_HOLIDAYS.indexOf(s) >= 0;
}
/* 找出此碼頭的下一班船（依時刻表推算，非實時） */
function ferryNextSailings(pierId, limit=4){
  const now = new Date();
  const hhmm = now.getHours()*60 + now.getMinutes();
  const mask = ferryTodayMask(), isHol = ferryIsHoliday();
  const out = [];
  const seen = new Set();
  for(const [op, route, orig, dest, pierIds, freq] of FERRY_ROUTES){
    const at = pierIds.indexOf(pierId);
    if(at < 0) continue;
    // 選出適用於今天的時刻表：假期優先取高位版本，平日取基本版
    let best = null, bestK = -1;
    for(const k of Object.keys(freq)){
      const ki = +k, dayMask = ki & 127, v = ki >> 7;
      if(!(dayMask & mask)) continue;
      if(bestK < 0){ best = freq[k]; bestK = v; continue; }
      if(isHol ? v > bestK : v < bestK){ best = freq[k]; bestK = v; }
    }
    if(!best || !best.length) continue;
    for(const t of best){
      const m = /^(\d{2})(\d{2})$/.exec(String(t));
      if(!m) continue;
      const mins = (+m[1])*60 + (+m[2]);
      const key = route+'|'+t;
      if(seen.has(key)) continue;
      seen.add(key);
      out.push({route, op, dest, orig, dep:String(t), min: mins - hhmm});
    }
  }
  out.sort((a,b)=> (a.min<0?a.min+1440:a.min) - (b.min<0?b.min+1440:b.min));
  return out.slice(0, limit);
}
/* ---------- 輕鐵 ----------
   座標與站號取自 hkbus 專案整理之港鐵開放資料（hk-bus-crawling，GitHub），
   共 80 站，為真實 WGS84 座標。
   （官方 light_rail_routes_and_stops.csv 只有編號／名稱／路線，沒有經緯度） */
/* 同一車站的不同月台各有編號（座標完全相同），已依站名合併為 68 站。
   格式：[站號, 站名, lat, lng, [途經路線]] ；站號去掉 LR 即為到站 API 用的數字編號 */
const LRT_STOPS = [
['LR001','屯門碼頭',22.37271,113.96712,["506P*","507","507P*","610","614","614P","615","615P","751*"]],
['LR010','美樂',22.37505,113.96111,["506P*","610","615","615P"]],
['LR015','蝴蝶',22.37817,113.96166,["506P*","610","615","615P"]],
['LR020','輕鐵車廠',22.38181,113.96342,["506P*","610","615","615P"]],
['LR030','龍門',22.38526,113.96498,["506P*","610","615","615P"]],
['LR040','青山村',22.3904,113.96696,["506P*","610","615","615P"]],
['LR050','青雲',22.39434,113.9674,["506P*","610","615","615P"]],
['LR060','建安',22.39513,113.9689,["505","506P*"]],
['LR070','河田',22.39738,113.97313,["507","507P*","751","751*"]],
['LR075','蔡意橋',22.39993,113.97417,["507","507P*","751","751*"]],
['LR080','澤豐',22.40349,113.97589,["610","610P*","751","751*"]],
['LR090','屯門醫院',22.40777,113.97715,["610","610P*","751","751*"]],
['LR100','兆康',22.4119,113.97822,["505","506P*","507P*","610","610P*","614","614P","615","615P","720*","751","751*","SPR"]],
['LR110','麒麟',22.41097,113.97634,["505","610P*","615P"]],
['LR120','青松',22.40729,113.97252,["505","507P*","610P*","615","615P"]],
['LR130','建生',22.40673,113.96918,["505","507P*","610P*","615","615P"]],
['LR140','田景',22.40771,113.96643,["505","507","507P*","610P*","615","615P"]],
['LR150','良景',22.40669,113.96363,["505","507","507P*","610P*","615","615P"]],
['LR160','新圍',22.40529,113.96442,["505","507","507P*","610P*","615","615P"]],
['LR170','石排',22.40138,113.96769,["505","610","615","615P"]],
['LR180','山景(北)',22.39851,113.96662,["505"]],
['LR190','山景(南)',22.39662,113.96598,["505"]],
['LR200','鳴琴',22.39706,113.96734,["505","610","615","615P"]],
['LR212','大興(北)',22.4046,113.96998,["507","507P*","610","610P*"]],
['LR220','大興(南)',22.40267,113.97197,["507","507P*","610","610P*"]],
['LR230','銀圍',22.40239,113.97484,["507","507P*","610","610P*"]],
['LR240','兆禧',22.37524,113.9669,["507","507P*","614","614P","751*"]],
['LR250','海皇路(舊屯門泳池)',22.38116,113.97041,["507","507P*","614","614P","751*"]],
['LR260','豐景園',22.38327,113.97299,["507","507P*","614","614P","751*"]],
['LR265','兆麟',22.38456,113.97509,["505","507","507P*","614","614P","751*"]],
['LR270','安定',22.38764,113.97507,["505","507","507P*","614","614P","751","751*"]],
['LR275','友愛',22.38672,113.97352,["751"]],
['LR280','市中心',22.39136,113.97489,["505","507","507P*","614","614P","751","751*"]],
['LR295','屯門',22.39372,113.97331,["505","506P*","507","507P*","751","751*"]],
['LR300','杯渡',22.39461,113.9768,["506P*","614","614P"]],
['LR310','何福堂',22.39737,113.9774,["506P*","614","614P"]],
['LR320','新墟',22.40022,113.97804,["506P*","614","614P"]],
['LR330','景峰',22.40313,113.9795,["506P*","614","614P"]],
['LR340','鳳地',22.40674,113.97874,["506P*","614","614P"]],
['LR350','藍地',22.4185,113.98163,["610","614","615","720*","751","751*","SPR"]],
['LR360','泥圍',22.42365,113.98632,["610","614","615","720*","751","751*","SPR"]],
['LR370','鍾屋村',22.42966,113.99223,["610","614","615","720*","751","751*","SPR"]],
['LR380','洪水橋',22.43364,113.99736,["610","614","615","720*","751","751*","SPR"]],
['LR390','塘坊村',22.44011,114.00704,["610","614","615","761P"]],
['LR400','屏山',22.44282,114.01176,["610","614","615","761P"]],
['LR425','坑尾村',22.44509,114.00553,["720*","751","751*","761P","SPR"]],
['LR430','天水圍',22.44945,114.00596,["705","706","751","751*","751P","SPR"]],
['LR435','天慈',22.4527,114.00602,["705","706","751","751*","751P","SPR"]],
['LR445','天耀',22.45038,114.00267,["705","706","720*","761P"]],
['LR448','樂湖',22.45304,114.00108,["705","706","720*","761P"]],
['LR450','天湖',22.45499,114.00577,["705","706","751","751*","751P","SPR"]],
['LR455','銀座',22.45756,114.00489,["705","706","751","751*","751P","SPR"]],
['LR460','天瑞',22.45592,113.99943,["705","706","720*","761P"]],
['LR468','頌富',22.46203,113.99696,["705","706","751","751*","751P","761P","SPR"]],
['LR480','天富',22.46454,113.9977,["705","706","751","751*","751P","761P","SPR"]],
['LR490','翠湖',22.45972,113.99953,["720*","751","751*","751P","SPR"]],
['LR500','天榮',22.45953,114.0026,["705","706","720*","751","751*","751P","SPR"]],
['LR510','天悅',22.46282,114.00156,["705","706"]],
['LR520','天秀',22.46555,114.00297,["705","706"]],
['LR530','濕地公園',22.4696,114.00246,["705","706"]],
['LR540','天恒',22.46966,114.00076,["705","706"]],
['LR550','天逸',22.46697,113.99883,["705","706","751","751*","751P","761P","SPR"]],
['LR560','水邊圍',22.44446,114.02045,["610","614","615","761P"]],
['LR570','豐年路',22.44447,114.0239,["610","614","615","761P"]],
['LR580','康樂路',22.44455,114.02661,["610","614","615","761P"]],
['LR590','大棠路',22.44452,114.02897,["610","614","615","761P"]],
['LR600','元朗',22.44572,114.03437,["610","614","615","761P"]],
['LR920','三聖',22.3829,113.97686,["505"]]
];

/* ---------- 港鐵重鐵：車站直接由內建路線表產生，零請求 ---------- */
function buildMtrStops(){
  if(D.MTR.ready) return;
  const map = new Map();
  MTR_LINES.forEach(L=>{
    L.st.forEach(([code, tc, lat, lng])=>{
      if(!map.has(code)) map.set(code, {co:'MTR', id:code, tc, en:'', lat, lng, lines:[]});
      map.get(code).lines.push(L.code);
    });
  });
  const stops = [...map.values()];
  D.MTR.stop = stops;
  D.MTR.stopById = new Map(stops.map(x=>[x.id, x]));
  D.MTR.routesAtStop = new Map(stops.map(x=>[x.id, x.lines.map(l=>({route:l, bound:''}))]));
  D.MTR.route = MTR_LINES.map(L=>({co:'MTR', route:L.code, bound:'', orig:'', dest:L.name}));
  D.MTR.ready = stops.length>0;
  if(stops.length) _allStopsCache = null;
}

/* ---------- 輕鐵：編號／名稱／路線取自官方 CSV，座標用近似表 ---------- */
let _lrtPromise = null;
function ensureLrt(){
  if(_lrtPromise) return _lrtPromise;
  _lrtPromise = loadLrt().catch(()=>{}).then(()=>{
    renderDataStatus();
    if(lastGeo && activeTab==='stop') renderNearby(lastGeo);
  });
  return _lrtPromise;
}
function waitLrt(ms=8000){
  if(D.LRT.ready) return Promise.resolve();
  return Promise.race([ ensureLrt(), new Promise(r=>setTimeout(r, ms)) ]);
}
async function loadLrt(){
  if(D.LRT.ready) return;
  const rsAt = new Map();
  const routeSet = new Set();
  const stops = LRT_STOPS.map(([id, tc, la, lo, rs])=>{
    (rs||[]).forEach(r=>routeSet.add(r));
    rsAt.set(id, (rs||[]).map(r=>({route:r, bound:''})));
    return {co:'LRT', id, tc, en:'', lat:la, lng:lo};
  });
  D.LRT.stop         = stops;
  D.LRT.stopById     = new Map(stops.map(x=>[x.id, x]));
  D.LRT.routesAtStop = rsAt;
  D.LRT.route        = [...routeSet].map(r=>({co:'LRT', route:r, bound:'', orig:'', dest:''}));
  D.LRT.ready        = stops.length>0;
  if(stops.length) _allStopsCache = null;
}
/* 解析輕鐵到站的中文時間：「即將抵達」→0；「3 分鐘」→3 */
function parseLrtTime(t){
  const str = String(t||'').trim();
  if(!str) return null;
  if(/即將|抵達中|進站/.test(str)) return 0;
  const m = str.match(/(\d+)/);
  return m ? +m[1] : null;
}

/* ---------- 港鐵巴士／接駁巴士（CSV + POST API） ---------- */
let _mtrbPromise = null;
/* 確保港鐵巴士開始載入（重複呼叫只會載一次） */
function ensureMtrBus(){
  if(_mtrbPromise) return _mtrbPromise;
  _mtrbPromise = loadMtrBus().catch(()=>{}).then(()=>{
    renderDataStatus();
    if(lastGeo && activeTab==='stop') renderNearby(lastGeo);   // 補上港鐵巴士站
  });
  return _mtrbPromise;
}
/* 等港鐵巴士載完，但最多等 ms；逾時就先用其他營辦商的結果 */
function waitMtrBus(ms=8000){
  if(D.MTRB.ready) return Promise.resolve();
  return Promise.race([ ensureMtrBus(), new Promise(r=>setTimeout(r, ms)) ]);
}
async function loadMtrBus(){
  if(D.MTRB.ready) return;
  let rTxt=null, sTxt=null;
  try{ rTxt = await cachedText(EP.mtrbRouteCsv, 24*3600e3, {timeout:30000}); }catch(e){}
  try{ sTxt = await cachedText(EP.mtrbStopCsv , 24*3600e3, {timeout:30000}); }catch(e){}

  // --- 路線 ---
  const routes = [];
  const seenR = new Set();
  if(rTxt){
    const rows = parseCSV(rTxt);
    if(rows.length>1){
      const h = rows[0];
      const cR = csvCol(h,'Route Code','RouteCode','route_code','route','路線');
      const cO = csvCol(h,'Origin TC','Origin','orig','起點','總站');
      const cD = csvCol(h,'Destination TC','Destination','dest','終點','目的地');
      const cDir = csvCol(h,'Direction','direction','dir','方向');
      for(let i=1;i<rows.length;i++){
        const r = rows[i];
        const code = (cR>=0 ? r[cR] : r[0] || '').trim();
        if(!code || seenR.has(code)) continue;
        seenR.add(code);
        routes.push({co:'MTRB', route:code, bound:(cDir>=0? (r[cDir]||'').trim():'') || 'O',
                     orig:(cO>=0? (r[cO]||'').trim():''), dest:(cD>=0? (r[cD]||'').trim():'')});
      }
    }
  }
  // CSV 失敗時用備援清單，讓「附近路線」至少能查到站
  if(!routes.length) EP.MTRB_FALLBACK.forEach(c=>{
    if(!seenR.has(c)){ seenR.add(c); routes.push({co:'MTRB', route:c, bound:'O', orig:'', dest:''}); }
  });
  D.MTRB.route = routes;

  // --- 車站（從 route-stop CSV 建立：站、以及站→路線索引） ---
  const stopMap = new Map(), rsAt = new Map();
  if(sTxt){
    const rows = parseCSV(sTxt);
    if(rows.length>1){
      const h = rows[0];
      const cR  = csvCol(h,'Route Code','RouteCode','route_code','route','路線');
      const cId = csvCol(h,'Stop ID','StopID','stop_id','stopid','stop','站編號','車站編號');
      const cN  = csvCol(h,'Stop Name TC','Stop Name','stop_name','name','站名','車站名稱');
      const cN2 = csvCol(h,'Stop Name EN','name_en','english');
      const cLa = csvCol(h,'Latitude','latitude','lat','緯度');
      const cLo = csvCol(h,'Longitude','longitude','lng','long','經度');
      const cSq = csvCol(h,'Stop Seq','stop_seq','sequence','seq','站序');
      for(let i=1;i<rows.length;i++){
        const r = rows[i];
        const id = String((cId>=0? r[cId] : (r[4]||'') )||'').trim();
        const code = String((cR>=0? r[cR] : (r[0]||'') )||'').trim();
        const name = ((cN>=0? r[cN] : (r[5]||'') )||'').trim();
        if(!id || !name) continue;
        if(!stopMap.has(id)){
          const lat = cLa>=0 ? parseFloat(r[cLa]) : NaN;
          const lng = cLo>=0 ? parseFloat(r[cLo]) : NaN;
          stopMap.set(id, {co:'MTRB', id, tc:name,
            en:(cN2>=0? (r[cN2]||'').trim():''),
            lat: isFinite(lat)?lat:NaN, lng: isFinite(lng)?lng:NaN});
        }
        if(code){
          if(!rsAt.has(id)) rsAt.set(id, []);
          if(!rsAt.get(id).some(x=>x.route===code)) rsAt.get(id).push({route:code, bound:'O'});
        }
      }
    }
  }
  // 沒有座標的站無法用於「附近」，必須剔除
  const stops = [...stopMap.values()].filter(x=>isFinite(x.lat) && isFinite(x.lng));
  D.MTRB.stop = stops.length ? stops : [];
  D.MTRB.stopById = new Map(D.MTRB.stop.map(x=>[x.id,x]));
  D.MTRB.routesAtStop = rsAt;
  D.MTRB.ready = !!(D.MTRB.route && D.MTRB.stop.length);
  if(D.MTRB.stop.length) _allStopsCache = null;
}

function setBanner(id, msg, isErr){
  const el = document.getElementById(id); if(!el) return;
  el.innerHTML = msg ? `<div class="banner${isErr?' err':''}">${isErr?'⚠️':'<span class="spin"></span>'} ${esc(msg)}</div>` : '';
}
function needBusData(){
  if(!busDataLoaded && !loading) loadBusData();
  return busDataLoaded;
}

/* ============================================================
   到站查詢
   ============================================================ */
let stopFilter = 'ALL';
let _allStopsCache = null;
function allStops(co){
  if(co==='ALL'){
    if(_allStopsCache) return _allStopsCache;
    let out = [];
    if(D.KMB.stop) out = out.concat(D.KMB.stop);
    if(D.CTB.stop) out = out.concat(D.CTB.stop);
    if(D.GMB.stop) out = out.concat(D.GMB.stop);
    if(D.NLB.stop) out = out.concat(D.NLB.stop);
    if(D.MTRB.stop) out = out.concat(D.MTRB.stop);
    if(D.MTR.stop) out = out.concat(D.MTR.stop);
    if(D.LRT.stop) out = out.concat(D.LRT.stop);
    if(D.FERRY.stop) out = out.concat(D.FERRY.stop);
    // 預先正規化每個站名，搜尋時避免逐鍵重算上萬次
    for(const st of out){ if(st._n===undefined){ st._n = norm(st.tc); st._ne = norm(st.en||''); st._id = norm(st.id); } }
    _allStopsCache = out;
    return out;
  }
  let out = [];
  if(co==='KMB' && D.KMB.stop) out = out.concat(D.KMB.stop);
  if(co==='CTB' && D.CTB.stop) out = out.concat(D.CTB.stop);
  if(co==='GMB' && D.GMB.stop) out = out.concat(D.GMB.stop);
  if(co==='NLB' && D.NLB.stop) out = out.concat(D.NLB.stop);
  if(co==='MTRB' && D.MTRB.stop) out = out.concat(D.MTRB.stop);
  if(co==='MTR' && D.MTR.stop) out = out.concat(D.MTR.stop);
  if(co==='LRT' && D.LRT.stop) out = out.concat(D.LRT.stop);
  if(co==='FERRY' && D.FERRY.stop) out = out.concat(D.FERRY.stop);
  for(const st of out){ if(st._n===undefined){ st._n = norm(st.tc); st._ne = norm(st.en||''); st._id = norm(st.id); } }
  return out;
}
/* 嶼巴沒有整批車站 API，按路線逐一載入（按需，並快取） */
async function ensureNlbStops(){
  if(D.NLB.stop || !D.NLB.route) return;
  setBanner('stopMsg','正在載入嶼巴車站…');
  const lists = await pool(D.NLB.route, 5, async r=>{
    try{
      const j = await cachedGet(EP.nlbRS(r.id), 12*3600e3);
      return {r, stops: asArray(j.stops && j.stops.length ? j.stops : j.data)};
    }catch(e){ return null; }
  });
  const seen = new Set(), out = [];
  lists.filter(Boolean).forEach(({stops})=>{
    stops.forEach(s=>{
      const id = String(pick(s,'stopId','stop_id','stop','id') ?? '');
      if(!id || seen.has(id)) return; seen.add(id);
      const lat = +(pick(s,'latitude','lat')), lng = +(pick(s,'longitude','lng','long'));
      if(!isFinite(lat) || !isFinite(lng)) return;
      out.push({co:'NLB', id, tc: pick(s,'stopName_c','name_tc','stopName')||id, lat, lng});
    });
  });
  D.NLB.stop = out; D.NLB.stopById = new Map(out.map(s=>[s.id,s]));
  // 順便建立「站→路線」索引，查到站時不必對全部路線逐一試
  const rsAt = new Map();
  lists.filter(Boolean).forEach(({r, stops})=>{
    stops.forEach(s=>{
      const id = String(pick(s,'stopId','stop_id','stop','id') ?? '');
      if(!id) return;
      if(!rsAt.has(id)) rsAt.set(id, []);
      const arr = rsAt.get(id);
      if(!arr.some(x=>x.id===r.id)) arr.push({route:r.route, id:r.id});
    });
  });
  D.NLB.routesAtStop = rsAt;
  _allStopsCache = null;
  setBanner('stopMsg','');
}
/* 小巴 /route 有兩種形態：
   {data:{routes:['1','2',…]}}                      或
   {data:{routes:{HKI:['1',…], KLN:[…], NT:[…]}}}   按地區分組
   也有機會直接給物件陣列，一併處理 */
/* 小巴車站：官方可能回傳 data、data.stops 或純陣列 */
function gmbStopsFrom(S){
  return asArray(S)
    .map(s=>({co:'GMB', id:String(pick(s,'stop_id','stopId','stop','id')),
              tc:pick(s,'name_tc','stopName_c','description_tc')||'',
              lat:+pick(s,'latitude','lat'), lng:+pick(s,'longitude','lng','long')}))
    .filter(s=>s.tc && isFinite(s.lat) && isFinite(s.lng));
}
function gmbRoutesFrom(R){
  const out = [];
  const data = (R && R.data) ? R.data : R;
  const rts = (data && data.routes) ? data.routes : data;
  const add = (code, region, obj)=>{
    const c = String(code ?? '').trim(); if(!c) return;
    const o = (obj && typeof obj==='object') ? obj : {};
    const rg = region || pick(o,'region') || '';
    out.push({co:'GMB', route:c, region:rg,
      gtfs:String(pick(o,'gtfsId','gtfs_id') || (rg ? c+'_'+rg : c)),
      desc:pick(o,'description_tc','name_tc','routeName_c')||''});
  };
  if(Array.isArray(rts)){
    for(const it of rts){
      if(it && typeof it==='object') add(pick(it,'route_id','routeId','routeNo','route','route_code'), '', it);
      else add(it, '');
    }
  } else if(rts && typeof rts==='object'){
    for(const [region, arr] of Object.entries(rts)){
      if(!Array.isArray(arr)) continue;
      for(const it of arr){
        if(it && typeof it==='object') add(pick(it,'route_id','routeId','routeNo','route','route_code'), region, it);
        else add(it, region);
      }
    }
  }
  const seen = new Set();
  return out.filter(r=>{ const k=r.route+'|'+r.region; if(seen.has(k)) return false; seen.add(k); return true; });
}
function searchStops(q, co='ALL', limit=60){
  const nq = norm(q);
  if(!nq) return [];
  const hits = [];
  for(const s of allStops(co)){
    const sc = scoreStop(s, nq);
    if(sc>0) hits.push({s, sc});
  }
  hits.sort((a,b)=> b.sc-a.sc || a.s.tc.length-b.s.tc.length);
  return hits.slice(0, limit).map(x=>x.s);
}
function scoreStop(s, nq){
  if(s._n===undefined){ s._n = norm(s.tc); s._ne = norm(s.en||''); s._id = norm(s.id); }
  const tc = s._n, en = s._ne, id = s._id;
  if(tc===nq || en===nq) return 1000;
  if(id===nq) return 900;
  let sc = 0;
  if(tc.startsWith(nq)) sc = 800 - tc.length;
  else if(tc.includes(nq)) sc = 500 - tc.indexOf(nq) - tc.length*0.1;
  else if(en && en.includes(nq)) sc = 300;
  else if(id.includes(nq)) sc = 200;
  return sc;
}
function highlight(s, q){
  const nq = norm(q); if(!nq) return esc(s);
  const i = norm(s).indexOf(nq);
  if(i<0) return esc(s);
  // 用正規化索引映射回原字串（粗略：逐字對齊）
  let cnt=-1, start=-1, end=-1;
  for(let k=0;k<s.length;k++){
    if(/[\s（）()]/.test(s[k])) continue;
    cnt++;
    if(cnt===i) start=k;
    if(cnt===i+nq.length-1){ end=k+1; break; }
  }
  if(start<0) return esc(s);
  return esc(s.slice(0,start))+'<mark>'+esc(s.slice(start,end))+'</mark>'+esc(s.slice(end));
}

let stopTimer=null;
$('#stopQ').addEventListener('input', e=>{
  clearTimeout(stopTimer);
  const q = e.target.value.trim();
  stopTimer = setTimeout(()=>renderStopSearch(q), 220);
});
$('#stopFilters').addEventListener('click', e=>{
  const b = e.target.closest('.chip'); if(!b) return;
  if(b.id==='nearbyBtn'){ nearbyStops(); return; }
  stopFilter = b.dataset.co;
  $$('#stopFilters .chip[data-co]').forEach(c=>c.setAttribute('aria-pressed', c===b));
  if(stopFilter==='NLB'){ waitBus().then(ensureNlbStops).then(()=>{
      renderStopSearch($('#stopQ').value.trim());
      if(lastGeo && !$('#stopQ').value.trim()) renderNearby(lastGeo);
    }); return; }
  renderStopSearch($('#stopQ').value.trim());
  if(lastGeo && !$('#stopQ').value.trim()) renderNearby(lastGeo);   // 依新篩選重算車站＋路線
});
function renderStopSearch(q){
  const box = $('#stopResults');
  if(!q){
    box.innerHTML='';
    if(lastGeo) renderNearBox();
    else if(SETTINGS.autoNearby!=0 && !geoDenied()) autoNearbyOnce();
    return;
  }
  $('#nearBox').innerHTML='';
  if(!needBusData()){ setBanner('stopMsg','正在載入路線資料，請稍候…'); return; }
  const res = searchStops(q, stopFilter);
  if(!res.length){ box.innerHTML = `<div class="card empty">找不到「${esc(q)}」相關車站。<br>可試試輸入較短關鍵字，或用上方「附近車站」。</div>`; return; }
  box.innerHTML = res.slice(0,40).map((s,i)=>`
    <div class="item" data-co="${s.co}" data-id="${esc(s.id)}">
      <span class="badge ${CO_CLS[s.co]}">${esc(s.route||s.co)}</span>
      <div style="flex:1;min-width:0">
        <div class="nm">${highlight(s.tc, q)}</div>
        <div class="sub">${esc(s.en||'')} · ${esc(s.co)} · ${esc(s.id)}</div>
      </div>
      <span class="muted">›</span>
    </div>`).join('');
}
$('#stopResults').addEventListener('click', e=>{
  const it = e.target.closest('.item'); if(!it) return;
  openStopEta(it.dataset.co, it.dataset.id);
});
$('#nearBox').addEventListener('click', e=>{
  const tab = e.target.closest('[data-view]');
  if(tab){
    nearView = tab.dataset.view;
    renderNearBox();
    if(nearView==='route' && nearData.routes===null) loadNearbyRoutes();
    return;
  }
  const st = e.target.closest('.item[data-id]');
  if(st){ openStopEta(st.dataset.co, st.dataset.id); return; }
  const it = e.target.closest('.item[data-route]'); if(!it) return;
  const co = it.dataset.co, route = it.dataset.route;
  switchTab('route');
  const q = $('#routeQ'); if(q){ q.value = route; }
  const chip = document.querySelector(`#routeFilters .chip[data-co="${co}"]`);
  if(chip){ routeFilter = co; $$('#routeFilters .chip').forEach(c=>c.setAttribute('aria-pressed', c===chip)); }
  renderRouteSearch(route);
  openRoute(co, route);
});

/* ---------- 附近車站（開啟即自動定位） ---------- */
let lastGeo = null;                       // {lat,lng,acc,t}
let geoBusy = false;

function geoDenied(v){
  if(v===undefined) return localStorage.getItem('hkT.geoDenied')==='1';
  localStorage.setItem('hkT.geoDenied', v?'1':'0');
  return v;
}
const nearR = ()=> (+SETTINGS.nearRadius || 700);

/* 路線號碼排序：純數字在前，再按字母 */
function routeCmp(a,b){
  const na=/^\d/.test(a), nb=/^\d/.test(b);
  if(na!==nb) return na?-1:1;
  if(na&&nb){
    const x=parseInt(a,10), y=parseInt(b,10);
    if(x!==y) return x-y;
  }
  return String(a).localeCompare(String(b));
}
/* 用本地索引取出該站的路線號碼（零額外請求） */
function stopRoutesPreview(co, id, n=6){
  if(co==='KMB' && D.KMB.routesAtStop){
    const arr = D.KMB.routesAtStop.get(id) || [];
    return [...new Set(arr.map(x=>String(x.route)))].sort(routeCmp).slice(0,n);
  }
  if(co==='NLB' && D.NLB.routesAtStop){
    const arr = D.NLB.routesAtStop.get(String(id)) || [];
    return [...new Set(arr.map(x=>String(x.route)))].sort(routeCmp).slice(0,n);
  }
  if(co==='MTRB' && D.MTRB.routesAtStop){
    const arr = D.MTRB.routesAtStop.get(String(id)) || [];
    return [...new Set(arr.map(x=>String(x.route)))].sort(routeCmp).slice(0,n);
  }
  if(co==='MTR' && D.MTR.routesAtStop){
    const arr = D.MTR.routesAtStop.get(String(id)) || [];
    return arr.map(x=>String(x.route));        // 路線＝鐵路綫，依原序（不需排序）
  }
  if(co==='LRT' && D.LRT.routesAtStop){
    const arr = D.LRT.routesAtStop.get(String(id)) || [];
    return [...new Set(arr.map(x=>String(x.route)))].sort(routeCmp).slice(0,n);
  }
  if(co==='FERRY' && D.FERRY.routesAtStop){
    const arr = D.FERRY.routesAtStop.get(String(id)) || [];
    return [...new Set(arr.map(x=>String(x.route)))].sort(routeCmp).slice(0,n);
  }
  return [];
}
/* 非同步版：城巴／小巴需要打 API，結果快取起來避免重複請求 */
const _previewCache = new Map();
async function stopRoutesPreviewAsync(co, id, n=6){
  const key = co+'|'+id;
  if(_previewCache.has(key)) return _previewCache.get(key);
  const sync = stopRoutesPreview(co, id, n);
  let arr = sync;
  if(!arr.length && (co==='CTB' || co==='GMB')){
    try{
      const rs = await routesAtStopOf(co, id);
      arr = [...new Set(rs.map(x=>String(x.route)))].sort(routeCmp).slice(0,n);
    }catch(e){ arr = []; }
  }
  _previewCache.set(key, arr);
  return arr;
}
/* 車站清單先渲染，路線號碼隨後補上（只補最近的幾個非本地索引站） */
let previewTok = 0;
async function fillStopPreviews(){
  if(nearView!=='stop') return;
  const els = $$('#nearBox [data-sub]').filter(el=>!el.dataset.done).slice(0, 10);
  if(!els.length) return;
  const myTok = ++previewTok;
  await pool(els, 4, async el=>{
    const [co, id] = (el.dataset.sub||'').split('|');
    if(!co || !id){ el.dataset.done='1'; return; }
    const rt = await stopRoutesPreviewAsync(co, id);
    if(myTok !== previewTok) return;         // 畫面已重繪，放棄
    el.dataset.done = '1';
    const el2 = document.querySelector(`#nearBox [data-sub="${co}|${id}"]`);
    if(el2 && rt.length) el2.textContent = rt.join(' · ');
  });
}
/* 先用經緯度方框粗篩，再對框內車站算精確距離。
   否則每次重算都要對上萬筆資料逐一算距離（實測約 14ms／次），
   切換篩選或調整半徑時會明顯卡頓；手機上更慢。 */
function computeNearbyAll(la, lo, co){
  const R = nearR();
  const M_PER_DEG = 111320;
  const dLat = (R / M_PER_DEG) * 1.05;                       // 略放大，避免邊界漏站
  const cosL = Math.max(Math.cos(la * Math.PI/180), 0.01);
  const dLng = (R / (M_PER_DEG * cosL)) * 1.05;
  const laMin = la-dLat, laMax = la+dLat, loMin = lo-dLng, loMax = lo+dLng;
  return allStops(co==='ALL'?'ALL':co)
    .filter(s => isFinite(s.lat) && isFinite(s.lng)
              && s.lat>=laMin && s.lat<=laMax && s.lng>=loMin && s.lng<=loMax)
    .map(s=>({s, d:dist(la,lo,s.lat,s.lng)}))
    .filter(x=>x.d < R && isFinite(x.d))
    .sort((a,b)=>a.d-b.d);
}
/* 附近車站：先給每個營辦商保底，剩餘名額再按距離補滿。
   若只取「最近 N 個」，在九巴站點密集處（全港約 6000 站），
   名額會全被九巴吃掉，城巴／小巴／輕鐵／港鐵等一個都不會出現。 */
const NEAR_STOP_CAP   = 20;   // 附近車站最多列出幾個
const NEAR_STOP_FLOOR = 2;    // 每個營辦商至少保證幾個
function computeNearby(la, lo, co){
  const inRange = computeNearbyAll(la, lo, co);      // 已按距離排序
  if(co !== 'ALL') return inRange.slice(0, NEAR_STOP_CAP);
  if(inRange.length <= NEAR_STOP_CAP) return inRange;
  const idx = new Set(), perCo = new Map();
  for(let i=0;i<inRange.length;i++){                  // 第一輪：保底
    const k = inRange[i].s.co;
    const n = perCo.get(k) || 0;
    if(n < NEAR_STOP_FLOOR){ perCo.set(k, n+1); idx.add(i); }
  }
  for(let i=0;i<inRange.length && idx.size < NEAR_STOP_CAP;i++) idx.add(i);  // 第二輪：補滿
  return [...idx].sort((a,b)=>a-b).map(i=>inRange[i]);
}
function geoErrMsg(err){
  switch(err && err.code){
    case 1: return '已拒絕定位權限。請點瀏覽器網址列的鎖頭／權限圖示重新允許，或直接用上方搜尋框輸入站名。';
    case 2: return '無法取得位置（可能在室內、沒有 GPS 或網路定位）。可稍後重試，或用搜尋框輸入站名。';
    case 3: return '定位逾時。請稍後重試。';
    default: return '定位失敗：'+((err && err.message) || '未知錯誤');
  }
}
function renderGeoError(msg, slim){
  const box = $('#nearBox'); if(!box) return;
  const isFile = typeof location!=='undefined' && location.protocol === 'file:';
  if(slim){
    box.innerHTML = `<div class="card tight">
      <div class="spread"><span class="small muted">📍 ${esc(msg)}</span>
        <button class="btn sm ghost" id="geoRetry">↻ 定位</button></div></div>`;
  } else {
    box.innerHTML = `<div class="card">
      <h2>📍 附近車站</h2>
      <div class="banner err">⚠️ ${esc(msg)}</div>
      ${isFile?`<div class="tiny muted" style="margin-top:6px">提醒：以「本機檔案」方式開啟時，部分瀏覽器（如 Safari）會停用定位。
        可改用 Chrome／Edge，或把檔案放到 https 網址下開啟。</div>`:''}
      <div class="act" style="margin-top:10px">
        <button class="btn sm ghost" id="geoRetry">↻ 再試一次</button>
      </div></div>`;
  }
  const b = $('#geoRetry'); if(b) b.onclick = ()=>{ geoDenied(false); requestNearby({force:true}); };
}
/* 附近資料集中管理：定位一次，車站與路線共用同一份結果 */
let nearView = 'stop';                    // 'stop' | 'route'
let nearData = {pos:null, stops:[], routes:null, err:null};   // routes=null 表示尚未計算
const nearRoutesOn = ()=> SETTINGS.nearRoutes!==0 && SETTINGS.nearRoutes!=='0';
const fmtDist = d => d<1000 ? Math.round(d)+'m' : (d/1000).toFixed(1)+'km';
/* 輕鐵站座標為近似值，距離加「約」避免誤導 */
const fmtDistOf = (d, approx) => (approx?'約 ':'') + fmtDist(d);
/* 鐵路顯示鐵路綫名（不加「往」），巴士／小巴顯示「往 目的地」 */
function nearRouteLabel(x){
  const d = routeDescOf(x.co, x.route, x.bound);
  if(x.co==='MTR') return esc(d || (CO_NAME.MTR+' '+x.route));
  if(x.co==='LRT') return esc(CO_NAME.LRT+' '+x.route);
  if(x.co==='FERRY') return esc(CO_NAME.FERRY+' '+x.route + (d?(' 往 '+d):''));
  return d ? '往 '+esc(d) : esc(CO_NAME[x.co]+' '+x.route);
}

function renderNearby(pos){
  nearbyTok++;
  const inRange = computeNearbyAll(pos.lat, pos.lng, stopFilter);
  nearData = {pos, stops: inRange.slice(0,20), allInRange: inRange, routes:null, err:null};
  renderNearBox();
  loadNearbyRoutes();                     // 背景補算路線
}
/* 統一渲染：同一張卡片，用 chip 切換「車站／路線」＋依營辦商篩選 */
function nearCounts(){
  const c = {ALL:0, KMB:0, CTB:0, GMB:0, NLB:0, MTRB:0, MTR:0, LRT:0, FERRY:0};
  (nearData.allInRange || nearData.stops).forEach(x=>{
    c.ALL++; if(c[x.s.co]!==undefined) c[x.s.co]++;
  });
  return c;
}
const CO_SHORT = {ALL:'全部', KMB:'九巴', CTB:'城巴', GMB:'小巴', NLB:'嶼巴', MTRB:'港鐵巴', MTR:'港鐵', LRT:'輕鐵', FERRY:'渡輪'};
function renderNearBox(){
  const box = $('#nearBox'); if(!box) return;
  if($('#stopQ').value.trim()){ box.innerHTML=''; return; }     // 正在搜尋時不干擾
  const pos = nearData.pos; if(!pos) return;
  const R = nearR();
  const acc = pos.acc ? `（誤差約 ${Math.round(pos.acc)}m）` : '';
  const showRoutes = nearRoutesOn();
  const view = showRoutes ? nearView : 'stop';
  const cnt = nearData.routes ? nearData.routes.length : '…';
  const cc = nearCounts();

  let h = `<div class="card">
    <div class="spread"><h2 style="margin:0">📍 附近</h2>
      <span class="tiny muted">${R} m 內${acc}</span></div>
    <div class="chipbar" id="nearTabs" style="margin-top:8px">
      <button class="chip" data-view="stop"  aria-pressed="${view==='stop'}">車站 ${nearData.stops.length}</button>
      ${showRoutes?`<button class="chip" data-view="route" aria-pressed="${view==='route'}">路線 ${cnt}</button>`:''}
      <button class="chip" id="geoRetry">↻ 重新定位</button>
    </div>
    <div class="chipbar" id="nearCo" style="margin-top:6px">
      ${['ALL','KMB','CTB','GMB','NLB','MTRB','MTR','LRT','FERRY'].filter(k=>k==='ALL'||cc[k]>0||((k==='MTRB'&&!D.MTRB.ready)||(k==='LRT'&&!D.LRT.ready))).map(k=>
        (k==='MTRB' && !D.MTRB.ready) || (k==='LRT' && !D.LRT.ready)
          ? `<button class="chip" data-nco="${k}" aria-pressed="false" disabled style="opacity:.6">${CO_SHORT[k]} …</button>`
          : `<button class="chip" data-nco="${k}" aria-pressed="${stopFilter===k}">${CO_SHORT[k]} ${cc[k]}</button>`).join('')}
    </div>`;

  if(view === 'stop'){
    h += nearData.stops.length
      ? `<div class="list" style="margin-top:6px">` + nearData.stops.map(x=>{
          const rt = stopRoutesPreview(x.s.co, x.s.id);
          return `<div class="item" data-co="${x.s.co}" data-id="${esc(x.s.id)}">
            <span class="badge ${CO_CLS[x.s.co]}">${fmtDistOf(x.d, x.s.approx)}</span>
            <div style="flex:1;min-width:0">
              <div class="nm">${esc(x.s.tc)}</div>
              <div class="sub" data-sub="${x.s.co}|${esc(x.s.id)}"${rt.length?' data-done="1"':''}>${rt.length? esc(rt.map(c=> x.s.co==='MTR' ? String(lineOf(c)?.name||c).replace(/[線綫]$/,'') : c).join(' · ')) : esc(CO_NAME[x.s.co])}</div>
            </div><span class="muted">›</span></div>`;
        }).join('') + `</div>`
      : `<div class="empty">${R} 公尺內找不到車站。<br>可到「更多 → 設定」把半徑調大。</div>`;
  } else if(nearData.routes === null){
    h += `<div class="empty" style="padding:14px 0"><span class="spin"></span> 正在找出附近路線…</div>`;
  } else if(!nearData.routes.length){
    h += `<div class="empty">附近找不到路線資料。<br>可到「更多 → 設定」把半徑調大。</div>`;
  } else {
    h += `<div class="list" style="margin-top:6px">` + nearData.routes.map(x=>`
      <div class="item" data-co="${x.co}" data-route="${esc(x.route)}">
        <span class="badge ${CO_CLS[x.co]}">${esc(x.route)}</span>
        <div style="flex:1;min-width:0">
          <div class="nm">${nearRouteLabel(x)}</div>
          <div class="sub">${esc(x.stopName)} · ${fmtDistOf(x.dist, x.approx)} · ${esc(CO_NAME[x.co])}</div>
        </div><span class="muted">›</span></div>`).join('') + `</div>`;
  }
  h += `<div class="tiny muted" style="margin-top:8px">${
    view==='stop' ? '點車站看實時到站' : '點路線看完整站序'}</div></div>`;
  box.innerHTML = h;
  const b = $('#geoRetry'); if(b) b.onclick = ()=>{ geoDenied(false); requestNearby({force:true}); };
  $$('#nearCo .chip').forEach(c=>{
    c.onclick = ()=>{ setNearCo(c.dataset.nco); };
  });
  if(view==='stop') fillStopPreviews();   // 城巴／小巴的路線號碼隨後補上
}
/* 切換附近區塊的營辦商（同步上方主篩選列） */
function setNearCo(co){
  stopFilter = co;
  $$('#stopFilters .chip[data-co]').forEach(c=>c.setAttribute('aria-pressed', c.dataset.co===co));
  const chip = document.querySelector(`#routeFilters .chip[data-co="${co}"]`);
  if(chip){ routeFilter = co; $$('#routeFilters .chip').forEach(c=>c.setAttribute('aria-pressed', c===chip)); }
  if(co==='NLB' && !D.NLB.stop){ waitBus().then(ensureNlbStops).then(()=>{ if(nearData.pos) renderNearby(nearData.pos); }); return; }
  if(nearData.pos) renderNearby(nearData.pos);
}
/* 背景計算附近路線；算完只在仍停留於路線檢視時更新畫面 */
async function loadNearbyRoutes(){
  if(!nearRoutesOn() || !nearData.pos) return;
  const myTok = nearbyTok;
  let list = [];
  try{ list = await computeNearbyRoutes(nearData.pos.lat, nearData.pos.lng, stopFilter); }
  catch(e){ nearData.err = e; list = []; }
  if(myTok !== nearbyTok) return;         // 已有更新的計算，放棄這次結果
  nearData.routes = list;
  renderNearBox();                        // 讓「路線 N」的計數即時更新
}
function requestNearby({force=false, auto=false}={}){
  if(!navigator.geolocation){ renderGeoError('此瀏覽器／環境不支援定位功能'); return; }
  if(geoBusy) return;
  // 短時間內已有定位且非強制 → 直接用，避免重複彈權限提示
  if(!force && lastGeo && (Date.now()-lastGeo.t) < 120000){ renderNearBox(); return; }
  geoBusy = true;
  if(!auto) setBanner('stopMsg','正在定位…');
  const box = $('#nearBox');
  if(box) box.innerHTML = `<div class="card"><span class="spin"></span> 正在定位…</div>`;
  navigator.geolocation.getCurrentPosition(async pos=>{
    geoBusy = false;
    lastGeo = {lat:pos.coords.latitude, lng:pos.coords.longitude, acc:pos.coords.accuracy, t:Date.now()};
    geoDenied(false);
    setBanner('stopMsg','');
    await waitBus();                       // 等車站索引備妥才算距離
    await Promise.all([ waitMtrBus(6000), waitLrt(6000) ]);
    renderNearby(lastGeo);
  }, err=>{
    geoBusy = false;
    setBanner('stopMsg','');
    const denied = err && err.code===1;
    if(denied) geoDenied(true);
    renderGeoError(geoErrMsg(err), denied);
  }, {enableHighAccuracy:true, timeout:12000, maximumAge:60000});
}
/* ---------- 附近路線（由附近車站彙整出可搭乘的路線） ---------- */

/* 取某站停靠的路線：九巴／嶼巴用本地索引（零請求），城巴／小巴才打 API 並快取 */
async function routesAtStopOf(co, id){
  if(co==='KMB')
    return (D.KMB.routesAtStop?.get(String(id))||[])
      .map(x=>({route:String(x.route), bound:String(x.bound||'')})).filter(x=>x.route);
  if(co==='NLB')
    return (D.NLB.routesAtStop?.get(String(id))||[])
      .map(x=>({route:String(x.route), bound:''})).filter(x=>x.route);
  if(co==='MTRB')
    return (D.MTRB.routesAtStop?.get(String(id))||[])
      .map(x=>({route:String(x.route), bound:''})).filter(x=>x.route);
  if(co==='MTR')
    return (D.MTR.routesAtStop?.get(String(id))||[])
      .map(x=>({route:String(x.route), bound:''})).filter(x=>x.route);
  if(co==='LRT')
    return (D.LRT.routesAtStop?.get(String(id))||[])
      .map(x=>({route:String(x.route), bound:''})).filter(x=>x.route);
  if(co==='FERRY')
    return (D.FERRY.routesAtStop?.get(String(id))||[])
      .map(x=>({route:String(x.route), bound:''})).filter(x=>x.route);
  if(co==='CTB'){
    for(const mk of EP.ctbStopRoute){
      try{
        const j = await cachedGet(mk(id), 6*3600e3, {timeout:12000, tries:proxyOrder().slice(0,2)});
        const arr = asArray(pick(j,'data'))
          .map(d=>({route:String(pick(d,'route')||''), bound:String(pick(d,'dir')||'')}))
          .filter(x=>x.route);
        if(arr.length) return arr;
      }catch(e){}
    }
    return [];
  }
  if(co==='GMB'){
    for(const mk of [].concat(EP.gmbStopRoute)){
      try{
        const j = await cachedGet(mk(id), 6*3600e3, {timeout:12000});
        const arr = (plainArr(j).length ? plainArr(j) : plainArr(pick(j,'data')))
          .map(r=>({route:String(pick(r,'route_id','routeId','route','route_code')||''), bound:''}))
          .filter(x=>x.route);
        if(arr.length) return arr;
      }catch(e){}
    }
    return [];
  }
  return [];
}
/* 路線的目的地／描述 */
function routeDescOf(co, route, bound){
  const list = D[co]?.route || [];
  if(co==='GMB'){ const r = list.find(x=>x.route===route); return (r&&r.desc)||''; }
  if(co==='NLB'){ const r = list.find(x=>x.route===route); return (r&&r.orig)||''; }
  if(co==='MTRB'){ const r = list.find(x=>x.route===route); return (r&&(r.dest||r.orig))||''; }
  if(co==='MTR'){ const L = lineOf(route); return L ? L.name : ''; }
  if(co==='LRT'){ return ''; }
  if(co==='FERRY'){ const r = list.find(x=>x.route===route); return (r&&r.dest)||''; }
  const r = list.find(x=>x.route===route && (!bound || x.bound===bound)) || list.find(x=>x.route===route);
  return (r && (r.dest || r.orig)) || '';
}
/* 彙整附近路線。
   關鍵：每個營辦商各自取最近數站，而不是全取「最近的 N 站」——
   否則在九巴站點密集的地區，前 10 名全是九巴，城巴／小巴／嶼巴永遠不會出現。 */
const NEAR_STOP_QUOTA = 6;      // 每個營辦商取幾站來查路線
const NEAR_ROUTE_CAP  = 24;     // 結果最多幾條
const NEAR_ROUTE_FLOOR= 2;      // 每個營辦商至少幾條（保證多樣性）
async function computeNearbyRoutes(la, lo, co){
  const R = nearR();
  const inRange = allStops(co==='ALL'?'ALL':co)
    .map(s=>({s, d:dist(la,lo,s.lat,s.lng)}))
    .filter(x=>x.d < R && isFinite(x.d));
  if(!inRange.length) return [];
  let chosen;
  if(co==='ALL'){
    const byCo = new Map();
    inRange.sort((a,b)=>a.d-b.d);
    for(const x of inRange){
      const k = x.s.co;
      if(!byCo.has(k)) byCo.set(k, []);
      const arr = byCo.get(k);
      if(arr.length < NEAR_STOP_QUOTA) arr.push(x);
    }
    chosen = [].concat(...[...byCo.values()]);
  } else {
    chosen = inRange.sort((a,b)=>a.d-b.d).slice(0, NEAR_STOP_QUOTA*2);
  }
  const got = await pool(chosen, 4, async ({s, d})=>{
    try{
      const rs = await routesAtStopOf(s.co, s.id);
      return rs.map(r=>({co:s.co, route:r.route, bound:r.bound, stopName:s.tc, dist:d, approx:s.approx}));
    }catch(e){ return null; }
  });
  const map = new Map();
  for(const arr of got){
    if(!arr) continue;
    for(const it of arr){
      if(!it.route) continue;
      const k = it.co+'|'+it.route+'|'+it.bound;
      const prev = map.get(k);
      if(!prev || it.dist < prev.dist) map.set(k, it);
    }
  }
  const sorted = [...map.values()].sort((a,b)=> a.dist-b.dist || routeCmp(a.route,b.route));
  if(sorted.length <= NEAR_ROUTE_CAP) return sorted;
  const idx = new Set(), perCo = new Map();
  for(let i=0;i<sorted.length;i++){                   // 第一輪：保底
    const k = sorted[i].co;
    const n = perCo.get(k) || 0;
    if(n < NEAR_ROUTE_FLOOR){ perCo.set(k, n+1); idx.add(i); }
  }
  for(let i=0;i<sorted.length && idx.size < NEAR_ROUTE_CAP;i++) idx.add(i);  // 第二輪：補滿
  return [...idx].sort((a,b)=>a-b).map(i=>sorted[i]);
}
let nearbyTok = 0;
/* 開啟時自動執行一次；若當下不在「到站」分頁，就等切過去才做 */
let autoNearbyPending = false;
async function autoNearbyOnce(){
  if(SETTINGS.autoNearby===0 || SETTINGS.autoNearby==='0') return;
  if(geoDenied()){ renderGeoError('尚未定位（先前已拒絕權限）', true); return; }
  if(!navigator.geolocation){ renderGeoError('此瀏覽器／環境不支援定位功能', true); return; }
  if(activeTab !== 'stop'){ autoNearbyPending = true; return; }   // 別在使用者看別的分頁時彈權限
  if(lastGeo && (Date.now()-lastGeo.t) < 120000){ renderNearBox(); return; }
  await waitBus();
  await Promise.all([ waitMtrBus(8000), waitLrt(8000) ]);   // 鐵路資料也一起等
  requestNearby({auto:true});
}
function nearbyStops(){ requestNearby({force:true}); }
function waitBus(){
  return new Promise(res=>{
    if(busDataLoaded) return res();
    onLoad(res); needBusData();
  });
}

/* ---- 到站時間板 ---- */
let etaTimer = null, curStop = null, mtrTimer = null, curMtr = null;
async function openStopEta(co, id){
  curStop = {co, id};
  if(co==='NLB' && !D.NLB.stop) await ensureNlbStops();
  if(co==='MTRB' && !D.MTRB.ready) await loadMtrBus();
  if(co==='LRT' && !D.LRT.ready) await loadLrt();
  if(co==='FERRY') buildFerry();
  const box = $('#stopEta');
  const name = (D[co]?.stopById?.get(id) || {}).tc || id;
  box.innerHTML = `<div class="card"><div class="spread"><h2 style="margin:0">
      <span class="badge ${CO_CLS[co]}">${esc(co)}</span> ${esc(name)}</h2>
      <span class="spin"></span></div><div class="small muted" style="margin-top:6px">正在讀取實時到站…</div></div>`;
  box.scrollIntoView({behavior:'smooth', block:'start'});
  await fetchStopEta();
  restartEtaTimer();
}
async function fetchStopEta(){
  if(!curStop) return;
  if(document.hidden) return;        // 背景分頁不進行自動更新
  const {co, id} = curStop;
  const box = $('#stopEta');
  const name = (D[co]?.stopById?.get(id) || {}).tc || id;
  let rows = [], err = null;
  try{
    if(co==='KMB'){
      try{
        const j = await getJSON(EP.kmbStopEta(id), {timeout:15000});
        rows = asArray(pick(j,'data')).map(d=>{
          const e = asArray(pick(d,'eta'))[0] || {};
          return {route:pick(d,'route'), min: toMin(pick(e,'diff_min','diff')) ?? minsTo(pick(e,'eta','timestamp')),
                  iso: pick(e,'eta','timestamp') ?? null,
                  dest: pick(e,'dest_tc') || routeDest('KMB', pick(d,'route'), pick(d,'dir','bound')) || '',
                  rmk: pick(e,'rmk_tc') || ''};
        });
      }catch(e){
        // 備援：用本地「站→路線」索引逐路線查到站
        if(!D.KMB.routesAtStop) throw e;
        const list = (D.KMB.routesAtStop.get(id)||[]).slice(0,20);
        const got = await pool(list, 5, async it=>{
          try{
            const r = await getJSON(EP.kmbEta(id, it.route, it.service_type), {timeout:12000});
            const d = asArray(pick(r,'data'))[0]; if(!d) return null;
            return {route:it.route, min: minsTo(pick(d,'eta')), iso: pick(d,'eta') ?? null,
                    dest: pick(d,'dest_tc') || routeDest('KMB', it.route, it.bound) || '', rmk: pick(d,'rmk_tc') || ''};
          }catch(_){ return null; }
        });
        rows = got.filter(Boolean);
        if(!rows.length) throw e;
      }
    } else if(co==='CTB'){
      rows = await ctbStopEta(id);
    } else if(co==='GMB'){
      rows = await gmbStopEta(id);
    } else if(co==='NLB'){
      rows = await nlbStopEta(id);
    } else if(co==='MTRB'){
      if(!D.MTRB.ready) await loadMtrBus();
      rows = await mtrBusStopEta(id);
    } else if(co==='MTR'){
      rows = await mtrStationEta(id);
    } else if(co==='LRT'){
      if(!D.LRT.ready) await loadLrt();
      rows = await lrtStopEta(id);
    } else if(co==='FERRY'){
      rows = ferryNextSailings(id).map(s=>({route:s.route, min:s.min, iso:null,
                                            dest:s.dest||'', rmk:(FERRY_CO[s.op]||'')+' '+(s.dep||'')}));
    }
  }catch(e){ err = e; }
  if(err){
    box.innerHTML = `<div class="card"><h2>${esc(name)}</h2>
      <div class="banner err">⚠️ 無法取得實時到站：${esc(err.message)}<br>
      如屬 CORS 限制，可在「更多 → 設定」改用代理模式。</div></div>`;
    return;
  }
  rows = rows.filter(r=>r.route);
  rows.forEach(r=>{ r.min = toMin(r.min); });
  rows.sort((a,b)=>{
    const x = a.min===null?999:(a.min<0?998:a.min), y = b.min===null?999:(b.min<0?998:b.min);
    return x-y || String(a.route).localeCompare(String(b.route),'zh');
  });
  // 同一路線可能因方向／服務類型出現多次，只留最快的一班
  const seenR = new Set();
  rows = rows.filter(r=>{
    const k = String(r.route)+'|'+(r.dest||'');
    if(seenR.has(k)) return false; seenR.add(k); return true;
  });
  const updated = new Date().toLocaleTimeString('zh-HK',{hour12:false});
  box.innerHTML = `<div class="card">
    <div class="spread"><h2 style="margin:0"><span class="badge ${CO_CLS[co]}">${esc(co)}</span> ${esc(name)}</h2>
      <span class="tiny muted">${updated} 更新</span></div>
    ${co==='FERRY'? `<div class="banner" style="margin:6px 0 2px">⛴️ 渡輪沒有實時到站資料，以下為<b>時刻表推算</b>的下一班，實際以碼頭公佈為準。</div>`:''}
    <div class="small muted" style="margin:2px 0 8px">站號 ${esc(id)} · 共 ${rows.length} 條路線</div>
    ${rows.length? `<div class="stoplist">${rows.map(r=>`
      <div class="stoprow" data-route="${esc(r.route)}">
        <span class="badge ${CO_CLS[co]}">${esc(r.route)}</span>
        <div style="flex:1;min-width:0">
          <div class="small">往 ${esc(r.dest||'—')}</div>
          ${r.rmk?`<div class="tiny muted">${esc(r.rmk)}</div>`:''}
        </div>
        ${etaHtml(r.min, r.iso)}
      </div>`).join('')}</div>`
      : '<div class="empty">此刻沒有班次資料（可能是服務時間外）。</div>'}
    <div class="sep"></div>
    <div class="act">
      <button class="btn sm ghost" id="etaRefresh">↻ 立即更新</button>
      <button class="btn sm ghost" id="etaFav">★ 收藏此站</button>
    </div>
  </div>`;
  $('#etaRefresh').onclick = fetchStopEta;
  $('#etaFav').onclick = ()=>{ addFav({co, id, name}); };
}
/* 港鐵巴士路線頁：用車站 CSV 篩出此路線的站序（無額外請求） */
let _mtrbRows = null;
async function mtrbRouteRows(){
  if(_mtrbRows && _mtrbRows.length) return _mtrbRows;   // 空結果不快取，下次可重試
  if(!D.MTRB.ready) await loadMtrBus();
  try{
    const txt = await cachedText(EP.mtrbStopCsv, 24*3600e3, {timeout:30000});
    const rows = parseCSV(txt);
    if(rows.length>1) _mtrbRows = rows;
  }catch(e){}
  return _mtrbRows || [];
}
async function renderMtrbRoute(co, route){
  const box = $('#routeDetail');
  const info = (D.MTRB.route||[]).find(r=>r.route===route) || {};
  const rows = await mtrbRouteRows();
  const stops = [];
  if(rows.length){
    const h = rows[0];
    const cR  = csvCol(h,'Route Code','RouteCode','route_code','route','路線');
    const cId = csvCol(h,'Stop ID','StopID','stop_id','stop','站編號');
    const cN  = csvCol(h,'Stop Name TC','Stop Name','stop_name','name','站名');
    const cSq = csvCol(h,'Stop Seq','stop_seq','sequence','seq','站序');
    const seen = new Set();
    for(let i=1;i<rows.length;i++){
      const r = rows[i];
      if(String((cR>=0?r[cR]:'')||'').trim() !== String(route)) continue;
      const id = String((cId>=0?r[cId]:'')||'').trim();
      if(!id || seen.has(id)) continue;
      seen.add(id);
      stops.push({id, name:((cN>=0?r[cN]:'')||'').trim(), seq:+(cSq>=0?r[cSq]:0)||0});
    }
    stops.sort((a,b)=>a.seq-b.seq);
  }
  box.innerHTML = `<div class="card"><div class="spread">
    <h2 style="margin:0"><span class="badge mtrb">${esc(route)}</span> 港鐵巴士</h2>
    ${info.dest?`<span class="small muted">往 ${esc(info.dest)}</span>`:''}</div>
    ${stops.length? `<div class="sep"></div><div class="stoplist">${stops.map((s,i)=>`
      <div class="stoprow" data-stop="${esc(s.id)}"><span class="stopdot"></span>
      <div style="flex:1"><div class="small">${i+1}. ${esc(s.name||s.id)}</div></div>
      <span class="eta tiny"></span></div>`).join('')}</div>`
      : `<div class="sep"></div><div class="empty">找不到此路線的站序資料。</div>`}
    <div class="sep"></div><div class="tiny muted">站序取自港鐵開放資料 CSV。</div></div>`;
  $$('#routeDetail .stoprow').forEach(el=>{ el.onclick = ()=>openStopEta('MTRB', el.dataset.stop); });
}
/* 港鐵巴士到站：API 以「路線」為單位回傳，需先知道此站有哪些路線，再逐路線 POST */
async function mtrBusStopEta(stopId){
  const routes = (D.MTRB.routesAtStop?.get(String(stopId)) || []).slice(0, 12);
  if(!routes.length) return [];
  const out = await pool(routes, 4, async ({route, sid})=>{
    try{
      // 同一實體站在不同路線有不同編號，必須用該路線自己的編號去比對
      const want = String(sid || stopId);
      const j = await postJSON(EP.mtrbEta, {language:'zh', routeName:route}, {timeout:20000});
      const stops = asArray(pick(j,'busStop','bus_stop','data'));
      const mine = stops.find(x=>String(pick(x,'busStopId','bus_stop_id','stopId','stop_id'))===want);
      if(!mine) return null;
      const bus = asArray(pick(mine,'bus'));
      const first = bus[0];
      if(!first) return null;
      const sec = +pick(first,'arrivalTimeInSecond','arrivalTime','eta');
      const dep = +pick(first,'departureTimeInSecond');
      const use = (Number.isFinite(sec) && sec < 108000) ? sec : dep;   // 108000 = 無資料
      const desc = routeDescOf('MTRB', route);
      return {
        route,
        min: Number.isFinite(use) ? Math.round(use/60) : null,
        iso: null,
        dest: desc || '',
        rmk: pick(first,'busRemark') || (pick(first,'isScheduled')=='1' ? '預定班次' : '') || ''
      };
    }catch(e){ return null; }
  });
  return out.filter(Boolean);
}
/* 港鐵重鐵到站：以站為單位，對每條途經路線查一次官方 API */
async function mtrStationEta(sta){
  const lines = (MTR_ST[sta] && MTR_ST[sta].lines) || [];
  const got = await pool(lines, 4, async line=>{
    try{
      const j = await cachedGet(EP.mtrSched(line, sta), 30e3, {timeout:15000});
      const d = j.data || {};
      let node = null;
      for(const k of Object.keys(d)){ if(k.indexOf(line+'-'+sta)===0){ node = d[k]; break; } }
      if(!node) return null;
      const all = [].concat(asArray(node.UP), asArray(node.DOWN));
      const f = all.slice().sort((a,b)=>(+pick(a,'seq')||0)-(+pick(b,'seq')||0))[0];
      if(!f) return null;
      let min = toMin(pick(f,'ttnt'));
      if(min===null) min = minsToHk(pick(f,'time'));
      const destCode = pick(f,'dest');
      const dn = (MTR_ST[destCode] && MTR_ST[destCode].tc) || destCode || '';
      return {route:line, min, iso:pick(f,'time')||null, dest:dn,
              rmk: pick(f,'plat') ? ('月台 '+pick(f,'plat')) : ''};
    }catch(e){ return null; }
  });
  return got.filter(Boolean);
}
/* 輕鐵到站：官方以站號回傳各月台路線 */
async function lrtStopEta(rawId){
  const id = String(rawId).replace(/^LR/i,'');      // API 用數字編號：LR001 -> 001
  let j;
  try{ j = await cachedGet(EP.lrtEta(id), 30e3, {timeout:15000}); }
  catch(e){ return []; }
  const plats = asArray(pick(j,'platform_list'));
  const out = [];
  for(const p of plats){
    const pid = pick(p,'platform_id');
    for(const r of asArray(pick(p,'route_list'))){
      const route = pick(r,'route_no');
      if(!route) continue;
      out.push({route, min: parseLrtTime(pick(r,'time_ch') ?? pick(r,'time_en')),
                iso:null, dest: pick(r,'dest_ch') || '',
                rmk: pid ? ('月台 '+pid) : ''});
    }
  }
  return out;
}
/* 港鐵時間格式為「YYYY-MM-DD HH:mm:ss」（香港時間），非 ISO */
function minsToHk(t){
  if(!t) return null;
  const s = String(t).trim().replace(' ', 'T');
  const d = new Date(/[Z+]|-\d\d:$/.test(s) ? s : s + '+08:00');
  if(isNaN(d)) return null;
  return Math.round((d.getTime()-Date.now())/60000);
}
function routeDest(co, route, bound){
  const list = D[co]?.route || [];
  const r = list.find(x=>x.route===route && (!bound || x.bound===bound));
  return r ? r.dest : '';
}
async function ctbStopEta(stopId){
  // 找出停靠此站的城巴路線
  let routes = [];
  for(const mk of EP.ctbStopRoute){
    try{
      const j = await getJSON(mk(stopId), {timeout:12000});
      routes = asArray(pick(j,'data')).map(d=>({route:pick(d,'route'), dir:pick(d,'dir')}));
      if(routes.length) break;
    }catch(e){}
  }
  if(!routes.length){
    // 批次站點路線端點不可用時才退回逐一試，限量以控制請求數
    routes = (D.CTB.route||[]).slice(0,15).map(r=>({route:r.route, dir:r.bound}));
  }
  const uniq = [...new Map(routes.map(r=>[r.route+'|'+r.dir, r])).values()].slice(0,20);
  const out = await pool(uniq, 6, async r=>{
    try{
      const j = await getJSON(EP.ctbEta(stopId, r.route), {timeout:12000});
      const arr = asArray(pick(j,'data'));
      const d = arr.find(x=>!r.dir || x.dir===r.dir) || arr[0];
      if(!d) return null;
      return {route:r.route, min: minsTo(d.eta), iso:d.eta, dest:d.dest_tc||'', rmk:d.rmk_tc||''};
    }catch(e){ return null; }
  });
  return out.filter(Boolean);
}
/* 小巴到站回應有兩種嵌套：
   /eta/stop/{stop}  → data:[{route_id, route_seq, enabled, eta:[{diff,timestamp,remarks_tc}]}]
   /stop-eta/{stop}  → data:[{route_id, eta:[…]}] 或扁平 ETA 陣列 */
/* seq / bound 有值時才篩選：小巴到站 API 一次回傳整條路線所有站的班次，
   不篩選就會拿別站的時間當成這一站的（這是之前最主要的錯誤來源）。
   依 hkbus 官方用法：route_seq 1=去程(O) 2=回程(I)，stop_seq = 站序+1 */
function gmbEtaRows(j, seq, bound, defRoute){
  const out = [];
  const items = plainArr(j);
  for(const e of items){
    if(!e || typeof e!=='object') continue;
    if(Number.isFinite(seq)){
      const ss = +pick(e,'stop_seq');
      if(Number.isFinite(ss) && ss !== seq+1) continue;
    }
    if(bound){
      const rs = +pick(e,'route_seq');
      if(Number.isFinite(rs)){
        if(bound==='O' && rs!==1) continue;
        if(bound==='I' && rs!==2) continue;
      }
    }
    const inner = Array.isArray(e.eta) ? e.eta : null;
    const targets = (inner && inner.length) ? inner : [e];
    for(const t of targets){
      if(!t || typeof t!=='object') continue;
      // 到站回應不一定帶路線號，帶不出來時用呼叫端已知的路線（hkbus 亦是如此處理）
      const route = String(pick(e,'route_id','routeId','route','routeNo')
                        ?? pick(t,'route_id','routeId','route','routeNo')
                        ?? defRoute ?? '');
      const min = toMin(pick(t,'diff','diff_min')) ?? minsTo(pick(t,'timestamp','eta','estimatedArrivalTime'));
      const iso = pick(t,'timestamp','eta','estimatedArrivalTime') ?? null;
      let rmk = pick(t,'remarks_tc') || pick(e,'remarks_tc') || '';
      if(e.enabled===false || String(e.enabled)==='0') rmk = pick(e,'description_tc') || '服務暫停';
      out.push({route, min, iso,
                dest: pick(e,'description_tc') || pick(t,'description_tc') || '', rmk});
    }
  }
  // 同一路線只留最快一班
  const best = new Map();
  for(const r of out){
    const k = r.route + '|' + r.dest;
    const prev = best.get(k);
    if(!prev || ((r.min ?? 9999) < (prev.min ?? 9999))) best.set(k, r);
  }
  return [...best.values()];
}
async function gmbStopEta(stopId){
  // 1) 優先用內建資料：已知每條路線的 gtfsId 與站序，一次就查對
  const built = (D.GMB.routesAtStop?.get(String(stopId))||[]).filter(x=>x.gtfs).slice(0,12);
  if(built.length){
    const got = await pool(built, 4, async it=>{
      try{
        const j = await getJSON(EP.gmbEta(it.gtfs, stopId), {timeout:12000, tries:proxyOrder().slice(0,2)});
        const first = gmbEtaRows(j, it.seq, it.bound, it.route)[0];
        if(first) return {route:it.route, min:first.min, iso:first.iso, dest:first.dest, rmk:first.rmk};
      }catch(e){}
      return null;
    });
    const rows = got.filter(Boolean);
    if(rows.length) return rows;
  }
  // 2) 內建資料不可用時，退回逐路線查詢（順序：gtfsId 優先，其次 route_id）
  let routeIds = [];
  try{
    const j = await cachedGetAny(EP.gmbStopRoute(stopId), 6*3600e3, {timeout:15000});
    routeIds = plainArr(j)
      .map(r=>({id:String(pick(r,'route_id','routeId','route') ?? ''),
                gtfs:String(pick(r,'gtfsId','gtfs_id','route_id','routeId','route') ?? '')}))
      .filter(r=>r.id);
  }catch(e){ return []; }
  if(!routeIds.length) return [];
  const out = await pool(routeIds.slice(0,12), 4, async r=>{
    for(const rid of [r.gtfs, r.id]){
      if(!rid) continue;
      for(const u of EP.gmbEtaAlts(rid, stopId)){
        try{
          const j = await getJSON(u, {timeout:12000, tries:proxyOrder().slice(0,2)});
          const first = gmbEtaRows(j)[0];
          if(first) return {route:r.id, min:first.min, iso:first.iso, dest:first.dest, rmk:first.rmk};
        }catch(e){}
      }
    }
    return null;
  });
  return out.filter(Boolean);
}
async function nlbStopEta(stopId){
  if(!D.NLB.routesAtStop) await ensureNlbStops();
  // 只查真正停靠此站的路線（沒索引時才退回全路線清單）
  const routes = (D.NLB.routesAtStop && D.NLB.routesAtStop.get(String(stopId))) || (D.NLB.route||[]).slice(0,40);
  const out = await pool(routes, 5, async r=>{
    try{
      const j = await getJSON(EP.nlbEta(r.id, stopId), {timeout:12000});
      const a = asArray(pick(j,'estimatedArrivals','data'))[0];
      if(!a) return null;
      return {route:r.route, min: a.departed?0:minsTo(a.estimatedArrivalTime), iso:a.estimatedArrivalTime||null,
              dest:'', rmk: a.noGPS?'（無 GPS 訊號）':''};
    }catch(e){ return null; }
  });
  return out.filter(Boolean);
}
document.addEventListener('visibilitychange', ()=>{
  if(!document.hidden){
    if(curStop) fetchStopEta();
    const L = $('#mtrLine');
    if(L && L.value && curMtr) fetchMtrBoard(curMtr.line, curMtr.sta);
  }
});
function restartEtaTimer(){
  clearInterval(etaTimer);
  let sec = +SETTINGS.refresh||0;
  if(sec<=0 || !curStop) return;
  // 城巴／小巴／嶼巴查一站要打多次 API，間隔加長避免觸發限速
  if(curStop.co!=='KMB') sec = Math.max(sec, 40);
  etaTimer = setInterval(fetchStopEta, sec*1000);
}
function addFav(o){
  const f = getFavs();
  if(!f.find(x=>x.co===o.co && x.id===o.id)){ f.push(o); localStorage.setItem('hkT.fav', JSON.stringify(f)); }
  renderFavs();
  const b = $('#etaFav'); if(b){ b.textContent = '★ 已收藏'; setTimeout(()=>{ if(b.isConnected) b.textContent='★ 收藏此站'; }, 1400); }
}

/* ============================================================
   路線查詢
   ============================================================ */
let routeFilter='ALL';
$('#routeQ').addEventListener('input', e=>{
  clearTimeout(stopTimer);
  const q = e.target.value.trim();
  stopTimer = setTimeout(()=>renderRouteSearch(q), 220);
});
$('#routeFilters').addEventListener('click', e=>{
  const b = e.target.closest('.chip'); if(!b) return;
  routeFilter = b.dataset.co;
  $$('#routeFilters .chip').forEach(c=>c.setAttribute('aria-pressed', c===b));
  renderRouteSearch($('#routeQ').value.trim());
});
function allRoutes(co){
  let out=[];
  if((co==='ALL'||co==='KMB') && D.KMB.route) out=out.concat(D.KMB.route);
  if((co==='ALL'||co==='CTB') && D.CTB.route) out=out.concat(D.CTB.route);
  if((co==='ALL'||co==='GMB') && D.GMB.route) out=out.concat(D.GMB.route);
  if((co==='ALL'||co==='NLB') && D.NLB.route) out=out.concat(D.NLB.route);
  if((co==='ALL'||co==='MTRB') && D.MTRB.route) out=out.concat(D.MTRB.route);
  if((co==='ALL'||co==='MTR') && D.MTR.route) out=out.concat(D.MTR.route);
  if((co==='ALL'||co==='LRT') && D.LRT.route) out=out.concat(D.LRT.route);
  if((co==='ALL'||co==='FERRY') && D.FERRY.route) out=out.concat(D.FERRY.route);
  return out;
}
function renderRouteSearch(q){
  const box = $('#routeResults');
  if(!q){ box.innerHTML=''; return; }
  if(!needBusData()){ setBanner('routeMsg','正在載入路線資料，請稍候…'); return; }
  const nq = norm(q);
  const res = allRoutes(routeFilter)
    .filter(r=>norm(r.route)===nq || norm(r.route).startsWith(nq))
    .sort((a,b)=> String(a.route).length-String(b.route).length || String(a.route).localeCompare(String(b.route)));
  if(!res.length){ box.innerHTML=`<div class="card empty">找不到「${esc(q)}」路線。</div>`; return; }
  const seen = new Set();
  const uniq = res.filter(r=>{ const k=r.co+r.route; if(seen.has(k)) return false; seen.add(k); return true; });
  box.innerHTML = uniq.slice(0,40).map(r=>`
    <div class="item" data-co="${r.co}" data-route="${esc(r.route)}">
      <span class="badge ${CO_CLS[r.co]}">${esc(r.route)}</span>
      <div style="flex:1;min-width:0">
        <div class="nm">${esc(r.desc || [r.orig, r.dest].filter(Boolean).join(' → ') || '—')}</div>
        <div class="sub">${esc(CO_NAME[r.co])}</div>
      </div><span class="muted">›</span>
    </div>`).join('');
}
$('#routeResults').addEventListener('click', e=>{
  const it = e.target.closest('.item'); if(!it) return;
  openRoute(it.dataset.co, it.dataset.route);
});
async function openRoute(co, route){
  const box = $('#routeDetail');
  box.innerHTML = `<div class="card"><div class="spread"><h2 style="margin:0">
    <span class="badge ${CO_CLS[co]}">${esc(route)}</span> 路線資料</h2><span class="spin"></span></div></div>`;
  box.scrollIntoView({behavior:'smooth',block:'start'});
  try{
    if(co==='KMB')  await renderKmbRoute(co, route);
    else if(co==='CTB')  await renderCtbRoute(co, route);
    else if(co==='NLB')  await renderNlbRoute(co, route);
    else if(co==='GMB')  await renderGmbRoute(co, route);
    else if(co==='MTRB') await renderMtrbRoute(co, route);
    else box.innerHTML = `<div class="card"><div class="banner err">⚠️ 不支援的營辦商</div></div>`;
  }catch(e){
    box.innerHTML = `<div class="card"><div class="banner err">⚠️ 載入路線失敗：${esc(e.message||e)}</div></div>`;
  }
}
function stopName(co, id){
  return (D[co]?.stopById?.get(String(id))||{}).tc || id;
}
async function renderKmbRoute(co, route){
  const rs = (D.KMB.rs||[]).filter(r=>r.route===route);
  const byDir = {};
  rs.forEach(r=>{ (byDir[r.bound] ||= []).push(r); });
  Object.values(byDir).forEach(a=>a.sort((x,y)=>x.seq-y.seq));
  const info = (D.KMB.route||[]).filter(r=>r.route===route);
  const box = $('#routeDetail');
  const dirs = Object.keys(byDir);
  box.innerHTML = `<div class="card">
    <h2><span class="badge kmb">${esc(route)}</span> 九巴／龍運路線</h2>
    ${info.map(i=>`<div class="small">${esc(i.orig)} → ${esc(i.dest)}</div>`).join('')}
  </div>` + dirs.map(d=>{
    const inf = info.find(i=>i.bound===d)||{};
    const stops = byDir[d];
    return `<div class="card" data-dir="${d}">
      <h2>往 ${esc(inf.dest || (stops.length?stopName('KMB', stops[stops.length-1].stop):''))}</h2>
      <div class="stoplist">${stops.map((s,i)=>`
        <div class="stoprow" data-stop="${esc(s.stop)}" data-seq="${s.seq}" data-st="${s.service_type}" data-bound="${d}">
          <span class="stopdot"></span>
          <div style="flex:1"><div class="small">${i+1}. ${esc(stopName('KMB', s.stop))}</div></div>
          <span class="eta tiny" data-eta="${esc(s.stop)}"></span>
        </div>`).join('')}</div></div>`;
  }).join('');
  // 兩個方向都載入實時到站
  for(const d of dirs) loadKmbRouteEta(route, d, byDir[d]);

  // 站序表：點擊任一車站可直接看該站到站
  $$('#routeDetail .stoprow').forEach(el=>{
    el.onclick = ()=> openStopEta('KMB', el.dataset.stop);
  });
}
async function loadKmbRouteEta(route, dir, stops){
  if(!stops) return;
  const st = stops[0].service_type;
  // 逐站查詢（限制併發，避免觸發 API 限速）
  const chunk = stops.slice(0,45);
  const etas = await pool(chunk, 6, async s=>{
    try{
      const r = await getJSON(EP.kmbEta(s.stop, route, st), {timeout:12000});
      const arr = asArray(pick(r,'data'));
      const d = arr.find(x=>x.dir===dir) || arr[0];
      return [s.stop, d? {min:minsTo(d.eta), iso:d.eta, rmk:d.rmk_tc, dest:d.dest_tc}:null];
    }catch(e){ return [s.stop, null]; }
  });
  const map = new Map(etas);
  chunk.forEach(s=>{
    const el = document.querySelector(`.stoprow[data-stop="${s.stop}"][data-bound="${dir}"] .eta`);
    if(!el) return;
    const e = map.get(s.stop);
    el.innerHTML = e ? etaHtml(e.min, e.iso) : '<span class="eta none">—</span>';
  });
}
async function renderCtbRoute(co, route){
  const box = $('#routeDetail');
  const dirs = ['outbound','inbound'];
  const data = {};
  for(const d of dirs){
    try{
      const j = await getJSON(EP.ctbRS(route, d), {timeout:15000});
      data[d] = asArray(j.data).sort((a,b)=>a.seq-b.seq);
    }catch(e){ data[d]=[]; }
  }
  const infos = (D.CTB.route||[]).filter(r=>r.route===route);
  box.innerHTML = `<div class="card"><h2><span class="badge ctb">${esc(route)}</span> 城巴路線</h2>
    ${infos.map(i=>`<div class="small">${esc(i.orig)} → ${esc(i.dest)}</div>`).join('')}</div>` +
    dirs.filter(d=>data[d].length).map(d=>{
      const inf = infos.find(i=>(i.bound==='O')===(d==='outbound'))||infos[0]||{};
      return `<div class="card" data-dir="${d}"><h2>${d==='outbound'?'往 '+esc(inf.dest||''):'往 '+esc(infos[1]?.dest||inf.orig||'')}</h2>
      <div class="stoplist">${data[d].map((s,i)=>`
        <div class="stoprow" data-stop="${esc(s.stop)}" data-dir="${d}">
          <span class="stopdot"></span>
          <div style="flex:1"><div class="small">${i+1}. ${esc(stopName('CTB', s.stop))}</div></div>
          <span class="eta tiny"></span>
        </div>`).join('')}</div></div>`;
    }).join('');
  // 抽樣載入到站（每 3 站一次，避免請求過量）
  for(const d of dirs){
    const stops = data[d]||[];
    const sample = stops.filter((_,i)=>i%3===0).slice(0,14);
    await pool(sample, 5, async s=>{
      try{
        const r = await getJSON(EP.ctbEta(s.stop, route), {timeout:12000});
        const arr2 = asArray(pick(r,'data'));
        const dd = arr2.find(x=>(d==='outbound'?x.dir==='O':x.dir==='I')) || arr2[0];
        const el = document.querySelector(`.stoprow[data-stop="${s.stop}"][data-dir="${d}"] .eta`);
        if(el) el.innerHTML = dd ? etaHtml(minsTo(dd.eta), dd.eta) : '<span class="eta none">—</span>';
      }catch(e){}
    });
  }
}
async function renderNlbRoute(co, route){
  const box = $('#routeDetail');
  const info = (D.NLB.route||[]).find(r=>r.route===route);
  const j = await getJSON(EP.nlbRS(info.id), {timeout:15000});
  const stops = asArray(pick(j,'stops','data'));
  box.innerHTML = `<div class="card"><h2><span class="badge nlb">${esc(route)}</span> 新大嶼山巴士</h2>
    <div class="small">${esc(info?.orig||'')}</div></div>
    <div class="card"><h2>車站</h2><div class="stoplist">${stops.map((s,i)=>{
      const sid = String(pick(s,'stopId','stop_id','stop') ?? '');
      return `<div class="stoprow" data-stop="${esc(sid)}"><span class="stopdot"></span>
      <div style="flex:1"><div class="small">${i+1}. ${esc(pick(s,'stopName_c','name_tc','stopName')||sid)}</div></div>
      <span class="eta tiny" data-nlb="${esc(sid)}"></span></div>`;
    }).join('')}</div></div>`;
  const sample = stops.filter((_,i)=>i%3===0).slice(0,12);
  await pool(sample, 5, async s=>{
    const sid = String(pick(s,'stopId','stop_id','stop') ?? '');
    try{
      const r = await getJSON(EP.nlbEta(info.id, sid), {timeout:12000});
      const a = asArray(pick(r,'estimatedArrivals','data'))[0];
      const el = document.querySelector(`[data-nlb="${sid}"]`);
      if(el) el.innerHTML = a ? etaHtml(pick(a,'departed')?0:minsTo(pick(a,'estimatedArrivalTime','eta')), pick(a,'estimatedArrivalTime','eta')) : '<span class="eta none">—</span>';
    }catch(e){}
  });
}
/* 官方規格是 /route-stop/{route_id}/{route_seq}，需補抓 1、2 兩個方向 */
async function gmbRouteStops(ids){
  for(const id of ids){
    let arr = [];
    try{
      const j = await getJSON(EP.gmbRS(id), {timeout:15000});
      arr = Array.isArray(j?.data?.route_stops) ? j.data.route_stops : plainArr(j);
    }catch(e){}
    if(arr.length) return arr;
    // 沒帶 route_seq 拿不到，改抓兩個方向
    const got = await pool([1,2], 2, async seq=>{
      try{
        const j = await getJSON(EP.gmbRS2(id, seq), {timeout:15000});
        const a = Array.isArray(j?.data?.route_stops) ? j.data.route_stops : plainArr(j);
        return a.map(x=>(x && typeof x==='object') ? Object.assign({}, x, {route_seq:seq}) : x);
      }catch(e){ return null; }
    });
    const extra = got.filter(Boolean).flat();
    if(extra.length) return extra;
  }
  return [];
}
async function renderGmbRoute(co, route){
  const box = $('#routeDetail');
  const info = (D.GMB.route||[]).find(r=>r.route===route);
  const ids = [...new Set([info?.gtfs, info?.route, route].filter(Boolean))];
  const raw = await gmbRouteStops(ids);
  const bySeq = {};
  raw.forEach(s=>{
    if(!s || typeof s!=='object') return;
    const k = String(pick(s,'route_seq','routeSeq') ?? 1);
    (bySeq[k] ||= []).push(s);
  });
  Object.values(bySeq).forEach(a=>a.sort((x,y)=>(+pick(x,'stop_seq','stopSeq')||0)-(+pick(y,'stop_seq','stopSeq')||0)));
  const keys = Object.keys(bySeq).sort((a,b)=>(+a)-(+b));
  if(!keys.length){
    box.innerHTML = `<div class="card"><h2><span class="badge gmb">${esc(route)}</span> 專線小巴</h2>
      <div class="banner err">⚠️ 抓不到此路線的車站（可能是路線代碼不適用於即時到站系統）。</div></div>`;
    return;
  }
  box.innerHTML = `<div class="card"><h2><span class="badge gmb">${esc(route)}</span> 專線小巴</h2>
    <div class="small">${esc(info?.desc||'')}</div></div>` +
    keys.map(k=>`
    <div class="card"><h2>${k==='1'?'去程':'回程'}</h2><div class="stoplist">${bySeq[k].map((s,i)=>`
      <div class="stoprow" data-stop="${esc(String(pick(s,'stop_id','stopId','stop') ?? ''))}"><span class="stopdot"></span><div style="flex:1">
      <div class="small">${i+1}. ${esc(pick(s,'stop_name_c','name_tc') || stopName('GMB', pick(s,'stop_id','stopId','stop')))}</div></div>
      <span class="eta tiny"></span></div>`).join('')}</div></div>`).join('');
}

/* ============================================================
   港鐵
   ============================================================ */
function initMtr(){
  const sel = $('#mtrLine');
  sel.innerHTML = MTR_LINES.map(L=>`<option value="${L.code}">${L.name}（${L.code}）</option>`).join('');
  const stOpts = Object.entries(MTR_ST).map(([c,s])=>`<option value="${c}">${s.tc}（${c}）</option>`).join('');
  $('#mtrFrom').innerHTML = stOpts; $('#mtrTo').innerHTML = stOpts;
  $('#mtrFrom').value='CEN'; $('#mtrTo').value='TSW';
  sel.addEventListener('change', renderMtrStations);
  renderMtrStations();
  $('#mtrPlanBtn').onclick = ()=>{
    const a=$('#mtrFrom').value, b=$('#mtrTo').value;
    $('#mtrPlan').innerHTML = renderMtrPlan(a,b);
  };
}
function renderMtrStations(){
  const L = lineOf($('#mtrLine').value) || MTR_LINES[0];
  $('#mtrStations').innerHTML = L.st.map(([c,tc])=>`
    <div class="item" data-sta="${c}">
      <span class="badge mtr" style="background:${L.color};color:#fff">${esc(c)}</span>
      <div style="flex:1"><div class="nm">${esc(tc)}</div>
      <div class="sub">${(MTR_ST[c]?.lines||[]).map(x=>lineOf(x)?.name || x).join(' · ')}</div></div>
      <span class="muted">›</span>
    </div>`).join('');
}
$('#mtrStations').addEventListener('click', e=>{
  const it = e.target.closest('.item'); if(!it) return;
  openMtrBoard($('#mtrLine').value, it.dataset.sta);
});
async function openMtrBoard(line, sta){
  const L0 = lineOf(line);
  if(!L0) return;
  curMtr = {line, sta};
  const box = $('#mtrBoard');
  const L = L0;
  const nm = MTR_ST[sta]?.tc || sta;
  box.innerHTML = `<div class="card"><div class="spread"><h2 style="margin:0">
    <span class="badge mtr" style="background:${L.color};color:#fff">${esc(L.name)}</span> ${esc(nm)}</h2>
    <span class="spin"></span></div><div class="small muted" style="margin-top:6px">讀取下一班車…</div></div>`;
  box.scrollIntoView({behavior:'smooth',block:'start'});
  await fetchMtrBoard(line, sta);
  clearInterval(mtrTimer);
  mtrTimer = setInterval(()=>fetchMtrBoard(line, sta), 20000);
}
async function fetchMtrBoard(line, sta){
  if(document.hidden) return;
  const L = lineOf(line);
  if(!L) return;
  const nm = MTR_ST[sta]?.tc || sta;
  let data=null, err=null, isDelay=false, apiMsg='';
  try{
    // lang 參數大小寫在不同時期改過，兩種都試
    const j = await getJSONAny(EP.mtrSchedAlts(line, sta), {timeout:15000});
    // 回應：{status, isdelay, data:{"TWL-CEN-1":{UP:[…],DOWN:[…]}}}
    // 同一站可能有多個月台／方向組，全部合併起來才完整
    const merged = {};
    if(j && j.data && typeof j.data==='object'){
      for(const v of Object.values(j.data)){
        if(!v || typeof v!=='object') continue;
        for(const k of ['UP','DOWN','UT','DT']){
          if(Array.isArray(v[k])) (merged[k] ||= []).push(...v[k]);
        }
      }
    } else if(j && typeof j==='object'){
      for(const k of ['UP','DOWN','UT','DT']) if(Array.isArray(j[k])) (merged[k] ||= []).push(...j[k]);
    }
    if(Object.keys(merged).length) data = merged;
    const dl = String(pick(j,'isdelay','isDelay') ?? '');
    isDelay = dl==='Y' || dl==='1' || dl==='true';
    if(j && (j.status===0 || j.status==='0')) apiMsg = pick(j,'message','msg') || '港鐵 API 未提供此組合的班次';
  }catch(e){ err = e; }
  const box = $('#mtrBoard');
  if(err || !data){
    box.innerHTML = `<div class="card"><h2><span class="badge mtr" style="background:${L.color};color:#fff">${esc(L.name)}</span> ${esc(nm)}</h2>
      <div class="banner err">⚠️ 未能取得班次${err?'（'+esc(err.message)+'）':''}。<br>
      ${esc(apiMsg||'此站此方向可能不提供即時班次（港鐵 API 僅涵蓋指定車站組合）。')}</div>
      <div class="tiny muted" style="margin-top:8px">可在「更多 → 連線診斷」確認 API 是否可連。</div></div>`;
    return;
  }
  const upd = new Date().toLocaleTimeString('zh-HK',{hour12:false});
  const dirs = [['UP','上行','往 '+ (L.st[L.st.length-1][1])], ['DOWN','下行','往 '+ (L.st[0][1])],
                ['UT','上行','往 '+ (L.st[L.st.length-1][1])], ['DT','下行','往 '+ (L.st[0][1])]];
  let html = `<div class="card"><div class="spread"><h2 style="margin:0">
      <span class="badge mtr" style="background:${L.color};color:#fff">${esc(L.name)}</span> ${esc(nm)}</h2>
      <span class="tiny muted">${upd}</span></div>`;
  if(isDelay) html += `<div class="banner err" style="margin-top:8px">⚠️ 港鐵通報：此綫服務可能受阻</div>`;
  let any=false;
  for(const [key,label,to] of dirs){
    const arr = data[key]; if(!Array.isArray(arr)) continue;
    any = true;
    html += `<div class="sep"></div><h2>${label} <span class="tiny muted">${esc(to)}</span></h2><div class="list">`;
    html += arr.slice(0,4).map(t=>{
      const min = (t.ttnt!==undefined && t.ttnt!==null) ? +t.ttnt : (t.time? minsTo(t.time) : null);
      const dest = MTR_ST[t.dest]?.tc || t.dest || '';
      return `<div class="item" style="cursor:default">
        <div style="flex:1"><div class="nm">往 ${esc(dest)}</div>
        <div class="sub">${t.plat?'月台 '+esc(t.plat):''} ${t.time?esc(hhmm(t.time)):''}</div></div>
        ${etaHtml(min, t.time)}</div>`;
    }).join('') || '<div class="empty tiny">暫無班次</div>';
    html += `</div>`;
  }
  if(!any) html += `<div class="empty">此站沒有即時班次資料。</div>`;
  html += `</div>`;
  box.innerHTML = html;
}
/* --- 港鐵行程規劃（Dijkstra，(站,線) 狀態） --- */
function mtrPlan(from, to){
  if(from===to) return {legs:[], minutes:0, stops:0};
  const nodes = [];                    // [station, line]
  const idx = new Map();
  // 機場快綫需另購車票：只在起點或終點為機場／博覽館時納入
  const allowAel = ['AIR','AWE'].includes(from) || ['AIR','AWE'].includes(to);
  MTR_LINES.forEach(L=>{
    if(L.code==='AEL' && !allowAel) return;
    L.st.forEach(([c])=>{ idx.set(c+'@'+L.code, nodes.length); nodes.push([c,L.code]); });
  });
  const N = nodes.length, distArr = new Array(N).fill(Infinity), prev = new Array(N).fill(-1);
  const startLines = (MTR_ST[from]?.lines || []).filter(ln=>idx.has(from+'@'+ln));
  const pq = [];
  startLines.forEach(ln => { const i = idx.get(from+'@'+ln); if(i!==undefined){ distArr[i]=0; pq.push(i); } });
  const adj = i=>{
    const [st, ln] = nodes[i]; const out = [];
    const L = lineOf(ln), pos = L.st.findIndex(x=>x[0]===st);
    const br = new Set(L.br||[]);
    // 同綫前後站（br 標記者為支線起點，與前一站不相連）
    const hm = hopMin(ln);
    if(pos>0            && !br.has(st))            out.push([idx.get(L.st[pos-1][0]+'@'+ln), hm]);
    if(pos<L.st.length-1 && !br.has(L.st[pos+1][0])) out.push([idx.get(L.st[pos+1][0]+'@'+ln), hm]);
    // 支線額外連線
    (L.x||[]).forEach(([a,b])=>{
      const o = a===st ? b : (b===st ? a : null); if(!o) return;
      out.push([idx.get(o+'@'+ln), hm]);
    });
    // 同站轉綫
    (MTR_ST[st].lines||[]).forEach(o=>{ if(o!==ln){ const j=idx.get(st+'@'+o); if(j!==undefined) out.push([j,TRANSFER_MIN]); } });
    // 付費區內步行轉乘（如 中環 ↔ 香港）
    (WALK_LINKS[st]||[]).forEach(([o,cost])=>{
      (MTR_ST[o]?.lines||[]).forEach(ol=>{ const j=idx.get(o+'@'+ol); if(j!==undefined) out.push([j,cost]); });
    });
    return out;
  };
  // 簡易 Dijkstra（N 小，O(N²) 即可）
  const done = new Array(N).fill(false);
  for(;;){
    let u=-1, best=Infinity;
    for(let i=0;i<N;i++) if(!done[i] && distArr[i]<best){ best=distArr[i]; u=i; }
    if(u<0) break;
    done[u]=true;
    for(const [v,w] of adj(u)){
      if(v===undefined||v<0) continue;
      if(distArr[u]+w < distArr[v]){ distArr[v]=distArr[u]+w; prev[v]=u; }
    }
  }
  let bestEnd=-1, bestD=Infinity;
  (MTR_ST[to]?.lines||[]).forEach(ln=>{ const i=idx.get(to+'@'+ln); if(i!==undefined && distArr[i]<bestD){bestD=distArr[i];bestEnd=i;} });
  if(bestEnd<0 || bestD===Infinity) return null;
  const path=[]; for(let v=bestEnd; v>=0; v=prev[v]) path.push(nodes[v]);
  path.reverse();
  // 合併成路段
  const legs=[]; let cur=null;
  for(let i=0;i<path.length;i++){
    const [st,ln] = path[i];
    if(!cur || cur.line!==ln){
      if(cur) legs.push(cur);
      cur = {line:ln, from:st, to:st, stops:0, walk: !!(cur && cur.to!==st)};
    } else { cur.to = st; cur.stops++; }
  }
  if(cur) legs.push(cur);
  // 去掉開首的零站路段（純轉乘起手）
  while(legs.length>1 && legs[0].stops===0 && !legs[0].walk) legs.shift();
  return {legs, minutes:Math.round(bestD), stops:path.length-1};
}
function mtrLegsHtml(legs){
  return legs.map((lg,i)=>{
    const l = lineOf(lg.line) || {name:lg.line, color:'#888', st:[[lg.from],[lg.to]]};
    const walk = (i>0 && lg.walk)
      ? `<div class="small muted" style="margin:0 0 3px">🚶 步行轉乘 ${esc(MTR_ST[legs[i-1].to].tc)} → ${esc(MTR_ST[lg.from].tc)}（站內通道）</div>` : '';
    const pos1 = l.st.findIndex(x=>x[0]===lg.from), pos2 = l.st.findIndex(x=>x[0]===lg.to);
    const dirName = pos2>pos1 ? l.st[l.st.length-1][1] : l.st[0][1];
    const nxt = legs[i+1];
    const trans = nxt && !nxt.walk ? `<div class="tiny muted" style="margin-top:2px">於 ${esc(MTR_ST[lg.to].tc)} 轉乘 ${esc(lineOf(nxt.line).name)}</div>` : '';
    return `<div class="leg">
      <div class="dotcol"><span style="width:11px;height:11px;border-radius:50%;background:${l.color};display:block"></span><span class="ln"></span></div>
      <div style="flex:1">${walk}
        <div class="small"><b style="color:${l.color}">${esc(l.name)}</b> 往 ${esc(dirName)}</div>
        <div class="small muted">${esc(MTR_ST[lg.from].tc)} → ${esc(MTR_ST[lg.to].tc)}（${lg.stops} 站）</div>
        ${trans}
      </div></div>`;
  }).join('');
}
function renderMtrPlan(a,b){
  const r = mtrPlan(a,b);
  if(!r) return `<div class="banner err">找不到可行車程。</div>`;
  if(!r.legs.length) return `<div class="card"><div class="small">起點與終點相同。</div></div>`;
  return `<div class="card">
    <div class="spread"><div><b>${esc(MTR_ST[a].tc)} → ${esc(MTR_ST[b].tc)}</b></div>
      <div class="small muted">約 ${r.minutes} 分鐘 · ${r.stops} 個站</div></div>
    <div class="sep"></div>
    ${mtrLegsHtml(r.legs)}
    <div class="sep"></div>
    <div class="tiny muted">估算只供參考：按各綫平均每站行車時間計算，換綫計 ${TRANSFER_MIN} 分鐘，未含等車時間。</div>
  </div>`;
}

/* ============================================================
   點對點路線搜尋
   ============================================================ */
let map=null, mapMarks=[], planPts={from:null,to:null}, pickMode='from';
const GEO_OK = 1;
function initMap(){
  if(map || typeof L==='undefined') return;
  map = L.map('map', {zoomControl:false}).setView([22.3193,114.1694], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {maxZoom:19, attribution:'© OpenStreetMap'}).addTo(map);
  map.on('click', async e=>{
    const p = {lat:e.latlng.lat, lng:e.latlng.lng, name:await reverseName(e.latlng.lat, e.latlng.lng)};
    if(pickMode==='from'){ planPts.from=p; $('#planFrom').value=p.name; pickMode='to'; }
    else { planPts.to=p; $('#planTo').value=p.name; pickMode='from'; }
    drawMap();
  });
}
function drawMap(){
  if(!map) return;
  mapMarks.forEach(m=>map.removeLayer(m)); mapMarks=[];
  const pts=[];
  if(planPts.from){ const m=L.marker([planPts.from.lat,planPts.from.lng]).addTo(map).bindPopup('起點：'+planPts.from.name); mapMarks.push(m); pts.push([planPts.from.lat,planPts.from.lng]); }
  if(planPts.to){ const m=L.marker([planPts.to.lat,planPts.to.lng]).addTo(map).bindPopup('終點：'+planPts.to.name); mapMarks.push(m); pts.push([planPts.to.lat,planPts.to.lng]); }
  if(pts.length===1) map.setView(pts[0], 16);
  if(pts.length===2){
    map.fitBounds(pts, {padding:[30,30]});
    mapMarks.push(L.polyline(pts,{color:'#0f5c8c',dashArray:'6,6',weight:3,opacity:.7}).addTo(map));
  }
}
async function reverseName(lat,lng){
  try{
    const j = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=17&accept-language=zh-TW`,{timeout:10000});
    return j.name || j.display_name?.split(',')[0] || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }catch(e){ return `${lat.toFixed(5)}, ${lng.toFixed(5)}`; }
}
function withTimeout(p, ms){
  return Promise.race([p, new Promise(r=>setTimeout(()=>r(null), ms))]);
}
async function geocode(q){
  // 1) 本地車站／港鐵站（若資料仍未就緒，最多等 8 秒，之後只用線上地理編碼）
  if(busDataLoaded) await waitBus(); else await withTimeout(waitBus(), 8000);
  const nq = norm(q);
  const local = [];
  Object.values(MTR_ST).forEach((s,c)=>{ if(norm(s.tc)===nq || norm(s.tc).includes(nq)) local.push({name:s.tc+'站（港鐵）', lat:s.lat, lng:s.lng}); });
  allStops('ALL').forEach(s=>{ if(norm(s.tc)===nq) local.push({name:s.tc+'（'+CO_NAME[s.co]+'）', lat:s.lat, lng:s.lng}); });
  if(local.length) return local[0];
  try{
    const j = await getJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=hk&accept-language=zh-TW&q=${encodeURIComponent(q)}`,{timeout:12000});
    if(j && j.length) return {name: j[0].display_name, lat:+j[0].lat, lng:+j[0].lon};
  }catch(e){}
  try{
    const j = await getJSON(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5&lat=22.32&lon=114.17&lang=default`,{timeout:12000});
    const f = (j.features||[])[0];
    if(f) return {name: f.properties.name || q, lat:f.geometry.coordinates[1], lng:f.geometry.coordinates[0]};
  }catch(e){}
  return null;
}
$('#planGeo').onclick = ()=>{
  if(!navigator.geolocation){ setBanner('planMsg','此瀏覽器不支援定位', true); return; }
  navigator.geolocation.getCurrentPosition(async p=>{
    planPts.from = {lat:p.coords.latitude, lng:p.coords.longitude, name:'我的位置'};
    $('#planFrom').value = '我的位置';
    drawMap();
  }, e=>setBanner('planMsg','定位失敗：'+e.message, true), {enableHighAccuracy:true, timeout:12000});
};
$('#planSwap').onclick = ()=>{
  const a=$('#planFrom').value, b=$('#planTo').value;
  $('#planFrom').value=b; $('#planTo').value=a;
  const t=planPts.from; planPts.from=planPts.to; planPts.to=t; drawMap();
};
$('#planClear').onclick = ()=>{ $('#planFrom').value=''; $('#planTo').value=''; planPts={from:null,to:null}; $('#planResults').innerHTML=''; drawMap(); };
$('#planGo').onclick = doPlan;

async function resolvePoint(inputEl, key){
  const q = inputEl.value.trim();
  if(!q) return null;
  if(planPts[key] && (planPts[key].name===q || q==='我的位置')) return planPts[key];
  setBanner('planMsg', `正在查找「${q}」…`);
  const p = await geocode(q);
  setBanner('planMsg','');
  if(!p) return null;
  planPts[key] = p; inputEl.value = p.name;
  return p;
}
async function doPlan(){
  const a = await resolvePoint($('#planFrom'),'from');
  const b = await resolvePoint($('#planTo'),'to');
  const box = $('#planResults');
  if(!a || !b){ setBanner('planMsg','找不到起點或終點，請改用其他關鍵字或在地圖上點選。', true); return; }
  drawMap();
  box.innerHTML = `<div class="card"><span class="spin"></span> 正在搜尋路線…</div>`;
  await waitBus();
  const out = [];
  const dWalk = dist(a.lat,a.lng,b.lat,b.lng);
  if(dWalk < 1200) out.push({kind:'walk', minutes:Math.max(1,Math.round(dWalk/80)), detail:`步行約 ${Math.round(dWalk)} 公尺`});
  // 1) 港鐵
  const s1 = nearestMtr(a.lat,a.lng), s2 = nearestMtr(b.lat,b.lng);
  if(s1 && s2 && s1.d<1400 && s2.d<1400 && s1.code!==s2.code){
    const r = mtrPlan(s1.code, s2.code);
    if(r) out.push({kind:'mtr', minutes: Math.round(r.minutes + s1.d/80 + s2.d/80), legs:r.legs,
        a:s1, b:s2, stops:r.stops});
  }
  // 2) 直達巴士／小巴
  const direct = await findDirect(a,b);
  direct.forEach(x=>out.push(x));
  // 3) 巴士 → 港鐵 接駁
  const combos = await findBusMtr(a,b);
  combos.forEach(x=>out.push(x));
  out.sort((x,y)=>x.minutes-y.minutes);
  const seen = new Set();
  const uniq = out.filter(it=>{
    const k = it.kind + '|' + (it.co||'') + '|' + (it.route||'') + '|' + (it.bound||'');
    if(seen.has(k)) return false; seen.add(k); return true;
  });
  renderPlan(uniq.slice(0,12), a, b);
}
function nearestMtr(lat,lng){
  let best=null;
  for(const [c,s] of Object.entries(MTR_ST)){
    const d = dist(lat,lng,s.lat,s.lng);
    if(!best || d<best.d) best={code:c, d, s};
  }
  return best;
}
function candidateStops(pt, r1=450, r2=900, cap=8){
  let arr = allStops('ALL').map(s=>({s, d:dist(pt.lat,pt.lng,s.lat,s.lng)}))
            .filter(x=>x.d<r1).sort((a,b)=>a.d-b.d).slice(0,cap);
  if(!arr.length) arr = allStops('ALL').map(s=>({s, d:dist(pt.lat,pt.lng,s.lat,s.lng)}))
            .filter(x=>x.d<r2).sort((a,b)=>a.d-b.d).slice(0,cap);
  return arr;
}
async function findDirect(a,b){
  const res=[];
  const O = candidateStops(a), Dd = candidateStops(b);
  if(!O.length || !Dd.length) return res;
  // --- 九巴／龍運：用本地索引，零額外請求 ---
  if(D.KMB.routesAtStop){
    const destKmb = new Map(Dd.filter(x=>x.s.co==='KMB').map(x=>[x.s.id, x]));
    const seen = new Set();
    for(const o of O.filter(x=>x.s.co==='KMB')){
      for(const e of (D.KMB.routesAtStop.get(o.s.id)||[])){
        if(!destKmb.size) break;
        const seqs = D.KMB.seqOf.get(e.k); if(!seqs) continue;
        const s1 = seqs.get(o.s.id);
        if(s1===undefined) continue;
        let hit = null;
        for(const [did, dx] of destKmb){
          const s2 = seqs.get(did);
          if(s2===undefined || s2<=s1) continue;
          if(!hit || s2 < hit.s2) hit = {s2, dx};       // 選最接近的落車站
        }
        if(!hit) continue;
        const key = e.route+'|'+e.bound+'|'+e.service_type;
        if(seen.has(key)) continue; seen.add(key);
        const info = (D.KMB.route||[]).find(r=>r.route===e.route && r.bound===e.bound);
        res.push({kind:'bus', co:'KMB', route:e.route, bound:e.bound, service_type:e.service_type,
          from:o, to:hit.dx, stops:hit.s2-s1,
          minutes: Math.round(o.d/80 + (hit.s2-s1)*2.4 + hit.dx.d/80 + 4),
          dest: (info && info.dest) || ''});
      }
    }
  }
  // --- 城巴：站→路線→站序，全部走快取並限制併發 ---
  if(D.CTB.ready){
    const oStops = O.filter(x=>x.s.co==='CTB').slice(0,2);
    const destCtb = Dd.filter(x=>x.s.co==='CTB');
    const jobs = [];
    for(const o of oStops){
      let routes = [];
      for(const mk of EP.ctbStopRoute){
        try{
          const j = await cachedGet(mk(o.s.id), 6*3600e3, {timeout:15000, tries:proxyOrder().slice(0,2)});
          routes = asArray(pick(j,'data')); if(routes.length) break;
        }catch(e){}
      }
      for(const r of routes.slice(0,6)) if(r && r.route) jobs.push({o, r});
    }
    const found = await pool(jobs, 5, async ({o, r})=>{
      const dirWord = (r.dir==='I' || r.dir==='inbound') ? 'inbound' : 'outbound';
      let list;
      try{
        const j = await cachedGet(EP.ctbRS(r.route, dirWord), 12*3600e3, {timeout:25000});
        list = asArray(pick(j,'data')).slice().sort((x,y)=>(+x.seq)-(+y.seq));
      }catch(e){ return null; }
      const idx = new Map(list.map((x,i)=>[String(x.stop), i]));
      const s1 = idx.get(String(o.s.id));
      if(s1===undefined) return null;
      let hit = null;
      for(const dx of destCtb){
        const s2 = idx.get(String(dx.s.id));
        if(s2===undefined || s2<=s1) continue;
        if(!hit || s2 < hit.s2) hit = {s2, dx};
      }
      if(!hit) return null;
      return {kind:'bus', co:'CTB', route:r.route, bound:r.dir, from:o, to:hit.dx, stops:hit.s2-s1,
              minutes: Math.round(o.d/80 + (hit.s2-s1)*2.4 + hit.dx.d/80 + 4), dest:''};
    });
    const seenC = new Set();
    for(const x of found){
      if(!x) continue;
      const k = x.route+'|'+x.bound;
      if(seenC.has(k)) continue; seenC.add(k);
      res.push(x);
    }
  }
  return res;
}
async function findBusMtr(a,b){
  const res=[];
  const s1 = nearestMtr(a.lat,a.lng), s2 = nearestMtr(b.lat,b.lng);
  if(!s1 || !s2 || s1.code===s2.code) return res;
  if(s1.d<600 || s2.d<600) return res;              // 已有純港鐵方案，無需接駁
  if(!D.KMB.routesAtStop) return res;
  const plan = mtrPlan(s1.code, s2.code);           // 只算一次，別放進迴圈
  if(!plan || !plan.legs.length) return res;
  const O = candidateStops(a, 500, 1000, 6);
  const nearS1 = candidateStops({lat:s1.s.lat, lng:s1.s.lng}, 400, 700, 10).filter(x=>x.s.co==='KMB');
  if(!nearS1.length) return res;
  const nearIds = new Map(nearS1.map(x=>[x.s.id, x]));
  const seen = new Set();
  for(const o of O.filter(x=>x.s.co==='KMB')){
    for(const e of (D.KMB.routesAtStop.get(o.s.id)||[])){
      const seqs = D.KMB.seqOf.get(e.k); if(!seqs) continue;
      const s1q = seqs.get(o.s.id);
      if(s1q===undefined) continue;
      let hit = null;
      for(const [nid, nx] of nearIds){
        const s2q = seqs.get(nid);
        if(s2q===undefined || s2q<=s1q) continue;
        if(!hit || nx.d < hit.nx.d) hit = {s2q, nx};
      }
      if(!hit) continue;
      const key = e.route+'|'+e.bound+'|'+e.service_type;
      if(seen.has(key)) continue; seen.add(key);
      res.push({kind:'busmtr', co:'KMB', route:e.route, bound:e.bound, service_type:e.service_type,
        from:o, to:hit.nx, stops:hit.s2q-s1q, mtr:plan, mtrA:s1, mtrB:s2,
        minutes: Math.round(o.d/80 + (hit.s2q-s1q)*2.4 + plan.minutes + s2.d/80 + 8), dest:''});
    }
  }
  return res;
}
function renderPlan(list, a, b){
  const box = $('#planResults');
  if(!list.length){ box.innerHTML = `<div class="card empty">找不到合適路線。<br>
    可試著把起點／終點改為主要地標或港鐵站名稱。</div>`; return; }
  box.innerHTML = list.map(it=>{
    if(it.kind==='walk') return `<div class="card"><div class="spread">
      <div><b>🚶 全程步行</b><div class="small muted">${esc(it.detail)}</div></div>
      <div class="eta">${it.minutes} 分</div></div></div>`;
    if(it.kind==='mtr') return `<div class="card">
      <div class="spread"><div><b>🚇 港鐵</b>
        <div class="small muted">步行至 ${esc(it.a.s.tc)} 約 ${Math.round(it.a.d)}m · ${it.stops} 個站 · 步行至目的地約 ${Math.round(it.b.d)}m</div></div>
        <div class="eta">${it.minutes} 分</div></div>
      <div class="sep"></div>
      ${mtrLegsHtml(it.legs)}
      <div class="act" style="margin-top:8px">
        <button class="btn sm ghost" onclick="jumpMtr('${it.a.code}','${it.b.code}')">查看港鐵車程</button>
      </div></div>`;
    if(it.kind==='bus') return `<div class="card">
      <div class="spread"><div><b><span class="badge ${CO_CLS[it.co]}">${esc(it.route)}</span> 直達</b>
        <div class="small muted">步行 ${Math.round(it.from.d)}m 至「${esc(it.from.s.tc)}」 · ${it.stops} 站 · 於「${esc(it.to.s.tc)}」下車步行 ${Math.round(it.to.d)}m</div></div>
        <div class="eta">${it.minutes} 分</div></div>
      ${it.dest?`<div class="tiny muted" style="margin-top:4px">往 ${esc(it.dest)}</div>`:''}
      <div class="act" style="margin-top:8px">
        <button class="btn sm ghost" onclick="jumpStop('${it.co}','${esc(it.from.s.id)}')">查看實時到站</button>
      </div></div>`;
    if(it.kind==='busmtr') return `<div class="card">
      <div class="spread"><div><b><span class="badge ${CO_CLS[it.co]}">${esc(it.route)}</span> + 🚇 港鐵</b>
        <div class="small muted">步行 ${Math.round(it.from.d)}m 至「${esc(it.from.s.tc)}」 · ${it.stops} 站至 ${esc(it.mtrA.s.tc)}</div></div>
        <div class="eta">${it.minutes} 分</div></div>
      <div class="sep"></div>
      ${mtrLegsHtml(it.mtr.legs)}
      <div class="act" style="margin-top:8px">
        <button class="btn sm ghost" onclick="jumpStop('${it.co}','${esc(it.from.s.id)}')">查看巴士到站</button>
      </div></div>`;
    return '';
  }).join('');
}
window.jumpStop = (co,id)=>{ switchTab('stop'); setTimeout(()=>openStopEta(co,id), 60); };
window.jumpMtr = (x,y)=>{ switchTab('mtr'); $('#mtrFrom').value=x; $('#mtrTo').value=y;
  setTimeout(()=>{ $('#mtrPlan').innerHTML = renderMtrPlan(x,y); $('#mtrPlan').scrollIntoView({behavior:'smooth',block:'center'}); },60); };

/* ============================================================
   診斷 / 設定
   ============================================================ */
const DIAG = [
  ['九巴路線 API', EP.kmbRoute],
  ['九巴車站 API', EP.kmbStop],
  ['九巴到站 API', EP.kmbEta('A3ADFCDF8487ADB9','1A',1)],
  ['城巴路線 API', EP.ctbRoute[0]],
  ['城巴車站 API', EP.ctbStop],
  ['城巴到站 API', EP.ctbEta('001027','1')],
  ['城巴站路線 API', EP.ctbStopRoute[0]('001027')],
  ['嶼巴路線 API', EP.nlbRoute],
  ['小巴路線 API', EP.gmbRoute],
  ['小巴車站 API', EP.gmbStop],
  ['小巴站路線 API', EP.gmbStopRoute[0]('2001')],
  ['港鐵巴士路線 CSV', EP.mtrbRouteCsv],
  ['港鐵巴士車站 CSV', EP.mtrbStopCsv],
  ['輕鐵到站 API', EP.lrtEta('001')],
  ['小巴到站 API', EP.gmbEta('2006408','20014492')],
  ['港鐵班次 API', EP.mtrSchedAlts('TWL','CEN')[0]],
];
/* 只連得到還不夠，要真的有資料才算正常 */
function diagCount(j){
  if(!j || typeof j!=='object') return 0;
  const a = plainArr(j);
  if(a.length) return a.length;
  if(j.data && typeof j.data==='object' && !Array.isArray(j.data)) return Object.keys(j.data).length;
  return 0;
}
$('#diagBtn').onclick = async ()=>{
  const t = $('#diagTable'); t.innerHTML='<tr><td colspan="2"><span class="spin"></span> 測試中…</td></tr>';
  const rows=[];
  for(const [name,url] of DIAG){
    let ok=false, note='', n=0;
    const t0=performance.now();
    try{
      const j = await getJSON(url,{timeout:15000});
      n = diagCount(j);
      ok = n>0;
      note = `${Math.round(performance.now()-t0)}ms · ${LAST_PROXY} · ${ok?n+' 筆':'回應為空'}`;
    }catch(e){ note = e.message; }
    rows.push(`<tr><td>${esc(name)}</td><td class="${ok?'ok':'bad'}">${ok?'✓ 正常':'✗ 異常'} <span class="tiny muted">${esc(note)}</span></td></tr>`);
    t.innerHTML = rows.join('');
  }
  $('#diagSummary').innerHTML = `目前使用：<b>${esc(LAST_PROXY)}</b>　（失敗時會自動切換備援通道）`;
};
$('#reloadBtn').onclick = async ()=>{ await DB.clear(); location.reload(); };
$('#clearBtn').onclick = async ()=>{ await DB.clear(); localStorage.clear(); location.reload(); };
$('#proxySel').value = SETTINGS.proxy ?? 'auto';
$('#customProxy').value = SETTINGS.customProxy || '';
$('#refreshSel').value = String(SETTINGS.refresh ?? 20);
$('#proxySel').onchange = e=>{ SETTINGS.proxy=e.target.value; saveSettings(); };
$('#customProxy').onchange = e=>{ SETTINGS.customProxy=e.target.value.trim(); saveSettings(); };
$('#refreshSel').onchange = e=>{ SETTINGS.refresh=+e.target.value; saveSettings(); restartEtaTimer(); };
$('#autoNearbySel').value = String(SETTINGS.autoNearby ?? 1);
$('#nearRadiusSel').value = String(SETTINGS.nearRadius ?? 700);
$('#autoNearbySel').onchange = e=>{
  SETTINGS.autoNearby = +e.target.value; saveSettings();
  if(SETTINGS.autoNearby && !geoDenied()) autoNearbyOnce();
  else if(!SETTINGS.autoNearby){
    nearbyTok++;                          // 作廢進行中的計算
    $('#nearBox').innerHTML='';
    nearData={pos:null,stops:[],routes:null,err:null}; lastGeo=null;
  }
};
$('#nearRadiusSel').onchange = e=>{
  SETTINGS.nearRadius = +e.target.value; saveSettings();
  if(lastGeo) renderNearby(lastGeo);
};
$('#nearRoutesSel').value = String(SETTINGS.nearRoutes ?? 1);
$('#nearRoutesSel').onchange = e=>{
  SETTINGS.nearRoutes = +e.target.value; saveSettings();
  if(+e.target.value && nearData.routes===null && lastGeo) loadNearbyRoutes();
  if(lastGeo) renderNearBox();
};

/* ============================================================
   Tabs / 主題 / 啟動
   ============================================================ */
let activeTab = 'stop';
function switchTab(name){
  activeTab = name;
  $$('#tabs button').forEach(b=>b.setAttribute('aria-selected', b.dataset.tab===name));
  ['stop','route','mtr','plan','more'].forEach(n=>{
    document.getElementById('tab-'+n).classList.toggle('hidden', n!==name);
  });
  if(name==='plan'){ initMap(); setTimeout(()=>map&&map.invalidateSize(),80); }
  if(name==='stop' && autoNearbyPending && busDataLoaded){ autoNearbyPending=false; autoNearbyOnce(); }
  window.scrollTo({top:0, behavior:'smooth'});
}
$('#tabs').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  switchTab(b.dataset.tab);
});
function applyTheme(){
  const t = SETTINGS.theme==='auto' ? (matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light') : SETTINGS.theme;
  document.documentElement.setAttribute('data-theme', t);
}
$('#themeBtn').onclick = ()=>{
  const cur = document.documentElement.getAttribute('data-theme');
  SETTINGS.theme = cur==='dark' ? 'light' : 'dark'; saveSettings(); applyTheme();
};
applyTheme();

/* 收藏顯示（到站分頁頂部） */
function getFavs(){ try{ return JSON.parse(localStorage.getItem('hkT.fav')||'[]'); }catch(e){ return []; } }
function renderFavs(){
  const f = getFavs(), box = $('#favBox'); if(!box) return;
  box.innerHTML = f.length ? `<div class="card tight"><h2>我的收藏</h2><div class="chipbar">${
    f.map((x,i)=>`<button class="chip" data-fav="${i}">★ ${esc(x.name)} <span data-rm="${i}" style="opacity:.6">✕</span></button>`).join('')
  }</div></div>` : '';
}
$('#favBox').addEventListener('click', e=>{
  const rm = e.target.closest('[data-rm]');
  if(rm){
    e.stopPropagation();
    const f = getFavs(); f.splice(+rm.dataset.rm, 1);
    localStorage.setItem('hkT.fav', JSON.stringify(f)); renderFavs(); return;
  }
  const b = e.target.closest('[data-fav]'); if(!b) return;
  const f = getFavs()[+b.dataset.fav];
  if(f) openStopEta(f.co, f.id);
});

initMtr();
buildMtrStops();          // 重鐵車站為內建資料，立即可用
buildFerry();             // 渡輪碼頭亦為內建資料
// 小巴與港鐵巴士：官方資料源常被 CORS 擋下，先用內建資料（零請求）
Promise.resolve(loadGmbEmbedded()).catch(()=>{});
Promise.resolve(loadMtrbEmbedded()).catch(()=>{});
needBusData();
onLoad(()=>{
  renderFavs();
  renderDataStatus();
  if($('#stopQ').value.trim()) renderStopSearch($('#stopQ').value.trim());
  autoNearbyOnce();
});
function renderDataStatus(){
  const el = $('#dataStatus'); if(!el) return;
  const ok = [], bad = [];
  [['九巴/龍運',D.KMB.ready],['城巴',D.CTB.ready],['專線小巴',D.GMB.ready],['嶼巴',D.NLB.ready],
   ['港鐵巴士',D.MTRB.ready],['港鐵重鐵',D.MTR.ready],['輕鐵',D.LRT.ready],['渡輪',D.FERRY.ready]]
    .forEach(([n,v])=> (v?ok:bad).push(n));
  el.innerHTML = `車站／路線索引：${ok.map(n=>`<span class="ok">✓${n}</span>`).join(' ')}` +
    (bad.length? `　${bad.map(n=>`<span class="bad">✗${n}</span>`).join(' ')}` : '') +
    (D.MTRB.ready ? `<div class="tiny muted" style="margin-top:3px">港鐵巴士只服務屯門／元朗／天水圍／大埔一帶。</div>` : '') +
    `<div class="tiny muted" style="margin-top:3px">小巴／港鐵巴士／輕鐵／重鐵／渡輪的車站與路線為內建資料（GitHub 開放資料）。渡輪無實時到站，顯示為時刻表推算之下一班。</div>`;
  if(!ok.length){
    el.innerHTML += `<div class="banner err" style="margin-top:8px">
      ⚠️ 所有資料來源都連不上。請到「更多 → 連線診斷」查看原因；若顯示 CORS 相關錯誤，
      可在「更多 → 設定 → 網路模式」改用代理通道。</div>`;
  }
}
