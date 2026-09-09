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
  // 「個別小巴站的到站」官方端點是 /eta/stop/
  gmbStopEta:[ (s)=>`https://data.etagmb.gov.hk/eta/stop/${s}`,
               (s)=>`https://data.etagmb.gov.hk/stop-eta/${s}` ],
  gmbEtaAlts:(r,s)=>[`https://data.etagmb.gov.hk/eta/route-stop/${r}/${s}`,
                     `https://data.etagmb.gov.hk/eta/route-stop/${r}/1/${s}`],

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
      const arr = asArray(S.data);
      D.GMB.stop = arr.map(s=>({co:'GMB', id:String(pick(s,'stop_id','stopId','stop','id')),
              tc:pick(s,'name_tc','stopName_c','description_tc')||'',
              lat:+pick(s,'latitude','lat'), lng:+pick(s,'longitude','lng','long')}))
              .filter(s=>s.tc && isFinite(s.lat) && isFinite(s.lng));
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
  const out = await pool(routes, 4, async ({route})=>{
    try{
      const j = await postJSON(EP.mtrbEta, {language:'zh', routeName:route}, {timeout:20000});
      const stops = asArray(pick(j,'busStop','bus_stop','data'));
      const mine = stops.find(x=>String(pick(x,'busStopId','bus_stop_id','stopId','stop_id'))===String(stopId));
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
function gmbEtaRows(j){
  const out = [];
  const items = plainArr(j);
  for(const e of items){
    if(!e || typeof e!=='object') continue;
    const inner = Array.isArray(e.eta) ? e.eta : null;
    const targets = (inner && inner.length) ? inner : [e];
    for(const t of targets){
      if(!t || typeof t!=='object') continue;
      const route = String(pick(e,'route_id','routeId','route','routeNo') ?? pick(t,'route_id','routeId','route','routeNo') ?? '');
      if(!route) continue;
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
  // 1) 有小巴站整批到站端點時直接用
  for(const mk of [].concat(EP.gmbStopEta)){
    try{
      const j = await getJSON(mk(stopId), {timeout:12000, tries:proxyOrder().slice(0,2)});
      const rows = gmbEtaRows(j);
      if(rows.length) return rows;
    }catch(e){}
  }
  // 2) 否則：查此站的路線 → 逐路線查到站（有快取，重複查詢便宜）
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
  ['小巴站到站 API', EP.gmbStopEta[0]('2001')],
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
    `<div class="tiny muted" style="margin-top:3px">輕鐵／重鐵／渡輪座標已用 GitHub 開放資料校正。渡輪無實時到站，顯示為時刻表推算之下一班。</div>`;
  if(!ok.length){
    el.innerHTML += `<div class="banner err" style="margin-top:8px">
      ⚠️ 所有資料來源都連不上。請到「更多 → 連線診斷」查看原因；若顯示 CORS 相關錯誤，
      可在「更多 → 設定 → 網路模式」改用代理通道。</div>`;
  }
}
