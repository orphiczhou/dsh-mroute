# 任务书：m1-dev —— mroute M1 正式版增量开发

> 执行者读此文件开工。项目：mroute 插件（DSH 多子会话派遣的模型选择优先参考，**advisory-only 建议器**）。MVP 已实测通过并经审计修复（plugin-mroute/ 现状 = 审计修复版 0.1.0-mvp.1），你做的是 **MVP→M1 的增量**（MVP 已覆盖 M1 主体，增量见下）。

## 0. 必读（按序）
1. `D:/Codes/DSH小插件/AGENTS.md` —— 工作方法与环境坑（**§4 mroute 方向红线：advisory-only 必读**）
2. `D:/Codes/DSH小插件/docs/01-requirements-spec.md`（v1.2）—— FR-B1（status 三值）/FR-A3（capability 评级/90 天复核）/FR-A6（warning 标注+enforce_gate opt-in）/FR-E2（DecisionRecord）/NFR-0（会话自主权原则）
3. `D:/Codes/DSH小插件/docs/03-audit-report.md` §2/§5 —— 已修项上下文（M-2/M-3 已修，勿回退）
4. `D:/Codes/DSH小插件/mroute/07-assembly-plan.md` M1 章 —— 蓝图与排序伪代码
5. 被迭代代码：`D:/Codes/DSH小插件/plugin-mroute/`（先通读 index.js + lib/ 八模块 + docs/04-mvp-selfcheck.md §7 修复记录）

## 1. M1 增量清单（架构拆解，逐项实现）

### 1.1 schema 层（lib/config-schema.js）
- `manualSchema` + `status`：枚举 `active|disabled|exhausted`，default `active`（FR-B1，audit M-3 遗留补齐）
- channels[] 元素 + `capability` 评级对象：`{coding?, tools?, long_context?, vision?}`，值域评级字符串 `excellent|good|fair|null`（FR-A3-3 v1.2 口径，MVP 布尔代理退役；种子数据 zai 的 coding=excellent 保持）
- 顶层 `enforce_gate`：boolean，default **false**，`.volatile()`（FR-A6-3/NFR-0a；schema 层断言缺省 false）
- 顶层 `eval` 子对象预留位：nullable 对象（M5 填充；M1 仅 schema 占位，07 方案 M1 验收 6）
- volatile 纪律：channels[] 数组整体 volatile、顶层固定字段各自 volatile（AGENTS.md §4 实测口径，勿改）

### 1.2 registry 层（lib/registry.js）
- status 三值读侧兼容：缺字段 = active 不报错（FR-B1-4 前半）
- capability 评级解析（供过滤与展示）

### 1.3 查询/排序层（lib/ranking.js + lib/tool-query.js）
- **warning 标注（FR-A6-1/2 M1 部分）**：`status=disabled|exhausted` 或 manual 余额低于阈值（阈值常量可先内置 10 CNY）的渠道：**条目保留在表中**，加 `warning{reason, suggestion}`（suggestion 取 fallbacks[] 首选或排序下一项）。**不沉底、不出列、不阻断**（advisory-only NFR-0 红线）。与 FR-A2 的分工备注写进代码注释（静态标注 vs M2 动态账本 mask）
- **review_alerts（FR-A3-4）**：`reviewed_at` 距今 >90 天的渠道条目加 `review_alert:true` + 提示文案（建议人工复核 tier/priority）
- **capability 过滤生效**：`capability:"coding"` 入参 → 渠道 `capability.coding ∈ {excellent,good}` 命中；`fair` 不命中（进入"未命中"处理：不过滤但 reason 注明不满足）；无 capability 数据的渠道保持现状（reason 注明 M2 接入）
- **DecisionRecord 最小版（FR-E2）**：每次查询追加一行 JSONL 到 `~/.dsh/mroute/decisions/decisions-YYYYMM.jsonl`：`{ts, args, top3:[{id,rank,reason_head}], excluded_count, generated_at}`。追加用 `fs.appendFile`（原子性够用；参考 vendors/puppy-bai--dsh-quota-takeover 的 JSONL 审计先例）；目录不存在则创建；写失败静默降级（不影响查询返回，console 级日志）
- 返回文本微调：warning/review_alert 条目在文本渲染中带 ⚠ 前缀与建议

### 1.4 prompt-section（lib/prompt-section.js）
- 文案复核保持 advisory 语气（提醒查询，无任何"必须/强制"措辞）；如现有文案合规则不动

### 1.5 冒烟扩展（自检脚本）
- 新增断言组：status=disabled 渠道出现在返回且带 warning 且**无任何拦截路径**（NFR-0a 零拦截用例）；enforce_gate 缺省 false（schema 断言）；capability 过滤命中/未命中两例；DecisionRecord JSONL 落盘验证；review_alerts 触发例
- 全量回归：既有 8 组断言不得回退

## 2. 红线（AGENTS.md §4）
- **advisory-only**：不阻断不改写不代决策；enforce_gate 默认 false；无任何 deny 路径在缺省配置下激活
- 不碰 llm/stream、agent/request；无 HTTP 外呼；无凭据读取
- **不执行 install_bundle**（lead 统一重装实测）；node_modules 不动（schemastery 已就位）
- 每个 .js 过 `node --check`（PATH node v24.20.0）

## 3. 产物
1. plugin-mroute/ 增量代码（版本号 0.1.0-mvp.1 → 0.2.0-m1.0）
2. `D:/Codes/DSH小插件/docs/05-m1-devlog.md`：实现记录（逐项对照本清单 1.1-1.5 的落点文件:行号、偏离与理由、Day 式自检结果）
3. docs/04-mvp-selfcheck.md 更新（回归结果 + 新增断言组记录）

## 4. 上报纪律（AGENTS.md §2）
开工 send_message {target:"lead"} 简报；关键节点 progress；完成 send_message done（一句话结论+逐项状态+self_check 简表）。上下文接近 50% 时进度落盘 docs/HANDOFF-m1-dev.md 并继续。
