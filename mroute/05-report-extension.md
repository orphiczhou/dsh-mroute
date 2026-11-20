# 增补论证报告：设置面板可视化编辑 × 手工评测排名更新（mroute 增补章）

- 树节点：mroute / mroute-W6-extend
- 综合来源：`00-feasibility-report.md`（原综合报告）× `01-dsh-feasibility.md`（W1）× `02-provider-apis.md`（W2）× `03-ui-panel-feasibility.md`（W4，已验收）× `04-eval-feasibility.md`（W5，已验收）
- 报告日期：2026-11-13
- 性质：**本文是 00 的增补章，不改 00 原文**。引用约定沿用 00：`01§X`/`02§X` = 01/02 文档 X 节；新增 `03§X`/`04§X` = 03/04 文档 X 节
- 面向读者：同 00——需要决策「两条新需求是否纳入立项、整体路线怎么排」的用户

---

## 0. 变更摘要（相对 00，一页看清）

| 项 | 00 原表述 | 本增补之后 | 性质 |
|---|---|---|---|
| 总结论 | 可行（5 条需求，「参考工具型」插件） | **不变**；需求面从 5 条扩为 7 条，两条新增均判定可行 | 能力圈扩大，无任何翻转 |
| UI 面板定位 | 「可选，人工查看」（00§3.4-④，排在 M4） | 升级为「注册表可视化编辑器」——settings.section 是一等公民机制（03§A.3 两例实证），从 M4 提前并扩容 | 定位升级（00 原表述作为当时结论仍正确，见 §4.2） |
| MVP 路线 | M1–M4 | M1–M3 不变；M4=注册表编辑器（原 M4 的 UI 部分提前升级）；M5=评测引擎（新增）；M6=策略门整合+外部榜单同步（原 M4 余项） | 重排，理由见 §5 |
| 注册表 schema | 00§3.1 | channel 对象新增 `eval` 子对象（04§D-3，增量兼容）；可 UI 编辑字段在 M1 定稿时即 volatile 化 | 增量兼容，其余 schema 不动 |
| 风险清单 | 00§5 风险 1–7 | 增补风险 8–13 | 追加，不改动原 7 条 |
| 一致性核对 | — | W1§C「派遣参数层拦截不可行」× W5「插件可直调 llm.stream」辨析（本文 §4） | 澄清性说明，00 无需改动 |

---

## 1. 增补结论总览

### 1.1 两条新需求的逐条判定

**新需求 A：在设置面板可视化编辑各级别模型、备用链、优先顺序 —— 完全可行，且是一等公民机制。**

- 设置面板本身就是一个公开 slot 体系：`settings.section` 分区 slot 由壳的 children 声明，「人人可占」——第三方社区插件 dsh-orb 已注册 `orb` 分区（order:25）运行中实证，宿主官方 Models 页也是同构挂载（03§A.1/A.2/A.3）。
- 推荐形态唯一：Client slot + 手写 React（iframe 被 practices.md L33 明文反对，03§B.1）。
- 编辑→持久化链路全部白拿：`settings.mutate`（带 revision 乐观锁）→ `SettingsController.write` → volatile 路径校验 → `configEditor.edit` 落 profile patch（持久+热更+全客户端广播），三层校验（客户端 `settingsSchema.validate` → 宿主 volatile 路径/冲突 → 激活时 Config schema）（03§B.0/B.1/C.1）。
- 关键工程约束：注册表 schema 必须「对象根下固定命名字段各自 `.volatile()`」，不能把整个注册表做成一个 volatile dict（动态路径被拒，03§E.3-1，详见本文 §6 风险 8）。
- 成本已量化：参照宿主同构先例（subagent 授权模型清单页），我们的编辑器约 **400–700 行 React + 词典**（03§D.1）。

**新需求 B：手工触发评测模型能力 → 更新排名 —— 可行，主通道已在源码层证实。**

- 模型调用主通道 = 宿主 llm 服务：`LlmRuntime` 公开 `stream()/prepareCall()`（dsh-llm L2387/L2225），且宿主对话引擎 dsh-agent-loop 本身就是插件、以 `static inject=['llm']` + `loopCtx.llm.stream(request)` 消费（dsh-agent-loop L1298-1306/L877）——评测自动复用适配器、凭据、retry、usage 事件，对派遣链路保真度最高（04§A-0/A-②）。
- 评测资产以自建轻量固定集为主（四类各 10–20 题 + 确定性判分器，零依赖；04§B 含可直接起步的 suite JSON 示例）；promptfoo（MIT、可嵌）v1 不嵌；Python 系评测框架不嵌，其价值由外部榜单同步替代（04§B/C）。
- 排名边界清晰：评测只产 `suggested_tier/suggested_priority` 证据，**人工在面板确认后才写回**（`configEditor.edit` + `registry_version`+1 + `reviewed_at` 刷新）；00§3.1 schema 只需 channel 加一个 `eval` 子对象（04§D-1/D-3/D-4）。
- 成本护栏全套有上游机制支撑：预算帽/余额联动/包月优先全量评/prepaid 冒烟/串行限流/熔断续跑；入口 = 面板按钮（主）+ `model_eval_run` 工具（辅，配 `tools.guard/ask` 防模型自主烧钱）（04§E）。

### 1.2 与原「可行」总结论的关系

**原结论不变，能力圈扩大。** 00§1 的核心判断——「参考工具型插件可行、自动改写不可行也不必要」——没有被 W4/W5 任何新证据动摇（辨析见 §4）。变化在于：

1. 00§2 的覆盖判定从「5 条需求无一条落在不可行区」扩展为「**7 条需求无一条落在不可行区**」（需求对照增补表见 §3）。
2. 00§5 风险 4（能力分层过时）的缓解手段增强：原来只有 `reviewed_at` 人工复核提示，现在多了「评测证据链 + 外部榜单交叉引用」两个保鲜锚点（04§D-3 衔接点②）；但「tier 保持人工语义」的边界不变。
3. 00§3.4-④ UI 面板从「可选，人工查看」升级为「注册表编辑器 + 评测确认入口」——这是产品定位升级，机制上 00 与 03 并无冲突（见 §4.2）。

---

## 2. 更新后完整架构图（文字版，叠加 00§3）

在 00§3 三层架构（注入层/查询排序层/数据层）之上，新增「设置面板分区」与「评测引擎」两个模块、两条数据流。

```
┌─ 注入层 ─────────────────────────────────────────────────────────────┐
│ ① Host Tool: model_route_query（核，模型消费）                          │
│ ② systemPrompt.section：「派遣前先查路由」（一句提示）                    │
│ ⑤ 设置面板分区「模型路由」(settings.section 占位, React) ← W4 新增        │
│    = 注册表可视化编辑器 + 评测入口按钮 + 榜单只读展示 + reviewed_at 复核提示│
│ ⑥ Host Tool: model_eval_run（辅，会话内触发评测，配 tools.guard/ask）←W5 │
└──────┬───────────────────────────────────────────────────┬──────────┘
       │ 读（缓存优先）                                      │ 人工触发
┌─ 查询/排序层 ─▼─────────────────────────────────────┐ ┌─ 评测层（W5 新增）▼─────────────┐
│ model_route_query{capability, budget, ...}          │ │ 触发：面板按钮(主) / 工具(辅)     │
│ = 读注册表 → 逐渠道取余额（缓存优先）                    │ │ 主通道②: ctx.llm.stream /        │
│   → 财务/能力加权排序                                 │ │   prepareCall（凭据/retry/usage   │
│ 排序因子：channel_type > tier > priority             │ │   全复用宿主；保真度最高）          │
│           > eval.composite（tier 内次级，建议性）       │ │ ×①直连 HTTP：连通探针/参数实验     │
└──────┬───────────────────────────────────────────────┘ │ ×③子会话：tier 争议抽检仲裁       │
       │ 两条写链（见下）                                   │ → 自建固定集（四类各10-20题,       │
┌─ 数据层 ─▼──────────────────────────────────────────────┐ │   suite_version 化）             │
│ 模型注册表 = 插件自有 volatile Config                     │ │ → 确定性判分器（JSON schema/      │
│   静态字段：tier/capability/priority/fallbacks/         │ │   关键词/结构断言，零 LLM judge）  │
│     channel_type/reviewed_at —— 各自 .volatile()        │ │ → EvalReport：分项得分+composite+ │
│   eval 子对象：last_run/scores/composite/suggest/...    │ │   suggested_tier/priority+证据链  │
│ 余额获取层：A Key直读 / B AK·CLI / C 未文档化(熔断)        │ │ → 面板 diff 高亮 → 人工「确认采纳」 │
│   / D 人工登记 + 本地 TokenUsage 折算估算                 │ │ → Host 侧 configEditor.edit 写回  │
│ 缓存（≥60s）+ 熔断（失败 N 次 → degraded）                │ │   （registry_version+1、           │
│ 密钥：ctx.credentials / remote.credentials（侧牌，不进 Config）│ │ channel.eval 落摘要、reviewed_at  │
│ 插件数据目录：eval-history/<run_id>.json（逐题明细）       │ │   刷新）→ 下次查询立即生效          │
│              leaderboards/<source>/<date>.json（榜单快照）│ │ 成本护栏：预算帽/余额联动/包月优先/  │
│ 外部榜单同步器（人工触发，只读参考层，绝不自动改 tier）       │ │   串行限流/熔断续跑               │
└─────────────────────────────────────────────────────────┘ └─────────────────────────────────┘
```

### 2.1 数据流一：编辑 → volatile 热更 → 查询工具立即生效（W4 证实）

```
面板「模型路由」分区（React 草稿 state）
  → 读：configForms.describe() 镜像 + remote.llm 目录 + remote.session.modelCatalog（与宿主 Models 页同源）
  → 草稿校验：settingsSchema.validate(schema, draft)            ← 客户端第一道
  → configForms.get(ns).mutate(ops, draftRevision)              ← 每 namespace 串行队列
  → remote.settings.mutate → ctx.settings.write
      volatile 路径校验（非 volatile 路径直接抛错）+ revision 冲突检查
      （陈旧写 → settings/conflict → 客户端重读重试，非错误）
  → configEditor.edit(entry, fn) → profile patch（持久化，重启仍在）
  → volatile 引用热更（[write] 协议）→ emit settings/document-updated（全客户端广播）
  → model_route_query 下一次调用立即读到新注册表（不重启插件）
密钥路径：编辑器只显示侧牌（set/unset）→ remote.credentials.set/unset，值不过读线
```

依据：03§B.0/B.1/C.1/E.2。

### 2.2 数据流二：评测 → 建议 → 人工确认 → 写回（W5 证实）

```
人工触发（面板按钮 / model_eval_run 工具 + tools.guard/ask 人工确认）
  → 评测 run：通道② ctx.llm.stream 串行逐题（usage 累计、熔断监控、断点保存）
  → run 完成：生成 EvalReport（分项得分 + composite + suggested_tier/priority
     + 证据链：分数阈值 + 外部榜单交叉引用）
  → 面板展示 diff：当前 tier/priority vs 建议（红绿高亮，附 eval 元数据）
  → 人工点「确认采纳」→ Host 服务 configEditor.edit() 原子写回
     （registry_version+1、tier/priority 更新、channel.eval 落摘要、reviewed_at=今天）
     ——或点「忽略」→ 留档不写回
  → 下一次 model_route_query 即吃到新排名；systemPrompt 提示层无需改动
```

依据：04§D-4。**注意两条写链的分工**：编辑器的常规编辑走数据流一（client 侧 `settings.mutate` 写 volatile 路径）；评测「确认采纳」走数据流二（Host 侧 `configEditor.edit` 一次原子完成 `registry_version`/`tier`/`priority`/`eval`/`reviewed_at` 多字段联动）——后者是 03§C.3 记载的「操作类」正规通道（user-actions.md「一个操作、两个调用方」），两者不冲突、各得其所。

---

## 3. 需求对照增补表

| # | 新需求 | 技术支撑点 | 依据 |
|---|--------|-----------|------|
| 6 | **设置面板可视化编辑**各级别模型/备用链/优先顺序 | ① `settings.section` 分区 slot 是公开合同，第三方占位有两例在线实证（dsh-orb order:25、官方 models 页同构挂载）；② 形态唯一推荐 Client slot+React（iframe 被 practices.md 明文反对）；③ 注册表=自有 volatile Config：设置面板可寻址、热更、持久（profile patch）、revision 冲突保护、失效广播全白拿；④ provider/model 候选列表读 `remote.llm.listConfigurableProviders()`/`remote.session.modelCatalog()`（与官方页同源零维护）；⑤ 编辑保存三层校验 + `settings/document-updated` 广播后查询工具立即生效；⑥ 表单只三类控件（有序列表/下拉/增删行），约 400–700 行 | slot 机制 03§A.1–A.3；形态对比 03§B.1；写链与持久化 03§B.0/B.1/C.1；provider 目录合同（settingsNs+settingsPath）03§C.2；控件成本 03§D.1；逐点判定 03§E.1、推荐形态 03§E.2 |
| 7 | **手工评测模型能力 → 更新排名** | ① 通道②宿主 llm 服务：`LlmRuntime.stream()/prepareCall()` 公开（源码行号在案），决定性先例 = dsh-agent-loop 即插件、`static inject=['llm']` 消费；自动复用适配器/凭据/retry/usage，对派遣链路保真度最高；② 通道①直连 HTTP 只做连通探针与参数实验；通道③子会话只做 tier 争议仲裁；③ 评测资产自建固定集（四类各 10–20 题 + 确定性判分，零 LLM judge 零依赖）；④ 排名：v1 加权百分制（Elo 小样本缓行，provisional 门槛 n<8）；⑤ 评测只产 `suggested_tier/priority`，人工面板确认后 `configEditor.edit` 写回 + `registry_version`+1 + `reviewed_at` 刷新；00§3.1 只需 channel 加 `eval` 子对象；⑥ 成本护栏：预算帽/余额联动（余额<预估×3 拒跑）/包月优先全量评/prepaid 冒烟/串行限流/熔断续跑；⑦ 外部榜单（Aider 最易抓、SWE-bench 内嵌 JSON、LiveCodeBench 版本化、LMArena 社区镜像）= 只读参考层 | 通道判定 04§A-0/A 对比表/§F 判定 1–2；评测资产 04§B（含 suite JSON 示例）；榜单 04§C；排名体系 04§D-1/D-2；schema 衔接 04§D-3；流程 04§D-4；成本护栏 04§E |

---

## 4. 一致性核对说明（重要）

### 4.1 「派遣参数层拦截不可行」与「插件可直调 llm.stream」并不矛盾

这两句话经常被放在一起读，容易误以为 W5 推翻了 W1。**它们说的是两个不同动作主体 × 不同对象 × 不同目的的操作**：

| | W1§C-①（判定不可行） | W5§A-0（证实可行） |
|---|---|---|
| 动作主体 | 插件 | 插件自己 |
| 操作对象 | **别人**（lead 会话派遣工具）发起的派遣请求的参数/路由 | **自己新发起**的一次模型调用（评测用途） |
| 动作 | 改写（rewrite）别人的请求——宿主 `tools/pre-execute` 契约只有 "Allow, deny, cancel, or ask"，`tools/execute` 只管 "timeout, retry, or metrics"，**没有 rewrite 通道** | 作为 llm 服务的普通消费者发起调用：`ctx.llm.stream(options)` 构造自己的 options、消费返回的 chunk 流 |
| 类比 | 不能篡改别人已填好的派单 | 自己下单完全没问题 |

机制上的本质区别：**请求的所有权**。宿主有意不开放「改写他人派遣参数」的通道（否则任意插件可互相干扰派遣语义）；而「插件作为服务消费方自己发起模型调用」与插件调 `ctx.connection.fetch` 发 HTTP 是同一性质——llm 服务就是宿主公开的基础设施，谁都可以用（04§A-0 的决定性证据：宿主自己的对话引擎 dsh-agent-loop 就是以插件形态这样消费的）。

**还要澄清与 W1§C-②（llm/stream waterfall 理论改道）的关系**：W5 的评测方案**不依赖、也不经过**改写环节——它正常构造 options 发起调用并消费流。即使宿主装了 `llm/stream` waterfall 监听器（比如 token 计量插件），对评测请求的影响也只是「看得见」（04§F 遗留点 2 的可见性问题），不是「被改道」。因此 W5 的成立**不以** W1 已判定为高风险、明确不做的 C-② 通道为前提——两者彻底解耦。

### 4.2 00 报告有无因 W5 新证据需要微调的表述（逐条检查，均不改 00 原文）

**检查项 1：00§5 风险 5「GenerateOptions 可变语义未逐行验证」——适用范围需要辨析，结论不变。**

W5 逐行读了 `dsh-llm/lib/index.js`，新增事实是：

- `resolveCallWithInfo`（L2188-2212）读到的**请求控制面**只有 `maxTokens`/`reasoningEffort`/signal；`prepareCall`（L2225-2266）冻结 handle 后一次一投；`stream`（L2387-2403）经 waterfall 派发。

这对风险 5 的影响是**收窄了未知范围、但没有解除未知**：

- **已证实**（构造侧）：`GenerateOptions` 的 `provider/model/messages/tools/maxTokens/reasoningEffort` 字段在「插件自己发起调用」这条路径上有效且语义明确——这正是 02 通道的全部所需。
- **仍未验证**（改写侧）：在 `llm/stream` waterfall 监听器里改写 `options.route` 之后，下游 `next()` 是否遵守新值、改动与 retry/replay 的交互语义、如何区分调用方（父会话/compaction/标题生成）——风险 5 的核心疑问原封不动。
- **顺带仍未验证**（04§F 遗留点 1）：temperature/top_p 等采样参数是否透传（需要固定采样的题目 M5 首跑前先做一次字段验证，或该类题走通道①，见 §6 风险 13）。

**判定**：风险 5 讲的场景是「自动改写**别人**请求的 route」（§4.1 表中的左列），评测功能走的是「自己发起调用」，根本不触碰改写环节——所以风险 5 的结论「**明确不做，仅存档为理论通道**」**维持不变**，同时其适用范围**不覆盖**评测功能。00 原文无需改动；如未来有人拿 W5 的源码行号质疑「不是说没逐行验证吗」，以本节辨析为准：验证的是构造侧，未验证的是改写侧。

**检查项 2：00§1/§3.4-④「UI 面板作为人工查看的可选件」——定位升级，非结论冲突。**

00 把 UI 面板定位为「可选、人工查看、放 M4」；W4 证实设置面板分区是一等公民机制且挂载零风险。两者不矛盾：00 的「可选」是**产品优先级选择**（当时无 W4 证据，保守排序），不是机制限制断言。W4 之后产品定位升级为「编辑器」（本文 §5 重排），00 原文作为当时的保守判断保留不动。

**检查项 3：00§3.1 注册表 schema——增量兼容，无冲突。**

W5 只需 channel 对象加一个 `eval` 子对象（04§D-3），其余字段（tier/capability/priority/fallbacks/channel_type/balance/manual/reviewed_at）全部不动；逐题明细落插件数据目录不进 Config，保持 Config 可读可 diff。新增的唯一**横向**约束来自 W4：可 UI 编辑字段必须各自 `.volatile()`——这是对 00§3.1 schema 的**实现层附加要求**（00 schema 本身形状不变），在 §5 的 M1 验收增补里落实。

**检查项 4：00§5 风险 4（能力分层过时）——缓解增强，边界不变。**

W5 给风险 4 增加了两个保鲜锚点（评测证据链、外部榜单交叉引用，均挂进 `reviewed_against`），但「tier 是编辑期人工知识、评测只产建议」的边界由 04§D-1 明确保留。与 W1§C-③（插件没有每会话动态下发宿主 policy 的公开 API）也核对过：**评测写回的是插件自有注册表 Config，不是宿主 `subagentModelSelection` 的 allowedModels policy**——后者仍由用户在宿主设置页管理，两者作用面不同（mroute 注册表影响推荐排序，宿主 policy 影响硬性允许集），W4 的面板编辑器也不触碰宿主 policy（03§E.1 已判定编辑宿主注册表「可行但有界」）。

**检查项 5：00§7「不建议做的部分」——不变。** llm/stream 全局改道仍不做；第一版不追求 10 渠道全覆盖仍成立。

**总结论：00 无一处需要修改；W4/W5 的全部新证据要么扩大能力圈（§1），要么收窄既有风险的未知范围（检查项 1），要么增强既有风险的缓解（检查项 4）。**

---

## 5. 更新 MVP 路线（M1–M6，重排）

### 5.1 重排方案

| 期 | 内容 | 相对 00 的变化 |
|---|------|---------------|
| M1 | 静态注册表 + 查询工具 + manual 登记 | **不变**；验收标准增补 2 条（见 5.2） |
| M2 | A 类自动余额 + 缓存 + 熔断框架 | 不变 |
| M3 | B/C 类适配器 + D 类本地估算 + 券衰减 | 不变 |
| M4 | **注册表可视化编辑器**（settings.section 分区 + React 编辑器 + manual 登记/复核面板化） | **提前并扩容**：原 M4 的「UI 面板」部分升级为编辑器 |
| M5 | **评测引擎**（自建固定集 + 判分器 + 通道②评测 + 建议 + 面板确认写回 + 成本护栏） | **新增** |
| M6 | 策略门整合（tools.guard + policy 交集）+ 外部榜单同步 | 原 M4 余项 + 04§C，收尾 |

### 5.2 重排理由

1. **编辑器提前（原 M4 → 新 M4，紧跟 M3）**，三个理由：
   - **机制风险≈0**：W4 已验收，一等公民先例（dsh-orb、官方 models 页）在线运行，03§D.1 已把成本量化到 400–700 行——是最「稳」的一块增量；
   - **反哺 M1–M3 的运维体验**：manual 人工登记、reviewed_at 复核、余额阈值调整是 M1–M3 期间的持续性人工操作，靠改 cordis.patch.yml 重启插件体验差且易错；面板上线后这些操作全程可视化，人工维护成本立刻下降；
   - **M5 的前置依赖**：评测「确认采纳」的 diff 展示与确认按钮就在面板上（04§D-4），编辑器必须先行。
2. **评测放 M5（新增）**：依赖 M1 的 schema 预留位（`eval` 子对象）与 M4 的确认写回 UI；评测引擎自身复杂度（判分器/护栏/写回联动/预算帽）值得单独立期，不与 UI 期混杂，便于把「真实渠道额度消耗」的风险暴露隔离在独立验收期内。
3. **策略门整合 + 榜单同步放 M6 收尾**：tools.guard 拒绝与 policy 交集过滤是防御性增强，不阻塞主链路；外部榜单是只读参考层（绝不自动改 tier），优先级天然最低。原 M4 的这两项没有消失，只是让位给编辑器。

**备选方案**（供用户选择）：如果可视化编辑的诉求最迫切，可以把编辑器插到 **M1.5**（M1 验收后立即做），代价是 M1 刚结束就摊开 UI 工程。默认不推荐——M2/M3 的余额自动化对「参考价值」的增益大于编辑器的体验增益，且 M1 期用 yml 手动登记完全可用。

### 5.3 验收标准增补（M2/M3 沿用 00§6 原标准，其余各期增补如下）

**M1（增补 2 条）**：
5. 注册表 schema 按 volatile 化定稿：tier/priority/fallbacks/channel_type/manual/reviewed_at 等可 UI 编辑字段各自 `.volatile()`，通过「对象根下固定命名字段」结构审查（不能整表一个 volatile dict）；
6. channel 对象预留 `eval` 子对象位（可为 null/空对象），schema 演进文档注明 M5 将填充的字段清单（对齐 04§D-3）。

**M4（编辑器，全条新增）**：
1. 设置弹窗出现「模型路由」分区，导航可点、可用 `openSection('model-route')` 编程直达；order 落在 models(10) 与 orb(25) 之间（建议 15–20）；
2. tier/priority/fallbacks/manual/reviewed_at 全部面板可编辑；保存后**不重启插件**，`model_route_query` 立即读到新值（数据流一端到端验证）；
3. 并发编辑冲突可恢复：制造 revision 冲突（另一客户端先保存）→ 得到 "Settings changed elsewhere" 类可读提示 → 重读后草稿不丢数据；
4. 密钥字段只显示侧牌（set/unset），任何读面（describe/工具返回/日志）无明文；
5. 非法值双保险：客户端 `settingsSchema.validate` 拦截（如 fallbacks 引用不存在的渠道 id），宿主激活时 Config schema 校验兜底；
6. 面板控件与宿主视觉一致（theme token、明暗切换、locale），无跨插件 import（构建通过 purity gate）。

**M5（评测，全条新增）**：
1. 面板「运行评测」按钮触发后，通道②串行逐题跑通四类固定集，产出 EvalReport（分项得分/composite/suggested_tier/priority/证据链）；
2. 成本护栏生效：预估超 `per_run_cny_max` 拒跑；run 中 usage 累计超限即停且保留 `partial` 结果；余额 < 预估×3 拒跑（A/B 类机读渠道验证）；prepaid 渠道默认 5 题冒烟，全量需人工确认；
3. 「确认采纳」写回联动正确：`registry_version`+1、`channel.eval` 落摘要、`reviewed_at`/`reviewed_against` 刷新，下一次查询排序吃到新 priority；「忽略」留档不写回；
4. provisional 门槛生效：某类 `n_samples < 8` 或成本缺失 → 分数标 provisional，不参与 tier 建议与排序理由；
5. `model_eval_run` 工具触发时 `tools.guard/ask` 人工确认弹出，工具 description 明写「评测消耗真实渠道额度」；
6. 逐题明细落 `eval-history/<run_id>.json`（Config 保持可读可 diff）；判分器无 eval/new Function（安全面，04§B）。

**M6（策略门 + 榜单，全条新增）**：
1. 对 `manual.status=disabled` 或余额低于阈值的渠道，派遣守门给出含替代建议的可读拒绝；policy 交集过滤生效（排序前按会话 policy 过滤，01§B-4/B-6）；
2. Aider/SWE-bench 榜单人工触发抓取成功，落 `leaderboards/<source>/<date>.json`，面板只读展示（external_ref 交叉引用，绝不自动改 tier）；
3. 榜单模型名 alias 未映射条目进「待人工映射」队列，不进面板交叉引用；LMArena 镜像失败时熔断降级页面抓取、再失败标「同步失败于 <date>」。

---

## 6. 风险增补（承接 00§5 编号，R8–R13）

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 8 | **volatile 字段硬约束**：settings 写面逐路径校验 volatile，动态路径被拒（schemastery 报 "volatile fields require a fixed object path"）——把整个注册表做成一个 volatile dict 会直接不可编辑；数组字段是整体替换语义 | 中（设计期一次性规避） | M1 schema 定稿即「对象根下固定命名字段各自 `.volatile()`」（03§E.3-1）；数组编辑统一整条替换（mergeLayers 语义正好匹配列表编辑，03§E.3-2）；M1 验收第 5 条做结构审查 |
| 9 | **client purity gate**：跨插件**值导入**被构建门禁禁止（"forbids cross-plugin value imports"），想复用宿主 UI 组件的 import 写法会构建失败 | 低（规范即可规避） | 控件照抄宿主 primitives 的 markup+CSS+行为、类名改插件前缀、颜色只用 `--dsw-alias-*` token；协作一律走 cordis 服务注入（`inject:[...]` 只声明激活顺序 ≠ 可 import）（03§D.2）；M4 验收第 6 条以构建通过为准 |
| 10 | **模型名 alias 映射人工校准**：各榜单命名不规范（alias/日期后缀/托管渠道前缀），错误映射会让榜单分数张冠李戴到错误 model 上 | 中 | 人工校准 `model_alias` 映射表；未映射条目进待人工映射队列、不进面板交叉引用；榜单层整体是只读参考层不自动改 tier，最坏影响被限制在「人工参考误导」（04§C）；M6 验收第 3 条 |
| 11 | **评测成本失控**：评测消耗真实渠道额度；无护栏时全渠道全量跑可能烧穿 prepaid 余额；更隐蔽的是模型自主调用 `model_eval_run` 烧钱 | 中高 | 四层护栏全上：预算帽（per_run/monthly）+ 余额联动（余额<预估×3 拒跑）+ 包月优先全量/prepaid 冒烟 + 串行限流与熔断续跑；工具入口配 `tools.guard/ask` 人工确认、description 明写烧钱警告（04§E）；预算帽配置本身放 volatile Config 可面板调整 |
| 12 | **面板 locale 覆盖**：宿主设置页惯例 8 语种，只注册 zh/en 是否被 locale 服务接受未验证（03§遗留点 3）；缺失语种可能回落英文或显示 key | 低 | 保守跟随惯例注册 8 语种（词典为机械翻译成本，models/subagent 两页均如此）；先 zh/en 实测 locale 服务行为再决定是否补全（03§E.3-4 同类保守策略） |
| 13 | **评测采样参数控制面未证实**：`GenerateOptions` 是否透传 temperature/top_p 未验证（读到的控制面仅 maxTokens/reasoningEffort/signal，04§F 遗留点 1）——需要固定采样参数的题目可能测不出预期分布 | 低 | M5 首跑前对该字段做一次验证实验（通道②发一个带采样参数的调用看行为）；未证实前该类题走通道①（直连 HTTP 采样全自由，04§A-①）；不影响四类固定集的主体（其判分不依赖采样参数） |

---

## 7. 最终建议：完整立项视图

### 7.1 七条需求全覆盖

| # | 需求 | 判定 | 承接期 |
|---|------|------|--------|
| 1 | 能力分层（overseas/domestic/bulk） | 可行（注册表 tier + 运行时活校验；M5 后另有评测证据链） | M1（+M5 增强） |
| 2 | 财务优先级：包月 > 券 > 预充值 | 可行（channel_type 三级 + 机读/折算/衰减） | M1–M3 |
| 3 | fallback 备选链 | 可行（fallbacks[] + 宿主缺省链回落语义） | M1（M4 可视化编辑） |
| 4 | 余额/用量查询 | 可行（A/B/C/D 四级渐进，全自动→纯人工） | M1–M3 |
| 5 | 动态能力变化保鲜 | 可行（活校验+熔断+reviewed_at；M5 后增加评测/榜单锚点） | M1–M3（+M5/M6 增强） |
| 6 | **设置面板可视化编辑**（新） | **可行（一等公民机制，两例在线实证）** | M4 |
| 7 | **手工评测→排名更新**（新） | **可行（主通道源码证实，护栏齐备）** | M5（榜单部分 M6） |

七条需求中没有任何一条落在「技术不可行」区；两条新增需求的机制风险反而是全表最低的（均有宿主一等先例在线背书）。

### 7.2 M1 起步路径：不变，只加两条零成本定稿要求

**M1 本周可启动的路径完全不变**：定稿注册表 schema → 实现 `model_route_query` + 排序引擎 + manual 登记 → 在本机 5 个 provider 上跑通「查询→选路→派遣」闭环。唯一增补是 §5.3 的两条验收（schema volatile 化定稿 + 预留 `eval` 子对象位）——这两条在 M1 定稿时成本几乎为零，但**避免后期两类返工**：非 volatile 字段后面要迁移用户配置才能面板编辑；eval 子对象后补要动 schema 演进兼容。

### 7.3 排期取舍建议（若时间有限）

- 编辑器（M4）与评测（M5）相互独立、可按需取舍：编辑器服务「降低日常运维成本」，评测服务「能力分层的证据保鲜」；
- 唯一的软依赖是评测的确认 UI 在面板上体验最好——若跳过 M4 直接做 M5，「确认采纳」可临时退化为 03§C.3 的 session command/操作通道，但不推荐；
- M6 的策略门与榜单是纯增强，缺了不阻塞任何主链路。

### 7.4 一句话结论

**立项建议从「值得做」升级为「值得做，且现在有 7 条需求的完整可行图景」：原参考工具型内核（M1–M3）起步路径不变；W4/W5 把插件从「只读参考工具」扩展为「可可视化运维 + 有证据链自保鲜」的完整工具——设置面板编辑器是一等公民机制上的低成本高收益件（提前到 M4），评测引擎在「人工确认才写回」的边界内安全可控（新增 M5），两者都不触碰 00 已明确不做的 llm/stream 改道红线。**

---

*本增补章结论以 03/04 两份已验收调研原文为准；与 00/01/02 的一致性核对见 §4。00 原文未做任何改动。*
