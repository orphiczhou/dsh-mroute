# 06 · mroute 动态混合推荐：参考维度与算法概要（用户核对稿）

- 文档性质：设计说明（不是 PRD、不是代码）——供用户核对「参考哪些维度、怎么排序、下一步做什么」。
- 核对对象：mroute 0.4.1-m3.1（M1 → M3.5 已上线）；本文不改动任何代码。
- 行号基线：`ranking.js` / `registry.js` / `quota-source.js` / `quota-cache.js` / `livecheck.js` / `client.js` / `index.js` 自 2026-11-19 起未再改动，行号与当前文件一致；`quota-view.js` / `tool-query.js` / `config-schema.js` 在本文写作期间正被**并行任务 m4-data（修窗口余额与模型列表同步）**修改（文件 mtime 2026-11-20 08:52–08:53）。因此正文中这三个文件的行号取自 **08:48 快照**，可能随其提交位移 3-10 行——检索请以函数名（`machineBalanceOf` / `windowItemsOf` / `platformViewOf` / `warningOf`）为锚。标「m4-data 现行」的段落引的是 08:55 前的工作区状态，仍在进行中。`docs/05-m3-devlog.md` 引用的 client.js 行号是更早版本，冲突时以本文为准。
- 证据口径：`lib/xxx.js:NN` = 该文件快照行号；「实测」= 本会话 2026-11-20 实采（quota 快照经 `GET /plugins/dsh-quota/api/status`，模型目录经 profile `cordis.patch.yml` 实读）；「未实现（规划）」= 本文建议、代码里没有；「实施中」= 并行任务 m4-data 正在落、本文定稿时未完成。
- 结论先行：**当前排序是纯静态全序，余额/窗口/模型档位/复核新鲜度一律不参与排序**；建议的 v2 仍然保持这条（动态数据只做标注与告警），理由见 §4.2。

---

## 1. 目标与红线

### 1.1 一句话目标

派遣子会话前，mroute 回答一个问题：**「这次优先把活派给哪个渠道、用哪个模型」**。输出 = 一张按财务优先级排好的渠道表 + 每条的理由 + 若干非阻断标注。它是给会话（模型）和用户看的**建议清单**，不是执行器。

### 1.2 advisory-only 的确切含义（三不）

| 维度 | 含义与边界 | 代码事实 |
|---|---|---|
| **不阻断** | 没有任何 `tools.guard` / deny 路径；排第一不等于必须用，排最后不等于不能用。宿主侧「子会话 route 不被允许」属于用户自行配置的宿主策略门，与 mroute 无关。`enforce_gate` 字段存在但默认 `false`，当前也不接任何阻断实现。 | `plugin-mroute/index.js:11-14`（红线自查锚）；`lib/tool-query.js:124-131`（「只产生标注，调用方不据此沉底/出列/拦截」）；`lib/config-schema.js:209` |
| **不改写** | 不监听 `llm/stream`、`agent/request`、不改 systemPrompt 组装、不替会话选模型。唯一写侧动作 = 注册一个查询工具 + 一句 systemPrompt 提示 + 本地 DecisionRecord 追加。 | `plugin-mroute/index.js:27`（inject 仅 `tools/llm/systemPrompt/webServer`）；`index.js:99-103`；`index.js:12-14` |
| **不代决策** | 排序、`warning`、`review_alerts`、模型档位行全是标注；是否按表派遣由会话与用户决定。文本渲染抬头明确写「标注均不阻断，最终选择权在会话与用户」。 | `lib/tool-query.js:213-215`；`lib/tool-query.js:124-125` |

### 1.3 红线：映射命中 ≠ 账户体系一致

**规则**：quota 平台行命中，只证明「平台 id 同名/前缀可认领」，**不证明**「本渠道消费的就是这张卡的账户」。machine 余额要采信，必须同时满足：`quota_account_verified === true`（人工核实过）+ 平台行 `status === 'ok'` + 存在可解析数值（`lib/tool-query.js:81-89`）。

**实测反例（2026-11-20）**：`zai-coding-cn` 是 GLM Coding **包月订阅**；映射到 quota 平台 `zhipu`，该行是「智谱 Coding Plan · max」——条目为 5 小时窗口 1%、本周窗口 3%、搜索/工具额度 3512、账户余额 ¥0.94、累计消费 ¥140，是**另一套账户语义**（包月套餐用量 vs API 余额）。注册表 `quota_account_verified: false`（`lib/config-schema.js:56-57`），所以即使数值命中也不采信，回落人工登记并标注原因（`lib/tool-query.js:81-83`）。

**第二条红线**：machine 数值采信**不校验币种**（`lib/tool-query.js:87-95` 只看 `typeof === 'number'`）；只有 low_balance 告警比较时才限定 `CNY | null`（`:136-142`），非 CNY 会在备注里写「币种 X，CNY 低余额阈值不适用」（`:467-469`）。当前 5 个种子渠道全为 CNY，无实害；接入 USD 渠道前需先做币种归一（M4 项）。

**第三条**：**推荐表不承诺「可派遣」**。宿主「模型目录」（`llm.listModels`）与「策略门放行面」（profile 的 `subagent-model-selection-settings.allowedModels`，见 `C:\Users\sir_c\.dsh\profiles\desktop\cordis.patch.yml:214-242`）是两个真源，后者 mroute 读不到（无 API），且放行面与模型档位相关（AGENTS.md §7 实录：`deepseek-v4-pro` 放行、`deepseek-chat` 被拒）。排序表只表达「建议优先尝试」；被宿主拒绝时按 §4.1 的顺序降级或省略 assignee 继承父路由。

---

## 2. 数据源矩阵

### 2.1 五类数据源总表

| # | 数据源 | 能读到什么 | host 工具侧 | client 面板侧 | 当前状态 | 证据 |
|---|---|---|---|---|---|---|
| 1 | **静态注册表** `channels[]` | 渠道全字段（类型/档位/优先级/模型/备选/能力/余额映射/复核锚） | 读：每次工具调用重读 volatile 数组（`getRegistry`）；**host 不写** | 读：`remote.settings.describe()` 镜像；写：`remote.settings.mutate()` 走 `channels` 数组整替 | **已实现**（M1 读 / M3 面板编辑） | `plugin-mroute/index.js:42`；`lib/registry.js:107-179`；`client.js:448-456`；`client.js:395-402` |
| 2 | **quota 插件面板快照** | `providers[].items`（余额/窗口/状态）、`refreshedAt`、`keys` | 读：同进程 loopback `GET /plugins/dsh-quota/api/status`（非 loopback 不发请求） | **不读**（面板只显示注册表值；预览卡明说不含余额） | **已实现**（M2；TTL + 单飞 + 退避 + 熔断 + stale） | `lib/quota-source.js:28,55-65,111-146`；`lib/quota-cache.js:34-38,119-137`；`client.js:111` |
| 3 | **宿主 llm 目录** | `listProviders()` / `listModels(id)` | 读：活校验用（60s TTL 缓存） | **不读**（M3 明确裁剪，未接 `remote.llm`） | **部分实现**：只用于可用性判定，**不用于模型列表同步** | `lib/livecheck.js:9,19-51`；`docs/05-m3-devlog.md` §2.4 |
| 4 | **provider 活校验** | `ok` / `unknown` + `availableModels` | 读：同上，结果随 `routes[].livecheck` 透出 | **不读**（预览忽略活校验，unknown 恒按 0 处理） | **已实现** | `lib/ranking.js:58`；`client.js:409-433` |
| 5 | **复核锚** | `reviewed_at` / `review_alerts`（>90 天提醒） | 读：每次查询计算提醒 | 读 + 可编辑（渠道卡「复核时间」字段） | **已实现** | `lib/tool-query.js:51,181-189`；`lib/config-schema.js:195`；`client.js:626-681` |

补充：client 半的注入面只有 `slots` / `remote` / `remote.settings` / `remote.credentials`（`client.js:971`），**拿不到 quota 快照、llm 目录与活校验结果**——面板里的实时余额永远是 host 工具输出的东西，面板自身不发起任何 HTTP（`client.js:973-992` 只有样式与 slot 注册）。

### 2.2 静态注册表字段（谁能读、谁能写）

| 字段 | 取值域（schema） | client 可编辑 | host 消费点 |
|---|---|---|---|
| `id` / `routeProvider` | 字符串，kebab-case | 只读（编辑表单不可改） | 排序兜底键 / 活校验入参 |
| `channel_type` | `monthly` \| `voucher` \| `prepaid` | 是（下拉闭集） | 排序第 2 键（`ranking.js:14`） |
| `tier` | `overseas_sota` \| `domestic_sota` \| `bulk` | 是 | 排序第 3 键（`ranking.js:15`）；`tier_min` 过滤 |
| `priority` | 整数 0-100，缺省 50 | 是 | 排序第 4 键（降序） |
| `models[]` | 字符串数组 | 是（每行一项） | 活校验入参 + 目录差异备注 |
| `fallbacks[]` | 字符串数组（渠道 id） | 是 | 替代建议 `suggestion` |
| `capability{}` | coding/tools/long_context/vision × excellent/good/fair | 是（4 下拉） | 仅备注标注，不排序不过滤 |
| `model_capability[]` | `[{model, 四维}]`，四维可缺 | 是（每模型 4 下拉） | **仅文本标注，当前不进排序** |
| `manual{status,quota_total,quota_used_est,note}` | status 三值 active/disabled/exhausted | 是 | warning / 人工余额兜底 |
| `quota_platform` | 字符串（空=不接 machine） | 是 | quota 行选取 |
| `quota_account_verified` | 布尔，缺省 `false` | 是（开关） | machine 采信开关 |
| `reviewed_at` | 日期串（可空） | 是 | 90 天提醒 |
| 顶层 `low_balance_threshold_cny` | ≥0，缺省 10 | 是 | 低余额阈值 |
| 顶层 `quota_cache_ttl_seconds` | 5-3600，缺省 60 | 是 | quota 缓存 TTL（热更） |
| 顶层 `enforce_gate` | 布尔，缺省 false | 是 | 预留，未接阻断 |
| 顶层 `eval{}` | 空对象预留 | 否 | M5 评测写回位 |

证据：`lib/config-schema.js:26-34`（闭集）、`:131-136`（manual）、`:144-149`（capability）、`:159-165`（model_capability）、`:168-196`（channel）、`:199-224`（顶层）；host 读侧归一 `lib/registry.js:133-163`；client 镜像/校验 `client.js:290-318,321-346,359-392`。

### 2.3 quota 面板快照：实测样本（2026-11-20）

| 平台行 id | 余额/窗口条目（实测） | 数值形态 | mroute 当前能否用 |
|---|---|---|---|
| `deepseek` | 「CNY 总余额」`¥36.73`，`remaining: 36.73`，另有 `weeklySpent 16.34`、`burnRatePerHour 0.1` | **金额型（remaining 数值）** | 能：`deepseek-official`/`deepseek-account` 两行 `verified: true` → `machine(¥36.73)`（`config-schema.js:88-89,103-104`） |
| `zhipu`（智谱 Coding Plan · max） | 「5 小时窗口」`percent 1` / 「本周窗口」`percent 3`（均只有 `percent` + `display:"已用 N%"` + `resetAt`）；「搜索/工具额度」`remaining 3512`；「账户余额」`display "¥0.94"`（无 remaining）；「累计消费」`display "¥140"` | **窗口型 + 金额 display 混合** | 不能：窗口标签不在余额闭集里 → 整条丢弃（`quota-view.js:31-40,47-51,97`）；「账户余额 ¥0.94」被读成余额，但 `zai-coding-cn` 的 `verified: false` 拦截 → 回落人工并标注（`tool-query.js:81-83`） |
| `opencode-go#OPENCODE_GO_API_KEY` 与 `opencode-go#OPENCODEGOSOTA_API_KEY` | 两行同构：「5h 窗口」`4%`、「本周窗口」`8%`、「本月窗口」`4%` | **窗口型，无 remaining** | 不能：没有金额条目，且 `opencode-go` 的 `verified: false`（`config-schema.js:71-72`） |
| `xiaomi` | 「总可用余额」`¥57.93`，`remaining: 57.93` | **金额型** | 能：`verified: true` → `machine(¥57.93)`（`config-schema.js:119-120`） |
| `probe#giteeinter` / `probe#proma` | 「模型服务」`在线`，附 `message:"该平台无 API-key 额度接口，仅探测服务可用性"` | **状态型** | 不适用：注册表无映射；也不满足「余额数值」条件 |

三条结论：

1. **金额型只有两行真正可采信**（`deepseek`、`xiaomi`）。用户样本里 `deepseek` 为 `¥37.24`、本次实采为 `¥36.73`——同一行、同一形态，数值随消耗变化，不影响结论（关键在「`remaining` 是数值」，不在具体金额）。
2. **窗口型是覆盖面最大的一类，08:48 快照里 mroute 完全看不到**：窗口条目只有 `percent`（语义是「已用」）与 `display`，没有 `remaining`；而余额闭集是金额标签（`quota-view.js:31-40`），窗口标签（「5 小时窗口」「本周窗口」）连候选都进不去。
   - **并发进展（m4-data 现行，08:55 前）**：已按「window 先于 amount」判形态（`quota-view.js:186-202`），只认 `display` 的 `已用 N%`、**不采信 `percent` 字段**（`:101-108,128`，percent 在额度/工具条目里有别的用途），产出 `mode:'window'`、`windows[]`、`worst_used_pct = max(...)`（`:196-201`）；消费侧采信门同步放开 window/status（`tool-query.js:95-102`）。
   - **但 `verified` 门仍在前**（`tool-query.js:89-91`）：`zhipu` / `opencode-go` 两行的 `quota_account_verified` 仍是 `false`，所以窗口读数目前仍不会出现在 `routes[]` 里。「通道能读」已落地，「表里能看」取决于 Q4 的裁决——这是本文最需要用户拍板的联动点。
3. **多账号形态**：平台行 id 为 `平台id#keyRef`，选取顺序 = 精确相等 → `平台#` 前缀 → 按 `provider_key_refs` 精选 → 首行 + `multiUnpicked` 标注（`quota-view.js:167-185`）。实测 `opencode-go` 两个 keyRef 行套餐相同（5h 4%/周 8%/月 4%）；若两把 key 对应不同套餐，未精选就会读错卡——当前仅标注、不猜。

### 2.4 宿主 llm 目录：与种子注册表的一致性核对（关键待修项）

| 渠道 | 注册表 `models[]`（种子） | 宿主目录实测 | 判定 |
|---|---|---|---|
| `zai-coding-cn` | `['glm-4.6']`（`config-schema.js:47`） | `glm-5.3` / `glm-5.3-flash` / `glm-5.3-highspeed`（profile `cordis.patch.yml:83-104`） | **不一致**：旧 id 且缺 2 个 |
| `opencode-go` | `[]`（`:64`） | `qwen3.8-flash` / `deepseek-v4.1-flash` / `glm-5.3-flash` / `longcat-2.0` / `longcat-2.5-preview-free` / `mimo-v2.6-flash`（`:39-82`） | **不一致**：空表；且同一目录在不同时间点也在漂移（任务书样本 4 个，现读 6 个） |
| `deepseek-official` | `['deepseek-chat','deepseek-reasoner']`（`:79`） | profile 未列该 provider 块（按宿主内置 provider 处理），其放行面为 `deepseek-flash` / `deepseek-v4-pro`（`:215-218`） | **不一致**：旧 id |
| `deepseek-account` | 同上（`:96`） | 同上（`:219-222`） | **不一致** |
| `xiaomi` | `[]`（`:111`） | `mimo-v2.6-flash` / `mimo-v2.6-pro`（`:105-121`） | **不一致**：空表 |

现状：host 侧发现差异只在 `note` 里写一句「注册表模型未在目录列出（建议性，可能仍可用）」（`lib/tool-query.js:109-113`），**不自动改写**；client 侧纯手工编辑列表（`client.js:626-681`）。因此 5 行种子的 `models[]` 全部处于「过期/空」状态，§5.2 的 M4-2 处理。

### 2.5 活校验与复核锚的事实

- 活校验：`listProviders()` → 未注册即 `unknown`；`listModels(id)` 失败即 `unknown` 且**不写缓存**（避免把「读不到」当「通过」）；成功结果缓存 60 秒（`lib/livecheck.js:9,21-49`）。并发按渠道跑，单渠道异常降级为 `unknown`（`lib/ranking.js:67-78`）。
- `unknown` 的处理是**全局沉底但保留在表中**（`ranking.js:6,58`），不是剔除——保证「读不到」不等于「不可用」。
- 复核锚：`reviewed_at` 距今 > 90 天 → `review_alerts` 一句提醒，**只标注、不降权、不剔除**（`tool-query.js:51,181-189`）；`reviewed_at` 为空则不提醒（现状，是否要把「未登记」也提示见 §6-Q5 备选）。

---

## 3. 维度定义

| # | 维度 | 取值域 | 数据来源 | 当前是否参与排序 | 当前实际作用 | 建议 |
|---|---|---|---|---|---|---|
| D1 | 财务优先级 `channel_type` | `monthly`(0) < `voucher`(1) < `prepaid`(2) | 注册表 | **是（第 2 键，实质一级）** | 包月整体优先于券、券优先于预充值 | 保持硬键，不参与加权 |
| D2 | 能力档位 `tier` | `overseas_sota`(0) < `domestic_sota`(1) < `bulk`(2) | 注册表 | **是（第 3 键）** | 同财务档内先看能力档 | 保持硬键 |
| D3 | `priority` | 整数 0-100，降序 | 注册表（人工） | **是（第 4 键）** | 同档内人工微调 | 保持；未来作为加权的锚点 |
| D4 | 余额（4 形态） | 金额 / 窗口百分比 / 状态 / 人工 | quota 快照 + 注册表 manual | **否** | 只做展示与 `low_balance` 阈值告警 | 见 §3.1；M4 补窗口通道 |
| D5 | 低余额阈值 `low_balance_threshold_cny` | ≥0，缺省 10 | 注册表顶层 | 否 | 金额 < 阈值 → `warning.reason='low_balance'`（CNY/null 才比较） | 保留；另加窗口阈值（建议 85%） |
| D6 | 活校验 `livecheck` | `ok` / `unknown` | 宿主 llm 目录 | **是（第 1 键：unknown 沉底）** | 读不到的渠道排到最后但仍在表中 | 保持 |
| D7 | 复核新鲜度 `reviewed_at` | 日期 / 空 | 注册表 | **否** | >90 天 → `review_alerts` 提醒 | 保持不排序；可考虑加「未登记」提示 |
| D8 | 渠道能力 `capability` 四维 | coding/tools/long_context/vision × excellent/good/fair | 注册表 | **否** | 查询参数 `capability` 命中 → 备注一句；**不过滤、不排序**（`tool-query.js:434-446` 只过滤 `tier_min`/`exclude_degraded`） | 保持标注；不要拿它当过滤器（会变成隐性阻断） |
| D9 | 模型级 `model_capability` 四维 | 同 D8，逐模型 | 注册表（M3.1 落地） | **否** | 只在文本输出追加「模型档位: …（advisory 标注，不参与排序）」（`tool-query.js:234-236`） | 用于「推荐模型」标注，仍不进渠道排序（§4.2-A） |
| D10 | 模型列表 `models[]` | 字符串数组 | 注册表（人工） | **否** | 参与活校验入参 + 目录差异备注 | 以宿主目录为提示源、人工确认后写回（M4） |

### 3.1 余额的四种形态（当前只有「金额型」被读，且只用于告警）

| 形态 | 实测样例 | mroute 现状 | 建议 |
|---|---|---|---|
| **金额型** | `deepseek` ¥36.73（`remaining`）；`xiaomi` ¥57.93（`remaining`） | 采信 → `balance{}`；`< 10` 时 `low_balance` 标注（`tool-query.js:136-142`） | 保留为主通道；补币种白名单 |
| **窗口百分比型** | `zhipu` 5h 1% / 本周 3%；`opencode-go` 5h 4% / 周 8% / 月 4% | 08:48 快照：**完全丢弃**（余额闭集不含窗口标签）。m4-data 现行：`mode='window'` 已识别（`quota-view.js:186-202`），但被 `verified` 门拦下（`tool-query.js:89-91`） | 保留 `windows[]` + `worst_used_pct`（已落），**只告警、不改序**；窗口选择与阈值见 Q2 |
| **状态型** | `probe#…`「模型服务 在线」；`provider.status` ok/error | 仅当 `status !== 'ok'` 时阻止 machine 采信（`tool-query.js:84-86`） | 保留；可扩展为「渠道不可用」标注 |
| **人工登记** | `manual.quota_total`（数字或占位 `—`）、`quota_used_est`、`note` | 数值 < 阈值 → `low_balance`（`:143-146`）；占位 `—` 写进备注（`:101-104`） | 保留为统一兜底真源 |

关键差异：金额型「越大越安全」，窗口百分比「**越小越安全**」（语义是已用）；且 5h / 周 / 月三个窗口的恢复速度差 1-2 个数量级——**不能把窗口百分比当金额直接参与排序**。

### 3.2 渠道级 `capability` 与模型级 `model_capability` 的分工

- 渠道级 `capability{}`：回答「这个渠道擅长什么」，用于查询参数命中后的备注（`tool-query.js:168-178`）；`fair` 未满足只标注、不过滤（`:174-175`），无数据时写「M2 接入」文案（`:177`）。
- 模型级 `model_capability[]`：回答「这个渠道里哪个模型擅长什么」，M3.1 已完整落地——schema（`config-schema.js:159-165,181`）、读侧归一（`registry.js:42-52,63-98`：重复模型首个生效、未知模型保留并告警）、输出可选键（`tool-query.js:344-358`）、面板每模型 4 下拉（`client.js:570-624`）。
- **两者都不参与排序**；模型级数据的正确用途是「在同渠道内挑模型」，而不是「让擅长 coding 的渠道压过包月」。

### 3.3 模型列表的一致性

`models[]` 是人工维护的「本渠道可用模型」清单，目前与宿主目录 5 行全不一致（§2.4）。它影响两件事：①活校验时是否把某模型视为可用（`livecheck.js:36`）；②无实际消费（查询只透出模型名）。建议按 §6-Q3 处理。

---

## 4. 算法概要与伪代码

### 4.1 当前已实现：静态全序（v1）

排序是纯函数：输入 = 注册表 channels + 活校验结果，输出 = 确定性全序。五个键依次比较（`lib/ranking.js:1-11` 头注、`:27-36` 比较器、`:55-64` 键构造）：

```
function sortKey(ch, live) {
  return [
    liveStatus(ch) === 'unknown' ? 1 : 0,        // ① 活校验 unknown 全局沉底（降权不剔除）
    CHANNEL_TYPE_RANK[ch.channel_type] ?? 9,     // ② monthly 0 < voucher 1 < prepaid 2
    TIER_RANK[ch.tier] ?? 9,                     // ③ overseas 0 < domestic 1 < bulk 2
    -(Number(ch.priority) || 0),                 // ④ priority 降序
    String(ch.id ?? ''),                         // ⑤ id 字典序兜底（保证全序确定）
  ]
}
sort(channels, (a, b) => cmpArray(sortKey(a), sortKey(b)))   // 同输入必同输出
```

**例子（当前 5 个种子渠道，2026-11-20 实调结果）**：

| rank | 渠道 | 键（活校验, 类型, 档位, -priority, id） | 输出摘录 |
|---|---|---|---|
| 1 | `zai-coding-cn` | `(0, 0, 0, -90)` | `monthly/domestic_sota/priority 90 | balance=manual` |
| 2 | `opencode-go` | `(0, 0, 0, -80)` | 同上，priority 80 |
| 3 | `deepseek-official` | `(0, 2, 0, -70)` | `prepaid/domestic_sota`，`balance=machine(¥36.73)` |
| 4 | `deepseek-account` | `(0, 2, 0, -65)` | 同上，priority 65 |
| 5 | `xiaomi` | `(0, 2, 2, -50)` | `prepaid/bulk`，`balance=machine(¥57.93)` |

（与 `docs/05-m3-devlog.md` §11.5 实调记录一致；行文本格式见 `lib/tool-query.js:232`。）

**同序附带、不进排序键的东西**（这是「advisory 标注」的全部内容）：`warning`（disabled/exhausted/low_balance，`tool-query.js:126-148`）、capability 备注（`:168-178`）、`review_alerts`（`:181-189`）、模型档位行（`:234-236`）、备注差异（`:98-115`）、`balance` 展示（`:192-197`）。余额、窗口、模型档位、复核新鲜度对「第几名」零影响。

### 4.2 建议的「动态混合推荐 v2」：两个候选方案

#### 方案 A：静态全序 + 动态标注（排序键零改动）

排序仍是 §4.1 的 5 键；动态数据只扩三样东西：①`routes[].balance` 增加窗口形态与 `worst_used_pct`；②`warning.reason` 增加 `window_high`；③`routes[].suggested_model` 按「本次能力需求 + `model_capability` + 目录可用性」挑一个模型并给一句理由。

- 稳定性：排序只由注册表决定 → 同注册表 + 同活校验 = 同序，**可复盘**。
- 可解释性：理由串就是配置事实（「包月优先；domestic_sota；priority 90」），一句能读完。
- 代价：无法表达「包月渠道本周窗口已 96%」对顺序的影响（只会在该行多一句告警）。

#### 方案 B：同档内加权（`channel_type`/`tier` 仍是硬键，动态分只在同档内生效）

```
function dynamicSortKey(ch, quota, ctx) {
  const head = [
    liveStatus(ch) === 'unknown' ? 1 : 0,
    CHANNEL_TYPE_RANK[ch.channel_type] ?? 9,
    TIER_RANK[ch.tier] ?? 9,
  ]
  const budget = budgetScore(ch, quota)        // 0..1，或 null=不参与
  const health = healthPenalty(ch)             // 0..1
  if (budget === null) return [...head, -(Number(ch.priority) || 0), ch.id]   // 中性，不加不减
  const score = (Number(ch.priority) || 0) + 100 * (wB * budget - wH * health)
  return [...head, -score, ch.id]
}
```

**窗口归一（建议 N2，二选一需用户裁决，见 §6-Q2）**：

```
windows = quota_row(ch).windows          // [{kind:'5h'|'week'|'month', used_pct, reset_at}]
if (windows.length === 0) return null    // 无窗口数据 → 中性，绝不猜测
// N1（简单）：worst = max(used_pct)                       —— 最紧窗口
// N2（推荐）：按恢复速度加权，5h 恢复快所以权重低
used = Σ(w[kind] * used_pct) / Σ(w[kind])   with w = { '5h': 0.3, 'week': 0.7, 'month': 0.15 }
return clamp01((100 - used) / 100)
```

#### 两方案比较

| 维度 | 方案 A（全序 + 标注） | 方案 B（同档内加权） |
|---|---|---|
| 排序稳定性 | **高**：纯注册表决定，同输入同输出 | 中：窗口百分比随时变 → 同一天两次查询可能换位 |
| 可解释性 | **高**：一句「包月优先 + priority 90」 | 中：需要解释权重与窗口合成公式 |
| 财务红线契合 | **完全契合**（静态层就是用户点名的财务优先级） | 契合（`channel_type`/`tier` 仍是硬键，只在同档内微调） |
| 数据依赖 | 无（标注可缺席） | 需要窗口归一 + 未核实判定 + 币种语义 |
| 实现量（估） | 小：`quota-view` 加窗口通道 + `tool-query` 加字段/告警/`suggested_model` | 中：额外一套评分、权重配置、回归与可复现性测试 |
| 主要风险 | 用户可能觉得「不够动态」 | 推荐漂移 + 派遣记录不可复盘 + 权重难以自证合理 |

#### 推荐：A 为默认，B 的「同档内加权」作为 opt-in（默认关闭）

理由三条：

1. **财务优先级是硬约束**。`channel_type` 在用户语境里是「包月先用、券次之、预充值兜底」；动态分一旦跨档生效，就会出现「余额充足的预充值压过包月」，直接违背产品定位。方案 B 把它压在同档内，是唯一可接受的形式。
2. **可复盘性**。lead 按表派遣后要能回看「当时为什么排这个」；金额/窗口秒级变化会让同一注册表在不同分钟给出不同名次，事后无法自证。方案 A 的排序是配置的函数，天然可审计。
3. **解释成本**。会话是「读一行字就决策」的使用者；A 的理由串一行可读完，B 需要一段公式。mroute 的输出首先服务于「一句话读懂」。

#### 未核实 / 无数据 / 过期 / 降级：统一处理

| 情形 | 处理 | 依据 |
|---|---|---|
| `quota_account_verified=false` | 不采信数值，`balance_source=manual`，备注写「映射命中但账户未核实（不采信数值）」 | `tool-query.js:81-83` |
| quota 快照无该平台行 | 回落 manual，备注写「快照无平台 X 行」；quota 整体缺席时**无任何噪音** | `:80,73` |
| 平台行 `status !== 'ok'` | 回落 manual，备注带状态与 message | `:84-86` |
| 余额/窗口解析不出来 | 不伪造 0，按「无可解析数值」回落 | `:87-89`；`quota-view.js:61-69` |
| 快照过期/熔断（stale） | 用最近一次成功快照，`degraded:true` + 展示 `stale`，并**不参与任何评分**（保守） | `:90-95,192-197`；`quota-cache.js:119-137` |
| 目录读不到 | 该渠道 `unknown` 沉底，不改写注册表 | `livecheck.js:39-48` |

### 4.3 输出契约：现有字段 + 建议新增

**现有 `routes[]`（`lib/tool-query.js:300-358`，required 见 `:360`）**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `rank` | number | 名次（从 1 起） |
| `channel_id` | string | 渠道 id |
| `provider` | string | `routeProvider`（进 assignee 的 provider） |
| `models` | string[] | 注册表模型列表 |
| `channel_type` / `tier` / `priority` | enum / enum / number | 排序三键回显 |
| `balance_source` | `manual` \| `machine` \| `unknown` | 余额来源 |
| `balance` | `{remaining, currency, display, as_of, source, degraded}` | 仅 machine 时出现 |
| `livecheck` | `ok` \| `unknown` | 活校验结果 |
| `reason` | string | 排序理由串 |
| `note` | string | 备注（人工登记/回落原因/目录差异） |
| `warning` | `{reason, suggestion, …}` | 非阻断标注（可选） |
| `review_alert` / `review_alerts` | string / string[] | 复核提醒（可选） |
| `model_capability` | `[{model, 四维}]` | 模型档位（可选，M3.1） |

**建议新增（M4，全部为可选键，缺数据即不出现，不破坏现有消费者）**：

| 字段 | 形态 | 用途 |
|---|---|---|
| `balance.mode` | `amount` \| `window` \| `status`（+ `null`） | 明确余额语义，避免把窗口当金额。**已落地（m4-data）**：`quota-view.js:176,198`；消费侧 `tool-query.js:95-102`（本文原写 `windows` 复数，实现取单数 `window`） |
| `balance.windows[]` | `{label, used_pct, text}` | 窗口型余额第一手数据。**已落地（m4-data）**：`quota-view.js:132-143,199`；`label` 保留快照原文、`text` 保留原始 display |
| `balance.worst_used_pct` | number \| null | 最紧窗口已用百分比。**已落地（m4-data）**：`quota-view.js:200` 取 `max(所有窗口)`（即 Q2 的 N1 口径） |
| `balance.worst_window` | `'5h'` \| `'week'` \| `'month'` \| null | 是哪一档最紧（解释告警来源）。**规划**——现行实现只给 max 值，不指出窗口名 |
| `suggested_model` | string \| null | 本渠道内推荐模型（按 `capability` 需求 + `model_capability` + 目录可用性）。**规划（M4-3，未落）** |
| `suggested_reason` | string | 一句理由（如「glm-5.3 coding=excellent；目录已列出」） |
| `model_catalog` | `{in_sync, missing[], extra[]}` | 与宿主目录的差异（只读提示，M4-2） |
| `meta.ranking_version` | string | 排序算法版本，便于复盘（07 方案已规划） |

**文本渲染对照（现有格式见 `lib/tool-query.js:215-249`；示例假设 M4-4 数据已修正、M4-1/M4-3 已落地）**：

```
模型路由排序表（财务一级键：monthly > voucher > prepaid；tier/priority 次级；标注均不阻断，最终选择权在会话与用户）
自动余额经 quota 插件读取（截至 2026-11-20T…），仅供参考
1. zai-coding-cn → provider=zai-coding-cn models=[glm-5.3] | monthly/domestic_sota/priority 90 | balance=manual
   理由: channel_type=monthly（一级键 包月优先）；tier=domestic_sota；priority=90（同类内降序生效）；id 兜底
   窗口: 本周 3% / 5 小时 1%（未核实，仅参考；需 Q4 开 opt-in）            ←── 新增（M4-1）
   推荐模型: glm-5.3（coding=excellent，目录已列出）        ←── 新增（M4-3）
   备注: 未采信 quota 数值（quota 平台 "zhipu" 映射命中但账户未核实），回落人工登记
```

---

## 5. 实施分档

### 5.1 已实现（M1-M3.5，均为现状）

| 能力 | 里程碑 | 证据 |
|---|---|---|
| 5 键静态全序 + 理由串 | M1 | `lib/ranking.js:1-78` |
| 活校验 unknown 沉底（60s TTL，失败不写缓存） | M1 | `lib/livecheck.js:9,19-51` |
| 查询工具 + 文本渲染 + `tier_min`/`exclude_degraded` | M1 | `lib/tool-query.js:213-251,406-548` |
| 人工登记 + `low_balance` 告警（非阻断） | M1 | `tool-query.js:126-148` |
| quota 快照读取（loopback GET）/缓存/熔断 | M2 | `quota-source.js:111-161`；`quota-cache.js:32-157` |
| machine 采信五道门 + stale 标注 | M2 | `tool-query.js:72-96,192-197` |
| 设置面板编辑器（channels 数组整替保存、冲突重拉） | M3 | `client.js:708-858` |
| 静态层排序预览 `previewRanking`（与 host 同序的 parity 用例） | M3.5 | `client.js:409-445`；`docs/05-m3-devlog.md` §11.5 |
| 模型级 `model_capability`（面板 4 下拉 + 输出可选键 + 文本行） | M3.5 | `config-schema.js:159-165`；`registry.js:42-98`；`tool-query.js:203-210,344-358`；`client.js:570-624` |

> 并发说明（2026-11-20 收口更新）：m4-data 已交付完毕，窗口通道（`mode='window'` + `windows[]` + `worst_used_pct`）已落地，本文 §5.2/§5.3 是**撰写当时**的规划视图；实际落地状态以 §5.4「已落地清单」为准，§6 已按用户裁决定稿。

### 5.2 建议 M4：数据面修正（部分实施中）

| 编号 | 内容 | 落点 | 验收断言 |
|---|---|---|---|
| M4-1 | **窗口余额语义**（**实施中，m4-data**）：`quota-view` 窗口通道先于金额判定、输出 `windows[]/worst_used_pct`（已落）；`tool-query` 透出 `balance.mode/windows/worst_used_pct`（已落）+ `worst_window`（未落）+ `worst_used_pct ≥ 85` 时 `warning.reason='window_high'`（**告警未落**，且 `verified=false` 渠道仍不出现数值） | `quota-view.js:90-123`；`tool-query.js:312-358,451-508` | ① zhipu/opencode-go 行出现 windows（需先开 `quota_account_verified`）；② 金额通道行为不变（deepseek/xiaomi 仍 `machine(¥…)`）；③ 无窗口数据渠道不出现新键、不告警；④ 未核实渠道即使有窗口数据也不采信 |
| M4-2 | **模型列表以宿主目录为提示源**（m4-data 已在 `config-schema.js:39` 补「`models[]` 为编辑期知识、按 `listModels` 首轮复核」的注释，**面板同步 UI 未落**）：面板显示「目录实际列出 N 个 / 注册表 M 个」，提供「采用目录」按钮，点击后由用户确认写回（**不自动改写**）；host 侧 `note` 保留差异提示 | `client.js:626-681`（渠道卡）；`tool-query.js:109-113` | ① 只读展示不触发保存；② 点击后 `channels` 整替 op 生效且 revision 冲突可重拉；③ host 侧无自动写路径 |
| M4-3 | **模型级档位用于 `suggested_model`**：按查询 `capability` 需求 → 候选模型按档位评级排序（excellent > good > fair > 无数据）→ 只取目录内可用者 | `tool-query.js` 新增 `suggestedModelOf`；`registry.js:42-52` | ① 有档位数据的渠道输出 `suggested_model`；② 无数据渠道为 null 且不猜；③ 渠道排序 5 键不变（回归断言与 M3.5 同款） |
| M4-4 | **数据修正**：种子 `models[]` 换成宿主目录现值（zai 3 个、opencode-go/xiaomi 填真实 id、deepseek×2 换 `deepseek-flash`/`deepseek-v4-pro`）；补币种白名单（非 CNY 不采信或强标注） | `config-schema.js:43-124`；`tool-query.js:87-95` | ① `npm run selfcheck` 全绿；② 5 行 `note` 不再出现「未在目录列出」；③ USD 渠道采信路径有断言 |

### 5.3 建议 M5：自动评测（未实现，规划）

- **eval 字段集冻结**（`mroute/07-assembly-plan.md:205`）：`last_run` / `scores{四类}` / `composite` / `suggest{tier,priority}` / `evidence_refs`，追加 `applied_effort`、`instrument_healthy`、`probe{ttft_ms,tps,samples,ttft_spread}`、`fingerprint{system_fingerprint,prompt_tokens,shape_hash,checked_at}`。
- **闭环 = 自研 S3**（`07-assembly-plan.md:81`）：评测 → EvalReport diff → 面板「确认采纳」→ 人写回 `registry_version+1` + `reviewed_at` 刷新。**mroute 只出建议，写回必须人工确认**（advisory 红线在评测链上的延续）。
- 评测结果**不自动进前置排序**；采纳前最多作为 `suggest` 字段展示（与 `capability`、`model_capability` 同等待遇）。

### 5.4 已落地清单（2026-11-20 收口，覆盖 §5.2/§5.3 的规划视图）

| 能力 | 里程碑 | 证据 | 验收 |
|---|---|---|---|
| 窗口型余额语义：`balance.mode='window'` + `windows[]` + `worst_used_pct`，只认 display 的 `已用 N%`（不回退 `item.percent`） | M4 | `lib/quota-view.js:62-260`；`lib/tool-query.js:80-108` | 真机 zai `machine(5h 2% · 本周 3%)`、opencode-go `machine(5h 10% · 本周 11% · 本月 5%)` |
| 模型列表同步 `model_route_sync_models`（默认 dry-run；apply 只写 `channels[].models` + `reviewed_at`） | M4 | `lib/tool-sync-models.js:1-324`；`index.js:96-97` | 五渠道与宿主目录一致，目录告警清零，二次 dry-run 幂等 |
| 动态沉底 `dynamic-state`（周 ≥98% / 5h ≥95% 提示 / CNY <¥10）+ 排序插键 | M4.5 | `lib/dynamic-state.js:1-123`；`lib/ranking.js:69-79` | `selfcheck 95/95`；构造性验证「周 98.5% 沉到 #3、¥5 沉到 #4、5h 96% 仍 #1」 |
| 两个窗口阈值入配置 + 面板输入 | M4.5 | `lib/config-schema.js:221-227`；`client.js:862-863` | 待用户强刷后抽验（可逆自测：周阈值调 1 观察沉底） |
| 跨渠道模型归并：`model_aliases` + `model_route_alias_suggest` + `models_index` + 面板「模型归并」折叠卡 | M4.6 | `lib/config-schema.js:244`；`lib/registry.js:60-117`；`lib/tool-alias-suggest.js:1-376`；`lib/tool-query.js:322-395`；`client.js:833-892` | `selfcheck 106/106`；真机 dry-run 4 组 same-id + 1 条 low-confidence；`routes[]` 零变化 |

**排序键现状（M4.5 后，替代 §4.1 的五键）**：`livecheck unknown → dynamicTight → channel_type → tier → priority 降序 → id 字典序`。动态项**只沉底不提权**：额度将尽的渠道不会越过财务优先级向上顶，符合 Q5 的「能影响排序但保持可复盘」。

**仍未实施（挂 backlog）**：M4-3 `suggested_model`（按查询 capability 标注推荐模型）、M4-2 面板「采用目录」按钮（现由 `model_route_sync_models` 承担，需人在场触发）、§5.3 M5 自动评测（用户第 3 条需求明确放后）。

---

## 6. 裁决结论（2026-11-20 用户定稿）

| # | 问题 | 结论（用户裁决） | 落点/证据 | 状态 |
|---|---|---|---|---|
| Q1 | 模型级档位是否影响渠道排序 | **不影响**。渠道顺序仍按渠道键；模型档位只用于「同一模型跨渠道」的归并视图与档位标注 | `lib/ranking.js` 零改动；`registry.js:84-117`；`tool-query.js:346-395` | ✅ M4.6 |
| Q2 | 窗口型余额的低额度阈值 | **周窗口 ≥98% 沉底、5h 窗口 ≥95% 仅提示**（用户上调了文档建议的 85/90：「周的 98% 之前都不太会影响任务执行」「5h 提示 95% 即可」）；两项阈值入配置可改 | `lib/dynamic-state.js:55-123`；`config-schema.js:221-227` | ✅ M4.5 |
| Q3 | 模型列表以谁为准 | **宿主目录为准**：工具 dry-run 显示差异，apply 由人/会话显式触发，**不自动覆盖**（避免吞人工备注） | `lib/tool-sync-models.js`；`tool-query.js:206-222` | ✅ M4 |
| Q4 | 未核实渠道是否显示 quota 数值 | **默认隐藏**；由用户在面板逐渠道打开 `quota_account_verified`（2026-11-20 五渠道已全开） | `tool-query.js:89-91`；`cordis.patch.yml:375-456` | ✅ M2+M4 |
| Q5 | 动态数据能否改变排序 | **能，但只沉底不提权**：`dynamicTight` 插在 `unknown` 之后、`channel_type` 之前，额度将尽的渠道沉到末位，绝不越过财务一级键向上顶（「有的渠道都快没额度了，再派长程任务会中途断开」） | `lib/ranking.js:69-79`；`dynamic-state.js:82-123` | ✅ M4.5 |
| 附加 | 低余额沉底阈值 | **默认 ¥10**（用户：「10 元够了……就是个默认值」）；非 CNY 不换算、不猜 | `dynamic-state.js:53`；`config-schema.js` `low_balance_threshold_cny` | ✅ M4.5 |
| 附加 | 模型别名 | **要做**，只自动并「同 id 跨渠道」，同族不同名只标 low-confidence 由人确认 | `lib/tool-alias-suggest.js:65-210`；`07-model-aliases.md` | ✅ M4.6 |

### 6.1 原始选项与推荐（历史记录，保留追溯）

| # | 问题 | 选项 | 推荐 | 理由 |

| # | 问题 | 选项 | 推荐 | 理由 |
|---|---|---|---|---|
| Q1 | 模型级档位要不要影响**渠道排序**？ | ① 只用于「推荐模型」标注；② 影响渠道排序 | **①** | 模型强弱是渠道内选择问题；跨渠道压过 `channel_type`/`tier` 会破坏财务红线与可复盘性。且 M3.1 已按「不参与排序」落地，改动需要重审 §4.1 全序键 |
| Q2 | 窗口型余额用哪个窗口做低额度告警？ | ① `max(所有窗口)`；② 周窗口主 + 5h 次（加权/分档）；③ 只展示不告警 | **②**：本周窗口 ≥85% 告警，5h 窗口 ≥90% 另给提示 | 5h 窗口几小时就恢复，把它当主阈值会造成频繁误报；周窗口是真正的预算约束。85% 与 quota 面板自身 `alertPercent` 实测 85 对齐。现行 m4-data 落的是 ①（`worst_used_pct=max`）；若采纳 ②，需在 M4-1 增量里按窗口类型分档 |
| Q3 | 模型列表以谁为准？ | ① 宿主目录自动同步（覆盖注册表）；② 保留纯手工；③ 目录只做提示 + 用户点「采用」才写回 | **③** | ①违反「不改写」红线且会吞掉人工备注；②已经证明会过期（5 行全不一致）；③兼顾准确与用户主权 |
| Q4 | 未核实渠道要不要显示 quota 数值？ | ① 继续完全隐藏（现状：回落 manual + 一句原因）；② 在 `quota_hint` 里只读透出并强标注；③ 直接进 `balance` | **①为默认，②作 opt-in** | 现状符合「映射命中≠账户体系一致」红线；但核对账户时用户需要看到「候选数值」——所以把它做成显式开关（默认关），且永不参与告警/评分 |
| Q5 | 动态数据能否改变排序？ | ① 完全不能（方案 A）；② 仅同档内并列时 tie-break；③ 同档内加权（方案 B） | **①为默认，②可选** | 排序可复盘是派遣记录的前提；②只在 priority 完全相等时生效，抖动面最小，可作为过渡 |

---

## 7. 证据索引

| 证据 | 位置 |
|---|---|
| 全序键 / 理由串 / 活校验沉底 | `plugin-mroute/lib/ranking.js:1-11,14-15,18,25-64,67-78` |
| 输出 schema、渲染、采信门、告警、阈值 | `plugin-mroute/lib/tool-query.js:72-148,168-197,213-251,300-358,406-508` |
| 注册表 schema 与种子 | `plugin-mroute/lib/config-schema.js:26-34,43-124,131-196,199-224` |
| 读侧归一化 | `plugin-mroute/lib/registry.js:42-98,107-179` |
| quota 快照读取 / 归一 / 缓存 | `lib/quota-source.js:28,55-65,111-161`；`lib/quota-view.js:31-69,90-123,167-185`；`lib/quota-cache.js:32-157` |
| 活校验 | `plugin-mroute/lib/livecheck.js:9,19-51` |
| 面板预览与编辑 | `plugin-mroute/client.js:290-346,359-402,409-445,448-456,570-681,708-858,971-1004` |
| M2/M3.5 已实现事实 | `docs/05-m2-devlog.md`（§0/§6/§7）；`docs/05-m3-devlog.md`（§11） |
| M4 窗口余额 / 模型同步 | `docs/05-m3-devlog.md` §12；`plugin-mroute/lib/quota-view.js:62-260`；`lib/tool-sync-models.js:1-324` |
| M4.5 动态沉底 | `docs/05-m3-devlog.md` §13；`plugin-mroute/lib/dynamic-state.js:1-123`；`lib/ranking.js:69-79` |
| M4.6 模型归并 | `docs/05-m3-devlog.md` §14；`plugin-mroute/lib/tool-alias-suggest.js:1-376`；`lib/registry.js:60-117`；`docs/07-model-aliases.md` |
| 本轮裁决原文 | 会话 m01843 / m01854（2026-11-20）：模型档位不影响渠道顺序、98%/95% 阈值、目录为准、未核实隐藏、动态可影响排序、¥10 默认、别名要做 |
| M5 评测字段与闭环 | `mroute/07-assembly-plan.md:81,205,282,288` |
| 宿主模型目录实测 | `C:\Users\sir_c\.dsh\profiles\desktop\cordis.patch.yml:39-121,214-242` |
| quota 快照实测 | 本会话 `GET http://127.0.0.1:55802/plugins/dsh-quota/api/status`（2026-11-20） |

---

**文档状态：已定稿（2026-11-20 用户裁决回注）。** §5.4 / §6 是落地状态与最终结论；§5.2 / §5.3 / §6.1 保留为撰写当时的规划与原始选项，供追溯，不再代表现状。
