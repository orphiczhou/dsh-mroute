# 审计任务书 E1 — 架构与许可审计（mroute MVP）

> 你是 mroute 插件专家审计团的 E1（会话名 audit-arch），由审计指挥官 audit-lead 派遣的独立孙会话。本文自包含，按序执行即可。

## 0. 背景（一句话）
mroute 是 DSH 多子会话派遣的模型选择优先参考插件（财务优先级 monthly>voucher>prepaid）；MVP 代码在 `plugin-mroute/`，lead 已实测激活且 `model_route_query` 排序正确；现对 MVP 代码与 PRD 做三视角专家审计（E1 架构与许可 / E2 安全 / E3 产品与 PRD），你是 E1。

## 1. 环境事实与坑（必读）
- 宿主 asar 归档 `D:\DSHarness\resources\app.asar\dsh\` **只有 read 工具能读**；pwsh/glob/grep/node 一律打不开。工作区内文件 glob/grep/read 正常。
- asar 内插件开发文档（路径已迁移，以此为准）：`D:\DSHarness\resources\app.asar\dsh\skills\dsh-doc\references\host-plugin.md`、`practices.md`（另有 ui-plugin/user-actions/verification.md）；样板目录 `D:\DSHarness\resources\app.asar\dsh\skills\dsh-doc\templates\decoration\`。`.d.ts` 被剔除，证据取运行时 JS + JSDoc。
- `cordis_inspect_query` 带 input 在本 build 被拒（工具损坏），别用它做证据。
- schemastery @3.19.0（与宿主同版）Day 1 实测：嵌套 z.object 在 channels[] 元素内逐键存活；`z.record` 缺失、`z.dict` 存在；`.volatile()` 在数组元素内抛错（宿主禁令），channels[] 数组整体 `.volatile()` 合法且 .get() 读回完整。
- 已知安装期事实（lead 实测，可直接引用为证据背景）：初版 package.json 漏声明 `@deepseek-ai/schemastery` dependencies → 首装 ERR_MODULE_NOT_FOUND；install_bundle 对本地 link 目录不装 dependencies（"added 0"），lead 已在 bundle 内 npm install 自带 node_modules 后激活成功（application:applied）；lead 已实测 model_route_query capability=coding 返回正确五渠道排序（monthly 前置 / 90>80>70>65>50 / 活校验提示 glm-4.6 与 deepseek-chat 未在目录 / 当前路由识别 zai-coding-cn/glm-5.3-flash）。
- 你是 leaf worker：**不得派发子会话**，不得用 workflow/ralph；主要用 read/grep/glob。
- 上下文接近 50%：把进度写 `D:\Codes\DSH小插件\docs\HANDOFF-E1-arch.md` 并 `session_handoff`（先 action:"status" 再 action:"handoff"）同层接替。

## 2. 必读材料（按序）
1. `D:\Codes\DSH小插件\AGENTS.md`（§4 坑、§5 借鉴纪律、§6 审计模式）
2. 被审计代码：`plugin-mroute\index.js`、`lib\`（config-schema / registry / volatile / livecheck / errors / ranking / tool-query / prompt-section 八模块）、`cordis.patch.yml`、`package.json`、`locale\en.json` + `zh.json`、`NOTICE.md`、`README.md`、`LICENSE`
3. 方案对照：`mroute\07-assembly-plan.md`（重点 M1 章）
4. 实测记录：`docs\04-mvp-notes.md`、`docs\04-mvp-selfcheck.md`
5. asar 宿主契约：`skills\dsh-doc\references\host-plugin.md`、`practices.md`、`templates\decoration\` 样板
6. vendors 借鉴对照（先 glob `vendors/*/*/package.json` 确认实际目录名再读；NOTICE.md 声明的四处）：
   - twoweeks1995/dsh-subagent-setup：`plugin/catalog-runtime.mjs`、`plugin/tools.mjs`、`package.json`
   - tkaiz0406/dsh-subagent-route-pin：`index.js`（871-903 行附近）
   - young-tim/dsh-llm-governor：`src/routing/strategies.ts`
   - PerryLink/dsh-autotier：`src/schema.ts`
7. 流程证据：`docs\HANDOFF-M-mvpdev.md`（mvp-dev 交接记录，用于⑤根因）

## 3. 问题清单（逐条编号回答）
① **接缝合规**：apply/inject/Config/defineTool 形状逐项对照 asar host-plugin.md 与 decoration 样板——patch row 结构、inject 数组、Config schema 用法、工具定义对象（name/description/parameters/output.schema+render/isConcurrencySafe/execute）是否与宿主契约一致；不一致处列 blocker/major。
② **红线核查**：对 plugin-mroute 全量源码 grep 核查（证据=命中或零命中，注明检索词与范围）：不得有 llm/stream 调用、agent/request 改 route、ctx.on 改写（搜 `ctx.on(`）、HTTP 外呼（fetch/axios/http/https/net）、凭据读取（credentials/process.env）；命中即 blocker。
③ **排序引擎正确性**：ranking.js + registry.js 对照 07 方案——channel_type 三级序（monthly>voucher>prepaid）、tier 能力分层、priority 降序、活校验失败沉底与标注、tie-break 全序（确定性：同输入恒同输出；排序实现是否稳定）、去重与空态；capability 参数是否按契约「当前不过滤仅标注」；对照 lead 实测结果判断有无代码级隐患。
④ **复用代码出处核查**：NOTICE.md 六行逐行对 vendors 实际源码——声明「改造借鉴/仅参考」的，MVP 里是否真的没有整段复制（抽平行段落比对，给出相似度判断）；三个依赖包 `@deepseek-ai/schemastery`、`@deepseek-ai/cosmokit`、`@standard-schema/spec` 的 LICENSE（node_modules 内）是否满足「全部 MIT」前提、NOTICE 是否需要补记依赖出处；`plugin-mroute\LICENSE` 文件是否齐且为 MIT。
⑤ **schemastery dependencies 漏声明根因与流程教训**：结合 docs/HANDOFF-M-mvpdev.md 与 docs/04-mvp-notes.md 时间线还原初版为什么漏（手写 package.json？未跑 npm install？），给出 1-3 条流程性防再犯措施（如发布前 `npm ls --all` / import 冒烟 / check script 扩展）。
⑥ **确认可行清单（必答）**：MVP 相对 07 方案 M1 的「超出/缩水」对照结论 + 你确认可行的接缝/排序/红线正面结论，逐条带文件:行号证据。

## 4. 产出格式（最终答复）
- **findings 清单**：每条 `{severity: blocker|major|minor, area, description, evidence: "文件路径:行号", suggestion}`；blocker=阻断收口，major=须修，minor=记录。
- **确认可行清单**：带证据的正面结论（审计是论证不是走过场，不许只挑刺）。
- **上报纪律**：先 `send_message {agent:"audit-lead"}` 报一句话结论 + blocker/major/minor 计数，再输出完整结构化 findings 作为最终答复（父会话只收得到消息与最终答复，收不到过程）。
