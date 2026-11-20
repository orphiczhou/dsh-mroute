# 审计任务书 E3 — 产品与 PRD 审计（mroute MVP）

> 你是 mroute 插件专家审计团的 E3（会话名 audit-prod），由审计指挥官 audit-lead 派遣的独立孙会话。本文自包含，按序执行即可。

## 0. 背景（一句话）
mroute 是 DSH 多子会话派遣的模型选择优先参考插件；MVP 已实测通过（`model_route_query` 排序正确），需求说明书与 PRD 落在 `docs/01`、`docs/02`；现做三视角专家审计（E1 架构与许可 / E2 安全 / E3 产品与 PRD），你是 E3，专注需求追溯、可测性、范围合理性与体验盲点。

## 1. 环境事实与坑（必读）
- 本任务基本只读工作区文档，不涉及 asar；如需宿主契约证据可 read `D:\DSHarness\resources\app.asar\dsh\skills\dsh-doc\references\host-plugin.md`（只有 read 工具能读 asar）。
- 上游文档编号法见 AGENTS.md §3：mroute/00 综合可行性（决策入口）、01-04 专项调研、05 增补论证、06 市场扫描、07 工程方案；引用上游用章节号，不改原文。
- 已知安装期事实（lead 实测，PRD 完备度判定时可引用）：初版漏声明 schemastery dependencies 已补；install_bundle 对本地 link 目录不装 dependencies，需 bundle 内自带 node_modules；model_route_query capability=coding 实测五渠道排序正确（monthly 前置 / 90>80>70>65>50 / 活校验提示未在目录渠道 / 当前路由识别 zai-coding-cn/glm-5.3-flash）。
- 你是 leaf worker：**不得派发子会话**，不得用 workflow/ralph；主要用 read/grep/glob。
- 上下文接近 50%：把进度写 `D:\Codes\DSH小插件\docs\HANDOFF-E3-prod.md` 并 `session_handoff`（先 action:"status" 再 action:"handoff"）同层接替。

## 2. 必读材料（按序）
1. `D:\Codes\DSH小插件\AGENTS.md`（§3 文档体系、§6 审计模式）
2. 被审计物：`docs\01-requirements-spec.md`（需求说明书，含追溯矩阵）、`docs\02-prd.md`（PRD）
3. MVP 裁剪依据：`docs\briefs\mvp1-M.md`（MVP 任务书）
4. MVP 实测记录：`docs\04-mvp-notes.md`、`docs\04-mvp-selfcheck.md`
5. 上游对照：`mroute\00-feasibility-report.md`（结论章）、`mroute\05-report-extension.md`、`mroute\06-market-scan.md`（空白确认）、`mroute\07-assembly-plan.md`（M1 章）
6. 产品叙事对照：`plugin-mroute\README.md`

## 3. 问题清单（逐条编号回答）
① **需求覆盖**：docs/01 追溯矩阵完整性抽查——抽 3 条 REQ→FR→AC 链路验证（写明抽了哪三条编号），每条验证：链条是否闭合、AC 是否可从 FR 推出、MVP 是否承接或已明确进 backlog；发现断链/孤儿项列 findings。
② **验收标准可测性**：FR 抽 5 条判定 AC 是否真的可测（有明确输入/输出/阈值/观测手段）；不可测的指出缺什么、怎么补；写明抽了哪五条。
③ **MVP 范围合理性**：对照 briefs/mvp1-M.md 裁剪逻辑与 07 方案 M1 章——MVP 缺口是否都进了 backlog/开放问题（PRD 里有没有「MVP 不做」清单与承接位置）；有没有漏掉的、或不在任何 backlog 的孤儿功能；裁剪理由与 07 方案是否冲突（冲突处需指明）。
④ **PRD 内联性**：假设读者没读过 mroute/00-07 上游——术语有没有内联定义（如 channel_type/tier/volatile 这些概念）、引用上游是否自包含（有章节号+一句摘要）、决策依据是否内联；挑出读者会卡住的 3 处以上。
⑤ **体验盲点**：从用户视角挑 PRD/MVP 没想到的 3 个问题（例如：全部渠道活校验失败时模型该信什么、用户改配置后 TTL 缓存窗口内旧排序误导、能力关键词拼错时有没有引导、多 profile/多机场景、locale 覆盖面）；每个盲点给「为什么现在 PRD 没接住 + 建议落点（PRD 补条 / backlog）」。
⑥ **确认可行清单（必答）**：PRD/需求说明书做得好的地方（追溯矩阵完整性、范围控制、风险章等），逐条带章节号证据。

## 4. 产出格式（最终答复）
- **findings 清单**：每条 `{severity: blocker|major|minor, area, description, evidence: "文件路径:行号或章节号", suggestion}`；blocker=阻断收口，major=须修，minor=记录。
- **确认可行清单**：带证据的正面结论（审计是论证不是走过场，不许只挑刺）。
- **上报纪律**：先 `send_message {agent:"audit-lead"}` 报一句话结论 + blocker/major/minor 计数，再输出完整结构化 findings 作为最终答复（父会话只收得到消息与最终答复，收不到过程）。
