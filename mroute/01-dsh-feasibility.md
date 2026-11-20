# DSH 侧可行性调研：子会话派遣「模型选择优先参考」插件

- 树节点：mroute / mroute-W1-dshmech
- 调研时间：2026-11-13
- 证据源：`D:/DSHarness/resources/app.asar/dsh/`（DSH 0.2.2-rc.1 桌面版 asar，仅 read 工具可读）、`cordis_inspect_list/query` 实测输出、本会话工具面实测
- 交付物：本文档

> 注：本 build 的 `cordis_inspect_query` exact-query（带 `input` 参数）一律被宿主拒绝（`"input" must be an object`，Service/Event/Config 三个 provider 实测均复现），只能用无参 catalog 模式 + asar 内运行时 JS 源码补证。asar 中 `.d.ts` 类型文件被剔除（package.json 声明 `lib/types/index.d.ts` 但文件不存在），故类型证据以运行时 JS 内的 JSDoc/实现为准。

---

## A. Host 侧插件能注册什么

**注册入口（导出形式二选一，不可混用）**——`node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md` L57-64：

> "`index.js` exports one of these forms; do not mix them:
> - `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
> - A service class as the default export.
> Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup. A plugin that declares `Config` validates the row's `config` at activation."

**可注册面**（证据 = practices.md + 宿主 Service/Event catalog + dsh-tool-subagent 实源码）：

| 注册面 | API | 证据 |
|---|---|---|
| Tool（Agent 可调用工具） | `ctx.tools.register(defineTool({name, description, parameters, output:{schema,render}, execute}))` | `dsh-tool-subagent/lib/index.js` L215-238（`list_subagent_models` 注册体）；Service catalog `tools.register(definition, options)` |
| Event（宿主事件监听） | `ctx.on('<event>', listener)`；waterfall 监听器可改写 | host-plugin.md L64（"Register every resource inside `apply` with `ctx.effect` or `ctx.on`"）；practices.md L10（"waterfall listeners can rewrite and depend on registration order"）；Event catalog（host）全部事件目录 |
| Service（进程内服务） | service class 默认导出（`extends Service`，`static inject`、`static Config`） | `dsh-tool-subagent/lib/model-selection-settings.js` L72-74：`class SubagentModelSelectionConfig extends Service { static inject=["sessionProjections","sessions"]; static Config=… }` |
| Config（JSON Schema 配置） | 导出 `const Config = z.object({...})`（schemastery），row `config` 激活时校验；改自身配置走 `ctx.get('configEditor').edit(entry, fn)`，volatile 字段原地热更 | host-plugin.md L64/L68-77；`dsh-tool-subagent/lib/index.js` L301-315 的 `Config` |
| System Prompt 注入 | `ctx.systemPrompt.section({name, order, text})`、`ctx.systemPrompt.context({...})`、`agent.inject()` | practices.md L18（仅记载 section()/agent.inject()）；Service catalog `systemPrompt`（`section()`/`context()` 签名，修复会话复核）；`dsh-tool-subagent/lib/index.js` L500-509（section）与 L510-521（context）实战用例 |
| 每会话派生状态 | `ctx.sessionProjections.register({key, stateVersion, stateSchema, init, apply})`（纯函数 fold 会话事件流） | `model-selection-settings.js` L44-59、L85 |
| Client UI Slot | `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`；插件页=slot 里的 React 组件；会话行视图走 `ctx.uiConversation.events.register()` + `conversation.chat.node` slot | practices.md L33-38 |
| 宿主 HTTP 路由/页面注入 | `webServer.register(route)`、`webServer.tapIndex(html→html)`、`webserver/index-inject` 事件 | Service catalog `webServer`；Event catalog `webserver/index-inject` |

**样板**（templates/decoration/）：`package.json` 声明 `dsh.bundle.patch`（指向 `cordis.patch.yml`）与 `dsh.client`（`platform:"web"`、`immediately:true`、`inject` 指定 client 侧激活顺序）；patch 内容仅一行插入 `- insert: [{id, name}]`；Host 半边 `index.js` 可为 `export function apply() {}` 空实现。Loader 方言（insert / 按 id override / `group` / `disabled`+`!!js` / `isolate`）见 `cordis-composition-reference/SKILL.md` L10-25。

---

## B. 子会话派遣的模型解析链（缺省从哪来）

派遣工具 = `@deepseek-ai/dsh-tool-subagent`（`subagent`/`subagent_fork` 两个 row 共用此包，见插件清单 `include:tool-subagent` / `include:tool-subagent-fork`）。其 `lib/index.js` 给出完整实现（本机实测我的 `subagent` 工具已暴露 provider/model/reasoning_effort 参数，即该 profile `modelSelection=true`）：

**1) 缺省合并链**（`requestedAgentOptions(parentOptions, configured, request, enabled)`，L60-79 + execute L438-443）：

```
request.provider/model/reasoning_effort（模型显式给）
  > configured = config.agentOptions（插件 row 配置的子默认）
    ⊕ providerRouteDefaults（后端 provider 的 agentRouteDefaults，若有）
  > parentOptions = parentAgentOptionsForDelegation(parent)（父代理当前 route）
```

工具 description 两档措辞（L370）实证了这条链：
> `"Omitted values use child defaults, falling back to compatible parent values."`（无后端 route defaults 时）
> `"…falling back to this backend's route defaults."`（有 providerRouteDefaults 时）

约束：provider+model 必须成对（L66）；**换 route 且未带 effort → 丢弃 configured 的 effort**（L69-72）；route 未变时 omitted effort 继承父 effort，route 变了则用模型默认（`preflightChildLlmRoute` L115-126：`inheritParentReasoningEffort && !routeChanged`）。

**2) 派遣前活校验**（L445-449）：`llm.resolveCallConfig({provider, model, reasoningEffort})` —— "The LLM runtime owns provider lookup, exact-model metadata, effort validation, and adapter defaults"。校验失败工具直接抛错，派遣不发生。

**3) 可用 provider/model 清单的权威来源 = `llm` 服务**（Service catalog `llm` 条目，spill 全文 L1032-1083——无参 catalog 模式可复现：修复会话复跑 `cordis_inspect_query host/Service.listService`（无参），`key:"llm"` 仍落于 spill 全文 L1032-1083，描述与 registerAdapter/listProviders/registerConfigurableProviders/registerModelDiscovery/listModels/resolveModelInfo/resolveCallConfig/providerRetryPolicy 等签名逐字吻合；spill 为会话临时文件不作持久证据，行号仅辅助定位）：

> `"The abstract llm service: an adapter registry plus a streaming model-call API, interceptable via the llm/stream waterfall."`
> 方法：`listProviders(): LlmProviderInfo[]`、`listModels(provider): Promise<LlmModelInfo[]>`、`resolveModelInfo(provider, model)`、`registerAdapter(providers[], adapter)`、`registerConfigurableProviders(entries)`、`registerModelDiscovery(settingsNs, discover)`

组成 = **编译期适配器**（`dsh-llm-deepseek-api-key`、`dsh-llm-deepseek-account`，均 active）+ **用户可配置目录**（`registerConfigurableProviders`，对应设置页 `ui-settings-models`）。**本机实测** `list_subagent_models()` 无参返回：`deepseek-official / deepseek-account / opencode-go / zai-coding-cn / xiaomi`（后三个为可配置目录项）。

**4) 部署级/会话级授权层 = `subagentModelSelection` 服务**（`dsh-tool-subagent/lib/model-selection-settings.js` L71-118，对应 active 插件行 `include:subagent-model-selection-settings`）：

- Config：`enabled: boolean` + `allowedModels: {provider,model}[]`，两者 `.volatile()`（设置页热更）；
- `agent/created` 时给**尚无 policy 的会话**写入 durable 事件 `subagent/model-selection-policy {allowedModels}`：子会话（`origin==="subagent"`）**继承父会话 policy**；全新顶层会话取当前部署配置；
- 投影 `subagentModelSelectionPolicy`（key=`subagentModelSelectionPolicy`, stateVersion=1）：`apply` 只允许 `null → routes` **单向迁移**（L52-58）——policy 一旦落定，本会话不可撤销/更改。

**5) 部署级缺省模型另有独立服务 `agentDefaultModel`**（Service catalog）：`"Owns the default model selection independently of any Host or transport"`，`currentSelection()/saveSelection()`。顶层会话的"父 route"最终源于它。

**6) 宿主已内置发现工具 `list_subagent_models`**（`dsh-tool-subagent/lib/index.js` L214-239，`config.modelDiscovery===true` 时注册）：
> `"Inspect subagent models without changing the current Agent. No arguments: providers; provider: allowed models; provider + model: that model and its reasoning efforts. Inspect options here before selecting a child provider and model; use returned ids for delegation."`

—— 它按 session policy 过滤：无 policy 时只显示父 route（L177-184）。

**7) 其他派遣口同构**：`tree_dispatch` 的 `assignee:{provider?,model?,effort?}`（tree-engine 亦走 `ctx.subagents` 接缝；其 description 明言 assignee 在 leaf 持久化）；`spawn_teammate`（`dsh-experimental-tool-agent-team`，active）；workflow `agent()` 的 `provider/model/effort` 覆盖。均最终收敛到 `subagents.startActivation(spec)` / `agents.create(options)`（Service catalog）。

---

## C. 插件能否拦截/重写派遣时的模型选择

**分三层，结论不同：**

**① 派遣参数层（tool args）——不能改写，只能放行/拒绝。**
`tools/pre-execute` waterfall 的契约是 "Allow, deny, cancel, or ask before dispatch"（Event catalog），practices.md L17 同义；`tools/execute` 是 "Around-dispatch waterfall for timeout, retry, or metrics"（不可改 args）；`tools/post-execute` 只能改结果。没有 "rewrite tool arguments" 的宿主机制。
但注意：**派遣工具自身就有硬策略门**——`assertAllowedModelSelection`（L89-96）：

> 无 policy 时："explicit selection (including reasoning_effort) is limited to the parent route"；有 policy 时 route 必须命中 `policy.routes`，否则抛 `"child LLM route \"p/m\" is not allowed for this Session"`。

所以「拦截（拒绝不良选择）」实际已有宿主原生机制；插件可叠加 `tools.guard()`（practices.md："A denial that must hold regardless of order is a ctx.tools.guard()"）做**补充拒绝**，但**改写目标模型没有官方参数层通道**。

**② 模型调用层——可以改写，但是全局且低层。**
`llm/stream` waterfall（Event catalog）：
> `'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>`，描述 "Waterfall around every streaming model call (retry, replay, **routing**)"；`llm` 服务描述同句 "interceptable via the llm/stream waterfall"。

practices.md L10 明文："waterfall listeners can rewrite and depend on registration order"。理论上插件可在 `llm/stream` 里改 `GenerateOptions` 的 route（把请求改道到别的 provider/model）。局限：作用于**所有**模型请求（含父会话、compaction、会话标题等辅助调用），需自行按调用方区分；生成选项对象的可变语义本次未逐行验证（asar 内 dsh-llm 主文件过大未通读）——列为**理论可行、工程高风险**通道，不建议作主方案。

**③ 授权策略层——插件不是权威，但部署配置是热改的。**
policy 权威 = `subagentModelSelection` 服务的 volatile Config（`enabled`/`allowedModels`）。插件改它只有两条路：`configEditor.edit()`（改 profile 文件、重启插件生效）或设置服务 `settings.update(ns, patch)`（该服务方法存在，属 UI 面）。**没有面向插件的"每会话动态下发 policy"公开 API**（policy 事件 `subagent/model-selection-policy` 由 `agent/created` 监听器按部署配置写入，且投影单向锁定）。且 `agentDefaultModel.saveSelection()` 只改部署级缺省，影响的是**下一个**顶层会话。

**=> C 判断：插件不能"在派遣瞬间替换模型"；能做的是（a）提供派遣前查询工具（参考层），（b）guard 拒绝，（c）llm/stream 全局改道（高风险），（d）改部署配置影响新会话。**

---

## D. 「模型优先参考」四种注入方式对比

| 方式 | 可行性 | 证据 | 局限 |
|---|---|---|---|
| ① Host Tool（如 `model_route_query`，派遣前调用） | **可行，推荐** | `ctx.tools.register(defineTool(...))` 即可（A 节）；宿主自己的 `list_subagent_models` 就是同形态先例（B-6）；本机已装 `list_subagent_models` 实测可用 | 依赖模型自觉调用；工具面每次请求都占 token；返回的是"参考"，无强制力 |
| ② 预设/skill/context 注入（改 preset 或 skill 文件） | **可行，次选** | `ctx.systemPrompt.section()/context()`（dsh-tool-subagent L500-521 实战）、`agent.inject()`（practices.md L18，记录为 `agent/inbox/spliced`）、skills 服务 `register/skill`（Service catalog）；preset 由 `agentPresets.mount/composeFrom` 组合 | 静态文本，不随余额/负载动态变化；直接改用户 preset 文件侵入性强；skill 需模型主动 load |
| ③ Config 静态配置 | **可行但仅是数据源** | 插件自带 `export const Config`（A 节），用户在 cordis.patch.yml 改；volatile 字段热更（host-plugin.md L77） | 纯静态优先级表；无人帮模型读它——仍需 ①或② 消费；改普通字段重启插件 |
| ④ Client UI 面板（人看） | **可行（辅刃）** | `ctx.slots.inject()` + React 组件（practices.md L33-37）；theme token 规约 L34；本机 meta-adapter-ui provider 证明第三方 UI 插件已跑通（iframe 面板形态） | 模型看不见；只服务人工决策；React 组件需自写（禁 import host UI 包，practices.md L35） |

**推荐组合**：①为核（注册 `model_route_query` Tool，内部聚合 `llm.listProviders()/listModels()` + 插件自有优先级/备选链/余额数据），③承载优先级/备选链静态配置，②补一段 systemPrompt.section 提示模型"派遣前先查"，④做人工查看面板。**不要**碰 C-② 的 llm/stream 改道。

---

## E. Host 侧插件对外 HTTP 与密钥存放

**HTTP：可行，多通道。**
- 插件代码在宿主进程内以 ESM 直接加载（`dsh-tool-subagent/lib/index.js` 顶层 `import z from "@deepseek-ai/schemastery"` 等；`dsh-subagent/lib/index.js` 还直接 `import {randomUUID} from "node:crypto"`、`import {accessSync…} from "node:fs"`）——插件同样可用 Node 全局 `fetch`/`node:http(s)`；
- 宿主正规接缝：`ctx.connection.fetch: HostConnectionFetch`（Service catalog `connection`）；`web.registerFetchProvider()/fetch(request)`（`web` 服务）；`webhookRuntime.register/dispatch`（出站 webhook 规则引擎）；官方出站 HTTP 先例包 `dsh-web-fetch-http`、`dsh-web-search-deepseek` 均 active。
- **查渠道余额甚至有官方先例**：`deepseekAccount` 服务 `getBalance(client): Promise<AccountDetails['balance']|null>`（"only Host consumers can obtain a request credential"）——查 DeepSeek 官方余额不必自己发 HTTP；第三方渠道（openrouter/硅基流动等）才需插件自 HTTP。

**密钥：放 credentials 服务，绝不放 Config。**
- `@deepseek-ai/dsh-credentials/README.md` L12：*"keeps secret values out of configuration"*；L54-58 `credentialRef('DEEPSEEK_API_KEY')` + `ctx.credentials.resolve()/set()/describe()`（describe **永不回显值**）；L64-78 记录通道 `credentialKey('<owner>/<id>')` + `ctx.credentials.modifyRecord()`——正是 host-plugin.md L77 的要求："Store secrets … as `ctx.credentials.modifyRecord()` records, not configuration; declare `credentials` in `inject`"。
- 环境变量亦可：README L32 "If you only need one fixed environment variable, read that variable directly and skip the store"，且 stored key 优先于 env fallback（L57）。
- 本机已装 `include:credentials → dsh-credentials-local`（active），存储路径可配。

---

## F. 当前 profile（desktop）已装插件与配置现状

`plugin_manager list_plugins` 全量 244 行 + Config catalog 页 0（247 条目）。第三方/社区插件全部 active：

- `include:tree-engine → @local/dsh-tree-engine`（本任务树的宿主，tree_dispatch 即来自它）
- `include:meta-adapter → @local/dsh-meta-adapter`、`include:harness-rsi → @local/dsh-harness-rsi`、`include:dsh-flow-engine → @local/dsh-flow-engine`、`include:thoughtdag → dsh-thoughtdag`、`include:dsh-market → dshmarket`、`include:dsh-startup-secret → dsh-startup-secret`、`include:session-tree → @orphiczhou/dsh-session-tree`、`include:td-tweak → @local/dsh-td-tweak`、`include:region-probe`、`include:agent-introspect`
- `include:gemini-web → @deepseek-ai/dsh-mcp-client`（MCP 桥）

与本调研直接相关的官方行（全部 active）：
`include:agent-default-model`、`include:subagent`、`include:subagent-spawn-in-process`、`include:subagent-fork-in-process`、`include:subagent-model-selection-settings`、`include:llm`、`include:llm-deepseek`（=dsh-llm-deepseek-api-key）、`include:llm-deepseek-account`、`include:llm-retry`、`include:ui-model-selection`、`include:ui-settings-subagent`、`include:ui-settings-models`、`include:agent-team` + `include:tool-agent-team`（spawn_teammate）、`include:credentials`（=dsh-credentials-local）、`include:web-fetch-http`。
（部分可选工具行 disabled：`tool-subagent`/`tool-subagent-fork`/`tool-web`/`tool-bash` 等——被 preset 级同包行覆盖或按 preset 挂载，不影响机制结论。）

结论：第三方插件挂 Tool/Service/UI 的形态在本机已被 tree-engine、meta-adapter、harness-rsi 等充分验证；模型选择链路的全部关键插件（缺省模型、授权策略、DeepSeek 适配器、发现工具、UI）都在线。

---

## DSH 侧可行性结论（逐点）

| 判定项 | 结论 | 关键证据 |
|---|---|---|
| **插件注册"派遣前查询"工具（`model_route_query`）** | **可行** | `ctx.tools.register(defineTool(...))`（host-plugin.md L59-64 + dsh-tool-subagent L215-238 同形态先例 `list_subagent_models`，本机实测可调、返回 5 provider）；数据源 `llm.listProviders()/listModels()/resolveModelInfo()`（Service catalog） |
| **拦截/重写派遣时的模型选择** | **不可行（参数层无官方改写通道）**；拒绝可行（`tools.guard()`）；llm/stream 全局改道理论可行但高风险不建议 | `tools/pre-execute`="Allow, deny, cancel, or ask"（Event catalog，无 rewrite）；`tools/execute`="timeout, retry, or metrics"；派遣硬策略门 `assertAllowedModelSelection`（L89-96）；`llm/stream`="retry, replay, routing"+practices.md "waterfall listeners can rewrite"（全局、低层、GenerateOptions 可变语义未逐行验证） |
| **插件 Host 侧发 HTTP 查渠道余额** | **可行** | 插件进程内 ESM 运行（可 Node 全局 fetch）；正规接缝 `ctx.connection.fetch`/`web.fetch`/`webhookRuntime`；官方 `deepseekAccount.getBalance` 先例；密钥走 `ctx.credentials`（`modifyRecord` 记录 / `credentialRef` 键），禁止进 Config（dsh-credentials README L12/L54-78 + host-plugin.md L77） |
| **推荐注入方式** | **①Host Tool（核）+ ③Config（静态优先级/备选链数据）+ ②systemPrompt.section（一句提示先查）+ ④UI 面板（人工查看，可选）** | ①③②④证据见 D 节表；宿主原生缺省链（request > config.agentOptions ⊕ providerRouteDefaults > parentOptions）已能吃 ③ 的静态子默认（`config.agentOptions:{provider,model,reasoningEffort,maxTokens}`，L306-311），插件不必重复造缺省机制 |

**一句话**：在 DSH 侧做「模型选择优先参考」插件完全可行——以注册查询工具为主体（宿主连参考工具都内置了同款 `list_subagent_models`），静态优先级放插件 Config，余额走 credentials+HTTP（或官方 getBalance），可另配 UI 面板；但"派遣瞬间自动改写模型"没有安全的插件通道，只能退而求其次做"参考+守门（guard 拒绝）"或高风险的 llm/stream 全局改道。

## 遗留不确定点（诚实声明）

1. `GenerateOptions`（llm/stream）字段级可变性未逐行验证（asar 内 dsh-llm/lib/index.js 过大未通读；inspect exact-query 在本 build 损坏）。
2. `agentRouteDefaults`（spawn-in-process provider 侧子默认）的具体来源未深挖（在 dsh-subagent-spawn-in-process 包内，机制语义已由工具 description 两档措辞证实）。
3. Config catalog 仅翻了页 0/25 条（分页参数在本 build 被拒）；全量 247 条目未逐条列 schema，但 F 节结论以 `plugin_manager list_plugins` 全量 244 行为准，不受影响。

---

## 修复记录（第 1 轮异族审计修复执行 · 2026-11-13）

> **审计发现清单缺失说明**：本轮修复任务书携带的「审计发现：」一节在派发/竹节接力链路中为空（why_find 回读派发原文确认：`审计发现：` 与 `请立即修复` 之间无任何条目；父会话与树日志均未检索到该轮 adversarial 审计的 findings 文本）。为避免按猜测误改，执行者未重写任何结论性内容，仅对**独立复核中可逐字验证的三处引用缺陷**做外科修正；其余全文引用与事实断言逐条复核属实（清单见下）。如父会话补发原始 findings，可在本记录之上继续增补修正。

**修正项（3 处，均为引用层，不动结论）**：

1. **A 节 Event 行引用错位**：`ctx.on` 注册 API 原引 practices.md L16-17（该处实为 waterfall 纪律与 guard/ask 规则，不含 `ctx.on` 注册语义），改引 host-plugin.md L64 原句 "Register every resource inside `apply` with `ctx.effect` or `ctx.on`"，并补 practices.md L10 原句 "waterfall listeners can rewrite and depend on registration order" 作为"可改写"的准确出处。
2. **A 节 System Prompt 行断言超宽**：practices.md L18 只记载 `section()` 与 `agent.inject()`，不含 `context()`；补 Service catalog `systemPrompt` 的 `section()`/`context()` 签名（修复会话实测复核），并把 dsh-tool-subagent 实战用例拆分为 L500-509（section）与 L510-521（context）精确出处。
3. **B-3 节 spill 引用悬空**：原"spill 文件 L1032-1083"指向原调研会话的 Temp 临时文件、读者不可解析；补无参 catalog 模式的复现路径（修复会话复跑后 `key:"llm"` 仍恰为 L1032-1083、引文逐字吻合），行号保留但标注非持久证据属性。

**复核确认无误的引用（修复会话逐字抽验，未改动）**：DSH 版本 0.2.2-rc.1（asar `dsh/package.json` L4）；host-plugin.md L57-64/L68-77/L77；practices.md L10/L16-17/L18/L33-38；`dsh-tool-subagent/lib/index.js` L60-79（requestedAgentOptions）/L66（provider+model 成对）/L69-72（换 route 丢 effort）/L89-96（assertAllowedModelSelection 及两条报错原文）/L115-126（preflightChildLlmRoute 与 `inheritParentReasoningEffort && !routeChanged`）/L177-184（无 policy 只显父 route）/L214-239（list_subagent_models 注册体与 description 原文）/L301-315 与 L306-311（Config.agentOptions）/L370（两档缺省措辞原文）/L438-449（合并链+活校验）/L500-521（systemPrompt 实战）；`model-selection-settings.js` L44-59（投影定义）/L52-58（null→routes 单向迁移）/L72-74（Service 声明）/L76-77（volatile Config）/L85（register）/L92-99（子继承父 policy、顶层取部署配置）；`dsh-credentials/README.md` L12/L32/L54-78；Service catalog：llm（L1032-1083）、agentDefaultModel（描述原句）、deepseekAccount.getBalance（"only Host consumers can obtain a request credential"）、connection.fetch、web.registerFetchProvider/fetch、webhookRuntime.register/dispatch、webServer.register/tapIndex、tools.register/restrict/guard、configEditor.edit、subagents.startActivation/registerProvider；Event catalog：llm/stream（"Waterfall around every streaming model call (retry, replay, routing)"+签名）、tools/pre-execute（"Allow, deny, cancel, or ask before dispatch"）、tools/execute（"Around-dispatch waterfall for timeout, retry, or metrics"）、tools/post-execute、webserver/index-inject（存在性）、agent/pre-step（payload 含 modelSelection）——引文均逐字吻合；client 侧 meta-adapter-ui provider 自述含 iframe src/overlay 面板，佐证 D-④。
