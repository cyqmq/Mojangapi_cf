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
await show('unknown path 404', '/foo');
await show('proxy /api-mojang/users/profiles/minecraft/Notch', '/api-mojang/users/profiles/minecraft/Notch');