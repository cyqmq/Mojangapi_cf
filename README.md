# MojangAPI_cf · Minecraft Auth Proxy

将 Mojang / Minecraft 服务 API（正版验证/皮肤/权限等）反向代理到 Cloudflare Workers，自动注入 CORS 头，并内置上游状态检查。

## 功能

- 单文件 Worker，零 npm 依赖，纯 Web 标准 API。
- 反向代理以下三个上游服务：

| 前缀 | 上游 |
|------|------|
| `/api-mojang` | `https://api.mojang.com` |
| `/session-mojang` | `https://sessionserver.mojang.com` |
| `/api-minecraft` | `https://api.minecraftservices.com` |

- 自动处理 CORS（`OPTIONS` 预检 + 响应头），支持跨域请求。
- `/status` 与 `/health`：并行探测三个上游的连通性与延迟，并返回代理自身处理耗时。

## 部署

### 方式一：本地 wrangler

```bash
npx wrangler deploy   # 需在目录下执行，首次会提示登录
```

### 方式二：Cloudflare Workers Builds（GitHub 自动部署）

1. 在 Cloudflare 控制台 `Workers & Pages` 创建 Worker，连接本仓库。
2. `Settings → Build → Build command` 填 `npx wrangler deploy`（或留空用默认部署）。
3. 之后每次 `git push` 自动部署。

## 使用

```bash
# 通过代理访问 api.mojang.com 的接口
curl "https://你的worker域名/api-mojang/users/profiles/minecraft/Notch"

# 通过代理访问 sessionserver / minecraftservices
curl "https://你的worker域名/session-mojang/session/minecraft/profile/<uuid>"
curl "https://你的worker域名/api-minecraft/minecraft/profile"
```

即：`https://你的worker域名/<前缀>/<上游路径>`

### 状态检查

```bash
curl https://你的worker域名/status
```

返回示例：

```json
{
  "service": "minecraft-auth-proxy",
  "version": "1.0.0",
  "time": "2026-09-10T00:00:00.000Z",
  "status": "ok",
  "proxy": { "latencyMs": 533 },
  "upstream": {
    "/api-mojang":     { "alive": true, "status": 404, "latencyMs": 533 },
    "/session-mojang": { "alive": true, "status": 403, "latencyMs": 315 },
    "/api-minecraft":  { "alive": true, "status": 403, "latencyMs": 342 }
  },
  "summary": { "total": 3, "alive": 3, "down": 0, "avgLatencyMs": 397 }
}
```

说明：

- `upstream.<前缀>.alive`：上游是否可达（能收到 HTTP 响应即视为活着）。
- `upstream.<前缀>.status`：探针 `GET /` 返回的 HTTP 状态码（上游根路径返回 404/403 属正常）。
- `upstream.<前缀>.latencyMs`：该上游单次往返耗时。
- `proxy.latencyMs`：代理本次处理总耗时（含所有探针并发往返）。
- 整体 `status`：`ok`（全部存活）/ `degraded`（部分存活）/ `down`（全部不可达）。
- 探针默认超时 5s，可通过 `PROBE_TIMEOUT_MS` 调整。

### 实时延迟 `/ping`

轻量版状态，便于页面 / 启动器定时轮询展示：

```bash
curl https://你的worker域名/ping
# {
#   "time": "2026-09-10T00:00:00.000Z",
#   "proxyLatencyMs": 688,
#   "avgUpstreamLatencyMs": 434,
#   "upstream": { "/api-mojang": {"alive": true, "latencyMs": 314}, ... }
# }
```

### 状态徽章 `/badge`（PCL2 主页集成）

动态生成 shields 风格徽章，实时反映上游状态与延迟。

端点说明：

| 路径 | 格式 | 适用场景 |
|------|------|----------|
| `/badge` | SVG | 网页、Markdown（shields.io 风格） |
| `/badge.png` | PNG (RGB) | PCL2 MyImage 控件、WPF 等不支持 SVG 的环境 |

参数（SVG 和 PNG 共用）：

| 参数 | 说明 |
|------|------|
| `?p=all`（默认） | 三个上游合并为一个徽章 |
| `?p=/api-mojang` | 单个上游徽章 |
| `?p=/session-mojang` / `?p=/api-minecraft` | 同上 |

```bash
# 示例（这些 URL 本身就是一张图片）
https://你的worker域名/badge?p=all        # SVG
https://你的worker域名/badge.png?p=all    # PNG（PCL2 用这个）
https://你的worker域名/badge.png?p=/api-mojang
```

> **PCL2 集成**：PCL2 的 `MyImage` 控件基于 WPF，不支持 SVG。使用 `/badge.png` 端点获取 PNG 格式徽章。在启动器主页按钮的图片引用 `badge.png` URL，即可实时显示 API 延迟；点按钮可跳转 `/status` 查看完整 JSON。

徽章右侧颜色表示当前延迟（配色参考 [Colored ping bars](https://www.curseforge.com/minecraft/texture-packs/colored-ping-bars)）：
绿 `<300ms` / 黄 `<800ms` / 橙 `<1500ms` / 橙红 `>1500ms`，深红表示不可达（`down`/`timeout`）。

Markdown 嵌入示例：

```markdown
![api-mojang](https://你的worker域名/badge?p=/api-mojang)
![session-mojang](https://你的worker域名/badge?p=/session-mojang)
![api-minecraft](https://你的worker域名/badge?p=/api-minecraft)
```

PNG 版（PCL2 用）：把 `/badge` 替换为 `/badge.png` 即可。

### 实时延迟信号条 `/ping.png`

按实时延迟生成 **ping 信号条 + 延迟数字** 合成图（配色来自 Colored ping bars 资源包，`ping_1` 最差 ~ `ping_5` 最佳）：

| 参数 | 说明 |
|------|------|
| `?p=/api-mojang`（默认） | 探测并生成该上游的信号条图 |
| `?p=/session-mojang` / `?p=/api-minecraft` | 同上 |
| `?mode=proxy` | 代理自身处理延迟：并发探测全部上游，取 `proxyLatencyMs - avgUpstreamLatencyMs` |

`mode=proxy` 反映 Worker 自身的处理开销（不含等待上游响应的时间）。图片为 **RGBA 透明背景** 的 PNG：仅含信号条与文字，数字为深色 + 白色描边（MC 文字风格），在 PCL2 任意明暗主题下都无方块感且清晰可辨。

```bash
curl -o ping.png "https://你的worker域名/ping.png?p=/api-mojang"
curl -o proxy.png "https://你的worker域名/ping.png?mode=proxy"
```

响应头附带实际延迟便于调试：`X-Ping-Level`、`X-Ping-Latency-Ms`。

## 本地调试

```bash
node test.mjs   # Node 22+，无任何依赖，直接调用 Worker 逻辑
```

会依次验证：`/status`、`/health`、未知路径 404、以及代理转发真实 Mojang 接口。

## 说明

- 仅供学习与自用，请遵守 Mojang/Minecraft EULA 与相关服务条款。
- 上游偶发 429 限流时，代理会原样透传状态码。
- 初版源码（无 `/status` 状态检查）保留在 [`original/worker.js`](original/worker.js)，可直接部署替换。