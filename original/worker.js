// 将常量定义放在顶部
const MOJANG_API = 'https://api.mojang.com';
const SESSION_API = 'https://sessionserver.mojang.com';
const MINECRAFT_SERVICES_API = 'https://api.minecraftservices.com';

// 路径映射配置
const PATH_PREFIXES = {
  '/api-mojang': MOJANG_API,
  '/session-mojang': SESSION_API, 
  '/api-minecraft': MINECRAFT_SERVICES_API,
};

// 白名单域名
const ALLOWED_ORIGINS = ['*'];

function getCorsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin) 
    ? origin || '*'
    : ALLOWED_ORIGINS[0];
  
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Expose-Headers': '*',
    'Vary': 'Origin'
  };
}

function handleCorsPreflight(request) {
  const origin = request.headers.get('Origin');
  
  return new Response(null, {
    status: 204,
    headers: {
      ...getCorsHeaders(origin),
      'Access-Control-Max-Age': '86400',
      'Content-Length': '0'
    }
  });
}

// ES 模块格式的导出
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    
    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
      return handleCorsPreflight(request);
    }
    
    // 查找匹配的 API 端点
    let targetBaseUrl = null;
    let apiPath = null;
    
    for (const [prefix, baseUrl] of Object.entries(PATH_PREFIXES)) {
      if (url.pathname.startsWith(prefix)) {
        targetBaseUrl = baseUrl;
        apiPath = url.pathname.slice(prefix.length) || '/';
        break;
      }
    }
    
    // 如果没有匹配的路径，返回 404
    if (!targetBaseUrl) {
      return new Response('Not Found: Available endpoints: ' + Object.keys(PATH_PREFIXES).join(', '), {
        status: 404,
        headers: getCorsHeaders(origin)
      });
    }
    
    // 构建目标 URL
    const targetUrl = new URL(apiPath, targetBaseUrl);
    targetUrl.search = url.search;
    
    try {
      // 准备转发请求
      const headers = new Headers(request.headers);
      
      // 移除可能引起问题的请求头
      headers.delete('cf-connecting-ip');
      headers.delete('cf-ray');
      headers.delete('cf-visitor');
      headers.delete('cf-ipcountry');
      
      // 确保有 User-Agent
      if (!headers.has('User-Agent')) {
        headers.set('User-Agent', 'Minecraft-Auth-Proxy/1.0 (Cloudflare Workers)');
      }
      
      // 构建转发请求
      const proxyRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers: headers,
        body: request.body,
        redirect: 'follow'
      });
      
      // 发送请求到 Mojang API
      const response = await fetch(proxyRequest);
      
      // 创建响应并添加 CORS 头
      const responseBody = response.body;
      const responseHeaders = new Headers(response.headers);
      
      // 添加 CORS 头
      const corsHeaders = getCorsHeaders(origin);
      for (const [key, value] of Object.entries(corsHeaders)) {
        responseHeaders.set(key, value);
      }
      
      // 移除可能不需要的响应头
      responseHeaders.delete('content-security-policy');
      responseHeaders.delete('x-frame-options');
      
      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
      
    } catch (error) {
      console.error('Proxy error:', error);
      
      return new Response(`Proxy Error: ${error.message}`, {
        status: 502,
        headers: getCorsHeaders(origin)
      });
    }
  }
};