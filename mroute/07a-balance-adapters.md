# 07a · 余额/额度类社区插件源码级分析（mroute 增量）

> leaf mroute-W7-balsrc 产出。方法：逐包 README → package.json → lib/src 源码通读，回答 A 宿主接缝 / B 渠道端点实现 / C 工程面 / D（provider-usage 专项）四问。每包 B 节末尾以「02 对照」标注相对 02 渠道 API 调研的源码级增量。六包全部完成。

## 总览矩阵

| # | 包 | 版本 | License | 覆盖渠道 | 宿主接缝 | 凭据存放 |
|---|---|---|---|---|---|---|
| 3 | wai549077/dsh-aliyun-balance | 0.1.4 | MIT | 阿里云 BSS 余额+代金券 | webServer 路由×3 + index-inject + credentials 服务 | credentials 服务（ALIYUN_BILLING_AK/SK） |
| 4 | yanlijin/dsh-qwen-balance | 0.1.1 | MIT | 阿里 BSS + 代金券 + OpenAI 兼容中转（new-api/one-api + DeepSeek 风格） | name/inject/Config/apply 四导出 + webServer 路由×3 | env > AK 文件 > 配置明文（不用 credentials 服务） |
| 5 | ShawnKung/dsh-balance-monitor | 0.2.3 | MIT | DeepSeek / Kimi / 智谱 GLM / TeamoRouter | name/inject/Config/apply + webServer×6 路由 + llm/sessions/settings 注入 | credentials 服务（Config 里 role('credential-ref') 声明） |
| 1 | wenzetan/dsh-quota-panel | 0.1.7-rc.1-v0.1 | MIT | DeepSeek/OpenRouter/SiliconFlow双站/Moonshot/MiniMax双站/StepFun/xAI/智谱+GLM Coding/Z.AI/Kimi Coding/OpenCode Go/方舟 Agent+Coding/ChatGPT 订阅/new-api（16 目录行） | connection.fetch.register（/api 围栏）+ shell.overlay 槽位 | credentials 服务（refs+secretRefs 双引用）；ChatGPT 走 ~/.codex/auth.json 或设备码登录 |
| 2 | wingsky-1/dsh-provider-usage | 0.2.11 | MIT | v2 用量采集框架（deepseek-official / opencode-go / zai-coding-cn 内置 + 用户 mjs） | cordis 四导出 + /api/dsh-provider-usage/* 8 路由 | apiKey 五级链：credentials seam(apiKeyEnv)>显式配置>env>credentials.yaml>auth.json |
| 6 | Thedeergod666/dsh-musage | 0.1.4 | MIT | MiniMax/DeepSeek/Kimi/OpenRouter/智谱/百炼 Coding Plan（6 家跟随当前模型） | cordis 四导出（credentials+subprocess+timer）+ GET /musage/quota + conversation.input.right slot | credentials 服务（refs 候选数组按 <UPPER>_API_KEY 规范，sticky） |

---

## Pkg 3 · wai549077/dsh-aliyun-balance（阿里云余额+代金券悬浮挂件）

### A. 宿主接缝
- **注册面**：`apply(root, config)` 直接被宿主调用（非 cordis name/inject 风格，desktop profile 兼容写法）。内部两段式：
  1. **立刻注册** `root.on('webserver/index-inject', table)`：往注入表推一条**内联 script 行**（text 形态），由它动态建 `<script src="/dsh-aliyun-balance/widget.js">`。为什么必须内联：桌面壳 index.html 从安装包 dist 直出、`tapIndex` 过不去；推 `script-src` 行会被 await、加载失败会 reject `__DSH_BOOT_READY__` 整个应用起不来；桌面壳只在宿主启动时一次性收集注入表，所以 apply 必须立刻注册（来源：照抄 dsh-whale-widget issue #152/#153/#154 的坑）。
  2. **等服务就绪** `root.inject(['webServer','credentials'], start)`（等价于对象级 inject 但不挡注入行注册）。
- **路由**：`ctx.webServer.register({kind:'exact', path, handler})` ×3：`/widget.js`（每次请求重读磁盘，改前端刷新页面即生效）、`/overview.json`（GET，取数）、`/settings.json`（GET/PUT/POST，含凭据写入）。
- **凭据**：走 **DSH 官方 credentials 服务** `ctx.credentials.resolve(ref)` / `set(ref, value)`，引用名 `ALIYUN_BILLING_AK` / `ALIYUN_BILLING_SK`（ref 命名须符合 `[A-Za-z_][A-Za-z0-9_]*`）。settings GET 只回 `hasAk/hasSk`，永不回显密钥。README 明说 credentials 底层文件 `~/.dsh/.credentials.yaml` 是明文 YAML。
- **幂等激活**：同进程可能被激活多次（实测每次启动两条 apply），保存上一次的 disposers、新激活先 `disposeLive()` 收干净，防 `duplicate exact route` 与双份轮询。`root.inject` 返回的 fiber 也要进 disposers（防两次激活都早于服务就绪时双 start）。
- **定时器**：`ctx.effect(() => {...})` 包裹 + 手动进 disposers 双保险。

### B. 渠道端点实现
- **端点**：`https://business.aliyuncs.com/`（可配，仅允许 `*.aliyuncs.com` 正则白名单，含国际站 `business.ap-southeast-1.aliyuncs.com`）。
- **签名**：**ACS3-HMAC-SHA256**（v3 风格）。实现要点（lib/bss-client.js，纯函数）：
  - `Action`/`Version` 走 `x-acs-action` / `x-acs-version` 头（Version=2017-12-14），其余业务参数默认进 query（paramLocation 可选 body + `content-type: application/x-www-form-urlencoded`）。
  - 必签头：`host`、`x-acs-action`、`x-acs-version`、`x-acs-date`（ISO8601 UTC）、`x-acs-signature-nonce`（16 字节随机 hex）、`x-acs-content-sha256`（body 的 SHA256，空 body 用 EMPTY_SHA256）。
  - CanonicalRequest = `[method, uri, queryString, canonicalHeaders, signedHeaders, contentSha256].join('\n')`；canonicalHeaders 每行 `name:value\n` **末行也带 \n**，join 后不再追加空行（多一个空行 → SignatureDoesNotMatch）。
  - StringToSign = `ACS3-HMAC-SHA256\n{sha256hex(CanonicalRequest)}`；Signature = HMAC-SHA256(sk, StringToSign) hex。
  - Authorization 头：`ACS3-HMAC-SHA256 Credential={ak},SignedHeaders={...},Signature={sig}`。
  - **黄金用例**：QueryCashCoupons / QueryAccountBalance 两个 CanonicalRequest 的 SHA256 已写进 test/bss-sign.test.mjs（用服务器返回的 CanonicalRequest 反推验证过）。
- **Action 与解析字段**：
  - `QueryAccountBalance` → `Data.{AvailableAmount, AvailableCashAmount, CreditAmount, MybankCreditAmount, QuotaLimit, Currency}` → `{available, cash, credit, mybankCredit, quotaLimit, currency}`。RAM 权限 `bss:DescribeAcccount`（官方双 c）。
  - `QueryCashCoupons` → `Data` 可能是数组 / `Data.CashCoupon` / 多层嵌套（couponList() 六个候选位置逐个试）→ 每券 `{CashCouponId, CashCouponNo, NominalValue, Balance, Status, EffectiveTime, ExpiryTime, GrantedTime, ApplicableProducts, ApplicableScenarios, Description}`。权限 `bss:DescribeCoupons`。
  - **有效券判定**：Status ∈ {available, availabletouse}（小写比较）才计入 availableBalance；排序可用在前、失效时间升序。
  - **坑**：省略 EffectiveOrNot 参数的返回范围未经验证——列表为空时用 `EffectiveOrNot:'true'` 和 `'false'` 各取一次合并兜底。
- **金额契约**：一律两位小数字符串；求和按「分」整数累加避免浮点误差；异常输入退化为 '0.00'/null，不抛异常。
- **02 对照**：02 文档若只记录了 QueryAccountBalance，则 **QueryCashCoupons 的 EffectiveOrNot 兜底双查、Data 六种包裹形态、Availabletouse 状态值、bss:DescribeAcccount 双 c 权限名** 是源码级增量。

### C. 工程面
- **缓存**：per-scope（balance/coupons 分区独立）freshness 三态 miss/fresh/stale；TTL 默认 300s（5 分钟）、下限 30s；in-flight 去重（并行刷新不重复打 API）；`?refresh=1` 强制绕过。
- **轮询**：固定 `setInterval` ×2 分区，`timer.unref()`；**刻意不退避**——刷新失败成本低（只读请求），退避反而拖慢「凭据刚修好」的恢复。
- **失败处理**：分区失败不遮别的分区；errors 数组 `{scope, code, message}`；`ok` 语义 =「凭据可用」而非「取数全成功」。日志 200 行环形缓冲 + 按 key 节流（稳态事件 5 分钟一枪，异常 10s 一枪），密钥绝不落日志。
- **安全**：settings 路由双闸门——① Origin 与 Host 同源（环回三别名视为同站）+ Sec-Fetch-Site 必须 same-origin；② 只收 `application/json`（强制跨源请求走预检，浏览器自己拦掉 text/plain 简单请求）。
- **test-before-save**：「测试连接」**绝不先落盘**——旧实现先写凭据再测，测试失败但坏值已覆盖好值，后台从此一直 Forbidden。现在先测、测通才写；缺哪侧回退用已存的那侧（支持「只换 SK」）。写入失败必须回 `ok:false`，不得谎报「已保存」。
- **UI**：原生 DOM 悬浮行挂件（无构建步骤），拖动记忆/双击复位/单击强制刷新/悬停明细卡；配色走 DSH 主题令牌 `--dsw-alias-*`。

---

## Pkg 4 · yanlijin/dsh-qwen-balance（阿里 BSS + 代金券 + 中转站额度卡片）

### A. 宿主接缝
- **注册面**：cordis 标准四导出 `export const name / inject / Config / apply` + `export default {name, inject, Config, apply}`；`inject = ['webServer']`。`apply(ctx, config)` 里 `ctx.effect(fn, 'dsh-qwen-balance: runtime')` 挂路由+定时器，`ctx.on('loader/volatile-update', () => runtime.rearm())` 监听配置热更新。
- **Config**：`@deepseek-ai/schemastery` `z.object({...}).volatile()`——**每个用户可见字段都带 volatile()**，宿主只在至少一个字段 volatile 时才派生设置表单。
  - **schemastery 解析三级兜底**（工程教训）：裸 import → 按 `~/.dsh/profiles/<p>/node_modules/@deepseek-ai/schemastery/lib/index.mjs` 绝对路径 → 内置极简 stand-in。动因：pnpm `link:` 安装会符号链接包、ESM resolver realpath 后裸说明符解析不到 hoisted 副本 → `ERR_MODULE_NOT_FOUND`。
  - **volatile 陷阱**：数组自身 volatile 后，其元素字段不能再标 volatile（schemastery 要求 volatile 在固定对象路径），否则 ValidationError。
- **路由**×3：`GET /api/dsh-qwen-balance/overview?lang=zh|en`、`POST /refresh`、`POST /client-report`（v0.1.1 诊断，卡片自报挂载状态，body ≤2KB、超限 413）。全部 loopback 围栏。
- **凭据**：**不用 credentials 服务**。三级优先级：env（`ALIYUN_AK_ID/SECRET` + 别名 `ALIBABA_CLOUD_*`、`ALIYUN_ACCESS_KEY_*`，STS `ALIYUN_STS_TOKEN`）> AK 文件 `~/.dsh/qwen-coupon.json`（扁平或嵌套 aliyun 对象均可）> 配置明文（明示不安全，万不得已）。**整源选择**：第一个同时有 id+secret 的源胜出，不跨源拼对（拼出来的对不存在，只会报 Confusing InvalidAccessKeyId）。

### B. 渠道端点实现
- **阿里 BSS（RPC V1.0 / HMAC-SHA1）**——与 Pkg 3 的 ACS3-HMAC-SHA256 是**两套不同的阿里签名**：
  - 公共参数：`AccessKeyId, Action, Format=JSON, SignatureMethod=HMAC-SHA1, SignatureNonce=randomUUID(), SignatureVersion=1.0, Timestamp=ISO8601 UTC 秒精度, Version=2017-12-14`，STS 时加 `SecurityToken`。
  - percentEncode 的 Java 对齐：`encodeURIComponent` 后 `+`→`%20`、`*`→`%2A`、`!`→`%21`、`'`→`%27`、`(`→`%28`、`)`→`%29`、`%7E`→`~`（JS 的 encodeURIComponent 不编码 `!'()*` 四个，Java 的 URLEncoder 会，必须手工补）。
  - StringToSign = `METHOD & %2F & percentEncode(canonicalQuery)`；Signature = base64(HMAC-SHA1(sk+'&', StringToSign))。**官方黄金向量** `OLeaidS1JvxuMvnyHOwuJ+uX5qY=` 锁定，注释明令不许「改进」Timestamp 格式（是签名材料的一部分）。
  - GET + query 传签；HTML/非 JSON 响应在 parse 前分类报错；`Code` 为空/'200'/'Success' 算成功。
- **Action 与字段**：`QueryAccountBalance`（同 Pkg 3 字段，number|null 契约）；`QueryCashCoupons`（无按券号过滤参数，只能全量拉回本地 pickCoupon；`Status=Available` 才计入合计；ExpiryTimeStart/End、EffectiveOrNot 是仅有的服务端参数）。
- **OpenAI 兼容中转站（0..N 个 gateways[]）**——两族端点自动降级：
  - **A. new-api/one-api billing**：`GET {origin}/dashboard/billing/subscription` → `hard_limit_usd`（USD 元）；`GET {origin}/dashboard/billing/usage` → `total_usage`（**单位是美分，必须 /100**）。total = hard_limit_usd，used = total_usage/100，remaining = total − used。
  - **B. DeepSeek 风格**：`GET {origin}/user/balance` → `balance_infos[]` 取 CNY 优先的 `total_balance`。
  - `kind: auto` 先试 A 再回落 B；base 尾部 `/v1` 自动剥离再试（billing 路由在 origin 根）。
  - **旧版 one-api 陷阱**：对未知路由回 **200 + HTML 页面**——必须先按 content-type/首字符 `<` 判 HTML 再 JSON.parse，否则要么抛异常要么把网页解析成假余额。
- **DashScope 事实**：`sk-` key 没有任何余额接口；千问 CLI OAuth 登录态只有用量/套餐命令、没有代金券命令——余额/券唯一程序化路径是 BSS + AccessKey（README 明说，避免后来者重复踩坑）。
- **02 对照**：中转站两族端点 + total_usage 美分陷阱 + 200/HTML 陷阱是关键增量；与 02 的 new-api 调研互证。

### C. 工程面
- **传输层硬约束**：**禁用 globalThis.fetch/undici，只用 node:http(s) + `agent: false`**——Windows 上 undici keep-alive socket 与 libuv handle teardown 并发，`process.exit` 触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) ... async.c:94` 崩溃。每请求独立短连接。超时 15s。这对 DSH 插件普遍适用（宿主常驻进程）。
- **快照缓存**：单快照 + single-flight（inFlight 共享并发）+ 自重臂定时器；`ensure()` 缺失或过期才刷；rearm 按 `enabled:pollIntervalSec` 签名判断，改无关字段不重置节奏；激活时后台预热不阻塞。默认 60s，30–3600 可调。
- **失败隔离**：每源独立 try/catch → `{state: ok|off|error, error}`，绝不冒泡 500；保持上次快照追加错误行；不可读 AK 文件也算「已配置」（要告诉用户为什么没数据，而不是给「未配置」误导）。
- **安全**：loopback 三重围栏（socket remoteAddress 127/8::1::ffff: + Host 头 loopback + Sec-Fetch-Site≠cross-site + Origin 同源；X-Forwarded-For 永不信任）；`redactSecrets` 在边界统一替换（第三方错误体可能回显 Bearer，按原文+URL 编码两种形态替换，≥6 字符才替换防误伤）；`maskKey`（≤12 位前 2+`***`，长则前 6+`...`+后 4）。
- **数字契约**：所有数值 `number|null` 永不 undefined（undefined 会被 JSON.stringify 丢键，浏览器分不清「没这字段」和「没值」）。
- **UI**：侧栏 foot 单文件卡片（`window.__ModuleLoader__.load` 包裹，无打包器无 React）；宿主量数、卡片纯渲染，浏览器拿不到任何密钥；`navigator.language` 定语言，字段名是稳定契约、label 跟语言。

---

## Pkg 5 · ShawnKung/dsh-balance-monitor（DeepSeek/Kimi/智谱/Teamo 多渠道侧栏）

### A. 宿主接缝
- **注册面**：cordis 四导出（同 Pkg 4）。`inject = ['webServer', 'credentials']`；再二级 `ctx.inject(['llm','settings','sessions'], ...)` 做路由识别（这四项是渠道自动路由的关键）。
- **Config**（schemastery）：`sidebarChannels`（≤3 多选）、`channelOrder`、`balancePrecision`、四个 `xxxApiKeyRef: z.string().role('credential-ref').default('DEEPSEEK_API_KEY'|'KIMI_API_KEY'|'ZAI_API_KEY'|'TEAMO_API_KEY')`、`teamoBaseUrl`、`teamoRangeDays(2..90)`。**`role('credential-ref')` 是把 Config 字段声明成凭据引用的宿主约定**——设置 UI 会按凭据引用渲染。
- **配置读取**：`ctx.inject(['settings'], ...)` 里 `settings.describe({redactSecrets:false})` 找 `ns==='dsh-balance-monitor'` 取值；监听 `settings/document-updated`（global）热应用；带**源签名**（JSON.stringify 关键字段）判断是否需要刷新全部。
- **会话事件**：`ctx.on('session/event', (session, event) => ..., {global: true})` 只处理 `turn/end` → 按 session 的 provider 路由到渠道定向刷新。
- **凭据解析优先级**（service.js resolveCredential）：**environment（credentials 服务里 source ∈ env/project-env/user-env）> model provider refs（llm 目录里 apiKeyEnv 与渠道匹配的引用，仅当唯一时）> user config ref**。多候选冲突时不擅自选。浏览器只收 `hasConfigured/来源/可写` 元数据。

### B. 渠道端点实现
渠道对象契约（channels/*.js，**这是 mroute 渠道层的最小参考形状**）：
```js
export const xxxChannel = {
  id, label,
  credentialRef(config),          // 配置里存 credentials ref 的字段名
  environmentRefs(),              // 环境变量名兜底 ['DEEPSEEK_API_KEY']
  credentialEndpoint(config),     // 渠道关联端点（供 provider 域名匹配）
  async fetch({apiKey, config, fetchImpl}) {
    // fetch(endpoint, {Authorization: Bearer, Accept, signal: AbortSignal.timeout(15000)})
    // 返回 {currency, balance, balanceRaw, detail:[{label,value,amount?,rawAmount?,currency?,tone?}], periods:[{label,cost,amount,requests,currency}], note?}
  },
}
```
- **DeepSeek**：`GET https://api.deepseek.com/user/balance`（Bearer）→ `balance_infos[]` 选 total_balance>0 的，回落 CNY，再回落 [0]；字段 `total_balance / topped_up_balance / granted_balance / currency`、`is_available`。
- **Kimi（CN）**：`GET https://api.moonshot.cn/v1/users/me/balance`（Bearer）→ `{status:true, code:0, data:{available_balance, cash_balance, voucher_balance}}`。README 注：Moonshot 国际站 / Kimi Coding / Z.AI Coding Plan 与 CN 余额**不是同一账户体系**，不误触发。
- **智谱 GLM**：`GET https://www.bigmodel.cn/api/biz/account/query-customer-account-report`（Bearer）→ `{success:true, code:200, data:{availableBalance|balance, rechargeAmount, giveAmount, todaySpendAmount, totalSpendAmount}}`（多带今日/累计消费）。
- **TeamoRouter**：`GET {base}/v1/billing/balance` → `{balance:{value, currency}}`；`GET {base}/v1/billing/costs?start_time&end_time`（Unix 秒）→ `{total_amount:{value, requests}}`；`GET {base}/v1/usage?...` → `{usage:{total_tokens, input_tokens, output_tokens, cached_read_tokens}}`。三个并发 `Promise.allSettled`，单失败降级为 error 行。唯一一家带消费+Token 用量。
- **02 对照**：智谱 `query-customer-account-report`（网页域名的 biz API 而非 open.bigmodel.cn）与 Teamo 三端点是主要增量；DeepSeek/Kimi 与 02 互证。

### C. 工程面
- **刷新策略**（无 TTL 缓存、事件驱动）：启动全刷 → 手动全刷/单渠道刷 → `turn/end` 定向刷 → 60s ActiveSessionRefresher 轮询枚举实时 Session（`session.snapshotEvents()` 从尾扫 `turn/start` 无 `turn/end` 判活跃），活跃渠道每轮只刷一次，无活跃会话不请求。
- **渠道路由识别**（channel-routing.js）：provider 从 `session.requestHeader().config.provider ?? session.requestContext().provider`；provider 条目经 `llm.listConfigurableProviders()` → settings ns 里 `baseURL`/`apiKeyEnv`；**baseURL 有值按 URL.hostname 精确/子域名匹配**（`teamorouter.cn/moonshot.cn/bigmodel.cn/deepseek.com`），无 baseURL 用内置 provider-id 映射（`deepseek-official|deepseek`→deepseek、`moonshotai-cn`→kimi）。未命中不兜底全刷（避免误刷别的账户）。
- **状态机**：per-channel `idle/loading/ready/unconfigured/error`；error 时 `stale: previous.status==='ready'` 保留旧值；**revision 单调递增**快照（前端拒绝迟到旧快照，防启动 loading 覆盖已完成结果）；pub/sub + SSE 推送。
- **HTTP 面**：`/api/dsh-balance-monitor/{state,refresh,credential,events,update,update/events}`；loopback + same-origin 双检；SSE 25s 心跳；body ≤4KB。
- **自更新**：npm registry `latest` 检查每 10 分钟（host 全局单例 + SSE 同步状态）；安装只接受固定包名+Registry 精确 SemVer、调当前 DSH CLI `plugin --profile web add`，装后回 profile 校验；`link:/file:` 安装不显示更新入口。
- **UI**：侧边栏余额行（新会话与工作区之间）+ 弹窗详情 + 插件设置页；浅/深/跟随系统主题；SortableJS 拖排序（打包进 client.js）。
- **其余**：Node ≥20；DSH `>=0.1.7-rc.1 <0.2.0`；仅 web profile；`AbortSignal.timeout(15s)` 统一超时。

---

## Pkg 1 · wenzetan/dsh-quota-panel（16 渠道额度面板，本批覆盖面最广）

### A. 宿主接缝
- **双面插件**：宿主 `lib/index.js`（src/index.ts 编译产物）+ 浏览器 `lib/client.js`（React，`dsh.client` manifest 进 `__DSH_BOOT__` 模块图，`immediately: true` 预取）。
- **注册面**：`apply(ctx, config)` 里 `ctx.connection.fetch.register({path:'/api/dsh-quota-panel/<endpoint>', methods:['POST'], requestBody:'buffered', fetch})`——**骑在 DSH 自带 `/api` 鉴权通道下**（受信任主机 + 浏览器会话围栏）。端点：`specs`（渲染提示）、`fetch-all`（归一化视图）、`chatgpt-auth-status/login-start/login-cancel/logout`。
  - **关键教训（v0.9.2-rc.2）**：不能用 `connection.rpc.handle()`——DSH 0.1.5+ 该通道的销毁回调把 `owner.webServer` 解析到 Connection 插件自己的 fiber（永远没有 webServer），第三方在子 fiber 注册会静默抛错消失、启动日志一片安静。Fetch registry 只需 `owner.effect`。
- **浏览器半**：`shell.overlay` 槽位（右下角）+ `ctx.interval` timer 服务（`ctx.interval` 刷新周期，页面隐藏暂停）+ `ctx.locale` 词典服务。
- **凭据**：`ctx.credentials.resolve(ref)`；**双凭据引用** `refs`（AK）+ `secretRefs`（SK）——方舟 AK/SK 场景，两者都解析到才上板。目录探测引用名 UPPER_SNAKE（如 `DEEPSEEK_API_KEY`、`VOLC_ACCESS_KEY`+`VOLC_SECRET_KEY`）。
- **自动发现**：DSH 无凭据枚举 API → 宿主每刷新周期探测目录条目的引用名，能解析的上板、删 key 即消失；显式 providers 行 key 缺失才报行内错误。`localAuth: 'codex'` 行（ChatGPT）跳过凭据探测、改查 auth 文件存在性。

### B. 渠道端点实现（16 目录行 + 14 format 适配器）
**目录（provider id → 端点 → 引用 → 行类型）**：
| 渠道 | 端点 | 引用 | 行类型/响应 |
|---|---|---|---|
| DeepSeek | `api.deepseek.com/user/balance` | DEEPSEEK_API_KEY | balance_infos[] |
| OpenRouter | `openrouter.ai/api/v1/credits` | OPENROUTER_API_KEY | `{data:{total_credits, total_usage}}` 余额=购入−已用 |
| SiliconFlow 国际/国内 | `api.siliconflow.{com,cn}/v1/user/info` | SILICONFLOW(_CN)_API_KEY | `{data:{balance, chargeBalance, totalUsage}}`，双站点独立 id |
| Moonshot | `api.moonshot.cn/v1/users/me/balance` | MOONSHOT_API_KEY | `{data:{total_balance}}` |
| MiniMax Coding 国际/国内 | `www.minimax.io`/`api.minimaxi.com/v1/token_plan/remains` | MINIMAX(_CN)_API_KEY | `model_remains[]` 优先取 MiniMax-M* 编码模型行；计数是**剩余侧**（已用=总−计数）；`current_weekly_total_count>0` 才有周窗 |
| StepFun | `api.stepfun.com/v1/accounts` | STEP_API_KEY/STEPFUN_API_KEY | `{balance, total_cash_balance, total_voucher_balance}` |
| xAI | `api.x.ai/v1/billing/credits` | XAI_API_KEY | `{total:{val}}`（分→元） |
| 智谱 GLM | `open.bigmodel.cn/api/monitor/usage/quota/limit` | ZHIPU/GLM_API_KEY | `{code:200, data:{limits:[{remaining, number}]}}` 文本行（智谱无公开余额接口） |
| 智谱 GLM Coding / Z.AI | `open.bigmodel.cn`/`api.z.ai/api/monitor/usage/quota/limit` | ZAI_CODING_CN/ZAI_API_KEY | `limits[]` 语义映射：TOKENS_LIMIT `unit=3`→5h 窗、`unit=6`→周、TIME_LIMIT→MCP 月度；CREDIT_LIMIT 行共用同一套 unit 声明（积分套餐）；未知 unit 回退 nextResetTime 排序；百分比优先 `percentage` 字段 |
| Kimi Coding | `api.kimi.com/coding/v1/usages` | KIMI_API_KEY | 5h=`window.duration=300`、周=`10080`；used=limit−remaining（顶层 usage 兜底） |
| OpenCode Go | `opencode.ai/zen/go/v1/usage` | OPENCODE_GO_API_KEY | `{usage:{rolling|weekly|monthly:{percent, resetsAt}}}` |
| 火山方舟 Agent/Coding | `open.volcengineapi.com` OpenAPI | VOLC_ACCESS_KEY+VOLC_SECRET_KEY | GetAFPUsage→`Result.AFPFiveHour/AFPWeekly/AFPMonthly`；GetCodingPlanUsage→`Result.QuotaUsage[].Level∈{session,weekly,monthly}`；**两行独立不互退**，未订阅显示行内提示 |
| ChatGPT 订阅 | `chatgpt.com/backend-api/wham/usage` | OAuth 令牌 | `rate_limit.primary_window/secondary_window` |

- **方舟 AK/SK 签名（SigV4 变体）**——与 AWS SigV4 的三处差异（照抄必踩坑）：
  1. SignedHeaders **固定顺序** `host;x-date;x-content-sha256;content-type`（**非字母序**）；
  2. 算法串裸 `HMAC-SHA256`（无 `AWS4` 前缀），credential scope 以 `/request` 结尾（非 `/aws4_request`）；
  3. 推导链第一层直接 `HMAC(SK_raw, date)`（无 `AWS4` 前缀）。链：kDate→kRegion→kService→kSigning(HMAC('request'))→签名 hex。xDate 格式 `YYYYMMDD'T'HHmmss'Z'`（ISO 去符号取 15 位+Z）。Action/Region/Version=2024-01-01 走 query；POST 空 body；service=`ark`。
  - **响应陷阱**：火山把业务错误包成 **200 + `ResponseMetadata.Error`**，必须查体不看 HTTP 状态。
  - region 推导：显式 provider.region > endpoint 里 `ark.<region>.volces.com` 正则 > cn-beijing。
- **ChatGPT 订阅用量**（实验性，无公开 API）：
  - 端点 `GET https://chatgpt.com/backend-api/wham/usage`，头 `Authorization: Bearer <access_token>` + `ChatGPT-Account-Id: <account_id>`。
  - **令牌来源优先级**：① DSH 托管 `$DSH_HOME/dsh-quota-panel/chatgpt-auth.json`（插件内设备码登录，0600 权限，含 refresh 回写）→ ② `~/.codex/auth.json`（或 `$CODEX_HOME/auth.json`，读 `tokens.access_token`；**只读不回写**，Codex CLI 拥有该文件；刷新令牌只留进程内存）。
  - **设备码流程**：`POST auth.openai.com/api/accounts/deviceauth/usercode`（得 user_code+device_auth_id，15 分钟有效）→ 用户在 `auth.openai.com/codex/device` 输码 → 宿主轮询 `POST .../deviceauth/token`（body `{device_auth_id, user_code}`）→ 拿 authorization_code + PKCE verifier 换 `POST auth.openai.com/oauth/token`；client_id=`app_EMoamEEZ73f0CkXaXp7hrann`（Codex 同款）。refresh 走 form-urlencoded `grant_type=refresh_token`。
  - **窗口判别**：primary/secondary 位置不是契约——按 `limit_window_seconds` 判（18000s±5%→5h 滚动、604800s±5%→周），缺失才回退典型布局（primary=5h, secondary=周）。两窗落同泳道时，单一已知 duration 的证据胜出。
  - 401 → 清缓存强制刷新一次重试。OpenAI 错误体两种形态（嵌套 `{error:{code,message}}` 与扁平 OAuth2）都要处理，别渲染 `[object Object]`。
- **openai-billing（one-api/new-api 聚合站）**：`{base}/v1/dashboard/billing/subscription`→`hard_limit_usd` + `{base}/v1/dashboard/billing/usage`→`total_usage`；余额 = 上限−已用（$）。**注意与 Pkg 4 的路径差异**：这里带 `/v1` 前缀（Pkg 4 不带）。
- **02 对照**：xAI `/v1/billing/credits`、StepFun `/v1/accounts`、OpenRouter `/api/v1/credits`、MiniMax `token_plan/remains`、Kimi Coding `coding/v1/usages`、智谱 quota/limit 的 `unit` 语义表、方舟两个 Action 与 SigV4 变体细节、ChatGPT wham/usage 全链路——均为相对 02 的高价值增量。

### C. 工程面
- **归一化视图模型**：`{kind:'balance'|'usage'|'info', amount?, windows?, title?}`——上游原始 JSON 与 key 都不出宿主；浏览器只拿渲染提示（specs）与归一化结果（fetch-all）。
- **失败处理**：单行失败不影响其他行（`Promise.all` per-row try/catch → `{id, error}`）；代理引擎 socket/request 的 error 事件全部汇入行结果（v0.9.2-rc.3 前未挂监听会让宿主直接崩）；15s 超时、1MB body 上限（先 arrayBuffer 检查大小再 parse）。
- **代理引擎**（零依赖手写）：https 目标走 CONNECT 隧道、http 走绝对 URI；仅 http(s)，socks 拒绝；优先级前端设置 > profile > 直连。**已知风险**明示：Authorization 头对代理可见；代理 URL 可被持会话者指向任意服务器。
- **轮询**：默认 60s（`refreshMs>=5000` 校验，config 非法 fail loud）；页面隐藏暂停；刷新按钮防并发。
- **阈值分级在客户端**（specs 下发 profile 阈值，前端 localStorage 本地覆盖，无需重拉）；余额三档 `{critical<=warn<=healthy}` 默认 {10,20,50}，用量 `warnPercent/errorPercent` 70/90。
- **宿主线 pin 策略**：peerDependencies 精确 pin 五个接缝包到 `0.1.7-rc.1`；版本串 `<dsh线>-v<本地号>`；发布通道跟随 dsh 自己的 dist-tags。mroute 不必抄这个策略，但说明「接缝包版本敏感」是社区共识。
- **零 npm 依赖**：schemastery+cosmokit vendor 进 src/vendor 相对导入。
- **UI**：胶囊/卡片双尺寸、拖动（指针捕获+视口钳位）、主题 token 全跟随（`--dsw-alias-*`）、i18n 双语词典、`createElement/textContent` 无 innerHTML。

### D. 对 mroute 的特殊价值
quota-panel 是**渠道覆盖面最广**的实现（16 行），且它是「**宿主归一化 + 浏览器纯渲染**」架构的最完整样本。它的 format 适配器表（14 种）+ 目录（id/refs/secretRefs/endpoint/format/currency/tiers）结构几乎就是 mroute 渠道层想要的形状，可直接平移为数据驱动目录。

---

## Pkg 6 · Thedeergod666/dsh-musage（6 家套餐跟随当前模型切换）

### A. 宿主接缝
- **注册面**：cordis 四导出；`inject = ['credentials', 'subprocess', 'timer']`（注意 **subprocess 是 curl 方案的前提**）；webServer 缺席的环境（headless）用 **scoped `ctx.inject(['webServer'], scope => ...)`** 保证只在服务出现时挂路由、其余环境零副作用。定时器走 `ctx.timer.interval(fn, ms)` / `ctx.timer.timeout(fn, ms)`（非裸 setInterval）。
- **路由**：`GET /musage/quota?provider=<p>&force=1`（webServer.register `{name, kind:'exact', path, handler}`）；`cache-control: no-store` 防浏览器启发式缓存。
- **凭据**：全走 `ctx.credentials.resolve(ref)`；**按 DSH 的 `<UPPER_ROUTE>_API_KEY` 命名规范列出候选 ref 数组**（musage 宿主注释指出推导规则在 dsh-client-ui-settings-models/lib/client.js:476：如 `minimax-cn`→`MINIMAX_CN_API_KEY`、`zai-coding-cn`→`ZAI_CODING_CN_API_KEY`）。每个 provider `refs: [...]` 按优先级逐个试，命中后 sticky（activeRef 缓存）。**零用户配置**：DSH 模型设置里配过 key 即自动可用。
- **客户端半**：`inject: ['slots','timer','modelDirectories']`；`slots.inject('conversation.input.right', function*(){...})` 在 composer 工具栏注册一行 readout；**跟随模型**：`ctx.modelDirectories.directoryFor(sessionId)` → `directory.store.subscribe(snap => snap.current.provider)` → DSH route id 映射表（`deepseek-official→deepseek`、`modelstudio→dashscope`…）→ provider 变化触发重 fetch（切换时 `force=1` 现场真拉）。**教训**：服务名是 `modelDirectories` 不是 `models`（写错 → ctx.get undefined → 整个组件 return 什么都不显示）。

### B. 渠道端点实现
provider 注册表（对象即契约）：`{refs[], urls{ref:endpoint}, parse(body)->{ok,...|kind,message}, authHeaders(key)->string[]（缺省 Bearer）, method?, body?, fallbackUrl?}`。
| provider | 端点 | 特殊点 |
|---|---|---|
| minimax | `api.minimaxi.com/v1/api/openplatform/coding_plan/remains`（CN） / `api.minimax.io/...`（EN，**按 ref 选端点**） | 2026-06-01 双 schema：percent 型（`remaining_percent`+`status===1`）与 count 型（total−remaining）；优先 `model_name==="general"` 行 |
| deepseek | `api.deepseek.com/user/balance` | balance_infos[0] |
| kimi | `api.kimi.com/coding/v1/usages` | 5h=`limits[0].detail`、周=顶层 `usage`；ref 候选 `KIMI_CODING_API_KEY`→`KIMI_API_KEY` |
| openrouter | `openrouter.ai/api/v1/credits` | total_credits−total_usage |
| zhipu | `open.bigmodel.cn/api/monitor/usage/quota/limit` | **Authorization 不加 Bearer 前缀**（raw key）；unit=3→5h、unit=6→周；`percentage` 服务器算好直接用；注意读数陷阱：字段叫 `usage` 实为 limit 语义 |
| dashscope（百炼 Coding Plan） | **控制台 API**：`POST bailian.console.aliyun.com/data/api.json?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2`，国内失败（`code==="ConsoleNeedLogin"`）回退 `modelstudio.console.alibabacloud.com` 同路径 | **三 header 同发**（`Authorization: Bearer` + `x-api-key` + `X-DashScope-APIKey`——控制台 API 接受方式随宿主而异，同发已被第三方实现验证）；**专用 key `sk-sp-` 开头**与按量 `sk-` 不互通；响应 `data.codingPlanInstanceInfos[0].codingPlanQuotaInfo.{per5Hour/perWeek/perBillMonth}{UsedQuota,TotalQuota,QuotaNextRefreshTime}`（unix 秒）；额度按调用次数计（Pro：5h 6000/周 45000/月 90000） |
- **02 对照**：百炼控制台端点（非 DashScope 开放 API！）+ ConsoleNeedLogin 双宿主回退 + sk-sp- 专用 key + zhipu 裸 Authorization + minimax 按 ref 选双站端点——五项均为高价值增量。

### C. 工程面
- **传输：curl via subprocess**——DSH 无 fetch provider 且 `web.fetch` 协议只支持 GET+url 不能加 Authorization header → `subprocess.resolveExecutable('curl')` + spawn。**安全细节**：auth header 全部走 stdin 的 `curl -K -` 配置（`header = "Authorization: ..."`），**绝不进 argv**（argv 里的 -H 会把 key 暴露给本机任意用户的 `ps`）；`-w "\n%{http_code}"` 尾行回传状态码；stdout 8MB 上限；15s 超时。
- **缓存**：per-provider 30s TTL；**失败也缓存并指数退避**（5s×2^n，上限 30min）——失败结果同样占住缓存位防打爆；`force=1` 连退避缓存一起清。
- **轮询（懒预热）**：5min 后台轮询**只覆盖 client 请求过的 provider**（requested 白名单，v0.1.4 语义「没人看的套餐不盲拉」）；首次由 client 切套餐时 force 现拉。
- **信任检查**：直连 host 即放行（localhost/.localhost/::1/IPv6 字面量/IPv4 字面量）——**IP 字面量不可能被 DNS rebinding 劫持**，域名 Host 才是 rebinding 攻击面；因此 LAN 直连（绑 0.0.0.0 从局域网访问）也能用而 rebinder 进不来。+ sec-fetch-site + origin 同源。
- **失败静默**：每 provider 失败只显示 `Provider ⚠`（hover 看错误），错误分类闭集 `parse/server_error/schema_unknown/auth_failed/rate_limited/network/unconfigured/console_need_login/other`。
- **UI**：composer 内一行（`¥X.XX` / `5h X% | 7d Y%` / `5h|Wk|Mo` 三窗口），currency 字段自动选 ¥/$ 符号；零侵入不挡输入。
- **依赖服务**：`subprocess` + `credentials` + `timer`（DSH 自带）。

### D. 对 mroute 的特殊价值
「跟随当前会话模型」的完整实现样板（client 订阅 modelDirectories + host 按 route-id 命名规范解析凭据）；curl-subprocess 传输层是 DSH 环境的兜底方案（当 fetch/WebFetchProvider 不可用或需自定义 header 时）。

---

## Pkg 2 · wingsky-1/dsh-provider-usage（D 专项：v2 适配器契约，mroute 适配器层头号参考）

### A. 宿主接缝
- **注册面**：cordis `name/inject/apply/ROUTES/HotReloadableAdapter` 导出；peer pins `@deepseek-ai/dsh-host-webserver`、`dsh-llm`、`dsh-settings`、`dsh-session`、`dsh-client-ui-slots` 等（全 optional，缺席降级）。dsh.catalog 声明 `capabilities: ["connection"]`。
- **路由**：`/api/dsh-provider-usage/{stats,history,trend,health,adapters.json,adapters/select,adapters/inspect,adapters/add}`——stats/history 返回**宿主端渲染好的 HTML**（capsuleHtml/panelHtml），客户端只做注入。
- **凭据**：apiKey 五级解析链（registry/provider-config.js，纯函数分层）：
  0. **DSH 凭据 seam**：`ctx.llm.listConfigurableProviders()` 找 provider 条目（provider/settingsNs/settingsPath 三键窄投影）→ 沿 settingsPath 下钻（覆盖 pi-ai 等嵌套命名空间）→ `profile.apiKeyEnv` → `credentials.resolve(ref)`；
  1. 显式插件配置 `apiKey`（落盘 0600 保护，不进设置回显）；
  2. 环境变量 `{PROVIDER}_API_KEY`（大写、连字符→下划线）；
  3. 旧环境变量（opencode-go 兼容）；
  4. `~/.dsh/.credentials.yaml` 的 `{PROVIDER}_API_KEY`；
  5. `auth.json`（仅 opencode-go）。
  服务缺席时回落后续链（不引入硬依赖），seam 漂移逐面写诊断（service ∈ settings|credentials）。

### B/D. v2 适配器契约（完整接口形状——mroute 适配器层头号参考）
一个用户 mjs 适配器**默认导出该形状，同时支持具名导出**（`export const version/name/label/providers` + `export function fetchData/formatCapsule/formatPanel`）：

```ts
// lib/shared/contracts.d.ts（v2，ADAPTER_CONTRACT_VERSION = 2；v1 已随 #932 删除）
interface UsageStatsAdapter {
  version: number;          // 必须 === 2
  name: string;             // 唯一名，白名单 ^[A-Za-z0-9_-]{2,64}$（用于日志/历史目录名；safeSegment 防目录穿越）
  label?: string;           // 展示名（缺省取 name）
  providers: string[];      // 认领的 provider 列表（与会话模型 provider 精确匹配）
  fetchData(ctx: FetchContext): Promise<Record<string, unknown>>;  // 宿主端执行
  formatCapsule(input: CapsuleInput): string;                      // 宿主端渲染 HTML
  formatPanel(input: PanelInput): string;                          // 宿主端渲染 HTML
}
interface FetchContext {
  apiEndpoint: string;      // 插件配置或模型配置链
  staticPath: string;       // 用户定义的 API 路径（与 apiEndpoint 拼接）
  apiKey?: string;          // 上面五级链解析
  provider: string;
  model?: string;
  sessionId?: string;
  timeoutMs: number;        // 固定 5000ms（宿主注入，不可配置 #208）
  signal?: AbortSignal;     // 超时/卸载取消
  utils?: AdapterUtils;     // 宿主注入共享工具（迷你图 SVG/转义/日界），mjs 鸭子类型可选，缺失回退文件内私有副本
}
interface CapsuleInput {
  time: number;
  data: Record<string, unknown>;          // fetchData 原样返回
  status: 'fresh' | 'cached' | 'stale';   // stale 时带 error
  error?: string;
  esc: (s: unknown) => string;            // 转义义务（& < > " '）
}
interface PanelInput {
  entries: Array<{ time: number; data: Record<string, unknown> }>;  // 历史条目（JSONL 分片读回）
  range: { start: number; end: number };   // 面板判定不取墙钟、用 range.end（防 flake）
  truncated: boolean;                      // 服务端截断标记
  esc: (s: unknown) => string;
  utils?: AdapterUtils;
}
```
- **错误码闭集**：`no-provider / no-adapter / no-enabled-adapter / no-api-key / unauthorized / timeout / network / bad-data / bad-json / adapter-load-failed / adapter-crash / adapter-timeout` + 模板 `` `http-${number}` ``。适配器 throw 的 Error.message 直接作为稳定码消费（六态错误路径；**AbortError 必须重抛**不得吞成 network）。
- **校验器**：`isUsageStatsAdapter` 结构守卫 + `describeUsageStatsAdapterShape` 形状问题明细（一次列全）；内置装配 fail-fast（registerBuiltinAdapters）；内置适配器 name 加 `-builtin` 后缀避免与用户已装原型在 registeredNames 冲突。
- **内置三适配器**：`deepseek-official-builtin`（余额+峰谷徽标+区间记账日用量）、`opencode-go-builtin`（/v1/usage 三窗口）、`zai-coding-cn`（智谱 Coding Plan）。
- **DeepSeek 官方适配器的领域深度（值得抄思路）**：
  - `topped_up_balance` 是「充值账户当前剩余」**非累计计数器** → 旧守恒式 `usage=Δbal+Δtop+Δgranted` 恒 0（完美相消）→ **v2.3 区间记账法**：相邻采样区间分类（unavailable/gap(>27h)/disturbed(充值或赠款变动)/clean），clean 区间消耗=余额降幅可与账单对账，disturbed 提取充值事件不混算；
  - 峰谷倒计时：DeepSeek 官方错峰定价 UTC 工作日峰窗 `[[01:00,04:00],[06:00,10:00]]` + 中国法定节假日表（随码发布，每年 Q4 追加）+ 周末全天谷；UTC 日期查表与北京日期查表等价的证明条件（峰窗整体落在 00:00–16:00 UTC 内）都写进注释；
  - 官方域名剥 `/v1` 前缀（OpenAI 兼容 base 与余额端点不同根）；严格金额解析（非有限 → null 杜绝 NaN 落盘）；仅保留 CNY 币种。

### C. 工程面
- **调度**：客户端 60s 轮询 /stats（取数前**复检当前 provider** #71 自愈——切完模型最长一个周期收敛）；宿主 5min 后台预热保历史连续；getStats Mutex 互斥 + 60s 缓存（#198 由 60s 下调 30s：峰谷徽标端到端翻转延迟 ≤95s=宿主 30s+客户端 60s+余量）；fetch 超时固定 5s。
- **历史**：按天分片 JSONL 落盘（0600）、maxAgeDays=30/maxSizeMB=20 自动清理、超龄超量从最旧日文件删；trend 聚合按天压实（目录维度取 `SessionHeader.cwd` basename、未识别桶 `(unidentified)` 不静默丢弃、**总量守恒**=目录桶+每日残差投影；时段维度 day×hour 行「落盘即定型」绝不重算、覆盖度守卫降级）。
- **渲染缓存**：panelHtml 进程内缓存，key=(provider, 启用适配器, 自然日归一化窗口)；主失效=落盘成功全清，select/add/热更新三挂点同步全清；兜底 TTL 90s；错误响应不入缓存。
- **热更新**：autoReload 默认开，mtime+size 轮询，**新版校验通过才原子切换**。
- **用户适配器管理**：设置页 inspect（回显导出不注册）/add（路径校验：存在可读+禁穿越 `..`/`./`，相对路径须在 DSH_HOME 或插件 home 内）/select（provider→适配器映射持久化 `adapter-state.json`：独占临时文件+fsync+原子 rename+目录 fsync；坏 JSON no-clobber 隔离为 `.bak-<ts>` 留证、轮转 5 份、**不自动回灌** fail-closed）。
- **XSS 双防**：esc() 转义义务（契约入参）+ 结构化净化兜底（渲染输出双层）。
- **provider 跟随**：会话内切模型经宿主 modelSelection 投影帧（control frame type:projection）实时推送。
- **报告子系统**（超出余额范畴但有借鉴价值）：daily/weekly/monthly 三周期 LLM 报告，reasoningEffort 以 opaque ID 显式校验 fail-closed、有界重试（1/2/4/8/16 分钟退避，仅 transient 进预算）、retry ledger 墓碑机制（终态 key 不自动重开、force 才清墓碑）。

---

## 汇总 · mroute 适配器契约设计建议

### 综合判断
六个包提供了三种成熟度递进的契约范式：
1. **Pkg 5（balance-monitor）渠道对象**——最简：`{id,label,credentialRef,environmentRefs,credentialEndpoint,fetch}`，纯数据获取、渲染归宿主；
2. **Pkg 1（quota-panel）format 适配器 + 数据驱动目录**——中量：目录条目（id/refs/secretRefs/endpoint/format/currency/tiers）+ format 函数把上游 JSON 归一化为 `{kind:'balance'|'usage'|'info'}` 视图模型，**上游原始 JSON 不出宿主**；
3. **Pkg 2（provider-usage）v2 契约**——完整：声明（version/name/label/providers）+ 三函数（fetchData/formatCapsule/formatPanel）+ 注入面（ctx.apiKey/apiEndpoint/timeout/signal/utils + esc）+ 错误码闭集 + 结构校验器 + 注册表/热更新/持久化全套管理面。

**mroute 推荐形状**：以 Pkg 2 契约为骨架（版本号/唯一名/认领 provider/错误码闭集/esc+utils 注入面照搬），合并 Pkg 5 的凭据解析三优先级与 Pkg 1 的目录驱动 + 双凭据引用（AK/SK）+ 视图模型分层。mroute 的特殊性在于它**不做渲染**（输出是模型选择的机读参考而非 UI HTML），所以 formatCapsule/formatPanel 两函数应替换为一个 `describe()` 归一化函数，输出结构化 JSON 而非 HTML——这是与 Pkg 2 的关键分叉。

### 推荐适配器接口（TS 伪代码）

```ts
// ============ mroute adapter contract v1（草案） ============
export const ADAPTER_CONTRACT_VERSION = 1;

/** 稳定错误码闭集（参照 provider-usage ERROR_CODES，加财务特有项） */
type AdapterErrorCode =
  | 'no-api-key' | 'unauthorized' | 'timeout' | 'network'
  | 'bad-json' | 'bad-data' | 'not-subscribed'      // 方舟未订阅套餐类
  | 'html-response'                                  // 旧 one-api 200+HTML
  | 'endpoint-forbidden'                             // 端点白名单拒绝
  | `http-${number}`;

/** 单渠道凭据引用（支持双凭据：方舟 AK/SK、阿里 AK/SK 场景） */
interface CredentialSpec {
  refs: string[];              // 候选 credentials ref（按 DSH <UPPER>_API_KEY 规范），按优先级
  secretRefs?: string[];       // 第二凭据（SK），与 refs 同时可解析才激活
  envRefs?: string[];          // 环境变量兜底名
}

/** fetchData 上下文（宿主注入） */
interface FetchContext {
  apiKey: string;              // 五级链已解析：credentials seam(→apiKeyEnv) > env > 显式配置
  secretKey?: string;          // secretRef 解析结果（AK/SK 双凭据渠道）
  apiEndpoint: string;         // 可被 endpoint 白名单校验（如 ^https?://[\w.-]*aliyuncs\.com$）
  provider: string;            // 认领的 DSH route id
  signal?: AbortSignal;        // 超时/卸载（统一 15s，AbortError 必须重抛）
}

/** 归一化结果：机读视图（不做 HTML 渲染） */
interface QuotaView {
  kind: 'balance' | 'usage' | 'subscription' | 'unavailable';
  currency: string | null;            // ISO 代码；usage 型可为 null
  balance: number | null;             // 还剩多少（主数值）
  total?: number | null;              // 额度上限（new-api total − cents/100 陷阱）
  used?: number | null;
  windows?: Array<{                   // 套餐窗口（5h/周/月）
    lane: 'five_hour' | 'weekly' | 'monthly' | 'session';
    usedPercent: number | null;       // 缺失绝不伪造 0%
    resetsAt?: string | null;         // ISO
  }>;
  vouchers?: Array<{ balance: string; expiryTime: string | null; nominal: string }>;  // 阿里券
  raw?: Record<string, never>;        // 禁止：上游 JSON 不出宿主（quota-panel 纪律）
  meta?: { planType?: string; accountIdMasked?: string; isAvailable?: boolean };
}

interface BalanceAdapter {
  version: number;                    // === 1
  name: string;                       // ^[a-z0-9-]{2,64}$，唯一
  label: string;
  providers: string[];                // 认领的 DSH provider route id（精确匹配）
  credentials: CredentialSpec;
  endpoint: string | ((ref: string) => string);   // 静态或按 ref 选（minimax 双站模式）
  endpointAllowPattern?: RegExp;      // 端点白名单（aliyun-balance 的 *.aliyuncs.com 模式）
  auth: 'bearer' | 'raw-header' | 'ak-sk-signed' | 'oauth-token' | 'multi-header';
  //   raw-header=智谱裸 key；ak-sk-signed=方舟 SigV4 变体/阿里 ACS3/RPC-V1；
  //   oauth-token=ChatGPT wham/usage；multi-header=百炼控制台三 header 同发
  authHeaders?: (key: string, secret?: string) => Record<string, string>;
  fallbackEndpoint?: string;          // 百炼国内→国际回退模式
  /** 必填：拉取并归一化（宿主端执行） */
  fetchQuota(ctx: FetchContext): Promise<QuotaView>;
  /** 可选：多动作渠道（方舟 Agent/Coding 两行、阿里 余额+券 两分区）返回多视图 */
  fetchAll?(ctx: FetchContext): Promise<Array<{ id: string; view: QuotaView | { error: AdapterErrorCode | string } }>>;
}
```

### 宿主侧配套（从源码提炼的运行时纪律）
1. **凭据解析链**（Pkg 2 五级 + Pkg 5 三源合并）：`credentials seam（llm.listConfigurableProviders→settingsPath 下钻→apiKeyEnv→resolve）` > `env {PROVIDER}_API_KEY` > `插件显式配置（0600，不回显）`；浏览器永不接触密钥与上游原始 JSON。
2. **调度**：默认 TTL 缓存 30–60s + 单飞（inFlight 去重）+ 失败指数退避（5s×2^n 封顶 30min，失败结果也占缓存位）；懒预热（只轮询被消费的渠道）；turn/end 事件定向刷新（Pkg 5 模式）+ 60s 活跃会话兜底轮询。
3. **传输**：Node http(s) `agent:false`（Windows undici 崩溃教训）或直接 fetch+`AbortSignal.timeout(15s)`；**禁用 curl-subprocess 为主路径**（mroute 是 host 侧插件、可用原生 fetch；Pkg 6 的 curl 方案仅作无 fetch 环境兜底笔记）。每请求 1–8MB body 上限。
4. **响应分类**：先判 HTML 再 JSON.parse（200+HTML 陷阱）；业务错误 200+`ResponseMetadata.Error`（火山）；`ok` 语义分离「凭据可用」与「取数成功」（Pkg 3）。
5. **状态**：revision 单调递增快照（Pkg 5，拒绝迟到旧快照）；per-channel 状态机 idle/loading/ready/unconfigured/error + stale 保留旧值。
6. **HTTP 面**：loopback + same-origin 围栏（Pkg 4 三重围栏最严）；写凭据路由加 content-type:application/json 强制（Pkg 3 双闸门）；`cache-control: no-store`。
7. **安全**：密钥掩码（≤12 前2+***，长则前6+...+后4）+ redactSecrets 边界统一替换（≥6 字符防误伤）；测试连接 test-before-save 绝不先落盘（Pkg 3）。
8. **幂等激活**：disposers 闭包活数组 + inject fiber 一并释放（Pkg 3 的 duplicate route 教训）；schemastery 裸导入失败时按 profile hoisted 路径兜底（Pkg 4 三级解析）。

### 端点速查（六包并集，可直接回写 02）
| 渠道 | 端点 | 认证 | 解析字段 | 来源包 |
|---|---|---|---|---|
| DeepSeek | GET api.deepseek.com/user/balance | Bearer | balance_infos[]{currency,total_balance,topped_up_balance,granted_balance}+is_available | 1/5/6/2 |
| Kimi CN | GET api.moonshot.cn/v1/users/me/balance | Bearer | {status,code,data:{available_balance,cash_balance,voucher_balance}} | 5 |
| Kimi Coding | GET api.kimi.com/coding/v1/usages | Bearer | 5h=limits[duration=300].detail、周=usage；used=limit−remaining | 1/6 |
| 智谱按量 | GET open.bigmodel.cn/api/biz/account/query-customer-account-report | Bearer | data:{availableBalance,rechargeAmount,giveAmount,todaySpendAmount,totalSpendAmount} | 5 |
| 智谱/GLM Coding | GET open.bigmodel.cn/api/monitor/usage/quota/limit | **裸 key 无 Bearer** | data.limits[]: TOKENS_LIMIT unit=3→5h/unit=6→周、TIME_LIMIT→MCP 月度、percentage 权威 | 1/6 |
| Z.AI | GET api.z.ai/api/monitor/usage/quota/limit | Bearer | 同上 | 1 |
| OpenRouter | GET openrouter.ai/api/v1/credits | Bearer | data:{total_credits,total_usage} 余额=差 | 1/6 |
| SiliconFlow | GET api.siliconflow.{com,cn}/v1/user/info | Bearer | data:{balance,chargeBalance,totalUsage} | 1 |
| MiniMax Coding | GET api.minimaxi.com (CN)/api.minimax.io (EN)/v1/api/openplatform/coding_plan/remains | Bearer | model_remains[]（general 行优先；剩余侧计数；双 schema） | 1/6 |
| StepFun | GET api.stepfun.com/v1/accounts | Bearer | {balance,total_cash_balance,total_voucher_balance} | 1 |
| xAI | GET api.x.ai/v1/billing/credits | Bearer | {total:{val}}（分→元） | 1 |
| OpenCode Go | GET opencode.ai/zen/go/v1/usage | Bearer | usage:{rolling,weekly,monthly:{percent,resetsAt}} | 1 |
| 阿里 BSS 余额 | RPC GET business.aliyuncs.com QueryAccountBalance（ACS3-HMAC-SHA256 或 RPC-V1 HMAC-SHA1 双实现） | AK/SK 签名 | Data:{AvailableAmount,AvailableCashAmount,CreditAmount,MybankCreditAmount,QuotaLimit,Currency} | 3/4 |
| 阿里 BSS 券 | 同上 QueryCashCoupons | AK/SK | CashCoupon[]{CashCouponId,No,NominalValue,Balance,Status(Available/availabletouse),ExpiryTime...}；无券号过滤参数 | 3/4 |
| 百炼 Coding Plan | POST bailian.console.aliyun.com (CN)/modelstudio.console.alibabacloud.com (INTL)/data/api.json?action=...queryCodingPlanInstanceInfoV2 | 三 header 同发（Bearer+x-api-key+X-DashScope-ApiKey），sk-sp- 专用 key | codingPlanQuotaInfo.{per5Hour,perWeek,perBillMonth}{Used,Total}Quota+NextRefreshTime | 6 |
| 火山方舟 Agent | POST open.volcengineapi.com/?Action=GetAFPUsage&Region&Version=2024-01-01 | AK/SK SigV4 变体（固定头序/裸算法串//request scope） | Result.{AFPFiveHour,AFPWeekly,AFPMonthly}；错误=200+ResponseMetadata.Error | 1 |
| 火山方舟 Coding | 同上 Action=GetCodingPlanUsage | 同上 | Result.QuotaUsage[].Level∈{session,weekly,monthly} | 1 |
| ChatGPT 订阅 | GET chatgpt.com/backend-api/wham/usage | OAuth Bearer+ChatGPT-Account-Id（~/.codex/auth.json 或设备码登录） | rate_limit.{primary,secondary}_window{used_percent,reset_at,limit_window_seconds}（18000s/604800s 判窗） | 1 |
| new-api/one-api | GET {base}/dashboard/billing/subscription + /usage（musage/qwen：无 /v1；quota-panel：带 /v1） | Bearer | hard_limit_usd + total_usage（**美分，/100**） | 1/4 |
| TeamoRouter | GET {base}/v1/billing/balance、/v1/billing/costs、/v1/usage（Unix 秒区间） | Bearer | balance:{value,currency}、total_amount:{value,requests}、usage:{total_tokens,input,output,cached_read} | 5 |

---

## 复用分级表

| 包 | 分级 | 复用方式 | LICENSE | 说明 |
|---|---|---|---|---|
| Pkg 3 aliyun-balance | **直接复用**（独立装）+ 改造借鉴 | ACS3 签名模块（lib/bss-client.js 纯函数）、test-before-save 模式、幂等激活模式、环形日志+节流 | MIT | 作为独立插件直接装即可给 mroute 补阿里券数据；bss-client.js 可整体抄入 mroute（保留黄金哈希测试） |
| Pkg 4 qwen-balance | **改造借鉴** | RPC-V1 HMAC-SHA1 签名（有官方黄金向量）、redactSecrets/maskKey、loopback 三重围栏、HTML-先判分类、gateway 降级链（newapi→user-balance）、schemastery 三级解析 | MIT | percentEncode Java 对齐细节必须逐字抄（注释明令不许改）；中文转数字观感差——抄逻辑不抄文案 |
| Pkg 5 balance-monitor | **改造借鉴（头号渠道层样板）** | 渠道对象六字段形状、凭据三优先级（env>model>user）、channel-routing hostname 匹配 + 内置 provider-id 映射、revision 快照+SSE、turn/end 定向刷新 | MIT | channels/*.js 四个文件可近乎原样移植（改渲染层）；service.js 状态机直接平移 |
| Pkg 1 quota-panel | **改造借鉴（覆盖面最广）** | format 适配器表（14 种解析逻辑）、目录驱动 + 双凭据（AK/SK）、方舟 SigV4 变体签名、ChatGPT 设备码+auth.json 全链路、归一化视图模型纪律 | MIT | 适配器解析函数逐个移植；代理引擎按需（mroute 若需代理）；宿主线 pin 策略不抄 |
| Pkg 2 provider-usage | **改造借鉴（契约骨架）** | v2 契约形状（version/name/providers/三函数）、FetchContext 注入面、错误码闭集、结构校验器、apiKey 五级链、JSONL 历史/渲染缓存/热更新管理面 | MIT | 契约照搬后把 formatCapsule/formatPanel 替换为 describe()→JSON；adapter-state.json 隔离/墓碑纪律抄 |
| Pkg 6 musage | **仅参考** | 跟随模型的 client 订阅（modelDirectories→store.subscribe→current.provider）、curl-subprocess 传输（兜底方案笔记）、懒预热轮询、失败退避缓存、百炼控制台端点与三 header 方案、zhipu 裸 Authorization | MIT | 生产代码不建议抄 curl 路径（mroute host 侧有原生 fetch）；client 订阅模式与百炼端点细节值得抄 |

**许可证结论**：六包全部 MIT，允许复制/修改/商用/再分发，仅需保留版权与许可声明。mroute 汇总实现时在文件头或 NOTICE 注明各来源模块出处即可。

---

## 附：给 mroute 的三条最高优先结论

1. **契约骨架抄 Pkg 2、渠道形状抄 Pkg 5、目录与特殊签名抄 Pkg 1**——三者拼起来就是 mroute 渠道层的完整形态；渲染函数替换为结构化 `describe()` 是唯一需要自己设计的分叉点。
2. **四个签名实现都有测试锚**：阿里 ACS3（黄金哈希）、阿里 RPC-V1（官方向量 OLeaidS1JvxuMvnyHOwuJ+uX5qY=）、火山 SigV4 变体（三处与 AWS 的差异注释）、ChatGPT OAuth（client_id 与窗口判别逻辑）——移植时连同测试一起搬，禁止凭记忆重写。
3. **服务器端纪律清单**（六包共同教训的并集）：密钥不出宿主/不上 argv/不回显/不落日志（掩码+redact 双保险）；上游 JSON 不进浏览器；HTML 先判再 parse；错误分区分隔绝不互相拖垮；`ok` 语义与 stale 语义分离；AbortError 重抛；agent:false 防 Windows undici 崩溃；幂等激活防重复路由。
