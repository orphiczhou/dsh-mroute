# 调研报告：dsh-quota 小米（Xiaomi MiMo）余额适配器

> 任务书：`docs/briefs/brief-quota-xiaomi-adapter.md` §4 四问逐条回答。执行：agent-1（subagent），2026-11-13。
> 所有结论带证据：vendors 源码=文件路径+行号；官方文档=URL；本机环境=任务书 §2（lead 亲测）。

## 结论速览

- **端点**：`GET https://api.xiaomimimo.com/v1/platform/balance`（Bearer API key）为主；套餐 `GET https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan`（tp- key）；日用量 `GET https://api.xiaomimimo.com/v1/platform/usage/daily?start_date=…&end_date=…`（sk- key）。
- **可行路线**：本机只有 `XIAOMI_API_KEY`（API key）→ **API key 直查可行，为主路线**（官方文档明文支持），无需探活降级、无需 Cookie。
- **改造面**：`src/platform-map.ts` 一处映射 + `src/direct.ts` 两个解析器与两条目录项 + 测试；`src/client/platform-map.ts` 在当前上游已是 re-export（单源同步），构建后验证两侧 lib 均含规则。
- **构建**：`tsdown` + `node scripts/check-client-id.mjs`（改名后 CLIENT_ID 必须与 package name 一致）；`link-harness.sh` 仅 dev 对齐用，构建不依赖，跳过。

---

## 问题 1：小米 MiMo 余额/套餐查询端点是什么？

### 1.1 参考 A（bricika/dsh-quota-dashboard@0.2.5，MIT，lib 编译产物）

三个 fetcher 全部 Bearer 认证（`vendors/bricika--dsh-quota-dashboard/lib/host.js`）：

| 端点 | 认证 | 证据行号 |
|---|---|---|
| `GET https://api.xiaomimimo.com/v1/platform/balance` | `authorization: Bearer ${key}` | host.js L846-852 |
| `GET https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan` | 同上 | host.js L854-860 |
| `GET https://api.xiaomimimo.com/v1/platform/usage/daily?start_date=<UTC日>&end_date=<UTC日>` | 同上，日期 `toISOString().slice(0,10)`（UTC 自然日，跨度 clamp 1..31） | host.js L862-876 |

凭证引用解析顺序（host.js L898-900）：
- `MIMO_REFS = ["XIAOMI_API_KEY", "MIMO_API_KEY"]`（余额+日用量）
- `MIMO_TP_REFS = ["XIAOMI_TOKEN_PLAN_API_KEY", "MIMO_TOKEN_PLAN_API_KEY", "MIMO_TP_API_KEY"]`（Token Plan）

响应结构（`vendors/bricika--dsh-quota-dashboard/lib/data.js`）：

- **余额** `shapeMimoBalance`（data.js L922-938）：
  - `balance_infos`（array，取 `[0]`，缺失即抛错）
  - `is_available`（boolean）
  - `balance_infos[0]` 字段：`currency` / `cash_balance`（现金）/ `gift_balance`（赠金）/ `frozen_balance`（冻结）/ `credit_limit` / `credit_available` / `total_available`（总可用）——**金额全部是字符串**
- **套餐** `shapeMimoPlan`（data.js L940-960）：
  - `quota.total_credits` / `quota.used_credits` / `quota.remaining_credits`（缺 remaining 用 max(0, total-used) 兜底）
  - `plan_code`、`period.start_at` / `period.end_at`、`auto_renew`
- **日用量** `shapeMimoUsage`（data.js L962-1000）：
  - `data[]` 行字段：`date` / `currency` / `consumed_amount` / `total_tokens` / `request_count`

请求侧公共形态（host.js L426-451 `fetchJson`）：GET、`accept: application/json`、UA `dsh-quota-dashboard/<build>`、redirect: error、20s 超时、响应体 8MiB 上限；401 时错误文案点名 `XIAOMI_API_KEY`（host.js L464-466）。

### 1.2 参考 B（Yeoksin/dsh-usage-wallet，MIT，GitHub main，含完整源码）

控制台 Cookie 路线（`vendors/Yeoksin--dsh-usage-wallet/dsh-usage-wallet-main/lib/mimo.js`）：

- 端点根 `https://platform.xiaomimimo.com/api/v1`（mimo.js L23）：
  - `GET /balance` → `{ code: 0, data: { balance, currency, cashBalance, giftBalance } }`（mimo.js L8-9，解析 L119-140）
  - `GET /tokenPlan/detail` → `{ code: 0, data: { planCode, currentPeriodEnd, expired } }`（L10-11，解析 L176-187）
  - `GET /tokenPlan/usage` → `{ code: 0, data: { monthUsage: { percent, items[] } } }`（L12-13，解析 L148-170）
- 认证：浏览器登录态 Cookie，必需 `api-platform_serviceToken` + `userId`（L26）；302→登录页或 401/403 判 unauthorized（L218-238）；请求带 origin/referer/UA 仿浏览器（L204-217）
- API key 路线只做**探活**：`validateMiMoApiKey` 用 `GET <host>/v1/models` 验证 key 并列模型（L300-339）；`sk-`→按量网关 `api.xiaomimimo.com`，`tp-`/`ttp-`→依次试 cn/sgp/ams 三集群（L274-291）

### 1.3 官方文档（mimo.mi.com，权威正源）

- 余额：[查询余额（zh-CN）](https://mimo.mi.com/docs/zh-CN/api/asset/balance-get)——`GET https://api.xiaomimimo.com/v1/platform/balance`；「接口支持以下两种认证方式…（本接口需使用普通 API Key `sk-`）」；请求头 `api-key: $MIMO_API_KEY` **或** curl 示例 `Authorization: Bearer $MIMO_API_KEY`；响应 `object:"balance"`、`is_available`（total_available − frozen_balance > 0 时 true）、`balance_infos[]`{currency, cash_balance, gift_balance, frozen_balance, credit_limit, credit_available, total_available}，字符串两位小数，total_available = 现金+赠金+可用授信（已加回冻结）。
- 套餐余量：[查询套餐余量（zh-CN）](https://mimo.mi.com/docs/zh-CN/api/asset/credits-get)——`GET https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan`；「本接口需使用 Token Plan 专属 API Key `tp-`」；响应 `object:"token_plan"`、`plan_code`、`period.start_at/end_at`（UTC `YYYY-MM-DD HH:mm:ss`）、`quota.total_credits/used_credits/remaining_credits`（integer，remaining = max(0, 总−已用)）、`auto_renew`、`claw_enabled`。
- 日用量：[查询日用量（zh-CN）](https://mimo.mi.com/docs/zh-CN/api/asset/consumption-get)——`GET https://api.xiaomimimo.com/v1/platform/usage/daily?start_date=…&end_date=…`；需 `sk-`；参数为 **UTC 自然日**（闭区间，跨度 ≤31 天，最早 2026-09-01，越界返回空列表不报错）；响应 `object:"list"`、`data[]`{date, resource_type(model|plugin), name, masked_api_key, currency, consumed_amount, …}。
- 上线时间：[平台更新日志 V2.2.0（2026-11-03）](https://mimo.mi.com/docs/zh-CN/updates/feature/platform)——「余额 & 套餐余量查询：支持实时查询现金、赠金、信控余额以及套餐剩余量」「日用量 & 日账单查询」为 **2026-11-03 新上线能力**。

**判定：参考 A 的三端点与官方文档逐字段一致，是同一条官方 API 路线；参考 B 是另一条（控制台 Cookie）路线，两条路线并存但互不冲突（详见一致性核对）。**

---

## 问题 2：本机只有 XIAOMI_API_KEY，哪条路线可行？

**主路线 = API key 直查余额（参考 A = 官方文档路线），无需降级探活。**

证据链：

1. 官方文档明确 `/v1/platform/balance` 接受 `Authorization: Bearer $MIMO_API_KEY`（[balance-get](https://mimo.mi.com/docs/zh-CN/api/asset/balance-get)），且本接口接受的是**普通 API Key（sk-）**——即按量计费 key。
2. 本机 `XIAOMI_API_KEY` 是 DSH `xiaomi` provider 的 `apiKeyEnv`（任务书 §2，lead 亲测）；mroute 注册表登记 `xiaomi → prepaid/bulk`（预付费按量），对应 `sk-` 按量 key 形态。前置风险：若该 key 实际是 `tp-` 前缀（Token Plan key），余额端点会 401——此时卡片显示认证失败错误卡（上游直连错误卡的标准行为），不炸面板；验收口径允许「探活路线出在线」备选，但按官方文档预期主路线直接可用。
3. dsh-quota 的自动发现（extending.md L13-21「L0 内置目录」）：适配器声明的 `keyRefs` 在 DSH 凭证域/环境变量能解析 → 平台卡自动出现。controller 用 `credentials.resolve(credentialRef(ref))` 逐引用解析（src/controller.ts L223-228），`XIAOMI_API_KEY` 已在凭证域（任务书 §2）→ **自动命中，无需用户任何配置**。
4. 参考 B 的 Cookie 路线需要的 `api-platform_serviceToken`/`userId` 本机没有（也无从抓取），**不采用**；它的价值在「一致性核对」里作为旧断言的证据。

**探活降级方案（仅作兜底记录，不实现为主行为）**：若 lead 实测 401（key 形态不符），可退参考 B 的 `validateMiMoApiKey` 路线——`GET https://api.xiaomimimo.com/v1/models`（Bearer）探活并展示模型列表（mimo.js L300-339），卡片显示「模型服务在线 · N 个模型」。本次不实现，理由：官方文档已坐实直查路线，先按主路线交付，lead 安装实测后如 401 再补（改造点已预留：xiaomi 条目换成自定义 fetch 即可，见问题 3 的 opendesign 自定义 fetch 样板 src/direct.ts L921-928）。

---

## 问题 3：dsh-quota 源码里加一个直连平台要动哪几处？

上游把平台分三层（docs/extending.md L3-9）：L0 内置目录（凭证解析即自动出现）、L1 自定义 HTTP 平台（用户配置）、L2 MCP（Cookie 会话）。我们走 **L0**——把 xiaomi 加进内置目录。以 SiliconFlow/StepFun 同类条目为样板（src/direct.ts L906/L910），改造面：

| # | 文件 | 动什么 | 样板/证据 |
|---|---|---|---|
| 1 | `src/platform-map.ts` | `platformForProvider`（L29-57）加规则：`p.includes('xiaomi-token-plan')||p.includes('mimo-token-plan') → 'xiaomi-token-plan'`（放前面，防被通用规则截胡）；`p.includes('xiaomi')||p.includes('mimo') → 'xiaomi'`。平台 id 与适配器 id 对齐，DSH provider `xiaomi` 的会话模型才能认领卡片并置顶 | 文件头注释 L4-8 记录了 ark 单侧漂移导致置顶失效的历史坑 |
| 2 | `src/client/platform-map.ts` | **当前上游已是单行 re-export**（L13 `export { …, platformForProvider } from '../platform-map.ts'`）——改第 1 处的共享源即自动同步两侧。任务书「两份必须同步」的实质=不许出现单侧漂移；上游已用 re-export+一致性单测（tests/platform-map.test.ts L18-32）把「两边一致」钉死。构建产物层面仍须验证 lib/index.js 与 lib/client.js 都含 xiaomi 规则（客户端 bundle 把该模块整个内联，platform-map.ts L10-11） | client/platform-map.ts L1-11 |
| 3 | `src/direct.ts` FORMATS | 注册两个解析器：`'xiaomi-balance'`（解析 `balance_infos[0]`，样式仿 `deepseekBalance` L270-288：总余额常驻、赠金/授信非零才拆明细）、`'xiaomi-token-plan'`（解析 `quota{}`，样式仿 MiniMax 的错误即抛 L343-348 + percent 计算） | FORMATS 注册表 L498-514 |
| 4 | `src/direct.ts` CATALOG_EXTRA | 加两条目录项（自动发现，无 key 不显示）：`entry({ id:'xiaomi', label:'小米 MiMo', keyRefs:['XIAOMI_API_KEY','MIMO_API_KEY'], endpoint:'https://api.xiaomimimo.com/v1/platform/balance', format:'xiaomi-balance' })` + `withExtraItems(..., xiaomiUsageRows)`（近 7 天日用量作附加行，样式仿智谱 zhipuAccountRows L604-608 与 withExtraItems L617-630）；`entry({ id:'xiaomi-token-plan', label:'小米 MiMo Token Plan', keyRefs:['XIAOMI_TOKEN_PLAN_API_KEY','MIMO_TOKEN_PLAN_API_KEY'], endpoint:'https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan', format:'xiaomi-token-plan', planOf: body→plan_code })`。entry() 自动派生 origins（L849-869）与 envKeys（L864） | CATALOG_EXTRA L902-953 |
| 5 | 类型定义 | **零改动**：`QuotaItem`（src/config.ts L38-58）、`ProviderSnapshot`（L111-124）、`CatalogEntry`（src/direct.ts L521-539）完全够用——label/planOf/note/buildUrl 均为现有字段 | — |
| 6 | 面板文案/locale | **零改动**：面板 chrome 双语表 src/client/locale.ts L15-253 不需要新键（xiaomi 无专属 UI）；Host 渲染的条目 label/上游错误信息按原样投递（locale.ts L8-9 明示「Host-rendered data stays as delivered」）。en 无中文门禁只查 locale chrome（tests/locale.test.ts L50-53），条目 label 中文与上游一致（智谱/Z.AI 同为中文 label） | — |
| 7 | tools.ts | **零改动**：`quota_refresh` 从 `state.providers` 派生输出（src/tools.ts L59-68），新目录项自动流入 | — |
| 8 | controller.ts | **零改动**：目录消费是全量的（src/controller.ts L450 adapters、L483 逐 ref 解析、L550 `CATALOG_EXTRA.filter(directVisible)`），凭证变更自动刷新走 `KNOWN_REFS = ALL_DIRECT_REFS`（src/index.ts L38，ALL_DIRECT_REFS 在 direct.ts L956 由目录派生） | — |
| 9 | 测试 | 新增 `tests/xiaomi.test.ts`（解析器夹具按官方文档字段造；目录项断言 keyRefs/endpoint/origins；usage 日期函数）；`tests/platform-map.test.ts` 的两半一致性 id 列表（L21-27）补 `'xiaomi'`、`'xiaomi-token-plan'`、`'mimo'` 并加断言 | direct.test.ts L89+ 的 zhipu 测试样式 |
| 10 | `package.json` / `tsdown.config.ts` | fork 改名 `dsh-quota` → `dsh-quota-xiaomi` 时：`tsdown.config.ts` L23 `PACKAGE_ID` 与 L32 `CLIENT_ID` 同步改名——build 门禁 scripts/check-client-id.mjs L34-42 要求 client bundle 自注册 id == package.json name（浏览器 loader 拒绝别的 id）；`cordis.patch.yml` 的 `name:` 同步改 | package.json L42-49 |

**不需要动的**：ark.ts（AK/SK 双字段样式只在 AK/SK 型凭证才需要，xiaomi 是单 key，用不上）、mcp.ts、http.ts、magpie.ts、insights.ts、history-file.ts 等。

---

## 问题 4：构建链路怎么跑通？

上游构建要求（package.json L42-49 + tsdown.config.ts + check-client-id.mjs）：

1. **依赖**：devDependencies = tsdown 0.22.2 / typescript 6.0.3 / react 18 / @types/* / unrun。源码运行时还 import `@deepseek-ai/schemastery`（src/config.ts L8）。这些 `@deepseek-ai/*` 包不在 npm 公网（宿主内置），构建期靠 `external: [/^@deepseek-ai\//]`（tsdown.config.ts L46）**不解析也能打包**；但 `tsc --noEmit` typecheck 与「import config.ts 的运行时测试」需要它能解析。
2. **link-harness 的定位**：scripts/link-harness.sh L1-17 自述是「dev 依赖与目标 dsh 对齐」的**开发步骤**（typecheck/build 解析与运行时相同代次的宿主包，防 API 漂移回归），**不是 build 链的依赖**——`pnpm build` = `tsdown && node scripts/check-client-id.mjs`，两者都不读 node_modules/@deepseek-ai。本机 DSH 装在 asar 里（非 npm 全局），link-harness 的 `npm root -g` 探测落空；且任务书 §6 禁改宿主 → **跳过 link-harness，构建不受影响**；typecheck 若因宿主包缺类型报错，按「仅 build+test 为验收门」处理（build 不做类型检查）。
3. **client-id 门禁**：tsdown 打出 `lib/client.js`（CJS，banner `window.__ModuleLoader__.load({ id: CLIENT_ID, factory: … })`，tsdown.config.ts L64-69）→ `check-client-id.mjs` 校验 id == package.json name → 改名 fork 必须三处一致（package.json name / tsdown PACKAGE_ID / CLIENT_ID）。
4. **测试**：`node --test --experimental-strip-types tests/*.test.ts`（package.json L46）——Node ≥22 原生跑 TS；本机 PATH node v24.20.0 满足。import `@deepseek-ai/schemastery` 的测试（dsh-config/state-store 系）需要 node_modules 里有它 → 按工作区先例（AGENTS.md §4 schemastery 依赖坑）在 package.json `dependencies` 显式声明 `"@deepseek-ai/schemastery": "3.19.0"` 并 `npm.cmd install` 自带（否则激活期 ERR_MODULE_NOT_FOUND，install_bundle 对 link: 目录不装依赖）。
5. **实际命令序列**（Windows，结果见 BUILD.md）：
   ```
   cd D:\Codes\DSH小插件\plugin-quota-xiaomi
   npm.cmd install                      # 装 devDeps + dependencies（含 schemastery）
   node --test --experimental-strip-types tests/*.test.ts
   npx tsdown                           # 或 pnpm build；产物 lib/
   node scripts/check-client-id.mjs     # client-id 门禁
   node --check lib/index.js 等         # 产物语法自检
   ```
6. **产物**：`lib/index.js`（Host ESM）+ `lib/client.js`（浏览器 CJS bundle）+ `.map`；安装入口 `cordis.patch.yml`（insert id `quota`，name 改为 fork 包名）。

---

## 一致性核对：两个参考实现的小米路线冲突吗？以谁为准？

**冲突表象**：参考 B 在 lib/mimo.js L4-6 与 L270-272 明确断言「MiMo 开放平台的余额**没有** API Key 接口……这些网关**没有任何账户/计费接口**（实测所有 /v1/usage、/v1/balance 之类路径都是 404），余额必须走控制台 Cookie」；参考 A 却用 Bearer key 直查 `/v1/platform/balance` 出余额。

**辨析（三层证据）**：

1. **测试路径不同**：参考 B 实测列举的路径是 `/v1/usage`、`/v1/balance`（mimo.js L270「之类路径」）；参考 A/官方用的路径是 **`/v1/platform/balance`**——`platform` 命名空间下的平台接口，不是推理网关的 `/v1/balance`。参考 B 的 grep 全文（本报告 §1.2）确认它从未请求过 `/v1/platform/*` 路径。两者很可能各自都对：推理端点下确实没有计费接口，但平台命名空间下有。
2. **时间线**：官方更新日志 [V2.2.0（2026-11-03）](https://mimo.mi.com/docs/zh-CN/updates/feature/platform)明载「余额 & 套餐余量查询」「日用量 & 日账单查询」是 **2026-11-03 上线**的新能力。参考 B 的断言写于该能力上线前（其 README/NOTICE 无任何 `/v1/platform` 痕迹），当时为真；参考 A（dashboard@0.2.5，README L72-74）实现的是上线后的新端点。
3. **官方文档正源**：[balance-get](https://mimo.mi.com/docs/zh-CN/api/asset/balance-get) / [credits-get](https://mimo.mi.com/docs/zh-CN/api/asset/credits-get) / [consumption-get](https://mimo.mi.com/docs/zh-CN/api/asset/consumption-get) 与参考 A 的端点、认证头、响应字段**逐字段一致**（含金额字符串两位小数、`is_available` 语义、UTC 自然日参数、`quota` 整数积分）。

**裁决**：**以参考 A + 官方文档为准**——API key 直查是当前官方支持的路线，且恰好匹配本机 `XIAOMI_API_KEY` 的持有形态。参考 B 的 Cookie 路线仍然有效（控制台侧信息更全：现金/赠金分离、Token Plan 月度百分比），但依赖浏览器登录态，本机不具备，仅作旧断言证据与未来增强参考。参考 B 独有的可复用资产是 `sk-/tp-/ttp-` 前缀判型与 `/v1/models` 探活（mimo.js L283-339），本次以「兜底记录」收录（见问题 2），不进主实现。

---

## 附：fork 落点设计（供 BUILD/NOTICE 衔接）

- 包名 `dsh-quota-xiaomi`（version `0.14.10-xiaomi.1`），基于 Minokun/dsh-quota **v0.14.10**（vendors 下载版 main，package.json L3；GitHub codeload zip 无 commit 号，以版本号锚定），MIT（上游 README L134-136）。
- 借鉴三分：参考 A=改造借鉴（端点/响应结构对照实现，代码自写，MIT 已记录）；参考 B=仅参考（key 判型/探活兜底思路 + 旧断言证据，MIT 已记录）。
- 附加依赖声明：`dependencies: { "@deepseek-ai/schemastery": "3.19.0" }`（工作区先例，AGENTS.md §4）。
- 安装注意（写给 lead）：fork 的 cordis.patch.yml insert id 保留 `quota`（与原版同 id，便于替换安装）；**与原版 dsh-quota@0.14.10 同时安装会在 bundle id/设置命名空间上撞车**，建议先禁用原版再装 fork。
