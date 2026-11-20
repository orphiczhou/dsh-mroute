# mroute 需求说明书（01-requirements-spec.md）

- 文档编号：docs/01
- 版本：v1.2（2026-11-13；v1.1 同日审计回注、v1.0 初版同日）
- 状态：评审通过——三视角专家审计 blocker=0、放行 M1（docs/03-audit-report.md §6）；v1.1 含审计 B 组 7 项回注；**v1.2 含用户方向澄清校准：advisory-only（建议不强制），FR-A6 由阻断降级为 warning 标注**；修订记录见文末附录 A
- 上游依据：`mroute/00-feasibility-report.md`（可行性综合）、`mroute/05-report-extension.md`（增补论证，M1-M6 重排）、`mroute/06-market-scan.md`（市场扫描与空白确认）、`mroute/07-assembly-plan.md`（工程组装方案）。本文不改上游任何原文；引用一律用章节号（如 `00§2`、`05§5.3`、`07§3.5`）。
- 引用约定：`00§X` / `05§X` / `06§X` / `07§X` = 对应上游文档 X 节；上游内部转引 01–04 专项调研时写为「00§Y 引 0Z§W」。
- 读者假设：**未读过上游文档**。第 0 章内联全部必要背景。

---

## 0. 背景速览（内联上下文，可跳过若已读上游）

- **DSH**（DeepSeek Harness）是一个多会话 AI 代理运行时。其「指挥官→工人」模式下，主会话（lead）通过派遣工具（如 `tree_dispatch`、`subagent`）把任务派给子会话，派遣参数里的 `assignee` 字段指定子会话用哪个 LLM provider/model。
- **多渠道成本结构**：用户通常同时持有三类计费渠道——①**包月套餐**（如 GLM Coding Plan、火山方舟/Anthropic Max 订阅，按月付费用量配额）；②**限期算力券**（如阿里云代金券/资源包，有到期日）；③**预充值余额**（如 DeepSeek 官方按量付费账户）。三者是**独立额度池**：包月有剩余不代表预充值有钱，反之亦然（00§2 #2、02§三.Q1，经 00§2 引用）。
- **痛点**：lead 派遣子会话时，宿主只提供「哪些模型可用」（`list_subagent_models`），不提供「**该优先用哪个**」。结果常见两类浪费：包月配额还剩很多却烧预充值现金；算力券快过期却没用掉。目前选路完全靠人脑记忆，无法机读。
- **已排除的错误方向**：「插件自动改写派遣参数里的模型」不可行——宿主 `tools/pre-execute` 契约只有 allow/deny，**没有 rewrite 通道**（00§1，依据 01§C-①）。因此本产品定位是「**参考 + 提醒标注**」：派遣前给 lead 一张带理由的排序表，最终选择权与重试都在 lead。
- **可行性结论**：七条需求全部可行、无一落在技术不可行区（00§2、05§1.2）；市场 10,778 个插件中无同类全家桶（06§三）。

---

## 1. 背景与问题陈述

### 1.1 问题一：派遣子会话没有选路参考

lead 每次派遣都要在多个 provider/model 里挑一个填进 `assignee`。宿主机制只保证「选错了会被策略门拒」（`assertAllowedModelSelection`，00§2 #3 引 01§C-①），不回答「该选哪个」。缺参考的后果：

1. **财务浪费**：不记得哪家包月还有量、哪张券快过期，默认走预充值现金渠道；
2. **能力错配**：重型代码任务派给 bulk 档小模型，或轻任务浪费 overseas_sota 档额度；
3. **派遣中途失败**：渠道额度已耗尽/接口已失效仍被派上去，工人会话半路死亡，指挥官反复重试。

### 1.2 问题二：余额数据碎片化且口径不一

10 个主流渠道的余额可得性分四级（00§2 #4 引 02§二）：A 类 4 家模型 Key 直读、B 类 3 家 AK/CLI 另类凭证、C 类 1 家未文档化接口（随时可失效）、D 类仅人工登记。包月套餐仅 2/10 官方可机读（火山方舟、阿里百炼，00§2 #2 引 02§三.Q1），其余包月只能「人工登记总额 + 本地 TokenUsage 按官方系数折算估算」（社区插件 DSH-TOKEN-feiyong 已验证对账比值 1.0000，00§2 引 02§三.Q1）。算力券剩余大多可查、**过期时间基本不可查**（唯阿里云资源包例外），过期日须人工一次性登记（00§2 引 02§三.Q2）。用户目前没有任何一个工具把这些碎片拼成「派遣时点的机读排序参考」。

### 1.3 问题三：能力分层知识会过时

「overseas_sota / domestic_sota / bulk」这类分层是**编辑期知识**，模型升级、渠道下线都会让它失真（00§5 风险 4）。需要复核锚点（`reviewed_at`）与可选的评测证据链来保鲜。

### 1.4 产品回答

做一个 DSH 插件 **mroute**：核心是一个派遣前查询工具 `model_route_query`，读插件自有「模型注册表」（Config 承载），逐渠道取余额（缓存优先），按「财务优先级 × 能力分层 × 健康/额度状态」产出带理由的排序表；辅以设置面板（注册表可视化编辑 + 评测入口）与评测引擎（只产建议、人工确认才写回）。**只做参考与提醒标注，不改写任何请求、默认不阻断任何派遣**（00§1；advisory-only 方向见 NFR-0）。

---

## 2. 目标用户与场景

### 2.1 目标用户

| 画像 | 描述 | 核心诉求 |
|---|---|---|
| P1 多渠道重度派遣用户 | 同时持有 ≥2 类计费渠道（包月/券/预充值），每天派出十次以上子会话的 DSH 用户 | 别烧错池子：包月券先用，预充值兜底 |
| P2 单渠道轻量用户 | 只有一两个渠道，但希望派遣别撞上额度耗尽 | 派遣前知道「还有没有量」；耗尽前有备选 |
| P3 模型尝鲜者 | 频繁接入新模型/新渠道 | 新模型快速上手评估并进排名，而不是凭感觉填 tier |

### 2.2 三个核心用户故事

- **US-1（派遣前选路）**：作为 P1 用户，当 lead 要派一个 coding 类子会话时，我希望它先调用 `model_route_query{capability:"coding", tier_min:"domestic_sota"}` 拿到一张「包月优先、带余额与排序理由」的表，让这次派遣落在包月配额内，而不是默认烧我的预充值现金。
  - 验收指向：FR-A1、FR-A2、FR-E1。
- **US-2（余额耗尽前切换）**：作为 P1/P2 用户，当某渠道额度耗尽或接口熔断时，我希望排序表把它沉底/出列并标注原因（`exhausted`/`degraded`），lead 按表顺序换下一项即可完成派遣；全部渠道耗尽时明确告诉我「等最近一次 reset」，而不是硬派一个必死的派遣。
  - 验收指向：FR-B5、FR-B6、FR-A4、FR-A5、FR-A6。
- **US-3（新模型上手评估）**：作为 P3 用户，接入一个新模型后，我希望在面板点一次「运行评测」（有预算帽保护），得到分项得分与 `suggested_tier/suggested_priority` 建议；我人工点「确认采纳」后它才写回注册表并影响后续排序——机器永不擅自改我的分层。
  - 验收指向：FR-C1～FR-C4、FR-D1、FR-D2。

---

## 3. 需求总览与编号规则

### 3.1 原始七需求（上游论证的需求面）

| 编号 | 原始需求 | 上游出处 |
|---|---|---|
| REQ-1 | 能力分层（overseas_sota / domestic_sota / bulk） | 00§2 #1 |
| REQ-2 | 财务优先级：包月 > 算力券 > 预充值 | 00§2 #2（引 02§三.Q3.3） |
| REQ-3 | 替代备选（fallback 备选链；被策略门拒换下一项） | 00§2 #3 |
| REQ-4 | 剩余 token / 余额查询 | 00§2 #4（引 02§二） |
| REQ-5 | 动态能力变化保鲜（渠道上下线、余额波动、接口失效） | 00§2 #5 |
| REQ-6 | 设置面板可视化编辑各级别模型/备用链/优先顺序（增补） | 05§3 #6 |
| REQ-7 | 手工评测模型能力 → 更新排名（增补） | 05§3 #7 |

### 3.2 FR 编号规则

- 功能性需求编号 `FR-<组字母><序号>`，全局唯一，五组：A 派遣选路、B 额度感知、C 评测排名、D 面板运维、E 基础设施。
- 每条 FR 含：描述 / 优先级（P0 必做核心、P1 重要、P2 增强）/ 承接里程碑 / 可测验收标准（AC 编号 `<FR>-<n>`）。
- 验收标准纪律：全部可测（给输入可判真伪），禁「体验良好」类表述。上游已有验收原文的（00§6、05§5.3）逐条承接并标注出处；上游给建议值未定死的（如复核阈值「如 90 天」）由本文明确取值并标注「本说明书设定值」。

---

## 4. 功能性需求（FR）

### 4.1 FR 组 A：派遣选路

#### FR-A1 派遣前查询工具 `model_route_query`
- **描述**：Host Tool，会话内可调用。入参全可选（缺省=全量排序表）：`capability`（能力需求）、`tier_min`（最低档位）、`budget`（v1 仅 `monthly_first` 一档）、`exclude_degraded`（剔除 degraded，缺省只降权标注）、`refresh`（绕过缓存）。返回结构含 `current / routes[] / excluded[] / inherit_fallback / meta` 顶层键，每条 route 含 `rank/channel_id/route{provider,model}/tier/channel_type/efforts/description/quota/health/policy/dispatch_precheck/score/reason/review_alerts`（07§3.4 返回 schema **草案**参照；正式合同面以实现期冻结的工具 output.schema 为准，上游草案演进不回溯改判——audit m-13）。
- **优先级**：P0；**承接期**：M1。
- **验收标准**：
  - FR-A1-1 插件安装激活后，`model_route_query` 在会话内可调用，返回带排序理由的渠道列表（含 manual 余额与「人工登记」标注）〔00§6-M1.1〕。
  - FR-A1-2 一次真实调用的返回结构与插件工具声明的 **output.schema** 逐键一致（缺失/多余键即不通过）；07§3.4 仅作草案参照、不作为验收判据〔措辞修订 audit m-13：防上游草案演进致规格被动失真〕。
  - FR-A1-3 无可用路由时返回不填 `provider/model`，并明示「子代理继承父路由」的 inherit 降级语义〔07§3.6-S5-③〕。
  - FR-A1-4 返回文本中不出现任何渠道端点的上游原始响应 JSON（只含 QuotaView 归一化字段）〔07§3.4 返回纪律〕。

#### FR-A2 财务三级排序引擎
- **描述**：`channel_type` 为排序一级键：monthly(0) < voucher(1) < prepaid(2)；同档内 `priority` 降序；再以 `routeProvider` 字典序兜底，保证确定性全序。包月与预充值是独立额度池，排序不跨池相加、不拿「有余额」冒充「套餐有剩余」（00§3.1 设计要点）。M5 起 `eval.composite` 作为 tier 内次级**建议性**因子进入感知层（05§2 架构图排序因子）。引擎为纯函数，产出 DecisionRecord（见 FR-E2）。
- **优先级**：P0；**承接期**：M1（L1 静态层+L2 空账本占位），M5（eval 因子启用）。
- **验收标准**：
  - FR-A2-1 构造含 monthly/voucher/prepaid 各 ≥1 渠道的注册表，返回全序中 monthly 全部排在 voucher 之前、voucher 全部排在 prepaid 之前〔07§3.6-S4〕。
  - FR-A2-2 同 `channel_type` 内 `priority` 高者排前；`priority` 相同按 `routeProvider` 字典序；同一注册表+同一账本输入连续两次调用，输出全序逐字节一致〔07§3.6-S4〕。
  - FR-A2-3 口径分立：机读高余额的 prepaid 渠道不得排到人工登记的 monthly 渠道之前（以一次构造用例的 DecisionRecord 排序步骤为证）。

#### FR-A3 tier 能力分层与过滤
- **描述**：注册表 `tier ∈ {overseas_sota, domestic_sota, bulk}` 与 `capability` 子字段（coding/tools/long_context/vision 等，**评级字符串语义**，对齐上游 00§3.1 `"coding": "good"` 口径）为编辑期知识，必须带 `reviewed_at` 保鲜；`provider/models` 为运行期知识，每次查询用 `llm.listProviders()/listModels()` 活校验（00§2 #1、00§3.1 设计要点）。`tier_min` 与 `capability` 入参做前置过滤。
- **优先级**：P0；**承接期**：M1。
- **验收标准**：
  - FR-A3-1 `tier_min="domestic_sota"` 的查询不返回 bulk 档渠道（被过滤渠道进 `excluded[]` 并带原因）。
  - FR-A3-2 注册表写了 `llm.listProviders()` 中不存在的 provider → 该条目标 unknown 并降权〔00§6-M1.3〕。
  - FR-A3-3 capability 过滤生效（**评级字符串语义**，audit M-5 修订）：capability 需求按评级门槛匹配——`capability.coding` 评级低于需求门槛的渠道不入 `routes[]`（评级枚举闭集与门槛映射在 M2 capability 数据建模时定稿；上游口径见 00§3.1 `"coding": "good"/"excellent"`）。**MVP 过渡态显式声明**：MVP 注册表无结构化能力数据，capability 入参为 no-op 且 reason 中标注（docs/04-mvp-selfcheck.md §5-2 实录）；布尔代理（如 `coding=false`）仅为过渡表述，不作为正式验收判据。
  - FR-A3-4 `reviewed_at` 距今超过 90 天的渠道，返回条目 `review_alerts` 非空并附「建议人工复核」文案（90 天为**本说明书设定值**；上游表述为「如 90 天」建议值，00§5 风险 4）。

#### FR-A4 fallbacks 备选链与降级语义
- **描述**：注册表每渠道 `fallbacks[]` 显式声明备选序列（00§2 #3）。无可用路由时不硬派：全部渠道 exhausted/cooldown 时返回 `waiting=true` + 最近 `resetsAt`（07§3.5 全空终局语义）；部分不可用时 lead 按排序表顺序换下一项。`fallbacks` 悬空引用采用「读时告警、不拒写」的校验分层（07§3.2-5）。
- **优先级**：P0；**承接期**：M1。
- **验收标准**：
  - FR-A4-1 注册表内 `fallbacks` 引用不存在的 channel id → 激活后读侧产生告警（去重）但**不拒写**，查询返回附告警信息〔07§3.2-5〕。
  - FR-A4-2 人工构造全渠道 exhausted 账本 → 返回 `routes=[]` 且 `waiting=true`、`waitUntil` 等于最近 resetsAt〔07§3.5〕。
  - FR-A4-3 端到端：查询返回第 1 名被宿主策略门拒绝后，lead 按返回表改派第 2 名成功，完成「查询→选路→派遣」闭环〔00§4 消费路径、07§3.6-S6〕。

#### FR-A5 policy 四态标注与派遣预检
- **描述**：插件不是 policy 权威，只做**标注**（07§3.4 注 2）：每条 route 标 `policy ∈ {named, allowlist, child-default, fork}`，并附 `dispatch_precheck{can_dispatch, provider_routable, tool_visibility_ok, max_depth, depth_remaining}`，让模型派遣前就知道哪条会过门（07§1.2-B11）。M6 起增加排序前按会话 policy 的交集过滤。
- **优先级**：P1；**承接期**：M1（标注+预检），M6（交集过滤）。
- **验收标准**：
  - FR-A5-1 每条返回 route 均带 policy 四态之一，且与宿主会话 policy 实读一致（`sessionProjections`/settings 两读法之一比对）〔07§3.6-S5-②〕。
  - FR-A5-2 对活校验失败的渠道 `dispatch_precheck.provider_routable=false` 且 `can_dispatch=false`（构造不可路由用例验证）。
  - FR-A5-3（M6）排序前按会话 policy 交集过滤：policy 不允许的 route 移入 `excluded[]` 并带 `why="policy"`，`routes[]` 中不含 policy 拒绝项〔05§5.3-M6.1〕。

#### FR-A6 额度/禁用 warning 标注（非阻断；阻断为 opt-in 可选）
- **描述（v1.2 方向校准重写）**：对注册表标记 `manual.status=disabled`（字段定义见 FR-B1）、`manual.status=exhausted` 或余额低于阈值的渠道，查询排序表**仍保留该渠道条目**，但条目带 `warning` 标志 + 原因字符串（disabled/exhausted/low_balance）+ 替代建议（取其 `fallbacks[]` 或排序表下一项 channel_id）。**不阻断派遣：会话知情后自主决定**——advisory-only（建议不强制）产品方向的落地（用户澄清 2026-11-13）。
  - 与 FR-A2 L2 账本 mask 的分工：运行时账本的**动态** exhausted/cooling 仍按 FR-A2 语义沉底/出列（全耗尽走 waiting 终局）；FR-A6 处理的是注册表**静态标记与低余额阈值**，一律标注保留在表中。
  - **阻断类能力降级为 opt-in 可选**：插件配置新增 `enforce_gate: boolean`（默认 **false**）。仅当用户显式开启时，才对上述渠道启用 `tools.guard` 拒绝（含替代建议的可读错误，承接上游 00§6-M4.2/05§5.3-M6.1 原验收语义）；**默认行为永远是标注不阻断**。
- **优先级**：P2；**承接期**：M6。
- **验收标准**：
  - FR-A6-1（默认路径）`manual.status=disabled` 渠道仍出现在查询返回 `routes[]` 中，条目带 warning 标志、原因字符串与至少一条替代建议（fallbacks 成员或排序下一项 channel_id）〔承接上游 00§6-M4.2 的「含替代建议」语义，行为从拒绝改为标注——上游原文作为历史验收口径保留，不构成阻断要求〕。
  - FR-A6-2（默认路径）余额低于 `low_balance_threshold_cny` 或 `status=exhausted` 的渠道同样带 warning 标注：不消失、不沉底出列、派遣不被拦截。
  - FR-A6-3（opt-in 边界）`enforce_gate=false`（缺省）时对 disabled 渠道发起派遣，全链路无插件注入的阻断错误（零拦截验证）；`enforce_gate=true` 时上述渠道的派遣被 `tools.guard` 拒绝且错误文本可读、含替代建议〔上游 00§6-M4.2 原语义仅在显式开启下生效〕。

### 4.2 FR 组 B：额度感知

#### FR-B1 D 类人工登记余额（统一兜底落点）
- **描述**：`manual` 对象（`quota_total/quota_used_est/grant_expires_at/last_recorded_at/note` + **`status`**）是 D 类渠道与一切适配器失败/缺席的**统一落点**：查询层总能返回「登记值+估算值+数据新鲜度」，永不返回空（00§3.1 设计要点）。M1 全量渠道走 manual（07§3.3）。
  - **`status` 字段定义（audit M-3 补齐）**：`status ∈ {active, disabled, exhausted}`，缺省 `active`，读侧缺字段视为 `active`（旧版注册表兼容，对齐 NFR-4 读侧兼容纪律）。语义：`active`=正常登记；`disabled`=人工停用；`exhausted`=额度耗尽挂起——供 warning 标注（FR-A6，v1.2 起非阻断）与排序 L2 账本 mask（FR-A2）消费。上游 00§6-M4.2 / 05§5.3-M6.1 本就以 `manual.status=disabled` 表述，此为补定义、非改上游口径。
  - **MVP schema 对齐说明（audit M-3 实录）**：MVP `plugin-mroute/lib/config-schema.js` manualSchema 暂无 `status` 字段；M1 首迭代补齐（schema default `active`），补齐前读侧按缺字段=`active` 兼容，不影响 M1 验收。
- **优先级**：P0；**承接期**：M1（登记与读取），M4（面板编辑入口，见 FR-D2）。
- **验收标准**：
  - FR-B1-1 M1 阶段所有渠道返回 `quota.source="manual"` 且带 `as_of` 数据截至时间与「人工登记」标注〔00§6-M1.1、07§3.3〕。
  - FR-B1-2 manual 缺失的渠道返回 quota 数值为 null/unknown 并附标注，返回中**不出现伪造的 0%**〔07§1.3-S6〕。
  - FR-B1-3 修改某渠道 manual 登记值后，下一次 `model_route_query` 读到新值（M1 经 Config 重启、M4 起面板热更两种路径分别验证）。
  - FR-B1-4 `manual.status` 三值行为：schema default `active`；缺 `status` 的旧版注册表读侧按 `active` 处理不报错；标记 `disabled` 的渠道在查询返回中被 warning 标注语境识别（M6 后由 FR-A6-1 端到端验证；M1 阶段验证 schema default 与读侧兼容两半）。

#### FR-B2 A 类渠道 Key 直读自动余额
- **描述**：DeepSeek、Kimi 双站、SiliconFlow、OpenRouter(/key) 四渠道 Bearer GET 官方端点直读；DeepSeek 优先探测宿主 `deepseekAccount.getBalance` 先例可用性，宿主服务在则走宿主、HTTP 兜底（07§3.3 表）。密钥一律走 `ctx.credentials`（见 NFR-1）。
- **优先级**：P1；**承接期**：M2。
- **验收标准**：
  - FR-B2-1 四渠道用真实 Key 各拉到一次真实余额，字段与 02§一 总表一致（经 00§2 #4 引用）〔00§6-M2.1〕。
  - FR-B2-2 密钥仅存在于 credentials 记录；Config/日志/工具返回中无明文（describe 不回显验证）〔00§6-M2.3〕。
  - FR-B2-3 人为制造失败（错 Key）→ 渠道转 degraded 且排序降权；恢复正确 Key 后回 ok〔00§6-M2.4〕。

#### FR-B3 B 类渠道 AK/CLI 适配器
- **描述**：百炼 BSS + Token Plan（ACS3-HMAC-SHA256 签名，RAM 最小权限提示；全场唯一能查资源包有效期）、火山方舟 arkcli usage plan（或复刻其 OpenAPI；返回 `periods[]{used,total,percent,reset_at}`，reset_at 是**窗口刷新时间不是订阅到期日**）、OpenRouter /credits（Management Key，可选）（00§6-M3、07§3.3 表）。签名实现按 07§1.1-R3/R4/R5 连黄金测试一起移植。
- **优先级**：P1；**承接期**：M3。
- **验收标准**：
  - FR-B3-1 方舟返回 `periods[]{used,total,percent,reset_at}` 且 reset_at 按「窗口刷新」而非订阅到期理解并正确呈现〔00§6-M3.1〕。
  - FR-B3-2 百炼资源包返回含有效期字段（全场唯一）并可参与券衰减排序〔00§6-M3.2〕。
  - FR-B3-3 AK/SK 使用独立 credential 槽位（不与模型 Key 共用 ref）；错误信息与日志中不含签名材料明文〔00§5 风险 2 缓解〕。

#### FR-B4 C 类未文档化适配器（强制熔断）
- **描述**：智谱 biz 网关余额/资源包/quota limit 三接口属第三方实测可用、官方随时可改版加签（00§5 风险 1）。**强制熔断**：连续失败达 `breaker_threshold`（注册表默认 3）→ `health.state=degraded` → 落 manual 登记值；渠道与返回标注「尽力而为」（00§3.2 表）。
- **优先级**：P2；**承接期**：M3。
- **验收标准**：
  - FR-B4-1 人为断网/改路径 → 连续 3 次失败（默认阈值）后自动 degraded、落 manual 值、工具返回与面板标注「尽力而为」〔00§6-M3.3〕。
  - FR-B4-2 degraded 渠道在排序中降权但**保留在返回中并带原因标注**（标注不隐藏）〔00§3.3〕。

#### FR-B5 余额缓存
- **描述**：余额查询缓存 TTL ≥60s（渠道级 `cache_ttl_s` 可覆盖；各家未承诺限速，00§3.3 引 02§三.Q3.4）；单飞去重；**失败退避占位**（失败结果也占缓存位，5s×2ⁿ 封顶 30min，借鉴 07§1.2-B17）；懒预热（只覆盖客户端请求过的 provider）。OpenAI/Anthropic Admin 用量 5–30min~T+1 延迟数据只降权参考不作硬门（00§3.3、00§5 风险 6）。
- **优先级**：P1；**承接期**：M2。
- **验收标准**：
  - FR-B5-1 缓存 TTL 内重复调用不产生新的出站请求（出站计数器/日志证明）〔00§6-M2.2〕。
  - FR-B5-2 `refresh=true` 绕过缓存强制刷新，返回 `as_of` 晚于缓存值。
  - FR-B5-3 失败退避生效：制造一次失败后，退避窗口内同渠道出站请求 ≤1 次且回退值/占位可辨（借鉴 07§1.2-B17 失败占位语义）。

#### FR-B6 熔断与降级
- **描述**：每渠道维护 `health{state, last_check_at, last_error, consecutive_failures}`；连续失败达阈值即 degraded；degraded 渠道排序降权并在工具返回标注原因；恢复探测（成功一次）回 ok（00§3.3）。A 类 M2 生效，C 类 M3 强制。
- **优先级**：P1；**承接期**：M2（A 类），M3（C 类强制）。
- **验收标准**：
  - FR-B6-1 连续失败达 `breaker_threshold` → `state=degraded`，工具返回与面板附失败原因（`last_error`）〔00§3.3〕。
  - FR-B6-2 一次成功探测后回 `ok`（与 FR-B2-3 恢复半段共用用例）〔00§6-M2.4〕。
  - FR-B6-3 每次状态迁移在 health 元数据中可查（`consecutive_failures`、`last_check_at` 单调更新）。

#### FR-B7 券衰减排序
- **描述**：voucher 档内按紧迫度重排：`urgencyKey = 剩余额 ÷ max(剩余天数, 1)`，**值大者排前**（快过期且剩得多 → 单位时间需消耗越多 → 先用），落实 00§3.1「剩余额 ÷ 剩余天数衰减加权，先用快过期的券」。缺 `grant_expires_at` 或余额数据的券渠道不打乱原序（07§3.5 缺数据分支）。⚠ 上游勘误注记：07§3.5 伪代码注释写「小者排前」，与其解释「接近过期且还剩得多排前」方向相反（二者数值方向矛盾）；本文按 00§3.1 设计要点意图统一定义为 urgencyKey 大者排前，实现以本条为准并在代码注释修正。
- **优先级**：P1；**承接期**：M3。
- **验收标准**：
  - FR-B7-1 构造两券：券 A 余额 100/剩 5 天（urgencyKey=20）、券 B 余额 50/剩 30 天（urgencyKey≈1.67）→ 返回顺序 A 在 B 前。
  - FR-B7-2 缺 `grant_expires_at` 或余额的券渠道保持 voucher 档内原序（priority 序）不变〔07§3.5〕。
  - FR-B7-3 百炼资源包（唯一带有效期机读）与人工登记到期日的券均能参与衰减排序〔00§6-M3.2〕。

#### FR-B8 包月估算折算
- **描述**：无机读的包月渠道走「人工登记总额 + 本地 TokenUsage 按官方系数折算累计估算」；系数表带版本引用 `coeff_table_ref`；定期与控制台快照人工对账校准（先例比值 1.0000，00§2 引 02§三.Q1）；展示层永远标「估算值 + 数据截至时间」，绝不冒充机读值（00§5 风险 3）。
- **优先级**：P1；**承接期**：M3。
- **验收标准**：
  - FR-B8-1 本地折算与渠道控制台快照对账，误差比值有记录且 ≤1.05（目标接近 1.0；1.05 为**本说明书设定阈值**）〔00§6-M3.4〕。
  - FR-B8-2 系数表带 `coeff_table_ref` 版本字符串；更换版本后历史估算条目可追溯到所用版本〔00§5 风险 3〕。
  - FR-B8-3 估算渠道的返回/面板显示含「估算」标识与 `as_of`，且 `quota.source` 与机读渠道可区分〔00§5 风险 3〕。

#### FR-B9 QuotaView 归一化机读视图
- **描述**：适配器统一输出 `describe()` → QuotaView JSON：`kind/currency/balance/total/used/windows[]/vouchers[]/source/as_of/note`——给模型看的结构化视图，不做 HTML 渲染（07§1.3-S6，07a 指认的唯一自设计分叉点）。口径隔离：方舟 usage（近实时）与 billing（T+1）不混用；智谱 coding 路由与标准 API 是两个额度池——适配器内固定口径，排序层不跨口径相加（00§3.3）。
- **优先级**：P1；**承接期**：M2。
- **验收标准**：
  - FR-B9-1 A/B/C/D 四类适配器各自 `describe()` 输出通过结构校验器（必填字段一次列全部 violations，借鉴 07§1.2-B1 契约）。
  - FR-B9-2 口径分立：包月窗口（windows）与预充值余额（balance）不并入同一数值字段；同渠道两个额度池各自独立条目〔00§3.3〕。
  - FR-B9-3 已知陷阱防御：渠道返回 200 但 body 为错误对象（火山「200+ResponseMetadata.Error」陷阱）→ 判为失败、不产出 QuotaView〔07§4.3-3 已知 bug 清单〕。

### 4.3 FR 组 C：评测排名

#### FR-C1 评测触发入口与成本护栏
- **描述**：入口两个：面板「运行评测」按钮（主）+ `model_eval_run` 工具（辅，配 `tools.guard/ask` 人工确认，工具 description 明写「评测消耗真实渠道额度」）（05§1.1、05§5.3-M5.5）。四层成本护栏：①预算帽（per_run/monthly，配置放 volatile Config 可面板调）；②余额联动（余额<预估×3 拒跑）；③包月渠道优先全量评、prepaid 渠道默认 5 题冒烟（全量需人工确认）；④串行限流 + 熔断续跑 + 超限即停留 `partial` 结果（05§1.1 B、04§E 经 05§3 #7 引用）。
- **优先级**：P1；**承接期**：M5。
- **验收标准**：
  - FR-C1-1 预估成本超 `per_run_cny_max` 拒跑；run 中 usage 累计超限即停且保留 `partial` 结果〔05§5.3-M5.2 前半〕。
  - FR-C1-2 余额 < 预估×3 拒跑（A/B 类机读渠道上验证）〔05§5.3-M5.2 中〕。
  - FR-C1-3 prepaid 渠道默认 5 题冒烟；全量触发需一次人工确认〔05§5.3-M5.2 后半〕。
  - FR-C1-4 `model_eval_run` 工具触发时 `tools.guard/ask` 人工确认弹出〔05§5.3-M5.5〕。

#### FR-C2 评测执行与确定性判分
- **描述**：主通道②宿主 llm 服务：`ctx.llm.stream/prepareCall`（自动复用适配器/凭据/retry/usage，对派遣链路保真度最高；effort 钉死用 `prepareCall` 第三参 configure 回调，07§0 裁决 5）；通道①直连 HTTP 仅做连通探针与参数实验；通道③子会话仅做 tier 争议抽检仲裁（05§1.1 B）。评测资产自建轻量固定集：四类各 10–20 题、`suite_version` 化；判分器确定性（JSON schema/关键词/结构断言），零 LLM judge、零外部依赖；finish kind 宽表兼容（`completed|stop` 均算成功，未知 kind 显式失败附原文，07§1.2-B19）；哨兵 must-pass/must-fail 用例破判整轮 `instrument_unhealthy`（07§1.2-B8）。
- **优先级**：P1；**承接期**：M5。
- **验收标准**：
  - FR-C2-1 面板按钮触发后，通道②串行逐题跑通四类固定集并产出 EvalReport〔05§5.3-M5.1〕。
  - FR-C2-2 判分器源码静态检查无 `eval`/`new Function`〔05§5.3-M5.6 后半，04§B〕。
  - FR-C2-3 注入哨兵用例（一个必 pass 一个必 fail 故意反向）→ 整轮标 `instrument_unhealthy` 且不进排名〔07§1.2-B8 哨兵协议〕。
  - FR-C2-4 finish kind 词表宽表兼容：`completed` 与 `stop` 样本均判成功；未知 kind 显式失败且附原始值〔07§1.2-B19〕。

#### FR-C3 评测建议输出（EvalReport）
- **描述**：run 完成产出 EvalReport：分项得分（四类）+ `composite` + `suggested_tier/suggested_priority` + 证据链（分数阈值 + 外部榜单交叉引用）；性能探针 `probe{ttft_ms,tps,samples,ttft_spread}` 作参考列**不进 composite**；指纹 `fingerprint{...}` 作事件驱动复核锚（07§3.2-4 eval 字段集）。provisional 门槛：某类 `n_samples < 8` 或成本缺失 → 分数标 provisional，不参与 tier 建议与排序理由（05§1.1 B、05§5.3-M5.4）。逐题明细落插件数据目录 `eval-history/<run_id>.json`，Config 保持可读可 diff（05§5.3-M5.6）。
- **优先级**：P1；**承接期**：M5。
- **验收标准**：
  - FR-C3-1 provisional 门槛生效：构造某类 n<8 的 run → 该类分数标 provisional 且不出现在 tier 建议与排序理由中〔05§5.3-M5.4〕。
  - FR-C3-2 逐题明细落 `eval-history/<run_id>.json`；Config 注册表内容不因明细膨胀（保持可读可 diff）〔05§5.3-M5.6〕。
  - FR-C3-3 EvalReport 的 `evidence_refs` 非空（分数阈值与榜单引用至少其一）〔05§3 #7〕。

#### FR-C4 人工确认写回（排名闭环）
- **描述**：评测**只产建议**：面板 diff 高亮（当前 tier/priority vs 建议，红绿对比，附 eval 元数据）；人工点「确认采纳」→ Host 侧 `configEditor.edit()` **原子写回**（`registry_version`+1、tier/priority 更新、`channel.eval` 落摘要、`reviewed_at/reviewed_against` 刷新）→ 下一次查询立即吃到新排名；点「忽略」→ 留档不写回（05§2.2 数据流二）。两条写链分工：编辑器常规编辑走 client 侧 `settings.mutate`（FR-D2），评测采纳走 Host 侧 `configEditor.edit` 多字段联动（05§2.2 注）。机器建议与人工确认不一致时 `source` 字段显式区分——机器估分永远压不过人工确认（07§1.2-B14）。
- **优先级**：P1；**承接期**：M5。
- **验收标准**：
  - FR-C4-1 「确认采纳」后 `registry_version`+1、`channel.eval` 落摘要、`reviewed_at/reviewed_against` 刷新，下一次 `model_route_query` 排序吃到新 priority〔05§5.3-M5.3〕。
  - FR-C4-2 「忽略」后注册表数值不变，该次 EvalReport 留档可查〔05§5.3-M5.3 后半〕。
  - FR-C4-3 人工改值与机器建议不一致时，`channel.eval` 摘要含 `source` 区分标记〔07§1.2-B14〕。

#### FR-C5 外部榜单参考（只读层）
- **描述**：Aider（最易抓）、SWE-bench（内嵌 JSON）、LiveCodeBench（版本化）、LMArena（社区镜像）+ OpenRouter `/api/v1/models` 作第 0 源（免鉴权机读含三指数+Elo+定价+上下文，07§1.2-B18）。人工触发抓取，快照落 `leaderboards/<source>/<date>.json`；面板只读展示、`external_ref` 交叉引用；**绝不自动改 tier**（05§5.3-M6.2）。榜单模型名 alias 未映射条目进「待人工映射」队列、不进面板交叉引用；LMArena 镜像失败 → 降级页面抓取 → 再失败标「同步失败于 <date>」（05§5.3-M6.3、05§6 风险 10）。
- **优先级**：P2；**承接期**：M6。
- **验收标准**：
  - FR-C5-1 Aider/SWE-bench 榜单人工触发抓取成功，落 `leaderboards/<source>/<date>.json`，面板只读展示〔05§5.3-M6.2〕。
  - FR-C5-2 alias 未映射条目进待人工映射队列，不进面板交叉引用〔05§5.3-M6.3 前半〕。
  - FR-C5-3 LMArena 镜像失败时熔断降级页面抓取，再失败标「同步失败于 <date>」〔05§5.3-M6.3 后半〕。

### 4.4 FR 组 D：面板运维

#### FR-D1 设置面板分区「模型路由」
- **描述**：`settings.section` 分区 slot（一等公民机制，第三方占位两例在线实证：dsh-orb order:25、官方 Models 页同构，05§1.1 A）；形态唯一推荐 Client slot + 手写 React（iframe 被 practices.md 明文反对，05§1.1 A）；`openSection('model-route')` 可编程直达；order 落在 models(10) 与 orb(25) 之间（建议 15–20）；控件与宿主视觉一致（theme token、明暗切换、locale），无跨插件 import（05§5.3-M4.1/M4.6、05§6 风险 9）。
- **优先级**：P1；**承接期**：M4。
- **验收标准**：
  - FR-D1-1 设置弹窗出现「模型路由」分区，导航可点、`openSection('model-route')` 编程直达；order 在 15–20 区间〔05§5.3-M4.1〕。
  - FR-D1-2 面板控件使用宿主 theme token、明暗切换正常、locale 正确渲染；构建通过 purity gate（无跨插件值 import）〔05§5.3-M4.6〕。

#### FR-D2 注册表可视化编辑
- **描述**：tier/priority/fallbacks/manual/reviewed_at 全部面板可编辑；保存后**不重启插件**，`model_route_query` 立即读到新值（volatile 热更链路，05§2.1 数据流一）；并发编辑 revision 冲突可恢复（可读提示+重读不丢草稿）；密钥字段只显示侧牌（set/unset，值不过读线）；非法值双保险（客户端 `settingsSchema.validate` 拦截 + 激活时 Config schema 校验兜底）。schema 前置约束见 NFR-3（volatile 化）与 §6.3（嵌套降级预案）。
- **优先级**：P1；**承接期**：M4。
- **验收标准**：
  - FR-D2-1 五类字段全部面板可编辑；保存后不重启插件，`model_route_query` 立即读到新值（数据流一端到端验证）〔05§5.3-M4.2〕。
  - FR-D2-2 制造 revision 冲突（另一客户端先保存）→ 得到 "Settings changed elsewhere" 类可读提示 → 重读后草稿不丢数据〔05§5.3-M4.3〕。
  - FR-D2-3 密钥字段只显示侧牌（set/unset），任何读面（describe/工具返回/日志）无明文〔05§5.3-M4.4〕。
  - FR-D2-4 客户端 `settingsSchema.validate` 拦截非法值（如 fallbacks 引用不存在的渠道 id）；宿主激活时 Config schema 校验兜底〔05§5.3-M4.5〕。

#### FR-D3 复核提示
- **描述**：`reviewed_at` 超期（>90 天，本说明书设定值）的渠道在工具返回（M1 起，FR-A3-4）与面板（M4 起）均附「建议人工复核」提示；M5 起 `reviewed_against` 挂三锚点（`eval-suite@版本 + 榜单@日期 + fingerprint@hash`，07§3.2-8）；指纹漂移探针（移植 big-coming，07§1.1-R1）提供事件驱动复核锚。
- **优先级**：P1；**承接期**：M1（工具返回），M4（面板），M5（reviewed_against 三锚点）。
- **验收标准**：
  - FR-D3-1 超期渠道在 `model_route_query` 返回条目 `review_alerts` 非空（与 FR-A3-4 共用用例）。
  - FR-D3-2 M4 后同一超期提示在面板可见〔05§5.3-M4.4 前半、00§6-M4.4〕。
  - FR-D3-3 M5 后被评测覆盖渠道的 `reviewed_against` 含三锚点引用（eval-suite 版本/榜单日期/指纹 hash 至少其一非空）〔07§3.2-8〕。

### 4.5 FR 组 E：基础设施

#### FR-E1 systemPrompt 派遣提示
- **描述**：`systemPrompt.section` 注入一段固定提示：「派遣子会话前先调 `model_route_query`，按返回排序选择 assignee」，附一句调用示例与降级说明（无可用路由时继承父路由）（00§3.4-②）。文案纪律：限定一句话+工具名，避免与已装的 subagent-setup 等路由类插件提示叠加冲突（07§4.1）。
- **优先级**：P0；**承接期**：M1。
- **验收标准**：
  - FR-E1-1 新会话的 systemPrompt 提示文本中出现该段与工具名〔00§6-M1.4〕。
  - FR-E1-2 提示文案含降级说明（无可用路由→继承父路由），文案 diff 校验通过。

#### FR-E2 DecisionRecord 排序留痕
- **描述**：排序引擎为纯函数，同输入同输出可重放；每次查询产出 DecisionRecord（`candidates/excluded/selected/逐项加减分/why/until`）落 `ledger/decision-<ts>.json`，借鉴 governor 决策审计与 provider-usage 原子写纪律（07§1.2-B7/B15）。v1 查询零副作用，落盘失败不阻塞返回，但必须在返回 `meta` 标注留痕未持久并记日志（**本说明书设定**；B7 的 fail-closed 纪律适用于 v2 换档语义，v1 无实际改写发生）。
- **优先级**：P1；**承接期**：M1。
- **验收标准**：
  - FR-E2-1 同一注册表+同一账本输入连续两次调用，输出全序一致且 DecisionRecord 逐字节一致〔07§3.6-S4〕。
  - FR-E2-2 每次查询产生一个 `ledger/decision-<ts>.json`，内容含 `excluded[]` 与逐项加减分〔07§3.6-S4〕。
  - FR-E2-3 ledger 目录下决策文件均可被 `JSON.parse`（原子写抽查）；模拟落盘失败时查询仍返回且 `meta` 含留痕未持久标注。

#### FR-E3 健康状态机
- **描述**：渠道级 health 三态 `ok/degraded/unknown` + `last_check_at/last_error/consecutive_failures`；内部状态机移植 balance-monitor（idle/loading/ready/unconfigured/error + **stale 保留旧值** + revision 单调快照，07§1.1-R7）。M1 占位（manual 渠道恒 ok/unknown），M2 起 A 类生效。unknown（未配置凭据/从未检测）不冒充 ok。
- **优先级**：P1；**承接期**：M1（占位），M2（A 类生效）。
- **验收标准**：
  - FR-E3-1 M2 后 A 类渠道经真实调用刷新 `last_check_at`，health 三态字段齐备（与 FR-B2-1 联动验证）。
  - FR-E3-2 未配置凭据的渠道 state=unknown 且返回带标注，不显示为 ok。
  - FR-E3-3 刷新失败时保留旧值并附 stale 标注与 `last_error`（R7 stale 语义）。

---

## 5. 非功能性需求（NFR）

#### NFR-0 会话自主权原则（advisory-only 总则，v1.2 新增）　P0
- **mroute 一切输出皆建议**：查询排序表、warning 标注、systemPrompt 提醒都只是参考信息；**最终选择权永远在会话与用户**。
- 插件**不阻断、不改写、不代决策**：不改写任何派遣请求（00§1 无 rewrite 通道，产品形态上也不做）；默认路径下对任何渠道的派遣零拦截（与 FR-A6 默认路径一致）。
- **阻断类能力必须 opt-in 且默认关闭**：任何 guard deny 类行为（如 FR-A6 的 `enforce_gate`）缺省 false，仅在用户显式开启时生效；默认行为永远是标注不阻断。
- **宿主原生策略门**（`assertAllowedModelSelection`/`subagentModelSelection` policy）属用户在宿主侧自行配置，**不是 mroute 的行为**；mroute 只做 policy 四态标注（FR-A5），不接管、不代配置（与 07§3.4 注 2「不做 policy 权威」同源）。
- **可测验收（NFR-0a）**：①缺省配置下对 disabled/低余额渠道发起派遣，全链路无插件注入的阻断错误，warning 仅出现在查询返回文本中（与 FR-A6-3 前半共用用例）；②插件配置 schema 中 `enforce_gate` 缺省值为 false（schema 断言）；③红线 grep 无 rewrite/默认阻断挂载点（与 NFR-3 红线验收共用）。

#### NFR-1 安全（凭据与攻击面）　P0
- 所有凭证走 `ctx.credentials`（`modifyRecord` 记录 / `credentialRef` 键，describe 永不回显）；**禁止进 Config/日志/工具返回/浏览器**（00§2 #4、00§5 风险 2，依据 host-plugin.md L77 经 00§2 引用）。
- AK 类凭证（百炼/方舟）权限远大于模型 Key：独立槽位 + 权限提示 + 建议最小权限 RAM 策略（00§2 #4 引 02§三.Q3.2）。余额查询凭证 ≠ 模型调用 Key（凭证隔离，00§3.2）。
- 判分器禁止 `eval`/`new Function`（05§5.3-M5.6）。
- 只读诊断 webServer 仅 loopback + same-origin 围栏（07§3.1 webserver.js，围栏标准取各家最严并集）。
- **可测验收**：①对 describe 与工具返回全文做密钥子串断言（与 FR-B2-2/FR-D2-3 共用用例）；②源码静态检查无 eval/new Function（与 FR-C2-2 共用）；③webServer 监听地址为 loopback（配置断言）。

#### NFR-2 性能　P1
- 查询毫秒级：余额走缓存时排序为纯内存计算（00§4 消费路径）。**本说明书设定阈值**：缓存命中场景下单次 `model_route_query` P95 ≤ 500ms（本机 10 渠道注册表）。**活校验缓存口径承接记录（audit M-4 回注）**：MVP 已实测为**单 TTL 60s**（「读不到不缓存」纪律保留，docs/04-mvp-selfcheck.md §5-4）；07§1.1-R11 的双 TTL（成功 10min/失败 1min）为 **M2 恢复项**，恢复前本 NFR 阈值口径以单 TTL 60s 实测为准。
- **活校验缓存陈旧窗口可见性（audit M-6 新增附属条）**：活校验/目录缓存 TTL 窗口（MVP 60s；M2 恢复双 TTL 后为「成功 10min/失败 1min」）内发生的外部事实变化（渠道上下线、注册表配置变更），其后的查询**不得冒充新鲜**：返回 `meta` 必须携带 `generated_at`（本次排序生成时间）与缓存状态标注（如 `catalog_staleness`），使调用方可判断「数据截至」。MVP 已返回 `generated_at`/`reviewed_at`（plugin-mroute `tool-query.js:60,207-210`，audit §3 M-6 实录）。
  - **可测验收（NFR-2a）**：①每次查询返回 `meta.generated_at` 非空，且缓存命中窗口内连续两次查询的 `generated_at` 互不相同（逐次实时生成，不复用缓存时间戳）；②构造注册表 priority 变更用例：变更后 60s 窗口内的查询结果可经 `generated_at` 与变更时间比对识别为「变更前快照」——即调用方有手段发现数据截至，而非无感旧值；③构造渠道目录级变化用例（渠道在缓存窗口内上线）：最迟「TTL+一次查询」后该渠道进入返回且不再标 unknown——陈旧窗口**有界且可见**。
- 缓存 TTL ≥60s（00§3.3）；评测串行限流不并发打爆渠道（05§1.1 B）。
- **可测验收**：本机基准脚本连续 100 次查询（缓存命中）计时统计 P95；出站请求计数器证明 TTL 内零新增外呼（与 FR-B5-1 共用）。

#### NFR-3 兼容性（宿主版本与红线）　P0
- 目标 DSH 0.2.x，`engines.dsh` 声明；宿主 API 以运行时实源为准，不照抄任一插件的旧代次调用（07§4.3-2）。
- **v1 红线（禁做区）**：不改写 `llm/stream`（00§5 风险 5，明确不做、仅存档理论通道）；不挂 `agent/request` 改写（宿主 0.2.2 step-fixed selection 下被拒，07§0 裁决 1）；换档持久落点只认 `agent.model.select()` 且 v2 才评估（07§0 裁决 4）；`llm/stream` 监听仅限「观察记账」先例形态（07§2 边界注记）。
- volatile 结构硬约束（**Day1 实测结论口径，2026-11-13**；audit M-4 回注。实测证据：docs/04-mvp-notes.md §1.2–§1.3 C4、AGENTS.md §4）：**`channels[]` 数组整体 `.volatile()`**（实测：数组**元素内**字段标 volatile 明确抛错 `"volatile fields require a fixed object path without an enclosing volatile field"`——宿主禁令的 schema 层实锤）；数组整体 volatile 后经 `.get()` 读回完整（roundtrip identical）；`registry_version/reviewed_at/reviewed_against` 等**顶层固定命名字段**各自 `.volatile()`（顶层合法）；数组编辑统一**整条替换**语义（07§3.2-2）；禁止整表 volatile dict（动态路径仍被宿主拒绝，05§6 风险 8）。
  - **一致性核对（上游表述辨析，不改上游原文）**：上游 05§5.3-M1.5 / 05§6 风险 8 / 07§3.2-1 的「可编辑字段各自 `.volatile()`」口径在**顶层对象根字段**层面与实测一致；差异仅在 `channels[]` 数组——上游文字未覆盖「数组元素内抛错」边界，Day1 实测（C4）补齐该边界：**数组只能整体 volatile**。上游表述作为当时假设口径保留不动，实现与验收以本条实测口径为准。
- schemastery 嵌套降级预案：`capability{}/manual{}/eval{}` 三个嵌套对象在目标 DSH 版本上 Day 1 实测（写入→重启→读回逐键核对），任一不过 → 降级 JSON 字符串字段 + `schema_version` 标注，结论写进 `config-schema.js` 头注（07§3.2-3）。
- 工具命名无冲突：`model_route_query` 全市场无重名先例；**不建任何委派工具**（避免与 subagent-setup 等同类工具重名顶替，07§4.1）。
- **可测验收**：目标 DSH 版本安装激活成功；静态扫描无 llm/stream 与 agent/request 改写挂载点；volatile 结构审查（05§5.3-M1.5）；嵌套实测结论入档。

#### NFR-4 可维护性　P1
- **移植即冻结**：抄进 mroute 的代码从上游版本 fork 后自行维护，NOTICE.md 记来源版本；上游升级不自动跟进（07§4.3-1）。
- NOTICE.md 覆盖全部复用项 R1–R16 出处（插件名@版本/文件/LICENSE）；每个移植文件头保留原版权行 + Source 标注；**测试与代码一起搬**（R3 黄金哈希/R4 官方向量）；已知 bug 清单与教训注释随码移植不许删（07§4.2/4.3-3）。
- 许可合规：26 来源包 MIT（义务=保留版权与许可声明）；autotier 为 Apache-2.0，取「仅参考」不取码；eval-harness 声明 MIT 但 checkout 无 LICENSE 文件——默认只借鉴形状不抄实现（07§4.2）。
- schema 演进兼容：`registry_version` 驱动读侧兼容（老版本缺 eval→视为空对象、缺 manual→视为 unknown）（07§3.2-9）。
- 校验分层：schemastery 只管逐字段形状；跨字段语义读时补（告警去重），**不拒写**（07§3.2-5）。
- **可测验收**：NOTICE 覆盖检查表全绿；构造 v1 schema 数据在 v2 读侧不抛错（缺字段回退用例）。

#### NFR-5 可观测性与数据诚实　P1
- 每次查询可重放：DecisionRecord 全留痕（FR-E2）；评测逐题明细落盘（FR-C3）；榜单快照带 provenance（sourceKind/isOnline/surveyDate，07§1.2-B18）。
- 所有余额/健康返回带 `as_of` 数据新鲜度；延迟口径（Admin 用量 5–30min~T+1、方舟 billing T+1）写进适配器元数据；这类数据只降权参考不作硬门（00§5 风险 6、00§3.3）。
- **缺失绝不伪造 0%**：数据缺失一律显式 null/unknown + 标注（07§1.3-S6）。
- **可测验收**：任取一条工具返回可对应到一份 decision 文件并重放排序；抽查返回中缺失数据项均带显式标注。

---

## 6. 约束与依赖

### 6.1 宿主 API 面依赖

| 宿主接缝 | 用途 | 依据 | 承接期 |
|---|---|---|---|
| `ctx.tools.register(defineTool(...))` | 注册 `model_route_query` / `model_eval_run` | 00§3.4-①（同形态先例 `list_subagent_models`） | M1 / M5 |
| `systemPrompt.section` | 派遣提示 | 00§3.4-② | M1 |
| 插件 Config（schemastery 校验 + volatile 热更） | 承载注册表 | 00§3.4-③、05§1.1 A | M1 |
| `ctx.credentials` | 凭据存取 | 00§2 #4、host-plugin.md L77（经 00§2 引用） | M1 |
| `settings.section` slot + `settings.mutate` | 面板分区与常规编辑写链 | 05§1.1 A、05§2.1 | M4 |
| `configEditor.edit` | 评测采纳原子写回 | 05§2.2 数据流二 | M5 |
| llm 服务（`LlmRuntime.stream/prepareCall`，`static inject=['llm']` 先例） | 评测通道② | 05§1.1 B、07§0 裁决 5 | M5 |
| `tools.guard` / `tools.ask` | 评测人工确认（保留，FR-C1）；额度/禁用 warning 标注的 opt-in 阻断（默认关闭，FR-A6） | 04§E（经 05§3 #7）、00§6-M4 | M5 / M6（标注；阻断仅 opt-in） |
| `ctx.slots.inject`（React） | 面板 UI | 00§3.4-④、05§1.1 A | M4 |
| webServer（只读诊断路由） | 注册表 dump 调试 | 07§3.1 webserver.js | M1 可选 |

### 6.2 红线（禁做区，违反即架构审计 blocker）

1. `llm/stream` 全局改道：**明确不做**，仅存档为理论通道（00§5 风险 5）。
2. `agent/request` 改写：v1 不碰；宿主 0.2.2 起被 step-fixed selection 拒绝（07§0 裁决 1）。
3. policy 权威化：插件只做四态**标注**，不接管宿主 `subagentModelSelection` policy（07§3.4 注 2；05§4.2 检查项 4）。
4. 密钥进 Config / 日志 / 工具返回 / 浏览器（NFR-1）。
5. 自动改写派遣参数：无 rewrite 通道，产品形态上也不做（00§1）。

### 6.3 环境坑依赖（实现前置检查）

- **schemastery 嵌套**：部分构建缺 `z.record/z.dict` 且 `z.any` 丢嵌套对象——`capability/manual/eval` 三嵌套对象 Day 1 实测决定 schema 形状（07§3.2-3）。
- **inspect exact-query 损坏**：本 build `cordis_inspect_query` 带 input 被拒，开发期宿主类型证据依赖运行时 JS + JSDoc（00§5 风险 7；AGENTS.md §4）。
- **asar 归档只读**：宿主检出只有 read 工具可读，证据取运行时 JS（AGENTS.md §4）。

### 6.4 许可与合规依赖

- 直接复用/移植项全部 MIT（R1–R16），义务=保留版权与许可声明 + NOTICE 汇总（07§4.2）。
- autotier（Apache-2.0）仅参考不取码；eval-harness 无 LICENSE 文件，只借鉴形状（07§4.2）。
- governor 域模块作者自律（不直连 provider HTTP/不存凭据）随 R14 移植继承为编码规范（07§4.2 末）。

### 6.5 同装共存约束

- 与 subagent-setup/delegate-router/autotier/llm-fallbacks/llm-governor 存在「选路指引语义重叠」：文档明示二选一建议（07§4.4）。
- 与 quota-panel/balance-monitor/musage 可共存（M4 面板上线后 UI 重叠由用户决定去留）；与 aliyun-balance 推荐共存（R16，B 类适配器上线前的人工对账窗口）（07§4.4）。
- credentials ref 命名沿用 `<UPPER>_API_KEY` 规范，共享即互补无冲突（07§4.1）。

### 6.6 外部数据依赖

- 各渠道余额端点可用性与限速均为「官方未承诺」状态，缓存+熔断兜底（00§3.3 引 02§三.Q3.4）。
- C 类智谱接口与榜单镜像端点属易变面，接口失效表现为 degraded 落 manual，不阻塞主链路（07§4.3-2）。

---

## 7. 需求追溯矩阵

### 7.1 主矩阵：七需求 → FR → 里程碑 → 上游论证章节

| 原始需求 | 承接 FR | 里程碑 | 上游论证章节 |
|---|---|---|---|
| **REQ-1** 能力分层 | FR-A3（tier 分层+过滤+活校验）、FR-A2（tier 进排序）、FR-C2/C3/C4（评测建议增强保鲜）、FR-D3（复核提示+reviewed_against 锚） | M1（+M5 增强） | 00§2 #1、00§3.1（schema/设计要点）、00§5 风险 4、05§3 #7（评测保鲜锚点）、06§一 需求 7 表（零件先例） |
| **REQ-2** 财务优先级（包月>券>预充值） | FR-A2（channel_type 一级键）、FR-B7（券衰减）、FR-B8（包月折算）、FR-B1～B4（三池分立口径的四级适配）、FR-B9（口径分立视图） | M1–M3 | 00§2 #2、00§3.1 设计要点（一级键/双池警示）、02§三.Q3.3/Q1/Q2（经 00§2 引用）、06§三 空白 1/2、07§1.3-S1/S2（自研定位） |
| **REQ-3** fallback 备选链 | FR-A4（fallbacks+waiting/inherit 降级）、FR-A5（policy 四态+预检：被拒换下一项）、FR-A6（warning 标注+替代建议；阻断 opt-in）、FR-D2（fallbacks 面板编辑） | M1（M4 可视化编辑、M6 warning 标注） | 00§2 #3（含策略门拒绝换下一项）、00§4 消费路径、05§3 #6、07§1.2-B4/B11 |
| **REQ-4** 余额/用量查询 | FR-B1（D 类人工）、FR-B2（A 类直读）、FR-B3（B 类 AK/CLI）、FR-B4（C 类熔断）、FR-B5（缓存）、FR-B9（QuotaView）、FR-A1（查询工具出口）、FR-A6（低于阈值 warning 标注） | M1–M3（M2 为主） | 00§2 #4、00§3.2（四级适配器表）、00§3.3（缓存熔断）、02§一/§二（经 00§2 引用）、07§1.1-R3~R8（移植出处）、06§一 需求 4 表 |
| **REQ-5** 动态能力变化保鲜 | FR-E3（健康状态机）、FR-B6（熔断降级）、FR-A3（运行期活校验）、FR-D3（reviewed_at 复核）、FR-C5（榜单外锚）、FR-E2（DecisionRecord 可追溯）、FR-B5（数据新鲜度 as_of） | M1–M3（+M5/M6 增强） | 00§2 #5、00§3.3、00§5 风险 1/4/6、07§1.1-R1（指纹锚）、07§1.1-R7（状态机） |
| **REQ-6** 设置面板可视化编辑 | FR-D1（分区挂载）、FR-D2（注册表编辑+写链）、FR-D3（复核提示面板化）、FR-B1（manual 登记入口） | M4 | 05§3 #6、05§1.1 A（slot 机制实证）、05§2.1（数据流一）、05§5.3-M4（验收）、05§6 风险 8/9/12、03§A–E（经 05 引用） |
| **REQ-7** 手工评测→排名更新 | FR-C1（触发+护栏）、FR-C2（执行判分）、FR-C3（建议输出）、FR-C4（确认写回）、FR-A2（eval.composite 因子）、FR-C5（外部榜单参考） | M5（榜单 M6） | 05§3 #7、05§1.1 B、05§2.2（数据流二）、05§5.3-M5/M6（验收）、05§6 风险 10/11/13、04§A–E（经 05 引用）、06§一 需求 7 表、07§1.3-S3（闭环自研定位） |

### 7.2 反向覆盖自检（每条 FR 至少归属一条需求）

| FR | 归属需求 | 说明 |
|---|---|---|
| FR-A1 | REQ-2/3/4 | 查询出口：财务排序表 + 备选顺序 + 余额机读 |
| FR-A2 | REQ-1/2 | tier 与 channel_type 双排序因子 |
| FR-A3 | REQ-1/5 | 分层过滤 + 运行期活校验 |
| FR-A4 | REQ-3 | 备选链与降级 |
| FR-A5 | REQ-3 | 策略门被拒前的预检标注 |
| FR-A6 | REQ-4/5 | 欠费/禁用渠道 warning 标注（阻断 opt-in） |
| FR-B1 | REQ-2/4 | D 类登记与统一兜底 |
| FR-B2/B3/B4 | REQ-4 | A/B/C 三级适配器 |
| FR-B5 | REQ-4/5 | 缓存与数据新鲜度 |
| FR-B6 | REQ-5 | 熔断降级 |
| FR-B7 | REQ-2 | 券衰减（06§三空白 2） |
| FR-B8 | REQ-2 | 包月折算 |
| FR-B9 | REQ-4 | 机读视图（口径分立） |
| FR-C1/C2/C3/C4 | REQ-7/1 | 评测闭环（REQ-1 的保鲜增强） |
| FR-C5 | REQ-7/5 | 外部榜单参考锚 |
| FR-D1/D2 | REQ-6 | 面板与编辑器 |
| FR-D3 | REQ-5/6 | 复核提示 |
| FR-E1 | REQ-2/3 | 提示层（让排序表真的被消费） |
| FR-E2 | REQ-5 | 留痕可追溯 |
| FR-E3 | REQ-5 | 健康状态机 |

**完整性判定**：REQ-1～REQ-7 每条均有 ≥2 条 FR 承接且各有 ≥1 条 P0/P1 主承接 FR；无遗漏、无「无 FR 承接」的需求条目。基线为 05§7.1 七需求全覆盖表的承接期判定（M1/M1–M3/M1–M3/M1–M3/M1–M3+M5/M6/M4/M5+M6），本文矩阵与之逐条一致。

---

## 8. 术语表

| 术语 | 含义 |
|---|---|
| DSH / lead / 子会话 | DeepSeek Harness 运行时 / 发起派遣的主会话 / 被派遣的工人会话 |
| assignee | 派遣参数中指定子会话 provider/model 的字段 |
| channel_type | 渠道计费类型：monthly（包月）/ voucher（限期算力券）/ prepaid（预充值），财务排序一级键 |
| tier | 能力分层：overseas_sota / domestic_sota / bulk（编辑期知识） |
| capability | 渠道能力子字段（coding/tools/long_context/vision 等，编辑期知识） |
| 三池分立 | 包月、券、预充值是三个独立额度池，余额与排序均不跨池相加 |
| A/B/C/D 类适配器 | 余额可得性四级：Key 直读 / AK·CLI / 未文档化（强制熔断）/ 人工登记（00§3.2） |
| QuotaView | 适配器输出的归一化机读 JSON 视图（给模型看，非 HTML） |
| 熔断 / degraded | 连续失败达阈值后渠道标记降级、排序降权、落人工登记值；一次成功恢复 ok |
| volatile 字段 | Config 中允许设置面板热更的字段（宿主逐路径校验，须固定命名字段各自声明） |
| DecisionRecord | 每次排序的候选/淘汰/选中与逐项加减分留痕，可重放 |
| 通道② | 评测主通道：以插件身份消费宿主 llm 服务发起自己的模型调用（非改写他人请求） |
| policy 四态 | 派遣可行性标注：named / allowlist / child-default / fork（插件只标注不做权威） |
| provisional | 评测样本不足（n<8）或成本缺失时分数的临时标记，不参与建议与排序理由 |
| inherit_fallback | 无可用路由时不填 provider/model，子代理继承父会话路由（宿主缺省链语义） |

---

*本文为需求基线；实现与验收以上游论证原文（00/05/06/07）为最终依据——其中与 Day1 实测结论冲突的表述（如 volatile 数组口径），以 docs/04-mvp-notes.md 实测为准且已在正文「一致性核对」标注。上游验收原文出处已在各 AC 标注〔方括号〕。*

---

## 附录 A：修订记录

- **v1.0（2026-11-13）**：初版交付（mvp1-D-prd）。
- **v1.1（2026-11-13，审计 B 组回注，docs/03-audit-report.md §5）**：
  - M-3：`manual.status` 定义补齐——加入 FR-B1 字段集（值域 active|disabled|exhausted，缺省 active + 读侧兼容 + MVP schema 对齐说明），FR-A6 加交叉引用（上游 00§6-M4.2 本就以该字段表述，属补定义非改口径）；
  - M-4：NFR-3 volatile 口径改 Day1 实测结论（`channels[]` 数组整体 volatile、元素内抛错），附上游表述一致性核对；NFR-2 双 TTL 改「MVP 单 TTL 60s（已实测）、M2 恢复双 TTL」承接记录；
  - M-5：FR-A3 capability 语义统一为评级字符串（00§3.1 `"coding":"good"` 口径），MVP 布尔代理显式声明为过渡态（capability 过滤 M2 接入）；
  - M-6：NFR-2 新增附属条「活校验缓存陈旧窗口可见性」+ 可测验收 NFR-2a 三条；
  - m-13：FR-A1-2 字段集判据改「以工具 output.schema 为准」；
  - m-1：头部状态段同步「MVP 已实测通过、审计放行 M1」事实。
  - （A 组 8 项代码修复与 C 组 backlog 归 mvp-dev / M2+，见审计报告 §5，不在本表。）
- **v1.2（2026-11-13，用户方向澄清校准）**：**advisory-only（建议不强制）——mroute 是给会话的模型使用建议（提醒），不是强制会话用哪个模型**。①新增 NFR-0「会话自主权原则」总则（一切输出皆建议/不阻断不改写不代决策/阻断必须 opt-in 默认关闭/宿主策略门非 mroute 行为）；②FR-A6 整体重写：由「tools.guard 派遣守门拒绝（阻断）」降级为「额度/禁用 warning 标注（非阻断）」——disabled/exhausted/低余额渠道仍出现在排序表，带 warning+原因+替代建议；阻断降级为 `enforce_gate` opt-in（默认 false）；验收标准同步（A6-1 端到端拒绝→warning 呈现验证，新增 A6-3 opt-in 边界）；③追溯矩阵 REQ-3/REQ-4 与 §7.2 FR-A6 行、FR-B1-4 语境措辞同步；④术语统一：除评测人工确认（FR-C1 guard/ask，保护钱包的人工确认，非模型强制）外，「守门」一律改「提醒标注/warning 标注」。上游 mroute/ 文档未动（00§6-M4.2/05§5.3-M6.1 原阻断语义作为历史口径在 FR-A6-1/3 中注明承接方式）。
