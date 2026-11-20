# NOTICE — dsh-orb-quota fork

> Fork 执行：orb-dev（lead 派发），2026-11-15。计划书正源：`docs/briefs/brief-orb-quota-integration.md`（v2 审核修正版）+ 裁决书 `brief-orb-quota-integration-review.md`。工程蓝图：`docs/00-blueprint.md`（M0 侦察去险结论 + 接口冻结点）。

## 基线与许可

- **上游**：[mini-yifan/dsh-orb-cordis](https://github.com/mini-yifan/dsh-orb-cordis)（**MIT**），工作区副本 `vendors/mini-yifan--dsh-orb-cordis/dsh-orb-cordis-main/`，基线版本 **bundle `dsh-orb@0.2.1`**（monorepo 根包 `dsh-orb-cordis`）。
- 本 fork = 上游全量复制 + 下列改造；除下列文件外与上游逐字节一致（`packages/`、`models/`、`docs/` 原样保留）。
- **移植即冻结（AGENTS.md §5）**：本代码树不再跟上游升级。上游后续变更不自动流入；若必须吸收，按「重新 fork + 改造点重放」流程走（quota-multi 先例，见 `plugin-quota-multi/BUILD.md` §1）。

## 本 fork 的改造点（v0.2.1-quota.1）

1. **包身份改名涟漪三件套**（裁决书 M2）：`packages/bundle/package.json` `name` → `dsh-orb-quota`、`version` → `0.2.1-quota.1`；`assemble.mjs` `NEW_CLIENT_ID` → `id: 'dsh-orb-quota'`；`cordis.patch.yml` 六处 entry `name:` 前缀 `dsh-orb/` → `dsh-orb-quota/`。**五个 insert id 原样不动**（`preset-computer-use`/`orb-code-agent-registry`/`orb-lasso`/`orb-host`/`ui-settings-orb`）——与上游 dsh-orb 互斥安装靠 insert id，装前先移除上游（lead 操作）。`pack.mjs` 的 tgz 文件名改读 `manifest.name`（原名写死 `dsh-orb-` 前缀）。
2. **多渠道余额数据层（新增 `packages/host/src/quota-feeder.ts`）**：经 `ctx.webServer.port` + `ctx.connection.authenticatedUrl()` 组装的**带凭据 URL** 拉取已装 dsh-quota(-multi) 插件的 `GET /plugins/dsh-quota/api/status`（GET 免 CSRF；quota 插件 function-plugin 形态不可 inject 直取，HTTP 快照是唯一干净面——mroute M2 交叉实证）。**authenticatedUrl 严禁写日志/任何产出文件**（上游 open-main.ts L2-3 既有纪律，本 fork 全部继承）。消费面只取 `providers[].{id,label,status,items[].{label,percent,display}}`、`currentModel.platform`、`alertPercent`。
3. **降级状态机**：非 200（含 404 未装）/ JSON 坏 / providers 空 / 全部非 ok → quota `unavailable` → 静默退回上游 DeepSeek 账号余额链路（行为与上游 0.2.1 一致）。
4. **三级展示**：①56px 卫星贴片显示「最紧急」一条（超黄档阈值者，同百分比按 id 字典序；无超阈值显示 currentModel.platform 对应渠道；再无显示 id 序首行），hover 展开完整列表（`#quota-popover`）；②panel 卡片 `#quota-card`（每渠道一行：状态点+label+读数，点卡片头经既有 `open-main` socket 通道跳 DSH 主窗口）；③设置页「余额来源」三选（多渠道聚合 / DeepSeek 账号 / 关）+ 黄档阈值（30-90，默认 60）+ 各渠道显隐开关。
5. **偏好扩展**：`lasso-capture.json` 新增 `balanceSource`（默认 `multi`；旧文件迁移：`balance:false`→`off`，其余→`multi`；`balance` 布尔恒等于 `balanceSource!=='off'` 保持旧 helper 兼容）；新文件 `orb-quota.json`（`{yellowPercent, hidden}`）。
6. **升级兼容（裁决书 M3）**：`dshHomePath('dsh-orb', ...)` 全部保留——已装 0.2.1 用户的浮球位置/皮肤/语音模型/native staging 无缝延续。
7. **更新探针改道**：`update.ts` `UPDATE_REPO` 由上游 `mini-yifan/dsh-orb-cordis` 改为占位 repo `dshextensions/dsh-orb-quota`（不存在，双探针 404 → 更新卡静默）。**原因**：保留上游 repo 会让一键升级用上游 dsh-orb 覆盖本 fork，静默丢掉全部整合能力。

## 与 dsh-quota-multi 的 lockstep 义务（裁决书 m4）

`/status` 消费面（§2 所列字段）形状冻结于 **dsh-quota-multi v0.14.10-multi.1**（`plugin-quota-multi/src/http.ts` L20/L35-36、`src/client/controller.ts` L14-44、`src/config.ts` L147-158）。这些字段任何一侧变更，**两个 fork 必须同步改版**。路由前缀 `/plugins/dsh-quota/api` 由 quota 侧 install id `quota` 决定，不随其包名漂移。

## 凭据纪律自查口径

- 本 fork 不读 `ctx.credentials`、不碰任何 key 值；quota 侧 `/status` 的 `keys` 只含 `{configured, source, ref}`（引用名），`providers[].keyRef` 同为引用名。
- `quota-feeder.ts` 内 URL 只进 `fetch`，错误信息只记 status/异常 message（不含 URL）；`orb.ts` 的 `quotaStatusUrl()` 结果不落任何日志。
