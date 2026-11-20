---
name: mroute-dispatch
description: "派遣子会话 / dispatch subagent model 选择前先做模型优先级预检：调用 mroute_dispatch_plan 取可直接粘贴进 assignee 的 provider/model 清单（余额/额度读数、包月渠道优先、动态沉底、能力档位匹配、⚠ 标注与快照新鲜度）；需要完整诊断表时用 model_route_query。也用于回答「该用哪个模型 / 还有多少额度」、被宿主策略门拒绝（child LLM route is not allowed for this Session）后如何降级、以及设置面板「模型路由」各开关怎么改。触发词：派遣子会话、选模型、模型优先级、余额/额度、包月渠道、策略门被拒、能力档位、模型归并、动态沉底、mroute_dispatch_plan、model_route_query、dispatch subagent model。"
---

# mroute 使用细则：派遣前选模型（mroute-dispatch）

mroute 是 DSH 的模型路由**建议**插件：把已登记渠道按财务优先级与能力档位排成一张表，供你在派子会话时填 `assignee{provider,model}`。它 **advisory-only**——只建议、不阻断、不改写任何请求，最终选择权在会话与用户。

配套文件：`references/tools.md`（四个工具逐字段 + 源码行号）、`references/troubleshooting.md`（症状→原因→处置）。算法与维度定稿见工作区 `docs/06-recommendation-algorithm.md`（本文不复述全文）。

## 一、何时用

- 要派 `subagent` / `tree_dispatch` / 任何带 `assignee` 的子会话**之前**（派遣预检）。
- 要回答「用哪个模型」「还有多少额度 / 额度快用完没」时。
- 收到宿主策略门拒绝（`child LLM route is not allowed for this Session`）要换渠道时。
- 要改推荐口径（阈值、模型归并、能力档位）→ 设置面板「模型路由」，见 §六。

## 二、三步流程

1. **先查**：调 `mroute_dispatch_plan`（可选 `need` / `limit` / `channel_type`；无参即可用于一般派遣）。
2. **照抄**：按返回顺序，把第 1 行的 `provider` / `model` 填进派遣参数的 `assignee{provider,model}`。
3. **降级**：被宿主策略门拒绝 → 换清单下一项；**全部被拒则省略 `assignee`**，让子会话继承父路由。

要点：

- 清单顺序即推荐顺序；`limit` 缺省 5，取值 1..10，越界按边界收敛。
- 不要把模型名写死进提示词或代码——渠道目录会变，用 `model_route_sync_models` 对齐后再查。
- 派遣前重查一次：快照超过 300 秒即视为偏旧（见 §三）。

## 三、怎么读返回

头部三行：`queried_at`、quota 快照时间与新鲜度、`machine_count/pool_count`（机读可用渠道数 / 参与排序渠道数）。

行格式：

```
1. provider / model  [channel_type · tier · priority N]  🌕 5h 31% · 本周 11%  fit=3 min=1  ⚠ 尾注
```

- `[channel_type · tier · priority]`：`monthly`/`voucher`/`prepaid`；`overseas_sota`/`domestic_sota`/`bulk`；priority 大者在前。
- `🌕` 运行态正常；`🌓` 有窗口告警（周窗口沉底或 5h 提示）；`💰` 金额型余额；manual/unknown 行无图标。
- `fit=` 能力匹配分（need 各维档位序值之和）、`min=` 最小裕度（模型档位减需求档位的最小值）：两者越大越稳；不传 need 时两者都不出现。
- `⚠` 尾注：无匹配、未核实（manual）、无余额登记（unknown）、stale、`warning=disabled|exhausted|low_balance`、`livecheck=unknown`。
- 新鲜度：距今 ≤300s 显示「新鲜（≤5 分钟）」；更旧显示「偏旧（>5 分钟，建议重查；距今 Ns）」。

完整排序（全序，见 `plugin-mroute/lib/ranking.js:34-44`）：`livecheck=unknown` 全局沉底 → 动态 `tight` 沉底 → `channel_type`（monthly > voucher > prepaid）→ `tier`（overseas_sota > domestic_sota > bulk）→ `priority` 降序 → `id` 字典序。

## 四、need 六维（AND 语义）

`coding` / `tools` / `long_context` / `vision` / `world_knowledge` / `orchestration`，每维取 `fair|good|excellent`（**大小写敏感**；需求侧没有 `none`）。多键 = 全部满足（AND）。

- 不传 need：每行取该渠道 `models[]` 首个模型，不做能力筛选。
- 传 need：行内模型换成 `suggested_model`（该渠道匹配最好的模型）；无匹配渠道**仍留在列里**并标 `⚠ 无匹配（vision:无）`。
- `none` 与「未登记」不同：`none` = 明确无此能力（序值 0，不满足任何需求）；未登记 = 无数据（未知，也不算满足）。
- 非法入参在**任何 IO 之前**报错，原文示例：`need 参数非法：未知能力维度 "bogus"（允许的键 coding|tools|long_context|vision|world_knowledge|orchestration）`。

## 五、常见坑

1. **快照过期**：清单只代表查询那一刻；超 300s 先重查，不要拿几分钟前的清单派遣。
2. **余额不显示**：显示 `manual`（未核实/非机读）或 `unknown`（无登记）是设计行为——未核实账户不采信数值；quota 插件停用也会回落 manual，但四个工具仍可用。
3. **`unknown tool`**：多半是插件未激活，或工具 schema 注册失败（宿主禁 `type` 数组，可能整套工具一起消失，fiber 仍显示 active）。
4. **策略门是宿主行为**：mroute 既不阻断也不感知；只有「换下一项 / 省略 assignee」两种降级，不要试图绕过。
5. **不要硬编码模型名**：用 `model_route_sync_models`（默认 dry-run）核对 `channels[].models` 与宿主 llm 目录差异。
6. **advisory-only**：`enforce_gate` 只是占位开关（缺省 false，未接 `tools.guard`）；标 ⚠ 的渠道不会被剔除，动态沉的渠道也仍在表内。

## 六、面板（设置 → 账号菜单 → 模型路由）

- 渠道卡默认折叠，展开可改 `channel_type`/`tier`/`priority`/`models`/`manual.status`；顶部 chips 是摘要。
- 阈值：`low_balance_threshold_cny`（默认 10）、`window_week_tight_pct`（默认 98，达阈沉底）、`window_5h_hint_pct`（默认 95，仅提示不沉底）。
- 模型归并：`model_aliases`（渠道→{渠道模型→统一名}）；`model_route_alias_suggest` 默认只给建议，apply 只写「同 id 跨渠道」自反映射。
- 统一模型名能力档位：`model_ratings` 六维下拉，含「无」（`none`）。
- 动态层：最近一次查询的快照，只读；显示全部渠道读数与沉底/提示/正常计数（`as_of` 为空＝从未查过）。

## 七、工具速查

| 工具 | 用途 | 关键入参 |
|---|---|---|
| `mroute_dispatch_plan` | 派遣前预检清单（首选） | `need` / `limit`(1..10) / `channel_type` |
| `model_route_query` | 完整诊断表（routes/归并视图/告警） | `need` / `tier_min` / `capability` / `exclude_degraded` |
| `model_route_sync_models` | 同步渠道模型目录 | `apply`（默认 false，dry-run） |
| `model_route_alias_suggest` | 跨渠道模型归并建议 | `apply`（默认 false，dry-run） |

逐字段说明与示例见 `references/tools.md`；报错与异常处置见 `references/troubleshooting.md`。
