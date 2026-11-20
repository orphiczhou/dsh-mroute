# 05-m1-devlog.md — mroute M1 正式版增量开发实现记录

- 执行者：m1-dev（lead 派发，任务书 `docs/briefs/m1-dev.md`）
- 日期：2026-11-13
- 基线：`plugin-mroute/` 审计修复版 **0.1.0-mvp.1** → 本增量 **0.2.0-m1.0**
- 红线基线：AGENTS.md §4 mroute 方向红线（advisory-only：不阻断/不改写/不代决策；enforce_gate 默认 false；不碰 llm-stream 与 agent-request；无 HTTP；不执行 install_bundle）

---

## 1. 增量清单落点对照（任务书 §1.1–1.5）

### 1.1 schema 层（lib/config-schema.js）

| 清单项 | 落点 | 实现 |
|---|---|---|
| manualSchema + `status` 三值 | config-schema.js:96-106 | `status: z.union([...MANUAL_STATUSES]).default('active')`；闭集常量 `MANUAL_STATUSES=['active','disabled','exhausted']`（:27） |
| channels[] + `capability` 评级对象 | config-schema.js:108-119（定义）、:130（挂载） | `capabilitySchema = z.object({ coding/tools/long_context/vision: z.union([...CAPABILITY_RATINGS]) })`；评级闭集 `excellent/good/fair`（:29）。键缺省=无数据（schemastery object 语义：缺键省略不回填，lib/index.cjs:518-527 实读核实），查询侧按「无数据」标注 |
| 种子数据 zai coding=excellent 保持 | config-schema.js:40 | `SEED_CHANNELS[0].capability = { coding: 'excellent' }`；其余渠道不臆造评级 |
| 顶层 `enforce_gate` default false + volatile | config-schema.js:141-146 | `z.boolean().default(false).volatile()`；注释明示 M1 不接线 tools.guard、无 deny 路径（M6 opt-in 边界） |
| 顶层 `eval` 预留位 | config-schema.js:147-148 | `z.object({}).default({}).volatile()`（07 §3.2-4；M5 填充清单冻结于 07 方案，此处仅占位） |
| volatile 纪律 | config-schema.js:137-148 | channels[] 数组整体 volatile、顶层固定字段各自 volatile——保持 MVP 口径未改；capability/manual 在数组元素内，未标 volatile（Day 1 C4 禁令） |

### 1.2 registry 层（lib/registry.js）

| 清单项 | 落点 | 实现 |
|---|---|---|
| status 三值读侧兼容 | registry.js:17-25（`manualStatusOf`） | 缺字段 → `active` 不报错不告警（FR-B1-4 前半，旧表兼容）；非法值 → 按 `active` 降级 + 读时告警（registry.js:93-95），不拒写 |
| capability 评级解析 | registry.js:31-38（`capabilityRatingOf`） | 键不在 `CAPABILITY_KEYS`、值不在评级闭集、字面 `'null'` 串 → 一律 `null`（无数据），供过滤标注与展示消费 |
| enforce_gate/eval 透传 | registry.js:86-96 | 读侧缺省 false（`enforceGate === true` 才为 true——缺省路径零拦截）；eval 透传对象 |

### 1.3 查询/排序层（lib/ranking.js + lib/tool-query.js + lib/decision-log.js）

| 清单项 | 落点 | 实现 |
|---|---|---|
| warning 标注（FR-A6-1/2 M1 部分） | tool-query.js:61-77（`warningOf`）、:304-305（挂载） | `status=disabled/exhausted` 或 manual 余额 < **10 CNY**（常量 `LOW_BALANCE_THRESHOLD_CNY`，tool-query.js:34）→ `warning{reason, suggestion}`；**rank 不变、excluded 不变、无任何拦截**（冒烟组 9 断言 rank 原位 + excluded 空）。低余额解析：quota_total 可 parseFloat 且数值 < 阈值才触发，占位"—"/非数值不触发。FR-A2 分工注释在 tool-query.js:9-10（静态标注 vs M2 动态账本 mask） |
| suggestion 取 fallbacks[] 首选或排序下一项 | tool-query.js:79-94（`suggestionFor`） | fallbacks 首个合法 id → 排序下一项（末位回退前一项）→ 空串。简化裁决：不校验 suggestion 目标自身是否告警（见 §2 偏离 3） |
| review_alerts（FR-A3-4） | tool-query.js:109-118（`reviewAlertsOf`）、:306-307（挂载） | channel.reviewed_at 距今 >90 天（`REVIEW_STALE_DAYS=90`，本说明书设定值）→ `review_alert:true` + `review_alerts[]` 文案「建议人工复核 tier/priority 与 capability 评级」；空/不可解析日期不触发。双字段同时满足任务书 `review_alert:true` 形态与 docs/01:117 / 07 方案 §3.4 的 `review_alerts[]` 数组形态 |
| capability 过滤生效（FR-A3-3 M1） | tool-query.js:96-107（`capabilityNoteOf`）、:262（capabilityKey）、:302（接线） | `capability.coding ∈ {excellent,good}` → reason「命中（评级 x）」；`fair` → 「未满足（评级 fair，仅标注不过滤）」**且条目保留**（冒烟组 11：excluded 空）；无数据 → 「过滤未生效（M2 接入）」保持现状。评级门槛的「不入 routes[]」强过滤属 M2 数据建模裁决，M1 按 advisory-only 只标注（任务书 1.3 口径） |
| DecisionRecord 最小版（FR-E2） | lib/decision-log.js（新模块全文件）；tool-query.js:328-336（接线） | 每次查询追加一行到 `~/.dsh/mroute/decisions/decisions-YYYYMM.jsonl`：`{ts, args, top3:[{id,rank,reason_head}], excluded_count, generated_at}`；`fs/promises.appendFile` 追加 + `mkdir recursive`；写失败 catch → logger.warn 静默降级、查询不受影响（decision-log.js:44-58）。reason_head 80 字符截断（:37-40）。baseDir 可注入供冒烟测试。先例：vendors/puppy-bai--dsh-quota-takeover journal.jsonl 追加审计（其 index.js:83 用 createWriteStream flags:'a'，本实现用 appendFile 等价原子口径） |
| 返回文本 ⚠ 前缀与建议 | tool-query.js:120-149（`renderRouteResult`） | warning/review_alert 条目行首 `⚠ `；warning 行附「替代建议： …」；review_alerts 行附复核提示。表头补「标注均不阻断，最终选择权在会话与用户」advisory 声明 |
| output schema 增补 | tool-query.js:210-224 | routes items 增 `warning`（可选键，不在 required——可选字段省略先例 vendors/r600a-code--dsh-swarm-router/index.js:223-230）、`review_alert`（boolean，required）、`review_alerts`（string[]，required） |

### 1.4 prompt-section（lib/prompt-section.js）

未改动。复核结论：现有文案（prompt-section.js:12-14）为「建议先调用工具 → 按返回顺序填写 → 被策略门拒绝换下一项」，全程 advisory 语气、无「必须/强制」措辞，合规不动。

### 1.5 冒烟扩展（tmp/mvp-smoke/mvp-smoke.mjs 重写）

MVP 既有 8 组保留（其中 2 组按新形态修订，见 §3），M1 新增 11 组断言块：

| 组 | 断言 |
|---|---|
| 1b | schema 层：manual.status 默认 active；zai capability.coding=excellent；无数据渠道评级键省略；enforce_gate 缺省 false（Volatile 解出）且类型 boolean、opt-in=true 可通过；eval={} 占位 |
| 2d | 读侧兼容：缺 status 静默=active 零告警；非法 status 告警且按 active 降级 |
| 9 | status=disabled：渠道在表中、rank 原位 3、excluded 空（**零拦截**）、warning{disabled, deepseek-account}、渲染含 ⚠ 与替代建议 |
| 9b | exhausted（suggestion=fallbacks 首选）与 low_balance（quota_total='5'<10，rank 原位）；占位"—"三渠道恒无 warning |
| 10 | enforce_gate 读侧缺省 false + true 透传（M1 不接线断言口径） |
| 11 | capability fair 未命中：条目保留 + reason 注明 + excluded 空；字面 'null' 串视为无数据 |
| 12 | DecisionRecord：decisions-YYYYMM.jsonl 落盘、末行 JSON.parse、形状逐键（ts/args/top3/excluded_count/generated_at）、reason_head ≤81、与 meta.generated_at 一致、全行可 parse |
| 12b | 写失败静默降级：baseDir 指向普通文件 → 查询仍返回 5 条 + warn 日志「落盘失败」 |
| 13 | review_alerts：超期渠道触发（文案含「建议人工复核」与阈值 90）、其余渠道 false、渲染 ⚠；空/不可解析日期不触发 |

---

## 2. 关键设计裁决与偏离

1. **capability「未命中不过滤」**（任务书 1.3 口径执行）：FR-A3-3 v1.2 原文「评级低于门槛不入 routes[]」的强过滤语义与任务书 1.3「fair 不命中 → 不过滤但 reason 注明」并存时，**按任务书执行**（M1 标注级）；docs/01:116 的强过滤验收留待 M2 capability 数据建模定稿门槛映射后承接。理由：advisory-only 红线下 M1 不引入任何出列路径；任务书是本轮的增量裁决源。
2. **review_alert 双字段**：任务书写 `review_alert:true` + 文案，docs/01 FR-A3-4/FR-D3-1 与 07 方案 §3.4 写 `review_alerts[]` 非空。实现两者（boolean + string[]），冒烟与 schema 同步覆盖，两侧 FR/任务书口径均闭合。
3. **suggestion 简化**：不校验 suggestion 目标渠道自身是否也告警（如 fallback 首选同为 disabled）。M1 从简避免级联计算；记录为 M2 账本层接入时的小改（选择未告警目标优先）。
4. **warning 单对象三优先级**：disabled > exhausted > low_balance 取主因（FR-A6 reason 枚举三值单选口径）；不堆叠多条 warning。
5. **warning 键可选省略**：output schema 不把 warning 列入 required、无告警条目省略该键——可选字段省略有在装先例（swarm-router swarm_stats byModel）；冒烟组 4 改为「required 全在 + 无声明外键」的双向断言。
6. **「零副作用」措辞修订**：MVP 红线「零写盘」在本增量后更新为「唯一写面 = DecisionRecord 本地 JSONL 追加（观察面非控制面，无网络、无凭据内容、不改写任何请求）」。advisory-only 三不改写红线不受影响（grep 证据见 §4）。
7. **DecisionRecord 含 args**：args 仅查询入参（capability/tier_min/exclude_degraded），无凭据面；ts 与 generated_at 同值双字段按任务书字段清单保留。

## 3. 回归与冒烟结果

- `node --check`：**10/10 通过**（新增 lib/decision-log.js；package.json scripts.check 已同步，PATH node v24.20.0）。
- 冒烟（`node tmp/mvp-smoke/mvp-smoke.mjs`，2026-11-13 实跑）：**全部通过**。
  - MVP 8 组回归：组 1/2/2b/2c/3/5/5b/6/8 原样通过；**组 4 修订**（键一致性断言适配新 schema：required 全在 + 无声明外键 + warning 形状）；**组 7 修订**（capability 从 no-op 标注改为命中/无数据三分标注——这是本增量的行为变更而非回归）。
  - M1 新增 11 组：1b/2d/9/9b/10/11/12/12b/13 全过。
  - 调试期修复 2 处用例自身问题（单渠道注册表 fallbacks 悬空干扰 2d；typeof 'integer' 笔误 12）+ 1 处实现缺陷（execute 将布尔 capabilityRequested 传给 capabilityNoteOf 丢失键名，已改为 capabilityKey 透传实际入参）。
- 排序顺序回归：种子 5 渠道全序与 MVP 一致（`zai-coding-cn > opencode-go > deepseek-official > deepseek-account > xiaomi`）；disabled/exhausted/low_balance 条目 rank 原位不变。

## 4. 红线自查（grep 证据，2026-11-13）

| 红线 | 检查 | 结果 |
|---|---|---|
| advisory-only 零拦截 | 冒烟组 9/9b/11（rank 原位 + excluded 空）+ enforce_gate 缺省 false（组 1b/10 schema+读侧双断言） | ✓ |
| 不碰 llm-stream/agent-request/system-prompt-assemble、无 `.on(` 注册、无 tools.guard 接线 | grep 全 lib+index.js：仅 3 处注释提及（index.js:8、config-schema.js:143、registry.js:86），**代码零命中** | ✓ |
| 无 HTTP 出站/无凭据面 | grep `fetch|https?://|credentials|apiKey|api_key|secret|password` 于 *.js（除 node_modules）：**零命中**；`token|rewrite|prepareCall|.stream(` 仅 node_modules 第三方内部命中 | ✓ |
| 唯一写面 = DecisionRecord 本地 JSONL | decision-log.js 全文件走查：仅 fs/promises mkdir+appendFile，路径 `~/.dsh/mroute/decisions/`，无网络、无凭据 | ✓ |
| 不执行 install_bundle | 本会话未调用 plugin_manager（lead 统一重装） | ✓ |

## 5. 遗留与 M2 衔接

1. enforce_gate=true 的 tools.guard 拒绝路径：M6（opt-in 边界，任务书 §1.1 仅 schema 占位）。
2. 低余额阈值内置 10 CNY：M2 随 manual 面板升级为可配置 `low_balance_threshold_cny`（docs/01:142）。
3. capability 强过滤门槛映射（excellent/good 命中、fair 出列与否）：M2 capability 数据建模裁决；suggestion 避开告警目标的小改进同批。
4. DecisionRecord 完整版（逐项加减分、meta 留痕失败标注 FR-E2-3 后半）：M2 随 L2 账本 mask 一并落。
5. FR-A6-3 前半「缺省配置对 disabled 渠道派遣零拦截」的端到端验证需真实派遣链路，属 lead 安装实测范围（本会话离线冒烟已覆盖工具面证据）。
