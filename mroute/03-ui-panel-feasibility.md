# DSH 设置面板接入机制调研：可视化模型注册表编辑器（交互 UI）可行性

- 树节点：mroute / mroute-W4-uipanel
- 调研时间：2026-11-13
- 证据源：`D:/DSHarness/resources/app.asar/dsh/`（DSH 0.2.2-rc.1，仅 read 工具可读）、`C:/Users/sir_c/.dsh/profiles/desktop/node_modules/`（profile 已装第三方包，pwsh/read 可读）、`plugin_manager list_plugins` 全量 244 行、`cordis_inspect_list`
- 交付物：本文档
- 与上游 01（`01-dsh-feasibility.md`）的关系：01-A/D 已给出「Client slot + React、webServer.register、configEditor volatile 热更」的基础结论；本文做**增量**——把「设置面板」这个具体表面拆开（壳/分区/导航/写链/存储/表单成本），并回答新需求「在设置面板里可视化编辑各级别模型、备用链、优先顺序」的逐点可行性。

> 方法注：本 build `cordis_inspect_query` 带 `input` 的 exact-query 依旧被拒（W1 结论，本文未再消耗调用复测）；client 侧 `Slots.listSubTree`/`Builtin.listBuiltins` 三次尝试均超时（GUI 页面的 inspect 通道未连接，提示 "Open or reconnect the Harness page, then retry"）。**本文全部结论由源码级证据承载**（宿主自己四个设置页包 + profile 里第三方包 dsh-orb 的运行时代码），证据强度不低于 inspect 实查。

---

## A. 设置面板结构与挂载机制（源码级）

### A.1 设置面板 = 一个 slot 体系，不是固定路由页

设置「页」不是一个 URL 路由，而是 Web GUI 里的一个**模态弹窗**，由一组 slot 组装而成：

| slot 名 | 角色 | 声明方 |
|---|---|---|
| `sidebar.settings` | 设置弹窗壳（single 占位，带 store handle + children 声明） | `dsh-client-ui-settings-general` |
| `settings.section` | **分区 list slot（导航项 + 页面体）——第三方插件的正规入口** | 由壳的 children 声明，人人可占 |
| `settings.launcher` / `settings.trigger` / `settings.header` / `settings.close` | 壳的周边部件（single） | general 自占 |
| `settings.action` | 设置头部动作区（list）——官方放「打开配置文档」按钮 | general 自占，他人可加 |
| `settings.onboarding` | 首启引导层（list，order 排序） | models 占了 3 个 |
| `settings.general.item` | General 分页内的条目（list）——第三方可往 General 页塞卡片 | general 的 general 分区 children |
| `settings.models.provider-card` / `settings.models.footer` | Models 分页内 keyed/list 子槽 | models 分区 children |
| `plugins.item` | **插件管理页**的每插件卡片（另一张设置表面） | subagent 设置页挂这里 |

**壳的实现**（`node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`）：
- `createSettingsShellStore()` L19-42：`{open, activeId}` + `actions.open/close/select/openSection(id)`——`openSection` 可**编程直达某分区**（打开弹窗并切到该页）。
- 导航列表直接从 slot 读：L1434-1440
  ```js
  rows = ctx.slots.entries("settings.section").map((e) => ({
    id: e.options.id ?? "", order: e.options.order ?? 0,
    label: resolveSlotLabel(e.options.label) ?? ""
  })).sort((a, b) => a.order - b.order);
  ```
- `sidebar.settings` 注册体 L1469-1562：children 声明上表 8 个 slot；同时注册快捷键 `settings.open`（Ctrl/Cmd+,）L1476-1521。
- general 自己占 `settings.section` 分区 `{id:"general", order:0, children:{"settings.general.item":{kind:"list"}}}` L1587-1597；`settings.action` 放 "open-document"（调 `remote.settings.openSettingsDocument` 原生打开 profile 配置文档）L1576-1582。

### A.2 宿主 Models 设置页如何挂载（先例，逐行）

`@deepseek-ai/dsh-client-ui-settings-models/lib/client.js` L5391-5481：

```js
const inject = ["slots","locale","remote","remote.credentials","remote.llm",
                "remote.settings","remote.session","configForms","settingsSchema"];
function apply(ctx) {
  // …locale 词典、store、invalidation 订阅…
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "models",
    order: 10,
    label: () => t("nav"),          // 导航项文案（走 locale）
    inject: injected,               // 给组件的 props 工厂（store/operations/schema/t）
    children: {                     // 该分区自己开放的子槽
      "settings.models.provider-card": { kind: "keyed", scope: "root" },
      "settings.models.footer":       { kind: "list",  scope: "root" }
    }
  }, ModelsSection));               // ModelsSection = React 组件
}
```

要点：**分区 = slot 占位（id/order/label/inject + React 组件）**；数据与操作不走 import，全走 cordis 服务注入（`configForms`、`settingsSchema`、`remote.*`）；React 来自宿主浏览器模块表（ui-plugin.md L9）。

### A.3 第三方能否注入设置面板——能，已有两例实证

1. **dsh-orb（`@deepseek-ai` 体系外的社区包，装于 profile）注册了 `orb` 分区**——`C:/Users/sir_c/.dsh/profiles/desktop/node_modules/dsh-orb/client.js` L3100-3169：
   ```js
   const SECTION_ID = 'orb'
   const inject = ['slots']
   ctx.slots.inject('settings.section', () => ctx.slots.register({
     name: 'settings.section', id: SECTION_ID, order: 25,
     label: () => copy().nav, inject: () => ({}),
   }, OrbSettingsSection))
   ```
   同文件 L3123-3160 还演示了**从悬浮球编程打开设置弹窗直达自己分区**：读 `ctx.slots.entries('sidebar.settings')` 拿壳的 store handle → `handle.create().actions.openSection('orb')`。最小注册面 = `inject:['slots']` 一个服务。
2. **dsh-client-ui-settings-subagent（官方，模式同构于第三方做法）挂在插件管理页**：`lib/client.js` L1016-1081——
   ```js
   ctx.effect(() => ctx.configForms.whileServed(["subagent","subagent-model-selection"], () =>
     ctx.slots.inject("plugins.item", () => ctx.slots.register({
       name:"plugins.item", id:"subagent", order:10, label:()=>t("subagentTitle"), …
     }, SubagentCard))), "ui-settings-subagent: page");
   ```
   `whileServed(namespaces, register)`（ui-settings base L1315-1334）= **宿主不再 serve 这些 namespace 时页面自动摘除**（「该插件当前未加载，暂时无法配置」文案 L18/L56 即此机制的 UX 面）。

**边界**：第三方可以①新增自己的分区（settings.section 占位）；②往已声明子槽的面板里加卡片（如 `settings.general.item`、`settings.models.provider-card`——后者是 keyed 槽，Models 页按 `entryKey=provider.settingsNs` 渲染，L2669-2673/L2744-2748）；③加设置头部动作（settings.action）。**不能**改动宿主分区的内部结构（除非宿主为该处声明了 child slot），也不能替换应用根（ui-plugin.md L13 禁令）。

---

## B. 插件交互面板三种形态对比

### B.0 先说共同底座：Client→Host 通道清单

| 通道 | 用途 | 证据 |
|---|---|---|
| `configForms`（ui-settings 基座服务）+ `settingsSchema` | 读：`describe()` 共享镜像（全宿主 settings 文档）；写：`form.mutate(ops, revision)` | ui-settings client.js L1080-1334 |
| `remote.settings` | `describe()/update()/replace()/mutate()/openSettingsDocument()`——secret 自动红acted | dsh-api-settings-controller L293-509 |
| `remote.credentials` | `describe(refs)/set/unset`——密钥**单向**过线（读永不回值） | 同上 L84-211 |
| `remote.llm` | `listProviders()/listConfigurableProviders()/discoverModels()` | dsh-llm/lib/typert.host.js L53-138 |
| `remote.session.modelCatalog()` | 模型目录（分组+失败列表），subagent 授权模型页用它 | ui-settings-subagent client.js L982 |
| `remote.$on("settings/document-updated" | "credentials/record-updated" | "llm/adapters-updated")` + `connection/reset` | 失效推送→镜像重读 | ui-settings client.js L1488-1498；models L5447-5464 |
| `webserver/index-inject` | Host→Client 页面引导数据（window global） | models lib/index.js L16-24（`__DSH_MODELS_ONBOARDING__`） |
| `webServer.register(route)` 自有 HTTP 路由 | 插件自有 API/跨窗口桥 | dsh-orb client.js L3184+（`request('/.dsh-orb/jump')` 轮询桥） |
| session command（`ctx.remote.commands.execute()`） | UI 按钮调 Host 业务操作的正道（user-actions.md L8） | user-actions.md |

### B.1 三形态

| 形态 | 先例 | 读写 Host 数据方式 | 适用/局限 |
|---|---|---|---|
| ① **Client slot + React 组件**（设置分区/面板） | 宿主全部设置页 + dsh-orb orb 分区 | **configForms.mutate / remote.* / locale / theme 全在进程内**，与宿主设置页同一套数据层 | **推荐**。与设置面板视觉一致（theme token、locale、focus/Escape 行为都能对齐）；写链自带 revision 冲突处理 |
| ② **iframe 自有页面**（meta-adapter 形态） | meta-adapter-ui（inspect provider 自述 iframe src/overlay） | iframe 内 `fetch` 打自有 webServer 路由；Host 数据要自建 HTTP API 层 | practices.md L33 明文反对："**Do not serve an HTML page from the Host and embed it in an iframe: an iframe document does not receive the host's theme tokens, light/dark switching, or ctx.locale**"——只适合 canvas/重交互等确实需要隔离渲染面的场景 |
| ③ **webServer.register 自有路由页** | dsh-orb 的 `/.dsh-orb/*` 路由（但其 UI 仍是 client 半边组件，HTTP 只作跨窗口桥） | 独立 HTML 页同 ② 弊端；作为**给外部工具/脚本的 API 面**则正合适（01-E 已证） | 不推荐做设置 UI；推荐做数据 API |

**数据流（形态①，以一次保存为例）**：

```
React 组件(草稿 state) 
  → ctx.configForms.get(<ns>).mutate([{op:"set",path:[…],value},…], draftRevision)   // ui-settings base, 串行队列
    → ctx.remote.settings.mutate(ns, ops, expectedRevision)                          // typert 远端
      → SettingsController.write → ctx.settings.mutate/update                        // dsh-settings
        → settings.write(): 校验 volatile 路径 → configEditor.edit(entry, fn)        // 落 profile patch（持久）
          → 冲突检查(descriptor.revision !== expected → SETTINGS_CONFLICT)           // 乐观锁
        → describe() 重算 → emit "settings/document-updated"                         // 全客户端广播
      ← 返回该 namespace 新视图（红acted）→ mirror.acceptView 折回 → 组件重渲染
```

失败分类（settings-controller L488-509）：陈旧写 = `settings/conflict`（带 expected/actual，客户端应重读重试，非错误）；其他拒绝 = `settings/rejected`（消息逐字透传给页面——两页的 conflict 文案实证：「Settings changed elsewhere. Discard your draft and try again.」）。

---

## C. 「编辑注册表 → 持久化」链路

### C.1 存哪：两条正规路径，推荐第一条

1. **插件自有 Config（`export const Config = z.object({...})`）——推荐**。
   - settings 服务只暴露 **volatile 字段**：`describe()` 里 `volatileForm(schema)` 为空的条目**根本不出现**在设置文档（dsh-settings L417-419）；写面 `write()` 逐路径校验 `isVolatilePath`，非 volatile 路径直接抛 `"Config field \"x\" is not volatile"`（L505-507）。
   - **volatile ≠ 不持久**：写仍经 `configEditor.edit(entry, fn)` 落到 profile patch 文档（`documentPath` = configEditor 的 patch，L400-408/508）；"volatile" 语义是**运行中热更**（schemastery 的 `createVolatile/[write]` 引用协议，ui-settings client.js L33-69）+ **重启动后从 profile 读回**。普通（非 volatile）字段则要插件重载后才生效。
   - 校验时机三层：① 激活时 row config 过 Config schema（host-plugin.md L64，01-A 已引）；② 客户端提交前 `settingsSchema.validate(schema, draft)`（ui-settings L942-949；subagent 页「Select at least one model before saving」即客户端规则）；③ 宿主写面校验 JSON 形状（`cloneJsonShaped` 拒绝非 JSON/环/非有限数，L237-273）+ volatile 路径 + revision；值级 schema 错误最终在 Loader 配置解析/重激活时暴露为 `settings/rejected`。
   - 并发编辑：每 namespace 单调 revision（`describe()` 按 raw 变化递增，L427-435）+ 客户端每 namespace 串行写队列 + 失败自动 `recover()` 重读（ConfigFormController L1080-1207）。
2. **插件自有存储（storage 服务）**——practices.md L21："keep plugin-owned data in a storage service found through inspection"（本 profile 已装 `include:storage`/`storage-json`/`storage-domain`）。适合大注册表/带历史版本的数据；但**要自己做 UI 读写通道**（settings 面板不含它），通常退化为「Config 存规则、storage 存运行统计」的混合。

**密钥绝不进注册表 Config**：走 `ctx.credentials` / `remote.credentials.set`（单向过线 + `role('secret')` 字段在 settings 读面自动剥离并只报 set/unset 侧牌，dsh-settings L9-89 + settings-controller L393-399）。这是官方 Models 页「密钥卡」的做法。

### C.2 宿主已把「provider 目录」合同化：`settingsNs + settingsPath`

`dsh-llm/lib/typert.host.js` L24-37（`llm/listConfigurableProviders` 结果 schema，逐字）：

> `settingsNs`: "User-settings namespace whose section configures this provider."
> `settingsPath`: "Path from that namespace's section root to this provider's profile object; empty when the whole section is the profile."

即：**每个可配置 provider 的配置存放位置由 adapter 自述（哪个 settings namespace 的哪条路径）**，Models 页据此寻址编辑（`ProviderEditor` 接 `namespace`+`settingsPath`，models client.js L2834-2852；自定义 API provider 卡用 `piAi.revision` 走 llm-pi-ai 的 namespace，L2860-2879）。`llm/discoverModels(settingsNs, request)`（L56-106）= Models 页「获取可用模型」的后端，按 settingsNs 找 `registerModelDiscovery` 注册的探测器（typert.host.js L186-190 JSDoc："Offer to interrogate provider endpoints on behalf of the settings namespace this plugin owns"）。

**对本需求的含义**：我们的「各级别模型/备用链/优先顺序」注册表如果做成**自己插件的一块 volatile Config**，就自动获得：设置面板可寻址（namespace=我们的 entry id）、热更、持久、冲突保护、失效广播——与宿主 provider 注册表同一机制层级，不需要碰 dsh-llm 内部。

### C.3 普通（非 volatile）配置的 UI 编辑

settings 面板**够不着**（volatile-only）。若确需在 UI 改非 volatile 字段，正规通道是 user-actions.md 的「一个操作、两个调用方」：Host 服务方法做实现 → UI 走 session command（`ctx.remote.commands.execute()`）→ agent 侧同名 Tool 镜像；方法内用 `ctx.get('configEditor').edit(entry, fn)` 改任意字段（普通字段重启插件生效，01-A/C 已证）。我们的场景（tier/fallback/priority 全 volatile 化）用不到这条，但「测试这条备用链通不通」类**操作**应走此模式。

---

## D. 表单控件成本

### D.1 「Config schema 自动生成设置表单」——数据层白拿，渲染层不白拿

- **白拿的部分**：Config 声明后，设置文档自动出现该 namespace（volatile 字段非空时）：序列化 schemastery schema + base/user 值 + revision + secret 侧牌全部送到客户端（settings describe，L441-451）；客户端 `settingsSchema.rehydrate/validate/nodeAtPath/getPath/setPath/deletePath`（ui-settings L923-1028）给足了 schema 驱动编辑的**数据设施**。
- **不白拿的部分**：宿主没有任何「给一份 schema 就渲染通用表单」的产品页——ui-settings-general 是 General 分区+壳，ui-settings-plugin-inventory 是只读 Loader 清单（package.json L3："Read-only Cordis Loader inventory tab"）；Models/Subagent 页全部是**手写 React + CSS Modules + theme token**。schemastery 本身带 `role()`/`pattern()`/`collapse` 等表单元数据（client.js L397-499），自建通用渲染器可行，但那是自己写一个表单引擎，不是白拿。
- 结论（成本量化）：我们的编辑器只管三类控件——**有序列表（tier/优先级，拖拽或上下移）+ 下拉选择（provider/model，数据源 `remote.llm`/`remote.session.modelCatalog`）+ 增删行（fallback 链）**。参照 subagent 授权模型清单页（同构：目录加载+多选+保存+冲突）约 1100 行 client.js（含 8 语种词典约一半）；我们的更简单，估计 **400-700 行 React + 词典**。拖拽排序不必自研键盘外的复杂度——宿主文案明说「拖拽或上下箭头键」（models L3860 reorderModelHelp），用上下移按钮即可起步。

### D.2 「禁 import 宿主 UI 包」约束的准确出处与含义

- practices.md L35（原文）："**Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module**; … Write your own controls and match the host instead: copy markup, CSS, and behavior from the primitive … Rename copied classes under your plugin's prefix, keep only `--dsw-alias-*` token references…"
- 机制根源（ui-settings base L1245-1250 注释，逐字）："**the client bundle purity gate forbids cross-plugin value imports and directs cross-plugin collaboration through cordis services** (`packages/client/tsdown.client.ts`)"——跨插件**值导入**被构建门禁禁止；协作一律走 cordis 服务注入（`inject: ["configForms","settingsSchema",…]`）。`dsh.client.inject` 只声明**激活顺序**，不等于可 import。
- 实操含义：Modal/switch/input 等控件**照抄宿主 primitives 的 markup+CSS 行为**（源码 checkout `src/*.tsx` 或已装包 `lib/index.js` 可读可抄），类名改前缀，颜色只用 `--dsw-alias-*` token（`Theme.listTokens` 列表）；宿主 models 页自身就是可抄范本（同一个仓库编译产物，类名→CSS 变量全在）。

---

## E. 结论

### E.1 逐点判定

| 判定项 | 结论 | 关键证据 |
|---|---|---|
| 第三方插件在设置面板挂自己的分区（子页） | **可行，一等公民机制** | dsh-orb `settings.section` 注册（order:25）运行中实证；导航=slot 占位排序（general L1434-1440）；最小面 `inject:['slots']` |
| 第三方往现有分区注卡/注头部动作 | 可行（限宿主声明过的子槽） | `settings.general.item`（general L1593-1596）、`settings.action`（L1539-1542）、`settings.models.provider-card` keyed（models L2669-2673） |
| UI 手工编辑「各级别模型/备用链/优先顺序」并持久化 | **可行**（自有注册表 = 自有插件 volatile Config） | settings 写链 volatile-only 但持久（profile patch）+ 热更（B.0/C.1）；同构先例 = subagent 授权模型清单页（多选+保存+冲突+热更） |
| 可视化编辑**宿主现有** provider/model 注册表 | 可行但有界：只能动各 adapter 通过 settingsNs/settingsPath 暴露的 volatile 面；非 volatile 字段仍在 cordis.patch.yml（页面文案自认：「其他字段在 cordis.patch.yml，直接编辑该节」） | llm typert L24-37；models locale advancedHint |
| 自定义 API provider（中转/自建网关） | 官方 UI **已有**（Models 页 addCustom：baseUrl+协议 OpenAI Completions/Responses/Anthropic Messages+模型目录抓取） | models locale L3753-3760 + `llm/discoverModels` |
| iframe/独立 HTML 页做该编辑器 | **不推荐**（theme/locale 全丢，practices.md L33 明文） | practices.md L33；meta-adapter 先例仅适合 canvas 类 |
| 「白拿」schema 表单 | 数据层白拿、渲染层自写（估计 400-700 行） | C.1/D.1 |

### E.2 推荐形态（改动最小/维护最稳）

**形态①：一个 bundle（Host 半边 + Client 半边）注册 `settings.section` 分区（如 id:"model-route", order 落在 models=10 与 orb=25 之间取 15-20），React 手写编辑器 + 自有 volatile Config 承载注册表。**

- **不改宿主任何文件**：纯增量 bundle（patch 一行 insert + package.json `dsh.client` 节），升级不冲突（dsh-orb 同款安装形态已验证）。
- 数据层零自研：`configForms`/`settingsSchema` 注入即得 describe 镜像、revision 冲突、失效广播；provider/model 候选列表直接读 `remote.llm.listConfigurableProviders()`/`remote.session.modelCatalog()`（与官方页同源，无重复维护）。
- 与 01 的推荐组合严丝合缝：01 推荐的 ③「Config 承载优先级/备选链」在这里升级为「**volatile** Config 承载」——同一个 Config，从「改 yml 重启」升级为「设置面板热改」；①查询工具与 ②systemPrompt 提示照旧。
- 编辑保存链路图（最终推荐链）：

```
设置面板「模型路由」分区 (React, settings.section 占位)
  │ 读: configForms.describe() 镜像(本 ns) + remote.llm 目录 + remote.session.modelCatalog
  ▼
草稿校验: settingsSchema.validate(schema, draft)            // 客户端第一道
  ▼
configForms.get(ns).mutate(ops, draftRevision)              // 串行队列
  ▼
remote.settings.mutate → ctx.settings.write
  │ volatile 路径校验 → revision 冲突检查(SETTINGS_CONFLICT→settings/conflict)
  ▼
configEditor.edit(entry, fn) → profile patch(cordis 用户层)  // 持久化，重启仍在
  ▼
volatile 引用热更([write] 协议) → emit settings/document-updated
  ▼
(同屏其他页/其他客户端) 镜像重读；派遣工具 model_route_query 立即读到新注册表
密钥路径: 编辑器只显示侧牌(set/unset) → remote.credentials.set/unset   // 值不过读线
```

### E.3 风险与工程注意

1. **volatile 约束是硬的**：注册表 schema 里每个可 UI 编辑字段必须 `.volatile()`，且不能有「volatile 字段套在 volatile 父级里」（schemastery `validateVolatileSchema` 报 "volatile fields require a fixed object path"，ui-settings client.js L502-513）——即注册表应为**对象根下固定的命名字段**（如 `tiers`/`fallbacks`/`priority` 各自 volatile），不要把整个注册表做成一个 volatile 的 dict（dict 内键是动态路径，不可 volatile）。
2. 数组字段整体替换语义（`mergeLayers`：对象递归合并、数组整替，dsh-settings L281-291）——拖拽排序返回整条新数组即可，unset 数组下标=删除元素（`mutate` L488-500），正好匹配列表编辑。
3. 版本兼容：settings 文档对未知字段宽容（object resolver merge 未知键，schemastery L779-788），但 schema 演进仍建议只增不改语义（01 已有同类结论）。
4. 管理面 vs 设置面：若还想要「插件管理页」卡片（像 subagent 那样），同 bundle 再占 `plugins.item` 即可，零额外机制。

## 遗留不确定点（诚实声明）

1. client 侧 `Slots.listSubTree`/`Builtin.listBuiltins` 三次超时（GUI 页面 inspect 通道未连接）——slot 树实查未做，但 A 节源码已逐行给出 slot 名与占位形状，不影响结论。
2. Models 页 catalog provider 的 settingsNs 具体粒度（每目录 provider 一个 entry，还是共用 pi-ai 单 entry 多 settingsPath）未逐行验证——llm 目录合同（settingsNs+settingsPath 由 adapter 自述）已证，粒度是 adapter 实现细节，不影响本插件「自有 namespace」方案。
3. locale 只注册 zh/en 两个词典是否被 locale 服务接受（宿主页面惯例 8 语种）未验证；保守做法跟随惯例注册 8 语种（models/subagent 均如此，词典为机械翻译成本）。
4. 第三方插件自建 typert Remote namespace（像 api-settings-controller 那样）未查证先例（api-* 全是官方包）；UI→Host 自定义操作按 user-actions.md 走 session command 路径即可，不依赖此。
