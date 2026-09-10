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

## 本地调试

```bash
node test.mjs   # Node 22+，无任何依赖，直接调用 Worker 逻辑
```

会依次验证：`/status`、`/health`、未知路径 404、以及代理转发真实 Mojang 接口。

## 说明

- 仅供学习与自用，请遵守 Mojang/Minecraft EULA 与相关服务条款。
- 上游偶发 429 限流时，代理会原样透传状态码。
- 初版源码（无 `/status` 状态检查）保留在 [`original/worker.js`](original/worker.js)，可直接部署替换。