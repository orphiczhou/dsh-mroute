# M5 自动评测 · 多专家计划书（共享任务书）

> 本文件是三位专家（E1 通道/工程、E2 评测设计、E3 产品/风险）的**共同事实底**。各自只写自己角度的一份文档，不写代码、不改插件、不发布任何东西。

## 0 背景（一句话）

`plugin-mroute` 是 DSH 多子会话派遣的**模型选择建议**插件（advisory-only，不阻断），当前版本 `0.8.2-m4.11`，已有：财务优先级排序（monthly > voucher > prepaid → tier → priority）、渠道余额机读（quota 插件快照）、动态沉底（窗口/金额阈值）、渠道级+统一模型名六维能力档位（`coding / tools / long_context / vision / world_knowledge / orchestration`）、`need` 能力匹配、`mroute_dispatch_plan` 派发预检、设置面板编辑器、以及一份会话审计器（`plugin-mroute/devtools/audit-sessions.mjs`，响应率 70%）。

**M5 = 自动评测**：让插件能自己跑一批小任务、给模型的六维能力打分，把分数写进注册表 `eval` 字段（`suggest{ tier, priority }` → 用户确认 → 写回），最终让「能力档位」从人工登记变成「实测优先、人工复核」。

用户目标（原文）：「M5 自动评测，多专家共同制定计划，然后先跑个MVP摸清地图。」——即：先出**计划**（本阶段），再跑一个**最小可运行 MVP** 把地图摸清（通道能不能通、成本多少、判分靠不靠得住、写回链路闭环不闭环），不追求一次做全。

## 1 必须遵守的既有结论（不要推翻，除非有证据）

1. **eval 字段集已冻结**（`mroute/07-assembly-plan.md:205`）：`last_run / scores{四类} / composite / suggest{tier,priority} / evidence_refs` + 四个实证字段 `applied_effort / instrument_healthy / probe{ttft_ms,tps,samples,ttft_spread} / fingerprint{system_fingerprint,prompt_tokens,shape_hash,checked_at}`。
2. **当前 eval 只是空占位**：`plugin-mroute/lib/config-schema.js` 里 `eval: z.object({}).default({}).volatile()`。
3. **评测通道②=宿主 llm 服务**（`ctx.llm`）：`prepareCall` / `stream` 公开，effort 用 `prepareCall` 第三参 configure 回调钉死；已有先例 4 插件（`lib/livecheck.js` 已用 `ctx.llm.listProviders()/listModels()`）。
4. **判分纪律借鉴 eval-harness**（`mroute/07d-eval-monitoring.md`）：assert 键集映射、哨兵 must-pass/must-fail 破判整轮 `instrument_unhealthy`、judge 末行 PASS/FAIL 协议、TPR/TNR≥0.9 校准、Wilson 95% 下界给 provisional。
5. **finish kind 词表有代次漂移**：`completed|stop` 均算成功，未知 kind 显式失败并附原文，不许静默放行。
6. **成本护栏四层**（07 方案 §M5 估工 8–12 人日）：单轮题量上限、单模型 token 预算、全局日预算、连续失败熔断。
7. **红线**：advisory-only（分数只影响建议，不阻断派发）；不碰 `llm/stream` 改道、不包装 provider、不监听 `agent/request`；凭据只走 `ctx.credentials`；面板只用 theme token + `mroute-` 前缀；宿主工具 JSON schema **禁 type 数组**（`type: ['string','null']` 会让整套工具注册失败）。

## 2 已实测的环境事实（可直接引用，不要重复踩）

- 桌面端 client origin 是 `dsh-app://app`，client 不能直连宿主机 HTTP；client↔host 只能走 `ctx.remote.*`（返回 `{ok,value}` 信封，须解包）。
- 宿主设置写链：`ctx.get('configEditor').edit(entry, current => next)`，`entry = ctx.fiber.entry`；volatile 字段热更、非 volatile 会重启插件；`channels[]` 数组整体 volatile 合法，但**数组元素内禁 `.volatile()`**。
- 插件工具注册必须**平级 try**（一个工具 schema 非法会连累其它工具），注册后可用 host Inspect `Tool.listTools` 核对。
- 会话日志位置：`C:\Users\sir_c\.dsh\sessions\<slug>\session-<uuid>\session.v4.jsonl.zstd`（多帧 zstd，需逐帧解）。
- 现役渠道与余额（2026-11-20 快照）：zai-coding-cn（包月，5h/周窗口）、opencode-go（包月，5h/周/月窗口）、deepseek-official / deepseek-account（赠金 ¥28.x）、xiaomi（¥57.9）；模型目录以 `ctx.llm.listModels(provider)` 为准。
- 可用工具面（本实例）：`model_route_query`、`model_route_sync_models`、`model_route_alias_suggest`、`mroute_dispatch_plan`；技能 `mroute-dispatch` 已全局安装。

## 3 必读文件（按角度挑，别全读）

- `mroute/07-assembly-plan.md`（§S2/S3、§205 eval 字段集、§M5 估工、§426）
- `mroute/07d-eval-monitoring.md`（八插件评测监测：判分/哨兵/校准/指纹）
- `mroute/04-ranking-and-eval.md` 或 `mroute/04-*.md`（评测排名调研，若存在）
- `plugin-mroute/lib/config-schema.js`（eval 占位、channels/rating 形状）
- `plugin-mroute/lib/livecheck.js`（`ctx.llm` 现有用法）
- `plugin-mroute/lib/capability-need.js`（六维评级闭集与 `RATING_RANK`）
- `plugin-mroute/lib/tool-query.js`（`assembleRouteTable` 装配与输出契约）
- `docs/06-recommendation-algorithm.md`（排序口径与维度定义）
- `docs/09-multi-model-session-audit.md`（为什么会话审计能给出「响应率」这类客观指标）

## 4 三个角度（各写一份，互不重复）

### E1 · 通道与工程可行性（产出 `docs/briefs/m5-plan-channel.md`）
必须回答（逐条编号，每条给源码/实测证据）：
1. `ctx.llm.prepareCall/stream` 的确切调用序列（含 effort 钉死写法）、返回值形状、finish kind 实际取值、usage/token 计数从哪拿。
2. 串行/并发边界：同 provider 能并发几路不被限流；如何做单飞与超时取消；失败重试与熔断的落点。
3. 性能探针（`probe.ttft_ms/tps/samples/spread`）如何在不污染判分的前提下采集。
4. 结果落地：JSONL 历史（按天分片）+ 注册表 `eval` 写回 + `evidence_refs` 指向什么；原子写与坏数据隔离怎么写。
5. MVP 最小可行链路：一个 `model_eval_run`（或 devtools 脚本）最少要哪几个函数、能否在 1 天内跑通；列出「跑不通就得改设计」的三个硬风险。
6. 成本实测口径：单题 token 估算、整轮预算、如何避免把包月渠道窗口打爆。

### E2 · 评测设计与指标（产出 `docs/briefs/m5-plan-design.md`）
必须回答：
1. 六维能力各用**什么题型**测（每维 2–3 个题型，给示例 prompt 与判分方式）；哪些维度**不适合**自动评测（如 `orchestration` 需要多轮/工具），给出替代口径或明确「不测」。
2. 判分策略分层：确定性判分（exact/regex/schema/数值）优先 → LLM-judge（rubric + 末行 PASS/FAIL）兜底；judge 用哪个模型、如何避免自评偏差（同族 skew）。
3. 样本量与统计：每模型每维多少题才能给出可信分；TPR/TNR 校准怎么做；Wilson 下界与 `provisional` 标记的阈值。
4. 偏差控制：位置/顺序偏差、温度与 effort 不统一、缓存命中、多语言、输出格式漂移。
5. 分数→`suggest{tier,priority}` 的映射规则（保守、可解释、可手改），以及和现有「渠道级 tier / 统一模型名档位」的关系（谁覆盖谁）。
6. 一套 suite 的**文件格式**（JSON）草案 + 一个最小 suite（每维 1 题）的完整样例。

### E3 · 产品落地与风险（产出 `docs/briefs/m5-plan-product.md`）
必须回答：
1. 用户可见形态：面板里评测入口长什么样（按钮/进度/报告 diff/「确认采纳」），host 工具参数与返回怎么设计（`model_eval_run`）。
2. MVP 范围切割：哪些进 MVP、哪些留 M5.1；给出「一天能验完」的验收清单（可勾选）。
3. 成本与护栏的产品侧表达（预算上限怎么设、超了怎么提示、失败怎么降级）。
4. 与既有功能的耦合点：动态沉底、`need` 匹配、`mroute_dispatch_plan` 是否要读 eval 分数；读的话顺序与冲突规则。
5. 隐私与安全：评测 prompt 会不会带用户代码/密钥；日志落盘边界。
6. 里程碑拆分（M5-MVP / M5.1 / M5.2）+ 每档验收标准；明确列出需要用户裁决的问题（≤5 条，单选/多选形式）。

## 5 输出纪律

- 文档：各自路径，**中文**，每个结论带证据（文件:行号 / 实测输出摘录 / 官方文档链接）。不要写「大概/应该」。
- 篇幅：每份 120–200 行，宁可少写不要空话；必须包含一节「我与其他角度可能冲突的判断」（便于 lead 合并）。
- 回答：最后只回 ≤12 行摘要（三条最强结论 + 两个最大风险 + 你对 MVP 的一句话建议），不要复述文档。
- 边界：**只读**评审与设计，不修改 `plugin-mroute/` 任何代码，不新增文件到仓库根，不提交 git。
- 如果发现任务书事实有误（例如源码里 eval 字段形状不同），直接在文档里写「任务书纠偏」小节，并以源码为准。
