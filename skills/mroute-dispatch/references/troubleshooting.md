# mroute 排障：症状 → 原因 → 处置

适用 v0.8.2-m4.11。原则：先判断是**插件没注册**、**数据源没接上**、还是**宿主策略/前端状态**问题；mroute 本身 advisory-only，不会阻断请求，所以「被拦住」几乎都不是它干的。

## 1. `unknown tool` / 四个工具一个都不在

**症状**：调用 `mroute_dispatch_plan` 或 `model_route_query` 报 `unknown tool`；`plugin_manager` 显示插件 active。

**原因**（按概率）：

1. 工具 schema 注册失败——宿主 `ctx.tools.register` **禁 `type` 数组**，任一工具 schema 非法会让该次注册整体抛错，而插件外层 `try/catch` 只写 `logger.error`，fiber 仍是 active。历史实例：`type: ['string','null']` 导致连 `model_route_query`/`sync`/`alias` 一起消失。
2. 插件/bundle 未启用或未安装（换了 profile、升级后未 applied）。
3. 会话是旧进程创建的，宿主未重扫工具面（罕见）。

**处置**：

- 用宿主 Inspect `Tool.listTools` 看实时全局工具面（零命中 = 注册失败，不是调用姿势问题）。
- 查日志 `[mroute] ... 注册失败: ...`；错误原文里会指出哪个 schema 不合法。
- 修 schema（单一 `type` 字符串 + 无值时省略该键），再热重载：`plugin_manager set_bundle` 关→开；仍不行则重启 DSH。
- 确认注册可用后，再按 `mroute_dispatch_plan` 重新取清单（不要在工具缺失时凭记忆填 assignee）。

## 2. 余额不显示 / 只显示 manual 或 unknown

**症状**：清单行没有 `💰`/`🌕` 读数，只有 `⚠ 未核实/数据非机读（manual）` 或 `⚠ 无余额登记（unknown）`。

**原因**：

- `manual`：渠道有 `manual` 登记对象但没接机读——`quota_platform` 为空、quota 插件未装/未启用、或 `quota_account_verified !== true`（`tool-query.js:101-110`，采信前提见 `config-schema.js:190-196`）。
- `unknown`：既无 manual 也无 machine 登记（`tool-query.js:83-87`）。
- 红线：**映射命中 ≠ 账户体系一致**（包月订阅 ≠ API 余额卡）。未核实就采信数值比不显示更糟，因此默认隐藏数值。
- `stale`：quota 处于降级期（breaker 非 ok），展示最近一次成功快照并标注 `stale`（`tool-dispatch-plan.js:89`；breaker 闭集 `tool-query.js:995`）。

**处置**：

- 先确认 quota 插件在跑、`quota_refresh` 能出该平台卡；停用 quota 时 mroute 回落 manual 属预期，工具仍可用。
- 核对渠道账户与 quota 卡是否同一账户体系；确认后到设置面板把该渠道的「账户已核实」打开，再重查。
- 映射关系不改就别改 `quota_account_verified`——这是用户级事实，不是配置调优项。
- `stale` 会自愈：quota 重启后占位/snapshot 过期会自动重探测（约 60s 级）；确定性缺席（如 http-404）不熔断、不产生 stale，表头整体消失属预期静默。
- 若某平台行「消失」而非变 0：先看 quota 快照里是否根本没有该平台行，再查 `provider_key_refs` 多账号精选。

## 3. 设置面板空态 / 显示「插件未启用」

**原因**：M3 真机根因是 `ctx.remote.settings.describe()` 返回 `{ok, value}` 信封（数据在 `value.namespaces`），旧代码直接读 `result.namespaces` 得到 0 个 namespace。当前版本已用 `unwrapResult` 修掉。

**处置**：

- 确认装的是当前版本；`plugin_manager list_plugins` 看版本与 applied 状态。
- 先强刷页面；若面板仍空，`set_bundle` 关→开热重载 client 半。
- 若这是**新增 `dsh.client` 声明后的首次安装**：必须重启 DSH 才能重扫 client graph，页面级刷新无效（slot 不会出现）。
- 面板读的是 `ctx.remote.*`，桌面端 origin 是 `dsh-app://app`，相对 `fetch('/plugins/...')` 打不到宿主 HTTP——不要用浏览器 fetch 去验证面板接口。

## 4. 保存设置报 conflict / 改动丢失

**原因**：`SETTINGS_CONFLICT` —— 提交的 `revision` 已过期（另一个窗口/会话先保存了），或 `mutate` 返回 `ok:false`。

**处置**：

- 让面板重新拉取（重开设置页）后再改一次；不要连点保存。
- 双窗口同时编辑时，后保存者必然冲突；以重新拉取后的状态为准再提交。
- 保存链路是「整表 set + revision」，不是字段级 merge；面板显示旧值时先刷新再判断是否真丢。
- `channels[]` 是 volatile 数组、整表替换；改 schema 默认值**不会**覆盖已 materialize 的配置（实际值在 profile 的 `cordis.patch.yml`），必须改 patch 或走面板。

## 5. 写 JSON/配置后报 `Unexpected token '﻿'`

**原因**：Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM；`set_bundle`/JSON 解析器把 BOM 当非法字符，报的正是 `Unexpected token '﻿'`。

**处置**：

- 改 JSON（含 `cordis.patch.yml` 的等价 JSON 视图）一律用 node 脚本或编辑器写 UTF-8（无 BOM）。
- 已写坏的：用 node `fs.readFileSync(..., 'utf8').replace(/^\uFEFF/, '')` 重写，先校验 `JSON.parse` 通过再装。
- 不要用 `Set-Content` 作为「快速修复」手段；这条坑在安装/打包链上复现过多次。

## 6. 宿主策略门拒绝 `child LLM route is not allowed for this Session`

**症状**：带 `assignee{provider,model}` 派子会话，宿主直接拒绝，子会话没起来。

**原因**：这是**宿主原生策略门**，不是 mroute 行为。mroute 只给建议，不感知也不干预策略门；放行面可能与模型档位/会话配置相关。

**处置**：

- 换 `mroute_dispatch_plan` 清单的**下一项**（保持顺序，不要跳着试）。
- 全部被拒：**省略 `assignee`** 派发，让子会话继承父路由（宿主缺省链语义）；这是已验证的降级路径。
- 不要为了绕过策略门去硬编码别的 provider/model，也不要在同一被拒组合上反复重试。
- 如果某组合历史上可用、现在被拒：属于宿主侧配置变化，记录「provider/model + 拒绝原文」后按上面降级，不要改 mroute 配置。

## 7. 快照偏旧 / 数据看着不对

**症状**：清单头部显示「偏旧（>5 分钟，建议重查；距今 Ns）」，或 `model_route_query` 提示 quota 降级。

**处置**：

- 重跑 `mroute_dispatch_plan` 取新快照；300 秒（`tool-dispatch-plan.js:21`）是「新鲜」口径，不是硬过期。
- `model_route_query` 看 `meta.quota` 与 `routes[].balance.degraded`：`degraded=true` 表示展示的是最近一次成功快照。
- 面板「动态层」的 `as_of` 为空 = 从未查询过（不是故障）；随便跑一次 `model_route_query` 就会写回快照（TTL 30s，rows 变化才写，失败静默）。M4.10 起 rows 保留全部渠道（含正常行），因此「刚查过且全部安全」也会显示摘要与读数。

## 8. 排序/推荐看着意外

- 排序是全序：`livecheck=unknown` 沉底 → 动态 `tight` 沉底 → `channel_type` → `tier` → `priority` 降序 → `id`（`ranking.js:34-44`）。**能力档位与 need 不参与排序**，只影响行内模型与 `fit=/min=`。
- 周窗口 ≥98%、金额余额 <¥10 会沉底；5h ≥95% 只提示。阈值可配（`low_balance_threshold_cny` / `window_week_tight_pct` / `window_5h_hint_pct`）。
- 模型名对不上：先跑 `model_route_sync_models`（dry-run）看 `missing/stale/provider_known`，再决定是否 `apply`；provider 不在宿主目录的渠道不会被写入。
