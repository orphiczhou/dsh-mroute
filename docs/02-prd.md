# mroute PRD（02-prd.md）

- 文档编号：docs/02
- 版本：v1.2（2026-11-13；v1.1 同日审计回注、v1.0 初版同日）
- 状态：评审通过——**MVP 已实测通过**（plugin-mroute 安装激活 + `model_route_query` 实调排序正确，2026-11-13；实测记录 docs/04-mvp-notes.md / docs/04-mvp-selfcheck.md），三视角专家审计 blocker=0 放行 M1（docs/03-audit-report.md §6）；v1.1 含审计 B 组回注；**v1.2 含用户方向澄清校准：advisory-only（建议不强制）——FR-A6 由阻断降级为 warning 标注，新增会话自主权原则（docs/01 NFR-0）**
- 配套文档：需求基线见 `docs/01-requirements-spec.md`（FR-xx/NFR/追溯矩阵）；本文引用 FR 编号处不再重复验收标准。
- 上游依据：`mroute/00-feasibility-report.md`、`mroute/05-report-extension.md`、`mroute/06-market-scan.md`、`mroute/07-assembly-plan.md`。本文不改上游原文；引用一律用章节号。
- 读者假设：**未读过上游文档**。第 0 章内联必要背景；关键概念首次出现时以括号简注。

---

## 0. 背景速览（30 秒版）

DSH（DeepSeek Harness）里，主会话（lead）把任务派给子会话时要填 `assignee`（用哪个 provider/model）。用户往往同时持有三类计费渠道：**包月套餐**（月费买量）、**限期算力券**（有到期日）、**预充值余额**（现金按量）——三者是独立额度池。现状：选路全靠人脑，常见「包月还剩很多却烧现金」「券过期作废」「派到没额度的渠道半路死」。宿主只回答「哪些模型能用」，不回答「**该用哪个**」；且宿主不提供「自动改写派遣模型」的通道（00§1），所以正确的产品形态是**派遣前的参考工具 + 提醒标注**。mroute 就是这个参考层：一句话查询，返回一张带理由、带余额、带财务优先级的排序表。

**术语速查**（正文首次出现处另有括注；完整版见 docs/01 §8）：
- **channel_type**：渠道计费类型 monthly（包月）/ voucher（限期算力券）/ prepaid（预充值），财务排序一级键；
- **tier**：能力档位 overseas_sota（海外旗舰）/ domestic_sota（国内旗舰）/ bulk（廉价量产档）；
- **volatile**：Config 中允许设置面板热更的属性（宿主逐路径校验；`channels[]` 须数组整体声明，元素内声明抛错——Day1 实测，docs/01 NFR-3）；
- **活校验**：每次查询用宿主 `llm.listProviders()/listModels()` 核实渠道真实存在，缓存 TTL（MVP 60s）内存在有界的陈旧窗口（docs/01 NFR-2a）；
- **DecisionRecord**：每次排序落盘的候选/淘汰/逐项加减分留痕（`ledger/decision-<ts>.json`），可重放可审计。

---

## 1. 产品定位与价值主张

### 1.1 一句话定位

> **mroute 是 DSH 多子会话派遣的「模型选择优先参考」：指挥官派遣前一次查询，按「包月 > 券 > 预充值」的财务优先级 × 能力分层 × 实时余额/健康，拿到一张带排序理由的渠道表；只做参考与提醒标注——不改写任何请求、默认不阻断任何派遣，最终选择权永远在会话与用户（advisory-only）。**（00§1、07§0 裁决 1；v1.2 用户澄清）

### 1.2 价值主张（对三类用户）

| 用户 | 现状痛点 | mroute 价值 |
|---|---|---|
| 多渠道重度派遣用户 | 不记得哪家有量，默认烧预充值现金 | 派遣自动落在包月/券池内，现金渠道只做兜底（FR-A2） |
| 单渠道轻量用户 | 派遣撞上额度耗尽，工人会话半路死亡 | 排序表把耗尽/熔断渠道沉底并给原因，按表换下一项即可（FR-B6、FR-A4） |
| 模型尝鲜者 | 新模型 tier 凭感觉填，没人复核 | 一次有预算帽的评测给出建议，人工确认才写回排名（FR-C1～C4） |

### 1.3 差异化：市场四空白（06§三）

背景：06 对 awesome-dsh-plugin 官方目录（10,778 个插件，2026-11-12 水印）做了全目录扫描：**单点能力全部有市场先例**（多渠道余额面板、子代理路由、模型测试工具都存在，技术路线被社区反复验证、实现风险低），**但没有任何一个插件同时做到以下四点**：

1. **channel_type（包月/券/预充值）驱动的财务优先级排序**——最接近的 dsh-quota-takeover 绑定单一 OFM 网关、dsh-llm-governor 极小众且渠道覆盖不明（06§三-1）；
2. **限期算力券「剩余 ÷ 剩余天数」衰减先用**——有插件做券余额**数据**（dsh-aliyun-balance/dsh-qwen-balance），无人做衰减**排序**（06§三-2）；
3. **评测 → 建议分层 → 人工确认 → 写回注册表的排名闭环**——评测框架（dsh-eval-harness）、实测工具（dsh-model-master）、人工评级（dsh-freemodels-opencode）零件齐全，无人串联（06§三-3）；
4. **三池分立的余额机读与派遣选路联动**——余额面板只给人看，不参与选路（06§三-4）。

### 1.4 替代路径（诚实披露，06§三「给用户的三条路」）

- **路 A（零开发）**：装 dsh-quota-panel（余额全景）+ dsh-delegate-router 或 dsh-llm-fallbacks（分派/备选）。适合先验证痛点是否被覆盖 80%。
- **路 B（本 PRD，自研全家桶）**：M1–M6 全量，四个空白全部自研承接（07§1.3 S1–S4）。
- **路 B'（站在先例上组装）**：以 dsh-quota-panel 顶余额展示层，mroute 聚焦「财务排序引擎 + 评测闭环」，可压缩约 6–9 人日（07§5）。

---

## 2. 范围 In / Out

### 2.1 v1 范围（In）

| 块 | 内容 | FR 组 | 期 |
|---|---|---|---|
| 查询内核 | `model_route_query` 查询工具 + 三层排序引擎（财务一级键/tier/priority/确定性全序）+ policy 四态标注与派遣预检 | A | M1 |
| 注册表 | 插件自有 volatile Config（channel_type/tier/capability/priority/fallbacks/reviewed_at；`eval` 子对象预留位）+ manual 人工登记 | B/D | M1 |
| 自动余额 | A 类 4 渠道 Key 直读（DeepSeek/Kimi 双站/SiliconFlow/OpenRouter）+ 缓存（TTL≥60s/单飞/退避/懒预热）+ 健康状态机与熔断 | B/E | M2 |
| 扩展余额 | B 类百炼/方舟 AK·CLI 适配 + C 类智谱（强制熔断）+ D 类包月本地折算估算 + 券衰减排序 | B | M3 |
| 面板 | 设置面板「模型路由」分区：注册表可视化编辑（tier/priority/fallbacks/manual/reviewed_at）、密钥侧牌、复核提示、评测入口 | D | M4 |
| 评测 | 自建固定集 + 确定性判分 + 宿主 llm 通道评测 + 成本护栏 + EvalReport + 人工确认写回闭环 | C | M5 |
| warning 标注与榜单 | 额度/禁用 warning 标注（disabled/exhausted/低余额渠道保留在排序表，带 ⚠+原因+替代建议；**默认不阻断**）+ policy 交集过滤 + 外部榜单只读同步（阻断类 `tools.guard` 仅 `enforce_gate` opt-in，默认关闭） | A/C | M6 |
| 基础设施 | systemPrompt 提示、DecisionRecord 留痕、QuotaView 机读视图（跨期交付） | E/B | M1–M2 |

### 2.2 明确不做（Out，v1）

| 不做什么 | 理由 | 出处 |
|---|---|---|
| `llm/stream` 全局改道（自动换模型） | 作用面覆盖一切模型调用、可变语义未逐行验证，高风险；已判定「明确不做，仅存档理论通道」 | 00§7、00§5 风险 5 |
| `agent/request` 改写 | 宿主 0.2.2 起 step-fixed selection 拒绝该路径（autotier 一手实证） | 07§0 裁决 1 |
| 换档持久落点 `agent.model.select()` | 属 v2 评估项，v1 不做 | 07§0 裁决 4 |
| 运行中自动换模/failover 执行链 | 仅存 v2 蓝本（picker 换模链/startActivation），触发条件未满足不立项 | 07§1.2-B9/B10 |
| 第一版 10 渠道全覆盖 | C 类智谱与 B 类 AK 接入维护成本不成比例，放 M3 | 00§7 |
| Elo 等小样本排名算法 | 小样本不稳，v1 用加权百分制 + provisional 门槛（n<8） | 05§1.1 B |
| 真实反馈驱动排名（swarm-router 式） | v1 不做，作为 v2 可选用件 | 07§1.1-R15 |
| policy 权威化（接管宿主允许集） | 插件只做四态**标注**；宿主 policy 仍由用户在宿主设置页管理 | 07§3.4 注 2、05§4.2 检查项 4 |
| 任何委派工具 | 避免与 subagent-setup 等同类工具重名顶替 | 07§4.1 |
| promptfoo / Python 评测框架嵌入 | 自建固定集零依赖起步；外部价值由榜单同步替代 | 05§1.1 B |
| 自动改写派遣参数 | 宿主无 rewrite 通道，产品形态上也不做（参考+提醒标注） | 00§1 |

---

## 3. 用户旅程（文字版链路图）

### 3.1 主旅程：派遣前选路（对齐 00§4 消费路径；数值为说明性样例）

```
lead 会话收到一个需要派遣子会话的任务
  │   〔systemPrompt 已含一句提示（FR-E1）：「派遣前先查 model_route_query」〕
  │
  ├─ lead 调用：model_route_query { capability:"coding", tier_min:"domestic_sota",
  │                                budget:"monthly_first", exclude_degraded:true }
  │
  ├─ 插件内部（毫秒级，余额走缓存 FR-B5）：
  │     读注册表 → capability/tier 过滤（FR-A3）→ 活校验渠道还活着（FR-A3）
  │     → 财务加权排序：monthly > voucher[衰减 FR-B7] > prepaid[低额降权]（FR-A2）
  │     → 健康/账本降权：degraded 沉底并标注（FR-B6/FR-E3）
  │     → 产出排序表（每条带 policy 态与派遣预检 FR-A5、带理由 reason）：
  │
  │   返回示例：
  │   1. zai-coding-cn     (monthly, 剩余≈72%, health=ok, 理由: 包月优先+coding 强)
  │   2. volc-ark          (monthly, 窗口剩余 88%, reset_at=+3h, ok)
  │   3. deepseek-official (prepaid, ¥43.2, ok, 理由: 余额充足兜底)
  │   ⚠ anthropic-sub     (monthly, 人工登记+估算, 数据截至 2026-11-12)
  │
  ├─ lead 选第 1 名，填派遣参数：
  │     tree_dispatch { ..., assignee: { provider:"zai-coding-cn", model:"glm-…" } }
  │
  ├─ 宿主活校验/策略门：
  │     ├─ 通过 → 派遣发生，旅程结束 ✅
  │     └─ 被 assertAllowedModelSelection 拒（route 不在会话 policy 内）
  │          → 工具返回明确错误 → lead 按返回表换第 2 名重试（无需再查插件）
  │          → 第 2 名通过 → 派遣发生 ✅  〔FR-A4-3 端到端验收即此旅程〕
  │
  └─ 本次消耗若涉 D 类渠道，由本地 TokenUsage 折算累计进估算账（FR-B8）
```

要点：**最终选择权与重试都在 lead**；插件排序表已把 policy 兼容性作为前置输入（00§4 要点）。

### 3.2 旅程二：额度耗尽前切换

```
某渠道额度耗尽 / C 类接口连续失败
  → 熔断器标记 degraded / 账本记 exhausted（FR-B6，附 until/resetsAt）
  → 下一次查询：运行时账本命中的渠道沉底或出列，excluded[] 带 why（cooling/exhausted/degraded）（FR-A2 L2 mask）
  → 注册表静态标记的禁用/欠费渠道：仍保留在排序表中，带 ⚠ warning + 原因 + 替代建议（FR-A6）
     ——lead 知情后自主决定，默认不阻断（阻断仅 enforce_gate opt-in，M6）
  → 全部渠道耗尽：返回 waiting=true + 最近 resetsAt，lead 决定等待或走继承路由
    （FR-A4，不硬派必死的派遣）
```

### 3.3 旅程三：新模型上手评估（M5）

```
用户接入新模型 → 面板「模型路由」分区点「运行评测」（或 model_eval_run 工具+人工确认）
  → 成本护栏四层检查：预算帽 / 余额<预估×3 拒跑 / 包月全量·prepaid 冒烟 / 串行限流（FR-C1）
  → 通道②串行逐题跑四类固定集 → 确定性判分 → EvalReport
     （分项得分 + composite + suggested_tier/priority + 证据链；样本不足标 provisional，FR-C2/C3）
  → 面板 diff 高亮：当前 tier/priority vs 建议
  → 人工「确认采纳」→ 原子写回（registry_version+1、reviewed_at 刷新）
     → 下一次 model_route_query 立即吃到新排名 ✅
     （或「忽略」→ 留档不写回；机器永不擅自改分层，FR-C4）
```

---

## 4. 功能规格（按 FR 组展开关键行为）

### 4.1 查询与排序（FR 组 A）

- **查询工具**（FR-A1）：入参全可选（`capability/tier_min/budget/exclude_degraded/refresh`），缺省返回全量排序表；返回为机读 JSON（`current/routes/excluded/inherit_fallback/meta`），渠道端点原始响应**不出宿主**。
- **排序引擎**（FR-A2）：三层组合——L1 静态真源（channel_type 一级键 monthly<voucher<prepaid，同档 priority 降序，routeProvider 字典序兜底）；L2 账本 mask（静态序不变，exhausted 出列 / cooling 沉底，带 why 与 until）；L3 感知微调（同档内加减分：eval.composite、健康惩罚——**一次成功即解除冷却，冷却是降级不是封禁**）。全序确定性，同输入可重放（07§3.5）。M5 起 eval.composite 仅作 tier 内次级**建议性**因子（05§2）。
- **分层与过滤**（FR-A3）：tier/capability 是编辑期知识（带 `reviewed_at` 保鲜）；provider/models 是运行期知识（每次查询活校验，注册表写了不存在的 provider 标 unknown 降权）——两层分开保鲜（00§3.1 设计要点）。
- **备选与降级**（FR-A4）：`fallbacks[]` 显式备选链；悬空引用读时告警不拒写；全耗尽返回 waiting 语义；无可用路由不填 provider/model（继承父路由语义写进返回）。
- **policy 四态与预检**（FR-A5）：每条 route 标 named/allowlist/child-default/fork + `dispatch_precheck`（provider 可路由/工具可见性/深度余量），让模型派遣前就知道哪条会过门；M6 起排序前做 policy 交集过滤。
- **warning 标注（非阻断）**（FR-A6，v1.2 方向校准）：注册表静态标记 disabled/exhausted 与低余额渠道**仍出现在排序表中**，条目带 ⚠ warning + 原因 + 替代建议（fallbacks 或下一项）；**不阻断派遣，会话知情后自主决定**。`tools.guard` 阻断降级为 `enforce_gate` opt-in 可选（默认 false，仅用户显式开启时生效）——总则见 docs/01 NFR-0「会话自主权原则」。
- **输出措辞纪律**（07§3.4 注 1）：路由条目以「用途描述」为主键、provider/model 为注脚；`channel_id` 保持中性（渠道语义名），强弱势信息只写进 description——避免模型按名字脑补（subagent-setup 别名实验：中性句柄 8/8 命中，身份暗示句柄 0/2）。

### 4.2 额度感知（FR 组 B）

- **四级适配器**（FR-B1～B4）：

| 级 | 渠道 | 凭证 | 机制 | 失败策略 |
|---|---|---|---|---|
| A | DeepSeek、Kimi 双站、SiliconFlow、OpenRouter | 模型 API Key | Bearer GET 官方端点；DeepSeek 优先宿主先例 | 失败报 unknown 不静默 |
| B | 百炼（BSS+Token Plan）、方舟（usage plan）、OpenRouter /credits（可选） | AK-SK 独立槽位+最小权限提示 | 官方 OpenAPI/CLI；百炼唯一可查资源包有效期、方舟唯一官方套餐剩余+reset_at | 官方接口，失败即报 |
| C | 智谱 biz 网关 | 站内凭据 | 第三方实测接口，官方随时可改版 | **强制熔断**（默认 3 次）→ degraded → 落 manual，标「尽力而为」 |
| D | 订阅制与无 API 渠道 | 无 | 人工登记总额+到期日；消耗由本地 TokenUsage 按官方系数折算累计，定期对账校准 | 永不返回空（manual 统一落点） |

（00§3.2 表；实现出处与签名黄金测试见 07§1.1-R3~R8。）

- **缓存与熔断**（FR-B5/B6/E3）：TTL≥60s（渠道级可覆盖）+ 单飞去重 + 失败退避占位（失败结果也占缓存位）+ 懒预热；健康三态 ok/degraded/unknown，刷新失败保留旧值标 stale。延迟口径（Admin 用量 5–30min~T+1）写进元数据、只降权不硬门（00§3.3、00§5 风险 6）。
- **券衰减**（FR-B7）：voucher 档内按 `剩余额 ÷ max(剩余天数,1)` 紧迫度降序排前，先用快过期的券；缺到期日/余额数据不打乱原序（⚠ 07§3.5 注释方向笔误已勘误，以 docs/01 FR-B7 定义为准）。
- **包月折算**（FR-B8）：系数表版本化（`coeff_table_ref`）；展示永远标「估算 + 数据截至」；对账目标比值 ≤1.05（先例实测 1.0000，00§6-M3.4）。
- **QuotaView**（FR-B9）：`describe()` 归一化 JSON 给模型看；口径隔离（usage/billing 不混、智谱两额度池分立）；「缺失绝不伪造 0%」。

### 4.3 评测排名（FR 组 C）

- **触发与护栏**（FR-C1）：面板按钮（主）+ `model_eval_run` 工具（辅，`tools.guard/ask` 人工确认，description 明写烧钱警告）；预算帽 per_run/monthly（volatile Config 可面板调）、余额<预估×3 拒跑、包月全量/prepaid 冒烟 5 题、串行限流+熔断续跑、超限停留 partial（05§1.1 B）。
- **执行与判分**（FR-C2）：主通道②=宿主 llm 服务（自动复用适配器/凭据/retry/usage，对派遣链路保真度最高；effort 用 `prepareCall` configure 回调钉死）；固定集四类各 10–20 题、suite_version 化；判分器确定性（JSON schema/关键词/结构断言，零 LLM judge）；finish kind 宽表兼容（未知 kind 显式失败）；哨兵破判整轮 `instrument_unhealthy`。
- **建议输出**（FR-C3）：EvalReport = 分项得分 + composite + suggested_tier/priority + 证据链（阈值/榜单引用）；provisional 门槛 n<8；性能探针（TTFT/TPS）只作参考列；逐题明细落 `eval-history/`（Config 保持可读可 diff）。
- **人工确认写回**（FR-C4）：评测只产建议；面板 diff 高亮 →「确认采纳」→ Host 侧 `configEditor.edit` 原子写回（registry_version+1、eval 摘要、reviewed_at 刷新）→ 下次查询立即生效；「忽略」留档；机器估分永远压不过人工确认（source 显式区分）。
- **外部榜单**（FR-C5）：只读参考层，**绝不自动改 tier**；OpenRouter /api/v1/models 作第 0 源（免鉴权机读），Aider/SWE-bench/LiveCodeBench/LMArena 顺延；alias 未映射进待人工映射队列；快照带 provenance（07§1.2-B18）。

### 4.4 面板运维（FR 组 D）

- **分区挂载**（FR-D1）：`settings.section` 一等公民 slot（第三方两例在线实证）；Client slot + React；`openSection('model-route')` 可直达；order 15–20。
- **可视化编辑**（FR-D2）：tier/priority/fallbacks/manual/reviewed_at 面板可编辑；两条写链分工——常规编辑走 client 侧 `settings.mutate`（volatile 热更、revision 冲突可恢复、保存不重启立即生效），评测采纳走 Host 侧 `configEditor.edit`（多字段原子联动）；密钥只显侧牌；非法值双保险（客户端 validate + 激活 schema 兜底）（05§2.1/2.2）。
- **复核提示**（FR-D3）：`reviewed_at` 超期（>90 天，设定值）在工具返回与面板双向提示；M5 起 `reviewed_against` 挂三锚点（评测套件版本/榜单日期/指纹 hash）。

### 4.5 基础设施（FR 组 E）

- **systemPrompt 提示**（FR-E1）：一句话+工具名+降级说明；限定文案避免与已装路由类插件指引打架（07§4.1）。
- **DecisionRecord**（FR-E2）：每次排序落 `ledger/decision-<ts>.json`（候选/淘汰/逐项加减分），可重放可审计。
- **健康状态机**（FR-E3）：health 三态 + last_check/last_error/连续失败计数；unknown 不冒充 ok；stale 保留旧值。

---

## 5. 里程碑与发布计划（对齐 05§5，工期引 07§5）

| 期 | 目标 | 主要交付 | 验收出口 | 人日（07§5） |
|---|---|---|---|---|
| **M1** | 参考层闭环（零外呼）：查询→选路→派遣可演示 | 插件骨架 + volatile 注册表 schema（含 eval 预留、嵌套实测）+ `model_route_query` + 三层排序引擎（L1+空账本）+ manual 登记 + systemPrompt 提示 + policy 四态/预检 + DecisionRecord | 00§6-M1 四条 + 05§5.3 增补两条（volatile 结构审查、eval 预留位），共六条全绿；本机 5 provider 端到端闭环一次（含被 policy 拒后换下一项成功） | **6–9** |
| **M2** | A 类自动余额上线 | 四渠道适配器 + QuotaView 契约 + 缓存/单飞/退避 + 健康状态机与熔断（A 类生效） | 真实 Key×4 各拉到余额；TTL 内零新增外呼；密钥无明文；错 Key→degraded→恢复→ok | **4–6** |
| **M3** | 余额面全覆盖 | B 类百炼/方舟 + C 类智谱（强制熔断）+ D 类折算估算 + 券衰减排序 | 方舟 periods+reset_at 语义正确；百炼资源包有效期入排序；智谱 3 连败→degraded→manual；对账比值有记录且 ≤1.05 | **5–8** |
| **M4** | 注册表可视化编辑器 | 设置面板分区 + 五类字段编辑 + 两条写链 + 密钥侧牌 + locale×8 + 主题 token | 05§5.3-M4 六条（含：保存不重启查询立即生效、revision 冲突可恢复、密钥侧牌、purity gate 构建通过） | **5–8** |
| **M5** | 评测排名闭环 | 固定集+判分器 + 通道② runner + 四层护栏 + EvalReport + 面板 diff 与确认写回 | 05§5.3-M5 六条（含护栏生效、写回联动、provisional 门槛、guard/ask 弹窗、明细落盘、判分器无 eval） | **8–12** |
| **M6** | warning 标注与榜单收尾 | 额度/禁用 warning 标注（默认非阻断）+ policy 交集过滤 + 榜单同步器 + alias 映射队列 | FR-A6 三条（warning 呈现 / 不阻断 / `enforce_gate` opt-in 边界）+ 05§5.3-M6 榜单两条（落盘只读展示、镜像失败降级标注；其第 1 条的「守门拒绝」语义按 v1.2 校准由 opt-in 路径承接，见 docs/01 FR-A6-3） | **3–5** |

- **主线与顺序**：05§5.1 编号 M1→M6 串行；07§5 给出主线组合 **M1→M2→M4→M5 合计约 23–35 人日**，M3/M6 为附注可并行/按需插入（M4 提前的理由：机制风险≈0、反哺 M1–M3 运维体验、M5 的确认 UI 依赖面板，05§5.2）。
- **第一周开工顺序**（07§6）：Day1 包骨架+嵌套对象 Config 实测（M1 唯一环境风险点）→ Day2–3 schema 定稿+目录/活校验 → Day4–6 排序引擎 → Day7–9 工具/提示+端到端联调 → M1 六条验收。
- **压缩选项**：路 B'（quota-panel 顶余额展示）可省 M2/M4 约 6–9 人日，但 **M1 的 schema volatile 化与 eval 预留位不可省**（返工成本不对称，05§7.2）。
- **取舍**：M4 编辑器与 M5 评测相互独立可按需取舍；跳过 M4 做 M5 时确认 UI 可退化为 session command 通道，不推荐（05§7.3）。
- **MVP 实测注记（audit m-1 状态同步，2026-11-13）**：M1 已以裁剪范围先行实测通过——安装激活成功 + `model_route_query` 实调返回五渠道排序正确（channel_type 一级键前置、priority 序正确、当前路由识别正确，audit §4.1 表）。裁剪口径与已知限制 7 条见 docs/04-mvp-selfcheck.md §5；**MVP 实测不替代完整 M1 验收**，正式验收仍按上表（00§6-M1 四条 + 05§5.3 增补两条）。

---

## 6. 成功指标

> ⚠ 标注纪律：上游未给任何运营基线数值，以下目标值除特别注明外均为**本 PRD 设定的假设目标**（【假设】），M1 上线后先测真实基线再修订。可测口径与 FR/NFR 验收共用。

| # | 指标 | 目标 | 性质与口径 |
|---|---|---|---|
| K1 | 查询采纳率：`model_route_query` 周调用次数 | ≥20 次/周（活跃使用期） | 【假设】派遣量因人而异；口径=工具调用日志计数 |
| K2 | 财务转移：monthly 池承载的派遣占比 | ≥60% | 【假设】基线未测；口径=DecisionRecord 中 selected 路由的 channel_type 分布 |
| K3 | 预充值现金支出环比 | M3 后逐月下降（相对上线前基线） | 【假设】需用户自报账单对照；插件侧只能给代理指标 K2 |
| K4 | 派遣可靠性：因额度耗尽/接口失效导致的派遣失败重试 | ≤2 次/周 | 【假设】口径=lead 会话内策略门/额度类报错后改派计数 |
| K5 | 排序可解释性：每次查询带 reason+DecisionRecord | 100% | 【硬指标】FR-E2 验收同源，非假设 |
| K6 | 运维效率：一次 manual 登记/复核修改 | ≤3 步面板操作、零重启（M4 后） | 【硬指标·M4 后】FR-D2-1 同源 |
| K7 | 保鲜度：渠道 reviewed_at 距今天数 | 全部 <90 天 | 【假设·阈值本 PRD 设定】FR-A3-4/D3 同源 |
| K8 | 评测采纳：每月「确认采纳」次数 | M5 后 ≥1 次/月 | 【假设】依赖用户评测频率 |
| K9 | 折算精度：D 类对账误差比值 | ≤1.05（目标≈1.0；先例实测 1.0000） | 【阈值本 PRD 设定，上游目标为「接近 1.0」】FR-B8-1 同源 |
| K10 | 查询性能：缓存命中 P95 | ≤500ms | 【阈值本 PRD 设定】NFR-2 同源 |

北极星建议取 **K2（monthly 池承载占比）**：它直接代理「别烧错池子」这一核心价值，且可由 DecisionRecord 机读导出，无需用户自报。

---

## 7. 风险与缓解（Top 表，R1–R13 精简）

| # | 风险 | 等级 | 对产品的影响 | 缓解（承接 FR/NFR） | 出处 |
|---|---|---|---|---|---|
| 1 | **评测成本失控**：评测烧真实渠道额度；模型自主调用 `model_eval_run` 烧钱 | 中高 | 用户财产损失、信任崩塌 | 四层护栏全上（预算帽/余额联动/冒烟/串行）+ guard/ask 人工确认 + description 明写烧钱警告（FR-C1） | 05§6 R11 |
| 2 | **密钥安全**：余额凭证≠模型 Key；AK 权限远大于模型 Key | 中高 | 凭据泄漏=资损 | 全走 `ctx.credentials` 永不回显；AK 独立槽位+最小权限提示（NFR-1、FR-B2-2/B3-3） | 00§5 R2 |
| 3 | **未文档化接口失效**：智谱 biz 接口改版/加签即失效 | 中高 | C 类余额断供 | 强制熔断→degraded→落 manual；标「尽力而为」（FR-B4）；失效不阻塞主链路 | 00§5 R1 |
| 4 | **volatile 字段硬约束**：整表 volatile dict 直接不可编辑；数组元素 volatile 陷阱 | 中（设计期一次性规避） | M4 编辑器整体不可用 | 「固定命名字段各自 .volatile()」+ 数组整条替换 + M1 结构审查验收（NFR-3、FR-D2） | 05§6 R8 |
| 5 | **包月估算漂移**：系数调价/口径变更/对账缺失致估算失真 | 中 | 用户误信估算烧穿套餐 | 系数表版本引用 + 定期对账 + 「估算」标识永不冒充机读（FR-B8）；优先接官方机读 | 00§5 R3 |
| 6 | **能力分层过时**：tier/priority 编辑期知识失真 | 中 | 排序推荐错误 | reviewed_at+复核提示 + 评测/榜单/指纹三锚点增强（FR-A3/D3/C3/C5）；tier 保持人工语义 | 00§5 R4 |
| 7 | **榜单 alias 误映射**：错误映射让分数张冠李戴 | 中 | 人工参考被误导 | 人工校准映射表；未映射进队列不进交叉引用；榜单整体只读不改 tier（FR-C5） | 05§6 R10 |
| 8 | **红线触碰（做=高风险）**：llm/stream 或 agent/request 改道 | 高（若做） | 架构审计 blocker；宿主演进撞墙 | **明确不做**；静态扫描挂载点为验收项（NFR-3、00§5 R5） | 00§5 R5、07 裁决 1 |
| 9 | **数据延迟误判**：Admin 用量 5–30min~T+1 延迟 | 低 | 短窗口余额误读 | 延迟口径入元数据 + as_of 标注 + 只降权不硬门（FR-B5/E3/NFR-5） | 00§5 R6 |
| 10 | **client purity gate**：跨插件值 import 构建失败 | 低 | M4 构建受阻 | 照抄宿主 primitives 形状、类名前缀化、只用 --dsw-alias-* token（FR-D1-2） | 05§6 R9 |
| 11 | **面板 locale 覆盖**：只注册 zh/en 是否被 locale 服务接受未验证 | 低 | 面板显示回落/key 裸露 | 保守跟随惯例注册 8 语种；先 zh/en 实测再定（开放问题 4） | 05§6 R12 |
| 12 | **评测采样参数控制面未证实**：temperature/top_p 透传未验证 | 低 | 需固定采样的题测不出分布 | M5 首跑前一次验证实验；未证实前该类题走通道①（开放问题 5） | 05§6 R13 |
| 13 | **开发期工具损坏**：inspect exact-query 本 build 被拒 | 低（开发期） | 类型证据取证绕路 | 以运行时实测为准；移植先例源码在库（AGENTS.md §4） | 00§5 R7 |

---

## 8. 开放问题

### 待 MVP 实测（实现期第 1–3 天内闭合）

1. **schemastery 嵌套实测结论**：`capability{}/manual{}/eval{}` 三个嵌套对象写入 Config→重启→读回是否逐键存活；任一不过 → 该字段降级 JSON 字符串（07§3.2-3）。这是 M1 唯一环境风险点，结论决定 schema 形状（对应 AGENTS.md §4 schemastery 坑）。
2. **券衰减排序方向勘误确认**：07§3.5 注释「小者排前」与其解释矛盾；本文按 00§3.1「先用快过期的券」统一定义为紧迫度大者排前（docs/01 FR-B7-1 有可测用例）——实现者按 FR-B7 执行并修正代码注释。
3. **DeepSeek 宿主先例可用性**：`deepseekAccount.getBalance` 在当前宿主版本是否可注入调用；可用则 A 类 DeepSeek 走宿主、HTTP 兜底（07§3.3 表）。
4. **locale 服务行为**：只注册 zh/en 是否被 locale 服务接受（05§6 R12）——决定词典补全策略。

### 待用户决策

5. **M4 面板排期**：默认 M4（紧跟 M3）；备选 M1.5（M1 后立即做，代价是过早摊开 UI 工程）——05§5.2 备选方案，默认不推荐。
6. **是否走路 B' 压缩**：以 dsh-quota-panel 顶余额展示层省 6–9 人日，代价是余额层依赖第三方插件存活（07§5）。
7. **与已装路由类插件的二选一**：已装 dsh-delegate-router/autotier/dsh-llm-fallbacks/dsh-llm-governor 任一的用户，需在「财务维度（mroute）」与「任务轻重分派（它们）」间选择，避免两套指引打架（07§4.4）。
8. **M5 是否跳过 M4 直接做**：确认 UI 可退化为 session command 通道，体验差，不推荐（05§7.3）。
9. **peerDependencies 宿主线 pin 策略**：是否精确 pin 到 rc 版本（仿 quota-panel），由实现期决定（07§4.3-2）。

### 后续期事项（v1.1+ 备忘）

10. **eval-harness LICENSE 补取**：若未来要抄其 judge 协议实现，先从 GitHub 补取 LICENSE 留档；当前只借鉴形状（07§4.2）。
11. **v2 候选清单**（不承诺）：`agent.model.select()` 换档、picker scoped 换模执行链、startActivation 运行中 failover、swarm-router 式真实反馈排名、subagent-custom 会话内改道缝评估（07§1.2-B9/B10、06§二-2、07§0 裁决 4）。
12. **外部榜单 alias 初始映射表**的人工校准工作量评估（M6 前置，05§6 R10）。

---

## 附：上游文档导读（供溯源）

| 文档 | 一句话 | 本文主要引用 |
|---|---|---|
| 00-feasibility-report | 总可行性：七需求对照、注册表 schema、消费路径、风险 1–7、MVP M1–M4 | §1/§2/§3/§4/§5/§6/§7 |
| 05-report-extension | 增补两需求（面板编辑/评测）、M1–M6 重排、验收增补、风险 8–13、与 00 的一致性核对 | §1/§2/§3/§5/§6/§7 |
| 06-market-scan | 10,778 插件全目录扫描：单点全有先例、全家桶四空白、三条路建议 | §一/§二/§三 |
| 07-assembly-plan | 组装施工图：三分清单（R1–R16/B1–B20/S1–S6）、M1 拆解 S1–S6、工期估算 | §0/§1/§3/§4/§5/§6 |

### 常引章节速查（一句摘要，audit m-14）

| 引用 | 一句摘要 |
|---|---|
| 00§1 | 上游总结论：推荐「参考工具型」插件；派遣参数自动改写不可行也不必要 |
| 00§2 | 原始五需求的逐条技术对照表（每条带支撑点与依据） |
| 00§3.1 | 模型注册表 schema 草案（channel_type/tier/capability/fallbacks/balance/manual 字段与设计要点） |
| 00§3.2 | 余额适配器 A/B/C/D 四级分类表（凭证/机制/熔断策略） |
| 00§3.3 | 缓存（≥60s TTL）与熔断（失败 N 次→degraded）设计 |
| 00§4 | 指挥官派遣前消费路径全流程（查询→选路→派遣→被拒换下一项） |
| 00§5 | 上游风险清单 R1–R7 |
| 00§6 | MVP 分期验收标准原文（M1–M4 逐条） |
| 00§7 | 上游结论与建议（值得做；不建议 llm/stream 改道与首版 10 渠道全覆盖） |
| 05§1.1 | 两条新需求（面板编辑/评测）的逐条可行性判定 |
| 05§2 | 更新后架构图与两条数据流（编辑→volatile 热更链路 / 评测→确认写回链路） |
| 05§3 | 增补需求 6/7 的技术对照增补表 |
| 05§5 | M1–M6 重排路线（§5.1 表、§5.2 理由、§5.3 各期验收增补原文） |
| 05§6 | 风险增补 R8–R13 |
| 05§7 | 完整立项视图（七需求全覆盖表/排期取舍） |
| 06§一 | 分需求竞品对照地图（余额/路由/评测/监测四类先例逐个对比） |
| 06§三 | 市场四空白确认与「给用户的三条路」（路 A 零开发 / 路 B 全自研 / 路 B' 组装） |
| 07§0 | 组装方案一页结论与五条关键裁决（红线/真源/通道） |
| 07§1 | 三分清单：直接复用 R1–R16 / 改造借鉴 B1–B20 / 自研核心 S1–S6 |
| 07§3 | M1 开工方案（schema 定稿要点、`model_route_query` 返回 schema **草案**、排序引擎伪代码、S1–S6 步骤与验收） |
| 07§4 | 依赖与冲突风险（同装冲突清单/许可合规/维护边界/功能重叠二选一） |
| 07§5 | 工期估算表（M1 6–9 / M2 4–6 / M3 5–8 / M4 5–8 / M5 8–12 / M6 3–5 人日；主线 23–35 人日） |

*本文与 docs/01-requirements-spec.md（需求基线）配套使用；两者与上游冲突时以上游论证原文为准——其中与 Day1 实测结论冲突的表述（如 volatile 数组口径）以 docs/04-mvp-notes.md 实测为准（辨析见 docs/01 NFR-3 一致性核对）。*
