# dsh-lan-status · 插件级会话上下文

> 只写本插件特有的约定、事实与坑。通用规则由工作区根 AGENTS.md 自动加载。

## 1. 本插件一句话

只读 LAN 状态面板（v0.3.0）：Host 半每节点可跑 `node:http` 服务（默认 `0.0.0.0:3091`），agent 暴露 `/self`，coordinator 聚合 `/status` 与单文件值班台 `/`；Client 半注册 `sidebar.panellist` 的 `LAN 状态` 图标与 `main` 的 `lan-status` 面板，并在 DSH web server 上注册同源 `/lan-status/*` 代理，点击后 iframe 显示值班台。不写 DSH 状态；入口直链 `entryUrl` 指向 `plugin-lan-trust` 网关。

## 2. 本插件特有坑

- **Host 半 + Client 半是刻意拆分**：Host 半保留独立 `node:http` 值班台，client 半只注册 `sidebar.panellist` + `main` 并用同源 `/lan-status/*` iframe。不要为了“省事”在 client 里直接 fetch 跨端口 `/status`：会撞 CORS/CSP；同源代理是当前选型。`ctx.remote` 仍只暴露已导入 `/remote` 的 namespace，不用于本插件。
- **协调者不能递归 `/status`**：`buildAggregateStatus` 对 `instanceId === self.node.instanceId` 的节点直接用本地 `self`；只有远端才 `agentUrl + '/self'`。改这段时务必保留。
- **`ctx.agents.list()` 形状**：运行时 agent 是对象，session id 优先取 `agent.id`，cwd/标题取 `agent.session`；标题走 `ctx.get('sessionProjections')?.snapshot(agent.session)?.values?.title`，投影缺失只丢标题，不能丢整行。
- **任务只读协调者台账**：`schedulerStateFile` 仅在 `role: coordinator` 时读取；agent 的 `/self` 任务恒为空。不要在每个节点读同一台账，否则同机 A/B 会互相污染。
- **端口冲突静默降级**：`apply` 里 `server.start()` 失败只 `logger.error`，插件 fiber 仍 active；部署后必须 `curl /health`，不能只看 systemd active。
- **同机多实例必须区分端口**：A/B 都在 `.23`，A 用 3091、B 用 3092；agentUrl 写错成同一端口时 `/status` 会把 B 的请求拨到 A，表现为 `online=2` 但其中一个节点数据是重复的。协调者 `nodes[]` 与各节点 `agentUrl` 必须一起改。
- **`ctx.agents.list()` 只列活 agent**：重启后没有活会话时 `/self.sessions=[]` 是真实结果；面板文案写“当前会话”，不要把它当持久会话列表。
- **`origin` 不含 token**：面板只展示 base URL；不要把 launch token 写进配置/HTML，否则等于把入口权限发给所有能看页面的人。
- **DSH web 与 desktop 区别**：本插件只被 `dsh web` 实例加载；desktop GUI 不是被观测节点。不要把桌面端 origin 当 agentUrl。
- **Windows 防火墙**：3091 需单独入站放行；只放 3081 不够。
- **已部署事实（2026-11-23 v0.3.0）**：A `.23:3091` coordinator、B `.23:3092` agent、C `.21:3091` agent、D `.24:3091` agent；四节点 host 服务与 `/lan-status/*` 代理均 200；A UI 左侧 dock 已视觉实测，本地 desktop 的 client slot 已 active（刷新页面后显示）。B 的 patch 若用 `printf '\n'` 追加出现 `n- insert:`，是换行被吞；直接编辑文件补换行，别用转义。
- **v0.3.0 没有 `/open/:id`**：入口按钮直接打开节点 `entryUrl`（`plugin-lan-trust` 网关）；网关服务端换 cookie，token 不经过 3091、不进 HTML/日志。不要为了“方便”在面板服务端 302 里做 token 交换，那等于把 owner 登录代发口开给整个 LAN。
- **`entryUrl` 优先于 `origin`**：`openNode` 用 `safeOrigin(node.entryUrl || node.origin)`；A 3095、B 3096、C/D 3095；`entryUrl` 是网关，不是 DSH 3081 本身。
- **`ui.html` 是单文件模板**：`renderPanelHtml` 读文件并替换 `__PANEL_TITLE__`/`__COORDINATOR__`；`status.js` 有模块级 `panelUiCache`，**改 HTML 后必须重启 DSH 进程**，不能只刷新页面。
- **`el()` 必须展开数组**：表格单元格构造传数组时若只 `append` Node，会把数组转成 `[object HTMLTableCellElement]`；用递归 `appendChild` 展开。
- **CSP/CORS 收紧**：v0.3.0 移除 `access-control-allow-origin: *`，CSP 改 `frame-ancestors 'self'`、`x-frame-options: SAMEORIGIN`（同源 iframe 需要），保留 `referrer-policy: no-referrer`、`nosniff`；修改 inline 脚本/样式时要同步 CSP，否则页面会静默空壳。

## 3. 关键文件地图

- `lib/status.js` — 纯数据构建与聚合：`readSchedulerState` / `taskRow` / `taskSection` / `sessionRows` / `buildSelfStatus` / `buildAggregateStatus` / `renderPanelHtml`（旧的 `renderHtml` 已弃用）。
- `lib/system.js` — 本机系统指标采集：CPU 两采样、内存、磁盘、负载、uptime、node/pid。
- `lib/server.js` — `node:http` 路由、2s 聚合缓存、单节点超时、安全头、`start/close`。
- `lib/index.js` — DSH 插件入口：`name='lan-status'`、`inject=['agents']`、`ctx.effect` 关闭 server；`panelUrl` 存在时通过 `ctx.inject(['webServer'])` 注册 `/lan-status/*` 代理。
- `lib/panel-proxy.js` — `/lan-status/*` 同源代理：剥前缀、透传 query、删 `accept-encoding`、502 处理。
- `client.js` — Client 半：`sidebar.panellist` 图标 + `main` 面板（iframe `/lan-status/`）。
- `cordis.patch.yml` — bundle 默认配置（`serve:false`、`panelUrl`）。
- `lib/ui.html` — 单文件值班台模板（内联 CSS/JS，无构建）。
- `tests/status.test.mjs` — 纯函数（任务/会话/协调者/离线聚合/HTML）。
- `tests/server.test.mjs` — 真实 HTTP（端口 0）：`/health`、`/self`、`/status`、`/`、404/405、agent 404、CSP。
- `docs/00-立项报告.md` — 决策、数据契约、安全与验收；`docs/01-redesign-ux.md`、`docs/02-observability-security.md` — 专家设计/安全评审。
