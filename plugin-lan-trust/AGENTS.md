# dsh-lan-trust · 插件级会话上下文

> 本文件只写本插件特有约定；通用规则见工作区根 `AGENTS.md`。

## 1. 一句话

为 DSH Web 增加“可信 LAN 免 token 入口”：同进程捕获 launch token，网关服务端换 cookie，allowlist 浏览器 302 进入，不改 DSH 认证、不把 token 交给浏览器。

## 2. 特有坑

- **DSH 没有 noAuth 开关**：`connection` 的 `trustedHosts` 只放宽 Host/Origin fence；`BrowserAuth` 仍要求 token/cookie。不要试图改 `HostConnectionService` 类——运行时路由用的是 app-boot 打包副本，插件动态 import 的不是同一份。
- **token 捕获时机**：必须在 `dsh web` 打印启动 URL 之前安装 stdout tee；当前在 `apply()` 里安装，四节点实测都早于 URL 打印（module loaded 早约 3 秒）。改 profile/插件加载顺序后要重新验证 `tokenCaptured:true`。
- **origin 必填且每节点不同**：bundle patch 里没有 origin；profile patch 必须补 `origin`，否则只 log 不监听。A/B 同机端口必须 3095/3096。
- **allowlist 内 = owner**：网关没有额外认证；不要暴露公网、不要放反代后面。只信 `req.socket.remoteAddress`，不支持 XFF。
- **DSH 3081 仍要 token**：网关只是新增入口；面板“打开界面”指向网关，不要改 DSH 监听或把它当成“关闭认证”。
- **Windows 安装**：显式 `DSH_HOME`；DSH 运行时 `package.json` 被占用会 `EPERM rename`，先停计划任务。
- **日志 token**：DSH 自己的启动行仍可能带 token；启动日志必须 600/ACL，`LAN_TRUST_DEBUG` 生产关闭。
- **端口**：A `.23:3095`、B `.23:3096`、C `.21:3095`、D `.24:3095`；D 防火墙已放行 3095。

## 3. 关键文件

- `lib/token.js` — stdout tee + 滚动 token 扫描；只存内存。
- `lib/trust.js` — IPv4/loopback CIDR 解析与 source 匹配；不读 XFF。
- `lib/gateway.js` — `node:http` 网关；`/health`、`/`、`/login`；服务端 token→cookie 交换与 302。
- `lib/index.js` — 插件入口；`installTokenCapture()`、`createLoginGateway()`、`ctx.effect` 关闭。
- `cordis.patch.yml` — bundle 默认端口/CIDR；`origin` 由 profile patch 提供。
- `tests/` — token/trust/gateway/index 16 条。
