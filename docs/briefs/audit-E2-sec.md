# 审计任务书 E2 — 安全审计（mroute MVP）

> 你是 mroute 插件专家审计团的 E2（会话名 audit-sec），由审计指挥官 audit-lead 派遣的独立孙会话。本文自包含，按序执行即可。

## 0. 背景（一句话）
mroute 是 DSH 多子会话派遣的模型选择优先参考插件（只读查询型工具，无凭据无外呼）；MVP 代码在 `plugin-mroute/`，lead 已实测激活；现做三视角专家审计（E1 架构与许可 / E2 安全 / E3 产品与 PRD），你是 E2，专注攻击面与泄漏面。

## 1. 环境事实与坑（必读）
- 宿主 asar 归档 `D:\DSHarness\resources\app.asar\dsh\` **只有 read 工具能读**；pwsh/glob/grep/node 一律打不开。工作区内文件 glob/grep/read 正常。
- asar 内插件开发文档（路径已迁移，以此为准）：`D:\DSHarness\resources\app.asar\dsh\skills\dsh-doc\references\host-plugin.md`（工具返回/Config 边界）、`practices.md`（安全纪律章节）；`.d.ts` 被剔除，证据取运行时 JS + JSDoc。
- schemastery @3.19.0 Day 1 实测：嵌套 z.object 在 channels[] 元素内逐键存活；`z.record` 缺失、`z.dict` 存在；`.volatile()` 在数组元素内抛错，channels[] 数组整体 `.volatile()` 合法且 .get() 读回完整。
- 已知安装期事实（lead 实测）：初版漏声明 schemastery dependencies 后已补 `^3.19.0` 并自带 node_modules（含传递依赖 cosmokit、@standard-schema/spec）激活成功。
- 你是 leaf worker：**不得派发子会话**，不得用 workflow/ralph；主要用 read/grep/glob。
- 上下文接近 50%：把进度写 `D:\Codes\DSH小插件\docs\HANDOFF-E2-sec.md` 并 `session_handoff`（先 action:"status" 再 action:"handoff"）同层接替。

## 2. 必读材料（按序）
1. `D:\Codes\DSH小插件\AGENTS.md`（§4 坑、§6 审计模式）
2. 被审计代码全量：`plugin-mroute\index.js`、`lib\` 八模块（config-schema / registry / volatile / livecheck / errors / ranking / tool-query / prompt-section）、`locale\en.json` + `zh.json`、`cordis.patch.yml`、`package.json`、`package-lock.json`（是否入库/锁了什么）、`README.md`
3. 安全契约对照：asar `skills\dsh-doc\references\practices.md`（安全纪律）、`host-plugin.md`（Config/工具返回边界）
4. 需求侧安全条款：`docs\02-prd.md`（安全相关 FR/约束）、`mroute\07-assembly-plan.md`（安全相关章节，按需）
5. 实测记录：`docs\04-mvp-notes.md`（Config volatile 实测结论）

## 3. 问题清单（逐条编号回答）
① **凭据面**：全量源码 grep 确认无 credentials 读取、无环境变量密钥（`process.env`）、无 HTTP 出站（fetch/axios/http/https/net）、无子进程（child_process/exec/spawn）、无文件系统越界写（fs 使用范围）；每项给命中或零命中证据。
② **工具返回泄漏面**：tool-query.js 返回文本构造逐处审——返回是否可能带宿主内部路径、凭据、配置敏感值（如注册表 channels 里若被用户塞入 key/token 字段，会不会原样透出到模型可见文本）；livecheck 失败信息是否透出内部 URL/路径；locale/zh.json+en.json 文案有无敏感词、内部路径、可被社工利用的表述。
③ **Config 注入面**：config-schema.js 注册表字段被恶意配置时的行为——原型污染（`__proto__`/`constructor` 作为 channel 名或 key）、路径注入、超长值（数组巨大/字符串超长的 DoS）、非预期类型（数字当字符串）；schemastery schema 是否兜底（类型强制/默认值）；registry.js 解析是否信任输入（有没有二次校验）；volatile 落点对注入的放大或抑制作用。
④ **错误处理**：errors.js + 各 try/catch——异常信息是否把内部路径/堆栈/宿主细节返回给模型（工具返回文本 & 日志）；失败降级（如活校验失败）是显式标注还是吞错误导致静默错误排序。
⑤ **依赖供应链**：仅 `@deepseek-ai/schemastery ^3.19.0` 一个直接依赖（cosmokit/@standard-schema/spec 为传递依赖）——评估 `^` 范围漂移风险 vs 精确锁版本、node_modules 自带（bundle 内 npm install）策略的利弊与重建风险、package-lock.json 是否入库且与 package.json 一致；给出锁版本建议。
⑥ **确认可行清单（必答）**：无凭据面/无出站面/返回面可控等正面结论，逐条带文件:行号证据。

## 4. 产出格式（最终答复）
- **findings 清单**：每条 `{severity: blocker|major|minor, area, description, evidence: "文件路径:行号", suggestion}`；blocker=阻断收口，major=须修，minor=记录。
- **确认可行清单**：带证据的正面结论（审计是论证不是走过场，不许只挑刺）。
- **上报纪律**：先 `send_message {agent:"audit-lead"}` 报一句话结论 + blocker/major/minor 计数，再输出完整结构化 findings 作为最终答复（父会话只收得到消息与最终答复，收不到过程）。
