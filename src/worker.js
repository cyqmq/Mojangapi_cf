// ============================================================
// Minecraft Auth Proxy · Cloudflare Worker
// 将 Mojang / Minecraft 服务 API 反向代理并注入 CORS 头
//    /api-mojang     → https://api.mojang.com
//    /session-mojang → https://sessionserver.mojang.com
//    /api-minecraft  → https://api.minecraftservices.com
//    /status 或 /health → 各上游连通性与延迟、代理自身耗时
// ============================================================

const VERSION = '1.0.0';
const PROBE_TIMEOUT_MS = 5000;

// 常量定义放在顶部
const MOJANG_API = 'https://api.mojang.com';
const SESSION_API = 'https://sessionserver.mojang.com';
const MINECRAFT_SERVICES_API = 'https://api.minecraftservices.com';

// 路径映射配置
const PATH_PREFIXES = {
  '/api-mojang': MOJANG_API,
  '/session-mojang': SESSION_API,
  '/api-minecraft': MINECRAFT_SERVICES_API,
};

// 状态检测探针：每个上游用于测连通性/延迟的目标
const STATUS_PROBES = {
  '/api-mojang': { base: MOJANG_API, probe: '/' },
  '/session-mojang': { base: SESSION_API, probe: '/' },
  '/api-minecraft': { base: MINECRAFT_SERVICES_API, probe: '/' },
};

// 白名单域名
const ALLOWED_ORIGINS = ['*'];

function getCorsHeaders(origin) {
  const allowedOrigin =
    ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)
      ? origin || '*'
      : ALLOWED_ORIGINS[0];

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Expose-Headers': '*',
    Vary: 'Origin',
  };
}

function handleCorsPreflight(request) {
  const origin = request.headers.get('Origin');

  return new Response(null, {
    status: 204,
    headers: {
      ...getCorsHeaders(origin),
      'Access-Control-Max-Age': '86400',
      'Content-Length': '0',
    },
  });
}

// 探测单个上游：请求其探针 URL，测连通性与耗时
async function probeAvailability(name) {
  const { base, probe } = STATUS_PROBES[name];
  const url = new URL(probe || '/', base);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
    });
    // 尽快断开响应体，释放连接（探针只关心状态与耗时）
    if (res.body) await res.body.cancel();
    return {
      base,
      alive: true,
      status: res.status,
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    return {
      base,
      alive: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      error: isTimeout ? 'timeout' : error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      ...getCorsHeaders(null),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

// GET /status | /health —— 代理状态与各上游延迟
async function handleStatus() {
  const proxyStartedAt = Date.now();

  const entries = await Promise.all(
    Object.keys(STATUS_PROBES).map(async (name) => [name, await probeAvailability(name)]),
  );
  const endpoints = Object.fromEntries(entries);

  const probes = entries.map(([, result]) => result);
  const alive = probes.filter((r) => r.alive);
  const avgLatencyMs = alive.length
    ? Math.round(alive.reduce((sum, r) => sum + r.latencyMs, 0) / alive.length)
    : null;

  const payload = {
    service: 'minecraft-auth-proxy',
    version: VERSION,
    time: new Date().toISOString(),
    status: alive.length === 0 ? 'down' : alive.length === probes.length ? 'ok' : 'degraded',
    proxy: {
      // 代理本次处理（含所有探针网络往返）的总耗时
      latencyMs: Date.now() - proxyStartedAt,
    },
    upstream: endpoints,
    summary: {
      total: probes.length,
      alive: alive.length,
      down: probes.length - alive.length,
      avgLatencyMs,
    },
  };

  return jsonResponse(payload);
}

// 单个上游的轻量延迟信息（/ping 用）
async function handlePing() {
  const startedAt = Date.now();

  const entries = await Promise.all(
    Object.keys(STATUS_PROBES).map(async (name) => [name, await probeAvailability(name)]),
  );

  const alive = entries
    .filter(([, r]) => r.alive)
    .map(([, r]) => r.latencyMs);
  const upstream = Object.fromEntries(
    entries.map(([name, r]) => [
      name,
      { alive: r.alive, status: r.status, latencyMs: r.latencyMs, error: r.error },
    ]),
  );

  return jsonResponse({
    service: 'minecraft-auth-proxy',
    time: new Date().toISOString(),
    proxyLatencyMs: Date.now() - startedAt,
    avgUpstreamLatencyMs: alive.length
      ? Math.round(alive.reduce((sum, ms) => sum + ms, 0) / alive.length)
      : null,
    upstream,
  });
}

// ---- 状态徽章（SVG，可供 PCL2 主页等作为图片嵌入）----

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badgeColor(alive, latencyMs) {
  if (!alive) return '#e05d44'; // 红：不可达
  if (latencyMs < 300) return '#4c1'; // 亮绿：优
  if (latencyMs < 800) return '#97ca00'; // 黄绿：良
  if (latencyMs < 1500) return '#dfb317'; // 黄：一般
  return '#fe7d37'; // 橙：慢
}

function badgeWidth(text) {
  return Math.round(String(text).length * 7.1 + 10);
}

function badgeText(x, text, color) {
  const esc = escapeXml(text);
  return (
    `<text x="${x}" y="15" fill="#010101" fill-opacity=".3" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">${esc}</text>` +
    `<text x="${x}" y="14" fill="${color}" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">${esc}</text>`
  );
}

function buildBadge(segments) {
  const widths = segments.map((s) => ({ lw: badgeWidth(s.label), vw: badgeWidth(s.value) }));
  const total = widths.reduce((sum, w) => sum + w.lw + w.vw, 0);
  const aria = escapeXml(segments.map((s) => `${s.label}: ${s.value}`).join(' '));

  let cursor = 0;
  let rects = '';
  let texts = '';
  for (let i = 0; i < segments.length; i++) {
    const { lw, vw } = widths[i];
    const s = segments[i];
    rects += `<rect x="${cursor}" width="${lw}" height="20" fill="#555"/>`;
    rects += `<rect x="${cursor + lw}" width="${vw}" height="20" fill="${s.color}"/>`;
    texts += badgeText(cursor + lw / 2, s.label, '#fff');
    texts += badgeText(cursor + lw + vw / 2, s.value, '#fff');
    cursor += lw + vw;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${aria}">` +
    `<linearGradient id="s" x2="0" y2="100%">` +
    `<stop offset="0" stop-color="#fff" stop-opacity=".7"/><stop offset=".1" stop-opacity=".1"/>` +
    `</linearGradient>` +
    `<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)">${rects}<rect width="${total}" height="20" fill="url(#s)"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">${texts}</g>` +
    `</svg>`
  );
}

// 探测目标上游并整理成徽章段（label/value/color），供 SVG 与 PNG 共用
async function probeSegments(wanted) {
  const entries = await Promise.all(
    Object.keys(STATUS_PROBES).map(async (name) => [name, await probeAvailability(name)]),
  );
  const picked = wanted === 'all' ? entries : entries.filter(([name]) => name === wanted);

  return picked.map(([name, r]) => ({
    label: name,
    value: r.alive ? `${r.latencyMs}ms` : r.error === 'timeout' ? 'timeout' : 'down',
    color: badgeColor(r.alive, r.latencyMs),
  }));
}

// GET /badge —— 实时状态徽章（SVG），?p=all | /api-mojang | /session-mojang | /api-minecraft
async function handleBadge(url) {
  const wanted = url.searchParams.get('p') || 'all';
  const segments = await probeSegments(wanted);
  if (!segments.length) {
    segments.push({ label: 'badge', value: `unknown: ${wanted}`, color: '#9f9f9f' });
  }

  return new Response(buildBadge(segments), {
    status: 200,
    headers: {
      ...getCorsHeaders(null),
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

// ---- /badge.png —— 同一徽章的 PNG 版（PCL2 的 WPF 不支持 SVG，只能显示 PNG/JPEG）----
// 零依赖：内置 5x7 位图字体 + 手工 PNG 编码（zlib 由 Web CompressionStream 提供）

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BADGE_H = 20;
const GLYPH_W = 5;
const GLYPH_H = 7;
const GLYPH_ADV = 6;
const PAD_X = 5;

const PNG_COLORS = {
  '#4c1': [76, 204, 17],
  '#97ca00': [151, 202, 0],
  '#dfb317': [223, 179, 23],
  '#fe7d37': [254, 125, 55],
  '#e05d44': [224, 93, 68],
  '#555': [85, 85, 85],
  '#9f9f9f': [159, 159, 159],
};

function hexColor(hex) {
  return PNG_COLORS[hex] || PNG_COLORS['#555'];
}

function parseGlyph(rows) {
  const cols = new Array(GLYPH_W).fill(0);
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < GLYPH_W; x++) {
      if (rows[y][x] === '#') cols[x] |= 1 << (6 - y);
    }
  }
  return cols;
}

const FONT_ROWS = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#..', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '#....', '#....'],
  ':': ['.....', '..#..', '..#..', '.....', '..#..', '..#..', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

const PNG_FONT = {};
for (const [ch, rows] of Object.entries(FONT_ROWS)) {
  PNG_FONT[ch] = parseGlyph(rows);
}

function crc32(bytes) {
  let table = PNG_FONT._crc;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    PNG_FONT._crc = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(typeStr, data) {
  const out = new Uint8Array(data.length + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = typeStr.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlibDeflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encodePng(width, height, rgb) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB（PCL2/WPF 通用）
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', await zlibDeflate(rgb)),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function createCanvasRGB(width, height) {
  const rowStride = 1 + width * 3;
  const raw = new Uint8Array(rowStride * height);
  // 白色背景，同时把每行的 filter 字节设为 0（None）
  for (let y = 0; y < height; y++) {
    raw[y * rowStride] = 0; // filter byte
    const off = y * rowStride + 1;
    for (let x = 0; x < width; x++) {
      raw[off + x * 3] = 255;
      raw[off + x * 3 + 1] = 255;
      raw[off + x * 3 + 2] = 255;
    }
  }
  return raw;
}

function rgbAt(raw, width, x, y) {
  return y * (1 + width * 3) + 1 + x * 3;
}

function fillRectRGB(raw, width, x, y, w, h, color) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = rgbAt(raw, width, px, py);
      raw[i] = color[0];
      raw[i + 1] = color[1];
      raw[i + 2] = color[2];
    }
  }
}

function drawGlyphRGB(raw, width, x, y, glyph, color) {
  for (let c = 0; c < GLYPH_W; c++) {
    const col = glyph[c];
    for (let r = 0; r < GLYPH_H; r++) {
      if ((col >> (6 - r)) & 1) {
        const i = rgbAt(raw, width, x + c, y + r);
        raw[i] = color[0];
        raw[i + 1] = color[1];
        raw[i + 2] = color[2];
      }
    }
  }
}

function measureText(text) {
  return text.length * GLYPH_ADV - 1;
}

function drawTextRGB(raw, width, x, y, text, color) {
  let cx = x;
  for (const ch of String(text).toUpperCase()) {
    const glyph = PNG_FONT[ch];
    if (glyph) drawGlyphRGB(raw, width, cx, y, glyph, color);
    cx += GLYPH_ADV;
  }
}

// GET /badge.png —— PNG 版状态徽章（PCL2 MyImage 可用），参数同 /badge
async function handleBadgePng(url) {
  const wanted = url.searchParams.get('p') || 'all';
  const segments = await probeSegments(wanted);
  if (!segments.length) {
    segments.push({ label: 'badge', value: `unknown: ${wanted}`, color: '#9f9f9f' });
  }

  const layout = [];
  let cursor = 0;
  for (const s of segments) {
    const w = measureText(s.label) + PAD_X * 2;
    const v = measureText(s.value) + PAD_X * 2;
    layout.push({ s, w, v, x: cursor });
    cursor += w + v;
  }
  const W = cursor;

  const raw = createCanvasRGB(W, BADGE_H);
  const white = [255, 255, 255];
  for (const { s, w, v, x } of layout) {
    fillRectRGB(raw, W, x, 0, w, BADGE_H, hexColor('#555'));
    fillRectRGB(raw, W, x + w, 0, v, BADGE_H, hexColor(s.color));
    drawTextRGB(raw, W, x + PAD_X, 6, s.label, white);
    drawTextRGB(raw, W, x + w + PAD_X, 6, s.value, white);
  }

  return new Response(await encodePng(W, BADGE_H, raw), {
    status: 200,
    headers: {
      ...getCorsHeaders(null),
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
    },
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

    // 代理状态 / 健康检查（放代理业务之前拦截）
    if (url.pathname === '/status' || url.pathname === '/health') {
      return handleStatus();
    }

    // 实时延迟（轻量，供页面/启动器轮询）
    if (url.pathname === '/ping') {
      return handlePing();
    }

    // 状态徽章（SVG 图片，供 PCL2 主页等嵌入）
    if (url.pathname === '/badge') {
      return handleBadge(url);
    }

    // 状态徽章 PNG 版（PCL2 MyImage 不支持 SVG，只能显示 PNG/JPEG）
    if (url.pathname === '/badge.png') {
      return handleBadgePng(url);
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
        headers: getCorsHeaders(origin),
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
        headers.set('User-Agent', 'Minecraft-Auth-Proxy/' + VERSION + ' (Cloudflare Workers)');
      }

      // 构建转发请求
      const proxyRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'follow',
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
        headers: responseHeaders,
      });
    } catch (error) {
      console.error('Proxy error:', error);

      return new Response(`Proxy Error: ${error.message}`, {
        status: 502,
        headers: getCorsHeaders(origin),
      });
    }
  },
};