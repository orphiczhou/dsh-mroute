# 03-audit-report.md — mroute MVP 三视角专家审计汇总裁决书

> 审计指挥官：audit-lead（lead → audit-lead → 专家孙会话三层结构）
> 审计时点：2026-11-13 晚（mvp1 树第 3 阶段；MVP 已实测通过、docs/01/02 已落盘之后）
> 结论先行：**blocker = 0，major = 6（全部确认、均可在 M1 首迭代内消化），minor = 15（合并去重后）——放行进入 M1 正式开发。**

---

## 1. 审计范围与方法

### 1.1 三视角分兵（孙会话结构）

```
lead（root，亲测安装/激活/工具实调）
└─ audit-lead（审计指挥官：拆解任务书、派遣、抽验证据、汇总裁决）
   ├─ E1 audit-arch  架构与许可审计（任务书 docs/briefs/audit-E1-arch.md）
   ├─ E2 audit-sec   安全审计（任务书 docs/briefs/audit-E2-sec.md）
   └─ E3 audit-prod  产品与 PRD 审计（任务书 docs/briefs/audit-E3-prod.md）
```

- 每名专家为**独立孙会话**（原生 subagent 嵌套，tree_dispatch 端口故障期等价替代，见 AGENTS.md §4），prompt 只指路、任务书落盘 `docs/briefs/`（防超长协议错误）。
- 专家结论均要求：结构化 findings（severity/area/description/evidence/suggestion）+ **确认可行清单**（审计是论证不是走过场）。
- 被审计物：`plugin-mroute/` 全量（index.js + lib/ 八模块 + cordis.patch.yml + package.json + locale/ + icon.svg + NOTICE.md + LICENSE + README.md）、docs/01/02（需求与 PRD）、docs/04-mvp-notes.md + 04-mvp-selfcheck.md（实测记录）、docs/briefs/mvp1-M.md（裁剪依据）、上游 mroute/00/05/06/07、asar 宿主契约文档、vendors/ 四家借鉴源码。

### 1.2 指挥官证据抽验（不重复专家工作，只验关键行号）

| 抽验对象 | 证据点 | 抽验结果 |
|---|---|---|
| E1 major① | NOTICE.md:11 autotier 标 MIT | **成立**：`vendors/PerryLink--dsh-autotier/LICENSE:1-2` 实为 Apache-2.0；且 docs/01:337 本身已正确记载「autotier 为 Apache-2.0，取仅参考不取码」——NOTICE 与需求说明书自相矛盾 |
| E1 major② | 工具注册未包 ctx.effect | **成立**：先例 `vendors/twoweeks1995--dsh-subagent-setup/plugin/index.js:345-352` 两处工具注册均 `ctx.effect(() => dispose, name)` 包裹；autotier 仓 AGENTS.md 硬规则「Registration is an effect」二次佐证；MVP index.js:33-42 用自制 disposers 数组，宿主对 apply 返回值的 dispose 语义无文档明证 |
| E2 minor②/④/⑤ | 错误链透出 / TIER_RANK 直读 / registry null 防御 | **成立**：errors.js:2-4 确只取 `.message`（无堆栈）；tool-query.js:171 确为 `TIER_RANK[channel.tier] ?? 9` 直读（原型链可命中）；registry.js:28-30 元素级确无 null 防御（schema 兜底在） |
| E3 major① | manual.status 未定义 | **成立**：docs/01:136、139 用 `manual.status=disabled`，但 FR-B1（:145）manual 字段集 `quota_total/quota_used_est/grant_expires_at/last_recorded_at/note` 无 status；MVP config-schema.js:86-90 manualSchema 亦无 |
| E3 major② | volatile 定稿口径冲突 | **成立**：docs/01:329「对象根下固定命名字段各自 `.volatile()`」与 Day1 实测 C4（docs/04-mvp-notes.md:40 元素内抛错实录、:62-66 结论、:66 落码「channels 数组整体 volatile」）表述冲突；NFR-2:323「活校验双 TTL」与 MVP 单 TTL 60s（selfcheck:74 明示简化）存在规格-实现偏差未回写 |
| E3 major③ | capability 布尔语义矛盾 | **成立**：docs/01:116 FR-A3-3 `capability.coding=false` 布尔判定 vs 上游 mroute/00:72 `"coding": "good"` 评级字符串 |
| E3 major④ | 活校验缓存陈旧窗口无 FR 承接 | **成立**：docs/01:175-181 FR-B5 为**余额**缓存（M2 范畴），活校验 60s 陈旧窗口的可见性处理无任何 FR/AC |
| E1 minor 自检漂移（自证一例） | selfcheck:67「dependencies 空」 | **成立**：package.json:36-38 现已声明 `@deepseek-ai/schemastery ^3.19.0`（安装期修复后回写代码、未回写自检） |

### 1.3 派遣路由实录（审计过程附注发现）

指挥官按纪律先调 `model_route_query` 取渠道序（zai-coding-cn/glm-4.6 → opencode-go（无 models 可填）→ deepseek-official/deepseek-chat → deepseek-account/deepseek-chat → xiaomi（无 models）），**四个可填组合全部被宿主策略门拒绝**（"child LLM route … not allowed for this Session"），遂降级为省略 provider/model 用子会话默认路由（与父同源 glm-5.3-flash）完成派遣。三点观察：①排序与降级链行为符合设计（prompt-section.js:14 文案「被策略门拒绝时换列表下一项」真实生效到「全部被拒 → 继承父路由」）；②「全部被拒后静默继承」无整体信号——与 E3 体验盲点相互印证，记 backlog；③注册表渠道当前无一能被子会话策略门放行，属宿主策略配置问题而非插件缺陷，建议 lead 在宿主侧为子会话放行 1-2 个渠道以打通 FR-A4-3 闭环。

---

## 2. 三专家 findings 汇总表（去重合并后）

原始计数：E1 = 0/2/6，E2 = 0/0/7，E3 = 0/4/5 → 合并去重后 **blocker 0 / major 6 / minor 15**。同类项合并：E2 minor①+②（返回文本暴露面）、E1「自检漂移」与 E3「PRD/MVP 状态脱节」并入一条。

### 2.1 major（须修，6 条）

| # | 来源 | area | 描述 | 证据 |
|---|---|---|---|---|
| M-1 | E1 | 许可 | NOTICE.md 把 autotier 误标 MIT（实为 Apache-2.0）；借鉴为形状级「仅参考」无版权义务违反，但与 docs/01:337 正确记载自相矛盾，须改标签 | NOTICE.md:11 vs vendors/PerryLink--dsh-autotier/LICENSE:1-2 |
| M-2 | E1 | 接缝 | 工具与 prompt 注册未按「注册即 effect」惯例用 `ctx.effect` 包裹；apply 返回 dispose 的宿主语义无文档明证、卸载路径未实测——停用后工具/提示段有残留风险 | 先例 subagent-setup plugin/index.js:345-352；autotier AGENTS.md 硬规则；MVP index.js:33-59 |
| M-3 | E3 | PRD | FR-A6 引用未定义字段 `manual.status`（FR-B1 manual 字段集与 MVP schema 均无此字段）——规格内部不自洽 | docs/01:136,139 vs :145 vs config-schema.js:86-90 |
| M-4 | E3 | PRD | NFR-3:329 volatile「各自 `.volatile()`」定稿口径与 Day1 实测 C4（元素内抛错、channels 数组整体 volatile 为唯一合法落码）冲突；NFR-2:323「双 TTL」与 MVP 单 TTL 60s 偏差未回写规格 | docs/01:329,323 vs docs/04-mvp-notes.md:40,62-66 vs selfcheck:74 |
| M-5 | E3 | PRD | FR-A3-3 capability 布尔语义（`coding=false`）与上游评级字符串（`"coding":"good"`）矛盾；MVP 已将 capability 声明为 no-op（M2 接入），规格层语义必须先统一否则 M2 无从实现 | docs/01:116 vs mroute/00:72 vs selfcheck:72 |
| M-6 | E3 | PRD | 活校验缓存陈旧窗口（60s 内旧排序在配置变更后的可见性处理）未纳入任何 FR/AC；FR-B5 是余额缓存不覆盖此面 | docs/01:175-181、livecheck.js:9 |

### 2.2 minor（记录，15 条）

| # | 来源 | 描述 | 证据 |
|---|---|---|---|
| m-1 | E1+E3 | 文档状态脱节：selfcheck:67「dependencies 空」vs package.json:36-38（已声明）；PRD 未反映「MVP 已实测通过」状态（PRD/MVP 状态脱节） | selfcheck:67、package.json:36-38 |
| m-2 | E1 | 重复 id 告警文本称「仅首个生效」但实现未去重（重复 id 渠道全部进排序） | registry.js:40-43 vs tool-query.js:170-199（无去重） |
| m-3 | E1 | FR-A3-4 90 天 review_alerts 缩水未记入已知限制（FR 承接期 M1/P0；种子 reviewed_at 均为当日故暂无功能影响） | docs/01:117 vs selfcheck:69-77（§5 未列） |
| m-4 | E1 | NOTICE.md 缺依赖包出处/许可节（schemastery/cosmokit/@standard-schema/spec 三包未记录） | NOTICE.md 全文 vs node_modules/*\/LICENSE |
| m-5 | E1 | asar skill 文档路径再迁移环境事实（指挥官复核时 `skills/dsh-doc/references/*` 已 not found——E1/E2 读取时点尚可用，宿主 build 中途切换） | 本报告 §1.2 复核实录 |
| m-6 | E2 | 返回文本低敏暴露面：livecheck.js:32 unknown detail 回显宿主全部 provider id；:43 errorMessage（仅 .message、无堆栈）经 ranking.js:42 进 reason，adapter 错误理论可含 URL/路径 | livecheck.js:32,43、ranking.js:42、errors.js:2-4 |
| m-7 | E2 | channels/models 无长度上限 + livecheckAll 无并发池化 = 配置自伤型 DoS（无外呼放大，风险有限） | config-schema.js:93-111、ranking.js:66-77 |
| m-8 | E2 | tool-query.js:171 `TIER_RANK[channel.tier]` 直读非 hasOwnProperty，`tier="__proto__"` 时 tier_min 过滤失效（只读无实害；rankOf:17 已正确用 hasOwnProperty，两处口径不一） | tool-query.js:171 vs ranking.js:17 |
| m-9 | E2 | registry.js 元素级无 null 防御（激活期 schema 兜底在，防御纵深建议一行 filter） | registry.js:25-30 |
| m-10 | E2 | 依赖 `^3.19.0` 建议锁 exact（package-lock.json 已在库且为 exact 3.19.0 带 integrity；node_modules 自带策略下 `^` 仅在重建流程引入漂移风险） | package.json:37、package-lock.json |
| m-11 | E2 | manual.note 逐字透出为设计内；「密钥不进返回」红线目前仅纪律约束无技术拦截（M2 credential-ref 落点时应加显式滤除） | tool-query.js:30 |
| m-12 | E3 | 评测预估算法留白（PRD 未定义预估口径，M5 前需补） | docs/02（评测相关章节） |
| m-13 | E3 | FR-A1-2 钉死 07§3.4 草案字段集（上游草案演进时规格会被动失真，建议改「以工具 output.schema 为准」措辞） | docs/01 FR-A1-2 |
| m-14 | E3 | PRD 内联缺口 5 处（channel_type/tier/volatile 等术语假设读者读过上游；上游引用有章节号但缺一句摘要） | docs/02 各处 |
| m-15 | E3 | 体验盲点 5 项：目录源故障无整体信号 / 零命中（capability 拼错）无引导 / 多 profile 多机场景未声明 / budget 单档 / 窗口型渠道护栏未定义 | docs/02 + 本报告 §1.3 实录互证 |

### 2.3 三专家「确认可行」正面结论汇总（带证据，论证非挑刺）

- **E1**：四导出接缝与已装先例 subagent-setup 逐字段同构（index.js:18-20 vs 先例同款 inject 名）；排序引擎复算与 lead 实测五渠道序完全一致（ranking.js:14-15,26-35,54-63；CHANNEL_TYPE_RANK 三级序 + tie-break 五键全序确定性）；红线 grep 代码零命中（无 llm/stream、无 agent/request、无 ctx.on、无 HTTP 外呼、无凭据读取）；种子注册表与 00 报告实测清单一致（config-schema.js:27-83）。
- **E2**：**PASS**。无凭据面/无出站面/无子进程/无文件系统访问/无红线监听（grep 全量零命中）；工具返回为白名单式逐字段构造（tool-query.js:183-199），Config 塞入的未知键不透出；原型污染受控（schemastery object 按 dict 构造解析天然跳过 `__proto__`/`constructor` + rankOf 用 hasOwnProperty）；唯一宿主写入面 = tools.register + systemPrompt.section（practices.md 认可的最弱机制）；17 条正面结论全部带文件:行号。
- **E3**：需求→FR→AC 双向追溯矩阵真实完整（docs/01 §5 两向矩阵、抽 3 条链路闭合）；设定值纪律执行到位（FR-A3-4:117「本说明书设定值 90 天」明示）；MVP 裁剪记录完整（selfcheck:69-77 已知限制 7 条 + notes:118-135 与任务书对照）；范围/风险章与 07 方案无未声明冲突。

---

## 3. blocker/major 裁决（逐条）

> 本轮 **blocker = 0**，无裁决必要。6 条 major 全部经指挥官抽验，裁决如下：

| # | 裁决 | 理由 |
|---|---|---|
| M-1 | **确认（major）** | 抽验成立（LICENSE:1-2 Apache-2.0）。不升 blocker：借鉴方式为「仅参考」（形状级，未取码），Apache-2.0 无未履行义务；危害=许可台账失真，一行修复 |
| M-2 | **确认（major）** | 抽验成立（双先例佐证）。不升 blocker：lead 已实测激活正常，风险仅在停用/重载路径（未实测）；修复为一行级 `ctx.effect` 包裹 + 补停用实测，纳入 M1 首任务 |
| M-3 | **确认（major）** | 抽验成立。纯规格层不自洽，MVP 代码反而无此问题（manualSchema 无 status）；修订 docs/01（定义 status 字段或改措辞为「注册表标记 disabled」），不动代码 |
| M-4 | **确认（major）** | 抽验成立。MVP 落码正确（以实测 C4 为准），错在规格文字停留于 Day1 之前的假设口径；修订 docs/01:329 与 :323，并在 NFR-2 补「MVP 单 TTL 60s 简化、M2 恢复双 TTL」的承接记录 |
| M-5 | **确认（major）** | 抽验成立。布尔/评级两种语义在 M2 能力数据建模前必须二选一，否则 FR-A3-3 的 AC 无法落地；建议规格层改评级字符串 + 布尔代理显式声明，capability 数据模型进 M2 backlog |
| M-6 | **确认（major）** | 抽验成立。60s 陈旧窗口是真实体验缺口（配置改了、查询仍回旧排序且无「数据截至」强提示）；MVP 已返回 `generated_at`/`reviewed_at`（tool-query.js:60,207-210）可作基础，补一条 FR/NFR 即可 |

无「降级/驳回」项：三专家 findings 证据密度高，抽验零翻车。

---

## 4. 可行性论证结论

### 4.1 MVP 技术可行性分点判定（全部 ✅）

| 判定点 | 结论 | 证据 |
|---|---|---|
| 安装激活 | ✅ | lead 实测：修复 dependencies 声明 + bundle 内自带 node_modules 后 `application:applied`；流程教训已固化进 AGENTS.md §4（漏声明根因=初版手写 package.json 未跑 npm install，防再犯措施见 §5 修复清单） |
| 工具注册 | ✅ | `model_route_query` 实调返回结构化五渠道排序表（E2：白名单式构造；E1：接缝与先例逐字段同构；宿主消费 render 文本格式验证通过） |
| 排序正确性 | ✅ | lead 实测 capability=coding：monthly 前置、priority 90>80>70>65>50、活校验未在目录渠道逐条标注、当前路由正确识别（zai-coding-cn/glm-5.3-flash）；E1 代码复算一致、全序五键确定性（ranking.js:26-35） |
| 红线遵守 | ✅ | E1+E2 独立 grep 双重零命中：无 llm/stream、无 agent/request 改写、无 ctx.on 改写、无 HTTP 外呼、无凭据读取/子进程/文件系统访问；唯一宿主写入面为 tools.register + systemPrompt.section（观察级最弱机制） |
| 可维护性 | ✅ | NOTICE 出处表（待修一处标签）、模块八分单一职责、注释带上游出处与实测编号（C1-C6）、`npm run check` 语法门、package-lock 在库；2 处文档标签级失真不伤及代码 |

### 4.2 PRD 完备度判定：**有条件完备（修订 4 项规格层 major 后达 M1 开发就绪）**

- 到位面：双向追溯矩阵（REQ↔FR↔AC↔上游出处四列）、设定值明示纪律、验收标准绝大多数可测（E3 抽 5 条仅个别需补观测手段说明）、MVP 裁剪与已知限制记录完整。
- 待修面：M-3（未定义字段引用）、M-4（volatile/双 TTL 口径滞后于实测）、M-5（capability 语义二义）、M-6（缓存陈旧窗口无 FR）——四条均为**文档回注**可解，无结构性缺陷；PRD 内联性缺口（m-14）建议随修订批次一并补术语表。

---

## 5. 修复建议清单（按「谁修」分组）

**A. MVP 回注 mvp-dev（代码/插件文件，M1 首迭代消化）**
1. M-1：NOTICE.md:11 autotier 许可标签 MIT → Apache-2.0（一行）。
2. M-2：index.js 工具注册与 prompt-section 注册改 `ctx.effect(() => dispose, 'mroute: …')` 包裹，删除自制 disposers 数组或保留为兜底；补一次「停用插件 → model_route_query 不可见」实测并记入 selfcheck。
3. m-2：重复 id 处二选一——实现真去重（读侧 filter 首个生效）或改告警文案为「重复 id，均将列出」。
4. m-3：selfcheck §5 补记「FR-A3-4 90 天 review_alerts 未实现（M1 后续/降级说明）」。
5. m-8：tool-query.js:171 改用与 ranking.js:17 同款 hasOwnProperty 口径（一行）。
6. m-9：registry.js channels 读取加一行 `channels.filter(ch => ch && typeof ch === 'object')` 防御。
7. m-10：dependencies 锁 exact `3.19.0`（去 `^`）。
8. m-4：NOTICE.md 增「依赖包出处」节（schemastery/cosmokit/@standard-schema/spec 三包 LICENSE 记录）。

**B. 文档回注（prd-writer / 文档会话，随 M1 修订批次）**
9. M-3：docs/01 FR-A6 的 `manual.status` 定义补齐（加入 FR-B1 字段集或改措辞）。
10. M-4：docs/01:329 volatile 口径改为实测结论表述；:323 双 TTL 改「MVP 单 TTL 60s（已实测），M2 恢复双 TTL」承接记录。
11. M-5：FR-A3-3 capability 语义统一（建议评级字符串 + MVP 阶段布尔代理显式声明）。
12. M-6：补活校验缓存陈旧窗口 FR/AC（建议 NFR-2 附属条：配置变更后查询须带 `generated_at` 数据截至提示）。
13. m-1：selfcheck:67 与 PRD 状态段同步 MVP 实测通过事实。
14. m-13：FR-A1-2 字段集措辞改「以工具 output.schema 为准」。
15. m-14：PRD 补内联术语表（channel_type/tier/volatile/活校验）与上游引用一句摘要。

**C. 记入 backlog（M2+ 承接）**
16. m-6/m-11：返回文本暴露面与 credential-ref 技术拦截，随 M2 余额适配器统一处理。
17. m-7：channels/models 长度上限 + livecheck 并发池化（M2 注册表规模化时）。
18. m-12：评测预估算法口径（M5 前）。
19. m-15：体验盲点 5 项（目录源故障整体信号 / 零命中引导 / 多 profile 声明 / budget 多档 / 窗口型渠道护栏）。

**D. 环境事实回注 AGENTS.md（lead 亲自，一条）**
20. m-5：asar skill 文档路径再次迁移（`skills/dsh-doc/references/*` 本晚复核已 not found）——新会话任务书不再引用固定路径，改为「read asar 内 dsh-doc skill 现路径」并建议 lead 用 read 探明新位置后回写。

---

## 6. 签收结论

- **blocker = 0**（三专家一致 + 指挥官抽验复核），major = 6（4 条文档回注 + 2 条插件小改，全部确认、无降级无驳回），minor = 15。
- **裁决：放行进入 M1 正式开发**（AGENTS.md §6 「blocker 清零即通过」）。条件：§5 清单 A 组 8 项随 M1 首迭代消化，B 组随 M1 文档修订批次完成；C 组进 backlog 挂账。
- MVP 技术可行性五点全部 ✅；PRD 有条件完备（4 项规格层 major 修订后即达 M1 就绪）。
- 附注：注册表五渠道当前均未被子会话策略门放行（§1.3 实录），建议 lead 宿主侧放行 1-2 渠道以打通 FR-A4-3「查询→选路→派遣」端到端验收。

—— 审计指挥官 audit-lead，2026-11-13
