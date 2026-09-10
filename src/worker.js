// ============================================================
// Minecraft Auth Proxy · Cloudflare Worker
// 将 Mojang / Minecraft 服务 API 反向代理并注入 CORS 头
//    /api-mojang     → https://api.mojang.com
//    /session-mojang → https://sessionserver.mojang.com
//    /api-minecraft  → https://api.minecraftservices.com
//    /ping.png?mode=proxy → 代理自身处理延迟的 ping 信号条+数字合成图（PCL2 MyImage）
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

// ---- /ping.png —— 代理自身处理延迟的「ping 信号条 + 延迟数字」合成图（PCL2 MyImage）----
// 零依赖：内置 5x7 位图字体 + 手工 PNG 编码（zlib 由 Web CompressionStream 提供）

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BADGE_H = 20;
const GLYPH_W = 5;
const GLYPH_H = 7;
const GLYPH_ADV = 6;
const PAD_X = 5;

// Minecraft ping 信号条（10×8，原图为 Colored ping bars 资源包，程序化生成等效像素）
// 5 条从左到右错位阶梯条，亮色列 + 右侧暗色阴影列；按等级填充 N 条（灰色为未激活）
const PING_LEVEL_COLORS = {
  1: { bright: [145, 0, 3], dark: [77, 0, 3] }, // 深红
  2: { bright: [255, 67, 0], dark: [135, 33, 0] }, // 橙红
  3: { bright: [255, 165, 0], dark: [135, 85, 0] }, // 橙
  4: { bright: [243, 255, 0], dark: [131, 135, 0] }, // 黄
  5: { bright: [0, 255, 33], dark: [0, 135, 15] }, // 绿
};
const PING_GREY = { bright: [91, 91, 91], dark: [56, 56, 56] }; // 未激活灰色槽
const PING_TEXT_CORE = [17, 17, 17, 255]; // 延迟数字像素色
const PING_TEXT_HALO = [255, 255, 255, 255]; // 白色描边（任意背景可读）
const PING_BARS = 5;
const PING_ICON_W = 10;
const PING_ICON_H = 8;

function latencyToPing(latencyMs, alive) {
  if (!alive) return 1;
  if (latencyMs < 300) return 5;
  if (latencyMs < 800) return 4;
  if (latencyMs < 1500) return 3;
  if (latencyMs < 2500) return 2;
  return 1;
}

// 绘制 ping 阶梯条（RGBA，透明背景），base 位置 x0,y0，scale 为放大倍数
function drawPingStaircase(raw, width, x0, y0, scale, level) {
  const fill = (x, y, color) => {
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const i = rgbaAt(raw, width, x0 + x * scale + dx, y0 + y * scale + dy);
        raw[i] = color[0];
        raw[i + 1] = color[1];
        raw[i + 2] = color[2];
        raw[i + 3] = 255; // alpha 255
      }
    }
  };
  for (let b = 0; b < PING_BARS; b++) {
    const filled = b < level;
    const c = filled ? PING_LEVEL_COLORS[level] : PING_GREY;
    // 亮色列 x=2b，行 5-b..6
    for (let r = 5 - b; r <= 6; r++) fill(b * 2, r, c.bright);
    // 阴影列 x=2b+1，行 6-b..7
    for (let r = 6 - b; r <= 7; r++) fill(b * 2 + 1, r, c.dark);
  }
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

async function encodePng(width, height, raw, colorType = 2) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType; // 2=RGB，6=RGBA（PCL2/WPF 通用）
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', await zlibDeflate(raw)),
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

function createCanvasRGBA(width, height) {
  const rowStride = 1 + width * 4;
  const raw = new Uint8Array(rowStride * height); // 全 0 → alpha 0，透明背景
  return raw;
}

function rgbaAt(raw, width, x, y) {
  return y * (1 + width * 4) + 1 + x * 4;
}

function drawGlyphRGBA(raw, width, x, y, glyph, color) {
  for (let c = 0; c < GLYPH_W; c++) {
    const col = glyph[c];
    for (let r = 0; r < GLYPH_H; r++) {
      if ((col >> (6 - r)) & 1) {
        const i = rgbaAt(raw, width, x + c, y + r);
        raw[i] = color[0];
        raw[i + 1] = color[1];
        raw[i + 2] = color[2];
        raw[i + 3] = color[3];
      }
    }
  }
}

function drawTextRGBA(raw, width, x, y, text, color) {
  let cx = x;
  for (const ch of String(text).toUpperCase()) {
    const glyph = PNG_FONT[ch];
    if (glyph) drawGlyphRGBA(raw, width, cx, y, glyph, color);
    cx += GLYPH_ADV;
  }
}

function measureText(text) {
  return text.length * GLYPH_ADV - 1;
}

// 探测单个上游，返回存活状态与耗时
async function probeEndpoint(name) {
  const probe = STATUS_PROBES[name];
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let alive = false;
  let timedOut = false;
  try {
    const res = await fetch(new URL(probe.probe || '/', probe.base), {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
    });
    if (res.body) await res.body.cancel();
    alive = true;
  } catch (error) {
    timedOut = error?.name === 'AbortError';
  } finally {
    clearTimeout(timer);
  }
  return { alive, timedOut, latencyMs: Date.now() - start };
}

// 生成「ping 信号条 + 延迟数字」合成图（PNG，透明背景）
async function buildPingCompositeImage(value, level) {
  const scale = 2;
  const iconW = PING_ICON_W * scale;
  const iconH = PING_ICON_H * scale;
  const segIconW = PAD_X * 2 + iconW;
  const segValueW = PAD_X * 2 + measureText(value);
  const W = segIconW + segValueW;

  // 透明背景，仅画信号条与数字
  const raw = createCanvasRGBA(W, BADGE_H);
  drawPingStaircase(raw, W, PAD_X, Math.round((BADGE_H - iconH) / 2), scale, level);

  // 数字：核心深色 + 1px 白色描边（MC 文字风格），任意主题背景可读
  const textX = segIconW + PAD_X;
  const textY = 6;
  for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
    drawTextRGBA(raw, W, textX + dx, textY + dy, value, PING_TEXT_HALO);
  }
  drawTextRGBA(raw, W, textX, textY, value, PING_TEXT_CORE);

  return encodePng(W, BADGE_H, raw, 6); // colorType 6 = RGBA（透明）
}

function pingPngResponse(png, level, latencyMs) {
  return new Response(png, {
    status: 200,
    headers: {
      ...getCorsHeaders(null),
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'X-Ping-Level': String(level),
      'X-Ping-Latency-Ms': latencyMs === null ? 'N/A' : String(latencyMs),
    },
  });
}

// GET /ping.png?mode=proxy —— 代理自身处理延迟（proxyLatencyMs - avgUpstreamLatencyMs）
async function handlePingIcon(url) {
  if (url.searchParams.get('mode') !== 'proxy') {
    return new Response('Not Found: only ?mode=proxy is supported', {
      status: 404,
      headers: getCorsHeaders(null),
    });
  }

  // 并发探测全部上游，proxyLatencyMs=总墙钟，差值即代理自身处理开销
  const proxyStarted = Date.now();
  const entries = await Promise.all(
    Object.keys(STATUS_PROBES).map(async (name) => [name, await probeEndpoint(name)]),
  );
  const proxyLatencyMs = Date.now() - proxyStarted;
  const latencies = entries.filter(([, r]) => r.alive).map(([, r]) => r.latencyMs);
  const avgUpstreamLatencyMs = latencies.length
    ? Math.round(latencies.reduce((s, ms) => s + ms, 0) / latencies.length)
    : null;

  let level;
  let value;
  let latencyMs;
  if (avgUpstreamLatencyMs === null) {
    // 全部上游不可达，代理开销无意义
    level = 1;
    value = 'DOWN';
    latencyMs = null;
  } else {
    latencyMs = Math.max(0, proxyLatencyMs - avgUpstreamLatencyMs);
    level = latencyToPing(latencyMs, true);
    value = `${latencyMs}MS`;
  }

  return pingPngResponse(await buildPingCompositeImage(value, level), level, latencyMs);
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

    // Minecraft ping 信号条图标（代理自身处理延迟）
    if (url.pathname === '/ping.png') {
      return handlePingIcon(url);
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