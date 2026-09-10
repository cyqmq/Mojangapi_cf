// 本地冒烟测试：无需 Cloudflare 账号（Node 22+ 自带 fetch/Request/Response）
// 用法： node test.mjs
import worker from './src/worker.js';
import { writeFileSync } from 'node:fs';

const call = async (path) => {
  const res = await worker.fetch(new Request('http://localhost' + path));
  return { status: res.status, text: await res.text() };
};

const show = async (label, path) => {
  const { status, text } = await call(path);
  console.log(`\n== ${label} == (${status})`);
  if (label === '/status' || label === '/health') {
    const j = JSON.parse(text);
    console.log(`status: ${j.status} | alive: ${j.summary.alive}/${j.summary.total} | avg: ${j.summary.avgLatencyMs}ms | proxy: ${j.proxy.latencyMs}ms`);
    for (const [name, r] of Object.entries(j.upstream)) {
      console.log(`  ${name}: ${r.alive ? 'OK' : 'DOWN'} https-status=${r.status} latency=${r.latencyMs}ms${r.error ? ' err=' + r.error : ''}`);
    }
  } else {
    console.log(text.slice(0, 300));
  }
};

await show('/status', '/status');
await show('/health', '/health');

const ping = await call('/ping');
console.log('\n== /ping == (' + ping.status + ')');
const p = JSON.parse(ping.text);
console.log(`avg: ${p.avgUpstreamLatencyMs}ms | proxy: ${p.proxyLatencyMs}ms | ${Object.entries(p.upstream).map(([k, v]) => `${k}=${v.alive ? v.latencyMs + 'ms' : 'DOWN'}`).join(' ')}`);

for (const q of ['all', '/api-mojang', '/api-minecraft', '/no-such']) {
  const b = await call(`/badge?p=${encodeURIComponent(q)}`);
  const head = b.text.split('\n').find((l) => l.includes('svg')) || b.text.slice(0, 60);
  console.log(`\n== /badge?p=${q} == (${b.status} ${b.text.match(/Content-Type|image|svg/) ? 'svg' : '?'}) width=${b.text.match(/width="(\d+)"/)?.[1]}`);
}

const badgePngRes = await worker.fetch(new Request('http://localhost/badge.png?p=/api-mojang'));
const b = Buffer.from(await badgePngRes.arrayBuffer());
const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const okSig = sig.every((v, i) => b[i] === v);
const w = b.readUInt32BE(16);
const h = b.readUInt32BE(20);
console.log(`\n== /badge.png?p=/api-mojang == (${badgePngRes.status}) PNG sig=${okSig} ${w}x${h} bytes=${b.length}`);
if (!okSig || w <= 0 || h !== 20) process.exit(1);

const bAll = Buffer.from(await (await worker.fetch(new Request('http://localhost/badge.png?p=all'))).arrayBuffer());
console.log(`== /badge.png?p=all == ${bAll.readUInt32BE(16)}x${bAll.readUInt32BE(20)} bytes=${bAll.length}`);
writeFileSync('/tmp/opencode/badge-single.png', b);
writeFileSync('/tmp/opencode/badge-all.png', bAll);

for (const p of ['/api-mojang', '/session-mojang', '/api-minecraft']) {
  const r = await worker.fetch(new Request(`http://localhost/ping.png?p=${encodeURIComponent(p)}`));
  const buf = Buffer.from(await r.arrayBuffer());
  const level = r.headers.get('x-ping-level');
  const ms = Number(r.headers.get('x-ping-latency-ms'));
  const sigOk = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => buf[i] === v);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const rgba = buf[25] === 6; // colorType 6 = RGBA（透明背景）
  console.log(`\n== /ping.png?p=${p} == (${r.status}) level=${level} latency=${ms}ms sig=${sigOk} rgba=${rgba} ${w}x${h} bytes=${buf.length}`);
}

{
  const r = await worker.fetch(new Request('http://localhost/ping.png?mode=proxy'));
  const buf = Buffer.from(await r.arrayBuffer());
  const level = r.headers.get('x-ping-level');
  const ms = Number(r.headers.get('x-ping-latency-ms'));
  const sigOk = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => buf[i] === v);
  console.log(`\n== /ping.png?mode=proxy == (${r.status}) level=${level} proxyLatency=${ms}ms sig=${sigOk} rgba=${buf[25] === 6} ${buf.readUInt32BE(16)}x20 bytes=${buf.length}`);

  // 交叉验证：/ping 返回的 proxyLatencyMs 与 avgUpstreamLatencyMs 应近似 proxyLatency - avg（网络抖动会有偏差）
  const ping = JSON.parse((await call('/ping')).text);
  const expect = Math.max(0, ping.proxyLatencyMs - (ping.avgUpstreamLatencyMs ?? 0));
  console.log(`  /ping 交叉校验: proxyLatencyMs=${ping.proxyLatencyMs} avg=${ping.avgUpstreamLatencyMs} 期望差≈${expect}ms（实测 ${ms}ms）`);
  writeFileSync('/tmp/opencode/ping-proxy-mode.png', buf);
}
await show('unknown path 404', '/foo');
await show('proxy /api-mojang/users/profiles/minecraft/Notch', '/api-mojang/users/profiles/minecraft/Notch');