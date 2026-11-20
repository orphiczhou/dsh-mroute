# mroute M3 任务书（设置面板编辑：可视化模型注册表编辑器）

> 派发：lead（2026-11-15）。执行者：m3-dev（独立 DSH 会话，看不到父会话历史）。
> 基线：mroute 0.3.0-m2.0 已收口（quota 数据源接入，lead 实测通过，当前安装于 desktop profile）。M3 目标 = 给它长出设置面板 UI：在 DSH 设置页挂「模型路由」分区，可视化编辑渠道注册表与参数，保存后 `model_route_query` 立即读到、重启仍在。开工先读 AGENTS.md。

## 1. 背景（一句话）

mroute 是 DSH 多子会话派遣的模型选择 advisory-only 建议器（不阻断/不改写/不代决策——方向红线）。M1/M2 交付了静态注册表+查询工具+quota 机读余额（balance_source=machine），注册表数据全部承载在插件自有 Config（channels[] volatile 数组 + 顶层参数）。M3 按 `mroute/03-ui-panel-feasibility.md` 的推荐形态①交付设置面板：bundle 增 Client 半，注册 `settings.section` 分区，React 手写编辑器，走 settings 写链（validate→mutate→revision 冲突→profile patch 持久化→volatile 热更）。

## 2. 必读文件（按序）

1. `D:\Codes\DSH小插件\AGENTS.md` —— 纪律/红线/环境坑（§4 全部）
2. `mroute/03-ui-panel-feasibility.md` —— **本任务书的方案正源**（A 节源码级挂载机制含行号、B.0 Client→Host 通道清单、C 节持久化链路、E.2 推荐形态+保存链路图、E.3 工程注意 4 条）
3. `plugin-mroute/lib/config-schema.js` + `lib/tool-query.js` + `lib/registry.js` —— M2 现状数据层（channels[] volatile 数组、manual 三值、quota_platform/verified、low_balance_threshold_cny/quota_cache_ttl_seconds）
4. `plugin-mroute/index.js` + `package.json` + `cordis.patch.yml` —— bundle 结构现状（host-only；M3 增 client 半）
5. `docs/05-m2-devlog.md` —— M2 实现记录（含 verified 种子语义：zai=false 包月≠API 账户、deepseek×2=true 同源、xiaomi=true id 对齐——**面板不得提供把这些语义改错的顺畅路径，verified 开关旁须显示当前依据提示**）
6. asar 内 dsh-doc skill（基目录以 skill 工具实报为准）的 `references/ui-plugin.md`（Client manifest/module loader/React 形态）、`references/practices.md`（UI 节：theme tokens、禁 import 宿主 UI 包、slot 纪律）、`references/plugin-details.md`（locale 细节）、`templates/decoration/client.js`（client 模块形状模板）
7. vendors 参考源码（MIT，改造借鉴标注 NOTICE）：dsh-orb 的 settings.section 注册（order:25 先例，03 E.1 表实证）；宿主 subagent 授权模型清单页（多选+保存+冲突+热更同构先例）与 Models 页挂载（03 A.2 逐行）——两者在 asar 内 node_modules 运行时 JS，read 探测

## 3. 已验证技术事实（lead 侦察 2026-11-15，可直接引用）

1. **挂载机制**：设置面板是 slot 体系；第三方注册 `settings.section` 是一等公民机制（dsh-orb order:25 运行中实证）。mroute 分区建议 id:"model-route"，order 落 models=10 与 orb=25 之间（取 15-20）。最小注入面 `inject:['slots']`（client 侧）。
2. **保存链路**（03 E.2 图，照此实现）：`configForms.describe()` 镜像读 → `settingsSchema.validate(schema, draft)` 客户端第一道 → `configForms.get(ns).mutate(ops, draftRevision)` 串行队列 → `remote.settings.mutate` → `ctx.settings.write` volatile 路径校验 + revision 冲突检查（SETTINGS_CONFLICT → settings/conflict 事件）→ `configEditor.edit` → profile patch 持久化 → volatile 热更 → `settings/document-updated` 广播 → `model_route_query` 立即读到。
3. **volatile 硬约束**（E.3.1）：可 UI 编辑字段必须 volatile；禁止「volatile 字段套 volatile 父级」（validateVolatileSchema 报错）；dict 动态路径不可 volatile。**M1 定案的 channels[] 数组整体 volatile 是合法形态**（AGENTS §4 Day1 实测 roundtrip identical，.get() 读回完整），且数组整替语义（E.3.2：mergeLayers 对象递归合并、数组整替）天然匹配列表编辑——但「settings 写链对 volatile 数组路径的真实接受度」未在真机 settings UI 链路验证过，是本任务**第一技术风险**（见 §6 问题 1 的 spike 要求）。
4. **M2 Config 现状**：channels[]（volatile 整替，5 渠道种子）+ low_balance_threshold_cny（volatile，缺省 10）+ quota_cache_ttl_seconds（volatile，缺省 60）+ enforce_gate（opt-in，默认 false）+ advisory 提示等。manual 三值闭集 active|disabled|exhausted。
5. **密钥纪律**：面板如展示渠道 key 状态，只做侧牌（set/unset，经 remote.credentials.describe），**值不过读线**（03 链路图末行）；mroute 不读不存任何密钥值。
6. **宿主策略门现状**（AGENTS §7 实录）：子会话显式 assignee 大多被拒（zai-coding-cn/glm-4.6、deepseek-official/deepseek-chat、deepseek-account/deepseek-chat 全拒）；orb-quota 项目实录 deepseek-official/deepseek-v4-pro 曾可用（放行面不一致）。**派遣省略 assignee 继承父路由是 proven 降级路径**。
7. **inspect 限制**：本 build cordis_inspect_query 带 input 被拒（只能无参 catalog）——slot 树实查受限，按 03 A 节源码行号 + vendors 先例走。
8. **版本**：M3 交付 0.4.0-m3.0；上游存档（mroute/00-07d）不回改，方案依据引用 03 章节号。

## 4. 交付物

### A. Client 半（新增，本任务主体）

1. **bundle 增量**：package.json 增 `dsh.client` 声明（按 ui-plugin.md 的 manifest 形状）+ client 入口模块 + `locale/` 词典（zh/en 必做；其余语种机械翻译可选，保守跟随宿主 8 语种惯例）。
2. **settings.section 分区**「模型路由」（id:model-route，order 15-20）：
   - **渠道卡片列表**（读 configForms describe 镜像）：每渠道可编辑——manual.status 三值（下拉闭集）、quota_total/quota_used_est/note（文本）、quota_platform（文本+空=不接提示）、quota_account_verified（开关，旁挂依据提示文案：zai=「包月订阅≠API 账户，勿轻易开」、deepseek=「2026-11-15 用户澄清单一源」、xiaomi=「id 对齐+实测背书」）、priority/tier/channel_type（枚举下拉）、fallbacks/models（列表编辑，数组整替）。id/routeProvider 只读展示。
   - **顶层参数表单**：low_balance_threshold_cny、quota_cache_ttl_seconds、enforce_gate（开关 + 「advisory 红线：默认关，开启即启用阻断语义，与方向红线冲突需谨慎」警示文案）。
   - **保存**：validate→mutate（draftRevision）→ 成功提示「已生效（model_route_query 立即可读）」；冲突（SETTINGS_CONFLICT）提示重拉镜像不覆盖他人修改。
   - **渠道 key 侧牌**（P1 加分）：经 remote.credentials.describe 显示各渠道 keyRef 的 set/unset 状态（只显状态不显值）。
   - 样式：theme tokens（--dsw-alias-*）only；禁 import 宿主 client UI 包；控件自写（可抄宿主页 markup/CSS 行为，类名加 mroute- 前缀）。
3. **降级容错**：settings/configForms 服务缺席（旧 build/headless）时分区不注册不报错（幂等激活纪律）。

### B. Host 半（预期零或极小改动）

- 现有 index.js/lib 不动（数据层已完备）。仅当 client 链路实证需要 host 侧配合（如新增只读遥测面）才最小增量，理由写 devlog。
- cordis.patch.yml 如需为 client 声明补充（照 ui-plugin.md/模板），增量 edit。

### C. 文档与自检

1. **`docs/05-m3-devlog.md`**（新）：实现记录——与 03 方案的对照（采用/偏离逐条）、spike 结论（§6 问题 1）、坑、自检、§7 问题清单逐条回答（带文件行号）。
2. **selfcheck 增量**：可测层照测——草稿校验纯函数（schema validate 调用形状）、字段映射/整替 ops 构造、locale 词典完整性（zh/en 键集一致）、降级容错（服务缺席不注册）。client React 组件无法无浏览器自测——以「代码自查 + lead 浏览器实测」验收（如实标注哪些未自动化，勿谎报）。
3. `node --check` 全过；README/NOTICE 增量（版本 0.4.0-m3.0）；AGENTS.md §7 末尾加一行「M3 已交付待 lead 实测」（增量 edit 勿覆盖）。
4. **不 install_bundle、不重启 DSH**（lead 收口时亲自做）。

## 5. 红线（违者返工）

1. **advisory-only**：面板只编辑注册表数据，不新增任何阻断行为；enforce_gate 警示文案必须保留默认关语义。
2. llm/stream 改道不碰；agent/request 不改 route；宿主文件零改动（纯增量 bundle）。
3. 密钥值不过读线（侧牌 set/unset only）；不把 credentials 值写进任何日志/返回。
4. 上游原始 JSON 不出宿主照旧；quota 快照消费逻辑（M2）不改语义。
5. theme tokens only、禁 import 宿主 client UI 包、slot 内渲染不越界（practices.md UI 节）。
6. mroute/00-07d 上游存档不回改；与 03 方案偏离处 devlog 留痕。

## 6. 问题清单（devlog 逐条回答，带证据）

1. **spike（最先做）**：channels[] volatile 数组经 settings 写链（mutate→write→热更）的真机行为——建议最小 client 页先只读展示 describe 镜像验证挂载，再走一次最小 mutate（改一个 manual.note）全链验证：热更是否生效、model_route_query 是否立即读到、重启是否仍在（持久化——此项 lead 实测配合）。spike 结论决定主实现走 channels[] 整替还是需拆分承载形态（如拆成固定命名字段），若需拆分先停下向 lead 报告裁决再动工。
2. client 侧 React 的获取方式与模块形状（ui-plugin.md/模板实读结论；禁 import 宿主 UI 包约束下的自写边界）。
3. settings.section 的注册形状/props 实操（03 A.1/A.3 行号 + dsh-orb vendors 先例对齐结果）。
4. SETTINGS_CONFLICT 的实际错误/事件形状与你的处理实现。
5. locale 落地语种数与词典组织。
6. 与宿主原生 schemastery 表单的双入口并发写：同 ns 两入口同时编辑的冲突语义是否已被 revision 机制覆盖？面板是否需要在页头提示「与插件设置页同一数据源」？

## 7. 上报与交接纪律（AGENTS §2）

- 开工一句话确认 → 阶段进展（spike 结论/挂载成功/编辑链路通/文档齐）简短报父会话 → 完成回报一句话结论 + §7 六问答案摘要。
- 水位接近上限时 `session_handoff` 同层接替并在 handoff 文件写清剩余步骤，接替会话继续本任务书。

## 8. DoD

- §4 A/B/C 全交付；node --check 全过；selfcheck 增量全绿（不可自动化层如实标注）。
- §7 六问逐条回答带证据；与 03 方案偏离处全部留痕。
- 一句话结论报父会话；不 install_bundle（lead 亲测浏览器实测后收口）。
