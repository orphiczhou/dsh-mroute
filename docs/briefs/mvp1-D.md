# 任务书：mvp1-D-prd —— 需求说明书 + PRD

> 执行者读此文件开工。树：mvp1 / leaf：mvp1-D-prd。这是产品文档任务。

## 0. 必读
1. `D:/Codes/DSH小插件/AGENTS.md`（文档纪律）
2. `mroute/00-feasibility-report.md`：七需求对照 §2、schema §3.1、消费路径 §4、风险 §5、MVP §6
3. `mroute/05-report-extension.md`：增补两需求、M1-M6 重排 §5、验收增补 §5.3
4. `mroute/06-market-scan.md`：竞品与差异化（PRD 市场章素材）
5. `mroute/07-assembly-plan.md`：三分清单、M1 方案（范围与里程碑素材）

## 1. 产物一：`D:/Codes/DSH小插件/docs/01-requirements-spec.md`（需求说明书）
1. 背景与问题陈述（多渠道成本结构：包月/限期算力券/预充值；派遣子会话无选路参考的痛点）
2. 目标用户与场景；3 个核心用户故事（派遣前选路 / 余额耗尽前切换 / 新模型上手评估）
3. 功能性需求 FR-xx（全局唯一编号，每条：描述/优先级 P0-P2/**可测验收标准**）：
   - FR 组A 派遣选路：model_route_query 查询、财务三级排序、tier 分层、fallbacks 备选链、policy 四态标注
   - FR 组B 额度感知：A/B/C/D 四级余额适配、缓存熔断、券衰减排序、包月估算折算
   - FR 组C 评测排名：手工触发评测、判分与建议、人工确认写回、外部榜单参考
   - FR 组D 面板运维：设置面板分区、注册表可视化编辑、复核提示
   - FR 组E 基础设施：systemPrompt 提示、DecisionRecord 留痕、健康状态机
4. 非功能 NFR-xx：安全（凭据走 credentials 不出宿主）、性能（缓存/查询毫秒级）、兼容（DSH 0.2.x volatile 约束/无 rewrite 通道）、可维护（移植冻结/NOTICE）、可观测
5. 约束与依赖（宿主 API 面/红线/schemastery 嵌套/许可合规）
6. **需求追溯矩阵**：原始七需求 → FR 编号 → 里程碑期数 → 上游论证章节（完整无遗漏）

## 2. 产物二：`D:/Codes/DSH小插件/docs/02-prd.md`（PRD）
1. 产品定位与价值主张（一句话+差异化四空白引 06）
2. 范围 In/Out（v1 做/明确不做——引 00§7）
3. 用户旅程（派遣前查询→选路→填 assignee→被策略门拒换下一项，文字版链路图）
4. 功能规格（按 FR 组展开关键行为，引用 FR 编号不重复验收标准）
5. 里程碑与发布计划：M1-M6 对齐 05§5（每期目标/验收出口/工期引 07 估算）
6. 成功指标（合理假设并标注假设性质）
7. 风险与缓解（00§5+05§6 R1-R13 精简为 PRD Top 风险表）
8. 开放问题（待 MVP 实测/待用户决策：schemastery 嵌套结论、M4 面板排期等）

## 3. 纪律
- 不改上游文档；引用用章节号；验收标准必须可测（禁"体验良好"类表述）；PRD 面向没读过 00-07 的读者，关键上下文内联。

## 4. 上报纪律（AGENTS.md §2）
开工 brief_echo → progress → context(pct) → done（meta 精简）。树：mvp1，leaf：mvp1-D-prd。水位 42% 自报；50% session_handoff 同层交接留痕。
