# 子会话派遣/模型管控五插件源码分析：mroute 的宿主接缝与额度联动（07c）

- 树节点：mroute / mroute-W9-subsrc
- 分析日期：2026-11-13
- 方法：5 个社区插件**源码逐文件精读**（vendors/ 下完整 checkout，read/grep 全套），逐插件回答 A–E 五问
- 上游依据：`01-dsh-feasibility.md`（W1 宿主接缝）、`00-feasibility-report.md`（M1–M6 架构）、`05-report-extension.md`（volatile 化约束）、`06-market-scan.md`（点名本批插件）
- 引用约定：`插件#文件:行号`；`01§X`/`00§X`/`05§X` 同前

---

## 0. 一页结论

| 插件 | 控制缝（A） | 与原生策略门关系（B） | 额度联动（C） | 对 mroute 的最大价值 |
|---|---|---|---|---|
| xingzhen199186/**dsh-subagent-custom** | `agent/request` waterfall 改写子代理请求（**唯一被源码证实的请求层改写缝**）+ `agent/pre-step` 建议注入 | 改写**绕过**策略门（门只验派遣参数）；建议文本经 policy 投影整形 | 无 | v2 改写通道的实现细节与**风险实录**（session-key 漂移、无条件覆写） |
| twoweeks1995/**dsh-subagent-setup** | 自有委派工具 `subagent_route`：别名→`agentOptions`→`startActivation` | **绕开**（自建工具不经原生 `assertAllowedModelSelection`，也不补） | 无 | 「给模型的选路参考表」数据结构与**中性别名实验**（0/2 vs 8/8） |
| SeverusZh/**dsh-plugin-subagent-director**（★24） | 自有委派工具 `subagent_role`：call>role>default>inherit 三层解析 | **兼容/复制**：读官方 `subagent-model-selection-settings` 命名空间，显式路由不在清单即抛错、角色路由不在清单丢弃→inherit（复刻语义不绕开） | 无 | 路由解析器纯函数 + policy 交集读法 + 双命名空间纪律（transport≠LLM route） |
| tkaiz0406/**dsh-subagent-route-pin** | ① `subagents.registerProvider` 包装 provider（`base.start` 前改 `agentOptions`）② 猴补 `ctx.subagents.startActivation/startContinuable` ③ `agent/request-error`→一次性 `agent/request` 换道 | 不验 policy；靠 `llm.listProviders/listModels` 活校验（advisory/strict 两档） | **有**：`FAILOVER_FAILURE_CODES={QUOTA,RATE_LIMIT,AUTH,MISSING_CREDENTIAL,NO_ADAPTER}` 触发运行中换道 | **provider 包装与 startActivation 猴补两缝的完整实现**+运行中 failover 模式 |
| wufeng0105/**dsh-teammate-model-picker** | `agent/created`→为队友装三条 scoped waterfall（`system-prompt/assemble` 快照 + `agent/request` 改写 + `agent/pre-step` notice）= 官方 `installModelSelection` 等价形状 | **复制官方语义**而非绕开；明确不碰白名单（已知限制） | **人肉版**：用户看 `turn/end ERROR QUOTA_EXCEEDED`→UI 换模→`model/selection` 事件落盘→下一 step 生效 | **「换模继续跑」的官方同构实现**：per-agent scoped 安装 + 既有事件类型复用 |

**核心新事实（相对 01§C 的增量）**：
1. 01§C 说「派遣参数层无 rewrite 通道」——仍然正确（`tools/pre-execute` 只有 allow/deny）。但插件层证明存在**另一条改写缝**：`agent/request` waterfall（每个 agent ctx 可 scoped 安装）正是**官方 `installModelSelection` 自己用的三条瀑布之一**（picker#DESIGN.md:55「三条 waterfall 是官方 installModelSelection 的等价形状」）。它不是 `llm/stream` 那种全局低层瀑布——**作用域可控、语义官方背书**，是 v2 评估的正主。
2. `subagents.startActivation` 的 continuable 路径**不经 `provider.start`**：runtime 判 `prepareContinuable` 存在即走 `startLocal(spec)`，路由只从 `spec.request.agentOptions` 读——所以包装 provider 拦不住队友/团队成员，唯一注入点是猴补 `startActivation`（route-pin#index.js:1105-1111 注释实录）。
3. 额度检测的机读信号在会话事件里：`turn/end ERROR {"code":"QUOTA_EXCEEDED"}`（picker#REPORT.md:40 实测）与 `agent/request-error` 的 `failure.code`（route-pin 枚举五类）——mroute 的余额层可以把它当「本地实测额度信号」接入（00§3.2 D 类估算的旁路证据）。

---

## 1. xingzhen199186/dsh-subagent-custom（MIT）

> 「Jev 判定任务类别→在 agent/request 钩子改写子代理请求」。实际上它有两个半缝：`agent/request` **强制改写**（auto/manual 模式）+ `agent/pre-step` **建议注入**（推荐文本）+ 角色提示词注入。无 agent 工具面。

### A. 控制缝

- **改写主缝 = `ctx.on("agent/request", …)`**（index.mjs:658-703）：
  ```js
  const config = await next();                       // waterfall：先放下游
  const depth = agent?.options?.subagentDepth;
  if (typeof depth !== "number" || depth < 1) return config;   // 只动子代理
  const route = enforcedRoute(sessionId);            // 人工选模 or Jev 判定的路由
  const overridden = { ...config, provider: route.provider, model: route.model };
  if (route.reasoningEffort !== undefined) overridden.reasoningEffort = route.reasoningEffort;
  else delete overridden.reasoningEffort;            // 换路即丢档位（同官方语义）
  ```
  源码自评：**"The only place a subagent's model can be rewritten, and it wins over whatever the caller passed"**（index.mjs:652-654）——改写**无条件生效**，连调用方显式指定的路由也覆盖；模型跑不了算配置错误，不静默回退（index.mjs:686-689 注释）。
- **建议缝 = `ctx.on("agent/pre-step", …, {prepend:true})`**（index.mjs:457）：Jev 分类后把「建议委派给 X 角色（provider/model）」作为 user 消息 append（`createUserMessage`，source=`plugin:subagent-custom`，index.mjs:143-164）——纯建议，模型可忽略；同缝还做子代理首步角色提示词注入（去重 Set，cap 500，index.mjs:454-507）。
- **无委派方参考工具**：给模型的参考数据走 systemPrompt/消息注入，不走工具。
- **不经 `startActivation` 参数**：派遣仍走原生 subagent 工具（源码自述 "The plugin owns no delegation machinery of its own"，index.mjs:12-16）。

### B. 与原生机制的关系

- **改写本身绕开 `assertAllowedModelSelection`**：策略门在派遣工具 execute 内验**工具参数**；请求层改写发生在派遣之后，门永远看不到最终路由。
- **但建议文本经 policy 整形**（capabilities.mjs:85-128）：`sessionProjections.stateOf(agent.session, "subagentModelSelectionPolicy")` 读会话 allowlist → `routeAdviceFor` 产出 `{named|fork|child-default|allowlist}` 四种建议形态——policy 不允许的命名路由降级为「用子默认/会话清单」。**约束的是建议，不是强制**。
- 附带能力门（capabilities.mjs:60-100）：派遣前验 `tools.get(toolName, agent)` 可见性、`subagents.getProvider(provider)`、`subagents.resolveMaxDepth()` vs `max(header.delegationDepth, options.subagentDepth)`——mroute 的查询工具可抄这套「派遣可行性预检」。

### C. 额度联动

无。Jev 分类走外部 HTTP（TypeSafe SystemOne，`timeoutMs` 4000 fail-open，config.mjs:246-295）。

### D. 配置数据结构

- `routes: {role → {provider, model}}` 五角色（junior/implementer/researcher/reviewer/writer，config.mjs:210-216）；
- `routeFor: {taskClass → role}` 任务类→角色映射（config.mjs:270）；
- `profiles: {auto|careful → {confidenceMin, delegate:{taskClass[], effortMax, blastRadiusMax, maxNoul{}, probabilityMax{}}}}` 委派谓词（config.mjs:152-176）；
- `selections: {rootSessionId → {mode: inherit|auto|manual, provider, model, reasoningEffort, routeProvider, routeModel}}`（src/shared/config.mjs:71；index.mjs:273-285）——**每会话人工选模态**；
- `dispatches: {rootSessionId → [{at, role, provider, model, child}]}` 派遣台账，每会话 cap 20、每子代理去重（index.mjs:385-398）；
- 全字段 `.volatile()` 热更；`resolveConfig` 逐键校验 + provider 预设合并（config.mjs:531-544）。

### E. 工具面

无 agent 工具。UI 面：composer 选择器（TypertRemoteService：`read/dispatches/defaults/set/clear`，index.mjs:757-831）+ 设置页。**教训**：`async` Remote 方法必须显式 `async`——同步方法返回值过线后变空对象（index.mjs:762-768 注释实录）。

---

## 2. twoweeks1995/dsh-subagent-setup（MIT）

> 「命名路由：别名绑定模型+思考档+令牌上限+『何时使用』供模型选路，委派时只写别名」。5 工具全家桶：委派/查目录/改配置/等后台/释放。

### A. 控制缝

- **自有委派工具 `subagent_route`**（plugin/index.js:104-229）：execute 内 `findRoute(settings.models, args.model)` 按别名查表 → `buildChildRequest` → `ctx.subagents.startActivation({provider: settings.subagentProvider, label, request, signal})`（index.js:225）。内层 request 形状（src/delegation.mjs:29-43）：
  ```js
  { prompt, parent, maxDepth,
    agentOptions: { provider: route.provider, model: route.model,
                    ...maxTokens, ...reasoningEffort },
    ...agentPreset }
  ```
- **启动 API 探测降级**（src/delegation.mjs:46-51）：`startActivation`→'activation'，`start`/`startContinuable`→'legacy'，都无→'none' 报错。返回值经 `adaptActivationResult` 适配前台/后台两形态。
- **给委派方的参考数据 = 工具 description 内嵌路由清单**（index.js:115-124）：**关键实测**——「子代理拿不到 plugin 注册的 systemPrompt 段落（实测连 DSH 自己的 harness:identity 都没有），但工具描述一定可见，所以路由清单必须写在这里」。另在 `systemPrompt.section` 同步挂一份给主会话（index.js:281-290）。
- effort 三级优先：显式参数 > 别名默认 > 模型默认（src/delegation.mjs:19-23）。

### B. 与原生机制的关系

- **整体绕开**：不用原生 `subagent` 工具 → `assertAllowedModelSelection` 与 policy 继承**完全不适用**，插件也不补验（src/policy.mjs 只是列表过滤，非模型策略）。
- 已知冲突（README:151-156）：同装多个同类插件时 ①工具重名顶替 ②两套路由清单并存迷惑模型 ③派发/等待工具跨插件不配对。
- 与 picker（插件5）互补的发现：picker 读到「Host 对 `origin:"subagent"` 的会话路由请求一律 `session/agent-busy`」（DESIGN.md:11）——本插件绕开原生工具并不会绕开**会话路由所有权**这道独立闸。

### C. 额度联动

无。

### D. 配置数据结构（★对 mroute 注册表最有参考价值）

别名条目 schema（plugin/tools.mjs:11-28，`modelRouteJsonSchema`）：

```jsonc
{ "alias": "a1",              // 必填，^[a-z0-9][a-z0-9_-]*$，唯一
  "displayName": "…",          // 人看
  "provider": "cherryin",      // 必填，LLM 路由 provider
  "model": "openai/gpt-6.1-sol", // 必填
  "maxTokens": 8192,           // 可选，正整数
  "reasoningEffort": "high",   // 可选
  "agentPreset": "…",          // 可选，绑定 Agent 预设（有 provider 能力守卫）
  "tags": ["spec-audit"],      // kebab-case 段
  "description": "何时使用…" }  // ★必填——给模型的选路依据
```

配套校验（README:81-88）：别名唯一、provider+model 可重复（同一路由多个别名=不同档位）、`agentPreset` 需 provider `capabilities.agentPreset && !inheritsParentContext`（delegation-runtime.mjs:71-84）。

**中性别名实验**（README:90-107，对 mroute 工具输出措辞有直接指导意义）：别名带模型身份/强弱暗示（`v4pro`/`pro`/`flash`）时模型按名字脑补能力、不读「何时使用」——同一任务**带标识 0/2 命中，中性 `a1..aN` 8/8 命中**。结论：句柄与人读名分离，用途写 description/tags。

**持久化反例**：配置存 `<DSH_HOME>/subagent-setup/config.json`（自有 JSON + 自写盘），不走 Config schema——05§E 已判定 mroute 应走 volatile Config（面板可编辑），本插件做法仅参考。

### E. 工具面（5 个）

| 工具 | 参数 | 返回 |
|---|---|---|
| `subagent_route` | `model`(别名，description 内列全部别名)/`prompt`/`description` 必填，`reasoning_effort`/`run_in_background` 可选 | 前台=output 数组原样；后台=`{childId}`（output.schema oneOf，index.js:154-169） |
| `subagent_route_catalog` | 无参 | `{current:{provider,model}, providers:[{id,name,error?,models:[{id,name,description?,inputModalities?}]}]}`——**`llm.listProviders()`+逐家 `listModels()` 聚合，单家失败降级不拖垮**（catalog-runtime.mjs:4-33）；当前路由读 `exec.agent.options.provider/model` |
| `subagent_route_configure` | `action:get|update`，update 带完整替换 `models[]` | `{status:current|updated, settings}`；写盘后立刻 `reconcile()` 重挂工具/提示段（tools.mjs:196-200） |
| `subagent_route_wait` | 后台 childId 集 | 阻塞收齐结果 |
| `close_subagent` | `subagent_id` | `ctx.subagents.drainChildren(parent, [id])`（tools.mjs:253） |

路由行渲染格式（src/catalog.mjs:24-28，可直抄给 model_route_query 输出）：
`- alias: displayName (provider/model) [tags: …] {default effort: high; efforts: low|mid|high*} — 何时使用描述`（`*`=模型默认档）。

---

## 3. SeverusZh/dsh-plugin-subagent-director（★24，MIT）

> 「子代理供应商/模型选择+角色模板」。TS 编译产物（lib/*.js + .d.ts），工程化程度最高。

### A. 控制缝

- **自有委派工具 `subagent_role`**（toolName 可配，delegation-tool.js:251-431）：参数 `description/prompt` 必填 + `role/provider/model/reasoningEffort/run_in_background` 可选。
- **三层路由解析**（route-resolver.js:27-154，**纯函数，mroute 可直接搬**）：
  1. call 层：显式 provider/model/effort；
  2. role 层：`roles[roleId]`（defaultRole 兜底；displayName 模糊回退并告警）；
  3. default 层：`defaultProvider/defaultModel/defaultReasoningEffort`；
  4. 全空 → `layer:'inherit'`（agentOptions=undefined → 子代理继承父路由）。
  effort 经 `ReasoningEffortId()`（@deepseek-ai/dsh-llm 导出）规范化；路由字段逐层取，但 **layer 归属按最高优先贡献层记录**（`call|role|default|inherit`）。
- 派遣：`ctx.subagents.startActivation({provider: transportProviderName, label, request, signal, delivery: 'caller'|'parent'})`（delegation-tool.js:404/418）——前台 `delivery:'caller'` 收 `activation.result/dispose`；后台 `delivery:'parent'` 拿 durable childId；`provider.prepareContinuable` 存在→continuable，否则 one-shot job。
- 参考数据：`systemPrompt.section({name:'subagent-director:roles', order:117, text:()=>renderRolesGuidance(...)})`——**order 117 紧跟 dsh-tool-subagent 的 116.5 工具段**（guidance.js:3-5），text 是活函数每次组装重算，角色清单=`- displayName (model: p/m): description` + `Delegate with: subagent_role({role:"id", …})`。

### B. 与原生机制的关系（★policy 兼容的范本）

- **复制语义、不绕开**（route-resolver.js:72-108 + delegation-tool.js:151-168,336-377）：
  - 读法：官方 `dsh-tool-subagent` 拥有 `subagent-model-selection-settings` 命名空间；本插件 execute 时 `settings.describe({redactSecrets:true})` 找该 ns → `descriptor.value` → `{enabled, allowedModels[]}`（settings.js:249-259）；无该段=无约束但告警「defaults/roles apply unconstrained」。
  - **显式 call 对**：必须在清单内且 provider+model **成对精确匹配**，否则**抛错**（对齐原生 "provider and model must be supplied together" 语义）；
  - **role/default 路由**：不在清单→**丢弃路由字段→inherit**，带告警（不炸派遣）；
  - 另有 `llm.listProviders()` 活校验：显式 provider 不可路由→抛错（FR-8.1 "never silently swapped"）；role/default 不可路由→`fallbackOnInvalid`（默认 true）降级 inherit 或抛错（FR-8.2）。
- 能力守卫（delegation-tool.js:217-225）：`agentPreset` 需 transport provider `capabilities.agentPreset` 且 `!inheritsParentContext`；数字 `maxDepth` 需 `capabilities.depthLimit`。

### C. 额度联动

无（有「路由不可跑→降级」框架，但触发条件是 catalog 缺失/适配器不在，不是余额）。

### D. 配置数据结构

- **双命名空间纪律**（config.js:8-15，mroute 文档应收录）：`subagentProvider`=**传输 provider**（spawn/fork/acp，给 `startActivation({provider})`）；`agentOptions.provider`/`defaultProvider`=**LLM 路由 provider**。两者同名不同义，混用即 bug。
- Composition 字段（重启管）：`subagentProvider:'spawn'`、`toolName:'subagent_role'`、`enableRunInBackground`、`backgroundMode:'one-shot'|'continuable'`、`maxDepth: number|'provider-managed'`。
- Settings 字段（全 volatile）：`defaultProvider/defaultModel/defaultReasoningEffort/defaultRole/fallbackOnInvalid/roles`；`roles` = `z.dict(RoleTemplateSchema, key∈kebab-case)`；RoleTemplate（settings.js:48-71）：`displayName/description` 必填非空白、`agentPreset/provider/model/reasoningEffort` 可选非空白、`toolFilter:{allow[],deny[]}.default(undefined)`（防 schemastery 把缺省物化成 `{allow:[],deny:[]}` → 写进请求会 restrict 全部工具——issue #2 实录）。
- **跨字段约束读时补**：schema 无法表达 `defaultRole` 悬空引用 → `readDirectorSettings` 读时告警（settings.js:111-148）+ 去重告警器（159-169）——**schema 管形状、读时管语义**的分层，mroute 注册表校验照此分层。
- 设置页策略：自有 Web 页 → `settings.configure({auto:false})` 关掉宿主自动页（settings.js:235-239）。

### E. 工具面

`subagent_role` 输出 schema（delegation-tool.js:51-81）：`oneOf {kind:'background', jobId} | {kind:'continuable', subagentId} | {kind:'foreground', runId, output[]}`；render 对齐原生措辞（`started subagent <id>`）。stopReason 错误映射与 `settleForegroundActivation`（result/dispose 独立聚合错误）逐行对齐 dsh-tool-subagent——**自建委派工具的行为对齐范本**。

---

## 4. tkaiz0406/dsh-subagent-route-pin（MIT，内部名 delegation-hub）

> 「包装 provider 让被委派子代理走指定路由」。**三条缝齐全**：包装 provider、startActivation 猴补、运行中 failover。2153 行单文件，工程纪律（probe/readiness 证据文件、幂等、once-per-service）最完整。

### A. 控制缝

**缝①：包装 provider（`subagents.registerProvider`，index.js:645-1050）**

- 注册一个名为 `pinned-account` 的新 transport provider，内部 `base() = ctx.subagents.getProvider(config.baseProvider /* 'spawn' */)`（index.js:655-665）——**每次调用懒取**（本插件可能先于 spawn 注册）。
- `capabilities` **逐字复制 spawn**：`{agentOptions, outputSchema, depthLimit, toolFilter, persona}`（index.js:89-96）——包装 provider 必须透传底座能力声明。
- `start(request)`（index.js:992-1049）：`pickRoute(label)` → `agentOptions = {...request.agentOptions, provider, model, ...effort, ...maxTokens}` → `base.start({...request, agentOptions})`。
- 路由解析五层（index.js:767-831）：设置文件 `experts[label]`（exact/contains 两模式）> Agent-Teams 成员角色（label `agent-teams:<team>:<member>` → 读 `<cwd>/.agent-teams/<teamId>/team.json` 的 `members[].role` → `roles[role]`）> `#step` 后缀/step 名 → `steps[step]` > 配置行（volatile）> 设置文件 `default`。
- **活校验带缓存**（index.js:871-903）：`ctx.llm.listProviders()/listModels()`，成功缓存 10min、失败缓存 1min（catalog 读不了≠路由通过，不缓存成功——否则一次抖动把 strict 静默关闭 10 分钟）；问题默认告警降级，`strict:true` 才 fatal。
- 失败语义双开关：`fallback`（启动失败重试一次回调用方路由）× `onPinFailure: 'fail'(默认)|'inherit'`——「用户特意选的路由不能静默死掉」与「免费车道跑干要能降级」两个需求分开管（index.js:44-48 注释 + 1029-1048）。
- 台账：`last-run.json`（单槽覆盖）+ `events.jsonl`（append-only 事件流，树视图/证据锚读这个）。

**缝②：startActivation 猴补（TeamInjectionAdapter，index.js:1129-1551）**

- **为什么必须**（index.js:1105-1111 注释，★缝知识）：continuable 子代理（队友/团队成员）**不走 `provider.start`**——`SubagentRuntime.startActivation()` 见 provider 有 `prepareContinuable` 就派发 `SubagentManager.startLocal(spec)`，`startLocal` 自己读 `request.agentOptions`。**唯一注入点 = 在 `startActivation` 调用前填 `spec.request.agentOptions`**。
- 实现：`Object.defineProperty(service, seam, {value: hook, configurable:true, writable:true})` 猴补 `startActivation`/`startContinuable` 两缝（探测存在的才补）；**once-per-service**——重挂只换 slot 里的 `resolve/options` 不重复包；dispose 按 `hadOwn` 精确还原 raw（index.js:1396-1463,1532-1551）；能力旗标 `{teamInjection, enabled, seams, reason}` 挂 `Symbol.for('dsh-delegation-hub.team-hook')`——**「补错缝」从静默变成可读状态**。
- hook 体（index.js:1233-1393）：填 `request.agentOptions`（`overrideMemberRoute` 默认 true：Agent Teams 自己填的 `memberLlmProvider` 也被钉路由压过；关掉则尊重调用方）；换路由且未显式给 effort → `delete agentOptions.reasoningEffort`（旧档位是给旧路由标定的）；嵌套缝已带同路由→幂等跳过；启动失败按 `fallback/onPinFailure` 还原 original agentOptions 重试一次。

**缝③：运行中 failover（armFailover，index.js:1483-1530）**

- 启动成功后 `agents.get(childId)` 拿活 agent → **scoped** `agent.ctx.on('agent/request-error')`：`failure.code ∈ {QUOTA, RATE_LIMIT, AUTH, MISSING_CREDENTIAL, NO_ADAPTER}`（车道级故障，镜像 agent-teams 的 FALLBACK_FAILURE_CODES）→ **一次性**在该 agent ctx 装 `agent/request` 监听：后续请求改写到 `failoverRoute`（**剥离 reasoningEffort**）——WeakSet 保证 exactly-once；向队长信箱投递 JSONL 报告（复用 agent-teams 契约）。
- 边界自述（index.js:46-48）：**provider.start 缝只能看到启动期失败——子代理自己 LLM 流里后续抛的额度错误在这里抓不到**，所以才有缝③。

### B. 与原生机制的关系

不读不验 policy（无 allowlist 交集）；与官方行为对齐的点只有 effort 语义（换路丢档）。安全网是「活校验 + 显式失败语义」而非策略门。**mroute 若做改写，策略交集要自己补**（读法见插件 1/3）。

### C. 额度联动（★自动换道的唯一源码先例）

- 触发：`agent/request-error` 的 `failure.code` 五类车道码（启动后运行中）+ `base.start` reject（启动期）。
- 动作：一次性 `agent/request` 改写 provider/model 到 `failoverRoute{provider,model}.volatile()`（Config 热更）；全程写 events.jsonl（`outcome: 'pinned'|'failed'|'failover'`）。
- mroute 化用：把 `failoverRoute` 从「单一静态配置」升级为「按 mroute 余额排序选下一可用路由」——五类故障码就是余额枯竭的机读信号。

### D. 配置数据结构

Config（index.js:204-246）：`providerName`（新 provider 名）、`baseProvider`、`settingsPath/readinessPath`（外部 JSON 路径）、`strict/fallback/onPinFailure/autoWireAgency`、volatile：`teamInjection/overrideMemberRoute/failoverRoute{provider,model}/provider/model/reasoningEffort/maxTokens/stepsJson`。
**★坑位实录（index.js:234-237）**：steps 通道用 **JSON 字符串**承载——「schemastery 3.18.5 部分构建缺 `z.record/z.dict`，`z.any` 丢嵌套对象」→ 嵌套 map 进 Config 会被吃掉。**mroute 注册表的嵌套结构（capability 对象、manual 对象）必须做同版兼容验证或降级为 JSON 字符串字段**。
外部设置文件（normalizeSettings，index.js:394-443）：`{default: route, experts: {name: route}, roles: {role: route}, steps: {step: route}, match: 'exact'|'contains'}`，route=`{provider, model, reasoningEffort?, maxTokens?}`。

### E. 工具面

无 agent 工具（委派方只改 label/不传 agentOptions 即被钉路由）。UI：自有设置页 + 两条同源 WebRoute（`/delegation-hub/last-run`、`/delegation-hub/options`——浏览器无文件读权，WebRoute 是 host→页唯一通道）。

---

## 5. wufeng0105/dsh-teammate-model-picker（MIT）

> 「队友会话模型选择器：额度用完换有额度的模型继续跑」。分界清晰：**额度检测=人眼，换模执行=插件**。

### A. 控制缝

- **三条 scoped waterfall = 官方 `installModelSelection` 等价形状**（index.js:119-183；DESIGN.md:55 自证「它们是复制」）：
  1. `agentCtx.on('system-prompt/assemble')`：next() 后把选中路由写进 `assembled.variables.{provider, model}`（提示组装快照）；
  2. `agentCtx.on('agent/request')`：next() 后 **剥离继承的 reasoningEffort**、覆写 `provider/model`（+显式 effort）；
  3. `agentCtx.on('agent/pre-step', …, {prepend:true})`：追加**持久换模通告** user 消息 `[model changed: …]`，source=`{kind:'model-selection', form:'notice', summary}`（route.mjs:49-66，字段对齐 `createUserMessage` 官方形状）。
- **安装时机**：`ctx.on('agent/created')` + 启动时 `agents.list()` 全量扫（覆盖插件激活前已存在的队友）（index.js:188-196）；teammate 判定（teammate.mjs:14-19）：`header.origin==='subagent'` **且** sessionProjections 的 subagentIdentity `mode==='continuable'`（identity 缺失宁可拒绝不猜）。
- **每次 install 前先 `planInstall`**（install-plan.mjs:15-19）：noop/dispose/install 三态——「无 override ⇒ 零介入（I-1 不变量）」「全局默认模型永不被碰（I-2：无 saveSelection 调用）」。
- **不写 `startActivation` 参数、不包装 provider**：改的是**已存在队友会话**的后续请求。

### B. 与原生机制的关系

- **背景闸门**（README:16 + DESIGN.md:11）：队友路由在派发时被 `subagent/descriptor` 事件钉死，`coldResume` 只按 descriptor 重建 agentOptions；`session.selectModel` 对 subagent-owned 会话拒绝、Host 通用 Session 路由对 `origin:"subagent"` 一律 `session/agent-busy`、Client 官方选择器对 subagent 会话返回空——三层叠加把队友锁死。
- 本插件的自评（README:87）：**「本地绕过，不是官方正解」**——但技术上它复刻的是官方 `installModelSelection` 的瀑布形状、复用**既有** `model/selection` 事件类型（不引入新事件类型），语义上与官方会话内换模一致（活跃 turn 中下一 step 生效，不中断进行中请求）。
- **已知限制（README:77-83）**：不与子代理模型白名单求交集（「展示运行时目录全量，可能不一致」）——**mroute 做改写必须补 policy 交集**；agent 侧工具未接线（换模只有 UI 路径）。

### C. 额度联动（★「换模继续跑」闭环实录）

- **额度检测 = 人肉**：无任何余额 API。用户看到 `turn/end ERROR {"code":"QUOTA_EXCEEDED"}`（REPORT.md:40 真机实测序列）→ 打开队友会话 UI 选择器（`conversation.input.right` 座位注册，两级菜单模型/推理等级）→ 选有额度的模型。
- **换模执行链**：写 Config.overrides → `settings.write` 热更/重启 row → planInstall → 装/换三瀑布 → `session.append('model/selection', {provider, model, effort?})`（**复用既有事件类型**，让 modelSelection 投影在首个请求前就反映新路由，index.js:100-110）→ 下一次 `agent/request` 起新路由 → 验证序列：`request/header` 变 override → `turn/end completed`。
- **持久化**：写用户 profile patch 层 `- id: teammate-model-picker` 行，跨重启仍在（README:48）；「恢复派发路由」= 删 override → dispose 瀑布。
- mroute 化用：把「人眼看 QUOTA_EXCEEDED→手选模型」换成「mroute 余额层给出下一可用路由」→ 三瀑布安装代码可整段借鉴。

### D. 配置数据结构

`Config = {showPicker: boolean, overrides: {[sessionId]: {provider, model, reasoningEffort?}}}`——**按 sessionId 键控的覆盖表**（与插件 1 的 `selections` 同构，mroute 的每会话状态照这个形状放）。

### E. 工具面

无 agent 工具（明确列为待办）。Client：composer 右座 React 选择器（复制官方 CSS、类名前缀 `tmp_`、只用主题 token）。

---

## 6. 汇总：mroute 派遣选路推荐接缝

### 6.1 v1（M1 落地）：查询工具，不改写——五插件证据下的完整落地方案

**主缝**：`ctx.tools.register(defineTool({name:'model_route_query', …}))`——先例充分（插件 2 catalog 工具、宿主 `list_subagent_models`），W1§A/§D 判定不变。

**落地细节清单（每条注明源码出处）**：

1. **目录数据源与降级**：`ctx.llm.listProviders()` + 逐家 `listModels()`，单家失败降级该家不拖垮整体；同时返回 `current`（`exec.agent.options.provider/model`）——插件 2 catalog-runtime.mjs:4-33 逐行可抄。
2. **活校验带双 TTL 缓存**：命中缓存不外呼；成功 TTL（10min）＞失败 TTL（1min）；**catalog 读不到≠校验通过**（不得把「没查成」当「通过」缓存）——route-pin index.js:871-903。对齐 00§3.3 的 ≥60s 缓存与熔断设计，补充了「失败短缓存」细节。
3. **policy 交集前置过滤（M6 提前到查询层）**：两种等价读法任选——`sessionProjections.stateOf(agent.session, 'subagentModelSelectionPolicy')`（subagent-custom capabilities.mjs:92，Array=有清单）或 `settings.describe({redactSecrets:true})` 找 ns `subagent-model-selection-settings` 的 `descriptor.value.{enabled, allowedModels}`（director delegation-tool.js:151-168）。查询结果把 route 标注为 `named(清单内可命名)/allowlist(清单外)/child-default(未启用)` 四态——直接复用 subagent-custom `routeAdviceFor` 的输出形状，让模型在**派遣前**就知道哪条路由会过门，而不是撞了 `assertAllowedModelSelection` 再换（00§4 已列此目标）。
4. **输出措辞纪律**：路由条目以「用途描述」为主键、provider/model 为注脚，**不要把模型名放进模型最容易抓的句柄位**——插件 2 中性别名实验（0/2 vs 8/8）与 README:149-150 的「描述再准模型也可能按模型名脑补」教训；渲染行格式抄 `- alias: displayName (provider/model) {efforts: …*} — description`（catalog.mjs:24-28）。
5. **派遣可行性预检随查询返回**：`tools.get(toolName, agent)` 可见性 / `subagents.getProvider` / `resolveMaxDepth` vs `max(header.delegationDepth, options.subagentDepth)`——subagent-custom capabilities.mjs:34-99 整段可搬，查询结果直接告诉指挥官「当前会话能不能派、还能派几层」。
6. **余额/健康标注**：每条路由带 `health.state + 数据截至 + 人工登记标注`（00§3 已设计）；插件证据补一条——**本地实测额度信号**：`turn/end` 的 `QUOTA_EXCEEDED`（picker REPORT.md:40）可作 D 类渠道的旁路观测写入 health。
7. **降级语义写进工具返回**：无可用路由 → 明示「不填 provider/model，子代理继承父路由」（route-pin `pickRoute` 返回 undefined→inherit 的语义；director `layer:'inherit'`）——让模型的 fallback 行为与宿主缺省链（01§B-1）对齐。
8. **v1 红线不变**：不改写任何请求；`tools.guard()` 只做拒绝（欠费/禁用渠道给可读错误+替代建议，00 M6 原案）；插件不做任何 policy 权威（01§C-③）。

### 6.2 v2（可选）：`agent/request` 改写通道评估

**W1§C-② 说的是 `llm/stream`（全局低层、GenerateOptions 可变性未验证、高风险）——本批插件揭示的 `agent/request` 是另一条缝，且是官方自己用的**：picker 明证「`system-prompt/assemble` 快照 + `agent/request` 改写 + `agent/pre-step` notice 三条瀑布 = 官方 `installModelSelection` 的等价形状」（DESIGN.md:55）。语义要点全部有官方同构先例：活跃 turn 中下一 step 生效、换路剥离继承 effort、换模写持久通告、复用 `model/selection` 事件。

**两种安装形态，安全性天差地别**：

| 形态 | 实现 | 风险 | 判定 |
|---|---|---|---|
| 全局 waterfall + 深度门 | subagent-custom：`ctx.on('agent/request')` 挂在插件 ctx，`subagentDepth≥1` 才动 | 每个 agent ctx 都跑这段逻辑；改写**无条件压过调用方显式路由**（连策略门允许的命名路由也被覆写）= 事实上绕过策略门；**session-key 漂移 bug 实录**（写和查用不同 id → 改写静默不生效，subagent 仍在调用方模型上跑，index.mjs:576-581/666-674 大段注释记错与修复） | **不采纳** |
| **per-agent scoped 安装** | picker：override 表命中才 `agent.ctx.on(...)` 三瀑布；route-pin failover 同型 | 作用域最小、可 dispose、无 override 零介入（I-1）；官方同构 | **v2 若做，只采纳此形态** |

**v2 形态的必要护栏（全部来自插件失败实录）**：
1. **policy 交集必须自补**——请求层改写天然绕过 `assertAllowedModelSelection`（门只验派遣参数）；改写前先按 `subagentModelSelectionPolicy` 过滤候选路由（director 的「不在清单→丢弃→inherit」行为照抄）。
2. **override 键控纪律**：以 `agent.id`（picker）而非「root session 推导」（subagent-custom 的教训：root walk 依赖活注册表、时序可变）。
3. **effort 语义**：换路且路由未配 effort → 剥离继承 effort（三家一致：subagent-custom index.mjs:692、route-pin index.js:1301-1305、picker index.js:153）。
4. **幂等**：嵌套缝/重装不重复改写（route-pin `alreadyPinned` 判定 index.js:1290-1295；picker `planInstall` noop 态）。
5. **触发边界**：`provider.start`/`startActivation` 缝只见启动期失败；运行中额度枯竭要靠 `agent/request-error` 的 `failure.code`（route-pin 五类码）或 `turn/end` 错误码——mroute v2 的「余额枯竭自动换道」= 把 route-pin 的 `armFailover` 静态 `failoverRoute` 换成「mroute 排序表下一项」。
6. **continuable 例外**：若还想控制「派遣瞬间」的队友/团队成员路由，必须猴补 `ctx.subagents.startActivation`（once-per-service + probe 上报 `seams` + dispose 还原，route-pin 全套纪律）；provider 包装拦不住 continuable——这是接缝事实，不是实现选择。
7. **05§风险 5 部分解除但未全解**：`agent/request` 的改写已被官方路径证明可行（不同于 `llm/stream` 的未验证改写）；但「改写 vs `tools/pre-execute` guard 的时序」「与 retry/waterfall 链的交互」仍无逐行验证——v2 立项前须先做这两项实验。

**v2 触发条件建议**：仅当 v1 上线后出现「模型不查工具就派遣」「派遣撞 policy 门率高」「额度枯竭后子会话反复失败无人换模」三种实测症状之一，再按上述形态立项；默认停留在 v1。

### 6.3 注册表 schema 的插件证据修订（对 00§3.1 的实现层补充）

1. **校验分层**（director 模式）：schemastery 管逐字段形状（必填/非空白/kebab-case 键），**跨字段语义读时补**（悬空 fallbacks 引用、defaultRole 式悬空 → 查询时告警去重，不拒写）。
2. **嵌套结构版本兼容**（route-pin 实录）：`capability{}、manual{}、eval{}` 等嵌套对象在部分构建的 schemastery 下会被 `z.any` 丢弃——M1 定稿前对目标 DSH 版本做一次嵌套对象 Config 实测；不通过则该字段降级 JSON 字符串（如 `stepsJson` 形态）。
3. **每会话状态独立于静态注册表**：`selections/overrides` 型 sessionId 键控 map（subagent-custom/picker 同构）单列，不与渠道表混放；派遣台账 cap（20 条/会话）+去重防膨胀。
4. **双命名空间文档化**：注册表字段名避免裸 `provider`——用 `routeProvider`（LLM 路由）与 `transportProvider`（spawn/fork）分列，杜绝 director 指出的 R2 混淆。
5. **transport 能力透传**：若未来做包装 provider，`capabilities` 必须逐字透传底座（route-pin CAPABILITIES 实录），`agentPreset` 类功能需 `capabilities.agentPreset && !inheritsParentContext` 守卫（director/setup 同款守卫）。

### 6.4 复用分级表

| 级别 | 内容 | 出处 | LICENSE/合规 |
|---|---|---|---|
| **直接复用**（抄代码+署名） | ① 模型目录聚合（listProviders/listModels 逐家降级+current 路由） | setup `catalog-runtime.mjs`（33 行纯函数） | MIT，保留版权行 |
| | ② 路由活校验+双 TTL 缓存 | route-pin `checkRoute` index.js:871-903 | MIT |
| | ③ 三层路由解析纯函数（call>role>default>inherit+清单约束） | director `route-resolver.js`（155 行纯函数） | MIT |
| | ④ 路由行渲染格式与 catalog 输出 schema | setup `catalog.mjs:24-57`、`tools.mjs:57-113` | MIT |
| **改造借鉴**（借思想改实现） | ⑤ policy 交集四态标注（named/allowlist/child-default/fork） | subagent-custom `routeAdviceFor` | MIT |
| | ⑥ v2 三瀑布换模安装（scoped+planInstall+事件复用） | picker `index.js:100-196` + `route.mjs` | MIT |
| | ⑦ 运行中额度 failover（agent/request-error 五类码→一次性改写） | route-pin `armFailover` index.js:1483-1530 | MIT |
| | ⑧ startActivation 猴补纪律（once-per-service/probe/dispose） | route-pin `TeamInjectionAdapter` | MIT |
| | ⑨ schema 校验分层（形状入 schema、语义读时告警） | director `settings.js:111-169` | MIT |
| **仅参考**（不抄） | ⑩ Jev 外部分类服务（mroute 不引入外部 LLM 依赖） | subagent-custom `jev.mjs` 体系 | MIT |
| | ⑪ 自有 config.json 持久化（mroute 走 volatile Config，05§E 已判定） | setup `store.mjs` 体系 | MIT |
| | ⑫ probe/readiness 证据文件体系（mroute 用宿主 logger+面板即可） | route-pin probe*.json 系列 | MIT |
| | ⑬ 中性别名心理学（指导工具输出措辞，不抄代码） | setup README:90-107 | MIT |

---

## 7. 自检与证据索引

| 断言 | 证据 |
|---|---|
| `agent/request` 是官方 installModelSelection 同构改写缝 | picker DESIGN.md:55、index.js:112-118 注释、REPORT.md:40 实测序列 |
| continuable 不走 provider.start、startActivation 是唯一注入点 | route-pin index.js:1105-1111 注释 + 猴补实现 1396-1463 |
| 三家一致「换路剥 effort」 | subagent-custom index.mjs:692 / route-pin index.js:1301-1305 / picker index.js:153 |
| policy 读法两种（投影/设置命名空间） | subagent-custom capabilities.mjs:90-97 / director delegation-tool.js:151-168 |
| 额度机读信号 | picker REPORT.md:40（QUOTA_EXCEEDED）/ route-pin index.js:1102（五类码） |
| 中性别名实验数据 | setup README:90-107（0/2 vs 8/8） |
| schemastery 嵌套对象坑 | route-pin index.js:234-241（stepsJson 注释） |
| 五插件均为 MIT | 各仓库 LICENSE / package.json `"license":"MIT"`（plugin 1: Copyright Vitaliy Ryumshyn, ringoage；plugin 4: Copyright 沈思宏） |
