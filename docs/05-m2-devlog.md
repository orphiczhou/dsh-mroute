# 05-m2-devlog.md — mroute M2 增量开发实现记录（quota 插件数据源接入）

- 执行者：m2-dev（lead 派发，任务书 `docs/briefs/m2-dev.md` v2）
- 日期：2026-11-15
- 基线：`plugin-mroute/` M1 收口版 **0.2.0-m1.0** → 本增量 **0.3.0-m2.0**
- 红线基线：AGENTS.md §4 mroute 方向红线（advisory-only）+ 任务书 §5 七条（不接触 API Key /
  quota 插件零改动 / 上游原始 JSON 不出宿主 / AbortError 重抛 / 渠道间错误隔离 / schemastery
  volatile 纪律 / 不依赖带参 inspect）；不 install_bundle 不重启 DSH（lead 亲自做）

---

## 0. 方向变更一致性核对（不改 07 上游原文，专章辨析）

M2 原方案 = mroute/07 §3.3 的 A 类四渠道 Key 直读适配器（DeepSeek/Kimi/SiliconFlow/OpenRouter
直连官方余额端点）。用户 2026-11-15 澄清**调整为复用已装 quota 插件（dsh-quota-multi）面板快照**
作为机读余额源：mroute 不自建直读适配器、不接触任何 API Key。与本增量的一致性核对：

| 维度 | 07 §3.3 原方案 | M2 实际落码（本 devlog） | 判定 |
|---|---|---|---|
| 数据面 | 各渠道官方 API 直查（Bearer 渠道 key） | webServer getOrigin loopback 读 quota 面板快照（`GET /plugins/dsh-quota/api/status`） | **替换**（07 §3.3 搁置为 backlog，lead 口径） |
| 凭据面 | mroute 经 credentials seam 解析渠道 key | **零凭据**（快照无密钥值，quota 插件自己管 key） | 收窄（红线 §5.3 天然满足） |
| 缓存/熔断 | 07a §宿主侧配套 2-5 纪律 | 照搬同一套纪律落码（quota-source/quota-cache） | **保留**（设计意图不变） |
| QuotaView 契约 | 07a §推荐适配器接口（机读视图/原始 JSON 不出宿主/缺失不伪造 0） | 同纪律落码（quota-view） | **保留** |
| 覆盖面 | 四渠道直读 | quota 插件已适配的全部平台（16+ direct + MCP + 自定义），经 `quota_platform` 显式登记逐渠道接线 | 扩大（但受 verified 红线约束，见 §4.3） |

07 §3.3 的「M1 阶段行为」承诺（manual 是所有适配器失败/缺席的统一落点）在 M2 依然成立且是本
增量的降级主线。direct.ts 为 **A 类**端点证据源（07a 速查表同源），行号引用保留 MIT 出处（NOTICE）。

## 1. 增量清单落点对照（任务书 §4）

### 1.1 lib/quota-source.js（新，§4.1）

| 清单项 | 落点 | 实现 |
|---|---|---|
| 经 webServer getOrigin loopback fetch GET /status | quota-source.js:168-190（createQuotaSource）、:111-150（fetchQuotaStatusRaw） | origin+`/plugins/dsh-quota/api/status`（端点常量 :28 QUOTA_STATUS_PATH = http.ts:20+35 证据）；origin 来自 `resolveOrigin(webServer)`（:38-53），webServer 缺席/getOrigin 非函数/抛错/返回空 → null → fetch 恒返回 `{ok:false, reason:'webserver-missing'}` 不发请求 |
| AbortSignal.timeout(15000) | quota-source.js:122（fetch 调用 AbortSignal.timeout(timeoutMs)，常量 :30 QUOTA_FETCH_TIMEOUT_MS=15_000） | 原生 fetch 传输（07a 宿主侧配套 3；无 curl-subprocess） |
| 响应先判 HTML 再 JSON.parse | quota-source.js:139-140 | content-type 非 json 或正文 trimStart 以 '<' 开头 → `{ok:false, reason:'html-response'}`（双判纵深；200+HTML 陷阱 07a 纪律 4） |
| 失败绝不抛出（safe 层） | quota-source.js:152-166（fetchQuotaStatus） | try/catch 全包，TimeoutError/AbortError → `{ok:false, reason:'timeout'}`，其余 → `network: <msg>`；selfcheck source.test 断言「绝不抛出」 |
| AbortError 重抛（raw 层，红线 §5.5） | quota-source.js:124、:135 | fetchQuotaStatusRaw 内 `if (isAbortLike(error)) throw error` 原样重抛保留身份；safe 层才归一为 timeout——**两层同时满足两条纪律**（裁决见 §2.1） |
| loopback only | quota-source.js:55-65（isLoopbackOrigin）、:117 | hostname ∈ {127.0.0.1, localhost, [::1]} 且协议 http/https；非 loopback 直接 `{ok:false, reason:'non-loopback-origin'}` 且 **fetchImpl 不被调用**（selfcheck 断言 called=false） |
| 形状守卫 + 最小消费裁剪 | quota-source.js:77-104（parseQuotaStatusBody） | providers 数组 + refreshedAt 字符串必须存在（否则 bad-shape）；裁剪只留 refreshedAt/refreshing/providers/currentModel/providerKeyRefs——keys/formats/loginFlows/keyPlatforms **parse 时即丢弃**（上游原始 JSON 不出宿主，红线 §5.5；selfcheck 断言 snapshot 无 keys 键） |

### 1.2 lib/quota-cache.js（新，§4.2）

| 清单项 | 落点 | 实现 |
|---|---|---|
| TTL 缓存（缺省 60s，Config 可调） | quota-cache.js:34（`let ttlMs`）、get() 内 TTL 判定 | 成功结果 60s 缓存；Config `quota_cache_ttl_seconds`（config-schema.js:200）volatile 热更经 `setTtlMs`（:126-130）+ index.js getQuota 每次对比（index.js:58-62） |
| 单飞 inFlight 去重 | quota-cache.js:55-57（requestOnce） | 并发 get 共享同一 Promise；selfcheck 断言 3 并发 fetch 计数=1 |
| 失败指数退避（5s×2^n 封顶 30min，失败结果也占缓存位） | quota-cache.js:52-53（backoffDelayMs）、get() 内失败占位分支 | 失败写入 last（占缓存位），退避窗口内 get 直接返回失败标记 cached:true 不重发；selfcheck 断言 4999ms 占位/5001ms 重发（边界） |
| 熔断状态机 ok→degraded→cooling→half-open→ok | quota-cache.js:69-99（requestOnce 成败分支） | 失败 1 次（<N=3）→ degraded（:96，任务书 §6.2「一次失败先 degraded」）；连续 3 次 → cooling+coolingUntil（:91-94）；冷却期 get 完全静默（:121-124）；到点转 half-open（:125）试探；成功 → ok 清计数（:69-74）；试探失败 → 回 cooling 重新冷却（:88-98） |
| stale 保留旧值 | quota-cache.js:63（lastGood）、:90（失败结果携带 staleSnapshot） | 失败结果带最近一次成功快照供上层 degraded 展示（07a 宿主侧配套 5）；selfcheck 断言 deepEqual(staleSnapshot, 快照)。**缺席态例外（补修）**：reason='http-404'（quota 未装/停用，确定性信号）不携带 staleSnapshot、不进退避熔断计数、缺席占位走普通 TTL 过期自动重探测（:76-87 分类、:129 占位窗口）——瞬态（timeout/network/5xx/其它 4xx）仍走原链 |

### 1.3 lib/quota-view.js（新，§4.3）

| 清单项 | 落点 | 实现 |
|---|---|---|
| balance_source:'machine' / source:'quota-plugin' / as_of=refreshedAt | quota-view.js:90-131（platformViewOf）、:133-158（normalizeQuotaSnapshot） | 每平台行归一化为 `{balance_source:'machine', source:'quota-plugin', as_of, status, balance, currency, display, message}`；整快照 → by_platform Map + current_model + provider_key_refs |
| items 按 label 匹配余额条目（映射表写死+注释） | quota-view.js:22-45（BALANCE_LABELS :31-45 + isBalanceLabel :47-57） | 闭集 8 项 + '总余额' 后缀（deepseek-balance 的 `${currency} 总余额`，direct.ts:278）；每项带 direct.ts 行号证据注释；usage 型条目（'5h 窗口'/'周额度'/'今日消耗'）**不命中不伪造余额**（selfcheck 断言） |
| remaining 优先 → display 兜底 → 失败不伪造 0 | quota-view.js:96-112（选取循环）、:61-70（parseDisplayNumber） | 优先「label 命中 + remaining 数值」；其次「label 命中 + display 解析」；都无 → balance=null。display 解析带**形态守卫**（:63-64）：串必须以币符/数字开头——`'已用 $0.5 · 无限额度'`（openai-billing unlimited 行，direct.ts:1106）这类已用量串判 null，防把已用当余额（裁决见 §2.3） |
| 上游原始 JSON 不出宿主 | quota-view.js 整文件 + quota-source.js:77-104 | Map 值是固定形状视图（selfcheck deepEqual 断言键集 = as_of/balance/balance_source/currency/display/message/source/status）；畸形行（null/数字/无 id）跳过（:139-142，渠道间错误隔离） |
| currency 识别 | quota-view.js:72-88（currencyOf） | display 币符（¥→CNY/$→USD）优先，label 前缀（'CNY 总余额'）兜底，识别不出 null |

### 1.4 注册表映射字段（config-schema.js，§4.4）

| 清单项 | 落点 | 实现 |
|---|---|---|
| quota_platform（空=不接） | config-schema.js:160-167（schema :165 `z.string().default('')`） | 显式声明 quota 面板平台 id；采信前提之一；**不用运行时 includes 推导采信**（platformForProvider 仅读侧交叉核对） |
| quota_account_verified（缺省 false） | config-schema.js:169-173（schema :171 `z.boolean().default(false)`） | true 才采信 machine 数值；未核实映射命中也回落 manual（§3.8 红线） |
| 种子五渠道 | config-schema.js:56-57（zai→zhipu, false）、:71-72（opencode-go, false）、:87-88（deepseek-official→deepseek, false）、:101-102（deepseek-account→deepseek, false）、:117-118（xiaomi→xiaomi, **true**） | verified 依据链注释逐条写在种子内（见 §4.6 Q6 详述） |
| volatile 纪律（红线 §5.6） | config-schema.js:165/171 元素内**不标 volatile** | channels 数组整体 volatile（M1 定案不变）；新字段随数组整条替换语义热更 |
| 顶层可配字段 | config-schema.js:186-201 | low_balance_threshold_cny（:194，缺省 10 兼容 M1 常量）+ quota_cache_ttl_seconds（:200，min 5/max 3600 缺省 60），均 volatile |
| 读侧交叉核对 | registry.js:83-96 | 显式 quota_platform ≠ platformForProvider(routeProvider) 推导 → 读时告警「请人工核对显式声明」不拒写；种子五渠道全一致（degrade.test 断言 warnings.length=0） |

### 1.5 lib/tool-query.js 增量（§4.5）

| 清单项 | 落点 | 实现 |
|---|---|---|
| balance_source 枚举加 'machine' | tool-query.js output schema（routes items balance_source enum `['manual','machine','unknown']`） | execute :434 `machine.use === 'machine' ? 'machine' : balanceSourceOf(channel)` |
| 采信判定 | tool-query.js:71-95（machineBalanceOf） | 五道门：quota 视图存在 → quota_platform 非空（:74）→ 平台行存在（:78-79，经 pickPlatformView 前缀认领，见 §7 补修 1）→ verified=true（:80-82）→ status ok（:83-85）→ balance 数值（:86-88）；任一不满足回落 manual 并给 why（缺席时 why=null 无噪——§6.1） |
| machine 行带 as_of/source 标注 | tool-query.js:428-437（quotaNote）+ 可选 balance 键（schema + execute :448-459） | balance `{remaining, currency?, display?, as_of, source:'quota-plugin', degraded}`；note「余额经 quota 插件自动读取（balance_source=machine，截至 …，仅供参考）」；stale 期追加说明、balance.degraded=true；多账号未精选追加标注（:432，§7 补修 1） |
| 阈值 Config 可配 | tool-query.js:125-149（warningOf options.thresholdCny）+ execute :393-395（readConfigValue 读取，非法/缺省回落 LOW_BALANCE_THRESHOLD_CNY=10） | machine 数值优先参与判定；**币种守卫**：仅 currency null/'CNY' 比较 CNY 阈值（:137，USD 不臆测汇率，note 标注「币种 USD，CNY 低余额阈值不适用」） |
| quota 缺席/失败/未 verified 与 M1 manual 完全一致 | degrade.test 全组 | 缺席：全行 manual/unknown、无 note 噪音、excluded 空、渲染无表头（§6.1 断言）；M1 manual 数值路径回归（degrade.test M1 兼容组） |
| meta.quota 区块 | tool-query.js:485-493（schema :351-369） | `{available, degraded, breaker∈闭集, as_of, note}`；缺席形态 available=false + breaker='unavailable' + as_of='' |
| advisory 表头 | tool-query.js renderRouteResult（quotaMeta.available 才加行） | 「自动余额经 quota 插件读取（截至 …），仅供参考」；无阻断语义、无 tools.guard（红线 §4.6） |

### 1.6 index.js 装配（§4.7 幂等激活）

- inject 增 `'webServer'`（index.js:27）——可选面：webServer 缺席 profile 下 apply 照常执行
  （quotaSource.available=false → 不建 cache → getQuota 恒 null，index.js:50-54）。
- 所有注册走 ctx.effect（工具 :86-92、prompt :99-103，M1 形态不变）；quota 链路无定时器无后台
  活动（懒获取），无新增 dispose 面。
- getQuota 装配（index.js:56-80）：cache.get() → ok 归一化；失败带 staleSnapshot → degraded:true
  归一化旧快照；无 stale → null。cache.get 契约不抛出，外层再兜一层 catch 按缺席降级（防御纵深，
  index.js:63-70）。

### 1.7 package.json / README / NOTICE（§4.8）

- package.json：version 0.3.0-m2.0；scripts.check 增 4 个新文件；scripts.selfcheck 新增。
- README：功能/红线/已知限制全量更新到 M2 口径（机读余额采信前提、缓存熔断、自检命令、种子
  verified 现状）。
- NOTICE：新增两行——platform-map.js **整文件移植**（dsh-quota-multi/src/platform-map.ts，MIT，
  移植即冻结 + 用途差异声明）与 07a/07 设计纪律借鉴（改造借鉴，未拷运行时代码）。

## 2. 关键设计裁决与偏离

1. **AbortError 两层落地**：任务书 §4.1「失败绝不抛出」与红线 §5.5「AbortError 重抛」字面冲突。
   裁决：分两层同时满足——raw 层（fetchQuotaStatusRaw）AbortError/TimeoutError 原样重抛保留
   身份（07a 纪律 4 的本意：不吞超时身份）；safe 层（fetchQuotaStatus，对外唯一入口）catch 后
   归一 `{ok:false, reason:'timeout'}` 绝不抛出。selfcheck 两侧各自断言。
2. **display 兜底解析形态守卫**：发现 openai-billing unlimited 行 display=`'已用 $0.5 · 无限额度'`
   （direct.ts:1106），label '额度 (USD)' 命中余额闭集——朴素首段数字解析会把**已用量 0.5**
   当余额。守卫：display 必须以币符/数字开头才解析（quota-view.js:69-70），已用量串判 null
   → balance=null 回落 manual（不伪造）。已知余额行 display 全部 ¥/$ 开头，守卫零误伤。
3. **币种守卫**：low_balance_threshold_cny 是 CNY 语义；USD 等其它币种不臆测汇率，不触发
   low_balance，note 标注币种（tool-query.js:420-422）。种子渠道全为 CNY 语义，守卫为未来
   USD 渠道 verified 后的防误报护栏。
4. **platformForProvider 移植件的用途收窄**：quota 插件用它运行时自动认领供应商→平台；mroute
   **不在运行时用推导结果采信数值**——采信只有显式 quota_platform+verified 一条门。移植函数
   仅用于 registry 读侧交叉核对告警（不一致提示人工复核，不拒写不自动改）。理由：任务书 §3.8
   红线「映射命中 ≠ 账户体系一致」，includes 推导恰好是「错账号」风险的主要来源（上游注释
   自证：qianwen 不带 bailian 防错账号、magpie 前缀防错认 anthropic）。
5. **providers 空/missing-key 不进熔断计数**：这是快照**内容**状态（quota 插件活着且如实上报），
   不是传输失败；按行状态回落 manual 即可，退避/熔断只针对 loopback 传输/解析失败。熔断
   degraded（cache 层）与渠道行 degraded（M1 恒 false 占位）是两个概念，devlog §4.2 辨析。
6. **§6.5 加分项不接线**：currentModel 与 exec.agent.options 是两个语义（宿主缺省模型 vs 查询
   会话自身路由），合并展示混淆；providerKeyRefs 已透出到归一化视图（quota-view.js:150）供
   后续做「verified 辅助提示」，但 keyRef 一致只是同账户的必要条件，自动翻真 verified 会绕过
   用户核实决策（账户语义是用户决策不是插件推断）。详见 §4.5。

## 3. 自检结果（留档）

- `npm.cmd run check`：**14/14 通过**（index + lib 13 文件；PATH 全局 node v24.20.0，2026-11-15 实跑）。
- `npm.cmd run selfcheck`（node --test 四套件）：**52/52 全绿**（2026-11-15 实跑，含 lead 验收反馈
  两项补修的新增用例；duration ≈0.22s）：
  - source.test.mjs **14 pass**：resolveOrigin 七形态（缺席/非函数/抛错/空串/非串）；
    loopback 围栏（127.0.0.1/localhost/[::1] 放行，example.com/127.0.0.1.evil.com/ftp/not-a-url 拒）；
    parse 形状守卫（bad-json/bad-shape）+ 最小消费裁剪（keys/formats/loginFlows/keyPlatforms 不透出）；
    响应分类（html-response 双判/http-500）；非 loopback 不发起 fetch；
    raw 层 AbortError/TimeoutError 重抛身份断言；safe 层绝不抛出（timeout 归一）；
    createQuotaSource webServer 缺席 available:false + fetch webserver-missing。
  - cache.test.mjs **11 pass**：TTL 59,999ms 命中/60,001ms 重发；单飞 3 并发 1 请求；
    失败占位 4,999ms 不重发/5,001ms 重发（退避边界）；一次失败 degraded→连续 3 次 cooling→
    冷却期 299,999ms 静默→half-open 试探成功→ok 且 TTL 正常；half-open 试探失败回 cooling；
    staleSnapshot deepEqual；invalidate/setTtlMs 热更；fetcher 违约归一 fetcher-crashed；
    **404 缺席三组（补修 2）**：首次即判缺席（breaker ok/计数 0/无 stale/absent 标记）、
    连续 404 不熔断 + 占位窗口=TTL（5s 时点仍占位非退避）+ 过期重探测自动恢复、
    瞬态对照（500 走退避链）+ 先成功后 404 不携带 stale。
  - view.test.mjs **15 pass**：label 闭集 + 总余额后缀命中、usage 型不命中；display 守卫
    （'已用 $0.5 · 无限额度'→null）；currencyOf 双源；remaining 优先/display 兜底/usage 型 null/
    error 行 message 截断 120；畸形行隔离（Malformed providers 6 元素仅 1 合法存活）+ 视图键集
    deepEqual；normalize 形状守卫 + current_model/provider_key_refs 透出；
    **pickPlatformView 六组（补修 1）**：裸 id 精确命中、前缀+keyRef 精选、ref 未登记→首行+multiUnpicked、
    ref 无对应行→首行+multiUnpicked、无命中 undefined、畸形视图安全空选取。
  - degrade.test.mjs **13 pass**：§6.1 缺席全回落无噪；§6.2 空 providers/全 missing-key 回落 +
    note 标注；§6.3 unverified 不采信（zhipu 行给 ¥999.99 也回落）；machine 采信行形态
    （remaining/currency/as_of/source/degraded + 渲染 machine(¥57.93) + rank 全序不变）；
    stale 降级标注；machine 低余额 warning（rank 原位零拦截）+ 阈值 100 可配 + USD 币种守卫；
    M1 manual 路径回归（quota_total='5' 触发 + 常量 10）；schema 缺省（五渠道映射期望 +
    空表缺省 + 阈值/TTL volatile 读回）；registry 交叉核对（kimi 错配告警/种子零告警/空不告警）；
    platformForProvider 种子对齐（含 xiaomi-token-plan/magpie-anthropic 优先规则）；
    **多账号行三组（补修 1）**：前缀命中+keyRef 精选无标注、无 ref→首行+「未按 keyRef 精选」标注、
    verified=false 时匹配先于采信门回落「账户未核实」。
- 调试期修复 3 处：quota-cache.js ttlMs const→let（setTtlMs 热更赋值）；`node --test selfcheck/`
  目录形态在本机（路径含中文）报 MODULE_NOT_FOUND——selfcheck script 改逐文件枚举（package.json）；
  404 缺席用例自身时间线错误（重探测仍落 404 分支）——改为「两次过期重探测均 404 不熔断、第三次恢复」。

## 7. 补修记录（lead 验收定向复核反馈，2026-11-15，均已实测/复测）

### 补修 1：多账号平台行前缀认领（`平台id#keyRef` 形态）

- **缺陷**（lead 亲测 /status）：多账号平台行 id 是 `opencode-go#OPENCODE_GO_API_KEY` /
  `opencode-go#OPENCODEGOSOTA_API_KEY`（controller.ts MAGPIE 注释即同款「`magpie#<provider>`
  前缀认领」模式）；quota-view byPlatform 精确匹配导致种子 opencode-go→'opencode-go' 找不到行，
  model_route_query 实测标注「quota 快照无平台 opencode-go 行」。
- **修法**（lead 给定）：行匹配改「精确相等 ∪ 以 `<声明值>#` 开头」；多行命中选取规则显式——
  ① provider_key_refs[routeProvider] 反查渠道 keyRef，选 `#<该keyRef>` 行（pickedByRef，无标注）；
  ② ref 未登记/无对应行 → 取首个前缀命中行，multiUnpicked=true，note 标注
  「多账号行，未按 keyRef 精选（首个前缀命中）」（tool-query.js:432）。
- **落点**：quota-view.js:155-192 新增 `pickPlatformView`（精确 → 前缀扫描 → keyRef 精选 →
  首行兜底）；tool-query.js:77-78 machineBalanceOf 改经 pickPlatformView 选取、:93 返回
  multiUnpicked、:432 note 标注。**匹配先于 verified 门**：unverified 渠道前缀命中仍回落
  「账户未核实」（degrade.test 补修组 3 断言）。
- **用例**：view.test pickPlatformView 六组 + degrade.test execute 层三组（keyRef 精选无标注 /
  无 ref 首行+标注 / verified 门先于采信）。

### 补修 2：http-404 确定性缺席分类（lead 降级实测反馈）

- **观察**（lead 降级实测全流程）：停用 quota → /status 404 走完整退避熔断链（3 连失败 + 5min
  冷却），过渡期持续 stale 标注——与任务书 §6.1「缺席态无感回落零噪音」预期不符（404 是
  确定性缺席信号非网络瞬态）。
- **修法**：quota-cache.js:76-87 对 reason='http-404' 首次即判 absent——breaker 保持 ok、
  失败计数清零、不携带 staleSnapshot（无 stale 标注）、缺席占位走普通 TTL（:129，60s 内信任
  缺席结论），过期自动重探测（quota 重新激活即自动恢复 machine，无需任何人工干预）；
  timeout/network/5xx/其它 4xx 仍为瞬态走原退避熔断链（语义分工：404=缺席确定性，5xx=瞬态）。
- **404 判缺席副作用裁决（回应 lead 问句）**：无实质副作用。「quota 升级中途短暂 404」场景下
  machine 通道静默回落 manual——这正是期望行为（升级窗口本无数据，静默优于持续 stale 标注），
  且缺席态不熔断：恢复探测每 TTL 周期自动进行（至多 60s 延迟），零人工零配置。唯一代价是缺席期
  每 60s 一次 loopback GET 探测，可忽略。故未保留现状。
- **用例**：cache.test 404 三组（缺席判定/连续 404 不熔断+TTL 占位+自动恢复/瞬态对照+无 stale）
  + source.test 404 reason 断言。

### 验收微调：deepseek×2 种子 verified 开 true（lead，2026-11-15 用户澄清）

- **澄清**：用户确认 **DeepSeek 只有一个源**——quota deepseek 卡的 `DEEPSEEK_API_KEY` 即 DSH
  deepseek 路由同一把 key，deepseek-official/deepseek-account 两行渠道同源同一账户。
- **改动**：config-schema.js 两处种子 `quota_account_verified: false→true`（注释记依据）；
  selfcheck/degrade.test.mjs 两处随种子更新断言（machine 采信用例 L118-121：deepseek-official
  →machine(42.5 fixture)；schema 种子断言 L200-201 →true）。52/52 全绿。
- **实测**（lead，link 重装后）：deepseek-official/deepseek-account 两行 `machine(¥48.74)`，
  与 quota_refresh 的 DeepSeek 卡 ¥48.74 一致——同源闭环。
- **环境事实**：本轮 remove/install 均标 `restart-required(unmanaged-plugin)`，但 HMR 实际已
  热更生效（model_route_query 实证新种子）——宿主状态标记与运行态可能不一致，后续勿被
  restart-required 吓住，先实测再定是否真需重启。

## 4. 任务书 §6 问题清单逐条回答

### Q1 quota 缺席（未装/禁用/webServer 缺席）时的行为路径？

**应答：三态缺席全部无感回落 manual，无告警噪音，插件照常激活。**

| 缺席态 | 路径（证据） | 结果 |
|---|---|---|
| webServer 缺席（无该服务的 profile） | index.js:27 inject 可选面 → quota-source.js:47-53 resolveOrigin=null → createQuotaSource available:false → index.js:52-54 不建 cache → getQuota 恒 null（index.js:57） | machine 永远缺席；查询全行 manual/unknown；meta.quota {available:false, breaker:'unavailable', as_of:''}；渲染无 quota 表头；**零请求零日志** |
| quota 未装/禁用（端点 404/非 JSON） | fetchQuotaStatusRaw → http-404 / html-response → cache 失败占位+退避熔断 → getQuota null（无 stale） | 同上全量回落；失败不打 warn（缺席是常态路径非错误）；重试被退避节流（5s→10s→20s→cooling 5min） |
| quota 激活但刷新中/空数据 | refreshing 字段不阻塞读取（快照是上次完成态）；providers 空 → by_platform 空 | 渠道 note 标注「quota 快照无平台 … 行」回落 manual（degrade.test §6.2 断言） |

工具调用不阻断：execute 的 quota 获取在 try/catch 防御纵深内（index.js:63-70），任何意外按缺席
降级。`degrade.test.mjs §6.1` 断言全行 manual/unknown + note 无「未采信 quota 数值」噪音 +
excluded 空（零拦截）+ 渲染无表头。

### Q2 /status 可达但 providers 空/全 missing-key？

**应答：对应渠道回落 manual；「一次失败先 degraded」的语义落在 cache 熔断层，不是渠道行。**

- providers 空 → normalizeQuotaSnapshot by_platform 空 Map → machineBalanceOf（tool-query.js:78-79）
  `{use:'manual', why:'quota 快照无平台 "xiaomi" 行（quota 插件未装/未启用该平台）'}` → note
  「未采信 quota 数值（…），回落人工登记」（degrade.test §6.2 前半断言）。
- 全 missing-key → 行存在但 view.status='missing-key' ≠ 'ok'（tool-query.js:83-85）→ 回落 manual
  + note「状态 missing-key（未配置 XIAOMI_API_KEY…）」（degrade.test §6.2 后半断言）；行状态是
  quota 插件的如实上报，透出 message 截断 120 帮用户定位（快照无密钥值，§3.7）。
- **端点 404（quota 未装/停用，补修后语义）**：确定性缺席——cache 层首次即判 absent（quota-cache.js:76-87），
  不进退避熔断、无 stale 标注，占位走普通 TTL 过期自动重探测（quota 重新激活即自动恢复 machine）；
  getQuota 收 absent 失败（无 staleSnapshot）→ null → 全量回落 manual。详见 §7 补修 2。
- **degraded 辨析**：任务书「已 verified 的 machine 渠道标 degraded（一次失败先 degraded，连续 N
  次才 cooling）」落码在 **cache 层**（quota-cache.js：1 次失败 breaker='degraded'、3 次 cooling），
  指的是 **loopback 数据通道健康度**；本问的 providers 空/missing-key 是**快照内容态**，不进
  熔断计数（quota 插件没坏，只是该平台没数据）。cache degraded 且有 stale 快照时 → getQuota
  返回 degraded:true → machine 行 `balance.degraded=true` + note stale 标注（degrade.test stale
  组断言）——这正是「已 verified 渠道在通道 degraded 时的可见降级」。渠道行级 degraded 字段
  仍为 M1 恒 false 占位（健康状态机未上线，README 已知限制同步）。

### Q3 映射命中但 quota_account_verified=false？

**应答：不采信数值，回落 manual，note 标注原因。**

- tool-query.js:80-82：verified !== true → `{use:'manual', why:'quota 平台 "zhipu" 映射命中但账户
  未核实（quota_account_verified=false，不采信数值）'}` → note「未采信 quota 数值（…），回落人工
  登记」。
- 加严测试（degrade.test §6.3）：fixture 给 zhipu 行 **ok + 余额 ¥999.99**——即便数据完美可解析，
  未核实也绝不进 routes（balance_source=manual、无 balance 键）。红线「拿错账号余额当建议比不
  显示更糟」的可执行形态。
- 种子四渠道 verified=false（config-schema.js:57/72/88/102）；用户在设置面板核实后改 true 即
  启用（channel_schema 元素内字段随 channels 数组 volatile 热更，无需重启）。

### Q4 熔断恢复机制？

**应答：`ok → degraded →(连续3次失败)→ cooling →(冷却5min到点)→ half-open →(试探成功)→ ok；
试探失败回 cooling 重新冷却；失败结果占缓存位；恢复后 TTL 正常。**

- 状态机：quota-cache.js:69-99。冷却期 get 完全静默（:121-124，不发生请求）；到点本次 get 即
  试探（:125）；成功 :69-74 清零恢复；失败 :88-98 回 cooling。
- 失败占缓存位语义：失败写入 last 后，退避窗口 `min(30min, 5s×2^(n-1))` 内 get 返回失败标记
  `cached:true` **不发请求**（失败占位与指数退避合一；selfcheck 边界断言 4,999/5,001ms）。
- 恢复后 TTL 正常：试探成功 → last={ok:true} → 后续 60s 内命中（cache.test「恢复后 TTL 正常」
  断言 calls 不增）。
- stale 伴行：任何失败结果携带最近一次成功快照（staleSnapshot）供上层 degraded 展示——熔断
  期间用户看到的 machine 数据（若有）明确标注「最近一次成功快照（stale）」。

### Q5 currentModel / providerKeyRefs 能否增强「当前会话路由」展示？（可选加分项）

**应答：M2 不接线（裁决+证据如下），providerKeyRefs 已透出留作后续辅助判据。**

- **currentModel 不合并**：mroute 的 `current`（tool-query.js:488-495，exec.agent.options）是
  **发起查询的会话**自身的路由；quota 的 `currentModel`（config.ts:148-158）是 quota 插件视角的
  **宿主缺省模型**及其 pill 摘要——两者对象不同（子会话派遣场景下常不相等），合并展示会诱导
  模型把「宿主缺省」误当「本会话路由」。mroute 的展示维持 exec 来源更准确。
- **providerKeyRefs**：机读价值真实——`providerKeyRefs[providerId]`（DSH 供应商→凭证引用名，
  config.ts:143）与快照平台行 `keyRef` 对比可机读验证「同一把 key」（同账户必要条件）。M2 落法：
  归一化视图已透出 `provider_key_refs`（quota-view.js:150，selfcheck 断言透出），**不做自动
  verified 翻真**——keyRef 一致不证明渠道登记语义正确，且账户核实是用户决策不是插件推断
  （红线精神）。后续里程碑可做 note 级提示「keyRef 一致，核实后可在面板开启机读余额」。
- 证据：view.test「provider_key_refs 透出」断言；degrade.test machine 采信组（当前无 per-channel
  keyRef 消费路径）。

### Q6 zai-coding-cn 的 machine 通道会不会显示错账号余额？verified 标置依据链？

**应答：不会——三重防线，且新证据表明该渠道连「余额数值」都不存在（语义双重不匹配）。**

1. **采信门**：种子 verified=false（config-schema.js:57）→ machineBalanceOf 直接回落 manual
   （Q3 路径），映射命中也不采信（degrade.test §6.3 用 ¥999.99 数据加严验证）。
2. **数值语义门（新证据，细化任务书 §3.8 预设而非推翻）**：quota_platform='zhipu' 对应的行是
   **direct zai-coding 卡**（direct.ts:1003，format 'zai-coding'，endpoint
   `open.bigmodel.cn/api/monitor/usage/quota/limit`），条目全是**用量窗口**（'5h 窗口'/'本周窗口'
   percent/used/limit，direct.ts:382-403）——**无任何余额闭集条目**，归一化 balance 恒 null
   （quota-view isBalanceLabel 测试断言 '5h 窗口'/'周额度' 不命中）→ 即便未来 verified=true 也
   回落 manual（tool-query.js:86-88「无可解析余额数值」）。注意 MCP 的智谱 API 余额卡
   （'账户余额'，mcp.ts:251-280）平台 id 是 **'bigmodel'** 不是 'zhipu'——两个账户体系在 quota
   里就是两行；zai-coding-cn 不登记 'bigmodel'，不会把 ZHIPU_API_KEY 的 API 余额错接给包月渠道。
3. **币种守卫**（纵深）：未来任何 verified 渠道若出现非 CNY 数值，不参与 CNY 阈值（Q 裁决 §2.3）。
- **verified=false 依据链**：①AGENTS §9 登记语义 = GLM Coding **包月订阅**；quota zhipu 卡的
  keyRefs 候选含 ZAI_CODING_CN_API_KEY（direct.ts:1003）——**若**用户包月 key 正是此引用名，
  账户可能同源，但本会话无法核实（mroute 不读凭据，红线 §5.3）；②即便同源，卡上数据是窗口
  用量百分比不是 CNY 余额（防线 2），「包月订阅 ≠ API 余额账户」的任务书预设在本环境细化成
  「订阅用量窗口 ≠ 余额数值」。结论：维持 verified=false + 数值语义说明；用户若核实 keyRef
  同源且接受窗口语义，属后续需求（percent→windows 归一化，本里程碑不做）。

## 5. 红线自查（grep 证据，2026-11-15）

| 红线 | 检查 | 结果 |
|---|---|---|
| advisory-only 零拦截 | degrade.test：缺席/unverified/low_balance 全组 excluded 空 + rank 原位断言；无 tools.guard 接线 | ✓ |
| 不碰 llm-stream/agent-request | grep `\.stream\(|prepareCall|tools\.guard|\.on\(|agent\.request` 于 lib/*.js：仅 3 处注释提及（config-schema.js:183 / registry.js:99 / tool-query.js:30），**代码零命中** | ✓ |
| 不接触 API Key | grep `credentials|apiKey|api_key|secret|password` 于 plugin-mroute *.js：仅 platform-map.js:19 注释（apiKeyEnv 引用名说明，移植注释），**代码零命中**；快照消费面无 keys 字段（parse 即丢弃） | ✓ |
| 唯一 HTTP 面 = loopback | grep `https?://` 字面 URL 于 lib/*.js：零命中（origin 运行时取自 getOrigin）；isLoopbackOrigin 围栏 + 非 loopback 不发请求（selfcheck 断言） | ✓ |
| quota 插件零改动 | 本会话未写 plugin-quota-multi/ 任何文件（只读 grep/read） | ✓ |
| 上游原始 JSON 不出宿主 | source.test 裁剪断言 + view.test 视图键集 deepEqual 断言 | ✓ |
| AbortError 重抛 + 渠道隔离 | source.test raw 层 rejects(name) 断言；view.test 畸形行隔离断言 | ✓ |
| schemastery volatile 纪律 | config-schema.js:165/171 元素内无 volatile；channels 数组整体 volatile 不变（M1 定案） | ✓ |
| 不 install_bundle / 不重启 DSH | 本会话未调用 plugin_manager；未触碰运行中 DSH | ✓ |

## 6. 遗留与后续衔接

1. lead 实测清单建议：安装激活 → quota_refresh 一次 → model_route_query 看 xiaomi 行
   balance_source=machine + ¥57.93（AGENTS §9 实测余额）+ meta.quota；停用 quota 插件 → 重查
   → 全行 manual 无噪（Q1 路径）；恢复。
2. deepseek-official/deepseek-account 的 verified 需用户核实（quota deepseek 卡用 DEEPSEEK_API_KEY，
   direct.ts:1000；哪把 key 对应哪渠道由用户确认后在面板改 true）。
3. zai-coding-cn 窗口语义（percent→QuotaView windows）归一化：verified 核实后才有意义，属
   后续需求（07a 契约本有 windows 槽位）。
4. providerKeyRefs 辅助提示（Q5）：keyRef 一致性 note 提示，M3+ 候选。
5. 宿主策略门（assignee 显式路由）依旧拒显式 assignee（AGENTS §7 重测实录）——mroute 侧无动作，
   advisory 表头/工具描述「被拒换下一项」口径已覆盖。
