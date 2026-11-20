# mroute 模型归并（model_aliases）设计草案

> 版本：2026-11-20 lead 起草，待用户确认后转任务书实施。
> 用户裁决（2026-11-20 原文）：「同一个模型在不同的渠道，优先顺序按渠道优先级排序」「模型别名要做，按你的计划安排」。

## 1. 问题

`model_route_sync_models` 把各 provider 目录**原样**写入各渠道 `models[]`，跨渠道没有同一性：

| 情形 | 实例（2026-11-20 目录实测） |
|---|---|
| 同 id 跨渠道 | `glm-5.3-flash`（zai-coding-cn、opencode-go）、`mimo-v2.6-flash`（opencode-go、xiaomi） |
| 同模型不同 id | `deepseek-flash` / `deepseek-v4-pro`（deepseek-official、deepseek-account）↔ `deepseek-v4.1-flash`（opencode-go） |
| 渠道独有 | `glm-5.3-highspeed`、`longcat-2.0`、`longcat-2.5-preview-free` |

后果：无法回答「哪些渠道能跑模型 X」，因此「先定任务所需能力 → 匹配模型 → 再按渠道优先级选渠道」这一步做不出来；`model_capability` 也只能按渠道 id 各标一遍，同名模型在另一渠道要重复标。

## 2. 目标（只做这三件）

1. **规范名**：给每个渠道模型 id 一个 canonical（规范名），同模型跨渠道归并；
2. **档位共享**：`model_capability` 的评级挂在 canonical 上，一次评级多渠道路由复用（渠道特有 id 仍可单独覆盖）；
3. **模型优先视图**：`model_route_query` 增 `models_index`——每个 canonical 模型列出「哪些渠道可用、该渠道的财务优先级/档位/余额状态」，渠道内按既有全序键排序（**不改变现有 routes[] 顺序语义**）。

## 3. 数据模型（方案 A，唯一采纳）

顶层新增：

```yaml
model_aliases:                 # 渠道 id → { 渠道模型 id → 规范名 }
  zai-coding-cn:
    glm-5.3-flash: glm-5.3-flash
    glm-5.3: glm-5.3
  opencode-go:
    deepseek-v4.1-flash: deepseek-v4
  deepseek-official:
    deepseek-flash: deepseek-v4
```

- 缺省 `{}`；未登记的 id 视为「自身即规范名」（自反），**不做启发式猜测**（不拆 `-flash/-pro` 后缀）。
- `model_capability` 行集语义扩展：`model` 字段可写规范名或渠道 id；查询时解析顺序 = 渠道 id 精确匹配 → 该 id 的 canonical → 规范名匹配 → 渠道级 `capability` 回退。
- **不改** `channels[].models` 的形状（仍 `string[]`；改形会破坏既有保存与 Red line「schema 只增不改」）。

被否方案：B `models: [{id, canonical}]`（改形，破坏既有 4-op 保存与面板行集）；C 后缀启发式（`-flash` 未必同模型，猜错比不猜更糟）。

## 4. 落点与接口

| 文件 | 改动 |
|---|---|
| `lib/config-schema.js` | 顶层 `model_aliases: z.record(...)` 等价结构（`z.dict`/嵌套 object，`.volatile()` 挂对象根，平铺两层渠道对象）；面板保存仍走「顶层 op + channels 整替」既有 4 种 op，不新增 op 类型 |
| `lib/registry.js` | 新增 `canonicalOf(aliases, channelId, modelId)`、`ratingsForModel(channel, canonical, modelId)`（解析顺序见 §3） |
| `lib/tool-query.js` | 新增可选输出 `models_index`：`[{canonical, ratings{coding,tools,long_context,vision}, channels:[{channel_id, channel_model, channel_type, tier, priority, rank, balance_state}]}]`；`routes[].model_capability` 仍按渠道自己的模型 id 展开（兼容旧消费方） |
| `lib/tool-alias-suggest.js`（新） | 工具 `model_route_alias_suggest`：dry-run 列出「疑似同模型组」（规则：id 完全相同 → 必并；同名去渠道前缀 → 建议；其余留空待人工），`apply:true` 才写 `model_aliases`；与 sync 工具同款纪律（只改该字段 + `reviewed_at`） |
| `client.js` | 新增折叠卡「模型归并」：按 canonical 分组列「渠道 → 渠道模型 id」；可编辑规范名；未归并 id 单列「未归并」；不新增请求通道（照旧 settings 读写） |

## 5. 与现有裁决的一致性

- 「模型档位不影响渠道推荐」：`models_index` 只是**视图**，`routes[]` 排序仍由全序键决定；模型档位不进排序键。
- 「同模型跨渠道按渠道优先级」：`models_index[].channels` 直接复用 `rankChannels` 的名次，不另立排序。
- advisory-only：别名只影响「同模型归并展示」与档位解析，不新增阻断/过滤。
- 未核实渠道默认隐藏：`models_index` 里 `balance_state` 对未核实渠道只写 `unknown`，不透出数值。

## 6. 验收（可测）

1. 干跑 `model_route_alias_suggest` 输出：`glm-5.3-flash` 两渠道并入同组；`mimo-v2.6-flash` 两渠道同组；`deepseek-v4.1-flash` 与 `deepseek-flash` 标为「疑似同组，待人工确认」（不自动并）。
2. `model_route_query` 输出 `models_index`，其中 `glm-5.3-flash` 组含两渠道且按 `rank` 排序（zai 在 opencode-go 前，因 priority 90 > 80）。
3. `model_capability` 只写一条 canonical 评级，两个渠道的 `routes[].model_capability` 都能解析到（新增单测）。
4. 面板保存 `model_aliases` → 工具立即读到（复用 M3 已验证的保存链路）。
5. 既有 83+ 自检全绿；`routes[]` 顺序与 `models_index` 之外的所有输出零变化（回归）。

## 7. 未决/风险

- **别名正确性靠人工**：`deepseek-flash` 与 `deepseek-v4.1-flash` 是否同模型，只能人来定（本设计不做猜测）。
- `z.dict`/`z.record` 在 schemastery 3.19：Day-1 实测 `z.record` **缺失**、`z.dict` 存在 → 实施时先用 `z.dict(z.string())` 等价物验证 roundtrip，再定形。
- 模型目录会随 provider 升级变；`model_aliases` 里指向已消失 id 的条目要保留（不自动清理，只在 suggest 里标注 stale）。
