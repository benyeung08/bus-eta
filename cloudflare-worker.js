/**
 * Cloudflare Worker — CORS Proxy for Hong Kong Bus APIs
 * 
 * 使用方法：
 * 1. 前往 https://workers.cloudflare.com/ 註冊（免費，每日 10 萬次請求）
 * 2. 創建 Worker，貼上以下代碼
 * 3. 部署後得到 URL：https://bus-proxy.你的帳號.workers.dev
 * 4. 在瀏覽器 console 執行：
 *    localStorage.setItem('bus-proxy','https://bus-proxy.你的帳號.workers.dev')
 * 5. 重新整理頁面 — 所有 API 走代理，不再有 CORS 問題
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  
  // 從 ?url= 參數獲取目標 URL
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return new Response(JSON.stringify({
      error: 'Missing url parameter',
      usage: '?url=https://data.etabus.gov.hk/v1/transport/kmb/route/1A'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // 安全白名單：只允許政府/交通 API
  const allowedHosts = [
    'data.etabus.gov.hk',
    'rt.data.gov.hk',
    'data.weather.gov.hk',
    'rss.weather.gov.hk',
    'www.td.gov.hk',
    'www.kmb.hk'
  ];
  
  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }
  
  if (!allowedHosts.includes(parsedTarget.hostname)) {
    return new Response(JSON.stringify({ error: 'Host not allowed', host: parsedTarget.hostname }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 轉發請求（保留原始 headers）
  const headers = new Headers();
  headers.set('Accept', 'application/json');
  headers.set('User-Agent', 'HK-Bus-ETA-Proxy/1.0');

  try {
    const response = await fetch(targetTarget(targetUrl), {
      method: 'GET',
      headers,
      redirect: 'follow'
    });

    // 構建 CORS 友好的響應
    const corsHeaders = new Headers(response.headers);
    corsHeaders.set('Access-Control-Allow-Origin', '*');
    corsHeaders.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    corsHeaders.set('Access-Control-Allow-Headers', 'Content-Type');
    corsHeaders.set('Cache-Control', 'public, max-age=30'); // 30 秒緩存

    // 處理 OPTIONS 預檢
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    return new Response(response.body, {
      status: response.status,
      headers: corsHeaders
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Proxy fetch failed', detail: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

function targetTarget(urlStr) {
  return urlStr;
}
