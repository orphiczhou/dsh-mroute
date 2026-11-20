# 04-mvp-notes.md — mroute MVP（mvp1-M）Day 1 实测与实现笔记

- 树节点：mvp1 / leaf：mvp1-M-mvpdev
- 日期：2026-11-13
- 性质：MVP 技术可行性测试切片的实测记录与实现笔记（Day 1 实测结论 + 降级预案 + 偏离清单）
- 上游引用：`mroute/07-assembly-plan.md` §3（M1 开工方案）、`mroute/00-feasibility-report.md` §3.1/§4、`AGENTS.md` §4 环境坑

---

## 1. Day 1 实测：schemastery 嵌套对象（07 方案 §3.2-3 指定的唯一环境风险点）

### 1.1 环境锚点（证据）

| 项 | 值 | 证据 |
|---|---|---|
| 宿主捆绑 schemastery | **@deepseek-ai/schemastery@3.19.0** | asar `dsh/node_modules/@deepseek-ai/schemastery/package.json` version=3.19.0（read 工具读取） |
| npm 可达性 | 同名同版本包公开发布 | `npm view @deepseek-ai/schemastery versions` 输出含 `3.19.0`；上游 `schemastery` 为 3.18.0（未用，避免版本错位） |
| Node | PATH `node` = v24.20.0 | `node -v` 实测；`D:/DSHarness/resources/runtime/bin/node.exe` **不存在**（AGENTS.md 所记捆绑 node v24.21.0 路径与本机不符）——以 PATH node 为准，同为 Node 24，`node --check` 行为一致 |
| 探针位置 | `tmp/day1-schemastery-probe/` | `package.json`（依赖 exact 3.19.0）+ `probe.mjs`（主探针）+ `probe2.mjs`（volatile 读回探针），`npm install` 后 `node probe.mjs` 可复现 |

> 探针用 **exact 3.19.0（与宿主捆绑逐字节同版本号）**，比任务书写的上游 `schemastery` 更贴近目标环境；07 方案 §3.2-3 要求的「目标 DSH 版本实测」以此近似（宿主 loader 内嵌行为仍以 lead 安装实测为准，见 §2.3）。

### 1.2 探针结果（原始输出摘录）

`probe.mjs`：

```
pkg-version	(no z.version)
z.record	undefined
z.dict	function
z.any	function
A.validate	ok manual-keys=quota_total|quota_used_est|note manual-roundtrip=identical channel-roundtrip=identical fallbacks=["deepseek-official"] count=2
B.partial-defaults	channel_type=prepaid tier=domestic_sota priority=50 manual={"quota_total":"—","quota_used_est":"—","note":""} models=[]
C.zany-nested	{"a":1,"b":{"c":2}}
D.record	absent
D.dict	{"a":1}
E.top-level-volatile	type=function flag={}
E.array-field-volatile	type=function flag={}
E.nested-object-volatile	type=function
E.in-array-element-volatile	THROW: $.*.a volatile fields require a fixed object path without an enclosing volatile field
E.channels-array-volatile-in-registry	type=function count=undefined manual-note=undefined typeofManualNote=undefined
```

`probe2.mjs`（channels[] 标 volatile 后的读回）：

```
typeof-channels	object
has-get	true
get-returns-array	true
get-length	1
get-manual-roundtrip	identical
get-channel-roundtrip	identical
dual-face-read	ok
dual-face-plain	ok
```

### 1.3 结论（编号供引用）

- **C1（核心，Q1）**：`z.array(z.object({...含嵌套 z.object manual{}...}))` 经 schema 校验后**逐键存活，字节级一致**（A.validate manual-roundtrip=identical）。→ **注册表用真嵌套对象，不降级 JSON 字符串**。07 方案 §3.2-3 的「嵌套降级预案」在本版本**不触发**。
- **C2（Q2）**：`z.record` 仍缺失（undefined）；`z.dict` 存在且校验可用（D.dict {"a":1}）。→ 07c 所记「部分构建缺 z.record」在 3.19.0 仍为真；**MVP 不使用 record/dict**（固定形状字段足够）；M2 若需 capability 映射可考虑 `z.dict`，需再测。
- **C3（Q3）**：`z.any` 的嵌套对象在 3.19.0 **存活**（C.zany-nested 完整返回）——07c 所记旧版丢对象坑未见复发。但 MVP 仍**不用 z.any**：固定 z.object 形状利于校验、设置面板渲染与演进兼容（07 §3.2-9）。
- **C4（Q4）**：`.volatile()` 合法落点实测——
  - 顶层字段：合法；
  - 数组字段（`z.array(...).volatile()`）：**构造合法**，但解析值变为 **Volatile 访问器**（count=undefined），须经 `.get()` 读回（probe2：get-returns-array=true、内容字节级一致）；
  - **数组元素内字段：明确抛错** `"volatile fields require a fixed object path without an enclosing volatile field"`——宿主级禁令的 schema 层实锤（autotier AGENTS.md「never inside an array, dict or union」同源）。
  - → 落码：`channels` 整体标 volatile（整条替换语义，07 §3.2-1/2）；`fallbacks[]` 在元素内**不标** volatile（实测抛错）；`registry_version/reviewed_at/reviewed_against` 顶层标 volatile。
- **C5**：Volatile 引用与裸值的**双面读取** helper（`v && typeof v.get === 'function' ? v.get() : v`）两类输入均正确读回（dual-face-read/plain ok）。→ apply 内统一走该 helper（autotier `resolveConfig` 接受双面同款模式，`vendors/PerryLink--dsh-autotier/src/config.ts` 设计出处）。
- **C6（B）**：部分输入默认值回填正常（B.partial-defaults：整条只给 id/routeProvider 时，channel_type/tier/priority/manual 全部按 schema default 回填）——设置面板「整条替换」语义的形状基础成立。

### 1.4 07 方案 §3.2 九要点 → MVP 落点对照

| # | 要点 | MVP 落点 |
|---|---|---|
| 1 | 可编辑字段各自 `.volatile()`，禁整表 volatile dict | `channels`（数组整体）+ 顶层三个复核锚字段各自 volatile；无 dict |
| 2 | 数组自身 volatile 后元素字段不再标；整条替换语义 | C4 实测合规；channels[] 按整条替换（fallbacks 编辑=改整条 channel 后整表替换） |
| 3 | 嵌套对象先实测，不过则降级 JSON 字符串 | **实测通过（C1）→ 不降级**；结论回写 `config-schema.js` 头注 |
| 4 | eval 子对象预留（M5 填充清单冻结） | MVP 注册表**不建** eval 字段（任务书 MVP 字段清单未列）；M5 填充清单仍以 07 §3.2-4 为准，`registry_version` 驱动读侧兼容（要点 9）承接未来演进 |
| 5 | 校验分层：schema 管形状、读时管语义 | schema 管枚举/类型/default；读时校验（悬空 fallbacks 告警、活校验 provider 交集）在 `registry.js` 读侧做，不拒写 |
| 6 | routeProvider 命名纪律 | 落码用 `routeProvider`（任务书「provider」为简写；transportProvider v1 不设，注释注明） |
| 7 | 凭据用 credential-ref 角色 | **MVP 无凭据面**（无 HTTP、无密钥；红线），该要点 M2 生效，schema 暂不含凭据字段 |
| 8 | 复核锚三件套 | `registry_version`（default 1）/ `reviewed_at` / `reviewed_against`（default 'initial seed 2026-11-13'）；MVP 无指纹锚（M5 起） |
| 9 | schema 演进兼容（registry_version 驱动） | 读侧对缺 manual 视为 unknown、缺字段用 default 回填（C6 兜底）；版本号入返回 meta |

### 1.5 降级预案（本实测不触发，留档备查）

触发条件：lead 安装实测发现宿主 loader/设置面板对「数组 volatile + 嵌套对象」的行为与 npm 3.19.0 探针不一致（如 manual{} 键在面板保存后丢失、或 volatile 更新后 .get() 读不到新值）。

操作：`config-schema.js` 中 `manual: z.object({...})` 换为 `manualJson: z.string().default('{}')`（route-pin `stepsJson` 同款降级，07c§4-D 实录），读取侧 `JSON.parse` + try/catch 回退 `{}`；`registry_version` +1 标注 schema 变更。探针与安装实测差异必须记入 04-mvp-notes.md 追加章。

### 1.6 可复现命令

```
cd tmp/day1-schemastery-probe
npm install        # 装依赖（package.json 已钉 exact 3.19.0）
node probe.mjs     # 主探针（Q1-Q5）
node probe2.mjs    # volatile 读回探针
```

---

## 2. 实现笔记与偏离记录

### 2.1 排序引擎（任务书三级排序的落码口径）

- 一级键 `channel_type`：`monthly=0 < voucher=1 < prepaid=2`（07 §3.5 L1 静态层真源，governor credit_first 改造）。
- 二级键 `tier`：`overseas_sota=0 < domestic_sota=1 < bulk=2`（SOTA 优于 bulk；任务书未给方向，此为落码裁决，notes 记录）。
- 三级键 `priority` **降序**（大者前，07 §3.5 伪代码 `b.priority - a.priority`）。
- 兜底 `id` 字典序（全序确定性）。
- **livecheck 惩罚**：活校验 provider 不存在的渠道标 `livecheck:"unknown"` 并**全局沉底**（排在全部正常渠道之后，rank 照发、reason 标注降权原因）——任务书「标 unknown 降权」的落码；不进 excluded（任务书是降权不是剔除）。
- L2 账本 mask / L3 感知层：**MVP 不做**（红线外），排序函数保持纯函数可重放。

### 2.2 活校验（route-pin 双 TTL 的 MVP 简化）

- 单 TTL 60s（任务书允许的简化；成功与失败结果都缓存 60s，键=`routeProvider`）。
- 保留 route-pin 核心纪律「**catalog 读不到 ≠ 校验通过**」：`llm.listProviders()/listModels()` 抛异常时不写缓存、该渠道当场按 unknown 处理（`vendors/tkaiz0406--dsh-subagent-route-pin/index.js:871-903` L879-884 注释教训）。
- 模型级校验：注册表 models[] 与 `listModels(provider)` 交集为空 → note 标注「模型目录未列出（可能仍可用）」，不降权（DSH catalog 是建议性，route-pin L867-869 同判）。

### 2.3 偏离 07 方案 / 任务书之处（逐条 + 理由）

| # | 偏离 | 理由 |
|---|---|---|
| D1 | 字段名 `provider` → `routeProvider` | 非偏离：任务书为简写；07 §3.2-6 双命名空间纪律是定稿口径 |
| D2 | 工具入参 `capability` 保留但为 no-op | 注册表 MVP 字段清单无 capability 数据可滤；no-op + reason 标注「capability 过滤未生效（注册表无能力数据，M2 接入）」。zai 的 coding 强项写入种子 note（任务书种子要求） |
| D3 | 返回结构在任务书字段清单外增补 `channel_id`/`livecheck`/`excluded`/`current`/`meta` | 增不改：channel_id 支撑 fallbacks 引用；livecheck 机读降权状态；excluded 留痕（07 B7 DecisionRecord 纪律 MVP 版）；current 供模型对照（R10 模式）；meta 带复核锚。全部为机读字段，不扩 systemPrompt 文案 |
| D4 | `eval{}` 不建（07 §3.2-4 说 M1 预留） | 任务书 MVP 注册表字段清单未列 eval；预留位以 `registry_version` 兼容路径承接（§1.4-9），避免 MVP schema 与面板展示引入无用空对象 |
| D5 | 不含 `balance{}`/`credential_ref` 等适配器字段 | MVP 红线：无 HTTP 无凭据面；M2 落契约时再加（07 §3.2-7 credential-ref 角色届时生效） |
| D6 | livecheck 缓存未做「失败短 TTL」双档 | 任务书明示 MVP 可简化单 TTL 60s；「读不到不缓存」纪律保留（§2.2） |
| D7 | Config 不含 `balance_source` 显式字段 | balance_source 是**查询时派生量**（manual 有登记→manual，否则 unknown），不是注册表存储字段；任务书清单中它出现在工具返回而非注册表字段清单 |

### 2.4 红线自查锚点（详见 docs/04-mvp-selfcheck.md）

- 无 `llm/stream`、`agent/request`、`system-prompt/assemble` 监听（唯一提示注入 = `ctx.systemPrompt.section()`，practices.md L17 允许的最弱机制）；
- 无 HTTP 出站、无凭据读写、无密钥面；
- 无 UI/评测/写回/configEditor 调用；
- 不做 install_bundle（lead 亲自装）。

---

## 3. lead 安装实测指引（摘要；完整清单见 docs/04-mvp-selfcheck.md §5）

1. `plugin_manager {action:"install_bundle", target:"D:/Codes/DSH小插件/plugin-mroute"}`；
2. 预期验证点：新会话 systemPrompt 出现「派遣子会话前先调用 model_route_query」段；调用 `model_route_query {}` 返回 5 渠道排序表（zai-coding-cn 第 1，monthly 档在前，prepaid 沉后）；把某 channel 的 routeProvider 改成本机不存在的值→该条沉底且 reason 带 unknown 标注；设置面板编辑 channels 不丢 manual 子键（§1.5 降级预案的触发观察点）。
