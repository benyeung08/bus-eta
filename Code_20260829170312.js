/* 香港公共交通 ETA — 公司歸屬校驗 驗證套件
 * 用法: node verify.js
 * 驗證「不屬於龍運(LWB)的路線就不顯示龍運，並擴展至所有路線」 */
const fs = require('fs');
const html = fs.readFileSync('/data/workspace/hk-transit-eta.html', 'utf8');
const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
const code = blocks.map(m => m[1]).join('\n');

let ok = 0, fail = 0;
const A = (name, cond) => { if (cond) { ok++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name); } };

/* ==================== A. 架構 / 回歸掃描（20 項） ==================== */
console.log('\n[A] 架構與回歸掃描');
try { new Function(code); A('語法檢查', true); } catch (e) { A('語法檢查', false); }
A('跨公司並行查詢 KMB/CTB/LWB', /\['KMB','CTB','LWB'\]/.test(code));
A('去重複合 key（KMB:1A ≠ CTB:1A）', /const dedupKey = `\$\{c\}_\$\{k\}`/.test(code));
A('fetchCompanyETA 站序驗證', /validateStops && filtered\.length/.test(code));
A('效能：並發上限控制', /concurrencyLimit|CONC=/.test(code));
A('效能：_servesCache LRU 有界', /_servesCacheMax\s*=\s*\d+/.test(code));
A('效能：_routeStopsCache 有界 200', /_routeStopsCache\.size>200/.test(code));
A('小巴 Bug2 一致性判定', /guessGmbRoutesAtStop && guessGmbRoutesAtStop\(stopId\)/.test(code));
A('擴展全部車站（80 安全閥）', /MAX_NEARBY_STOPS\s*=\s*80/.test(code));
A('★ routeCompanyMatches 定義', /function routeCompanyMatches/.test(code));
A('★ KMB/LWB 站序保留 company 欄位', /company:\s*\(x\.company\|\|co\)/.test(code));
A('★ 入口1 fetchCompanyETA 公司校驗', code.includes('!routeCompanyMatches(i.route, useCo)'));
A('★ 入口2 candidateRoutes 即時快取公司校驗', /cached\.map\(async r=>\{[\s\S]{0,220}routeCompanyMatches\(r\.route, rco\)/.test(code));
A('★ 入口3 candidateRoutes 靜態兜底公司校驗', /staticChecks\.map\(async x=>\{[\s\S]{0,180}!routeCompanyMatches\(x\.route, x\.co\)/.test(code));
A('★ CTB/GMB 無可靠 company → 保守放行', /coKey==='CTB'\?true:/.test(code) || code.includes("if(coKey==='CTB'||coKey==='GMB')return true;"));
A('★ LWB 公司徽章橙色', /LWB:'bg-orange-500 text-white'/.test(code));

/* ==================== B. routeCompanyMatches 單元測試（6 項） ==================== */
console.log('\n[B] routeCompanyMatches 邏輯單元測試');
const fnMatch = code.match(/function routeCompanyMatches\(route, claimedCo\)\{[\s\S]*?\n    \}/);
const fnSrc = fnMatch[0];
const _routeStopsCache = new Map();
// 真實路線
_routeStopsCache.set('LWB_E33', { outbound:[{stop:'SS917',seq:1,company:'LWB'},{stop:'SS900',seq:2,company:'LWB'}], inbound:[{stop:'SS900',seq:1,company:'LWB'},{stop:'SS917',seq:2,company:'LWB'}] });
_routeStopsCache.set('KMB_1A',  { outbound:[{stop:'10001',seq:1,company:'KMB'},{stop:'10002',seq:2,company:'KMB'}], inbound:[{stop:'10002',seq:1,company:'KMB'},{stop:'10001',seq:2,company:'KMB'}] });
// ★ 交叉項：模擬 fetchRouteStopsCached 同時查過兩家公司站序（真實行為）
_routeStopsCache.set('LWB_1A',  { outbound:[{stop:'10001',seq:1,company:'KMB'},{stop:'10002',seq:2,company:'KMB'}], inbound:[{stop:'10002',seq:1,company:'KMB'},{stop:'10001',seq:2,company:'KMB'}] }); // 1A 實際是 KMB
_routeStopsCache.set('KMB_E33', { outbound:[{stop:'SS917',seq:1,company:'LWB'},{stop:'SS900',seq:2,company:'LWB'}], inbound:[{stop:'SS900',seq:1,company:'LWB'},{stop:'SS917',seq:2,company:'LWB'}] }); // E33 實際是 LWB
_routeStopsCache.set('LWB_S1',  { outbound:[{stop:'30001',seq:1,company:'KMB'},{stop:'30002',seq:2,company:'KMB'}], inbound:[] }); // S1 實際是 KMB
// CTB 無 company 欄位
_routeStopsCache.set('CTB_720', { outbound:[{stop:'20001',seq:1},{stop:'20002',seq:2}], inbound:[] });
const routeCompanyMatches = new Function('_routeStopsCache', `${fnSrc}\nreturn routeCompanyMatches;`)(_routeStopsCache);

A('① 真正 LWB 路線 E33 → 屬於龍運',       routeCompanyMatches('E33', 'LWB') === true);
A('② 真正 KMB 路線 1A → 屬於九巴',         routeCompanyMatches('1A', 'KMB') === true);
A('③ KMB:1A 被錯標為 LWB → 拒絕',          routeCompanyMatches('1A', 'LWB') === false);
A('④ LWB:E33 被錯標為 KMB → 拒絕',          routeCompanyMatches('E33', 'KMB') === false);
A('⑤ CTB 720（無 company）→ 保守放行',      routeCompanyMatches('720', 'CTB') === true);
A('⑥ 尚無站序資料 → 保守放行',              routeCompanyMatches('999', 'LWB') === true);

/* ==================== C. 三入口閘門整合推導 ==================== */
console.log('\n[C] 三入口閘門整合推導（海麗邨 SS917 場景）');
const liveRoutes = [
  {route:'1A', co:'KMB'},  // 真正 KMB ✓
  {route:'E33', co:'LWB'}, // 真正 LWB ✓
  {route:'1A', co:'LWB'},  // ★ 錯標 → 刪除
  {route:'S1',  co:'LWB'}, // ★ 錯標 → 刪除
  {route:'720', co:'CTB'}, // CTB 保守放行 ✓
];
const result = [];
for (const r of liveRoutes) {
  if (!routeCompanyMatches(r.route, r.co)) { result.push(`[刪除] ${r.co} ${r.route}`); continue; }
  result.push(`[保留] ${r.co} ${r.route}`);
}
result.forEach(s => console.log('     ', s));
A('閘門：保留 3 條（KMB:1A / LWB:E33 / CTB:720）', result.filter(s=>s.startsWith('[保留]')).length === 3);
A('閘門：刪除 2 條錯標 LWB（1A、S1）',           result.filter(s=>s.startsWith('[刪除]')).length === 2);

/* ==================== 結果 ==================== */
console.log(`\n=============================`);
console.log(`合計: ${ok} 通過, ${fail} 失敗`);
process.exit(fail ? 1 : 0);
