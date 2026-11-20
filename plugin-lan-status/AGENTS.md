# dsh-lan-status · 插件级会话上下文

> 只写本插件特有的约定、事实与坑。通用规则由工作区根 AGENTS.md 自动加载。

## 1. 本插件一句话

只读 LAN 状态面板：每节点跑一个 `node:http` 服务（默认 `0.0.0.0:3091`），agent 暴露 `/self`，coordinator 聚合 `/status` 与 HTML `/`；不写 DSH 状态、不注册 client 半。

## 2. 本插件特有坑

- **没有 client 半是刻意选择**：`ctx.remote` 只暴露已导入 `/remote` 的 namespace；新增业务服务要改 client assembly。独立 HTTP 服务避免 client graph/重启，也避免 `settings.section` 的自定义 host 通道问题。
- **协调者不能递归 `/status`**：`buildAggregateStatus` 对 `instanceId === self.node.instanceId` 的节点直接用本地 `self`；只有远端才 `agentUrl + '/self'`。改这段时务必保留。
- **`ctx.agents.list()` 形状**：运行时 agent 是对象，session id 优先取 `agent.id`，cwd/标题取 `agent.session`；标题走 `ctx.get('sessionProjections')?.snapshot(agent.session)?.values?.title`，投影缺失只丢标题，不能丢整行。
- **任务只读协调者台账**：`schedulerStateFile` 仅在 `role: coordinator` 时读取；agent 的 `/self` 任务恒为空。不要在每个节点读同一台账，否则同机 A/B 会互相污染。
- **端口冲突静默降级**：`apply` 里 `server.start()` 失败只 `logger.error`，插件 fiber 仍 active；部署后必须 `curl /health`，不能只看 systemd active。
- **同机多实例必须区分端口**：A/B 都在 `.23`，A 用 3091、B 用 3092；agentUrl 写错成同一端口时 `/status` 会把 B 的请求拨到 A，表现为 `online=2` 但其中一个节点数据是重复的。协调者 `nodes[]` 与各节点 `agentUrl` 必须一起改。
- **`ctx.agents.list()` 只列活 agent**：重启后没有活会话时 `/self.sessions=[]` 是真实结果；面板文案写“当前会话”，不要把它当持久会话列表。
- **`origin` 不含 token**：面板只展示 base URL；不要把 launch token 写进配置/HTML，否则等于把入口权限发给所有能看页面的人。
- **DSH web 与 desktop 区别**：本插件只被 `dsh web` 实例加载；desktop GUI 不是被观测节点。不要把桌面端 origin 当 agentUrl。
- **Windows 防火墙**：3091 需单独入站放行；只放 3081 不够。
- **已部署事实（2026-11-20）**：A `.23:3091` coordinator、B `.23:3092` agent、C `.21:3091` agent、D `.24:3091` agent；A `/status` 聚合 4/4，HTML 200。B 的 patch 若用 `printf '\n'` 追加出现 `n- insert:`，是换行被吞；直接编辑文件补换行，别用转义。

## 3. 关键文件地图

- `lib/status.js` — 纯数据构建：`readSchedulerState` / `taskRow` / `taskSection` / `sessionRows` / `buildSelfStatus` / `buildAggregateStatus` / `renderHtml`。
- `lib/server.js` — `node:http` 路由、2s 聚合缓存、单节点超时、错误处理、`start/close`。
- `lib/index.js` — DSH 插件入口：`name='lan-status'`、`inject=['agents']`、`ctx.effect` 关闭 server。
- `tests/status.test.mjs` — 纯函数（任务/会话/协调者/离线聚合/HTML）。
- `tests/server.test.mjs` — 真实 HTTP（端口 0）：`/health`、`/self`、`/status`、`/`、404/405、agent 404。
- `docs/00-立项报告.md` — 决策、数据契约、安全与验收。
