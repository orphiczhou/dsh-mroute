# 05-m3-devlog.md — mroute M3 增量开发实现记录（设置面板编辑：可视化模型注册表编辑器）

- 执行者：m3-dev（lead 派发，任务书 `docs/briefs/m3-dev.md`）
- 日期：2026-11-15
- 基线：`plugin-mroute/` M2 收口版 **0.3.0-m2.0** → 本增量 **0.4.0-m3.0**
- 方案正源：`mroute/03-ui-panel-feasibility.md`（形态① + E.2 保存链路图 + E.3 工程注意 4 条）
- 红线基线：AGENTS.md §4 mroute 方向红线（advisory-only）+ 任务书 §5 六条；不 install_bundle 不重启 DSH（lead 亲自做）

---

## 0. 与 03 方案对照（采用 / 偏离逐条）

| 03 方案要点 | M3 落码 | 判定 |
|---|---|---|
| 形态①：一个 bundle 增 Client 半，注册 `settings.section` 分区 | client.js + package.json `dsh.client`（platform:web + inject `@deepseek-ai/dsh-client-ui-settings`）+ `./client` export | **采用** |
| 分区 id:"model-route"，order 落 models=10 与 orb=25 之间 | `SECTION_ID='model-route'`、`ORDER=18`（client.js:24-26） | **采用**（任务书 §3.1 取 15-20 区间内） |
| 最小注入面 `inject:['slots']`（client 侧） | `exports.inject = ['slots','remote','remote.settings','remote.credentials']`（client.js:563） | 扩展（需 remote 读镜像/写 + 订阅广播；slots 仍是最小挂载面） |
| 读 `configForms.describe()` 镜像 → `settingsSchema.validate` → `configForms.get(ns).mutate(ops, draftRevision)` | 改用 `remote.settings.describe()` + 自写轻校验 + `remote.settings.mutate(NS, ops, revision)` | **偏离（lead 已批准）**，见 §2.1 |
| 密钥侧牌经 `remote.credentials.describe` | 不实现（mroute 注册表无凭据字段，channel 无 keyRef 可侧牌） | **偏离（红线守正）**，见 §2.3 |
| provider/model 候选列表读 `remote.llm`/`remote.session.modelCatalog` | 不实现（`models`/`fallbacks` 为自写列表编辑，每行一项；id/routeProvider 只读） | 裁剪为后续里程碑，见 §2.4 |
| 渠道卡片可编辑字段（status/quota_total/quota_used_est/note/quota_platform/verified/priority/tier/channel_type/fallbacks/models；id/routeProvider 只读） | 全部按清单实现（client.js ChannelCard） | **采用** |
| 顶层参数（low_balance_threshold_cny / quota_cache_ttl_seconds / enforce_gate 开关+警示） | 实现（client.js ModelRouteSection top-level card） | **采用** |
| 保存链路图（E.2）：describe→validate→mutate→冲突重拉→热更 | 照此实现（remote.settings 层） | **采用**（底层服务替换，链路语义不变） |
| volatile 硬约束 E.3.1：channels[] 数组整体 volatile 合法 | spike 源码级复核通过（§4），主实现走数组整替 | **采用** |
| E.3.2 数组整替语义（mergeLayers 数组整替 + unset 下标删除） | 保存走 `set ['channels'] 整表`（数组整替）；未用下标 unset | **采用**（整替最简） |
| 降级容错（settings 服务缺席不注册） | client.js apply() 首行守卫 `!remote.settings.describe` 直接 return | **采用** |

## 1. 增量清单落点对照（任务书 §4）

### 1.1 A. Client 半（client.js，新，~673 行含 locale+style）

| 清单项 | 落点 |
|---|---|
| `window.__ModuleLoader__.load({id:'@local/dsh-plugin-mroute'})` 客户端模块 | client.js:1、:562（id=包名，仿 ui-plugin.md 模板 + dsh-orb client-settings 真机先例） |
| `dsh.client` manifest（platform:web + inject） | package.json `dsh.client`（inject `@deepseek-ai/dsh-client-ui-settings`，仿 dsh-orb client-settings package.json:26-33） |
| settings.section 注册（name/id/order/label/inject props 工厂 + React 组件） | client.js apply() L565-578（`inject: () => ({settings, remote})` 组件 props 工厂，仿 03 A.2 models 页 `inject: injected`） |
| 渠道卡片（ChannelCard） | client.js L326-379：id/routeProvider 只读展示；status/channel_type/tier 下拉闭集、priority 数字、quota_platform/quota_total/quota_used_est/note 文本、models/fallbacks 列表（每行一项）、quota_account_verified 开关+依据提示 |
| 顶层参数卡 | client.js ModelRouteSection L519-542：threshold/ttl 数字 + enforce_gate 开关 + advisory 警示文案 |
| 保存（validate→mutate→成功/冲突提示） | client.js onSave L455-487：`validateChannel`+`validateTopLevel` 客户端第一道 → `buildSaveOps` → `remote.settings.mutate(NS, ops, revision)`；成功 setForm(setRevision) + 「已生效」提示；冲突 `isConflictError` → 重拉镜像 + 「已刷新未覆盖」提示 |
| verified 依据提示 | client.js `verifiedHintKey` L268-275 + locale 五条（zai=包月≠API 账户 / opencode=待核实 / deepseek=单一源 / xiaomi=id 对齐+实测 / generic） |
| 样式 theme tokens only | client.js style 段 L557-670：`--dsw-alias-button-info-fill`/`--dsw-alias-label-primary-inverted`/`--dsw-alias-state-error-primary`/`--dsw-alias-state-success-primary`/`--dsw-static-neutral-bluish-00`/`--dsw-alias-settings-*`；类名 `mroute-` 前缀；无 `require('@deepseek-ai/dsh-client-ui-primitives')` 或任何宿主 client UI 包 |
| 降级容错 | client.js apply() L566-567：`!remote.settings.describe` → return（不注册不报错） |

### 1.2 B. Host 半

- **零改动**：index.js / lib/ 全不动（数据层 M2 已完备）。cordis.patch.yml 零改动（既有 `id:mroute, name:'@local/dsh-plugin-mroute'` 一行即 client 半的 host row；dsh.client 由 package.json 声明，无需 patch 增量）。

### 1.3 C. 文档与自检

| 清单项 | 落点 |
|---|---|
| docs/05-m3-devlog.md（本文） | 对照 03 / spike / 坑 / 自检 / 六问逐条 |
| selfcheck 增量 | `selfcheck/client.test.mjs`（新，6 断言组；vm 沙箱仿 dsh-orb section.test.mjs） |
| node --check 全过 | package.json scripts.check 增 client.js |
| README/NOTICE 增量 | README §功能/§自检/§红线/§已知限制 + NOTICE 增 orb 借鉴行 |
| AGENTS.md §7 一行状态 | 「M3 已交付待 lead 实测」 |

## 2. 关键设计裁决与偏离

1. **configForms/settingsSchema → remote.settings/remote.credentials 直连（lead 批准）**：03 B.0 的 configForms 是 client 侧对 remote.settings 的薄封装（串行队列 + 共享镜像 + recover）；其精确 client API 在本 build **仅 minified 单行**存在（`dsh-client-ui-settings/lib/client.js` 2 行压缩）、`.d.ts` 被 asar 剔除、无法按 03 行号核对。改用其底层 `remote.settings`（typert Remote 直连官方 `SettingsController`），host 侧契约已逐行核实：`describe()`→`{namespaces:[{ns,schema,value,revision,...}]}`、`mutate(ns,ops,expectedRevision)`、`replace`、`openSettingsDocument`（dsh-api-settings-controller lib/index.js L394-476）；`SETTINGS_CONFLICT` → `RemoteError("settings/conflict", {expected,actual})`（L489-509）。03「遗留不确定点 4」本就预告「api-* 全官方包、自定义 Remote namespace 未查证先例」，此处正是走官方 Remote 面，风险更低。
2. **客户端轻校验（lead 补充要求 a）**：`validateChannel`（id/routeProvider 非空、channel_type/tier/manual.status 闭集、priority 0-100 整数、models/fallbacks 字符串数组非空项）+ `validateTopLevel`（threshold 非负、ttl 5-3600 整数）。脏数据在 mutate 前拦截（client.test 「blocks dirty drafts」断言 mutateCalls.length=0），不触达 host 的 schemastery 拒绝。
3. **revision 闭环（lead 补充要求 b）**：revision 来自 describe 镜像（`nsView.revision`），mutate 携带；成功后以响应的 `revision` 续接力；冲突经 `isConflictError`（code/name 双判）→ `load()` 重拉镜像覆盖本地草稿 + 提示「未覆盖他人修改」。
4. **key 侧牌不实现（红线守正）**：mroute 注册表 channel schema 无凭据字段（红线：mroute 不读不存密钥），无 keyRef 可侧牌。不臆造 channel→credential 映射（那会把 DSH 模型提供商的密钥面错误接进建议面板）。密钥仍走 DSH 模型提供商设置页。任务书 §4.A.2 该条为 P1 加分，缺省不实现并在面板文案明确「本面板只编辑注册表参数，不接触密钥」。
5. **locale 落地（§6 Q5）**：manifest `locale/zh.json`+`en.json` 只承载 `meta.title/description`（Plugin Manager 显示）；设置分区 UI 文案自包含 client.js 内 zh/en 词典 + `<html lang>` 探测 + MutationObserver 热切换（仿 dsh-orb client-settings，无 locale 服务注册依赖）。**8 语种机械翻译不做**：宿主页面惯例 8 语种，但第三方分区 zh/en 即覆盖目标用户（dsh-orb 亦 zh/en 两词典），8 语种留待需要时机械补齐。client.test 断言 zh/en 键集一致。
6. **不新增/删除渠道**：任务书清单未列「增删渠道」，且 id 只读（改 id 会破坏 fallbacks 引用）。种子渠道由 config-schema.js SEED_CHANNELS 承载，M3 只编辑既有渠道可编辑字段。新增/删除渠道（含 id 输入 + 悬空 fallback 校验）属后续里程碑。
7. **provider/model 目录候选不接**：`models`/`fallbacks` 用自写「每行一项」列表编辑（数组整替），不读 `remote.llm`/`remote.session.modelCatalog`。理由：mroute 渠道的 `routeProvider` 是路由提供者 id（非宿主可配置 provider 目录），目录候选是 03 E.2 的「可选增强」非 M3 必做；接入目录需额外注入 remote.llm/remote.session 且引入宿主 provider 目录的形状耦合，裁剪留后。

## 3. 自检结果（留档）

- `npm.cmd run check`：**14/14 通过**（index + client + lib 13 文件；PATH 全局 node v24.20.0，2026-11-15 实跑）。
- `npm.cmd run selfcheck`（node --test 五套件）：**58/58 全绿**（含新增 client.test 6 组；duration ≈1.43s）：
  - source/cache/view/degrade 四套件 **52/52**（M2 基线不变，回归通过）。
  - client.test.mjs **6 组**：注册形状（spec.id=model-route/order=18/name=settings.section/label zh=en 切换）+ locale 键集一致；镜像渲染（两渠道卡 + 顶层参数 + zai/deepseek 依据提示 + 状态下拉三值）；保存 ops 构造（channels 整表 2 条全量回写 + status 变更 + 未编辑字段原样保留 + 空 capability 省略 + enforce_gate true + revision=3 来自镜像）；脏数据拦截（priority=999 → mutateCalls=0 + 错误可见）；冲突重拉（describe 二次 + 冲突提示）；降级（无 remote 不注册）。
- 调试期修复 3 处：client.js JSDoc 注释内 `reviewed_*/eval` 的 `*/` 提前闭合块注释（改措辞规避）；fieldset 顶层参数卡少一个闭括号（语法错）；client.test 跨 realm deepStrictEqual 失败（node:vm 对象与测试 realm 原型不同 → mutate 调用 JSON 往返归一化再断言）。

## 4. spike 结论（§6 Q1，源码级，未浏览器实测）

**channels[] volatile 数组经 settings 写链可用，无需拆分承载形态，主实现走数组整替。** 证据链（`D:/DSHarness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js` 运行时源码）：

1. `volatileForm(schema)` L122-131：channels 数组整体 volatile → `plainSchema(channelsSchema)` 把全量嵌套 schema 带进 settings 文档；`describe()` L413-464 经 `plainConfig`（L97-102，`isVolatile` 走 `.get()`）读回**完整数组**。
2. `isVolatilePath(schema, path)` L153-158：`if (schema.meta.volatile) return true` —— channels 节点 volatile → `['channels']` 及任意子路径 `['channels',i,'manual','note']` 全判 volatile（父级 volatile 即整棵子树合法；与 AGENTS §4 Day1 实测「数组整体 volatile 合法且 .get() 读回完整」互证）。
3. `applyPathOp` L189-216：对象路径递归 set；数组下标 set 替换 / `unset` splice 删除 / `set [length]` 追加；越界抛 TypeError。
4. `mutate` L488-500：ops 逐条 reduce → `write(ns, change, expectedRevision, ops.map(op=>op.path))`；`write` L501-537：逐 path `isVolatilePath` 校验（L507）→ `configEditor.edit` 内 revision 冲突检查（L511，`SettingsConflictError`）→ `cloneJsonShaped` + `validatePaths` + `strip` → `mergeLayers` 落 profile patch（持久）→ `describe()` 重算 → `emit("settings/document-updated", ns, revision)`（L435）。
5. 热更：`readRegistry` 每次工具调用 `readVolatile(config.channels)` 重读（lib/registry.js:46 + lib/volatile.js）；M2 已实证 volatile 热更生效（deepseek×2 verified 种子改动 `model_route_query` 立即读到，05-m2-devlog §验收微调）。

**保存形态**：`remote.settings.mutate('mroute', [{op:'set',path:['channels'],value:整表},{op:'set',path:['low_balance_threshold_cny'],...},{op:'set',path:['quota_cache_ttl_seconds'],...},{op:'set',path:['enforce_gate'],...}], revision)` —— 数组整替 + 三顶层参，不触碰 registry_version/reviewed 锚/eval 占位。

## 5. 红线自查（2026-11-15）

| 红线 | 检查 | 结果 |
|---|---|---|
| advisory-only 零阻断 | client.js 无 tools.guard/llm/stream/agent.request；enforce_gate 开关旁常驻警示文案（默认关语义，client.js enforceGateWarning） | ✓ |
| 密钥值不过读线 | client.js 无 credentials 值读取；remote.credentials 注入但未调用；channel 无 keyRef 侧牌（不臆造映射） | ✓ |
| theme tokens only + 禁 import 宿主 UI 包 | client.js 仅 `require('react')`（浏览器模块表）；style 只用 `--dsw-*` token；类名 mroute- 前缀 | ✓ |
| 宿主文件零改动（纯增量 bundle） | 仅写 plugin-mroute/ 内 client.js + package.json + locale + selfcheck + 文档；cordis.patch.yml 未改 | ✓ |
| 上游 mroute/00-07d 不回改 | 本会话未写 mroute/ 目录（只读 03） | ✓ |
| 不 install_bundle / 不重启 DSH | 未调用 plugin_manager | ✓ |

## 6. 未自动化清单 + lead 浏览器实测步骤

**未自动化（如实声明，勿当已验）**：
1. 真实浏览器挂载（settings 面板出现「模型路由」分区、order=18 落位、nav 文案、theme 亮暗）。
2. 真机保存链（改一个 manual.note → mutate 全链 → model_route_query 立即读到新值）。
3. 真机持久化（保存后**重启 DSH** → 值仍在 profile patch）。
4. SETTINGS_CONFLICT 真机触发（双客户端/原生配置文档并发）与冲突文案。
5. locale 8 语种缺失是否在非 zh/en 环境回退 en（预期：`copy()` 非 zh → en）。

**lead 实测步骤清单（收口用）**：
1. link 重装 plugin-mroute（remove+install 两轮，lead 亲测路径）→ 打开 DSH 设置 → 确认「模型路由」分区出现（models 与 orb 之间）。
2. 分区内改 zai-coding-cn 的 `manual.note`（如加「实测」）→ 点保存 → 见「已生效」→ 新会话调 `model_route_query` → 确认该渠道 note 含「实测」。
3. 改 `low_balance_threshold_cny` 为 100 → 保存 → `model_route_query` 中 manual 余额 <100 的渠道出现 low_balance warning（阈值生效）。
4. 重启 DSH → 分区内改过的 note/阈值仍在（持久化）。
5. （可选）开两个 DSH 窗口同分区编辑同渠道 → 后保存方见冲突提示且不覆盖先保存方。

## 7. 任务书 §6 问题清单逐条回答

### Q1 spike：channels[] volatile 数组经 settings 写链真机行为？
**应答：源码级证实可用，走数组整替，无需拆分**（见 §4 五点证据链）。真机行为（热更/持久化/重启仍在）由 lead 浏览器实测收口（§6 步骤清单 2-4），本会话未浏览器实测（如实标注）。

### Q2 client 侧 React 获取方式与模块形状（ui-plugin.md/模板实读结论；禁 import 宿主 UI 包下的自写边界）？
**应答**：客户端模块 = `window.__ModuleLoader__.load({id:包名, factory:(require)=>{ const React=require('react'); ...; return {apply, inject} }})`——React 来自浏览器模块表，无需 CDN/重复安装（ui-plugin.md L9；模板 templates/decoration/client.js；真机先例 dsh-orb client-settings client.js L1-8）。自写边界：仅 `require('react')`；控件全部自写（Toggle/SelectField/TextField/NumberField/ListField），类名 `mroute-` 前缀，样式只用 `--dsw-*` token（practices.md L35 明文禁止 require 宿主 client UI 包）。组件数据经 slot 的 `inject` props 工厂传入（03 A.2 `inject: injected` 模式）。

### Q3 settings.section 注册形状/props 实操（03 A.1/A.3 行号 + dsh-orb 先例对齐）？
**应答**：`ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section', id, order, label:()=>copy().nav, inject:()=>({settings,remote})}, ModelRouteSection))`——与 dsh-orb 先例（client.js L3236-3242）逐字段对齐（name/id/order/label/inject+组件），`inject` 是组件 props 工厂（03 A.2 models 页同款）；order=18 落在 models=10 与 orb=25 之间（03 A.1/A.3 实证 + 任务书 §3.1）。

### Q4 SETTINGS_CONFLICT 实际错误/事件形状与处理？
**应答**：host 侧 `SettingsForms.write` 抛 `SettingsConflictError{code:'SETTINGS_CONFLICT', expected, actual}`（dsh-settings lib/index.js L163-181、L511）；`SettingsController.rejected` 分类为 `RemoteError("settings/conflict", msg, {ns,expected,actual})`，其它拒绝为 `RemoteError("settings/rejected", ...)`（dsh-api-settings-controller lib/index.js L489-509）。client 处理（client.js `isConflictError` L118-124 + onSave L478-485）：判 `code==='settings/conflict'` 或 `name==='SettingsConflictError'` → 重拉镜像（`load()`）覆盖本地草稿 + 提示「已刷新未覆盖他人修改」；非冲突错误透传 message。事件侧 `settings/document-updated`（host describe L435 emit `(ns, revision)`）→ client `remote.$on` 订阅本 ns 重拉镜像（client.js L445-453）。

### Q5 locale 落地语种数与词典组织？
**应答**：**zh/en 两个语种**（§2.5）。manifest `locale/zh.json`+`en.json` 承载 meta.title/description；分区 UI 文案自包含 client.js zh/en 词典 + `<html lang>` 探测 + MutationObserver 热切换（dsh-orb 同款，无 locale 服务依赖）。8 语种机械翻译不做（第三方分区 zh/en 覆盖目标用户，dsh-orb 亦 zh/en）。client.test 断言 zh/en 键集一致。

### Q6 与宿主原生 schemastery 表单双入口并发写：revision 机制是否覆盖？
**应答**：**覆盖 settings 写链并发，但原生「打开配置文档」（cordis.patch.yml 文本编辑）是另一路径**。settings 写链（我的面板）每 ns 单调 revision（host describe 按 raw 变化递增 L427-435），任何携带陈旧 revision 的写被 SETTINGS_CONFLICT 拒（L511），client 冲突即重拉不覆盖——**同数据源双入口经 revision 乐观锁覆盖**。宿主原生「打开配置文档」走 `configEditor` 直接写文件、不经 settings.revision，但它触发 `app-boot/config-reload` → describe 重算 → revision 递增 → 我面板若持陈旧 revision 保存即冲突重拉（正确行为，不会覆盖他人）。故无需页头额外提示（revision 已兜底），但 devlog 此处说明双入口语义（原生文档编辑 = 外部写，靠 revision 冲突闭环兜底）。

## 8. 遗留与后续衔接

1. lead 浏览器实测（§6 步骤清单）→ 收口。
2. 新增/删除渠道（id 输入 + 悬空 fallback 校验）——后续里程碑。
3. provider/model 目录候选（remote.llm/remote.session）——可选增强。
4. zai 窗口语义归一化 / providerKeyRefs 辅助提示（M2 devlog 遗留）——面板 verified 提示文案已承接（deepseek/xiaomi 依据），未做自动翻真。

## 9. 实测修复：远端调用信封 `{ok, value}`（2026-11-16，lead 浏览器实测阶段）

**现象**：分区正确地出现在设置导航（order=18，位于 models 与 orb 之间），点进去却渲染 `text.unavailable`「模型路由插件未启用或本部署无设置面板服务」。

**定位**：host 侧探针 `ctx.settings.describe()` 返回 28 个 ns 且**含 `mroute`**（revision 6→13），schema/volatile/entries 过滤四项条件全过 ⇒ 故障收缩到 client 半。页面内诊断行（`[diag v3]`，不依赖网络）实测：

```
{"origin":"dsh-app://app","s":{"keys":["ctx","name","invokeRemote","methods","namespace","describe","mutate","openSettingsDocument","replace","update"]},
 "rt":"object","rkeys":["ok","value"],"n":0,"ns":[],"k0":[]}
```

**根因**：`ctx.remote.settings.describe()` 解析出的是 **`{ok, value}` 信封**，真实数据在 `result.value.namespaces`；原实现直接读 `result.namespaces` ⇒ `undefined` ⇒ 命名空间计数 0 ⇒ 走 unavailable 分支。`dsh-api-remotes` 的 `RemoteInfo.methods[endpoint].invoke()` 经 `Reflect.get` 调远端方法，返回值即信封（`descriptors` 按 `namespace/method` 拆分，`id = 包名#endpoint`），故**所有 `remote.*` 方法（describe/mutate/replace/update）都须解包**。

**修复**：`client.js` 新增纯函数

```js
function unwrapResult(response) {
  if (response && typeof response === 'object' && 'ok' in response) {
    if (response.ok === false) { /* error.code/name/message → new Error，保留 code 与 name */ }
    return response.value
  }
  return response   // 非信封形态原样返回（向前兼容）
}
```

`load()` 用解包结果；`onSave()` 改为 `mutate(...).then((raw) => unwrapResult(raw)).then(成功, 失败)`——**解包抛错必须进错误分支**：写在 `onFulfilled` 里会变成未处理拒绝，首版即被 selfcheck 抓出并改链。

**旁证（通道结论）**：桌面端渲染进程 origin = `dsh-app://app`（renderer 命令行 `--standard-schemes=dsh-app --secure-schemes=dsh-app --cors-schemes=dsh-app --fetch-schemes=dsh-app`），相对路径 `fetch('/plugins/...')` 落在自定义协议上，**打不到宿主 55095 的 webServer 路由** ⇒ client→host 只能走 `ctx.remote.*`，`webServer` 路由仅对真实 HTTP 客户端（如外部脚本/curl）有效。

**自检**：`npm run selfcheck` **60/60 全绿**——假 remote 改为真实信封形状，新增 `unwrapResult` 四态用例（`{ok:true}`/`{ok:false}` 带 code/name/非信封透传）与 unavailable 分支用例。

**收口清理（已完成）**：host 临时探针整块删除（`inject` 里的 `settings`、`mroute_settings_probe` 工具、`/plugins/mroute-diag/api` 路由、`node:fs` 落盘，index.js 回到 81 行且 `node --check` 通过）；client 只保留 unavailable 分支的一行 ns 名单诊断（无配置值）。


## 10. UI 实测迭代：布局修复 + 中英双语字段名 + 默认折叠卡片（2026-11-16，用户三条反馈）

### 10.1 布局错位（用户在 dsh-app 桌面端截图发现）

现象：内容宽于面板内容列 → 右侧被裁 + 底部横向滚动条；渠道卡标题列被压到约 30px、「zai-coding-cn」逐字换行；`channel_type`/`tier`/`manual.quota_used_est` 越过卡片右边界被裁。

取证：`Slots.listSubTree(root='settings.section')` 显示 occupants 顺序（`account(-10)/general(0)/models(10)/plugins(15)/model-route(18)/agent-presets(20)/orb(25)/…`），owner props 只有 `close`，catalog 原文「Sections render inside the panel content column」——**分区自身不带布局/滚动约定，尺寸全由插件 CSS 决定**；对照第三方 `dsh-windows-mcp/lib/client.js:130` 的 `.dwmc-set{display:flex;flex-direction:column;gap:18px;max-width:720px}`。

修复（`client.js` CSS 七处）：`.mroute-set` 加 `width:100%; min-width:0; box-sizing:border-box`（保留 `max-width:720px`）；`.mroute-fields`/`.mroute-card` 加 `min-width:0`（卡片再加 `max-width:100%; box-sizing:border-box`）；`.mroute-card-head` 加 `flex-wrap:wrap`；`.mroute-card-identity` 改 `flex:1 1 180px`；`.mroute-card-id/.mroute-card-provider` 加 `overflow-wrap:anywhere`；`.mroute-grid` 由固定 `repeat(2,minmax(0,1fr))` 改 `repeat(auto-fit, minmax(190px,1fr))`（窄列自动降为单列，替代 @media 断点）；`.mroute-verified-row` 加 `flex-wrap:wrap`。

### 10.2 用户三条新要求（原文）

> 「1、各要素字段名，要中英都有。2、下拉框底色为亮色，除了选中项目，其他都选项文字都和底色一样，看不到。3、每个渠道模型部分都做成折叠打开，刚进去显示的全部折叠起来，折叠起来时显示最重要的内容，如需要进一步点击展开。」

**① 字段名中英并列**：新增 `bi(key)`——取 `zh[key]`/`en[key]`，同文（`models`/`tier` 这类技术键）只显示一次，否则按界面语言排序输出 `中文 · English`（中文界面）或 `English · 中文`（英文界面）。所有 field label 与卡片/分区标题改为 `bi(...)`；zh 词典同时把技术键名改成中文词（`statusLabel:'手动状态'`、`channelTypeLabel:'渠道类型'`、`tierLabel:'能力档位'`、`quotaPlatformLabel:'余额平台'`…），于是渲染为 `手动状态 · manual.status`、`能力档位 · tier`。

**② 下拉弹层不可读**：桌面端原生 `<select>` 弹层被系统按**亮底**绘制，而 option 文本继承深色主题的浅色前景 → 亮底浅字。修复：`.mroute-select-wrap select.mroute-input{background-color: var(--dsw-alias-bg-overlay, rgba(127,127,127,.08))}` + `.mroute-select-wrap option{background-color: var(--dsw-alias-bg-overlay,#fff); color: var(--dsw-alias-label-primary,#1f2329)}`（只用 theme token，随亮暗主题切换）。

**③ 渠道卡默认折叠**：`ChannelCard` 重写为受控折叠卡——`const [open, setOpen] = React.useState(false)`（进入面板全部折叠）；卡头是 `button.mroute-card-toggle`（`aria-expanded`、chevron 旋转、identity = 渠道 id + `路由提供方: xxx（只读）`）+ `.mroute-card-chips` 六枚要点 chip（状态 / 付费类型 / 能力档位 / `priority N` / 余额平台 / 核实状态，tone 用 `--dsw-alias-state-*`）；展开后才渲染 `.mroute-card-body`（两列字段 + 备注 + 模型列表 + 备选 + 核实开关 + 复核时间）。`tier` 值含下划线，`shortKey()` 首字母大写拼接不适用 → 新增 `tierShortKey()` 显式映射（`overseas_sota→tierShortOverseas` 等）。

### 10.3 自检与分发验证

- `selfcheck/client.test.mjs` 的极简 React 假件原先用**全局 cursor 数组**分配 hook 槽位：折叠/展开某张卡会移动其它卡与 `ListField` 的槽位（真 React 是每实例独立 hook 链）→ 改为按「组件实例（函数名 + `label`/`channel.id` 身份）+ hook 序号」的 `Map` 槽位，`flush()` 改为多趟跑未执行 effect。/ 断言随新 UI 更新（折叠态无 select、点击 toggle 后字段可见、双语 aria-label、chip 要点齐备）→ **60/60 全绿**。
- 分发验证：`plugin_manager set_bundle enabled:false→true` 两轮 `application:"applied"`（本 build 可靠热重载，比 install_bundle 安全：不走 pnpm、避开中文路径坑）；`node %TEMP%\mroute-fetch-bundle.mjs` 复算 rev → `f5f082ef351c`、42246 字节、无临时诊断残留（`reportDiag`/`diag v3`/`safeStringify` 均为 false）；`Invoke-WebRequest` 直取 `/plugins/??@local/dsh-plugin-mroute/client.js&rev=f5f082ef351c` → 200，含 `mroute-card-chips`/`mroute-chip`/`mroute-select-wrap option`/`tierShortKey`/`aria-expanded`。

**教训**：改 `client.js` 后光点设置导航不会换代码——client 模块由 `dsh-client-modules` 在宿主侧按 `artifactRevision(stat)`（mtime/ctime/size 的 sha1 前 12 位）编译分发，必须 ①toggle bundle 触发 `internal/plugin` 重算 graph ②浏览器 `Ctrl+Shift+R` 才会拉到新 rev。

## 11. M3.5：静态层建议顺序预览 + 每模型能力档位（2026-11-16，0.4.1-m3.1）

### 11.1 交付范围与裁决

任务书 `docs/briefs/m3.5-dev.md` 两块能力：① 设置面板内只读「建议顺序（静态层）」预览（client 纯函数 `previewRanking`，与 `lib/ranking.js` 同序，靠 parity 用例对拍）；② 渠道级 `model_capability` 每模型四维档位（coding/tools/long_context/vision，面板每模型行 4 个下拉，随 channels 数组整替保存，host 工具输出可选透出）。

**裁决 A（lead，2026-11-16）**：`model_capability` 放弃任务书原样的 `.volatile()`，保留 `z.array(z.object({model, coding?, tools?, long_context?, vision?})).default([])`。理由与证据见 §11.3。任务书其余设计（位置/四维闭集/未登记=无数据/排序零改动/tool 可选透出）按书执行。

红线守持：`lib/ranking.js` 的 `rankChannels`/`rankOf`/`CHANNEL_TYPE_RANK`/`TIER_RANK` **一行未改**；模型级评级不参与排序；无 guard/阻断/改写；无新增依赖；未触碰 `gemini-eyes/`、`plugin-quota-multi/`。

### 11.2 落点（文件:行号，改动后行号）

- `plugin-mroute/lib/config-schema.js:159` 新增 `export const modelCapabilitySchema = z.object({ model: z.string(), coding/tools/long_context/vision: z.union([...CAPABILITY_RATINGS]) })`（四维无 default，缺键即省略）；`:181` `channelSchema` 增 `model_capability: z.array(modelCapabilitySchema).default([])`。
- `plugin-mroute/lib/registry.js:42` 新增 `export function modelCapabilityOf(channel, model)`；`:63` 私有 `normalizeModelCapability(channel, warnings)`（非对象行/空 model/四维全无有效值丢弃，重复首个生效，闭集外维度丢弃，未知模型引用保留）；`:133-135` readRegistry 归一化循环；`:175` 返回归一化 channels。
- `plugin-mroute/lib/tool-query.js:203` `modelCapabilityText(rows)`；`:234-235` 理由行后追加 `   模型档位: glm-4.6 coding=excellent …（advisory 标注，不参与排序）`；`:342` 起 output schema `routes.items.properties.model_capability`（可选、items `additionalProperties:false`、`required:['model']`、四维 enum）；`:503-505` route 组装仅在非空时展开该键。
- `plugin-mroute/client.js:110-125`（zh）/`:192-207`（en）新增 16 键（preview*/modelCapability*/dim*/rating*，键集一致）；`:276` `normalizeModelCapability`、`:333-344` `validateChannel` 增 model_capability 校验、`:360-390` `channelToPlain` 过滤空行并在非空时输出、`:415` `previewRanking`、`:570` `ModelCapabilityEditor`、`:687` `PreviewCard`、`:827` 渲染位置（advisory 横幅后、fieldset 前）、`:916-931` 新增 `.mroute-preview*` / `.mroute-modelcap*` 样式。
- `plugin-mroute/selfcheck/degrade.test.mjs:219/239/269` 三个 host 侧用例；`plugin-mroute/selfcheck/client.test.mjs:337/354/373/408/429` 五个 client 侧用例。
- `plugin-mroute/package.json:3` `0.4.0-m3.0` → `0.4.1-m3.1`（其余字段未动）。

### 11.3 `model_capability` 为何不标 `.volatile()`（裁决 A 依据）

最小探针 `tmp/day1-schemastery-probe/probe-m35.mjs`（schemastery 3.19.0，与宿主同版本）实跑：

- 任务书原样 `z.array(...).default([]).volatile()` 放在 `channels[]` 元素内：**构造期不抛，parse/调用期抛** `ValidationError: $.channels.*.model_capability volatile fields require a fixed object path without an enclosing volatile field`。
- P3（`channels` 非 volatile + 元素内字段 volatile）同样抛 ⇒ 根因是 **volatile 字段路径含数组通配符**，不是「外层有 volatile」单一因素（旧 Day-1 表述已据此精确化，见 §11.7 与 AGENTS.md §4）。
- P4 顶层固定路径 `model_capability: z.array(row).default([]).volatile()` 合法且 `.get()` 读回完整 ⇒ 数组本身标 volatile 没问题，是位置问题。
- 去掉 `.volatile()` 后（P2）：`channels[]` 元素内 `z.array(z.object).default([])` roundtrip byte-identical，缺字段回 `[]`，闭集外评级在 parse 期抛。

写侧能力来自**父级 `channels` 数组整体 volatile**（`Config` L193；settings 写链 `isVolatilePath('channels.*')` 整棵子树合法，M3 spike §4 已证），保存仍只发 `channels` 一条数组整替 op——`buildSaveOps` 维持 4 op，未新增顶层键或路径。

往返证据：schemastery 对象**没有 `toJSON`**（`typeof s.toJSON === 'undefined'`），`JSON.stringify(Config)` 对 volatile 字段一律返回 `{}`，不可用于往返。正确做法：`Config({channels})` → `readVolatile(s.channels)` → JSON 深拷贝 → 再 `Config(...)` → `readVolatile`，两次 `model_capability` deepEqual；无该字段的旧数据读回 `[]`（`degrade.test.mjs:219`）。

### 11.4 行为约定

- 预览：`previewRanking(channels)` 返回 `[{rank, channel, reason}]`，比较器与 host 同序（channel_type → tier → priority 降序 → id；忽略活校验，unknown 恒 0），随表单实时重算、只读、不发请求；空表显示「无渠道」；顶部固定说明「静态层排序：不含 provider 活校验、余额与 disabled/low_balance 告警；完整链路以 host 工具 model_route_query 为准」。
- 每模型档位：行集 = `models[] ∪ model_capability[].model`（去重保序）；模型 id 只读 + 4 个下拉（未登记 + excellent/good/fair，标签中英并列）；选「未登记」删该维，四维全空删行；未登记模型仅提示不阻断；重复 model 客户端阻止保存。
- host 读侧归一化：重复首个生效并 warn、非法评级丢弃并 warn、空行丢弃、未知模型引用保留并 warn；`modelCapabilityOf` 返回闭集四维对象或 `undefined`。
- 工具输出：可选键 `model_capability` 不进 `required`，无数据渠道不出现；文本档位行只在有数据时追加。排序/过滤零改动（`degrade.test.mjs:269` 断言五渠道全序不变）。
- 全部能力均为标注/预览：不阻断、不改写、不代决策（advisory-only）。

### 11.5 自检与分发验证

- `npm.cmd run selfcheck`：基线 60 → **68 tests / 68 pass / 0 fail**（本会话实跑）。新增 8 条：`degrade.test.mjs` 3 条（schema 往返+旧数据 `[]`、registry 归一化+`modelCapabilityOf`、工具可选键+文本行+全序回归）；`client.test.mjs` 5 条（5 种子渠道空活校验 Map 的 `previewRanking` ↔ `rankChannels` parity、预览卡渲染与折叠态、4 下拉+保存仍 4 op、重复 model 阻止 mutate、纯函数闭集与空行）。
- `node --check`：client.js、config-schema.js、registry.js、tool-query.js 与两个测试文件全过。
- 重载：`plugin_manager action=set_bundle target=@local/dsh-plugin-mroute enabled:false → true`，两轮 `application:"applied"`（未用 install_bundle）。
- 分发：`node %TEMP%\mroute-fetch-bundle.mjs` → path `D:/Codes/DSH小插件/plugin-mroute/client.js`、rev `dfb229b15064`、54397 字节；`Invoke-WebRequest "http://127.0.0.1:55095/plugins/??@local/dsh-plugin-mroute/client.js&rev=dfb229b15064"` → 200，含 `previewRanking`/`model_capability`/`建议顺序（静态层）`/`每模型能力档位`。
- 实调 `model_route_query`：5 行全序（zai → opencode-go → deepseek-official → deepseek-account → xiaomi）、advisory 表头、warning 标注与 machine 余额均不回归；种子无档位数据 → 无 `模型档位:` 行与该键（预期；有数据形态由 `degrade.test.mjs:269` 覆盖）。

### 11.6 未自动化（如实声明，勿当已验）

1. 浏览器真机挂载：预览卡位置/折叠态布局、模型行四下拉、长 id 换行。
2. 真机保存 → `model_route_query` 读到 `model_capability`（需面板先填数据并保存，另开会话查询；本会话只有单测覆盖）。
3. 桌面端下拉弹层亮底可读性（沿用 §10.2 修复，本次未新增特例，未真机复看）。

### 11.7 一致性核对

- **与任务书 §3.2 的偏离仅一处**：去掉 `model_capability` 的 `.volatile()`（裁决 A）；其余（渠道卡内模型行、四维闭集、未登记=无数据、数组整替保存、工具可选透出、排序零改动）逐条按书执行。
- **与 AGENTS.md §4 Day-1 条目**：原文「`.volatile()` 在数组元素内抛错」过粗，已改为「构造期不抛、调用期抛 `volatile fields require a fixed object path without an enclosing volatile field`；数组元素内禁 volatile，父级数组整体 volatile 合法」。
- **与 §10 UI 迭代**：新增样式全部 `mroute-` 前缀、只用 theme token；渠道卡默认折叠保留，预览卡独立常显，不改变既有折叠交互。

### 11.8 lead 定向复核（静态侧，2026-11-16）

并行于 worker 自报，lead 独立复核五项，全部通过：

1. `npm.cmd run selfcheck` 复跑：**68 tests / 68 pass / 0 fail**（与 worker 自报一致）。
2. schema 补测（worker 未覆盖的边界）：`Config({channels:[{… model_capability:[{model:'m', coding:'excellent'}]}]})` **不抛** —— schemastery 字段默认可选，四维缺键即省略，故面板允许「只填部分维度」；非法评级仍抛 `$.channels[0].model_capability[0].coding expected "excellent" | "good" | "fair" but got "bogus"`。结论：`channelToPlain` 的「只带已填维度」与 schema 相容，保存不会被拒。
3. `lib/tool-query.js:203` `modelCapabilityText` 与 `:234-235` 文本行、`:503-505` 可选键展开实现正确；`model_route_query` 实调 5 行全序不回归（zai → opencode-go → deepseek-official → deepseek-account → xiaomi，advisory 表头与两条 machine 余额在）。
4. `client.js` 侧：`DIMENSION_LABEL_KEYS`/`RATING_LABEL_KEYS`（:44-45）指向的键在 zh/en 两词典均存在；用 node 解析两词典做键集对拍 → **zh 80 键 / en 80 键，零差集**（双语不缺项，不会渲染 `undefined`）。
5. 分发包：`node %TEMP%\mroute-fetch-bundle.mjs` → rev `dfb229b15064`、54397 字节；诊断残留全 false（`reportDiag`/`diag v3`/`safeStringify`/`settingsShape`/`viaRemote`），`client.js` 源码亦无残留（Select-String 零命中）。

仍待真机点击的三项见 §11.6（预览卡与四下拉观感、保存后工具读回、下拉弹层亮底）。

## 12. M4 数据面：窗口型余额 + 模型列表同步（2026-11-20，0.4.1-m3.1 增量）

### 12.1 用户三条需求（原文，2026-11-20）

> 「看到面板更新了，有了静态建议顺序。1、包月模型渠道余额没有获取?额度插件那边是有的。2、各个渠道模型列表获取不到或者不正确。各个模型要能标记智能登记，用于优先级排序参考。3、对于动态混合推荐的参考维度和算法概要，你输出一个文本给说明下，我需要核对。」

第 3 条交付 `docs/06-recommendation-algorithm.md`（364 行，待用户裁决 Q1-Q5）。

### 12.2 窗口型余额（`quota-view` 新增 `mode='window'`）

- **背景**：包月渠道在 quota 快照里没有 `remaining` 数值——zhipu 卡是「5 小时窗口 已用 1% / 本周窗口 已用 3%」，opencode-go 卡是「5h 4% / 本周 8% / 本月 4%」；M2 只认 `remaining`，故整类被跳过。
- **落点**（`lib/quota-view.js`）：`:65` `WINDOW_USED_RE=/已用\s*(\d+(?:\.\d+)?)\s*%/`（只认 display 的 `已用 N%`，`已用 $0.5 · 无限额度` 不命中）、`:101` `parseWindowUsedPct`、`:116` `shortWindowLabel`（5h/本周/本月）、`:132` `windowItemsOf`（顺序=快照原序）、`:150` `compactWindowDisplay`（`5h 4% · 本周 8% · 本月 4%`）、`:156` `currencyOf`、`:179` `platformViewOf`（**模式判定序 window → amount → status → null**，`mode` 恒在视图形状，`windows`/`worst_used_pct` 仅 window 模式出现）。
- **为何不采信 `item.percent`**：zhipu 卡的「搜索/工具额度」也带 percent（12.2%），但它不是时间窗口用量；只认 display 文案可避免误判。
- **消费侧**（`lib/tool-query.js`）：`:89-91` 保留 `quota_account_verified` 采信门（红线：映射命中≠账户体系一致）；`:92-102` 模式校验改为 amount 必须有数值、window/status 可无数值；`:225-232` `balanceDisplayText`（window → `machine(5h 4% · 本周 8%)`、status → `machine(在线)`）；`:372` 输出 schema 增 `windows[]`/`worst_used_pct`；`:518` note 文案（含「最高 N%」）；`:542-560` `balance` 可选键展开。
- **真机实测（2026-11-20T02:28Z）**：zai-coding-cn `balance=machine(5h 2% · 本周 3%)`、opencode-go `balance=machine(5h 9% · 本周 10% · 本月 5%)`；deepseek-official/deepseek-account `machine(¥35.12)`、xiaomi `machine(¥57.93)` 金额型不回归。
- **配置默认值 ≠ 生效值（坑）**：schema 种子改 `quota_account_verified: true` 后真机仍是 `false` —— 因为 channels 数组早已被**持久化**到 `C:\Users\sir_c\.dsh\profiles\desktop\cordis.patch.yml`（`:375`/`:399`）。改默认值必须同时检查 profile patch 是否已 materialize；本次由用户在面板开「账户已核实」并保存后转 true（`:376`/`:400`）。

### 12.3 模型列表同步（新宿主工具 `model_route_sync_models`）

- **新增** `lib/tool-sync-models.js`（324 行）：`{apply?:boolean=false}`，默认 dry-run；返回 `dry_run/applied/synced_at/apply_error/materialized/changed_channels/skipped/channels[]`（每项 `channel_id/provider/current/catalog/missing/stale/provider_known/changed/reason`）。
- **数据源**：`ctx.llm.listProviders()` + `ctx.llm.listModels(provider)`（与 `lib/livecheck.js:20-49` 同源），目录里查不到的 provider 标记 `provider_known=false` 并跳过，不猜。
- **写回纪律**：apply 只改 `channels[].models` 与顶层 `reviewed_at`（`YYYY-MM-DD`，复用既有字段，不新增顶层键），不触碰 manual/capability/model_capability；不触发 `reviewAlertsOf`（避免把同步日误报成人工复核）。
- **提示侧**：`lib/tool-query.js:206` `catalogAlertsOf` 把「注册表 models 与宿主目录不一致」作为 advisory 挂在 `review_alerts`，**不阻断、不拒绝写**（advisory-only 红线）。
- **实测（2026-11-20）**：`apply:true` 后五渠道全部对齐目录（zai `glm-5.3/-flash/-highspeed`；opencode-go 六个模型含 `longcat-2.0`/`longcat-2.5-preview-free`；deepseek 两渠道 `deepseek-flash`/`deepseek-v4-pro`；xiaomi `mimo-v2.6-flash/-pro`）；复跑 dry-run 五渠道「一致」；`model_route_query` 的 5 条目录不一致告警消失。被替换掉的 `glm-4.6` 人工档位保留在 `model_capability` 里（面板行集 = models[] ∪ model_capability[].model）。

### 12.4 M3 收口：保存 → 工具读回（真机，2026-11-20）

用户按指引在面板打开 `zai-coding-cn`/`opencode-go` 的「账户已核实 · quota_account_verified」并保存 → `model_route_query` **立即**读到 `verified=true` 与窗口读数，`cordis.patch.yml:376,400` 落盘 `true`。

证据链：`client.js` `unwrapResult(settings.mutate(NS, ops, revision))` → `dsh-settings` write → `configEditor.edit` → `mergeLayers` 落 profile patch → `describe()` 重算 → host 工具读新值。**M3 五步清单第 2 步（保存热更读回）通过**（第 1 步挂载早已通过；第 3 步重启持久化由上一轮 `verified=false` 跨两次重启存活反向证明；第 4 步双窗口冲突、第 5 步 8 语种回退仍未真机复验）。

### 12.5 仍未做（如实声明）

1. **窗口高水位告警 `window_high` 未落码** —— 阈值等用户裁决（文档 §6 Q2 推荐：本周 ≥85%、5h 仅 ≥90% 提示）。`worst_used_pct` 已在输出里，接告警只差一个判断分支。
2. **模型级档位仍不参与排序**（文档 §6 Q1）——当前仅标注「模型档位」与面板编辑。
3. `lib/tool-query.js` 文本渲染未加「窗口用量告警」行，与 1 同批实施。

## 13. M4.5：动态数据影响排序（窗口/余额高水位沉底，2026-11-20，0.5.0-m4.5）

### 13.1 用户裁决（原文）

> 「动态数据要能影响排序，有的渠道都快没有额度了，再派长程任务，会执行到中间断开的，影响执行。」

阈值由用户裁决：**周窗口已用 ≥98% 沉底**、**5h 窗口已用 ≥95% 只提示不沉底**（「5h提示95%即可，周的98%之前都不太会影响任务执行」）、**金额型 CNY 余额低于既有 `low_balance_threshold_cny`（默认 ¥10）沉底**。三档均为 advisory-only：只改建议顺序与标注，**不剔除、不阻断、不改写请求**；未核实渠道仍按 M2 采信门不读数值。

### 13.2 规则表与口径（`lib/dynamic-state.js`，123 行）

- 纯函数 `dynamicStateOf(channel, machine, thresholds)`（`:82`）→ `{state:'tight'|'hint'|'ok', reasons:string[], metrics:{week_pct?,h5_pct?,balance?}}`；无随机、无时钟依赖，可复盘。
- 阈值归一 `dynamicThresholdsOf`（`:55`）：`window_week_tight_pct`/`window_5h_hint_pct` 只接受 1–100，否则回落 98/95（`:28/:30`）；`low_balance_cny` 非负，否则回落 10（`:32`）。
- 周窗口：`WINDOW_WEEK_RE=/周/` 且标签不含 5h（`:94`），`used_pct ≥ 98` → tight（`:97-99`，reason「本周窗口 98.5%（≥98% 沉底）」）。
- 5h 窗口：`WINDOW_5H_RE=/5\s*(?:h|小时)/i`（`:101`），`used_pct ≥ 95` → hint（`:104-106`，reason「5h 窗口 96%（≥95%，不沉底）」）。
- 金额：仅 `mode='amount'` 且 `currency===null||'CNY'` 比较（`:108-113`）；USD 不估汇率；reason「余额 ¥5 低于阈值 ¥10」。
- 排序优先级：**tight 优先于 hint**，且 tight 时 `reasons` 只列 tight 原因（`:116-121`）；`mode='status'`、窗口项缺失、`status!=='ok'`、无 machine 视图 → `ok` + 空 reasons（`:87-88`，不臆造）。

### 13.3 排序落点（`lib/ranking.js`）

- 全序键顺序改为 **unknown → dynamicTight → channel_type → tier → priority → id**（`:7` 文档、`sortKey` `:69-79`、比较器 `:38`）。
- `rankChannels(channels, livecheckById, dynamicById?)` 第三参可选（`:28`）：缺省时 `dynamicTight=0`，旧调用/旧测试顺序不变（回归已测）。
- `reasonFor` 在 unknown 理由后插「动态紧张 → 沉底（…）」（`:53-57`）；hint 不进排序理由，避免表体白噪音。
- tight 只改顺序：`ranked` 长度不变、`excluded` 不增、不产生 deny/阻断。

### 13.4 输出、文本与 schema（`lib/tool-query.js`）

- import（`:57`）；工具 description 增「周窗口/余额高水位（tight）只把渠道沉底并标注、5h 偏高只提示——都不剔除不阻断」（`:310`）。
- 文本渲染（`:286-292`）：tight 行在「备注:」前加 `⚠ 动态沉底: 本周窗口 98.5%（≥98% 沉底）（不阻断）`；hint 行加 `· 提示: 5h 窗口 96%（≥95%，不沉底）`；ok 不输出任何行。
- `routes[]` 恒带 `dynamic:{state,reasons,metrics}`（ok 也带空 reasons，消费方分支简单；schema `:409-433`、route 组装 `:639-644`）。
- `meta.dynamic_thresholds:{window_week_tight_pct,window_5h_hint_pct,low_balance_cny}`（schema `:484-497`、组装 `:677-683`），供复盘某条沉底由哪个阈值触发。
- execute 先建 `machineById`/`dynamicById`（每渠道只算一次 `machineBalanceOf`，`:557-565`）再 `rankChannels(pool, liveById, dynamicById)`（`:567`），machine 采信结果复用给 routes，避免重复判定。

### 13.5 面板两字段（`lib/config-schema.js` + `client.js`）

- Config 新增两个顶层 `.volatile()`：`window_week_tight_pct` `:225`、`window_5h_hint_pct` `:227`（1–100 整数，缺省 98/95），与 `low_balance_threshold_cny` 同形，只增不改。
- client：zh 词典 `:68-71`、en 词典 `:155-158`（键集相等）；`validateTopLevel` 1–100 整数校验 `:363-366`；`buildSaveOps` 两条 set `:413-414`（共 6 ops）；`formFromView` 缺省 98/95 `:469-470`；顶层参数卡两个 `NumberField` `:862-863`。
- 按任务书 §3.5，本轮**不做动态 chip**（面板拿不到实时窗口数据，禁止新增请求通道），留待下轮。

### 13.6 自检

- `npm.cmd run check` 通过（check 链新增 `lib/dynamic-state.js`）。
- `npm.cmd run selfcheck`：**95/95 全绿**（既有 83 + 新增 12），新增 `selfcheck/dynamic.test.mjs` 覆盖：周 98/97.9、5h 95/94.9 边界；CNY/USD/null 三态；tight 优先 hint；无 machine/status/无窗口/status!=ok；阈值可配与非法回落；`rankChannels` 三参沉底顺序 + 缺省回归；渲染 tight 在备注前、hint 有「· 提示」、ok 无噪音；`output.schema` 含 dynamic/thresholds。
- 版本号 `package.json:3` = `0.5.0-m4.5`；selfcheck 链 `:56`。

### 13.7 真机证据（2026-11-20，DSH 桌面 profile）

- 重载：`plugin_manager action=set_bundle target=@local/dsh-plugin-mroute enabled:false → enabled:true`，两次均 `application:"applied"`（安装形态是 **Junction → `D:\Codes\DSH小插件\plugin-mroute`**，改工作区即生效，无需重装）。
- `model_route_query` 真机输出（10:44）：五渠道动态状态**全 ok、零白噪音**——zai-coding-cn `machine(5h 2% · 本周 3%)`、opencode-go `machine(5h 10% · 本周 11% · 本月 5%)`、deepseek-official/deepseek-account `machine(¥35.12)`、xiaomi `machine(¥57.93)`；无任何「动态沉底/提示」行，静态顺序与 M4 一致。
- 结构化面（走真实 `createRouteQueryTool.execute`）：`meta.dynamic_thresholds = {"window_week_tight_pct":98,"window_5h_hint_pct":95,"low_balance_cny":10}`，每条 route 带 `dynamic`（ok 时空 reasons）。真机文本不打印阈值行，meta 由工具返回对象提供。

### 13.8 构造性验证（临时脚本，未入库）

脚本 `C:\Users\sir_c\AppData\Local\Temp\m45-constructive.mjs`（4 渠道：周 98.5% / 余额 ¥5 / 5h 96% / 正常）：

- 排序：静态第一的 `a-monthly-week98.5`（monthly/priority 99）沉到 **#3**，`b-prepaid-balance5` 沉到 **#4**，5h 96% 的 `c` 仍是 **#1**（hint 不沉底），正常渠道 `d` #2。
- 文本：`⚠ 动态沉底: 本周窗口 98.5%（≥98% 沉底）（不阻断）`、`⚠ 动态沉底: 余额 ¥5 低于阈值 ¥10（不阻断）`、`· 提示: 5h 窗口 96%（≥95%，不沉底）`。

### 13.9 偏离与理由

1. **渲染示例的重复后缀**：任务书 §3.3 与 §3.1 的 reason 文案在「不沉底/不阻断」后缀上不同源；实现选 §3.1 的完整 reason 进 `reasons`（工具返回对象自带语义），文本 tight 行尾统一补「（不阻断）」，hint 行不再重复补「（不沉底）」——避免「（不沉底）（不沉底）」。
2. **tight 时 reasons 不混入 hint 原因**：只影响排序的分支写进 reason，5h 提示不冒充沉底理由，减少误导。
3. **面板不加动态 chip**（§3.5 明确）：保持零新增请求，本轮只加两个阈值输入。

### 13.10 仍未做（如实声明）

1. 面板动态状态 chip（需实时窗口数据，涉及新请求通道，下轮单独立项）。
2. 窗口标签识别只认「周」「5h/5小时」：quota 其他语言/新标签（如月窗口之外的日窗口）不触发规则、也不猜。
3. `window_high` 告警行未单列——本轮已由 `dynamic` 标注承接；若未来要纯提示不沉底，需再拆一档。

## 14. M4.6：跨渠道模型归并（2026-11-20，0.6.0-m4.6）

顶层 `model_aliases`（渠道 id → {渠道模型 id → 规范名}）+ 新工具 `model_route_alias_suggest`（dry-run/apply）+ `model_route_query.models_index` 模型优先视图 + 面板「模型归并」折叠卡。全程 advisory-only：不改 `channels[].models` 形状、不改 `routes[]` 顺序与既有键、不剔除、不阻断、无新依赖、无出站请求。

### 14.1 schemastery 探针（三种写法 + 选形）

数据形态是「两层任意键映射」，先用探针裁决，探针存档 `D:\Codes\DSH小插件\tmp\m46-schemastery-probe\probe.mjs`（插件自带 `@deepseek-ai/schemastery@3.19.0`，与宿主同版本；已先回报 lead 再实施）：

| 写法 | roundtrip | 缺省 | 非法值 | 判定 |
|---|---|---|---|---|
| ① `z.dict(z.dict(z.string())).default({}).volatile()` | 两层任意键 deepEqual（含 `org/model:tag`、空格、点号键） | `{}` | 解析期抛 `expected string but got 123` | **采用** |
| ②a `z.dict(z.dict(z.any()))` | 同上 | `{}` | 静默接受 `123`（写侧无校验） | 丢弃 |
| ②b `z.dict(z.object({'*': z.string()}))` | 只剩 `*` 键 | — | — | 丢弃（形状错） |
| ②c `z.object({}).default({}).volatile()` | 未知键原样保留 | `{}` | 不校验 | 丢弃（无校验） |
| ②d 单层 `z.dict(z.string())` | 两层输入抛错 | — | — | 丢弃（不匹配两层形状） |
| ③ 数组控制组 | 可行 | `[]` | — | 丢弃（人读 YAML 不友好） |

选形理由：①既保留「人读 YAML 即键名」的映射形状，又在写侧拒绝非字符串；`dict` 的键不参与值校验，空渠道行 `{}` 合法；`.volatile()` 在顶层（非数组元素内）合法且支持面板热更。三种写法都不行才会停回报——本轮无阻塞。

### 14.2 数据模型与解析口径

- `lib/config-schema.js:235-244`：Config 新增顶层 `model_aliases: z.dict(z.dict(z.string())).default({}).volatile()`；缺省 `{}`；只增字段，其余形状不动。
- `lib/registry.js:60-77` `aliasTableOf`：读侧归一（丢非对象表/行、数组、空键、非字符串/空白规范名）→ 新两层对象；旧配置/手改 YAML 不锁死面板。
- `lib/registry.js:84-96` `canonicalOf(aliases, channelId, modelId)`：未登记一律自反；非对象表、原型链键（`__proto__`/`toString`）、空白规范名都按未登记处理，**绝不抛**。
- `lib/registry.js:104-117` `ratingsForModel(channel, canonical, modelId)`：渠道模型 id 精确行 → 规范名行 → 渠道级 capability 回退 → `null`。
- `lib/registry.js:236-237/:244`：readRegistry 读 `readVolatile(config.model_aliases)` 并返回 `model_aliases`；契约字段只增。
- 语义边界：归并只影响 `models_index` 分组与每模型能力解析顺序；`routes[]` 计算完全不读别名。

### 14.3 工具 `model_route_alias_suggest`（`lib/tool-alias-suggest.js`，新文件 377 行）

- 默认 dry-run：`planAliasSuggest`（`:76`）按**生效** canonical 分组（显式映射优先、未登记自反），成员 ≥2 才出；建议三类：
  - `same-id`（`:113-122`）：组内全员 `model === canonical` 且跨渠道 → 唯一可自动并类别（`apply` 写自反映射）；
  - `prefix-match`（`:149`）：仅 provider 前缀/`:tag` 不同（`normalizeId` 相同）；
  - `low-confidence`（`:150`）：去纯版本 token 后同族（如 `deepseek-v4.1-flash` / `deepseek-flash`）。
- apply（`:299-342`）：只写同 id 自反映射（**已有显式映射一律不覆盖**：人工判断优先），并写顶层 `reviewed_at`；写链唯一合法面 = `ctx.fiber.entry` + `ctx.get('configEditor').edit`（与 `tool-sync-models` 同法）；无 editor → `apply_error` 可读原因、不抛；回调内 `written = 0`（`:318`）防 configEditor 重试放大计数。
- `output.schema` 固定 `dry_run/applied/aliases_written/apply_error/groups/suggestions` 六键；`renderAliasResult`（`:348`）渲染「dry-run / 已写入 / 无可写变更 + 分组 + 建议」。
- 工具永不自动写非自反映射——「不猜模型同一性」落在代码结构上，而不是靠提示词。

### 14.4 `model_route_query.models_index`

- schema（`lib/tool-query.js:555-595`）：`models_index:[{canonical, ratings{coding,tools,long_context,vision}, channels:[{channel_id,channel_model,channel_type,tier,priority,rank,balance_state}]}]`；`balance_state` enum `machine|machine_tight|machine_hint|manual|unknown`；**顶层 required 仍 `['routes','excluded','meta']`**（只增可选键）。
- `buildModelsIndex`（`:346-393`）：按 canonical 分组；每组 `ratings` 取组内**排序最前且有数据**渠道的完整解析（不跨渠道拼维度，宁可缺维不误导）；`channels` 按 `rank → 渠道 id → 模型 id`；groups 按组内最优 rank；只带状态枚举，**不透出余额数值**。
- `balanceStateOf`（`:322-330`）：machine 细分 tight/hint；manual/unknown。
- 文本渲染（`:298-305`）：只列 `channels.length > 1` 的组（`- <canonical>: <渠道>→<模型>(#rank), ...`），单渠道/零别名零噪音；位置在 `excluded` 之前。
- description 增一句（`:405`）明示「只影响视图不改排序」。

### 14.5 面板「模型归并」折叠卡（`client.js`；静态自检过，浏览器未真机验）

- zh/en 词典同键集 9 键（`:138-146` / `:234-242`）：`aliasTitle/aliasHint/aliasCanonicalLabel/aliasMergedTitle/aliasUnmergedTitle/aliasEmpty/aliasMemberHint/aliasManualHint/aliasGroupChip`。
- 纯函数 `normalizeAliases`（`:321`）/`aliasGroups`（`:345`，返回 `{canonical, merged, members[{channel,model,explicit}], crossChannel}`，成员数降序）；`formFromView` 纳入（`:547`）。
- 保存链（`:490`）：既有 6 条 set 之后追加 `{op:'set', path:['model_aliases'], value:…}`，共 7 条；沿用既有 `mutate` + revision + `SETTINGS_CONFLICT` 重拉语义，**不新增 op 类型**。
- 组件 `AliasCanonicalField`（`:805`，受控草稿、失焦 trim 提交）/`AliasCard`（`:833`，折叠；chip「归并组 N」；已归并/未归并两段；规范名置空或等于原模型 id → 删映射）；挂在 `PreviewCard` 之后（`:1015`）；样式 `:1131`；`exports.__mroute` 暴露两纯函数（`:1207`）。
- 折叠 toggle 用 `mroute-card-toggle mroute-alias-toggle` 双类：既能统一折叠视觉，又不破坏既有 client.test 对 `mroute-card-toggle` 精确类名的计数断言。
- **未浏览器真机验**（如实声明）：本轮只跑 client 静态自检（`selfcheck/client.test.mjs:287` 的 7 ops 断言通过）；面板挂载/编辑/保存热更待 lead 抽验。

### 14.6 自检

- `npm.cmd run check` 通过（check 链新增 `lib/tool-alias-suggest.js`）。
- `npm.cmd run selfcheck`：**106/106 全绿**（既有 95 + 新增 11：`selfcheck/alias.test.mjs` 10 + `selfcheck/client.test.mjs` 1），新增 `selfcheck/alias.test.mjs`（`:42/:59/:82/:97/:137/:174/:200/:208/:239/:260`）覆盖：
  - Config 两层 roundtrip / 缺省 `{}` / 空渠道行 / 非字符串解析期拒；
  - `aliasTableOf`/`canonicalOf` 防御口径（原型链键、空白规范名、null）；
  - `ratingsForModel` 三级解析 + null；
  - 真机五渠道分组（四组 same-id）+ `deepseek-flash` 低置信簇 3 渠道（`deepseek-v4.1-flash` 不被自动并）+ 合成 prefix-match；
  - dry-run 零写、apply 8 条只改两顶层键、重复 apply 幂等、无 editor 可读报错；
  - `buildModelsIndex` 分组/排序/ratings/`balance_state`；`models_index` 变化而 `routes[]` 逐行 `deepEqual`。

### 14.7 真机证据（2026-11-20，DSH 桌面 profile）

- 重载：`plugin_manager action=set_bundle target=@local/dsh-plugin-mroute enabled:false → enabled:true`，两次（首版 + 计数修复后复载）均 `application:"applied"`；安装形态是 Junction → 工作区，改文件即生效。
- 真机 dry-run（`model_route_alias_suggest {}`）：4 个 same-id 组（`deepseek-flash` / `deepseek-v4-pro` / `glm-5.3-flash` / `mimo-v2.6-flash`）+ 1 条 `[low-confidence] deepseek-flash ← deepseek-account, deepseek-official, opencode-go`（opencode-go 的 `deepseek-v4.1-flash` **未**被自动并）。
- 真机 apply（`{"apply": true}`）：「已写入配置 / 新增自反映射 8 条」；`C:\Users\sir_c\.dsh\profiles\desktop\cordis.patch.yml:461-474` 落盘 5 渠道共 8 条自反映射（deepseek-account/deepseek-official × deepseek-flash/deepseek-v4-pro；opencode-go × glm-5.3-flash/mimo-v2.6-flash；zai-coding-cn × glm-5.3-flash；xiaomi × mimo-v2.6-flash）。
- 立即反映 + 幂等：紧随的第二次 apply 返回「无可写变更」（若运行中插件未读到新配置会再写 8 条）——证明 `configEditor` 写入即时反映到 `getRegistry`，无需重启。
- 真机 `models_index`（`model_route_query`）：
  - `glm-5.3-flash: zai-coding-cn→glm-5.3-flash(#1), opencode-go→glm-5.3-flash(#2)`（zai rank 在前）；
  - `mimo-v2.6-flash: opencode-go(#2) → xiaomi(#5)`；
  - `deepseek-flash` / `deepseek-v4-pro`：`deepseek-official(#3) → deepseek-account(#4)`（同 id 成组）。
- `routes[]` 逐行一致：apply 前后两次 `model_route_query` 的 1-5 号渠道（zai #1 / opencode-go #2 / deepseek-official #3 / ⚠ deepseek-account #4 / xiaomi #5）与各渠道 `models`/`priority`/`balance` 行完全一致，仅「生成于」时间戳不同。

### 14.8 变更清单（文件:行号）

- `lib/config-schema.js:235-244`（字段 + 探针裁决注释）
- `lib/registry.js:60-117`（`aliasTableOf`/`canonicalOf`/`ratingsForModel`）、`:236-237`/`:244`（readRegistry 返回）
- `lib/tool-alias-suggest.js:1-376`（新文件）
- `lib/tool-query.js:300-305`（渲染）、`:322-330`（`balanceStateOf`）、`:346-393`（`buildModelsIndex`）、`:405`（description）、`:555-595`（schema）、`:796`（结果组装）
- `index.js:22`/`:102-114`（导入、注册、dispose、告警文案）
- `client.js:138-146`/`:234-242`（locale）、`:321`/`:345`（纯函数）、`:490`（保存 op）、`:547`（formFromView）、`:805`/`:833`（组件）、`:1015`（挂载）、`:1131`（样式）、`:1207`（导出）
- `selfcheck/alias.test.mjs:1-276`（新文件，10 tests）
- `selfcheck/client.test.mjs:287`/`:403`（保存链 7 ops 断言）、`:499`（M4.6 `normalizeAliases`/`aliasGroups` 纯函数 + 折叠卡标题/chip 渲染；跨 realm 用 JSON 往返比较）
- `package.json:3`（0.6.0-m4.6）、`:55`（check 链）、`:56`（selfcheck 链）

### 14.9 偏离与未做（如实声明）

1. **探针写法取舍**：②c 的 `z.object({})` 对未知键更宽容，但没有写侧校验；选 ①（探针先行、已回报 lead，非擅自改形）。
2. **规范名归一**：写侧 `trim()`；读侧空白规范名视为未登记——避免空名进入分组键。
3. **apply 只写自反映射**（任务书要求）：低置信/前缀候选只标注；人工归并路径 = 面板改规范名（未浏览器验证）。
4. **ratings 不跨渠道拼维度**：取组内首个有数据渠道的完整解析，宁可缺维也不误导。
5. **面板未真机验**（14.5）：client 静态自检通过，浏览器交互/保存热更待 lead 抽验。
6. 未改 `channels[].models` 形状、未改 `routes[]` 顺序与既有键、未新增依赖/出站请求；单渠道模型（如 `glm-5.3`）不显示在归并视图（零噪音）。
7. **apply 计数防重试放大**：`written` 在 `configEditor.edit` 回调内每次重置（`lib/tool-alias-suggest.js:314`），宿主重试回调时不重复累加 `aliases_written`。
8. **折叠 toggle 双类**：`mroute-card-toggle mroute-alias-toggle`（`client.js:867`），既统一折叠视觉，又不破坏既有 client.test 对精确类名 `mroute-card-toggle` 的计数断言。

## 15. M4.7：能力档位搬到「统一模型名」+ 渲染内自测闭环（2026-11-20，0.6.0-m4.7）

### 15.1 用户裁决原文（m02305）

> 「你的临时渲染窗口，还在挡住我的部分界面，能做成可以拖动的么？另外模型能力评价功能，不应放在各个渠道设置，应该放在统一模型名那个模块，按统一模型名来设置。视觉能力，应该有无的选项。」

三条要求的落地口径：

1. 自测浮动窗：先做可拖动/可收起/可关闭，随后整段移出发布包（见 §15.4）。
2. 能力档位**从渠道维度搬到规范名（统一模型名）维度**：新顶层键 `model_ratings`，与 `model_aliases` 同级；编辑入口在「模型归并」折叠卡内，不再出现在渠道卡。
3. 视觉（以及其余三维）新增 `'none'` 取值 =「明确无此能力」，与「未登记（空）」区分。

### 15.2 变更落点（文件:行号）

- `lib/config-schema.js:246-255`：
  `model_ratings: z.dict(z.dict(z.union([...CAPABILITY_RATINGS, 'none']))).default({}).volatile()`；
  位置理由与回退顺序写进注释（统一模型维度、`channels[].model_capability` 保留为**旧数据回退层**、advisory-only 不参与排序）。
- `lib/registry.js:12-14`：`MODEL_RATING_KEYS = CAPABILITY_KEYS`、`MODEL_RATINGS = [...CAPABILITY_RATINGS, 'none']`；
  `:108-124`：`ratingTableOf()`（闭集过滤含 `'none'`、空名/空行丢弃）；`:130-137`：`ratingsOfCanonical()`（`hasOwnProperty` 防原型链、未登记 null）；
  `:146-166`：`ratingsForModel()` 解析顺序改为 **`model_ratings[canonical]` → `model_ratings[modelId]` → `channels[].model_capability` → 渠道级 `capability` → null**。
- `lib/tool-query.js:350-351`：`const ratingTable = registry.model_ratings`；`:370`：`ratingsForModel(...)` 增第四参。
- `client.js`：
  - `:350` `normalizeRatings()`（读侧归一化，闭集含 `'none'`）；
  - `:577` `formFromView` 增 `model_ratings`；`:519` `buildSaveOps` 第 8 个 op `{op:'set', path:['model_ratings'], value: …}`；
  - `:697-742` 新增 `ModelRatingEditor`（行集 = 规范名 ∪ 已登记键；四维下拉 options `['', ...CAPABILITY_RATINGS, 'none']`，`:709` 为 `none` 选项；空值删维度、整行空则删行）；
  - `:915` 挂进 `AliasCard`（`h(ModelRatingEditor, …)`，`:1053` 为 `onRatingsChange` 接线），`ChannelCard`（`:743`）内旧 `ModelCapabilityEditor` 删除；
  - `:121-133` zh i18n `modelRatingLabel/modelRatingHint/ratingNone:'无'`，`:220-232` en 对应 `'Canonical-model capability'` / `ratingNone:'none'`；
  - `:1242` `__mroute` 导出增 `normalizeRatings`、`ModelRatingEditor`。
- `selfcheck/alias.test.mjs:97-121`：新增 `§3b model_ratings`（表归一化、规范名优先于旧渠道级、`none` 保真、无表回退渠道级、未登记/原型链 null）。
- `selfcheck/client.test.mjs`：保存链 ops 断言 7 → **8**（`:287`、`:412`，末尾 `model_ratings`）；旧「每模型档位」用例改写为 `:373-420` 的 canonical 版（toggle 用 `className.includes('mroute-card-toggle')` 匹配，别名卡是 `mroute-card-toggle mroute-alias-toggle`；行序不假设首位——`aliasGroups` 按成员数降序再规范名升序；`:414` 断言 `{'glm-4.6': {coding:'excellent'}}` 按规范名落盘）。
- `package.json:3`：`0.6.0-m4.6` → **`0.6.0-m4.7`**。

### 15.3 `model_ratings` 与 `model_capability` 的关系（回退层，不是并列维度）

- 新数据只写 `model_ratings`（规范名维度）；`channels[].model_capability` 自 M4.7 起**只读兼容**：面板不再有编辑入口，但 schema/`normalizeChannel`/`channelToPlain` 未动，渠道 chip「档位 N」仍统计旧数据，`ratingsForModel` 在规范名无登记时回退到它。
- 迁移口径：用户按规范名重填后，旧渠道级值自动被更高优先级覆盖，无需手工清理；不改写、不删除既有 `channels[]` 字段（advisory-only 与「不代决策」一致）。
- `'none'` 语义：明确的「无此能力」，与「未登记（键不存在 / 空串）」不同——前者可参与对比与提示，后者表示未知。

### 15.4 渲染内自测闭环（本轮新增方法，重要）

问题：设置面板在 `dsh-app://app` 自定义协议下渲染，相对的 `fetch('/plugins/…')` 打不到宿主 HTTP 服务（§9 已结论），所以既有 `webServer` 路由**不能**当探针通道；`plugin_manager` 只能确认 bundle 生效，无法验证 UI 行为。

可行通道（三条实证）：

1. **改 `client.js` 后 `plugin_manager action=set_bundle enabled:false → true`，client 模块自动热重载，无需刷新页面**（旧认知「必须 Ctrl+Shift+R」只适用于绕过 rev 缓存，开发期 reload 已足够）。
2. 探针把结果写进**自己的 DOM**，我通过 `cordis_inspect_query {platform:'client', provider:'Regions', method:'snapshot', input:{selector:'.mroute-selftest-line'}}` 逐行读回——`<pre>` 里的大段 JSON 会被 snapshot 截断到约 100 字，所以改成「一行一条断言」（`名字|PASS/FAIL|细节≤70字`）。
3. 打开面板的可靠路径：点 `button[aria-label="账号菜单"]`（slot `settings.launcher`，左下角「大器免成」区域）→ 菜单项「设置」→ 导航「模型路由」。`ctx.layout.selectPanel('settings')` **不可用**（主面板只有 `plugins`/`conversation`，会抛 `main panel "…" is not registered`）；`openSettingsDocument()` 也不是开面板，而是 `openTextFile()` 在本地编辑器打开配置文件。

23 项断言全绿（2026-11-20，真机）：

| # | 断言 | 证据 |
|---|---|---|
| 1-3 | 打开链路 | `open.launcher` 账号菜单 / `open.menu.settings` 设置@BUTTON / `open.menu.nav` 模型路由@BUTTON |
| 4-7 | 渲染与默认折叠 | `cards.count=8`、`default.collapsed selects=0`、`chips.present count=31` |
| 8 | 双语字段名 | `低余额阈值（CNY） · Low-balance threshold (CNY)` |
| 9-11 | 布局/折叠交互 | `layout.no_overflow overflowing_cards=0`、`toggle.exists BUTTON`、`expand.body` |
| 12 | 下拉可读性 | `option.readable {optionBg:"rgb(97, 102, 107)", optionColor:"rgb(249, 250, 251)"}` |
| 13-15 | 保存与冲突 | `save.click_no_error []`、`conflict.detected {ok:false, code:"settings/conflict"}` |
| 16-18 | 语种回退 / 收起 / 单实例 | `locale.flip` zh↔en 顺序翻转并切回、`collapse.body`、`panel.open copies=1` |
| 19-20 | 面板整体不溢出 | `panel.no_overflow {cards:8, overflowing:0, width:559, scrollWidth:559}`、`panel.default_collapsed toggles=6` |
| 21-23 | M4.7 能力档位 | `ratings.in_alias_card {rows:10, selects:40, options:",excellent,good,fair,none", inChannelCard:0}`、`ratings.none_option`、`ratings.four_dims` |

闭环结论：M3 五步清单的「挂载 / 保存热更读回 / 双窗口冲突语义 / 语种回退 / 折叠与不溢出」全部由真机断言覆盖（冲突用「过期 revision 的 mutate」等价复现两窗口同源语义）。

### 15.5 片段外置（自测代码不进发布包）

- 自测段（原 `client.js:1208-1516`，309 行）迁到 `plugin-mroute/devtools/selftest-snippet.js`，头部写明用途、接回三步（加回 `const SELFTEST = true`、`apply` 末尾 `if (SELFTEST) runSelftest(ctx)`、inject 加宽到含 `'layout','locale'`）、结果读法与两条环境事实。
- `inject` 回退为 `['slots','remote','remote.settings','remote.credentials']`；`apply` 里的调用行已删；client.js 1558 → **1204 行**。
- 旧实例残留的 `#mroute-selftest` 盒子不会自行消失：用一次性清理行摘掉后立即删除该行并复载（两次 reload），最终代码零残留。

### 15.6 环境坑（本轮新增）

1. **PS 5.1 `Set-Content -Encoding UTF8` 写 BOM** → `plugin_manager set_bundle` 报 `Unexpected token '﻿', "﻿{\n  "name"... is not valid JSON`（package.json 首字节 0xEF）。修法：用 node 重写 JSON（`JSON.stringify(j,null,2)+'\n'`），并校验首字节。
2. 语法错误期间渲染器加载失败，**旧 bundle 实例继续运行并往自己的盒子写检查项**——读自测结果前先确认行集合属于当前源码。
3. `Regions.snapshot` 对长文本会截断，跨多条信息请拆成多个元素或分次查询。

### 15.7 自检与分发验证

- `node --check client.js`：OK。
- `npm.cmd run check`：通过（source/registry/tool 语法与模块装载）。
- `npm.cmd run selfcheck`：**107 tests / 107 pass / 0 fail**（M4.6 的 106 + `§3b model_ratings`）。
- 分发：`set_bundle` 两轮 `application:"applied"`；`mroute-fetch-bundle.mjs` 复算 rev **`38b3dec992af`**、66878 字节；直连 `/plugins/??@local/dsh-plugin-mroute/client.js&rev=38b3dec992af` 校验 `SELFTEST`/`runSelftest`/`mroute-selftest` 全 False、`model_ratings`/`ModelRatingEditor`/`ratingNone` 全 True。
- DOM 复核：`.mroute-set` 正常渲染（x=1092,y=170,w=559），标题「模型路由 · Model routing」、advisory 横幅、预览卡、5 张渠道卡默认折叠、保存按钮在位。

### 15.8 偏离与未做

1. `channels[].model_capability` **保留未删**（兼容旧数据 + 回退层），面板不再提供编辑入口——如需彻底下线需另立清理任务（涉及既有用户数据）。
2. `model_ratings` 不参与 `routes[]` 排序（用户裁决「模型档位不影响渠道推荐」），只出现在 `models_index` 与文本「模型归并视图」中作参考。
3. 自测片段留在 `devtools/`（不进 bundle），后续任何 UI 里程碑可原地接回。
4. 8 语种回退：桌面端实际只有 zh/en，自测以 `ctx.locale.setLocale()` 双向切换验证顺序翻转；其余语种未产包。

## 16. M4.8：能力匹配推荐（need 入参 + 匹配模型 + 推荐落点，2026-11-20，0.7.0-m4.8）

### 16.1 任务与 lead 裁决（红线口径收窄）

任务书 `docs/briefs/m4.8-capability-match.md`：新增 `need` 输入（coding/tools/long_context/vision 四维、值 fair|good|excellent），输出 `routes[].matching_models / suggested_model`、顶层 `model_picks`、`meta.capability_need / unrated_models`，文本补档位与推荐段。红线：**不传 need 时输出与 M4.7 等价、不改 routes[] 排序、advisory-only、'none' 与「未登记」严格区分**。

实现前发现 M4.7 真缺陷：`readRegistry` 未返回 `model_ratings`（写侧已入库，读侧全路径空表）。lead 裁决（m00131–m00133）：

1. 修复**无条件生效**（缺陷优先于输出等价），不只在传 need 时补档位；
2. 红线 2 收窄：`routes[]` 元素顺序/键集合/逐行内容不变、不新增必填顶层键、不传 need 时 need 专属键缺席（判定用 `'matching_models' in route === false`）；差异只允许出现在 `models_index[].ratings` 与「模型归并视图」每行末尾档位；
3. `model_route_alias_suggest` 不得透出 `model_ratings`；`ratingsForModel` 对带档位注册表必须返回非 null；读后形状只含登记键、值是闭集字符串（none ≠ 缺键）；
4. `model_picks` 排序用确定性可手算口径：`fit` 降序（need 各维评级序值和）→ 最小裕度降序（min(模型值−需求值)）→ 渠道 rank 升序 → canonical 字典序；文本写出 `fit=N min=M`。

### 16.2 变更落点（文件:行号）

- **新建 `lib/capability-need.js`（155 行，纯函数）**：
  `RATING_RANK={none:0,fair:1,good:2,excellent:3}`（`:14`）、`NEED_KEYS`（`:17`）、`NEED_VALUES`（`:20`）、`RATING_NONE_LABEL='无'`（`:23`）；
  `normalizeNeed:42`（省略/null→null；空对象→{}；未知维/非法值/非对象返回 `invalid.message`，指明键、值与允许值、大小写敏感）；
  `ratingValueOf:75`（'none'→0、未登记→null）；`matchesNeed:88`（多键 AND，未登记/`none` 均不满足）；
  `fitScore:103`；`minMarginInNeed:119`；`minRatingInNeed:137`；`needSummary:150`（`coding≥good, vision≥good`）。
- **`lib/registry.js` 读侧补齐**（M4.7 遗留，lead 已验）：
  `:287-289` `const modelRatings = ratingTableOf(readVolatile(config?.model_ratings))`；`:290-298` 返回对象新增 `model_ratings: modelRatings`。
  关键代码：

  ```js
  // model_ratings（M4.8 读侧补齐，M4.7 遗留）：volatile 热更双面读；归一化后供
  // models_index.ratings 与 need 能力匹配消费（闭集过滤 + 空行丢弃 + 原型链防御全在 ratingTableOf）。
  const modelRatings = ratingTableOf(readVolatile(config?.model_ratings))
  // …
  return {
    registry_version,
    // …
    // 只含登记键、值为闭集字符串（'none' 是有效值；未登记 = 键缺席，两者读后仍可区分）。
    model_ratings: modelRatings,
  ```
- **`lib/tool-query.js`**：
  `:64` import capability-need；`:54-61` M4.8 头注；`:268-279` `ratingTextOf/ratingsDimsText`（`'none'`→「无」，只列有值维度）；
  `:293` 能力需求表头；`:306-311` 归并视图反查 `ratingsByModel`；`:323-334` 「匹配模型」行（最多 4 个 + `等 N 个`；无匹配写「无（本渠道没有满足该能力需求的模型）」）；
  `:356-368` 模型归并视图档位后缀；`:370-384` 「能力匹配推荐」段（现算 `fit=N min=M`）+ `档位未登记模型: N 个（不计入匹配）`；
  `:489` `matchingModelsOf()`；`:524-537` 参数 `need`（四维 enum `NEED_VALUES`、`additionalProperties:false`）；
  `:670-674` routes 可选键 `matching_models/suggested_model`；`:731-790` `model_picks`（required canonical/channel_id/channel_model/rank/ratings）；`:792-806` meta 可选键；
  `:824` `normalizeNeed(args?.need)` 置于任何 IO 之前（非法参数不触发 livecheck/quota）；`:828` 归一；`:888-891` aliases/ratingTable；`:1000-1001` 路由可选键；`:1007-1021` picks 排序（剥离内部 fit/minMargin）；`:1042-1048` meta。
- **`client.js`**：`:118`（zh）/`:218`（en）新增 `previewNeedHint`；`PreviewCard:808` 在 `:817` 渲染 hint 行（`.mroute-preview-need-hint`）。
- **`package.json`**：`:3` `0.7.0-m4.8`；`:55` check 链加 `lib/capability-need.js`；`:56` selfcheck 链加 `selfcheck/need.test.mjs`。
- **`selfcheck/need.test.mjs`（新，265 行，13 测 §1–§13）**：normalizeNeed/评级序/none vs 未登记/AND/fit-min/registry 透表/matching+model_picks/vision 排除/不传 need 键缺席与 routes 逐元素一致/同分按 rank/文本渲染/非法参数 fail-fast/alias_suggest 不泄漏。
- **`selfcheck/degrade.test.mjs:400`**：新增「不传 need 与 M4.7 等价」回归（need 专属键缺席、顺序不变、文本无能力段）。

### 16.3 为什么必须无条件修 `readRegistry`（与红线 2 的张力）

M4.7 的 `model_ratings` 写侧已落库（`cordis.patch.yml:476-516`，8 个规范名），但 `readRegistry` 返回对象没有该键——M4.7 自测只用注入表因而漏检。后果是运行期 `tool-query.js:350`（当时）取空表：`models_index.ratings` 为空、归并视图无档位，M4.8 的匹配也无从谈起。

修复后 `models_index.ratings` 与归并视图档位在**不传 need 时也出现**，与「逐字节等价」冲突。按 lead 裁决收窄为：`routes[]` 不变、need 专属键缺席；允许差异仅限 `models_index[].ratings` 与归并视图行尾 `[coding:… vision:无]`。§16.5 的不传 need 输出与 M4.7 基线逐行比对即按此口径。

### 16.4 匹配与推荐排序口径（可手算）

- 序值：`fair=1 / good=2 / excellent=3`；`none=0`（明确无能力，不满足任何需求）；未登记=null（未知，不算满足）。
- 匹配（AND）：need 每维都有档位且 ≥ 需求；空 need/省略 = 不做匹配。
- `fit = Σ 模型各 need 维序值`；`min = min(模型序值 − 需求序值)`（可为负，但匹配已保证 ≥0）；排序 `fit↓, min↓, rank↑, canonical↑`。
- 真实样例（need={`{vision:'good'}`}）：`qwen3.8-flash` fit=3 min=1 第一；`glm-5.3-flash @ zai` fit=2 min=0 第二（rank #1 先于 #3）；`deepseek-flash @ official(#3)/account(#4)` 再后；`mimo-v2.6-flash @ xiaomi(#5)` 最后。
- **规范名优先的连锁效果**：真实 `model_aliases` 把 `opencode-go/deepseek-v4.1-flash` 归并到 `deepseek-flash`，`ratingsForModel` 取规范名档位（coding=excellent）——故 `need={coding:'excellent'}` 时 opencode-go 命中 `deepseek-v4.1-flash`，与「按实际档位如实输出」一致。
- `unrated_models` 只统计 need 所涉维度缺档（真实配置 2 个：longcat-2.0 / longcat-2.5-preview-free；已归并模型按规范名有档，不计入）。

### 16.5 自检与分发验证

- `node --check client.js`：OK。
- `npm.cmd run check`：exit 0（19 个文件语法；check 链含 `lib/capability-need.js`）。
- `npm.cmd run selfcheck`：**121 tests / 121 pass / 0 fail**（M4.7 107 + need 13 + degrade 回归 1）。
- `set_bundle` 关→开两轮 `application:"applied"`（warnings 仅 experimental-inspector / lark-kb，与本插件无关）。
- 分发：`mroute-fetch-bundle.mjs` 复算 rev **`c455219b668d`**（client.js 73790 字节 / 对外 67372 chars）；直连 bundle 校验 `previewNeedHint` = true（M4.8 client 增量已生效）。
- 真机配置驱动（本子会话无 `model_route_query` 工具面，见 §16.6）：同一 plugin lib + `cordis.patch.yml` materialized 配置 + quota HTTP 快照跑三段，输出存档 `tmp/real-run-output.txt`。
  - 不传 need：routes 顺序与 M4.7 基线一致（zai #1 / opencode-go #2 / deepseek-official #3 / deepseek-account #4 / xiaomi #5），文本逐行一致，**唯一差异**是归并视图行尾新增档位（如 `- deepseek-v4-pro [coding:good … vision:无]: …`）。
  - `need={coding:'excellent'}`：zai 匹配 `glm-5.3/glm-5.3-highspeed`、opencode-go `deepseek-v4.1-flash`、deepseek 两行 `deepseek-flash`、xiaomi 无；推荐 4 条，`glm-5.3 #1 fit=3` 起。
  - `need={vision:'good'}`：推荐 5 条，第一条 `qwen3.8-flash @ opencode-go (#2) … fit=3 min=1`，`glm-5.3-flash @ zai (#1) fit=2 min=0` 第二。
  - 非法 need：`model_route_query: need 参数非法：未知能力维度 "image"（允许的键 coding|tools|long_context|vision）`；非法值：`键 "coding" 的值 "very-good" 非法（允许 excellent|good|fair，大小写敏感）`。

### 16.6 偏离与未做

1. **子会话工具面缺 `model_route_query`**：本会话（subagent preset）未注入 mroute 工具，无法直接调用真机工具；改用「同一 lib + 真机 patch + 真机 quota 快照」脚本复算（`tmp/real-run.mjs`），并请 lead 在验收时用真机工具复跑对照。脚本与输出不进发布包。
   > **2026-11-20 追加（§16.7）**：这里的「工具面缺」不是 subagent preset 问题，而是**三个工具全都没注册成功**——根因是输出 schema 用了 `type: ['string','null']`，被宿主 JSON schema 校验拒绝。见 §16.7。

2. **不传 need 的非零差异仅限两处**（`models_index[].ratings`、归并视图档位后缀），已在 §16.3 记录张力与裁决；`routes[]` 顺序/键/内容不变。
3. **`model_picks` 每渠道只取 `suggested_model` 一条**（任务书口径），不在 picks 里展开渠道内全部匹配模型；完整列表在对应 `routes[].matching_models`。
4. **need 校验先于任何 IO**：非法参数直接抛工具错误，不触发 livecheck/quota/决策日志。
5. 未新增依赖、未新增出站请求；`model_ratings` schema 沿用 M4.7，未新增必填键。

### 16.7 验收阻塞与根因：工具输出 schema 的 `type` 数组把整套工具注册打死（2026-11-20，lead 真机验收）

**现象**：交付后 lead 调 `model_route_query` 得到 `Error: unknown tool "model_route_query"`；而 `plugin_manager list_plugins` 显示 `include:mroute` 为 `enabled:true`、`fiberPhase:"active"`，`Config.listConfigs` 也返回 `status:"schema"` —— 插件看着完全正常，工具却不存在。`Tool.listTools`（host Inspect，无入参）列 91 个工具，`model_route*` 零命中；另起子会话复现同样为 0 命中。

**根因（临时落盘诊断实证）**：在 `index.js` 加 TEMP-DIAG（`writeFileSync` 落 `C:\Users\sir_c\.dsh\mroute\apply-diag.json` + `ctx.tools.get(name)` 探三工具名）后 reload，读到：

```json
{"events":[
  {"step":"build.routeQuery","ok":true},
  {"step":"outer","ok":false,
   "error":"unsupported JSON schema: schema.properties.routes.items.properties.suggested_model.type must be a single type string (type arrays are not supported)"}],
 "probes":{"model_route_query":"missing","model_route_sync_models":"missing","model_route_alias_suggest":"missing"}}
```

链路：`lib/tool-query.js` 的输出 schema 写了 `suggested_model: { type: ['string','null'] }` → 宿主 `ctx.tools.register` 的 JSON schema 校验只接受**单一 type 字符串**，直接抛错 → `index.js` 的外层 `try/catch` 只 `logger.error`（投毒式静默）→ 而 `model_route_sync_models` / `model_route_alias_suggest` 的注册**嵌套在该外层 try 内**，一并跳过 → 三个工具一个都没注册；fiber 因为没有抛到 apply 层，仍是 active。§16.6.1 记的「子会话工具面缺工具」其实是同一件事。

**修复（两处，`plugin-mroute/lib/tool-query.js`）**：

1. `:674` 输出 schema `suggested_model: { type: ['string','null'] }` → `{ type: 'string' }`，并在 `:670-673` 注释写明宿主限制与「无匹配时不发该键」。
2. `:1000-1006` 发射点改为条件展开：`matching_models` 恒出现（可为空数组），`suggested_model` **只在有匹配时才出现**（不再发 `null`）。

**复验**：`npm.cmd run check` exit 0；`selfcheck` 121/121；`set_bundle` 关→开各 `application:"applied"`；apply-diag 变为 `register.routeQuery ok` 且三工具 `"found"`；lead 真机三连调用通过 —— 不传 need 与 M4.7 基线逐行一致（仅 `models_index[].ratings` 与归并视图档位后缀新增）；`need={coding:'excellent'}` 命中 zai/opencode-go/deepseek×2、xiaomi 显示「无」；`need={vision:'good'}` 正确排除 `vision:none` 的 glm-5.3 / glm-5.3-highspeed / deepseek-v4-pro；非法值报 `need 参数非法：键 "vision" 的值 "bogus" 非法（允许 excellent|good|fair，大小写敏感）`。

**教训（已回写 AGENTS.md §4）**：第三方插件注册工具时，`parameters`/`output.schema` 里**禁止 JSON Schema 的 type 数组**（`['string','null']` 这类可空联合），宿主只接受单一 type 字符串；注册失败只落 `logger.error`、fiber 仍 active，外部表现是「插件活着但工具不存在」。诊断三件套：`Tool.listTools`（看实时全局工具面）→ 临时落盘注册结果 → `ctx.tools.get(name)` 探针。

## 17. M4.9：能力维度 4→6 + 面板动态层快照（2026-11-20，0.8.0-m4.9）

### 17.1 用户需求原文

用户（2026-11-20）：①能力维度从 4 个扩到 6 个（追加 `world_knowledge` 世界知识、`orchestration` 策划调度）；②面板上要能看到动态层（沉底/提示/低余额）——桌面端 origin 是 `dsh-app://app`、client 无法直连宿主 HTTP，采用「最近一次查询快照」方案。

### 17.2 落点表

| 文件 | 改动 |
|---|---|
| `lib/config-schema.js:32` | `CAPABILITY_KEYS` 4→6（末尾追加 world_knowledge/orchestration；capabilitySchema、modelCapabilitySchema、NEED_KEYS、面板下拉全部按该常量派生，自动跟随） |
| `lib/config-schema.js:269-292` | 新增顶层 `dynamic_snapshot: z.object({as_of, rows[]}).default({}).volatile()`（rows 只存非 ok 渠道） |
| `lib/dynamic-state.js:131-181` | 新增纯函数 `buildDynamicSnapshot(routes, asOf)`（无 IO，ok 行丢弃）与 `snapshotRowsEqual(a,b)` 深比较 |
| `lib/tool-query.js:69-70` | import errorMessage + buildDynamicSnapshot/snapshotRowsEqual |
| `lib/tool-query.js:819-825` | `meta.dynamic_snapshot_error`（可选 string） |
| `lib/tool-query.js:1073-1101` | 快照写回：rows 变化或 as_of >30s 才写；`ctx.fiber.entry` + `ctx.get('configEditor').edit` 整替 `dynamic_snapshot`；全程 try/catch 静默，失败只在 meta.dynamic_snapshot_error |
| `client.js:39,44` | CAPABILITY_KEYS 副本 6 维 + DIMENSION_LABEL_KEYS 两个新键 |
| `client.js:129-130,246-247` | i18n dimWorldKnowledge 世界知识/world knowledge、dimOrchestration 策划调度/orchestration |
| `client.js:137-145 / 249-257` | i18n 动态层 8 键（dynamicTitle/dynamicHint/dynamicEmpty/dynamicSunk/dynamicHinted/dynamicLowBalance/dynamicAsOf，zh/en） |
| `client.js:599,604-652` | formFromView 读入 `dynamic_snapshot`（normalizeDynamicSnapshot 轻校验）+ dynamicChipOf/dynamicRowById 纯函数 |
| `client.js:~820` | 渠道卡 chips：tight→`⚠ {reason}`（warn）/ hint→`{reason}`（idle）/ ok 或无行→不渲染 |
| `client.js:867-892` | 新增 `DynamicCard`（只读）：标题 + hint + 摘要行 `快照时间 {as_of} · 沉底 N · 提示 M` + 每行明细；空数据显示引导文案 |
| `client.js:1122,1142` | 渲染顺序：PreviewCard 之后插 DynamicCard；ChannelCard 传 dynamicRow |
| `selfcheck/*.mjs` | client.test 六维断言（4→6）+ 新增动态层测试；dynamic.test 新增 §9 两条；need.test 新增 §14 六维 need |
| `package.json` | version 0.8.0-m4.9（node 重写，防 PS 5.1 BOM） |

### 17.3 方案与写入策略

- **快照写入**：`model_route_query` 在 result 组装完成后（appendDecisionRecord 之前）尝试写回。条件 = `snapshotRowsEqual` 判定 rows 有变化，或现有 as_of 距今 >30s（TTL 内同内容不重复 bump revision，减轻面板冲突重拉）。写法同 tool-sync-models.js（`ctx.fiber.entry` + `configEditor.edit`，回调整替 dynamic_snapshot 字段）。纯附加：写失败/被冲突拒绝都不抛、不重试，返回体与 M4.8 逐行一致（唯一允许差异 = meta.dynamic_snapshot_error 可选键）。
- **面板读回**：client 经 describe → formFromView 读入 dynamic_snapshot（只读镜像），buildSaveOps 仍为 8 条 ops、不含该字段（selfcheck 断言「保存后快照仍在」）。rows 只存非 ok 渠道 → 大多数渠道查无动态行 = chip 零噪音。
- **6 维贯通**：NEED_KEYS/normalizeNeed/ratingsForModel/ModelRatingEditor/normalizeRatings 均按 CAPABILITY_KEYS 派生，改常量即全链生效；`ratingsDimsText` 只列已登记维度 → 现有 4 维登记表文本不变（need.test §12 基线不动）。

### 17.4 schemastery 探针（tmp/m49-probe/probe.mjs，@deepseek-ai/schemastery@3.19.0）

先探后改（任务书 §3.4）：P1 `Config({})` 不抛、默认 `{"as_of":"","rows":[]}`；P2 tight 全字段行 roundtrip byte-identical；P3 缺省字段回填 + 二次整替读回一致；P4 6 维 capability（channels 内）与 model_ratings roundtrip identical、`none` 保留；P5 model_ratings 未知维度键 no-throw（z.dict 键侧宽容，读侧由 client 轻校验把关）。全部通过 → 顶层固定路径 `z.object(...).default({}).volatile()` 方案成立，无需启用备选形态。

### 17.5 自检

`npm.cmd run check` exit 0；`npm.cmd run selfcheck` **126/126**（新增 5 条：client 动态层卡+chip+ops 红线+空态+纯函数 1 条、dynamic §9 快照折叠/schema 声明 2 条、dynamic §9.1 形状回归 1 条、need §14 六维 1 条；原「四维下拉」断言改为六维）。**验收补修（lead 发现）**：§9 fixture 曾用不存在的嵌套 `balance.window/amount/status` 形状（自证错误假设），`buildDynamicSnapshot` 已改为读 `routes[].balance` 真实扁平形状（mode/display/worst_used_pct/windows 顶层；display 缺失时按 windows[] 拼「label used_pct%」紧凑串），fixture 全部换成真实形状并加形状回归断言（含「函数体不得再出现嵌套键读法」的源码级检查）。

### 17.6 已知取舍

- **面板打开期间发生快照写入 → revision bump → 下一次保存走 `settings/conflict` 冲突重拉**（现有 onSave 冲突路径已覆盖：重拉+notice，用户改动不会被覆盖，但也需重新点保存）。TTL+内容变化双门槛已把频率压到最低。这是「client 只读镜像 + host 写回」方案的固有代价，接受。
- 快照 rows 只存非 ok 渠道：面板无法显示「确认为 ok」的正面确认，只能显示异常（零噪音优先）。
- `dynamic_snapshot` 落在 cordis.patch.yml（volatile 写回面），每次内容变化会长大 profile patch；rows 上限 = 非 ok 渠道数（≤渠道总数），体积可控。
- P5：model_ratings 对未知维度键 parse 不拒（z.dict 键侧天然宽容），依赖 client normalizeRatings 白名单把关——与 M4.7 行为一致，非新增风险。

### 17.7 遗留

- 面板真机交互（DynamicCard/chip 渲染、双语、空态引导）待 lead 浏览器实测（`set_bundle` 关→开热重载即可，无需宿主重启）。
- 快照写回真机验证：实调 model_route_query 后查 cordis.patch.yml 是否出现 dynamic_snapshot 段。

### 17.8 lead 验收（真机，2026-11-20 19:30）

**独立复跑**：`node --check index.js|client.js|lib/dynamic-state.js` 全 0；`npm.cmd run check` exit 0；`npm.cmd run selfcheck` **126/126 pass / 0 fail**。

**缺陷处置（我发现的字段映射 bug）**：初版 `buildDynamicSnapshot` 读 `balance.window/amount/status` 三个不存在的嵌套键（真实形状见 `lib/tool-query.js:969-994`：`{mode, remaining?, currency?, display?, windows?, worst_used_pct?, as_of, source, degraded}` 扁平），单测 fixture 同时用了错误形状 → 自证错误假设。已退回子会话修复：改读扁平键、fixture 换真实形状、加「源码级禁止嵌套键读法」形状回归断言（126/126 复绿）。

**映射真机复核（我用真机 quota 快照跑一次性探针，验完即删）**：`normalizeQuotaSnapshot` → `machineBalanceOf` → `dynamicStateOf`（阈值临时压到 1/1/¥40）→ `buildDynamicSnapshot`，输出三行：
- `zai-coding-cn` tight / `windows="5h 18% · 本周 9%"` / `worst_used_pct=18` / `low_balance=false`
- `opencode-go` tight / `windows="5h 17% · 本周 23% · 本月 11%"` / `worst_used_pct=23`
- `deepseek-official` tight / `windows=""` / `worst_used_pct=-1` / `low_balance=true` / `display="¥29.04"`（金额型语义正确）
→ ok 渠道全部被丢弃（零噪音）。

**面板真机自测（渲染内闭环，23 检查项）**：`panel.open copies=1`、`cards.count=9`（新增动态卡）、`panel.no_overflow {cards:9,overflowing:0,width:559,scrollWidth:559}`、`ratings.in_alias_card {rows:10,selects:60,options:",excellent,good,fair,none"}`、保存/冲突/语种/折叠项全 PASS。唯一 FAIL 是旧片段里 `ratings.four_dims` 断言（期望 `rows*4`，M4.9 已 6 维）→ 已把 `devtools/selftest-snippet.js` 该断言改名 `ratings.all_dims` 且期望 `rows*6`。

**动态层可视证据（`Regions.snapshot` 实读 DOM）**：
- 卡标题「动态层（最近一次查询） · Dynamic layer (last query)」；提示句「面板无法直连宿主，这里显示最近一次 model_route_query 写回的动态快照…快照只读，保存不会修改它。」
- 摘要「快照时间 · snapshot time 2026-11-20T11:32:04.375Z · 沉底 2 · 提示 0」
- 明细「⚠ zai-coding-cn — 本周窗口 9%（≥1% 沉底）」「⚠ opencode-go — 本周窗口 23%（≥1% 沉底）」
- 渠道卡 chips 出现动态 chip「⚠ 本周窗口 9%（≥1% 沉底）」，`color rgb(245,158,11)` / `background rgba(0.96,0.62,0.04,0.1)`（warn 色调）——与既有六枚 chips 并存不破坏布局。

**临时态与回滚**：为让告警 chip 有数据，测试期把 `window_week_tight_pct` 临时改成 `1`（patch 第 460 行）并热重载，验证 `model_route_query` 真机出现「动态紧张 → 沉底」（zai/opencode-go 降到 #4/#5）；随后从备份回滚到 `98/95`、热重载、再查一次 → 排序回 5 行基线、`dynamic_snapshot.rows` 回 `[]`（as_of 刷新）。`client.js` 的自测片段（临时接回）已从备份回滚，源码零 `SELFTEST` 残留；一次性脚本与备份文件全部删除，`tmp/m49-probe/` 只留只读 `probe.mjs`。




## 18. M4.10 动态层面板可见性修复（0.8.1-m4.9.1，2026-11-20）

### 18.1 用户反馈与两个缺陷

用户原话：「还是没有显示最后一次动态数据。」（任务书 §1）。M4.9 的 `DynamicCard` 有两处可见性缺陷：

1. **只有异常行才渲染**：`rows.length === 0` 时只显示空态引导，即便 `as_of` 有值——而「全部渠道安全」时 rows 恰好为空，于是「刚查过且全部正常」与「从没查过」界面完全一致。
2. **ok 行被过滤**：`buildDynamicSnapshot` 丢弃 ok 渠道，面板看不到各渠道的窗口百分比 / 金额余额读数，只剩 `⚠/·` 异常行，用户无法确认动态层在工作。

### 18.2 改动

| 文件 | 改动 |
|---|---|
| `lib/dynamic-state.js:126` | 新增 `export const DYNAMIC_STATES = ['ok','hint','tight','unknown']`（唯一四态闭集） |
| `lib/dynamic-state.js:128-178` | `buildDynamicSnapshot` 改为**保留全部 routes**（顺序 = routes 顺序 = 当前排序）；跳过非对象/空 channel_id 行；state 白名单外按 `ok`；ok 行 `reason:''`；`low_balance = state==='tight' && typeof metrics.balance==='number'`；windows/worst_used_pct/display 逻辑与扁平读法不变 |
| `lib/config-schema.js:256-273` | `dynamic_snapshot` 注释改为四值语义 + 全渠道快照 + M4.10 动机（schema 本体 274-285 行零改动） |
| `client.js:46-47` | `DYNAMIC_ROW_STATES` 四值闭集 |
| `client.js:127-136 / 239-248` | i18n zh/en 新增 `dynamicNormalCount`（正常/normal）、`dynamicOk`（正常/ok）、`dynamicUnknown`（未知/unknown）；`dynamicEmpty` 改为「尚未收到任何查询快照：在会话里执行一次 model_route_query 后回到本页。」；`dynamicHint` 改为「全部渠道的当前读数…与沉底、提示原因」 |
| `client.js:609-634` | `normalizeDynamicSnapshot`：state 四值白名单，其余回落 `ok` |
| `client.js:636-649` | `dynamicChipOf`：tight→`⚠ reason` warn；unknown→`? reason||未知` idle；hint→idle；ok/无行→null |
| `client.js:878-913` | `DynamicCard`：`as_of` 非空即 `hasSnapshot`；摘要加「正常 K」；四态 glyph `⚠ · ✓ ?`；detail=reason 或 ok/unknown 标签；读数 windows 优先、display 兜底，` · ` 连接 |
| `client.js:1259-1261` | 最简 CSS `.mroute-dynamic-summary` / `.mroute-dynamic-row`（tabular-nums + currentColor 透明度，无新主题 token） |
| `selfcheck/dynamic.test.mjs:283-344` | §9 改为保留全部 routes（4 行，含 ok 行全字段 + 容错输入）；新增四态归一用例（DYNAMIC_STATES 导出、unknown 保留原因与读数、未知值回落 ok 且丢 reason）；§9.1 扁平形状回归（含源码级禁 `balance.window/amount/status`）原样保留 |
| `selfcheck/client.test.mjs:545-642` | 三个渲染分支：as_of 空→空态；as_of 有值+全 ok→摘要「正常 2」+ `✓ … — 正常 · 读数`；含 tight→`⚠ … — 原因`；chips warn/idle；ops 仍 8 条不含 dynamic_snapshot；as_of 有值 rows 空→摘要且非空态 |
| `package.json` | version 0.8.1-m4.9.1（node 重写，防 PS 5.1 BOM） |

### 18.3 渲染分支（`as_of` 是唯一判据）

- `as_of` 非空 → **永远**先渲染摘要行，再渲染全部行：`快照时间 · snapshot time {as_of} · 沉底 N · 提示 M · 正常 K`（K = ok 行数）。
- 行：`tight→⚠`、`hint→·`、`ok→✓`、`unknown→?`；行尾为 `reason`（ok 为空）与读数（`windows` 优先，其次 `display`）以 ` · ` 连接；两者都空则不带行尾。
- `as_of` 为空 → 才显示空态新文案。
- 渠道卡 chip 同步四态：tight→⚠ warn；unknown→`? 未知` idle；hint→idle；ok/无行→不渲染。

### 18.4 自检

- `node --check index.js|client.js|lib/dynamic-state.js`：全 0。
- `npm.cmd run check`：exit 0（19 个文件）。
- `npm.cmd run selfcheck`：**128/128 pass / 0 fail**（M4.9 基线 126，+2：dynamic 四态归一 1 条、client 全 ok 分支 1 条；client.test 17/17、dynamic.test 16/16）。
- 覆盖点：全渠道保留（含 ok 行全字段）、四态归一与回落、扁平形状回归（源码级禁嵌套键读法）、as_of 空→空态、as_of+全 ok→摘要+✓ 读数、含 tight→⚠+原因、保存 ops 仍 8 条且不含 `dynamic_snapshot`。

### 18.5 真机纯函数自证

真机 quota 快照（`GET http://127.0.0.1:55802/plugins/dsh-quota/api/status`，200，refreshedAt=`2026-11-20T12:36:37.913Z`，平台 deepseek / zhipu / opencode-go×2 / xiaomi）→ `normalizeQuotaSnapshot` → `machineBalanceOf` → `dynamicStateOf`（阈值 98/95/10）→ 组装扁平 balance（与 `lib/tool-query.js:972-993` 同构）→ `buildDynamicSnapshot`，rows=5，五行原文：

```
✓ zai-coding-cn | state=ok | reason="" | windows="5h 25% · 本周 10%" | display="5h 25% · 本周 10%" | worst=25 | low=false
✓ opencode-go | state=ok | reason="" | windows="5h 19% · 本周 23% · 本月 11%" | display="5h 19% · 本周 23% · 本月 11%" | worst=23 | low=false
✓ deepseek-official | state=ok | reason="" | windows="" | display="¥28.90" | worst=-1 | low=false
✓ deepseek-account | state=ok | reason="" | windows="" | display="¥28.90" | worst=-1 | low=false
✓ xiaomi | state=ok | reason="" | windows="" | display="¥57.93" | worst=-1 | low=false
```

对照 M4.9：这 5 条 ok 渠道全部被丢弃（rows=[] → 面板只能显示空态）；M4.10 全部保留，ok 行 reason 为空、读数非空。脚本 `tmp/m410-probe/probe.mjs` 为一次性探针，验完即删。

### 18.6 分发校验

- `plugin_manager set_bundle target=@local/dsh-plugin-mroute`：enabled=false → `application:"applied"`；enabled=true → `application:"applied"`（热重载生效，无需刷新页面/重启宿主）。两轮都带宿主既有 warning「experimental-inspector: globalThis.fetch is an accessor…」，与本改动无关。
- `mroute-fetch-bundle.mjs`（`DSH_GUI_BASE=http://127.0.0.1:55802`）复算分发 rev = **e13d7a8f1f67**（digest `e13d7a8f1f67b8ae5bf7028feccbd6f8c3bf5c5f`，12 位试命中 200；分发 client.js 为 74030 bytes）。
- 分发产物关键字计数：`dynamicOk` 3、`dynamicUnknown` 4、`dynamicNormalCount` 3、`dynamicEmpty` 3、`✓` 2、`⚠` 4 —— 新分支确已进入 bundle。

### 18.7 已知代价

- 快照 rows 由「仅异常」变「全部渠道」（当前 5 行）：`cordis.patch.yml` 中 `dynamic_snapshot` 体积变大，且窗口读数每次刷新（5h/本周百分比变化）都可能触发写回，比 M4.9 频繁。仍受「rows 深比较变化 **或** as_of 超 30s」双门槛限制，TTL 内同内容不重复写。
- 面板打开期间发生快照写回 → revision bump → 下次保存走 `settings/conflict` 重拉（M4.9 固有代价，未变）。
- `dynamic_snapshot` 仍是只读镜像：保存 ops 恒为 8 条、不含该字段（selfcheck 有断言）。

### 18.8 lead 真机验收（2026-11-20 20:50，通过）

活数据链路：会话里跑一次 `model_route_query` → 宿主把全渠道快照写回 `cordis.patch.yml` 的 `dynamic_snapshot`（`as_of: 2026-11-20T12:48:26.143Z`，rows 5 行、全 `state: ok`、`reason: ""`：zai `5h 25% · 本周 10%` worst=25、opencode-go `5h 20% · 本周 24% · 本月 12%` worst=24、deepseek-official/-account `¥28.90`、xiaomi `¥57.93`）。

面板 DOM 实读（`cordis_inspect_query {platform:'client',provider:'Regions',method:'snapshot',input:{selector:'.mroute-dynamic-summary, .mroute-dynamic-row'}}`，matched=6）：

```
快照时间 · snapshot time 2026-11-20T12:48:26.143Z · 沉底 0 · 提示 0 · 正常 5
✓ zai-coding-cn — 正常 · 5h 25% · 本周 10%
✓ opencode-go — 正常 · 5h 20% · 本周 24% · 本月 12%
✓ deepseek-official — 正常 · ¥28.90
✓ deepseek-account — 正常 · ¥28.90
✓ xiaomi — 正常 · ¥57.93
```

- 卡体说明句已换成 M4.10 文案：「…显示最近一次 model_route_query 写回的动态快照：**全部渠道的当前读数（窗口百分比 / 金额余额）**与沉底、提示原因。快照只读，保存不会修改它。」
- 独立复跑：`node --check client.js` 0；`npm.cmd run check` exit 0；`npm.cmd run selfcheck` **128/128 pass / 0 fail**。
- 发布形态复核：临时接回的自测片段已整段摘除（apply 调用行与 inject 的 `layout`/`locale` 一并回退），client.js 回到 **81431 bytes**、源码零 `SELFTEST` 命中；重载后 `#mroute-selftest` 不存在、动态摘要照常显示 —— 干净包与临时诊断包行为一致。
- 过程留痕：本次自动点击序列只跑出 3 行（`open.launcher|PASS`、`open.menu.settings|FAIL|none`、`open.menu.nav|FAIL|none`），判定为「自动点开账号菜单偶发失效」，不当作产品缺陷；改走「面板已打开 + 类名 snapshot」取证（更快更稳），该经验已记入 AGENTS.md §7。

（原验收草案三项——「沉底 0 · 提示 0 · 正常 5」+ 五行 ✓ 读数、全部安全时渠道卡不出现动态 chip、保存一次不丢快照——均已由上面的 DOM 实读覆盖。）

## §19 M4.11 派发预检工具 mroute_dispatch_plan（0.8.2-m4.11，2026-11-20）

### 19.1 需求与定位

任务书 `docs/briefs/m4.11-dispatch-preflight.md`。动机：AGENTS.md §1「派发前必查 mroute」落到实操时，会话面对 `model_route_query` 的完整诊断表（routes[]/models_index/告警明细）仍要做一次「提取 provider/model → 填 assignee」的心智搬运。M4.11 补一个意图明确的窄面工具 **mroute_dispatch_plan**：头部数据新鲜度 + 每行可直接粘贴的 provider/model 字面值 + 用法/降级脚注。完整诊断表的职责不变，仍在 model_route_query。

### 19.2 落点表（文件 × 行号）

| 文件 | 改动 |
|---|---|
| lib/tool-query.js:514-710 | 新增导出 `assembleRouteTable({getRegistry,livecheck,logger,getQuota,readConfigValue,tierMin,excludeDegraded,capabilityKey,need})`：原 execute 内的装配体（registry→livecheck→quota→阈值→过滤→动态→rankChannels→routes map→picks 排序）原样上移为共享函数；model_route_query 的 execute 改为薄壳调用，dynamic_snapshot 写回与 DecisionRecord 留在原处。routes[] 键集合与顺序零变化（need.test §8 基线回归兜底） |
| lib/tool-dispatch-plan.js（新，306 行） | `createDispatchPlanTool`：入参 need（六维×fair/good/excellent，AND）/limit（1..10 默认 5，边界 clamp）/channel_type（monthly/voucher/prepaid 过滤）；**校验全部先于任何 IO**；输出结构化 `{queried_at,snapshot_at,freshness_seconds?,machine_count,pool_count,need?,channels[],notes[]}` + 中文「派发预检」文本（3 头+limit 行+2 脚） |
| index.js:23,116-127 | import + 平级 try 注册（不嵌套在 model_route_query 的 try 里——后者注册失败时本工具仍尝试注册，自身失败独立 logger.error 暴露） |
| lib/prompt-section.js:12-16 | SECTION_TEXT 改双工具指向：预检用 mroute_dispatch_plan、完整表用 model_route_query；补「全被拒省略 assignee 继承父路由」降级句 |
| client.js | text.previewDispatchHint 双语（zh/en）+ PreviewCard 第三行提示（沿用 mroute-preview-need-hint 类名） |
| selfcheck/dispatch-plan.test.mjs（新） | 8 组用例覆盖任务书 §3.5 六类 |
| package.json | 0.8.2-m4.11；check/selfcheck 两处加新文件（node 重写防 BOM） |

### 19.3 实现要点与取舍

- **复用而非复制**：routes 装配 100% 走 `assembleRouteTable`，排序口径与 ranking.js/model_route_query 零漂移——工具间排序漂移是本任务书点名的高危错误。need 匹配同样复用 matchingModelsOf 产出的 suggested_model；fit/min 由 ratingsForModel 现算（与 model_picks 同源公式）。
- **不伪造数值红线**：manual/unknown 渠道不编余额——行级 warnings 写「未核实/数据非机读（manual）」「无余额登记（unknown）」；machine 行按 amount（💰 ¥N）/window（🌕 正常、🌓 窗口告警）展示。
- **state 图标在 render 阶段重算**：初版曾把 state_icon 塞进 `__render` 旁路通道，结构化 channels[] 又剥离它——改为 renderDispatchPlan 按 state/display 推导（`^[¥$]`→💰；machine_tight/hint→🌓；machine→🌕），结构化输出只保留 state 枚举（machine/machine_tight/machine_hint/manual/unknown，与 balanceStateOf 同源）。
- **freshness_seconds 可省略键**：无 quota 快照时不发该键（宿主 schema 禁 type 数组/null 的 M4.8 教训延续：可空 = 单一 type + 缺席不发）；snapshot_at 空串 + notes 说明。
- **无匹配诊断**：missingDimsText 按 need 维度给 `维度:未登记 / 维度:无 / 维度:不足（最高 X）`（与 capability-need 的 none=0 / 未登记=null 严格区分）。
- **advisory-only**：无任何阻断；notes 提醒「need 无匹配渠道仍在列（标 ⚠），最终选择权在会话与用户」。

### 19.4 自检

- `npm.cmd run check` exit 0；`npm.cmd run selfcheck` **136/136 pass**（基线 128 + 新 8）。
- 新测试六类：①排序一致 ②need 命中/无匹配 ③limit clamp+channel_type ④非法入参先于 IO（Proxy 陷阱证明 getRegistry 未被调用）⑤新鲜度三档（60s 新鲜/400s 偏旧/无快照）+ 降级 stale ⚠ ⑥models 空 → 「（模型未登记）」+ model_route_sync_models 提示；另加文本渲染（3+3+2 行、💰/fit=min 行文）与 schema 单一 type 回归（`/"type":\s*\[/` 零命中）。

### 19.5 已知取舍

- machine_count 只统计 pool（channel_type 过滤后）内的 machine 行——头部行是「本清单内机读可用 N/M」，与全量诊断表口径不同属有意为之。
- 文本行不展示 routes[].note/review_alerts 长文案（预检追求可粘贴性；细节归 model_route_query）。
- limit 只裁展示行，pool_count 记全量——让会话知道被裁了多少。

### 19.6 lead 真机验收（2026-11-20 21:27）

- 独立复跑：`node --check`（index.js / tool-dispatch-plan.js / tool-query.js / prompt-section.js / client.js）全 0；`npm.cmd run check` exit 0；`npm.cmd run selfcheck` **136 tests / 136 pass / 0 fail**（基线 128 + 新增 8）。
- 真机实调（无参）：5 行，头部「quota 快照 2026-11-20T13:26:38.141Z · 新鲜（≤5 分钟）· 5/5 渠道机读可用」；`1. zai-coding-cn / glm-5.3 [monthly · domestic_sota · priority 90] 🌕 5h 31% · 本周 11%`、`2. opencode-go / qwen3.8-flash ... 🌕 5h 23% · 本周 25% · 本月 12%`、`3. deepseek-official / deepseek-flash ... 💰 ¥28.83`、`4. deepseek-account / deepseek-flash ... 💰 ¥28.83 ⚠ warning=disabled`、`5. xiaomi / mimo-v2.6-flash ... 💰 ¥57.93`。
- 带 need + limit：`need={coding:'excellent'}, limit=3` → 行内模型自动换成 `suggested_model`（opencode-go → `deepseek-v4.1-flash`），每行带 `fit=3 min=0`；行数被 limit 裁到 3。
- 非法入参（先于 IO）：`need={bogus:'excellent'}` → `Error: mroute_dispatch_plan: need 参数非法：未知能力维度 "bogus"（允许的键 coding|tools|long_context|vision|world_knowledge|orchestration）`。
- 回归：`model_route_query`（不带 need / `tier_min=domestic_sota`）排序、余额、归并视图与 M4.10 基线一致；`assembleRouteTable` 抽取后 `routes[]` 键集未变。
- 全局注册：host Inspect `Tool.listTools` 结果里 `mroute_dispatch_plan` 在列（与 `model_route_query` 同源注册方式，子会话同样可见）。
- 分发包：`mroute-fetch-bundle.mjs` 复算 rev `5b757c8afc55`、client.js 81952 bytes；直连 combo URL 命中 `previewDispatchHint` / 「派发预检」 / `mroute_dispatch_plan`。面板第三行提示行未做 DOM 抽验（类名 `.mroute-preview-need-hint`，用户下次打开设置页可顺带确认）。
- 结论：M4.11 通过，`AGENTS.md` §1 的「派发前必查 mroute」纪律自此有对应工具支撑（advisory-only，不阻断）。

## 20. 派发纪律的响应率对比测试（2026-11-21，AGENTS.md 纪律条移除后）

### 20.1 背景
- M4.11 交付后，「派发前必查 mroute」这条流程纪律一度写在 `AGENTS.md` §1。用户（m03316 / m03337）要求先确认它的生效面。
- 实测结论：**工具与 systemPrompt 提示句都是本 DSH 实例全局** —— `plugin-mroute/index.js:92-127` 的 `ctx.tools.register(...)` 不传 scope；`plugin-mroute/lib/prompt-section.js:22-26` 用 `ctx.systemPrompt.section({ name, order: 116.5, text })`，没有 workspace/scope 概念。
- 而 `AGENTS.md` 只在 `D:\Codes\DSH小插件` 生效，且本机不存在任何全局 AGENTS 文件（`D:\AGENTS.md`、`D:\Codes\AGENTS.md`、`C:\Users\sir_c\AGENTS.md`、`C:\Users\sir_c\.dsh\AGENTS.md`、`profiles\desktop\AGENTS.md` 全部 False）。
- 按用户裁决：保持现状（不动全局提示）→ 从 §1 移除该纪律条 → 做新会话响应率测试后再决定形态。

### 20.2 设计与样本
- **条件 A**：无 AGENTS 纪律，仅插件全局提示 + 工具；子会话继承父路由（`opencode-go/deepseek-v4.1-flash`），n=4（`ab-a1`…`ab-a4`）。
- **条件 B**：同条件 A，但显式 `assignee=zai-coding-cn/glm-5.3` 换一个模型族，测提示句的跨模型族遵守度，n=4（`ab-b1`…`ab-b4`）。
- 中性 prompt（不提及任何推荐工具）：派一个子会话，把 `D:\Codes\DSH小插件` 的一级子目录名写进 `%TEMP%\mroute-ab\out-{a,b}N.txt`，然后只回三行 `ASSIGNEE=<provider>/<model>|inherit`、`TRACE=<派发前调用过的工具名>`、`REASON=<≤30 字>`。
- 指标：**响应率 = 派发前主动调用 `mroute_dispatch_plan`（或 `model_route_query`）的会话占比**。

### 20.3 结果
| 条件 | 子会话模型 | 调用预检 | 产出文件 | 三行格式遵守 |
|---|---|---|---|---|
| A | opencode-go/deepseek-v4.1-flash | **4/4（100%）** | 4/4 | 4/4 |
| B | zai-coding-cn/glm-5.3 | **4/4（100%）** | 4/4 | 2/4（`ab-b1`/`ab-b4` 先答非所问，追问后各补一行） |

- 证据：8 个产出文件全部生成（`out-a1..a4` 167 B；`out-b1..b4` 164–167 B，内容均为 12 个一级子目录名）；8 份自报 TRACE 均为 `mroute_dispatch_plan`。
- 行为侧交叉证据：`ab-a1` 自报「预检首位渠道曾遭策略门拒，v4-pro 已实证放行」，即它先按清单填了首位渠道、被宿主策略门拒后按提示句的降级路径改填 `deepseek-official/deepseek-v4-pro`；B 组 ASSIGNEE 全为清单首位 `zai-coding-cn/glm-5.3` 且实际派遣成功。
- **局限（须记）**：①每臂 n=4、单次实验，非统计显著样本；②`mroute_dispatch_plan` **不写 decision log**（`lib/tool-dispatch-plan.js` 无 `decision`/`appendFile` 引用），故自报是主要证据，`session_search` 的机器化交叉核对超时未完成；③A 组启动时 §7 仍残留「A 已落地」历史句（随后已改为中性表述），属轻微污染。

### 20.4 结论与决定
- **工作区级 AGENTS.md 纪律条是冗余的**：移除后两个模型族仍 8/8 主动调用预检工具 → 行为由插件的全局提示句 + 工具驱动，文档层没有增量。
- 因此 §1 不恢复该纪律条；§7 的 M4.11 条目中 A 的描述已改为「从 §1 移除，只依赖插件全局提示句 + 工具」。
- 后续若要进一步强化（跨 DSH 安装、或更弱的模型）：优先做 **skill**（按需加载、不占常驻系统提示、可携带更长流程与示例），其次是扩写 `SECTION_TEXT`（常驻、占提示预算，插件停用即失效）；不建议把纪律散落到各工作区的 `AGENTS.md`。

## 21. 发布：使用细则 skill、会话审计、洁净室验证、GitHub 仓库（2026-11-21）

### 21.1 触发与侦察
- 用户（m03430）：「做使用细则skill，多模型会话审计，洁净室测试，确认有效好用后，发布到本DSH全局。所有都做完后，git，并建立github项目，把插件，设计文档，skill等全部上传并写好详细的首页项目说明。」
- 侦察事实：本工作区此前**不是 git 仓库**；`gh` 未安装（winget 可用，最终未用，改走 REST API）；GitHub API 可达；`DSH_HOME=C:\Users\sir_c\.dsh`；全局 skills 目录 `C:\Users\sir_c\.dsh\skills` 已有 4 个既有 skill。
- 体积实测（决定 `.gitignore` 边界）：gemini-eyes 657.5MB / 5515 files、plugin-orb-quota 227.5MB（去 node_modules+dist 后 32.6MB）、tmp 156.7MB、vendors 100.7MB、`mroute/tmp-plugins.json` 单文件 14.37MB。
- 密钥扫描：对 346 个候选源文件跑 `sk-/gho_/ghp_/xoxb-/AKIA/PRIVATE KEY` 模式 → **零命中**，才允许公开。

### 21.2 使用细则 skill（`skills/mroute-dispatch/`）
- 交付 4 文件：`SKILL.md`（84 行，description 393 字符，中文触发词）、`references/tools.md`（101 行）、`references/troubleshooting.md`（100 行）、`check.mjs`（145 行，零依赖）。
- 自检：`node skills/mroute-dispatch/check.mjs` → `OK`（frontmatter / name=目录名 / 触发词 / ≤160 行 / 无 tab / references≥20 行 / 无 `sir_c`·`C:\Users`·`sk-`·`Bearer`）。
- 事实核对：worker 按源码复核 5 处并修正 3 处行号 —— `lib/tool-dispatch-plan.js:18`（`TOOL_NAME='mroute_dispatch_plan'`）、`:21`（`FRESH_SECONDS=300`）、`:244-258`（校验先于 IO）；`lib/capability-need.js:14`（`RATING_RANK none0/fair1/good2/excellent3`）；`lib/config-schema.js:206-211`（`enforce_gate` 占位不接 `tools.guard`）。
- 全局发布（lead 执行）：`Copy-Item skills\mroute-dispatch → C:\Users\sir_c\.dsh\skills\mroute-dispatch`（4 文件 5597 / 7116 / 7596 / 7537 字节）。
- **生效证据**：宿主随即重发 skills 目录，本会话 catalog 出现 `mroute-dispatch`（描述为该 skill frontmatter 的触发词版本）——这是「已对所有工作区全局生效」的机读证据。

### 21.3 洁净室验证（无工作区指令文件时 skill 是否被自发加载）
- 洁净室：`C:\Users\sir_c\AppData\Local\Temp\mroute-cleanroom`（仅 `readme.txt` 20B，**无 AGENTS.md**，与工作区隔离）。
- 派 2 个全新会话（`clean-1`/`clean-2`，assignee `zai-coding-cn/glm-5.3`，cwd=洁净室），prompt 中性、不提示任何工具或 skill。
- 结果 **2/2**：两者均回 `SKILL_SEEN=mroute-dispatch`、`SKILL_LOADED=yes`、`PREFLIGHT=mroute_dispatch_plan`、`ASSIGNEE=zai-coding-cn/glm-5.3`（=清单首项）；产出 `out-c1.txt`（11B）、`out-c2.txt`（15B）均生成。
- 判读：**不是靠工作区 AGENTS.md 驱动**（洁净室没有），说明「skill 路由 + 插件系统提示句 + 工具」三件套在陌生工作区也能闭环。

### 21.4 多模型会话审计（`docs/09` + `plugin-mroute/devtools/audit-sessions.mjs`）
- 脚本 **997 行**（node 计数；PS 5.1 Get-Content 按 ANSI 解码会误报 949 行）、零依赖、只读；新增 --since <ISO> 固定窗口参数（--days 随运行时刻滑动、不可复现）；**本审计最大技术坑 = `session.v4.jsonl.zstd` 是多帧拼接**，`zstdDecompressSync` 只解第一帧（某 258964B 文件只解出 276B），必须按 RFC 8878 逐帧切分（magic `0xFD2FB528`）。
- 实测：95 会话 / **41799 事件** / 0 失败文件 / 1808ms。
- 合规分类：compliant 11、compliant_fallback 3、preflight_late 1、no_preflight 2、deviation 3、unknown 0、no_dispatch 75。
- **响应率 70.0%（14/20）**；查过推荐率 85.0%（17/20）；近 7 天（--since 2026-11-13T14:00:00Z 固定窗口，70 会话）**77.8%（14/18）**、查过推荐率 88.9%；滑动窗口 --days 7 复跑 75.0%~77.8%，量级一致。
- 按模型族：glm 66.7%（12 有派发）、deepseek 75.0%（8 有派发）。
- 预检工具分布：`mroute_dispatch_plan` 9 · `model_route_query` 8 · 未查 3；同渠道异模型 4 会话。
- 异常：宿主策略门拒绝 **10 次 / 4 会话**（被拒路由固定为 `zai-coding-cn/glm-4.6`、`deepseek-official/deepseek-chat`、`deepseek-account/deepseek-chat`，被拒后一律「省略 assignee 继承父路由」而非换下一项）；`unknown tool` 16 次 / 6 会话（含 M4.8 的 schema 注册期）；mroute 工具自身报错 3 次 / 2 会话。
- 结论解读（报告 §5.6）：未响应面主要不是「忘了查」，而是「查了但清单没被执行」；`mroute_dispatch_plan` **不写 decision log**（`lib/tool-dispatch-plan.js` 无写盘引用），审计只能依赖会话日志里的 tool_call 事件——已记为后续可改进点。

### 21.5 git 与 GitHub（公开仓库）
- `.gitignore`：排除 `tmp/`、`tmp-*`、`*.bak*`、`vendors/`、`gemini-eyes/`、`**/node_modules|dist|build|.venv|venv|release|out`、`*.tgz|zip|7z|zst`、二进制 `*.dll|*.node|*.so|*.dylib|*.exe|*.gif`、`plugin-orb-quota/packages/{helper/assets,voice/prebuilds}`、`.acl-recovery/`、`plugin-mroute/devtools/out/`。
- 首次提交 **`fff65e6`**（conventional commit），749 files；`git init -b main` + `core.quotepath false`（中文文件名不转义）。
- 远端：`https://github.com/orphiczhou/dsh-mroute`（**public**，REST `POST /user/repos` 创建），`git push -u origin main` 成功，`HEAD == origin/main == fff65e6`。
- 首页 `README.md`：定位 / 为什么需要它 / 核心特性表 / 排序与判定口径 / 四个工具 / 设置面板 / skill / 会话审计（含实测数字表）/ 安装 / 仓库结构 / 文档索引 / 开发与自检 / 设计红线 / 环境坑 / 许可；`LICENSE` = MIT（附「上游 fork 保留原声明」说明）。

### 21.6 凭据事件（须跟进）
- 排查 GitHub 认证时，一次性把 `~/.git-credentials` 内容打到了控制台 —— 其中含明文 github token（`orphiczhou:gho_…`）。后续所有调用均从文件读取、**不再回显**。
- 建议用户：①轮换该 token；②`credential.helper` 从 `store` 改为 `manager`（凭据进系统凭据库而非明文文件）。

## 22. M5-MVP-0：自动评测最小可运行版本（2026-11-20）

### 22.1 范围与开工顺序
- 正源 `docs/10-m5-eval-plan.md` §2/§3/§4/§5/§7/§8/§9 + 任务书 `docs/briefs/m5-mvp-dev.md`；先跑两个探针再写实现（任务书 §1）。
- 交付 8 项全部落地：①`lib/config-schema.js` 两顶层字段 + 探针头注 ②`lib/eval/suite-lite.mjs` ③`lib/eval/runner.mjs` ④`lib/eval/score.mjs` ⑤`lib/eval/store.mjs` ⑥`lib/tool-eval-run.mjs` ⑦`index.js` 第 5 个平级 try 注册 ⑧`selfcheck/eval-run.test.mjs` + `package.json`（0.9.0-m5.0）。

### 22.2 探针 A：schemastery 形状（脚本 `plugin-mroute/tmp/m5-probe/probe-schema.mjs`）
- `z.dict(z.object(真嵌套)).default({}).volatile()` 在顶层合法：空表 {} 通过、`.get()` 可读；六维 scores/dimension_status/suggest/probe 逐键 roundtrip；缺维回填 -1；`JSON.parse(JSON.stringify())` 再 parse 幂等；非法值解析期抛带路径错误；**未知键被保留（不 strip）**；含 `/` `.` 的 dict 键合法。结论直接写进 `lib/config-schema.js` 头注（M5 段），未走降级路径。

### 22.3 探针 B：`ctx.llm` 的 tools 注入（临时工具 `mroute_eval_probe`，实调后已删）
- `options.tools=[{name,description,parameters}]` **被 deepseek-official 与 xiaomi 两个 adapter 接受**，产出 `tool-call-delta` 与 `finish.kind='tool-calls'`（id/name/argumentsDelta 可解析）⇒ **tools 维 graded，未按计划降到 null**。
- 附带教训：maxTokens=64 + effort=max 时 reasoning 吃满（finish=max-tokens、text 空）→ 单题 maxTokens 必须显式并留 reasoning 余量；MVP 用**共同最高偏好档 high** 钉死，不用 plan 例子的 max。
- chunk 形状再次实证：usage 恒倒数第二块、finish 恒最后一块；`listModels()` 不含 reasoning，取档位用宿主 `ctx.llm.resolveModelInfo(provider,model)`（`:2221`）。

### 22.4 实现要点（相对计划的明确裁决）
- effort：`choosePinnedEfforts` 取参与模型 efforts 交集里的最高偏好档（顺序 high→max→xhigh→medium→low→minimal）；无交集逐模型各取自身档并标注；无 reasoning 面 → 不传（runner 以 adapter materialize 值回填 applied_effort，不算 mismatch）。
- 哨兵：`sentinelCheck(TASKS)` 用每题 fixture_pass/fixture_fail 自证（纯函数、零模型调用）；破 → 整轮不调用、不写分数，只把 `eval_status.state='failed'`。
- 成本闸：单题 maxTokens 来自题面（coding 1024 / tools·long_context·orchestration 512 / world_knowledge 256）、`max_calls` 默认 18 硬顶 40、默认只 prepaid（`allow_monthly:true` 才纳入 monthly；voucher MVP 一律排除）、日预算 200 次（当日 eval-history 非空行数）。
- 统计：`wilsonLowerBound`（z=1.96）；samples<12 → provisional=true 且 tier=''；`priority_delta = clamp(round(20*(composite-0.5)), ±10)`，且要求 coding/tools 下界 ≥0.55 才给；samples≥12 且总下界≥0.75 才候选 tier（MVP 不会触达）。
- 写回：只写 `model_eval[canonical]` 与 `eval_status`（`ctx.fiber.entry` + `ctx.get('configEditor').edit`，合并写保留其他 canonical；失败静默 → 只报 `eval_status_error`）；**永不写** channels[].tier/priority/model_ratings。
- 存储：`<DSH_HOME>/mroute/eval-history/<run_id>.jsonl` 一行=一次真实调用（skipped 不写）；`<run_id>.summary.json` 原子写（tmp+rename）。run_id=`eval-YYYYMMDD-HHmmss-<4hex>`，仅 [A-Za-z0-9._-]。
- 面板：client.js 只加**一行只读**「评测：<as_of> · 状态=… · run=… · note」（无按钮、不进 buildSaveOps）；host 侧 `Regions.snapshot` 验证因客户端 inspect 超时未取到（见 §22.7）。

### 22.5 自检与真机一轮
- `node --check` 5 新文件 + client/index/config-schema 全 0；`npm run check` exit 0；`npm run selfcheck` **150/150**（136 + eval-run 14 组：哨兵、finish 四态、超时 aborted、vision null/-1、provisional/suggest 上限、dry_run 零调用零写盘、allow_monthly 排除、canonical 去重、max_calls 截断+JSONL 行数、配置合并写、写回失败不抛、Wilson、run_id 安全、schema 无 type 数组、effort 裁决）。
- 热重载：`plugin_manager set_bundle @local/dsh-plugin-mroute false→true` 两轮 `application:"applied"`；`Tool.listTools` 全局可见 `model_eval_run`。
- 真机 `model_eval_run({dry_run:false, models:['deepseek-flash'], max_calls:6})` 首轮（修正前，`eval-20261120-230846-70cb`）：实调 5 次、JSONL 5 行、哨兵 5/5、samples=5（当时把 world_knowledge 当 graded）、composite=1.00；**lead 抽读指出两处 major 后修正复跑** → `eval-20261120-231846-e537`：实调 5 次、JSONL 5 行、**samples=4**、composite=1.00、world_knowledge=sentinel(1.00)、vision=null(-1)、suggest tier=''/delta=0（下界 0.21<0.55），写回 profile patch 已核（详见 §22.8）。
- dry_run 无参：3 个 prepaid 候选（deepseek-flash / deepseek-v4-pro / mimo-v2.6-flash）、计划 15 次、排除 2 个 monthly + 2 条跨渠道去重、今日已调用 0 次，文本含「（dry_run：未写盘、零模型调用…）」。

### 22.6 零耦合（硬验收）
- 5 个口径文件 SHA256 与改前**逐字节一致**：`lib/ranking.js` DCEF02E1…、`lib/tool-query.js` 2963CCFE…、`lib/tool-dispatch-plan.js` 7B247882…、`lib/registry.js` A755470C…、`lib/capability-need.js` 139FC0FA…（`lib/tool-eval-run.mjs` 只读引用 rankChannels/canonicalOf，不改其行为；`model_eval/eval_status` 走 readConfigValue 读，故 registry.js 无需改）。
- 输出 diff：改前基线 `%TEMP%\m5-eval-baseline\before-*.txt` vs 改后 `after-*.txt`，归一化 ISO 时间/¥金额/百分比后 **model_route_query 与 mroute_dispatch_plan 均 NORMALIZED-IDENTICAL**（原始差异仅为 quota 实时读数与时间戳）。

### 22.7 遗留风险 / 未做
- **面板视觉未验证**：`cordis_inspect_query` client 面 `Regions.snapshot` 带 input 被拒（“input” must be an object，与 AGENTS §4 记录一致），`Regions.outline` 10s 超时（页面未打开/未响应）→ 需用户打开设置面板后目视确认「评测：…」一行；代码/词典/热重载均已就位。
- MVP 摘要按轮覆盖（`samples` 为单轮**判分维**数 = 4，不跨 run 累积）；跨 run 累积与 12 题/维留给 M5.1。
- `probe.ttft_ms/tps/samples` 恒 -1/0（计划明确 MVP 不实采）。
- 真机只测 deepseek-official/deepseek-flash（策略门相关）；monthly 渠道与 xiaomi 未实跑（省钱），仅 dry_run 候选可见性验证。
- 日预算统计按文件 mtime 当日 + 非空行数；跨进程并发跑两轮时可能短暂低估（MVP 单会话串行，风险可接受）。

### 22.8 lead 抽读修正（2026-11-20，两 major + 两 minor）
- **MAJOR-1 world_knowledge 只当校准哨兵、不进 composite**：`suite-lite.mjs` 的 world_knowledge-1 加 `sentinel:true`（skip 仍 false，真跑一次留证据）；`runner.mjs` 每条记录带 `sentinel` 字段；`score.mjs` 对 sentinel 维写 `scores=正确率`、`dimension_status='sentinel'`，**不计入** samples/successes/gradedDimensions/compositeSum/wilson_lb；`DIMENSION_STATUS_VALUES` 与输出 schema enum 增 'sentinel'，config-schema 注释同步；报告文案改「4 道判分题 + 1 道校准哨兵 + 1 道 vision 恒 null」。**为什么不能计分**：6 题里「最高山峰」这类题多数模型必答对，属于近免费的维度，计入会让 composite 系统性抬高最多 +0.2，而 `priority_delta=clamp((composite-0.5)*20)` 会因此偏 +4——唯一可产出的 actionable 输出被污染。
- **MAJOR-2 tier 只给相对上一档**：删除 `tier='domestic_sota'` 硬编码，新增 `TIER_NEXT`/`nextTierOf()`；`aggregateModel` 收 `currentTier`（tool-eval-run 的 buildCandidates 已有 `target.tier`，经 resultRowOf 传入）：bulk→domestic_sota、domestic_sota→overseas_sota、overseas_sota/未知→不提。原实现会让 bulk 模型「跳两级」、overseas 模型反而「降级」。
- **MINOR-3 实跑前先写 running**：runSuite 之前 `persistEval(..., {summaries:null, evalStatus:{state:'running', run_id, as_of, note:'进行中'}})`，结束照旧覆盖 ok/failed；写失败只进 notes 不阻断。否则「跑了 60 秒」与「从未跑过」在面板上同形（M4.10 教训）。
- **MINOR-4**：本小节即记录（行为变化 + 世界知识为何不能计分）。
- 自检：`npm run check` exit 0；`npm run selfcheck` **152/152**（150 + §15「哨兵答错不影响 composite/delta」+ §16「tier 三档相对建议 + 顶格不提」；§5/§9 断言同步改为 samples=4、world_knowledge='sentinel'、写回两次 running→ok）。
- 真机复跑 `eval-20261120-231846-e537`（`{dry_run:false,models:['deepseek-flash'],max_calls:6}`）：实调 5 次、JSONL 5 行（world_knowledge 行 `sentinel=true`）、**samples=4**、composite=1.00、dimension_status：coding/tools/long_context/orchestration=graded、**world_knowledge=sentinel**、vision=null、suggest `tier=''`/delta=0、写回 eval_status(state=ok)。
- 零耦合复核：5 文件 SHA256 与改前逐字节一致（清单见 §22.6）；`model_route_query`/`mroute_dispatch_plan` 归一化后仍 **NORMALIZED-IDENTICAL**。

## 23. M5.1 正式评测（formal/1 题集 + 六维分级报告，2026-11-21）

### 23.1 需求

用户（m03767）：「进行模型正式评测，评测后结果按照我们的能力配置参数分级做报告给我看，需我统一才能更新。」
→ 三条硬约束：正式题量（够算 per-dim Wilson）、按我们自己的六维量表（excellent/good/fair/none）分级、**用户确认前不得写能力配置**。

### 23.2 交付

| 文件 | 变化 |
|---|---|
| `plugin-mroute/lib/eval/suite-formal.mjs` | 新增 `SUITE_VERSION='formal/1'`，39 题：coding 10 / tools 10 / long_context 10 / orchestration 6（graded）+ world_knowledge 2（哨兵）+ vision 1（恒 null、零调用）= 38 次调用/模型 |
| `plugin-mroute/lib/tool-eval-run.mjs` | 新增入参 `suite`（`enum:['lite','formal']`，缺省 `'lite'` 向后兼容；单一 type 字符串 + enum，遵守宿主 schema 限制） |
| `plugin-mroute/lib/eval/score.mjs` | 新增 `suggestRating`：`excellent ⇔ lb≥0.75 且 p≥0.92`；`good ⇔ lb≥0.55`；`fair ⇔ p≥0.30`；`none ⇔ p<0.30`；`无数据 ⇔ n<6` |
| `plugin-mroute/selfcheck/eval-formal.test.mjs` | §F1–F7：题量/维度分布、每题 fixture 双向自证、取档边界、`suite` 缺省 lite |
| `docs/12-model-eval-report.md` | 报告（11653 bytes，141 行）：方法、逐模型逐维 p/lb 原始数字、★ 六维分级表、与 `model_ratings` 的差异表、等用户拍板 4 项 |
| `docs/briefs/m5.1-formal-eval.md` | 任务书（本次派发正源） |
| `package.json` | `0.9.0-m5.0` → **`0.10.0-m5.1`**（lead 补；worker 漏 bump） |

### 23.3 实际执行

四个 prepaid 模型 × 38 次 = **152 次调用**（日预算 200，余 48）；effort 钉死共同档 `high`；串行；单模型 `max_calls:40`。
run_id 与落盘（`C:\Users\sir_c\.dsh\mroute\eval-history\`）：

| 模型 | 渠道 | run_id | 调用 | samples | composite | wilson_lb | 总体档 |
|---|---|---|---|---|---|---|---|
| deepseek-flash | deepseek-official | `eval-20261121-191929-85ae` | 38 | 36 | 1.00 | 0.9036 | excellent |
| deepseek-v4-pro | deepseek-official | `eval-20261121-192023-38d2` | 38 | 33 | 1.00 | 0.8957 | excellent（raw 口径 good） |
| mimo-v2.6-flash | xiaomi | `eval-20261121-192341-671a` | 38 | 35 | 0.90 | 0.7762 | good |
| mimo-v2.6-pro | xiaomi | `eval-20261121-192812-5812` | 38 | 36 | 1.00 | 0.9036 | excellent |

**唯一实质弱项**：`mimo-v2.6-flash` 的 orchestration 3/5（两题只输出 1 项计划，实测判错；另 1 题答满 512 tokens 截断）。
**截断**：`deepseek-v4-pro` 3 题（coding-2、coding-10、orchestration-2）答满 maxTokens，按现行口径记 `invalid`、不计入 samples（raw 口径下其总体档从 excellent 降 good）。

### 23.4 lead 独立复核（非转述）

1. `npm.cmd run check` **exit 0**（check 链已含 `suite-formal.mjs`）。
2. `node --test selfcheck/*.test.mjs` → **tests 159 / pass 159 / fail 0**。
3. **题集自证**：`node -e` 导入 `suite-formal.mjs`，39 题、`{coding:10,tools:10,long_context:10,orchestration:6,world_knowledge(sentinel):2,vision:1}`；逐题 `grade(fixture_pass).pass===true && grade(fixture_fail).pass===false` → **38/38 PASS**（`vision-1` 为 `skip` 计时占位，无判分器，属预期）。
4. **从 JSONL 独立重算**（不经 worker 的 summary）：

| run | coding | tools | long_context | orchestration | 哨兵 |
|---|---|---|---|---|---|
| flash | 10/10 graded | 10/10 | 10/10 | 6/6 | 2/2 |
| v4-pro | 8/8 graded + **2 invalid** | 10/10 | 10/10 | 5/5 + **1 invalid** | 2/2 |
| mimo-flash | 10/10 | 10/10 | 10/10 | **3 pass / 2 fail**（n=5）+ 1 invalid | 2/2 |
| mimo-pro | 10/10 | 10/10 | 10/10 | 6/6 | 2/2 |

与报告 §2 表逐格一致。
5. **零耦合**：`git diff --stat` 对 `ranking.js` / `tool-query.js` / `tool-dispatch-plan.js` / `registry.js` / `capability-need.js` **为空**。
6. **未写能力配置**：`cordis.patch.yml` 的 `model_ratings` 8 个规范名条目保持原样（deepseek-flash / deepseek-v4-pro / glm-5.3(-flash/-highspeed) / mimo-v2.6-flash / mimo-v2.6-pro / qwen3.8-flash）；本轮写入仅 `model_eval.<canonical>` 与 `eval_status`（测量记录层）。

### 23.5 已知边界（写进报告 §3/§6）

- **单维 excellent 在本轮样本量下不可达**：10/10 全对时 Wilson 95% 下界仅 **0.7225**（6/6 为 0.6097），而 excellent 门槛是 0.75；要单维 excellent 需 n≥13（13/13 时 lb=0.7655）。因此分级表里四个 graded 维全是 `good ★★`，**这是统计保守性，不是能力结论**；横向比较应以「总体 composite + wilson_lb」为准。
- **截断口径**：现行 M5 设计把 `finish.kind` 不在白名单的作答记 invalid 并**剔出 samples**（截断≠答错）；raw 口径对照已在报告 §2/§3 给出，供用户裁决。
- **vision 恒 null**（宿主把图投影成文本占位）；**world_knowledge 仅哨兵**（2/2 全对，判分器可信，不计档）。
- 未做：`suggest` 的人工「确认采纳」入口、tier 写回、面板分级展示。

### 23.6 待用户裁决（报告 §6）

1. 实测档是否回写 `model_ratings`（建议：人工登记=用户判断层、实测=机器证据层，**并行展示不自动覆盖**）。
2. 截断是否计入分母（若「预算内答不完=能力不足」，需改 score 口径）。
3. 4 条 `suggest.tier`（deepseek ×2 → overseas_sota；mimo ×2 → domestic_sota）均 advisory、未应用。
4. 是否扩题量到 ≥13/维，让单维能出 excellent。
