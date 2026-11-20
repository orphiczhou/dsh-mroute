# 审核裁决书：大肥鱼浮球 × 多渠道额度整合（orb-quota）

> 审核员：orb-review-3（异种子模型审核会话，与撰写计划的 GLM 会话不同模型家族）
> 被审文件：`docs/briefs/brief-orb-quota-integration.md`（80 行）
> 审核日期：2026-11-15
> 审核方式：证据复核（vendors/ 与 plugin-quota-multi/ 源码逐行核对）+ asar 内 dsh-doc skill references 交叉验证

## 0. 一句话裁决

**修正后放行**。计划书方向正确、证据引用基本属实、红线零触碰；但「settings namespace 兜底」是一处事实错误，且互斥安装机制与重命名涟漪未写明——这两点不修正，实施者会在 M0/M1 走弯路甚至装坏 profile。

- **blocker：0**
- **major：3**（须修计划书后放行）
- **minor：5**（记录）

---

## 1. 证据复核结论（引用是否属实）

逐条核对计划书 §1 的引用，**全部属实或基本属实**，具体行号如下：

| 计划书引用 | 复核结果 | 证据 |
|---|---|---|
| `balance.ts` 204 行、`BalanceMonitor`+`BalanceSnapshot{text,full,state}` | ✅ 属实 | `vendors/.../packages/host/src/balance.ts` 全文 204 行；L125 `BalanceMonitor`，L30-36 `BalanceSnapshot` |
| balance.ts「不存不见 API key」注释 | ✅ 属实 | balance.ts L4-5「never stores or sees an API key」 |
| orb.ts L368-369 持有 monitor | ✅ 属实 | orb.ts L368-369 `private readonly balance: BalanceMonitor` |
| orb.ts L917 按 `lassoSatellite().enabled && lassoBall().balance` 启用 | ✅ 属实 | orb.ts L917-920 |
| orb.ts L1535 回合结束后主动刷新 | ✅ 属实 | orb.ts L1535-1536 `void this.refreshBalance(true)`，注释「A finished turn is when the balance actually moved」 |
| orb.ts L1966-1967 `broadcast({type:'lasso-balance', text, state})` | ✅ 属实 | orb.ts L1965-1968 `broadcastBalance()` |
| routes.ts L544/579 `lassoBalance()` 供设置页快照 | ✅ 属实 | routes.ts L544（类型）、L579（`deps.control.lassoBalance?.()`） |
| preferences.ts L202-209 `balance: true` 默认开关 | ✅ 属实 | preferences.ts L198-203 `LassoBallConfig.balance`、L205-210 `DEFAULT_LASSO_BALL.balance: true` |
| quota `src/http.ts` 注册 `/plugins/dsh-quota/api`，`/status` 返回 `{refreshedAt, providers, keys, httpPlatforms, currentModel, ...}` | ✅ 属实 | http.ts L20 `API_PREFIX`、L35-36 `/status`；消费方 controller.ts L368 |
| controller.ts L360-390 是现成消费方 | ✅ 属实 | controller.ts L368 `request<{refreshedAt, providers: PanelProvider[], ...}>('/status')`，L376-390 `store.set` |
| quota settings namespace `QUOTA_NS='quota'`（config.ts L21） | ✅ 属实（但「快照持久化」有误，见 finding M1） | config.ts L21 |

**额外正向证据**（计划书未写，但大幅降低实施风险）：

- orb host 已注入 `webServer` + `connection` 两个服务（orb `index.ts` L22-29），并有现成方法拿到 HTTP 地址与鉴权：`ctx.webServer.port` + `ctx.connection.authenticatedUrl('http://127.0.0.1:${port}')`（orb `index.ts` L161-172；`open-main.ts` L9-12 同款结构面）。
- helper 进程确实现成接收并渲染 balance 广播：helper `src/main.ts` L610 `if (record.type === 'lasso-balance')`、L772 `balanceText: chrome.lassoBalance.text`。

---

## 2. §5 七个审核问题逐条裁决

### Q1. 路线 A/B/C + 跨插件通信面 → **同意 A（附一处事实修正）**

- **同意 A 的方向**：orb 是展示端，消费 quota 的现成数据面、不复制查询代码、缺省退回 DeepSeek 余额，方向正确。B（移植 direct.ts）双份 key 管理 + 漂移风险，违反「移植即冻结」最小化原则，反对正确。C（quota 反向推送）方向反了，反对正确。
- **MAJOR 修正（finding M1）**：计划书 A 路线的「settings namespace 兜底」是**事实错误**。本机跑的是新 DSH（≥0.1.6，AGENTS.md §4 佐证宿主 0.2.2+），quota 的运行时快照 `providers/refreshedAt/history/currentModel` 只活在**内存覆盖层**，不落 settings namespace——`state-store.ts` L22 `PERSISTED_KEYS = new Set(['httpPlatforms'])`、L79-92 只有 `httpPlatforms` 走 `settings.update`；模块头注释 L1-10 明言「运行时快照走内存覆盖层」。config.ts 头注释 L2-4「last quota snapshot the panel renders」是 ≤0.1.5 旧语义的残留表述。**「settings namespace 兜底」在新 DSH 上拿不到任何实时额度数据，必须删除**。
- **更规范的跨插件通信面确实存在，但结论仍是 HTTP 为主**：
  - **服务注入（`ctx.provide` + `ctx.get`）是 cordis 最地道、类型安全、零序列化零端口探测的面**，且 orb **已经**这么消费可选服务——balance.ts 的 `deps.account()` 就是 `ctx.get` 一个 `deepseekAccount` 服务；orb index.ts L79/L162 也 `ctx.get('pluginManager')`、用 `connection` 服务。dsh-doc `practices.md` L20 明言「Put optional services in inject or ctx.inject([...]) so the plugin stays inactive in profiles without them」。但代价是**要改 quota-multi 一行**（`ctx.provide('quota', quota)` 暴露现成 `QuotaControllerFace`，controller.ts L239-264），破坏 A 路线「零改 quota-multi」的本意。
  - **事件总线不适用**：cordis 事件是生命周期/领域通知面，quota 并不发「快照已更新」事件，加一个就变成 C 路线（正确被否）。
  - **结论**：HTTP 作主、`ctx.get('quota')` 服务注入作备（若 HTTP 实测脆）。同时**把 M0 的「地址/鉴权」疑问降级为已解决**——`webServer.port` + `connection.authenticatedUrl()` 就是现成答案。

### Q2. 命名 → **dsh-orb-quota（备 dsh-orb-multi），两者都合规，非阻断**

两个候选都不带渠道字样，符合用户命名纪律。倾向 **dsh-orb-quota**：直接点明数据源，市场定位「独立桌面悬浮 + 全渠道余额」更清晰，且与既有 `dsh-quota-multi` 的渠道无关风格一致。`dsh-orb-multi` 的「multi」含义更模糊。此为记录级决定，不阻断。

### Q3. 卫星贴片信息策略 → **同意「最紧急优先 + hover 展开」**

- 56px 塞不下多渠道，「最紧急一条 + hover 展开」是唯一现实解；轮播作为可选项保留无妨。
- **minor（m2）**：需补两处细节——①「≥60% 黄档」阈值在 quota 数据里没有对应物（quota 的 `percent` 字段语义随条目类型不同：窗口型 vs 余额型；红色告警默认是 `alertPercent=85`，config.ts L147/L195），「60% 黄档」是 orb 侧自定展示约定，应做成可配置并明确取自哪个字段；②补一个确定性 tie-break（同百分比时按 id 排序）。
- 「当前会话模型所属渠道」映射**可行**：quota `/status` 返回 `currentModel{provider,model,platform,summary}`（config.ts L149-158），orb 自身也注入 `agentDefaultModel`。

### Q4. 降级路径完备性 → **方向同意，但互斥机制表述不精确（MAJOR）**

- **MAJOR（finding M2）**：计划书「与上游 dsh-orb 0.2.1 互斥安装（fork 同 bundle id）」术语错误且未展开。互斥机制是 **insert id**，不是「bundle id」（包名）。quota-multi 先例铁证：它包名是 `dsh-quota-multi`（≠上游 `dsh-quota`），但 cordis.patch.yml L5-7 明言「keep the insert id `quota` so this fork replaces the upstream bundle cleanly」，互斥靠的是 `id: quota`。orb 上游 cordis.patch.yml 有**五个** insert id：`preset-computer-use`（L5）、`orb-code-agent-registry`（L71）、`orb-lasso`（L76）、`orb-host`（L78）、`ui-settings-orb`（L82）。计划书必须写明：fork 保留这五个 id 不变 + 上游 dsh-orb 0.2.1 **先移除再装**（quota-multi 实录「上游已移除」）。
- **minor（m1）**：降级只写了「route 404」，未覆盖「/status 200 但 providers 空/全 error」——quota 面板真实会出现（无 key → missing-key、MCP 未注册 → 整行隐藏）。应补：providers 空或全非 ok 时同样静默退回 DeepSeek 余额。
- **确认可行**：凭据纪律成立。`/status` 的 `keys` 走 `keyStatus()` 只返回 `{configured, source, ref}`（controller.ts L900-916，绝无 value），`providers[].keyRef` 是引用名非密钥。orb 消费快照文本/数字不碰 key，与 balance.ts L4-5 既有模式一致。共存性（与 dsh-quota-multi 不同插件、不同 insert id `quota` vs orb 五个 id）成立。

### Q5. 阶段划分与工作量 → **基本合理，M0 建议加码**

- **minor（m5）**：M0「半天」偏乐观。M0 实际要落四件事：①构建链空跑（pack.mjs 需要 `tar`+`npm.cmd`+网络抓 darwin/win32 平台 prebuilds+koffi/zod/sherpa/node-cpal/pinyin-pro 打包，pack.mjs L68-127）；②package 重命名涟漪（见 M2）；③跨插件面确认（现已基本有答案）；④helper 渲染点定位。建议 M0 按 spike 1 天、带明确退出条件。M1 1-2 天在 M0 成功去险后成立。

### Q6. 风险清单遗漏 → **有遗漏，2 处并入 major，3 处 minor**

- **MAJOR（finding M3，§4 缺失「升级兼容」行）**：已装 0.2.1 的用户设置连续性未决策。orb 的偏好/会话文件路径写死 `dshHomePath('dsh-orb', ...)`（orb.ts L351、preferences.ts `profileDirectory`）。fork 改名后是**保留 `dsh-orb` home 目录以延续用户已调的浮球位置/皮肤/balance 开关**，还是换 `dsh-orb-quota`（用户重设一遍）？需在计划书明确——推荐保留（互斥安装下无冲突，且是「升级」而非「新装」）。
- **MAJOR（finding M2，同上）**：重命名涟漪 + insert id 互斥（见 Q4）。
- **minor（m3）**：新 quota-feeder 若走 HTTP，`connection.authenticatedUrl()` 返回的带凭据 URL **严禁写入日志**——这是 orb 既有纪律（open-main.ts L2-3「never written to the log」、orb index.ts L160-161），新代码必须继承。
- **minor（m4）**：两个 fork（quota-multi 与 orb-quota）的 `/status` 形状必须 lockstep 共版，冻结点写进维护兜底（计划书 §4 已有「运行时探测 + 形状断言 + 冻结点」，补一句「双端同步改」即可）。

### Q7. 红线核查 → **同意零触碰（附一条纪律）**

- **llm/stream 改道**：✅ 不碰。新代码只拉 quota 快照 + 广播给 helper，不监听/改写 `llm/stream`。
- **agent/request 路由**：✅ 不碰。quota-feeder 是定时 + 回合结束拉取，不注册 agent/request 瀑布监听。orb 现有 `ctx.sessionController.prompt()`（orb.ts L983）是既有行为非新增。
- **凭据纪律**：✅ 成立（见 Q4 确认）。`/status` 只暴露 ref/source 元数据，无 value；orb 不读 credentials。
- **纪律附注（minor m3）**：HTTP 鉴权 URL 严禁日志（见 Q6）。

---

## 3. 确认可行的地方（审计纪律：不止挑刺）

1. **两块基座的「现成能力」陈述全部属实**（§1 逐条核对见上表），lead 侦察质量高，无一处臆造行号。
2. **HTTP 消费面在 orb 侧已具备现成工具**：`webServer.port` + `connection.authenticatedUrl()`（orb index.ts L22-29/L161-172；open-main.ts L9-12）。这是计划书 M0 未点破的「地址/鉴权」答案，实施路径已通。
3. **广播通道复用是真实的**：helper main.ts L610 已处理 `lasso-balance` 消息、L772 已渲染到页面——「扩展 payload 或新增 `orb-quota` 消息类型」有现成管道，helper 半无需大改（向后兼容的「旧 helper 忽略新消息」判断成立）。
4. **凭据纪律天然满足**：quota 的数据面设计（`keyStatus()` 只出 ref/source、`providers[].keyRef` 只出引用名）与 orb 的「只读文本不碰 key」模式（balance.ts L4-5）是两条已经对齐的安全边界，整合无需新增凭据处理。
5. **降级状态机可复用**：balance.ts 已有 `EMPTY_BALANCE` / `'unavailable'` / `'signed-out'` 状态（L27/L38），quota 缺席时的静默退回能直接套用，无需新设计。
6. **市场方向**：「独立桌面常驻悬浮 + 全渠道余额」组合确属空白（lead 已定性），A 路线不复制查询代码、quota-multi 升级只要 `/status` 形状不变就不坏，成本/漂移权衡成立。

---

## 4. findings 分级汇总

### blocker（阻断实施）—— 0

无。路线方向、红线、凭据纪律均成立。

### major（须修计划书后放行）—— 3

- **M1 — 删除「settings namespace 兜底」错误陈述**：新 DSH 下 quota 运行时快照是内存覆盖层，不落 settings namespace（`plugin-quota-multi/src/state-store.ts` L1-10、L22、L79-92；config.ts L2-4 头注释为 ≤0.1.5 旧语义）。§1.2「快照持久化供面板渲染」与 §2.1 A 路线「或 settings namespace 兜底」两处都要改：主 = HTTP `/status`（地址/鉴权已有 `webServer.port`+`connection.authenticatedUrl()`），备 = `ctx.provide('quota')` 服务注入（需 quota-multi 一行改动），兜底 = 退回 DeepSeek 余额。
- **M2 — 明确互斥机制与重命名涟漪**：互斥靠 **insert id**（orb 五个 id：`preset-computer-use`/`orb-code-agent-registry`/`orb-lasso`/`orb-host`/`ui-settings-orb`，上游 cordis.patch.yml），非「bundle id」；上游 dsh-orb 0.2.1 须先移除（quota-multi 先例 L5-7）。同时写明 package 改名 `dsh-orb-quota` 的波及面：exports 子路径（bundle package.json L25-52）、assemble.mjs 的 `OLD_CLIENT_ID`/`NEW_CLIENT_ID` 重写常量（L25-27）、cordis.patch.yml 各 entry 的 `name:` 字段（如 `dsh-orb/host` → `dsh-orb-quota/host`）。
- **M3 — 补「升级兼容」决策**：fork 是否保留 `dshHomePath('dsh-orb', ...)`（orb.ts L351）以延续已装 0.2.1 的用户设置（推荐保留），需在计划书明确。

### minor（记录）—— 5

- **m1**：降级需覆盖「/status 200 但 providers 空/全 error」，不只 404。
- **m2**：卫星贴片「≥60% 黄档」阈值来源未定义（quota 只有 `alertPercent=85` 红档），补阈值来源 + tie-break。
- **m3**：HTTP 鉴权 URL 严禁日志（继承 open-main.ts L2-3 / orb index.ts L160-161 纪律）。
- **m4**：两 fork `/status` 形状 lockstep，冻结点写维护兜底。
- **m5**：M0「半天」偏乐观，建议 spike 1 天 + 明确退出条件。

---

## 5. 最终裁决：修正后放行

**必改清单（放行前提，对应 3 条 major）**：

1. 删除计划书 §1.2 与 §2.1 的「settings namespace 兜底」表述，改为「HTTP `/status` 主 + `ctx.provide` 服务注入备 + DeepSeek 余额兜底」，并写明地址/鉴权用 `ctx.webServer.port` + `ctx.connection.authenticatedUrl()`。
2. §2.3 互斥安装改为「insert id 口径」：枚举 orb 五个 insert id 保持不变、上游 dsh-orb 0.2.1 先移除；并在 §3 M1 增列重命名涟漪（exports/assemble.mjs 重写常量/cordis.patch.yml entry name）三项改动点。
3. §4 风险清单补「升级兼容」行，明确 `dsh-orb` home 目录与 preferences 连续性决策。

3 条 major 均为计划书文本修正，不涉及推翻架构；minor 可随实施记录。**blocker=0，修正上述 3 处后即可派发实施。**

---

## 6. 复核范围与未验证项（诚实声明）

- **已逐行核对**：balance.ts 全文、orb.ts L350-389/L895-1014/L1515-1574/L1940-1979、routes.ts L520-599、preferences.ts L190-229、orb host index.ts 全文、open-main.ts L1-40、helper main.ts（grep）、bundle cordis.patch.yml/package.json/assemble.mjs/pack.mjs 全文、quota http.ts/controller.ts(host 全文)/controller.ts(client L1-130/L340-419)/config.ts/state-store.ts/index.ts/cordis.patch.yml。
- **asar 内 dsh-doc skill 已加载**，references `practices.md` 与 `host-plugin.md` 全文核对；`locate-docs.md`/`configuration.md` 未展开（与本次裁决点无直接关系）。
- **未运行时验证**：`cordis_inspect_query` 本 build 带 input 被拒（AGENTS.md §4），无法实测 `webServer`/`connection` 服务的运行时 shape——上文的 `webServer.port` + `connection.authenticatedUrl` 结论来自 orb 自身源码调用面（index.ts L161-172、open-main.ts L9-12），非运行时 inspect，M0 应补一次 catalog 级确认。
- **未逐行复核** helper 的 hover 展开 panel 交互细节与 56px 卫星渲染代码（Q3 的「hover 展开」可行性基于 helper 已有 `lasso-balance` 渲染路径的推断，具体渲染点定位属 M0 产出）。
