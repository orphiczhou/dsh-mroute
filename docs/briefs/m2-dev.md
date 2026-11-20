# mroute M2 任务书（v2 · quota 插件数据源接入）

> 派发：lead（2026-11-15）。执行者：m2-dev（独立 DSH 会话，看不到本工作区父会话历史）。
> 方向变更：M2 原方案（mroute/07 §3.3：A 类四渠道 Key 直读适配器）经用户 2026-11-15 澄清**调整为复用已安装的 quota 插件（dsh-quota-multi）面板快照作为机读余额源**，mroute 不自建直读适配器、不接触任何 API Key。本任务书自包含，开工先读 AGENTS.md。

## 1. 背景（一句话）

mroute 是 DSH 多子会话派遣的模型选择 **advisory-only 建议器**（不阻断/不改写/不代决策——方向红线，见 AGENTS.md §4）。M1（0.2.0-m1.0）已收口并安装于 desktop profile：静态注册表 + `model_route_query` 查询工具 + 排序引擎 + manual 人工登记 + DecisionRecord JSONL + advisory 表头。M2 目标：把「人工登记余额」升级为「经 quota 插件自动读取的机读余额（balance_source=machine）」，并配缓存/单飞/退避/熔断框架，quota 插件缺席或失败时全部回落 M1 已有的 manual 降级路径（零新增风险）。

## 2. 必读文件（按序）

1. `D:\Codes\DSH小插件\AGENTS.md` —— 工作区纪律、方向红线 §4、环境坑 §4（asar/inspect/schemastery/node 路径）
2. `plugin-mroute/index.js` + `lib/`（registry.js / ranking.js / tool-query.js / config-schema.js / decision-log.js）—— M1 现状与接缝
3. `docs/05-m1-devlog.md` —— M1 实现记录与自检形态（M2 对齐）
4. `mroute/07-assembly-plan.md` §3.2/§3.3 —— quota-cache.js 设计意图与 QuotaView 契约（**注意**：§3.3 四渠道直读方案已被本任务书 v2 取代，只参考其缓存/熔断/契约部分）
5. `mroute/07a-balance-adapters.md` —— §推荐适配器接口（QuotaView 形状）、§宿主侧配套（8 条运行时纪律：传输/缓存/响应分类/状态机/安全/幂等激活）
6. `plugin-quota-multi/src/config.ts` —— 快照形状权威定义（ProviderSnapshot/QuotaItem）
7. `plugin-quota-multi/src/platform-map.ts` —— 供应商 id→平台 id 映射规则（移植对象）
8. `plugin-quota-multi/src/http.ts` —— /status 路由与 CSRF 语义（GET 无需 header）

## 3. 已验证技术事实（lead 2026-11-15 亲测/读源码，可直接引用）

1. **quota 插件无宿主 Service**：function-plugin 形态（`export function apply`），controller 实例是 apply 内闭包局部变量，mroute 无法 cordis inject 直取。可见面只有：① `quota_refresh` 工具（Agent 工具面，人读文本表，机读性差——不采用）② 面板 HTTP API ③ history.json 落盘（只有时序样本无快照——不采用）。**采用 ②**。
2. **快照端点**：`GET /plugins/dsh-quota/api/status`（**GET 无需 CSRF header**，POST 才要 `x-dsh-quota`），返回 JSON = `config.ts` 的 Config 形状 + `keys/formats/loginFlows/keyPlatforms`。核心字段：`refreshedAt`(ISO)/`refreshing`/`providers[]`/`currentModel{provider,model,platform,summary}`/`providerKeyRefs{providerId→keyRef}`。
3. **providers[] 行**：`{id, label, status:'ok'|'error'|'missing-key'|'missing-mcp', message?, via?:'api'|'mcp', keyRef?, keySource?, items:[{label, used?, limit?, remaining?, percent?, resetAt?, display?, burnRatePerHour?, etaMinutes?, weeklySpent?, spendWindowMs?}]}`。余额型条目靠 `label`（如"余额"）识别，数值在 `remaining`/`display`（字符串兜底解析）。
4. **同进程 loopback 通道**：宿主 webServer 服务有 `getOrigin(): string`（inspect host Service catalog 实证）。mroute `inject=['webServer']`（或 ctx.inject）→ `getOrigin()` → `fetch(origin + '/plugins/dsh-quota/api/status')`。GUI origin 实例 `http://127.0.0.1:53961`（桌面版 webServer 绑 loopback）。
5. **映射规则现成**：`platform-map.ts platformForProvider(provider)`——`zai→zhipu`、`deepseek`、`xiaomi`、`xiaomi-token-plan`（先于通用 xiaomi）、`opencode-go`、`openrouter`、`siliconflow`、`kimi`、`qianwen`、`tokenrouter`、`scnet`、`moonshot`、`minimax`、`magpie`、`stepfun`、`xai`、`volcark`。移植为 mroute 侧独立纯函数（连注释一起搬，注明出处 NOTICE）。
6. **quota 刷新节奏**：启动刷新 + 默认每 5 分钟（refreshIntervalMinutes 默认 5）+ 凭据变更触发（debounce 800ms）。mroute 侧缓存只是去抖 loopback 调用，TTL 可 60s 级。
7. **密钥安全先决条件已满足**：config.ts 模块注释明证 "API keys never live here"——快照不含密钥值，`keyRef` 只是引用名（可透出）。mroute 消费快照天然不接触凭据。
8. **危险语义（产品红线）**：**映射命中 ≠ 账户体系一致**。zai-coding-cn 是 GLM Coding 包月订阅；quota 的 zhipu 平台卡用 ZHIPU_API_KEY 查 API 余额——两者可能非同一账户，拿错账号余额当建议比不显示更糟。映射表必须显式声明账户语义，未核实的一律不采信数值。

## 4. 交付物

### A. plugin-mroute 源码增量（版本升 0.3.0-m2.0）

1. **`lib/quota-source.js`**（新）：经 webServer `getOrigin()` loopback fetch GET /status。
   - `AbortSignal.timeout(15000)`；Windows 传输纪律见 07a §宿主侧配套 3（fetch 原生、禁 curl-subprocess 主路径）。
   - 响应先判 content-type/HTML 再 JSON.parse（07a 纪律 4）；失败**绝不抛出**，返回 `{ ok:false, reason }` 降级标记；HTTP 面 loopback only（origin 非 127.0.0.1/localhost 直接拒绝）。
2. **`lib/quota-cache.js`**（新）：TTL 缓存（缺省 60s，Config 可调）+ 单飞 inFlight 去重 + 失败指数退避（5s×2^n 封顶 30min，失败结果也占缓存位）+ 熔断状态机 `ok→degraded→cooling→half-open→ok`（连续 N 次失败开熔断；冷却后半开试探一次成功才恢复）。设计意图参考 07 §3.2 quota-cache 注释。
3. **`lib/quota-view.js`**（新，或并入 quota-source）：providers[] → mroute QuotaView 归一化。
   - `balance_source:'machine'`、`source:'quota-plugin'`、`as_of=refreshedAt`；items 按 label 匹配余额条目（label 语义映射表写死+注释），`display` 字符串兜底解析数字（解析失败不伪造 0）。
   - 上游原始 JSON **不出宿主**（不透传给模型/日志），一律归一化视图。
4. **注册表渠道条目新增映射字段**（config-schema.js）：`quota_platform`（显式声明平台 id，空=不接）+ `quota_account_verified`（boolean，缺省 false）。**仅当 `quota_platform` 非空且 `quota_account_verified=true` 才采信 machine 数值**；unverified 渠道即使映射命中也回落 manual（§3.8 红线）。内置五渠道初始值：deepseek-official/deepseek-account → `quota_platform:'deepseek'`（verified 按实际账户判断写注释说明依据）、xiaomi → `'xiaomi'`（AGENTS §9 明证 id 对齐设计）、zai-coding-cn → `'zhipu'` + **verified:false**（包月订阅≠API 余额账户）、opencode-go → `'opencode-go'`（verified:false 待核实）。
5. **`lib/tool-query.js` 增量**：`balance_source` 枚举加 `'machine'`；低余额阈值升级 Config 可配置 `low_balance_threshold_cny`（缺省 10，兼容 M1 内置常量）；machine 行带 as_of/source 标注；quota 缺席/失败/未 verified 的渠道行为与 M1 manual 完全一致。
6. **advisory 措辞纪律**：model_route_query 输出的 quota 区块/表头沿用 M1 advisory 口径（「自动余额经 quota 插件读取，仅供参考」），不加任何阻断语义；无 tools.guard。
7. **幂等激活**：所有注册走 ctx.effect + inject 可选面（webServer 缺席的 profile 下插件必须照常激活，只是 machine 永远缺席）。
8. package.json 版本 0.3.0-m2.0；README/NOTICE 增量（NOTICE 记 platform-map 移植出处 MIT）。

### B. 文档

- **`docs/05-m2-devlog.md`**（新）：实现记录——决策与理由（含与 07 §3.3 原方案的差异：用户 2026-11-15 澄清复用 quota 插件，直读适配器搁置为 backlog）、接缝证据（文件路径+行号）、坑、自检结果、问题清单 §6 逐条回答。
- **AGENTS.md §7**：末尾只加一行「M2（quota 数据源接入）已交付待 lead 实测（0.3.0-m2.0）」——**增量 edit，勿整体覆盖**。
- mroute/00-07d 上游存档**不回改**；docs/01/02 活文档如需记 FR 口径调整，走增量小节（不改旧文）。

### C. 自检（对齐 M1 形态，先读 docs/05-m1-devlog.md 确认）

- M1 无独立 tests/ 目录：自检形态 = node 断言脚本 + lead 冒烟。M2 新增 `selfcheck/` 目录（node:test 或普通 node 断言脚本均可，`node --test selfcheck/` 或逐个 `node selfcheck/xxx.js` 跑通）：fixture JSON（providers ok/error/missing-key/畸形/HTML 响应）→ quota-source 解析、cache TTL/单飞/退避/熔断状态机、view 归一化、降级链（quota 缺席→manual、unverified→manual）。
- 全部 JS `node --check` 通过（PATH 全局 node v24.20.0）。
- **不 install_bundle、不重启 DSH**（lead 收口时亲自做）。

## 5. 红线（违者返工）

1. **advisory-only**：不阻断/不改写/不代决策；最终选择权永远在会话与用户。
2. **llm/stream 改道不碰**；agent/request 不改 route（宿主 step-fixed selection 会拒绝）。
3. **mroute 不接触 API Key**：不读 credentials、不写 Config 存 key、不打日志回显；只消费快照数值（快照本身无密钥值，§3.7）。
4. **quota 插件零改动**（`plugin-quota-multi/` 只读参考，市场插件保持原样）。
5. 上游原始 JSON 不出宿主；AbortError 重抛；渠道间错误隔离（一个平台解析失败不拖垮整表）。
6. schemastery：channels[] 数组整体 volatile 已是 M1 定案（读取走 .get()），新字段加在元素内不标 volatile；z.record 不存在用 z.dict；`.volatile()` 在数组元素内会抛错（AGENTS §4 Day1 实测）。
7. inspect exact-query 带 input 在本 build 被拒——不要依赖带参 inspect；本任务书 §3 事实已足。

## 6. 问题清单（devlog 逐条回答，带证据）

1. quota 缺席（未装/禁用/webServer 缺席）时的行为路径？——应：降级 manual + health unknown，无告警噪音，插件照常激活。
2. /status 可达但 providers 空/全 missing-key？——应：对应渠道回落 manual，已 verified 的 machine 渠道标 degraded（一次失败先 degraded，连续 N 次才 cooling）。
3. 映射命中但 `quota_account_verified=false`？——应：不采信数值，回落 manual，note 标注原因。
4. 熔断恢复机制？（半开试探一次成功才恢复；失败结果占缓存位的语义；恢复后 TTL 正常）。
5. `currentModel`/`providerKeyRefs` 能否增强「当前会话路由」展示？（可选加分项，不强求；做了要写清证据）。
6. zai-coding-cn 的 machine 通道在当前实际环境（用户 GLM 包月 + ZHIPU_API_KEY 若存在）会不会显示错账号余额？给出你 verified 标置的依据链。

## 7. 上报与交接纪律（AGENTS §2）

- 开工 `brief_echo` → `plan` → 阶段 `progress`（meta 带证据：文件路径+行号）→ 每几步 `context` 自报水位 → 完成 `done`（meta 精简，完整 self_check 用补充 progress 携带——meta 超长会触发宿主 unknown-tool 异常）。
- 水位 ≥42% 自报 context 触发竹节接力；接近 50% 用 `session_handoff` 同层接替（handoff 文件写清剩余步骤），接替会话继续本任务书。
- done 前一句话结论 + 关键发现 `send_message` 报父会话（lead）。

## 8. DoD

- §4 A/B/C 全部交付；`node --check` 全过；selfcheck 全绿（输出留档 devlog）。
- §6 问题清单 1-6 逐条回答带证据。
- 一句话结论报父会话；不 install_bundle（lead 亲测）。
