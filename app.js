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
/* corsproxy.io 已改為需要 API key，未帶 key 時回 HTTP 401，已移除。 */
const PROXIES = [
  {n:'直連',        f:u=>u},
  {n:'AllOrigins',  f:u=>'https://api.allorigins.win/raw?url='+encodeURIComponent(u)},
  {n:'CodeTabs',    f:u=>'https://api.codetabs.com/v1/proxy?quest='+encodeURIComponent(u)},
  {n:'cors.lol',    f:u=>'https://api.cors.lol/?url='+encodeURIComponent(u)},
  {n:'AllOrigins(get)', f:u=>'https://api.allorigins.win/get?url='+encodeURIComponent(u)},
];
const SETTINGS = Object.assign({
  proxy:'auto', customProxy:'', refresh:20, theme:'auto',
  autoNearby:1, nearRadius:700, nearRoutes:1, nearEta:1
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
  /* v1.1 的 batch 系列官方已於 2023 年底停用，改以 v2 優先嘗試。
     （城巴車站路線主要來源已是內建索引，此處僅為備援） */
  ctbStopRoute:[ (s)=>`https://rt.data.gov.hk/v2/transport/citybus/stop-route/CTB/${s}`,
                 (s)=>`https://rt.data.gov.hk/v1.1/transport/batch/stoproute/CTB/${s}` ],

  nlbRoute:'https://rt.data.gov.hk/v2/transport/nlb/route.php?action=list',
  nlbRS   :(id)=>`https://rt.data.gov.hk/v2/transport/nlb/stop.php?action=list&routeId=${id}`,
  nlbEta  :(r,s)=>`https://rt.data.gov.hk/v2/transport/nlb/stop.php?action=estimatedArrivals&routeId=${r}&stopId=${s}&language=zh`,

  gmbRoute:'https://data.etagmb.gov.hk/route',
  gmbStop :'https://data.etagmb.gov.hk/stop',
  gmbRS   :(id)=>`https://data.etagmb.gov.hk/route-stop/${id}`,
  gmbRS2  :(id,seq)=>`https://data.etagmb.gov.hk/route-stop/${id}/${seq}`,
  gmbEta  :(r,s)=>`https://data.etagmb.gov.hk/eta/route-stop/${r}/${s}`,
  /* 「個別小巴站的路線」正確端點是 /stop-route/。
     原本還列了 /stop/ 當備援，但那個只回傳該站基本資料、不含路線，
     查詢會拿到無關內容（甚至被誤當成路線清單），已移除。 */
  gmbStopRoute:[ (s)=>`https://data.etagmb.gov.hk/stop-route/${s}` ],
  // 官方只有「路線＋站」的到站端點（hkbus/hk-bus-eta 用法），沒有整站批次端點
  gmbEtaAlts:(r,s)=>[`https://data.etagmb.gov.hk/eta/route-stop/${r}/${s}`],

  /* 港鐵班次：官方端點常掛掉，hkbus（GitHub）也是這樣處理——
     失敗時改用自己的鏡像 https://mtr.hkbus.app/ */
  mtrSched:(line,sta)=>`https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=${line}&sta=${sta}&lang=TC`,
  mtrSchedMirror:(line,sta)=>`https://mtr.hkbus.app/?line=${line}&sta=${sta}`,

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
/* 客戶端時鐘與伺服器時間的偏差（毫秒）。
   校正後：分鐘數 = 到站時間戳 − (用戶端現在 + 偏差)。
   只從「即時到站」回應取得（這類請求不經快取，必定是新鮮的），
   避免拿快取裡過舊的時間戳來校正，反而製造更大誤差。 */
const TIME_SKEW = {ms:0, set:false, src:''};
function applyServerTime(j){
  const t = pick(j,'generated_timestamp','generatedTimestamp','timestamp');
  if(!t) return;
  const d = new Date(t);
  if(isNaN(d)) return;
  const skew = d.getTime() - Date.now();
  if(!Number.isFinite(skew) || Math.abs(skew) > 24*3600e3) return;   // 明顯異常就不採用
  TIME_SKEW.ms = skew; TIME_SKEW.set = true; TIME_SKEW.src = String(t);
}
function nowMs(){ return Date.now() + (TIME_SKEW.set ? TIME_SKEW.ms : 0); }
/* 取得即時回應時一併做兩件事：校正時鐘、留下原始回應供「複製診斷」 */
function etaSnap(j){
  applyServerTime(j);
  if(j && typeof j==='object'){ LAST_RAW.last = j; LAST_RAW.lastAt = new Date().toISOString(); }
}
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
/* 一律以香港時間顯示。
   原本用 getHours() 會套用使用者所在時區，出國或裝置時區非 UTC+8 時，
   到站時間會整整差好幾個小時（例如倫敦看香港班次顯示成凌晨）。 */
function hhmm(iso){
  if(!iso) return '';
  const m=String(iso).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if(m) return m[4]+':'+m[5];                 // 直接用字串裡的時分，不受時區影響
  const d=new Date(iso);
  if(isNaN(d)) return '';
  return new Intl.DateTimeFormat('zh-HK',{hour:'2-digit',minute:'2-digit',hour12:false,
                                          timeZone:'Asia/Hong_Kong'}).format(d);
}
function toMin(v){
  if(v===null || v===undefined || v==='') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function etaHtml(min, iso, sched){
  const m = toMin(min);
  if(m===null) return '<span class="eta none">暫無班次</span>';
  if(m<=-1)    return '<span class="eta none">已過站</span>';
  if(m<=0)     return '<span class="eta soon">即將抵達</span>';
  const cls = m<=5?'soon':(m<=15?'mid':'');
  // 班次表推算：明確標示，避免被當成實時資料（未計入行車時間）
  if(sched) return `<span class="eta ${cls}">約 ${m} 分</span>` +
                   `<span class="tiny muted" style="margin-left:5px">班表推算</span>`;
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
    for(const k of ['routes','route_stops','stops','route_list','stopList','estimatedArrivals','eta','platform_list'])
      if(Array.isArray(d[k])) return d[k];
  }
  // 輕鐵與港鐵的資料在 platform_list（頂層），不在 data 裡
  for(const k of ['routes','stops','eta','estimatedArrivals','platform_list'])
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
  /* 內建資料（GitHub 開放資料）優先：
     城巴、小巴、嶼巴、港鐵巴士的車站與路線都已內建，
     載入成功就不再呼叫對應 API——省請求、開更快，
     也讓那些時好時壞的端點（401／404／空回應）不再影響使用。 */
  await Promise.all([
    loadGmbEmbedded().catch(()=>false),
    loadMtrbEmbedded().catch(()=>false),
    loadCtbEmbedded().catch(()=>false),
    loadNlbEmbedded().catch(()=>false),
  ]);
  /* 內建資料已備妥的項目就不必再打 API。
     注意「城巴車站」「小巴車站」這類「全部車站清單」端點根本不存在
     （hkbus 也不用），只會回 401／404，所以直接從流程中移除。 */
  const skip = {
    '城巴路線': !!(D.CTB.route && D.CTB.route.length),
    '小巴路線': !!(D.GMB.route && D.GMB.route.length),
  };
  const steps = [
    ['九巴路線', ()=>cachedGet(EP.kmbRoute, 12*3600e3)],
    ['九巴車站', ()=>cachedGet(EP.kmbStop , 12*3600e3)],
    ['九巴路線-站', ()=>cachedGet(EP.kmbRS  , 12*3600e3)],
    ['城巴路線', ()=>cachedGetAny(EP.ctbRoute, 12*3600e3)],
    ['小巴路線', ()=>cachedGet(EP.gmbRoute, 12*3600e3)],
  ];
  const results = {};
  let doneN = 0;
  const tick = ()=> setBanner('stopMsg', `載入資料中…（${doneN}/${active0(steps, skip)}）`);
  tick();
  // 平行下載（限量 4），但 IndexedDB 寫入仍逐筆
  const active = steps.filter(([label])=>!skip[label]);
  skippedSteps = Object.keys(skip).filter(k=>skip[k]);
  await pool(active, 4, async ([label, fn])=>{
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
    const R=results['城巴路線'];
    if(R) D.CTB.route = asArray(R.data).map(r=>({co:'CTB', route:pick(r,'route','routeNo'),
              bound:pick(r,'bound','dir'),
              orig:pick(r,'orig_tc','origName_tc'), dest:pick(r,'dest_tc','destName_tc')}));
    D.CTB.ready = !!(D.CTB.route && D.CTB.stop && D.CTB.stop.length);
  }catch(e){ console.warn(e); }
  // GMB
  try{
    const R=results['小巴路線'];
    if(R) D.GMB.route = gmbRoutesFrom(R);
    D.GMB.ready = !!(D.GMB.route && D.GMB.stop && D.GMB.stop.length);
  }catch(e){ console.warn(e); }
  // NLB：路線與車站都已內建（含到站 API 需要的 routeId）
  try{ D.NLB.ready = !!(D.NLB.route && D.NLB.route.length && D.NLB.stop && D.NLB.stop.length); }
  catch(e){ console.warn(e); }

  busDataLoaded = true; loading = false;
  setBanner('stopMsg', '', false);
  loadListeners.forEach(f=>{ try{f();}catch(e){} });
  // 港鐵巴士用 CSV，不下載也能用其他營辦商，所以主流程不等它；
  // 但先記住 promise，讓「附近」可以在需要時等它完成
  ensureMtrBus();
  ensureLrt();
}

/* 從九巴的到站資料取出時間。
   eta 欄位有四種形狀，實測只有「物件陣列」能被正確讀出，
   其餘三種（純字串、字串陣列、null）全部變成 null → 整頁「暫無班次」：
     eta:null                          → 真的沒班次
     eta:"2026-09-09T11:05:00+08:00"   → 純字串
     eta:["2026-09-09T11:05:00+08:00"] → 字串陣列
     eta:[{eta:"…", dest_tc:"…"}]      → 物件陣列 */
function kmbEtaOf(d){
  const v = pick(d,'eta');
  const dflt = ()=>({dest: pick(d,'dest_tc')||'', rmk: pick(d,'rmk_tc')||''});
  // eta 為 null 代表「此刻沒班次」，但仍可能有目的地與備註（如「最後班次已過」）
  if(v===null || v===undefined || v==='') return Object.assign({min:null, iso:null}, dflt());
  // 純字串
  if(typeof v === 'string') return Object.assign({min: minsTo(v), iso: v}, dflt());
  // 陣列：先攤平，再找第一個可用的
  const arr = Array.isArray(v) ? v : asArray(v);
  for(const x of arr){
    if(x===null || x===undefined) continue;
    if(typeof x === 'string'){
      if(x) return {min: minsTo(x), iso: x,
                    dest: pick(d,'dest_tc')||'', rmk: pick(d,'rmk_tc')||''};
      continue;
    }
    if(typeof x === 'object'){
      const t = pick(x,'eta','timestamp','estimatedArrivalTime');
      if(t) return {min: toMin(pick(x,'diff_min','diff')) ?? minsTo(t), iso: t,
                    dest: pick(x,'dest_tc')||pick(d,'dest_tc')||'',
                    rmk: pick(x,'rmk_tc')||pick(d,'rmk_tc')||''};
    }
  }
  // 物件但沒有時間（例如服務暫停，只有備註）
  const first = arr.find(x=>x && typeof x==='object');
  return {min:null, iso:null,
          dest: pick(d,'dest_tc') || (first?pick(first,'dest_tc'):'') || '',
          rmk:  pick(d,'rmk_tc') || (first?pick(first,'rmk_tc'):'') || ''};
}

/* 最近一次原始回應與錯誤，供診斷與訊息顯示使用。
   關鍵用途：區分「此刻真的沒班次」與「連不上／解析失敗」——
   兩者畫面上一樣是空的，但對使用者的意義完全不同。 */
const LAST_RAW = {kmb:null, kmbErr:null, err:null, attempted:0, failed:0};
function etaReset(){ LAST_RAW.err = null; LAST_RAW.attempted = 0; LAST_RAW.failed = 0; }
function etaFail(e){
  LAST_RAW.failed++;
  const m = String((e && e.message) || e || '');
  if(!LAST_RAW.err || /CORS|Failed to fetch|NetworkError|timeout/i.test(m)) LAST_RAW.err = m;
}

/* ---------- 九巴／龍運全程行車時間（GitHub 開放資料） ----------
   班次表的時刻是「頭站開出」時間，但使用者關心的是「我這站幾時到」。
   沒有行車時間就只能顯示頭站開出時間——路線愈長、站愈後面，誤差愈大
   （可差幾十分鐘）。這裡用全程行車時間按站數比例推估每站所需時間。 */
const EMB_KMB_JT = "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";
const KMB_JT = {map:new Map(), ready:false};
function kmbJtLoad(txt){
  for(const line of txt.split('\n')){
    const [r,b,jt,n] = line.split('|');
    if(!r || !jt || !n) continue;
    KMB_JT.map.set(r+'|'+(b||''), {jt:+jt, n:+n});
  }
  KMB_JT.ready = true;
}
/* 從頭站到 seq 站（0 起算）的估計行車時間（分鐘） */
function kmbJtOffset(route, bound, seq){
  if(!KMB_JT.ready) return 0;
  const s = Number(seq);
  if(!Number.isFinite(s) || s <= 0) return 0;
  const e = KMB_JT.map.get(route+'|'+(bound||''));
  if(!e || !(e.n > 1)) return 0;
  const i = Math.min(s, e.n - 1);
  return Math.round(e.jt * (i / (e.n - 1)));
}

/* ---------- 九巴／龍運班次表（GitHub 開放資料） ----------
   官方到站 API 掛掉時（CORS、維修）的備援：依時刻表推算下一班。
   格式：路線|方向|星期遮罩|開出-結束-班距(分);…   gzip + base64
   注意：這是「頭站開出」推算，未計入行車時間，只作為沒有實時資料時的粗略參考。 */
const EMB_KMB_FREQ = "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";
const KMB_FREQ = {map:new Map(), ready:false};
function kmbFreqLoad(txt){
  for(const line of txt.split('\n')){
    const [r,b,mask,per] = line.split('|');
    if(!r || !mask || !per) continue;
    const arr = [];
    for(const p of per.split(';')){
      const [s,e,h] = p.split('-');
      if(!s || !e || !h) continue;
      arr.push([+s, +e, +h]);
    }
    if(arr.length){
      const k = r+'|'+(b||'');
      if(!KMB_FREQ.map.has(k)) KMB_FREQ.map.set(k, new Map());
      KMB_FREQ.map.get(k).set(+mask, arr);
    }
  }
  KMB_FREQ.ready = true;
}
const hhmm2min = n => Math.floor(n/100)*60 + (n%100);
/* 依班次表推算下一班的分鐘數。
   只接受 90 分鐘內的班次：再遠的話頭站開出時間參考價值太低，寧可顯示暫無班次。 */
const KMB_FREQ_MAX = 90;
function kmbTimetableNext(route, bound, seq){
  if(!KMB_FREQ.ready) return null;
  const off = kmbJtOffset(route, bound, seq);
  let byMask = KMB_FREQ.map.get(route+'|'+(bound||''));
  // 方向缺失或該方向沒有班次表時，改試另一個方向（取較近的一班）
  if(!byMask && bound!=='O' && bound!=='I'){
    const a = KMB_FREQ.map.get(route+'|O'), b = KMB_FREQ.map.get(route+'|I');
    if(a && b){ const x=_freqCalc(a, off), y=_freqCalc(b, off);
      return (x===null)?y:((y===null)?x:Math.min(x,y)); }
    byMask = a || b;
  }
  if(!byMask) return null;
  return _freqCalc(byMask, off);
}
function _freqCalc(byMask, off0){
  // 遮罩是「一組日子」（如 31=平日、32=週六、64=週日），要用位元比對而非相等；
  // 同時命中多組時取最特定的一組（位元數最少者）
  const bit = serviceBit();
  let per = null, best = 99;
  for(const [mask, arr] of byMask){
    if(!(mask & bit)) continue;
    let n = 0; for(let x=mask; x; x>>=1) n += x & 1;
    if(n < best){ best = n; per = arr; }
  }
  if(!per || !per.length) return null;
  const now = new Date();
  const cur = now.getHours()*60 + now.getMinutes();
  const off = off0 || 0;
  let soonest = null;
  /* 要找的是「抵達我這站的時間」= 頭站開出 + 行車時間。
     所以不能只看未來才開出的班次——已經開出、但還在路上（還沒到我這站）的也算。
     舊寫法只找未來的開出時間，對路線後段的站會漏掉這些班次。 */
  for(let pass=0; pass<2; pass++){                 // 第二段跨越午夜（如 2445）
    for(const p of per){
      const s = hhmm2min(p[0]) + pass*1440;
      const e = hhmm2min(p[1]) + pass*1440;
      const h = p[2];
      if(!(h > 0) || e <= s) continue;
      // 最小 k 使 s + k*h + off > cur
      let k = Math.floor((cur - off - s) / h) + 1;
      if(k < 0) k = 0;
      const dep = s + k * h;
      if(dep >= e) continue;                       // 該時段已收車
      const arrive = dep + off;
      const wait = arrive - cur;
      if(wait < 0) continue;
      if(wait <= KMB_FREQ_MAX + off) soonest = soonest===null ? wait : Math.min(soonest, wait);
    }
    if(soonest !== null) break;
  }
  return soonest===null ? null : Math.round(soonest);
}

/* ---------- 城巴／嶼巴：內建資料（GitHub 開放資料） ----------
   這兩家的 API 通常可連，但「某一站有哪些路線」仍要逐站打 API，
   「附近」更是每站一次請求。內建後：站→路線查詢零請求，
   且 API 失敗時車站資料仍有備援（尤其是嶼巴，路線頁原本必定要連網）。 */
const EMB_CTB = "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";
const EMB_NLB = "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";

/* 解析共用的「路線表＋車站表」格式：
     路線: 路線|方向|起點|終點|額外ID|停站1,停站2,…
     車站: 站號|站名|lat|lng|路線1,路線2,…
   nlbId=true 時第 5 欄為嶼巴的 routeId（查到站 API 必備） */
function parseEmbedded(txt, co, withNlbId){
  const parts = txt.split('\n@@\n');
  if(parts.length < 2) return null;
  const rmap = new Map(), rsAt = new Map();
  for(const line of parts[0].split('\n')){
    const [route, bound, orig, dest, extra, stopStr] = line.split('|');
    if(!route || !stopStr) continue;
    const stops = stopStr.split(',');
    if(!rmap.has(route)) rmap.set(route, {co, route, bound, orig, dest, stops,
                                          id: withNlbId ? extra : undefined});
    stops.forEach((sid, i)=>{
      if(!rsAt.has(sid)) rsAt.set(sid, []);
      const arr = rsAt.get(sid);
      if(!arr.some(x=>x.route===route && x.bound===bound))
        arr.push({route, bound: bound||'', seq: i+1});   // 站序：到站篩選需要
    });
  }
  const stops = [];
  for(const line of parts[1].split('\n')){
    const [id, tc, la, lo] = line.split('|');
    if(!id || !tc) continue;
    stops.push({co, id, tc, lat:+la, lng:+lo});
  }
  if(!stops.length) return null;
  return {stops, rsAt, rmap};
}
/* 城巴：API 成功時以 API 為主（資料較新），索引一律用內建（省請求） */
async function loadCtbEmbedded(){
  const txt = await gunzipB64(EMB_CTB); if(!txt) return false;
  const p = parseEmbedded(txt, 'CTB', false); if(!p) return false;
  if(!D.CTB.stop || !D.CTB.stop.length){
    D.CTB.stop = p.stops;
    D.CTB.stopById = new Map(p.stops.map(s=>[s.id, s]));
  } else {
    // API 有車站時，只補上 API 沒給到的站（內建為備援）
    const have = new Set(D.CTB.stop.map(s=>String(s.id)));
    for(const s of p.stops) if(!have.has(String(s.id))) D.CTB.stop.push(s);
    D.CTB.stopById = new Map(D.CTB.stop.map(s=>[String(s.id), s]));
  }
  D.CTB.routesAtStop = p.rsAt;
  D.CTB.routeMap     = p.rmap;
  if(!D.CTB.route || !D.CTB.route.length) D.CTB.route = [...p.rmap.values()];
  D.CTB.ready = !!(D.CTB.route && D.CTB.stop && D.CTB.stop.length);
  _allStopsCache = null;
  return true;
}
/* 嶼巴：路線的 routeId 內建就有了，不必先連網拿路線清單 */
async function loadNlbEmbedded(){
  const txt = await gunzipB64(EMB_NLB); if(!txt) return false;
  const p = parseEmbedded(txt, 'NLB', true); if(!p) return false;
  D.NLB.stop     = p.stops;
  D.NLB.stopById = new Map(p.stops.map(s=>[s.id, s]));
  D.NLB.routesAtStop = p.rsAt;
  // 到站 API 需要 routeId（不是路線號），從路線表補進索引
  if(p.rmap){
    for(const [sid, arr] of p.rsAt){
      for(const x of arr){
        const r = p.rmap.get(x.route);
        if(r && r.id) x.id = r.id;
      }
    }
  }
  if(!D.NLB.route || !D.NLB.route.length)
    D.NLB.route = [...p.rmap.values()].map(r=>({co:'NLB', route:r.route, id:r.id, orig:r.orig, dest:r.dest}));
  D.NLB.ready = true;
  _allStopsCache = null;
  return true;
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
/* 服務日代碼：低 7 位元為星期遮罩，高位為班次版本。
   順序經實測 hkbus 的 serviceDayMap 確認為 [日,一,二,三,四,五,六]，
   也就是直接對應 Date.getDay()，權重 [64,1,2,4,8,16,32]。
   （31=平日、32=週六、64=週日／假日——實測最常見的三種） */
const DAYBIT = [64,1,2,4,8,16,32];

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
  // 順序即為 Date.getDay()（0=週日），不可再換算
  return DAYBIT[new Date().getDay()];
}
/* 今天適用的服務日位元：假日改用週日班次 */
function serviceBit(){
  const d = new Date();
  const s = '' + d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  if(FERRY_HOLIDAYS.indexOf(s) >= 0) return DAYBIT[0];
  return DAYBIT[d.getDay()];
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
    /* 適用於今天的時刻表。
       服務日編碼：低 7 位元為星期遮罩，位元順序即 Date.getDay()
       （0=週日 →64，1=週一 →1 … 6=週六 →32），已對照 hkbus 的
       serviceDayMap 全部 511 個鍵驗證無誤。

       這裡取「所有符合的班次表聯集」，而不是只挑一份：
       同一路線常有多份班次表同時符合今天（例如長洲線 287 只有 1 班 1630、
       319 則涵蓋全日 43 班），只挑第一份會把整天班次都丟掉，
       使用者看到「今天只有一班船」。

       假日則改用週日班次表（hkbus 亦是如此：serviceDayMap[key][0]==="1"
       代表假日／週日班次）；若沒有週日版就退回平日表。 */
    const keys = Object.keys(freq).filter(k=>{
      const dayMask = +k & 127;
      return (dayMask & mask) !== 0;
    });
    let use = keys;
    if(isHol){
      const hol = keys.filter(k=>((+k & 127) & 64) !== 0);   // 含週日＝假日班次
      if(hol.length) use = hol;
    }
    if(!use.length) continue;
    const best = [];
    for(const k of use){
      const v = freq[k];
      if(Array.isArray(v)) best.push(...v);
      else if(v && typeof v==='object') best.push(...Object.keys(v));
    }
    if(!best.length) continue;
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
  /* 已開出的班次要過濾掉，不能留著顯示「已過站」。
     原本只是把負值在排序時加 1440（擠到最後），但回傳的 min 仍是負的，
     結果末班船開出後，畫面只會出現一排「已過站」，看不到下一班。 */
  const upcoming = out.filter(x=>x.min >= 0).sort((a,b)=>a.min-b.min);
  if(upcoming.length) return upcoming.slice(0, limit);
  // 今天已收船 → 顯示明天同一班（時刻表多為每日，故加一天）
  return out.map(x=>Object.assign({}, x, {min:x.min+1440, tmr:true}))
            .sort((a,b)=>a.min-b.min).slice(0, limit);
}
/* ---------- 輕鐵 ----------
   座標與站號取自 hkbus 專案整理之港鐵開放資料（hk-bus-crawling，GitHub），
   共 80 站，為真實 WGS84 座標。
   （官方 light_rail_routes_and_stops.csv 只有編號／名稱／路線，沒有經緯度） */
/* 同一車站的不同月台各有編號（座標完全相同），已依站名合併為 68 站。
   格式：[站號, 站名, lat, lng, [途經路線]] ；站號去掉 LR 即為到站 API 用的數字編號 */
const LRT_STOPS = [
['LR001','屯門碼頭',22.37271,113.96712,["506P*","507","507P*","610","614","614P","615","615P","751*"]],
['LR10','美樂',22.37505,113.96111,["506P*","610","615","615P"]],
['LR15','蝴蝶',22.37817,113.96166,["506P*","610","615","615P"]],
['LR20','輕鐵車廠',22.38181,113.96342,["506P*","610","615","615P"]],
['LR30','龍門',22.38526,113.96498,["506P*","610","615","615P"]],
['LR40','青山村',22.3904,113.96696,["506P*","610","615","615P"]],
['LR50','青雲',22.39434,113.9674,["506P*","610","615","615P"]],
['LR060','建安',22.39513,113.9689,["505","506P*"]],
['LR70','河田',22.39738,113.97313,["507","507P*","751","751*"]],
['LR75','蔡意橋',22.39993,113.97417,["507","507P*","751","751*"]],
['LR80','澤豐',22.40349,113.97589,["610","610P*","751","751*"]],
['LR90','屯門醫院',22.40777,113.97715,["610","610P*","751","751*"]],
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
  await lrtSeqEnsure();          // 先備妥站序，才能填進路線表
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
  D.LRT.route        = [...routeSet].map(r=>({co:'LRT', route:r, bound:'', orig:'', dest:'',
                          stops: lrtSeqOf(r)}));
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
  // .catch 不可省：ensureNlbStops 失敗時否則會變成未處理的 rejection
  if(stopFilter==='NLB'){ waitBus().then(ensureNlbStops).catch(()=>{}).then(()=>{
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
    if(nearView==='stop' && !nearData.stops?.[0]?.eta) fillNearEtas();
    return;
  }
  const st = e.target.closest('.item[data-id]');
  if(st){
    // 合併站：帶入所有月台，一次顯示各方向的班次
    const gi = st.dataset.gidx;
    const g = (gi!==undefined && nearData.stops[+gi]) ? nearData.stops[+gi] : null;
    const ids = (g && g.stops.length>1) ? g.stops.map(s=>s.id) : null;
    openStopEta(st.dataset.co, st.dataset.id, ids);
    return;
  }
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
  if(co==='CTB' && D.CTB.routesAtStop){
    const arr = D.CTB.routesAtStop.get(String(id)) || [];
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
        <button class="btn sm ghost" id="geoRetrySlim">↻ 定位</button></div></div>`;
  } else {
    box.innerHTML = `<div class="card">
      <h2>📍 附近車站</h2>
      <div class="banner err">⚠️ ${esc(msg)}</div>
      ${isFile?`<div class="tiny muted" style="margin-top:6px">提醒：以「本機檔案」方式開啟時，部分瀏覽器（如 Safari）會停用定位。
        可改用 Chrome／Edge，或把檔案放到 https 網址下開啟。</div>`:''}
      <div class="act" style="margin-top:10px">
        <button class="btn sm ghost" id="geoRetryErr">↻ 再試一次</button>
      </div></div>`;
  }
  for(const id of ['geoRetrySlim','geoRetryErr']){
    const b = $('#'+id); if(b) b.onclick = ()=>{ geoDenied(false); requestNearby({force:true}); };
  }
}
/* 港鐵班次：官方端點失敗時改用鏡像。
   回應格式：官方用 {data:{...}}；鏡像會包一層 {url,status,message,data}，
   status 為 0 時代表官方端點出錯，此時把 message 當成備註顯示。 */
async function mtrSchedJson(line, sta){
  let j = null, lastErr = null;
  try{ j = await cachedGet(EP.mtrSched(line, sta), 30e3, {timeout:15000}); }
  catch(e){ lastErr = e; }
  const usable = j && j.data && Object.keys(j.data).length;
  if(usable) return j;
  try{
    const m = await getJSON(EP.mtrSchedMirror(line, sta), {timeout:15000});
    if(m && (m.data || m.message)) return m;
  }catch(e){ lastErr = lastErr || e; }
  if(usable) return j;
  if(j) return j;
  throw lastErr || new Error('無法取得港鐵班次');
}

/* 是否曾發生連線錯誤：用來區分「真的沒班次」與「連不上」 */
function netErr(){
  if(!LAST_RAW.failed) return null;
  return LAST_RAW.err || '連線失敗';
}

let skippedSteps = [];
function active0(steps, skip){ return steps.filter(([l])=>!skip[l]).length; }

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
  const merged = mergeNearStops(inRange).slice(0, 20);
  nearData = {pos, stops: merged, allInRange: inRange, routes:null, err:null};
  renderNearBox();
  loadNearbyRoutes();                     // 背景補算路線
  fillNearEtas();                         // 背景補上各站即時分鐘數
}
async function renderLrtRoute(co, route){
  const box = $('#routeBox');
  let stops = lrtSeqOf(route);
  if(!stops.length){
    // 內建站序尚未解壓完成時，從索引反查（無順序）
    const rev = [];
    for(const [sid, arr] of (D.LRT.routesAtStop || new Map()))
      if((arr||[]).some(x=>String(x.route)===String(route))) rev.push(sid);
    stops = rev;
  }
  if(!stops.length){
    box.innerHTML = `<div class="card"><h2><span class="badge lrt">${esc(route)}</span> 輕鐵</h2>
      <div class="empty">找不到此路線的站序資料。</div></div>`;
    return;
  }
  box.innerHTML = `<div class="card">
    <div class="spread"><h2 style="margin:0"><span class="badge lrt">${esc(route)}</span> 輕鐵</h2>
      <span class="tiny muted">共 ${stops.length} 站</span></div>
    <div class="sep"></div>
    <div class="stoplist">${stops.map((sid,i)=>{
      const s = D.LRT.stopById?.get(String(sid)) || {};
      return `<div class="stoprow" data-co="LRT" data-id="${esc(sid)}">
        <span class="stopdot"></span>
        <div style="flex:1;min-width:0"><div class="small">${i+1}. ${esc(s.tc||sid)}</div></div>
        <span class="eta tiny"></span></div>`;
    }).join('')}</div>
    <div class="tiny muted" style="margin-top:8px">點站名看該站即時到站。</div></div>`;
}

/* 統一渲染：同一張卡片，用 chip 切換「車站／路線」＋依營辦商篩選 */
function nearCounts(){
  const c = {ALL:0, KMB:0, CTB:0, GMB:0, NLB:0, MTRB:0, MTR:0, LRT:0, FERRY:0};
  /* allInRange 是原始車站（{s,d}），stops 則是合併後的群組（{co,stops}）。
     兩種格式都要能吃，否則切換後計數會全部歸零。 */
  (nearData.allInRange || nearData.stops).forEach(x=>{
    const co = (x.s && x.s.co) || x.co;
    if(!co) return;
    c.ALL++; if(c[co]!==undefined) c[co]++;
  });
  return c;
}
const CO_SHORT = {ALL:'全部', KMB:'九巴', CTB:'城巴', GMB:'小巴', NLB:'嶼巴', MTRB:'港鐵巴', MTR:'港鐵', LRT:'輕鐵', FERRY:'渡輪'};

/* 附近清單會把同一個實體站拆成好幾項（119m 與 124m 都是「海麗邨巴士總站」、
   還有三個都叫「海麗邨」），因為它們是不同方向的月台、各有自己的站號。
   依「營辦商＋站名」合併成一項，點進去一次看全部方向的班次。 */
function nearStopKey(s){
  return s.co + '|' + String(s.tc||'')
    .replace(/[（(][^）)]*[）)]/g,'')      // 去掉括號（站名後綴／方向）
    .replace(/[\s,，、]+$/,'').trim();
}
function mergeNearStops(inRange){
  const groups = new Map();
  for(const x of inRange){
    const k = nearStopKey(x.s);
    let g = groups.get(k);
    if(!g){ g = {name:x.s.tc, co:x.s.co, dist:x.d, approx:x.s.approx,
                 stops:[x.s], dists:[x.d]}; groups.set(k, g); }
    else {
      if(!g.stops.some(s2=>String(s2.id)===String(x.s.id))){
        g.stops.push(x.s); g.dists.push(x.d);
      }
      if(x.d < g.dist){ g.dist = x.d; g.approx = x.s.approx; }
    }
  }
  return [...groups.values()].sort((a,b)=>a.dist-b.dist);
}
/* 站名後綴：合併後用來區分個別月台（如 SS667 / SS917） */
function stopCodeOf(s){
  const m = String(s.tc||'').match(/[（(]([^）)]+)[）)]\s*$/);
  if(m) return m[1];
  return String(s.id).slice(-5);
}
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
      ? `<div class="list" style="margin-top:6px">` + nearData.stops.map((g,i)=>{
          const rt = g.stops.length===1
            ? stopRoutesPreview(g.co, g.stops[0].id)
            : g.stops.flatMap(s=>stopRoutesPreview(g.co, s.id));
          const uniqRt = [...new Set(rt)].sort(routeCmp);
          const main = g.stops[0];
          return `<div class="item" data-co="${g.co}" data-id="${esc(main.id)}" data-gidx="${i}">
            <span class="badge ${CO_CLS[g.co]}">${fmtDistOf(g.dist, g.approx)}</span>
            <div style="flex:1;min-width:0">
              <div class="nm">${esc(g.name)}${g.stops.length>1?` <span class="tiny muted">${g.stops.length} 個月台</span>`:''}</div>
              <div class="sub" data-neta="${i}">${uniqRt.length? esc(uniqRt.map(c=> g.co==='MTR' ? String(lineOf(c)?.name||c).replace(/[線綫]$/,'') : c).join(' · ')) : esc(CO_NAME[g.co])}</div>
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
  if(co==='NLB' && !D.NLB.stop){ waitBus().then(ensureNlbStops).catch(()=>{}).then(()=>{ if(nearData.pos) renderNearby(nearData.pos); }); return; }
  if(nearData.pos) renderNearby(nearData.pos);
}
/* 背景替附近各站補上即時分鐘數：不必點進車站才看得到還有多久。
   限最近的 8 個站、每站最多顯示 6 條路線，並用 token 避免舊結果蓋掉新畫面。 */
let nearEtaTok = 0;
async function fillNearEtas(){
  if(nearView!=='stop' || !nearData.stops || !nearData.stops.length) return;
  if(SETTINGS.nearEta === 0 || SETTINGS.nearEta === '0') return;   // 可在設定關閉（省流量）
  const myTok = ++nearEtaTok;
  const groups = nearData.stops.slice(0, 8);
  await pool(groups, 3, async (g, gi)=>{
    let rows = [];
    for(const s of g.stops.slice(0, 3)){
      try{
        const r = await fetchEtaRows(g.co, s.id);
        for(const x of r) rows.push(Object.assign({_stop:s}, x));
      }catch(e){}
    }
    if(myTok !== nearEtaTok) return;
    // 同一路線＋目的地只留最快一班，並標註來自哪個月台
    const best = new Map();
    for(const r of rows){
      const k = String(r.route)+'|'+(r.dest||'');
      const cur = best.get(k);
      if(!cur || ((r.min ?? 9999) < (cur.min ?? 9999))) best.set(k, r);
    }
    const list = [...best.values()]
      .sort((a,b)=>(a.min ?? 9999)-(b.min ?? 9999))
      .slice(0, 6);
    g.eta = list;
    const el = document.querySelector(`#nearBox [data-neta="${gi}"]`);
    if(el) el.innerHTML = nearEtaHtml(list, g);
  });
}
function nearEtaHtml(list, g){
  if(!list || !list.length) return '<span class="tiny muted">暫無班次</span>';
  const multi = g.stops.length > 1;
  return list.map(r=>{
    const m = r.min;
    const t = (m===null||m===undefined) ? '<span class="tiny muted">—</span>'
            : (m<=0 ? '<span class="eta soon">將到</span>'
                    : `<span class="eta ${m<=5?'soon':''}">${m}分</span>`);
    const code = multi ? `<span class="tiny muted">${esc(stopCodeOf(r._stop))}</span>` : '';
    return `<span class="neta">${esc(r.route)} ${code} ${t}</span>`;
  }).join(' ');
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
    const em = D.CTB.routesAtStop?.get(String(id));
    if(em && em.length)
      return em.map(x=>({route:String(x.route), bound:String(x.bound||'')})).filter(x=>x.route);
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
async function openStopEta(co, id, ids){
  curStop = {co, id, ids: ids && ids.length ? ids : null};
  if(co==='NLB' && !D.NLB.stop) await ensureNlbStops();
  if(co==='MTRB' && !D.MTRB.ready) await loadMtrBus();
  if(co==='LRT' && !D.LRT.ready) await loadLrt();
  if(co==='FERRY') buildFerry();
  const box = $('#stopEta');
  const name = (D[co]?.stopById?.get(id) || {}).tc || id;
  box.innerHTML = `<div class="card"><div class="spread"><h2 style="margin:0">
      <span class="badge ${CO_CLS[co]}">${esc(co)}</span> ${esc(titleName)}${multi?` <span class="tiny muted">${ids.length} 個月台</span>`:''}</h2>
      <span class="spin"></span></div><div class="small muted" style="margin-top:6px">正在讀取實時到站…</div></div>`;
  box.scrollIntoView({behavior:'smooth', block:'start'});
  await fetchStopEta();
  restartEtaTimer();
}
/* 純資料版：只取到站列，不碰畫面。附近清單的即時分鐘數與合併站都用它。 */
async function fetchEtaRows(co, id){
  if(co==='KMB')  return await kmbStopEta(id);
  if(co==='CTB')  return await ctbStopEta(id);
  if(co==='GMB')  return await gmbStopEta(id);
  if(co==='NLB')  return await nlbStopEta(id);
  if(co==='MTRB'){ if(!D.MTRB.ready) await loadMtrBus(); return await mtrBusStopEta(id); }
  if(co==='MTR')  return await mtrStationEta(id);
  if(co==='LRT'){
    if(!D.LRT.ready) await loadLrt();
    let r = await lrtStopEta(id);
    if(!r.length){
      const rt = lrtRoutesAt(String(id));
      if(rt.length) r = rt.map(x=>({route:x, min:null, iso:null, dest:'', rmk:'實時到站暫時無法取得'}));
    }
    return r;
  }
  if(co==='FERRY'){
    buildFerry();
    return ferryNextSailings(id).map(s=>({route:s.route, min:s.min, iso:null,
                                          dest:s.dest||'',
                                          rmk:(FERRY_CO[s.op]||'')+' '+(s.dep||'')+(s.tmr?'（明日）':'')}));
  }
  return [];
}

async function fetchStopEta(){
  if(!curStop) return;
  if(document.hidden) return;        // 背景分頁不進行自動更新
  const {co, id} = curStop;
  const box = $('#stopEta');
  const name = (D[co]?.stopById?.get(id) || {}).tc || id;
  const ids = curStop.ids && curStop.ids.length ? curStop.ids : [id];
  const multi = ids.length > 1;
  const titleName = multi ? name.replace(/[（(][^）)]*[）)]\s*$/,'').trim() || name : name;
  let rows = [], err = null;
  etaReset();
  try{
    if(!multi){
      rows = await fetchEtaRows(co, id);
    } else {
      /* 合併站：一次查所有月台，各班次標註從哪個月台開出
         （同一站名可能有去程／回程兩個方向） */
      const got = await pool(ids, 3, async sid=>{
        try{
          const r = await fetchEtaRows(co, sid);
          const nm = (D[co]?.stopById?.get(String(sid)) || {}).tc || sid;
          return (r||[]).map(x=>Object.assign({_stop:sid, _stopName:nm}, x));
        }catch(e){ return []; }
      });
      rows = got.flat();
      // 同一路線＋目的地只留最快一班
      const best = new Map();
      for(const r of rows){
        const k = String(r.route)+'|'+(r.dest||'');
        const c = best.get(k);
        if(!c || ((r.min ?? 9999) < (c.min ?? 9999))) best.set(k, r);
      }
      rows = [...best.values()];
      rows.forEach(r=>{
        if(r._stop && !r._via){
          r._via = (D[co]?.stopById?.get(String(r._stop)) || {}).tc || '';
        }
      });
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
  /* 目的地後備：官方到站回應不一定帶目的地
     （小巴完全不提供，港鐵／輕鐵也常在夜間缺），
     此時改由內建路線表補，避免出現「往 —」這種看不懂的顯示。 */
  rows.forEach(r=>{
    if(!r.dest){
      const m = D[co]?.routeMap?.get(String(r.route));
      r.dest = (m && m.dest) || routeDest(co, r.route, r.bound) || '';
    }
  });
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
  const nSched   = rows.filter(r=>r.sched).length;
  const allSched = rows.length>0 && nSched===rows.length;
  const allNull  = rows.length>0 && rows.every(r=>r.min===null);
  box.innerHTML = `<div class="card">
    <div class="spread"><h2 style="margin:0"><span class="badge ${CO_CLS[co]}">${esc(co)}</span> ${esc(name)}</h2>
      <span class="tiny muted">${updated} 更新</span></div>
    ${co==='FERRY'? `<div class="banner" style="margin:6px 0 2px">⛴️ 渡輪沒有實時到站資料，以下為<b>時刻表推算</b>的下一班，實際以碼頭公佈為準。</div>`:''}
    ${nSched? `<div class="banner" style="margin:6px 0 2px">📋 實時到站${allSched?'無法取得':'部分缺資料'}，標示「班表推算」者為依<b>班次表</b>推算：以頭站開出時間，再按站數比例加上<b>估計行車時間</b>。僅供參考，實際以站牌為準。</div>`:''}
    ${co==='KMB' && rows.length && allNull? `<div class="banner err" style="margin:6px 0 2px">⚠️ 此站所有路線都沒有班次資料。若屬異常，請按「複製診斷」回報。</div>`:''}
    ${rows.length && !allNull && netErr()? `<div class="banner" style="margin:6px 0 2px">⚠️ 部分路線查詢失敗，顯示的可能不完整。</div>`:''}
    <div class="small muted" style="margin:2px 0 8px">站號 ${esc(id)} · 共 ${rows.length} 條路線</div>
    ${rows.length? `<div class="stoplist">${rows.map(r=>`
      <div class="stoprow" data-route="${esc(r.route)}">
        <span class="badge ${CO_CLS[co]}">${esc(r.route)}</span>
        <div style="flex:1;min-width:0">
          <div class="small">往 ${esc(r.dest||'—')}</div>
          ${r._via?`<div class="tiny muted">${esc(r._via)}</div>`:''}
          ${r.rmk?`<div class="tiny muted">${esc(r.rmk)}</div>`:''}
        </div>
        ${etaHtml(r.min, r.iso, r.sched)}
      </div>`).join('')}</div>`
      : (netErr()
          ? `<div class="banner err">⚠️ 無法連上 ${esc(CO_NAME[co]||co)} 的到站服務${esc(netErr()).slice(0,60)?'（'+esc(netErr()).slice(0,60)+'）':''}。<br>
             若為 CORS 限制，可到「更多 → 設定」改用代理通道。</div>`
          : '<div class="empty">此刻沒有班次資料（可能是服務時間外）。</div>')}
    <div class="sep"></div>
    <div class="act">
      <button class="btn sm ghost" id="etaRefresh">↻ 立即更新</button>
      <button class="btn sm ghost" id="etaFav">★ 收藏此站</button>
      <button class="btn sm ghost" id="etaDiag">📋 複製診斷</button>
    </div>
  </div>`;
  $('#etaRefresh').onclick = fetchStopEta;
  $('#etaFav').onclick = ()=>{ addFav({co, id, name}); };
  const dg = $('#etaDiag');
  if(dg) dg.onclick = async ()=>{
    const info = {
      stop: id, co, at: new Date().toISOString(),
      clockSkewMs: TIME_SKEW.set ? TIME_SKEW.ms : null,
      clockSkewFrom: TIME_SKEW.src || null,
      err: LAST_RAW.kmbErr || netErr(),
      raw: LAST_RAW.last ? JSON.stringify(LAST_RAW.last).slice(0, 1200) : null,
      rawAt: LAST_RAW.lastAt || null,
      rows: rows.map(r=>({route:r.route, min:r.min, sched:!!r.sched, dest:r.dest||''}))
    };
    const txt = JSON.stringify(info, null, 1);
    try{ await navigator.clipboard.writeText(txt); dg.textContent = '✓ 已複製'; }
    catch(e){
      try{ prompt('複製下列診斷資訊：', txt); }
      catch(e2){ console.log(txt); }
    }
    setTimeout(()=>{ if(dg) dg.textContent = '📋 複製診斷'; }, 2000);
  };
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
    LAST_RAW.attempted++;
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
    }catch(e){ etaFail(e); return null; }
  });
  return out.filter(Boolean);
}
/* 港鐵重鐵到站：以站為單位，對每條途經路線查一次官方 API */
async function mtrStationEta(sta){
  const lines = (MTR_ST[sta] && MTR_ST[sta].lines) || [];
  const got = await pool(lines, 4, async line=>{
    try{
      LAST_RAW.attempted++;
      const j = await mtrSchedJson(line, sta);
      const d = j.data || {};
      let node = null;
      for(const k of Object.keys(d)){ if(k.indexOf(line+'-'+sta)===0){ node = d[k]; break; } }
      if(!node) return null;
      const all = [].concat(asArray(node.UP), asArray(node.DOWN));
      const f = all.slice().sort((a,b)=>(+pick(a,'seq')||0)-(+pick(b,'seq')||0))[0];
      if(!f){
        // 官方端點回應「維修中／暫停」等訊息時，把訊息帶給使用者
        const msg = pick(j,'message');
        if(msg) return {route:line, min:null, iso:null, dest:'', rmk:String(msg).slice(0,60)};
        return null;
      }
      let min = toMin(pick(f,'ttnt'));
      if(min===null) min = minsToHk(pick(f,'time'));
      const destCode = pick(f,'dest');
      const dn = (MTR_ST[destCode] && MTR_ST[destCode].tc) || destCode || '';
      return {route:line, min, iso:pick(f,'time')||null, dest:dn,
              rmk: pick(f,'plat') ? ('月台 '+pick(f,'plat')) : ''};
    }catch(e){ etaFail(e); return null; }
  });
  return got.filter(Boolean);
}
/* 輕鐵到站：官方以站號回傳各月台路線 */
/* 小巴目的地：官方到站 API 不提供，一律由內建資料（GitHub）帶入 */
function gmbRouteDest(route, bound){
  const r0 = D.GMB.routeMap?.get(String(route));
  if(r0 && r0.dest) return r0.dest;
  const list = D.GMB.route || [];
  const r1 = list.find(x=>String(x.route)===String(route) && (!bound || x.bound===bound))
          || list.find(x=>String(x.route)===String(route));
  return r1 ? (r1.dest || '') : '';
}
/* 取該路線在此站的所有班次（含目的地），並保留最快的一班 */
function gmbRowsWithDest(j, seq, bound, route, dest){
  const rows = gmbEtaRows(j, seq, bound, route, dest);
  return rows.map(r=>Object.assign({}, r, {dest: r.dest || dest || ''}));
}

/* ---------- 輕鐵路線站序（GitHub 開放資料） ----------
   原本只有「站 → 路線」，沒有「路線 → 站序」，
   所以點輕鐵路線進去看不到站序表。這裡補上。 */
const EMB_LRT_SEQ = "H4sIAMAEoWoC/7VWW24DIQz8z1GqfJiHgT1CpUpdpdfJ4QtjF2iSzZIt/bFWGM+MH8Ay8fX9+nExROdsLayD9bAMG2BjsRY7sWAXLjbhW5yhrCyWTpyBP6/4ruu6J7VYwV1gU+NQPu50uE6fgaVCEtY30BCZvEbwkCnQhL2EOAIGAY866Q65OEQ57HfY73xjiMowUiFrbLGSsjBHaInPymUlFjhWlJIpzNKZARaQvMghDMisrqk/PGtZrITCrTqg6aZvp2DoV/XQ6EQjsfc9L2ioSAAWA4yBxhDFQPDSU3gdvA5eB69j7eyemm7WWWAxL1iETsCgjkXXTx1Nddoa4CuI4Cn2XRdTFSX6RKvqjl0+S8tTctb8U6tLrlHW5dfucMtQ64DbbvCJhkcGkK/MzP4Jy5BTuzopzblZTukm993US3D4wt4fYl4PTPHoTZ3hp3Z5auLz857S8ahPqBcdrujykg4zRGE/RDN4GTtZJMtOYPqQYPHt8e0544ce33Pzhi4qNTRFdh2jsFNTpQpdxrfUX/5b5fCWH9MvCn2KbAToQU7LJv+5ZgaC5/NEwKH0tzc7C5UzekCoBO/3W4BuelOCjxIPVqi9llt/GwwVJQMb9/4dRt86HY4jFQnai/ErZ3MSH0FvzOPvM9ZqO3jmv9bLf076NwzdUujvCwAA";
const LRT_SEQ = {map:new Map(), ready:false};
function lrtSeqLoad(txt){
  /* 每行格式：路線|方向|站1,站2,站3…
     注意方向與站清單之間也是 |，不能直接 slice(1) 拿站清單，
     否則方向碼會被併進第一個站號（例如 I|LR100）。 */
  for(const line of txt.split('\n')){
    const p = line.split('|');
    if(p.length < 3) continue;
    const key = p[0] + '|' + p[1];
    const stops = p.slice(2).join('|').split(',').map(s=>s.trim()).filter(Boolean);
    if(key && stops.length >= 2) LRT_SEQ.map.set(key, stops);
  }
  LRT_SEQ.ready = true;
}
/* 取路線的站序（0.7KB 的內建資料；bound 常為空，所以兩個方向都試） */
function lrtSeqOf(route){
  if(!LRT_SEQ.ready) return [];
  return LRT_SEQ.map.get(String(route)+'|O')
      || LRT_SEQ.map.get(String(route)+'|I')
      || [];
}

/* 某個輕鐵站有哪些路線（由內建路線表反查） */
function lrtRoutesAt(id){
  const arr = D.LRT.routesAtStop?.get(String(id)) || [];
  return [...new Set(arr.map(x=>String(x.route)))].sort(routeCmp);
}

/* 輕鐵站號有多種寫法（LR001／LR10／LR920），而 API 只吃數字。
   若某一種格式查不到就整站沒資料，所以依序嘗試幾種候選寫法。 */
function lrtIdCandidates(rawId){
  const s = String(rawId || '');
  const num = s.replace(/^LR/i, '');
  const out = [];
  const add = x=>{ if(x && !out.includes(x)) out.push(x); };
  add(num);
  add(num.replace(/^0+/, '') || '0');                       // 010 -> 10
  add(num.padStart(3, '0'));                                 // 10 -> 010
  return out;
}
async function lrtStopEta(rawId){
  let j = null, lastErr = null;
  LAST_RAW.attempted++;
  for(const id of lrtIdCandidates(rawId)){
    try{
      const r = await cachedGet(EP.lrtEta(id), 30e3, {timeout:15000});
      if(asArray(pick(r,'platform_list')).length){ j = r; break; }   // 有資料才收
      if(!j) j = r;                                                  // 否則記下，繼續試下一種
    }
    catch(e){ lastErr = lastErr || e; etaFail(e); }
  }
  if(!j){ if(lastErr) etaFail(lastErr); return []; }
  const plats = asArray(pick(j,'platform_list'));
  if(!plats.length) return [];
  /* 全部月台都收車時，明確告知而不是顯示一片空白
     （hkbus 也是這樣處理） */
  if(plats.every(p=>pick(p,'end_service_status')))
    return [{route:'—', min:null, iso:null, dest:'', rmk:'此站今日服務已經終止'}];
  const out = [];
  for(const p of plats){
    const pid = pick(p,'platform_id');
    const list = asArray(pick(p,'route_list'));
    // stop===0 才是停靠本站的班次（hkbus 用法）
    const atStop = list.filter(r=>pick(r,'stop')===0 || pick(r,'stop')==='0');
    for(const r of (atStop.length ? atStop : list)){
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
  // 找出停靠此站的城巴路線：內建索引已備妥，不必再打一次 API
  let routes = (D.CTB.routesAtStop?.get(String(stopId)) || []).map(r=>({route:r.route, dir:r.bound, seq:r.seq}));
  if(!routes.length){
    for(const mk of EP.ctbStopRoute){
      try{
        const j = await getJSON(mk(stopId), {timeout:12000});
        routes = asArray(pick(j,'data')).map(d=>({route:pick(d,'route'), dir:pick(d,'dir')}));
        if(routes.length) break;
      }catch(e){ etaFail(e); }
    }
  }
  if(!routes.length) return [];        // 內建與 API 都沒有 → 不必再打到站
  const uniq = [...new Map(routes.map(r=>[r.route+'|'+r.dir, r])).values()].slice(0,20);
  const out = await pool(uniq, 6, async r=>{
    LAST_RAW.attempted++;
    try{
      const j = await getJSON(EP.ctbEta(stopId, r.route), {timeout:12000});
      etaSnap(j);
      let arr = asArray(pick(j,'data'));
      // 依 hkbus 用法：先篩方向，再取站序最接近者（資料未必 100% 相符）
      if(r.dir){
        const f = arr.filter(x=> !x.dir || String(x.dir)===String(r.dir));
        if(f.length) arr = f;
      }
      if(Number.isFinite(+r.seq) && +r.seq > 0){
        const seq = +r.seq;
        const withSeq = arr.filter(x=>Number.isFinite(+x.seq));
        if(withSeq.length){
          const exact = withSeq.filter(x=>+x.seq === seq);
          if(exact.length) arr = exact;
          else{
            withSeq.sort((a,b)=>Math.abs(+a.seq-seq)-Math.abs(+b.seq-seq));
            const near = +withSeq[0].seq;
            arr = withSeq.filter(x=>+x.seq === near);
          }
        }
      }
      // 取最快的一班
      const withTime = arr.filter(x=>pick(x,'eta'));
      const d = (withTime.length? withTime : arr)
        .slice().sort((a,b)=>(minsTo(a.eta) ?? 9999)-(minsTo(b.eta) ?? 9999))[0];
      if(!d) return null;
      return {route:r.route, min: minsTo(d.eta), iso:d.eta||null, dest:d.dest_tc||'', rmk:d.rmk_tc||''};
    }catch(e){ etaFail(e); return null; }
  });
  return out.filter(Boolean);
}
/* 小巴到站回應有兩種嵌套：
   /eta/stop/{stop}  → data:[{route_id, route_seq, enabled, eta:[{diff,timestamp,remarks_tc}]}]
   /stop-eta/{stop}  → data:[{route_id, eta:[…]}] 或扁平 ETA 陣列 */
/* seq / bound 有值時才篩選：小巴到站 API 一次回傳整條路線所有站的班次，
   不篩選就會拿別站的時間當成這一站的（這是之前最主要的錯誤來源）。
   依 hkbus 官方用法：route_seq 1=去程(O) 2=回程(I)，stop_seq = 站序+1 */
function gmbEtaRows(j, seq, bound, defRoute, defDest){
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
      /* 官方到站回應沒有目的地欄位，只有 description_tc（路線描述）。
         把它當目的地會顯示成「往 屯門碼頭 - 上水站」這種奇怪的東西，
         甚至拿不到時整欄空白。hkbus 的做法是 dest 留空、description_tc 當備註，
         目的地則由路線表提供——這裡改為由呼叫端傳入內建資料的目的地。 */
      let rmk = pick(t,'remarks_tc') || pick(e,'remarks_tc') || '';
      if(e.enabled===false || String(e.enabled)==='0'){
        rmk = pick(e,'description_tc') || '服務暫停';
      } else if(!rmk){
        const d = pick(e,'description_tc') || pick(t,'description_tc');
        if(d && d !== defDest) rmk = d;
      }
      out.push({route, min, iso, dest: defDest || '', rmk});
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
/* ---------- 九巴／龍運到站 ----------
   參考 hkbus/hk-bus-eta（GitHub）的官方用法改寫。原本的寫法有兩個致命錯誤：
     1) 直接用 stop-eta 的 eta[0]；該端點在某些站會對全部路線回傳 eta:null，
        導致整頁「暫無班次」——但改查逐路線端點其實是有班次的。
     2) 逐路線端點一次回傳該站「所有方向、所有站序」的班次，
        必須篩 dir（方向）與 seq（站序），否則會拿到反方向或鄰站的時間。 */
function kmbPickEta(data, it){
  let arr = data.slice();
  const dir = it.bound ? String(it.bound) : '';
  if(dir){
    const f = arr.filter(e=>{ const d = pick(e,'dir','bound'); return !d || String(d)===dir; });
    if(f.length) arr = f;                                  // 沒方向欄位時不篩
  }
  const seq = Number(it.seq);
  const withSeq = arr.filter(e=>Number.isFinite(Number(pick(e,'seq'))));
  if(withSeq.length && Number.isFinite(seq) && seq>0){
    const exact = withSeq.filter(e=>Number(pick(e,'seq')) === seq);
    if(exact.length) return exact;                         // 站序完全相符（最可靠）
    withSeq.sort((a,b)=> Math.abs(Number(pick(a,'seq'))-seq) - Math.abs(Number(pick(b,'seq'))-seq));
    const near = Number(pick(withSeq[0],'seq'));
    return withSeq.filter(e=>Number(pick(e,'seq')) === near);
  }
  return arr;
}
async function kmbRouteEta(stopId, it){
  /* service_type 是必要參數。整站端點的回應不一定給這個欄位，
     缺了會組出 .../265M/undefined 這種網址而查不到班次，
     看起來就像「整站都沒車」。hkbus 一律帶入路線的 serviceType，這裡比照辦理，
     並在第一次查不到時改試 1（最常見的服務類型）。 */
  let st = Number(it.service_type);
  if(!Number.isFinite(st) || st < 1) st = 1;
  const tries = st === 1 ? [1] : [st, 1];
  for(const s of tries){
    let j;
    try{ j = await getJSON(EP.kmbEta(stopId, it.route, s), {timeout:12000}); }
    catch(e){ continue; }
    etaSnap(j);
    const data = asArray(pick(j,'data'));
    if(!data.length) continue;
    const cand = kmbPickEta(data, it);
    if(!cand.length) continue;
    let e = null;
    for(const c of cand){ const r = kmbEtaOf(c); if(r.min!==null){ e = r; break; }
                          if(!e) e = r; }
    if(e && e.min!==null)
      return {route:it.route, bound:it.bound, min:e.min, iso:e.iso,
              dest: e.dest || routeDest('KMB', it.route, it.bound) || '',
              rmk: e.rmk || ''};
  }
  return null;
}
async function kmbStopEta(id){
  let rows = [];
  try{
    const j = await getJSON(EP.kmbStopEta(id), {timeout:15000});
    LAST_RAW.kmb = j; LAST_RAW.kmbErr = null;
    etaSnap(j);
    rows = asArray(pick(j,'data')).map(d=>{
      const e = kmbEtaOf(d);
      return {route:pick(d,'route'),
              // 方向欄位：stop-eta 用 bound，逐路線端點用 dir，兩個都試
              bound:String(pick(d,'bound','dir') || ''),
              service_type:pick(d,'service_type'),
              min: e.min, iso: e.iso, dest: e.dest, rmk: e.rmk};
    }).filter(r=>r.route);
  }catch(e){
    LAST_RAW.kmbErr = String((e && e.message) || e);
    etaFail(e);
  }

  const idx = D.KMB.routesAtStop?.get(String(id)) || [];
  /* 統一路線清單。
     注意：不能只靠 idx——若 route-stop 索引尚未建立完成（檔案很大），
     idx 會是空的，舊程式在此直接 return，完全跳過班次表推算，
     畫面就只剩一排「暫無班次」。live 回應本身已帶 route 與 dir，足以推算。 */
  const list = [];
  const push = (route, bound, st, seq, live)=>{
    const k = String(route)+'|'+(bound||'');
    if(list.some(x=>x.k===k)) return;
    list.push({k, route, bound, service_type:st, seq, live});
  };
  for(const r of rows) push(r.route, r.bound, r.service_type, undefined, r);
  for(const it of idx){
    if(!rows.length){ push(it.route, it.bound, it.service_type, it.seq, null); continue; }
    const m = rows.find(r=>String(r.route)===String(it.route) &&
                            (!r.bound || String(r.bound)===String(it.bound||'')));
    if(!m) push(it.route, it.bound, it.service_type, it.seq, null);
  }
  if(!list.length) return rows;

  // 逐路線端點重查沒拿到時間的路線（官方用法：需篩方向與站序）
  const need = list.filter(x=> !(x.live && x.live.min!==null && x.live.min!==undefined)).slice(0,20);
  let fixed = [];
  if(need.length){
    const got = await pool(need, 5, async it=>{
      LAST_RAW.attempted++;
      try{ return await kmbRouteEta(id, it); }
      catch(e){ etaFail(e); return null; }
    });
    fixed = got.filter(Boolean);
  }

  return list.map(x=>{
    const f = fixed.find(y=>String(y.route)===String(x.route)
                          && (!x.bound || !y.bound || String(y.bound)===String(x.bound)));
    let r = Object.assign({route:x.route, dest:'', rmk:'', iso:null}, x.live||{});
    if(f && (r.min===null || r.min===undefined)) r = Object.assign({}, r, f);
    r.route = x.route;
    if(!r.dest) r.dest = routeDest('KMB', x.route, x.bound) || '';
    r.min = toMin(r.min);
    if(r.min===null || r.min===undefined){
      // 實時 API 真的沒資料 → 退回班次表推算（GitHub 開放資料）
      const m = kmbTimetableNext(x.route, x.bound, x.seq);
      if(m!==null) return {route:x.route, min:m, iso:null, dest:r.dest, rmk:r.rmk, sched:true};
    }
    return r;
  });
}

async function gmbStopEta(stopId){
  // 1) 優先用內建資料：已知每條路線的 gtfsId 與站序，一次就查對
  const built = (D.GMB.routesAtStop?.get(String(stopId))||[]).filter(x=>x.gtfs).slice(0,12);
  if(built.length){
    const got = await pool(built, 4, async it=>{
      LAST_RAW.attempted++;
      const dest = gmbRouteDest(it.route, it.bound);
      try{
        const j = await getJSON(EP.gmbEta(it.gtfs, stopId), {timeout:12000, tries:proxyOrder().slice(0,2)});
        etaSnap(j);
        return gmbRowsWithDest(j, it.seq, it.bound, it.route, dest)[0] || null;
      }catch(e){ etaFail(e); }
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
    const dest = gmbRouteDest(r.id, '');
    for(const rid of [r.gtfs, r.id]){
      if(!rid) continue;
      for(const u of EP.gmbEtaAlts(rid, stopId)){
        try{
          const j = await getJSON(u, {timeout:12000, tries:proxyOrder().slice(0,2)});
          return gmbRowsWithDest(j, undefined, '', r.id, dest)[0] || null;
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
    LAST_RAW.attempted++;
    try{
      const j = await getJSON(EP.nlbEta(r.id, stopId), {timeout:12000});
      etaSnap(j);
      const arr = asArray(pick(j,'estimatedArrivals','data')).filter(x=>pick(x,'estimatedArrivalTime'));
      const a = arr[0];
      if(!a){
        // 官方在無班次時會回傳 message（如「此路線暫停服務」）
        const msg = pick(j,'message');
        return msg ? {route:r.route, min:null, iso:null, dest:'', rmk:String(msg)} : null;
      }
      const t = String(pick(a,'estimatedArrivalTime')).replace(' ', 'T');
      return {route:r.route, min: a.departed?0:minsTo(t), iso:t||null,
              dest: pick(a,'routeVariantName')||'',
              rmk: (a.departed!=='1' || a.noGPS==='1') ? '預定班次' : ''};
    }catch(e){ etaFail(e); return null; }
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
    if(co==='LRT'){
      if(!D.LRT.ready) await loadLrt();
      await renderLrtRoute(co, route);
    }
    else if(co==='KMB')  await renderKmbRoute(co, route);
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
/* 診斷分兩段：
   ① 內建資料（GitHub 開放資料）— 不需連網，直接看載入狀態
   ② 實時到站 API — 非連網不可，這才是真正會影響使用的項目
   舊版把兩者混在一起，還去測根本不存在的端點
   （例如城巴／小巴都沒有「全部車站清單」這種 API），
   於是出現一堆 401／404 的紅字，看起來像壞掉，其實不影響使用。 */
const EMB_STATUS = [
  ['九巴',      'KMB',  false],   // 九巴站數多（約 6000），仍走官方 API
  ['城巴',      'CTB',  true ],
  ['專線小巴',  'GMB',  true ],
  ['嶼巴',      'NLB',  true ],
  ['港鐵巴士',  'MTRB', true ],
  ['港鐵重鐵',  'MTR',  true ],
  ['輕鐵',      'LRT',  true ],
  ['渡輪',      'FERRY',true ],
];
/* 實時到站：每家給一組真實存在的站號與路線。
   這些端點都經 GitHub 上 hkbus/hk-bus-eta 的官方用法確認。 */
const DIAG = [
  ['九巴到站',   'KMB',  EP.kmbEta('A3ADFCDF8487ADB9','1A',1)],
  ['城巴到站',   'CTB',  EP.ctbEta('001027','1')],
  ['小巴到站',   'GMB',  EP.gmbEta('2006408','20014492')],
  ['嶼巴到站',   'NLB',  EP.nlbEta('1','1')],
  ['港鐵班次',   'MTR',  EP.mtrSchedAlts('TWL','CEN')[0]],
  /* 輕鐵：站號格式在官方文件與實務間不一致（001 / 1 / 010），
     診斷時逐一嘗試，並回報哪一種有資料 */
  ['輕鐵到站',   'LRT',  ['001','1','10','920']],
];
/* ============================================================
   資料校驗：車站上的路線是否正確、座標是否合理、站序是否可展開。
   這些問題不會讓程式崩潰，但會讓功能「靜靜地不好用」——
   例如某站的索引缺了兩條路線，就永遠查不到那兩條的到站時間，
   畫面上看起來只是「那條路線沒車」，很難察覺是資料錯了。
   這裡全部在本地檢查（零請求），最後一項才實際打 API 抽樣比對。
   ============================================================ */
const HK_BOUNDS = {laMin:22.14, laMax:22.59, loMin:113.80, loMax:114.48};
function auditOperator(co){
  const d = D[co] || {};
  const stops = d.stop || [];
  const routes = d.route || [];
  const r = {co, stops:stops.length, routes:routes.length, issues:[], ok:true};

  // 1) 座標：超出香港範圍 → 「附近」與點對點規劃都會算錯
  let badGeo = 0, noGeo = 0;
  for(const s of stops){
    if(!isFinite(s.lat) || !isFinite(s.lng)){ noGeo++; continue; }
    if(s.lat < HK_BOUNDS.laMin || s.lat > HK_BOUNDS.laMax ||
       s.lng < HK_BOUNDS.loMin || s.lng > HK_BOUNDS.loMax) badGeo++;
  }
  if(badGeo) { r.issues.push(`${badGeo} 站座標超出香港範圍`); r.ok = false; }
  if(noGeo)  { r.issues.push(`${noGeo} 站沒有座標`); }

  // 2) 空站名
  const noName = stops.filter(s=>!s.tc || !String(s.tc).trim()).length;
  if(noName){ r.issues.push(`${noName} 站沒有站名`); r.ok = false; }

  // 3) 重複站號：會讓索引彼此覆蓋，該站的資料不完整
  if(stops.length){
    const seen = new Set(); let dup = 0;
    for(const s of stops){ const k = String(s.id); if(seen.has(k)) dup++; else seen.add(k); }
    if(dup){ r.issues.push(`${dup} 個重複站號`); r.ok = false; }
  }

  // 4) 車站→路線索引：這是「車站上有哪些路線」的依據
  const atStop = d.routesAtStop;
  let withRt = 0, totalRt = 0, noRt = 0;
  if(atStop && atStop.size){
    for(const [, arr] of atStop){ if(arr && arr.length){ withRt++; totalRt += arr.length; } else noRt++; }
    r.idxStops  = withRt;
    r.avgRoutes = withRt ? +(totalRt/withRt).toFixed(1) : 0;
    // 有車站卻幾乎都查不到路線 → 索引可能沒建立
    if(stops.length && withRt === 0){ r.issues.push('查不到任何車站的路線'); r.ok = false; }
    else if(stops.length && withRt < stops.length*0.5){
      r.issues.push(`僅 ${withRt}/${stops.length} 站查得到路線`);
      r.ok = false;
    }
  } else if(stops.length){
    r.issues.push('沒有建立「車站→路線」索引'); r.ok = false;
  }

  // 5) 路線缺終點：會顯示成「往 —」
  //    輕鐵屬環狀／雙向，本來就沒有單一終點（目的地由到站 API 提供），不列入
  if(routes.length && co!=='LRT' && co!=='MTR'){
    const noDest = routes.filter(x=>!x.dest && !x.orig).length;
    if(noDest) r.issues.push(`${noDest}/${routes.length} 條路線缺終點（可能顯示「往 —」）`);
  }

  // 6) 路線缺站序：點路線進去看不到站序表。
  //    站序不一定存在 route 物件裡——港鐵在 MTR_LINES、
  //    輕鐵／嶼巴可由「車站→路線」索引反查，所以要逐一確認而不是只看 stops 欄位。
  if(routes.length){
    // 先建立「路線 → 站數」的反查表
    const routeStops = new Map();
    if(atStop) for(const [, arr] of atStop)
      for(const x of (arr||[])){
        const k = String(x.route);
        if(!routeStops.has(k)) routeStops.set(k, new Set());
        if(x.seq !== undefined || x.stop) routeStops.get(k).add(String(x.seq ?? x.stop));
      }
    let noSeq = 0;
    for(const x of routes){
      const key = String(x.route);
      let has = false;
      if(x.stops && x.stops.length) has = true;
      else if(d.routeMap?.get(key)?.stops?.length) has = true;
      else if((routeStops.get(key)?.size || 0) >= 2) has = true;
      else if(co === 'MTR'){
        // 港鐵：站序在 MTR_LINES
        const ln = (typeof MTR_LINES!=='undefined' ? MTR_LINES : []).find(l=>l.code===key);
        if(ln && ln.st && ln.st.length) has = true;
      }
      if(!has) noSeq++;
    }
    if(noSeq && co!=='FERRY') r.issues.push(`${noSeq}/${routes.length} 條路線沒有站序資料`);
  }

  // 7) 路線號重複（同一路線號有多個方向是正常的，只看是否異常多）
  if(routes.length){
    const m = new Map();
    for(const x of routes) m.set(String(x.route), (m.get(String(x.route))||0)+1);
    const dupR = [...m.values()].filter(v=>v>8).length;
    if(dupR) r.issues.push(`${dupR} 個路線號有超過 8 個方向（可能重複）`);
  }
  return r;
}
function auditAll(){
  return ['KMB','CTB','GMB','NLB','MTRB','MTR','LRT','FERRY'].map(auditOperator);
}

/* 抽樣比對：拿官方到站 API 實際查得到哪些路線，
   與「內建索引說這站有哪些路線」比對。
   兩邊不符就是資料有問題：
     - 索引有、API 沒有 → 可能已停駛或改道（多半無害）
     - API 有、索引沒有 → 那條路線永遠查不到，屬真正的缺漏 */
async function auditSample(co){
  const d = D[co] || {};
  const out = {co, sampled:0, agree:0, onlyIdx:[], onlyApi:[], err:null};
  if(!d.routesAtStop || !d.routesAtStop.size) { out.err = '無索引'; return out; }
  // 挑有較多路線的站來測（資料豐富才比得出東西）
  const cands = [...d.routesAtStop.entries()]
    .filter(([,arr])=>arr && arr.length>=3)
    .sort((a,b)=>b[1].length-a[1].length)
    .slice(0, 10);
  if(!cands.length){ out.err = '找不到適合的站'; return out; }
  // 隨機取 2 個，避免每次都打同一站
  const picks = cands.sort(()=>Math.random()-0.5).slice(0, 2);
  for(const [sid, arr] of picks){
    let rows = [];
    try{ rows = await fetchEtaRows(co, sid); }
    catch(e){ out.err = out.err || e.message; continue; }
    out.sampled++;
    const idxSet = new Set(arr.map(x=>String(x.route)));
    const apiSet = new Set((rows||[]).map(x=>String(x.route)).filter(Boolean));
    if(!apiSet.size) continue;
    let same = 0;
    for(const r of apiSet) if(idxSet.has(r)) same++;
    out.agree += same / apiSet.size;
    for(const r of idxSet) if(!apiSet.has(r)) out.onlyIdx.push(String(r));
    for(const r of apiSet) if(!idxSet.has(r)) out.onlyApi.push(String(r));
  }
  out.onlyIdx = [...new Set(out.onlyIdx)].slice(0,8);
  out.onlyApi = [...new Set(out.onlyApi)].slice(0,8);
  if(out.sampled) out.agree = Math.round(out.agree / out.sampled * 100);
  return out;
}

/* 資料筆數（陣列長度／物件鍵數） */
function diagCount(j){
  if(!j || typeof j!=='object') return 0;
  const a = plainArr(j);
  if(a.length) return a.length;
  if(j.data && typeof j.data==='object' && !Array.isArray(j.data)) return Object.keys(j.data).length;
  return 0;
}
/* 真正「有到站時間」的筆數。
   到站 API 常回傳多筆但 eta 全為 null（非服務時段、參數不對…），
   只看筆數會把這種情況誤判成正常。 */
function diagEtaCount(j){
  const a = plainArr(j);
  if(!a.length) return 0;
  let n = 0;
  for(const e of a){
    if(!e || typeof e!=='object') continue;
    const t = pick(e,'eta','timestamp','estimatedArrivalTime');
    if(t && String(t).trim() && String(t) !== 'null') n++;
    else if(Number.isFinite(+pick(e,'diff','diff_min','ttnt'))) n++;
  }
  return n;
}
function auditRow(a){
  const name = CO_NAME[a.co] || a.co;
  if(!a.stops && !a.routes)
    return `<tr><td>${esc(name)} <span class="tiny muted">未載入</span></td>
      <td class="bad">✗ 無資料</td></tr>`;
  const stat = a.ok ? 'ok' : 'bad';
  const txt  = a.ok ? '✓ 正常' : '⚠ 有問題';
  const detail = a.issues.length ? esc(a.issues.join('；'))
               : `${a.idxStops? a.idxStops+' 站有路線資料':'—'}${a.avgRoutes? ` · 平均 ${a.avgRoutes} 條/站`:''}`;
  return `<tr><td>${esc(name)} <span class="tiny muted">${a.stops} 站 · ${a.routes} 路線</span></td>
    <td class="${stat}">${txt} <span class="tiny muted">${detail}</span></td></tr>`;
}

/* 抽查：實際打 API 比對索引 */
$('#auditBtn').onclick = async ()=>{
  const t = $('#diagTable');
  const btn = $('#auditBtn');
  btn.disabled = true;
  t.innerHTML = '<tr><td colspan="2"><span class="spin"></span> 正在抽查（每個營辦商取 2 站，需連網）…</td></tr>';
  const cos = ['KMB','CTB','GMB','NLB','MTRB','MTR','LRT'];
  const rows = ['<tr><td colspan="2" class="tiny muted" style="padding-top:8px">索引正確性抽查</td></tr>'];
  let bad = 0;
  for(const co of cos){
    const a = await auditSample(co).catch(()=>({co, err:'例外', sampled:0}));
    const name = CO_NAME[co] || co;
    if(!a.sampled){
      rows.push(`<tr><td>${esc(name)}</td><td class="warn">— 略過 <span class="tiny muted">${esc(a.err||'無法抽查')}</span></td></tr>`);
    } else if(a.onlyApi.length){
      bad++;
      rows.push(`<tr><td>${esc(name)} <span class="tiny muted">抽查 ${a.sampled} 站 · 吻合 ${a.agree}%</span></td>
        <td class="bad">✗ 索引缺 ${a.onlyApi.length} 條 <span class="tiny muted">${esc(a.onlyApi.join('、'))}</span></td></tr>`);
    } else {
      rows.push(`<tr><td>${esc(name)} <span class="tiny muted">抽查 ${a.sampled} 站</span></td>
        <td class="ok">✓ 吻合 ${a.agree}% ${a.onlyIdx.length?`<span class="tiny muted">（索引多出：${esc(a.onlyIdx.join('、'))}）</span>`:''}</td></tr>`);
    }
    t.innerHTML = rows.join('');
  }
  rows.push(`<tr><td colspan="2" class="tiny muted" style="padding-top:8px">${
    bad ? `有 ${bad} 家索引與官方資料不符，缺漏的路線會查不到到站時間。`
        : '各家索引與官方資料大致相符。'}</td></tr>`);
  t.innerHTML = rows.join('');
  btn.disabled = false;
};

function embRow(name, key, embedded){
  const d = D[key] || {};
  const ns = (d.stop||[]).length, nr = (d.route||[]).length;
  const ready = !!(ns || nr);
  const cls = ready ? 'ok' : 'bad';
  const src = embedded ? '內建' : '官方 API';
  const txt = ready ? '✓ 已載入' : '✗ 未載入';
  return `<tr><td>${esc(name)} <span class="tiny muted">${src}</span></td>
    <td class="${cls}">${txt} <span class="tiny muted">${ns? ns+' 站':'—'} ${nr? '· '+nr+' 路線':''}</span></td></tr>`;
}
$('#diagBtn').onclick = async ()=>{
  const t = $('#diagTable'); t.innerHTML='<tr><td colspan="2"><span class="spin"></span> 測試中…</td></tr>';
  const rows = [];

  // ① 內建資料
  rows.push('<tr><td colspan="2" class="tiny muted" style="padding-top:8px">車站／路線資料</td></tr>');
  let embBad = 0;
  for(const [name, key, embedded] of EMB_STATUS){
    rows.push(embRow(name, key, embedded));
    const d = D[key] || {};
    if(!((d.stop||[]).length || (d.route||[]).length)) embBad++;
  }
  t.innerHTML = rows.join('');

  // ② 實時到站
  rows.push('<tr><td colspan="2" class="tiny muted" style="padding-top:12px">實時到站（需連網）</td></tr>');
  let vitalOk = 0, vitalBad = 0;
  for(const [name, key, url] of DIAG){
    let ok=false, note='', n=0;
    const t0=performance.now();
    const ms = ()=>Math.round(performance.now()-t0);
    // 輕鐵：多編號嘗試（陣列＝候選清單）
    if(Array.isArray(url) && key==='LRT'){
      let hitId=null, raw=null;
      for(const id of url){
        try{
          const j = await getJSON(EP.lrtEta(id),{timeout:15000});
          const c = diagCount(j);
          if(c>0){ n=c; ok=true; hitId=id; break; }
          if(!raw) raw = JSON.stringify(j||{}).slice(0,80);
        }catch(e){ if(!raw) raw = 'ERR:'+e.message; }
      }
      note = ok ? `${ms()}ms · ${LAST_PROXY} · station_id=${hitId} · ${n} 筆`
                : `${ms()}ms · ${LAST_PROXY} · 全部編號皆無資料 · 原始回應：${raw||'（空）'}`;
    } else {
    try{
      const j = await getJSON(url,{timeout:15000});
      n = diagCount(j);
      ok = n>0;
      // 連得到卻沒資料時，把原始回應攤開，方便判斷是端點還是格式問題
      note = `${ms()}ms · ${LAST_PROXY} · ${ok?n+' 筆':'回應為空 · 原始回應：'+(JSON.stringify(j||{}).slice(0,80)||'（空）')}`;
    }catch(e){
      // 港鐵有鏡像備援，主端點失敗時再試鏡像
      if(key==='MTR'){
        try{
          const j = await getJSON(EP.mtrSchedMirror('TWL','CEN'),{timeout:15000});
          n = diagCount(j); ok = n>0;
          note = `官方失敗，改用鏡像 · ${ok?n+' 筆':'鏡像也無資料'}`;
        }catch(e2){ note = e.message; }
      } else note = e.message;
    }
    }
    if(ok) vitalOk++; else vitalBad++;
    rows.push(`<tr><td>${esc(name)}</td>
      <td class="${ok?'ok':'bad'}">${ok?'✓ 正常':'✗ 異常'} <span class="tiny muted">${esc(note)}</span></td></tr>`);
    t.innerHTML = rows.join('');
  }
  // ③ 資料校驗（純本地、零請求）
  rows.push('<tr><td colspan="2" class="tiny muted" style="padding-top:12px">資料校驗（本地檢查，不需連網）</td></tr>');
  const aud = auditAll();
  let audBad = 0;
  for(const a of aud){ rows.push(auditRow(a)); if(!a.ok) audBad++; }
  t.innerHTML = rows.join('');

  const tail = vitalOk
    ? `<span class="ok">${vitalOk} 個營辦商的實時到站可用${vitalBad?`，${vitalBad} 個失敗`:''}。</span>`
    : `<span class="bad">實時到站全部無法連上（可能為 CORS 或網路問題）。</span>`;
  $('#diagSummary').innerHTML = `目前使用：<b>${esc(LAST_PROXY)}</b>　（失敗時會自動切換備援通道）<br>${tail}
    ${audBad? `<span class="bad">資料校驗發現 ${audBad} 家有問題（見下方）。</span>`
             : '<span class="ok">資料校驗全部通過。</span>'}
    <div class="tiny muted" style="margin-top:4px">
    車站與路線已改為 GitHub 開放資料內建，不需要連網；上方「實時到站」才是需要連網的部分。
    若整排失敗且錯誤含 CORS，請到「設定」切換代理通道。<br>
    想確認「某站列出的路線是否正確」，可按「抽查索引正確性」實際比對官方資料。</div>`;
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
const nes = $('#nearEtaSel');
if(nes){
  nes.value = String(SETTINGS.nearEta ?? 1);
  nes.onchange = e=>{ SETTINGS.nearEta = +e.target.value; saveSettings();
                      if(SETTINGS.nearEta) fillNearEtas(); else renderNearBox(); };
}
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
  /* 離開分頁時停掉該分頁的輪詢。
     原本計時器只在「再次開啟同類資料」時才被清除，
     於是從港鐵分頁切走後，mtrTimer 仍每 20 秒打一次 API——
     背景持續消耗流量與電量，也可能觸發限速。 */
  if(activeTab && activeTab!==name){
    if(activeTab==='mtr'){ clearInterval(mtrTimer); mtrTimer=null; }
    if(activeTab==='stop'){ clearInterval(etaTimer); etaTimer=null; }
  }
  activeTab = name;
  $$('#tabs button').forEach(b=>b.setAttribute('aria-selected', b.dataset.tab===name));
  ['stop','route','mtr','plan','more'].forEach(n=>{
    document.getElementById('tab-'+n).classList.toggle('hidden', n!==name);
  });
  if(name==='plan'){ initMap(); setTimeout(()=>map&&map.invalidateSize(),80); }
  if(name==='stop' && autoNearbyPending && busDataLoaded){ autoNearbyPending=false; autoNearbyOnce(); }
  /* 回到分頁時恢復輪詢（並順便補一次最新資料） */
  if(name==='stop' && curStop){
    restartEtaTimer();
    fetchStopEta();
  }
  if(name==='mtr' && curMtr){
    if(!mtrTimer) mtrTimer = setInterval(()=>fetchMtrBoard(curMtr.line, curMtr.sta), 20000);
    fetchMtrBoard(curMtr.line, curMtr.sta);
  }
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
// 城巴／嶼巴：站→路線索引改為內建（零請求），車站資料作為 API 失敗時的備援
Promise.resolve(loadCtbEmbedded()).catch(()=>{});
Promise.resolve(loadNlbEmbedded()).catch(()=>{});
// 九巴班次表：到站 API 掛掉時的備援（非同步，不阻塞主流程）
(async()=>{ try{ const t = await gunzipB64(EMB_KMB_FREQ); if(t) kmbFreqLoad(t); }catch(e){} })();
(async()=>{ try{ const t = await gunzipB64(EMB_KMB_JT);   if(t) kmbJtLoad(t);   }catch(e){} })();
let _lrtSeqP = null;
function lrtSeqEnsure(){
  if(LRT_SEQ.ready) return Promise.resolve(true);
  if(!_lrtSeqP) _lrtSeqP = gunzipB64(EMB_LRT_SEQ).then(t=>{ if(t) lrtSeqLoad(t); }).catch(()=>{});
  return _lrtSeqP;
}
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
    `<div class="tiny muted" style="margin-top:3px">小巴／港鐵巴士／城巴／嶼巴／輕鐵／重鐵／渡輪的車站與路線為內建資料（GitHub 開放資料），不必連網。渡輪無實時到站，顯示為時刻表推算之下一班；九巴在實時 API 無資料時會依班次表推算（已計入估計行車時間）。${
      skippedSteps.length? `<br>已略過 ${skippedSteps.length} 個非必要 API：${esc(skippedSteps.join('、'))}（改由內建資料提供）`:''}</div>`;
  if(!ok.length){
    el.innerHTML += `<div class="banner err" style="margin-top:8px">
      ⚠️ 所有資料來源都連不上。請到「更多 → 連線診斷」查看原因；若顯示 CORS 相關錯誤，
      可在「更多 → 設定 → 網路模式」改用代理通道。</div>`;
  }
}
