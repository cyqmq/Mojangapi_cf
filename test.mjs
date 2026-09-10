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
  console.log(text.slice(0, 300));
};

for (const p of ['/api-mojang', '/session-mojang', '/api-minecraft']) {
  const r = await worker.fetch(new Request(`http://localhost/ping.png?p=${encodeURIComponent(p)}`));
  const buf = Buffer.from(await r.arrayBuffer());
  const sigOk = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => buf[i] === v);
  console.log(`\n== /ping.png?p=${p} == (${r.status}) 期望 404，实际 sig=${sigOk} bytes=${buf.length}`);
}

for (const mode of ['proxy', '', 'single', 'whatever']) {
  const r = await worker.fetch(new Request(`http://localhost/ping.png?mode=${mode}`));
  const buf = Buffer.from(await r.arrayBuffer());
  const level = r.headers.get('x-ping-level');
  const ms = r.headers.get('x-ping-latency-ms');
  const sigOk = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => buf[i] === v);
  const rgba = buf[25] === 6; // colorType 6 = RGBA（透明背景）
  console.log(`\n== /ping.png?mode=${mode || '(none)'} == (${r.status}) level=${level} latency=${ms}ms sig=${sigOk} rgba=${rgba} ${buf.readUInt32BE(16)}x20 bytes=${buf.length}`);
  if (mode === 'proxy') {
    writeFileSync('/tmp/opencode/ping-proxy-mode.png', buf);
  }
}

await show('unknown path 404', '/foo');
await show('proxy /api-mojang/users/profiles/minecraft/Notch', '/api-mojang/users/profiles/minecraft/Notch');