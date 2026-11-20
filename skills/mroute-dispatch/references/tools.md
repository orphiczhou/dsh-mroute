# mroute 四工具参考（源码行号版）

正源：`plugin-mroute/lib/*.js`（v0.8.2-m4.11）。本文件所有行号对应该版本；改代码后需重新核对。
注册面：`plugin-mroute/index.js:92-95`（`model_route_query`）、`:98-99`（`model_route_sync_models`）、`:105-106`（`model_route_alias_suggest`）、`:119-127`（`mroute_dispatch_plan`，独立平级 try 注册，兄弟注册失败不牵连）。

## 1. `mroute_dispatch_plan` —— 派遣预检（首选）

- 定义：`lib/tool-dispatch-plan.js:18`（`TOOL_NAME`）、`:153`（`createDispatchPlanTool`）。
- 入参 schema：`:161-188`；**校验先于任何 IO**：`:244-258`。
- 排序：复用 `assembleRouteTable`（`lib/tool-query.js:514-710`），与 `model_route_query` 同一份实现，口径零漂移（`tool-dispatch-plan.js:14`, `:260-261`）。

| 参数 | 类型 / 闭集 | 缺省 | 行号 |
|---|---|---|---|
| `need` | object，六维 `coding`/`tools`/`long_context`/`vision`/`world_knowledge`/`orchestration`，每维 `excellent|good|fair` | 省略 = 不做能力匹配 | `:165-177` |
| `limit` | integer | 5（clamp 到 1..10） | `:178-181`, `:254` |
| `channel_type` | `monthly|voucher|prepaid` | 省略 = 全部 | `:182-186`, `:262-264` |

出参（结构化，`:189-236` 声明、`:292-301` 生产）：

- 顶层：`queried_at`、`snapshot_at`、`freshness_seconds`（`:270-272`，仅快照可解析时出现）、`machine_count`、`pool_count`、`need`（回显，仅传了 need）、`notes[]`。
- `channels[]` 每行：`rank`、`provider`、`model`、`channel_type`、`tier`、`priority`、`display`、`state`、`reason`、`fit`、`min`、`warnings[]`（`:216-231`）。`reason` 仅在动态沉底或 `warning` 时出现（`:276-283`）。
  - `state` 闭集 `machine|machine_tight|machine_hint|manual|unknown`（`:224`）。
  - `fit`/`min` 仅能在 need 匹配成功时出现（`:109`）；无匹配时 `model='—'` + `warnings` 说明缺哪维（`:67-70`, `:31-52`）。
- 文本渲染：`:123-151`。头部 `:125-134`（新鲜度阈值 `FRESH_SECONDS=300` 见 `:21`，文案 `:127-131`）；行格式 `:140-145`；两行脚注（用法/标记）`:148-149`；图标按 `state`/`display` 重算 `:115-120`（`💰` 金额型、`🌓` tight/hint、`🌕` 正常，manual/unknown 无图标）。
- 注意：结构化 `channels[]` **不含图标键**（`:302` 注释），图标只存在于文本渲染。

示例：

```json
{ "need": { "coding": "excellent" }, "limit": 3 }
```

```text
派发预检 · dispatch preflight（2026-11-20T13:47:00.000Z）
数据：quota 快照 2026-11-20T13:46:30.000Z · 新鲜（≤5 分钟） · 4/5 渠道机读可用
需求：coding≥excellent
1. zai-coding-cn / glm-4.6  [monthly · domestic_sota · priority 90]  🌕 5h 31% · 本周 11%  fit=3 min=0
用法：按顺序把 provider/model 填进 subagent/tree_dispatch 的 assignee；被宿主策略门拒绝就换下一项；全被拒则省略 assignee 继承父路由。
```

## 2. `model_route_query` —— 完整诊断表

- 定义：`lib/tool-query.js:72`（`TOOL_NAME`）、`:724`（`createRouteQueryTool`）。
- 入参 schema：`:737-768`。

| 参数 | 类型 / 闭集 | 缺省 | 行号 |
|---|---|---|---|
| `capability` | string 关键词（如 `coding`） | 省略 | `:741-743` |
| `need` | object，六维同 dispatch plan | 省略 = 不匹配 | `:745-758` |
| `tier_min` | `overseas_sota|domestic_sota|bulk` | 省略 = 全部 | `:759-763`（闭集 `:74`） |
| `exclude_degraded` | boolean | false（只降权不剔除） | `:764-767` |

出参要点：

- `current{provider,model}`：`:775-783`。
- `routes[]`：`:784-908`。关键字段 `rank/channel_id/provider/models/channel_type/tier/priority/balance_source`；`balance` 形状 `:802-829`（`mode=amount|window|status`，`remaining/currency/display/windows[]/worst_used_pct/degraded`）；`livecheck` `:830`；`warning` `:836-843`；`dynamic` `:844-861`；`model_capability` 兼容层 `:867-881`；need 增补 `matching_models`（恒出现，可空）/`suggested_model`（仅匹配时出现，`type:'string'` 不发 null）`:884-891`。
- `models_index[]`：schema `:908-949`，按归并规范名分组的模型优先视图（`buildModelsIndex` `:1074` / 定义 `:422`，`balance_state` 只给状态不给数值 `:394-398`）。
- `model_picks[]`：schema `:950-977`，仅传 need 时出现；排序 fit 降序 → 最小裕度降序 → 渠道 rank → 规范名字典序（`:696` 起）。
- `meta`：schema `:979-1032`、生产 `:1077-1103`（`quota`、`dynamic_thresholds`、`capability_need`、`unrated_models`、`dynamic_snapshot_error`）。
- 文本渲染：`:283` 起。表头 `:285`，quota 段 `:298-302`，渠道行 `:319-322`，匹配模型段 `:324-336`，归并视图 `:359-370`，能力匹配推荐 `:372-382`。

示例：

```json
{ "need": { "vision": "good", "tools": "excellent" }, "tier_min": "domestic_sota" }
```

## 3. `model_route_sync_models` —— 同步渠道模型目录

- 定义：`lib/tool-sync-models.js:21`（`SYNC_TOOL_NAME`）、`:122`（`createSyncModelsTool`）。
- 入参：`apply` boolean，缺省 false（`:140-142`）；执行入口 `:204`，`apply = args?.apply === true`（`:208`）。
- 语义：默认 dry-run 只读目录与注册表、返回差异（`:9`, `:133`）；`apply:true` 经宿主 `configEditor` 只写 `channels[].models` 并把 `reviewed_at` 记为同步日（`:9-13` 注释、`:241-247`）；写链失败返回 `apply_error` 字符串而不是抛出（`:247`, `:287-288`）。
- 出参 required：`dry_run/applied/synced_at/apply_error/materialized/changed_channels/skipped/channels`（`:199`）；每渠道差异 `{current, catalog, missing, stale, provider_known}`（`:133`）。

示例：

```json
{ "apply": false }
```

## 4. `model_route_alias_suggest` —— 跨渠道模型归并建议

- 定义：`lib/tool-alias-suggest.js:22`（`ALIAS_TOOL_NAME`）、`:212`（`createAliasSuggestTool`）。
- 入参：`apply` boolean，缺省 false（`:223-225`）；执行 `:280`，`apply = args?.apply === true`（`:284`）。
- 语义：分组 + 建议（`groups`/`suggestions`，`:62-74`）；`reason` 闭集 `same-id|prefix-match|low-confidence`（`:57`, `:269`）。`apply:true` **只写**「同 id 跨渠道」自反映射到顶层 `model_aliases` + 顶层 `reviewed_at`（`:299-341`），`prefix-match`/`low-confidence` 永不自动写入，只标注（`:11`, `:65-68`）。
- 出参 required：`dry_run/applied/aliases_written/apply_error/groups/suggestions`（`:275`）。

示例：

```json
{ "apply": false }
```

## 5. 公共事实（闭集 / 阈值 / 排序）

- 闭集：`CHANNEL_TYPES` `lib/config-schema.js:26`；`TIERS` `:28`；`MANUAL_STATUSES`（active/disabled/exhausted）`:30`；`CAPABILITY_KEYS` 六维 `:32`；`CAPABILITY_RATINGS`（excellent/good/fair）`:34`。
- 评级序：`RATING_RANK = { none:0, fair:1, good:2, excellent:3 }` `lib/capability-need.js:14`；need 允许值 `NEED_VALUES` `:20`（不含 none）。
- 阈值缺省：`low_balance_threshold_cny` 10 `config-schema.js:219`；`window_week_tight_pct` 98 `:225`；`window_5h_hint_pct` 95 `:227`；`quota_cache_ttl_seconds` 60 `:233`。
- 排序全序：`lib/ranking.js:34-44`（比较器）、`:69-79`（sortKey：unknown → dynamicTight → channelType → tier → priority 降序 → id）。
- `enforce_gate`：`config-schema.js:206-211`，缺省 false，**未接 `tools.guard`**（advisory-only）。
- 全局提示句：`lib/prompt-section.js:10`（`SECTION_NAME`）、`:12`（order 116.5）、`:14-17`（`SECTION_TEXT`）、`:22`（注册，失败不阻断）。
