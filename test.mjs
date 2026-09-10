// 本地冒烟测试：无需 Cloudflare 账号（Node 22+ 自带 fetch/Request/Response）
// 用法： node test.mjs
import worker from './src/worker.js';

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

await show('unknown path 404', '/foo');
await show('proxy /api-mojang/users/profiles/minecraft/Notch', '/api-mojang/users/profiles/minecraft/Notch');