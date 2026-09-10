# MojangAPI_cf · Minecraft Auth Proxy

将 Mojang / Minecraft 服务 API（正版验证/皮肤/权限等）反向代理到 Cloudflare Workers，自动注入 CORS 头，并内置代理处理延迟的可视化信号条。

## 功能

- 单文件 Worker，零 npm 依赖，纯 Web 标准 API。
- 反向代理以下三个上游服务：

| 前缀 | 上游 |
|------|------|
| `/api-mojang` | `https://api.mojang.com` |
| `/session-mojang` | `https://sessionserver.mojang.com` |
| `/api-minecraft` | `https://api.minecraftservices.com` |

- 自动处理 CORS（`OPTIONS` 预检 + 响应头），支持跨域请求。
- `/ping.png?mode=proxy`：生成代理自身处理延迟的 ping 信号条 + 延迟数字合成图（PCL2 MyImage 用）。

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

### 实时延迟信号条 `/ping.png`

生成 **ping 信号条 + 延迟数字** 合成图（配色来自 Colored ping bars 资源包，`ping_1` 最差 ~ `ping_5` 最佳）：

| 参数 | 说明 |
|------|------|
| `?mode=proxy`（唯一用法） | 代理自身处理延迟：并发探测全部上游，取 `proxyLatencyMs - avgUpstreamLatencyMs` |

`mode=proxy` 反映 Worker 自身的处理开销（不含等待上游响应的时间；上游全部不可达时显示 `DOWN`）。图片为 **RGBA 透明背景** 的 PNG：仅含信号条与文字，数字为深色 + 白色描边（MC 文字风格），在 PCL2 任意明暗主题下都无方块感且清晰可辨。

```bash
curl -o proxy.png "https://你的worker域名/ping.png?mode=proxy"
```

响应头附带实际延迟便于调试：`X-Ping-Level`、`X-Ping-Latency-Ms`。

## 本地调试

```bash
node test.mjs   # Node 22+，无任何依赖，直接调用 Worker 逻辑
```

会依次验证：`/ping.png?mode=proxy` 输出、`?mode` 缺失/非法返回 404、未知路径 404、以及代理转发真实 Mojang 接口。

## 说明

- 仅供学习与自用，请遵守 Mojang/Minecraft EULA 与相关服务条款。
- 上游偶发 429 限流时，代理会原样透传状态码。