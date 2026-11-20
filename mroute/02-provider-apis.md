# 主流 LLM 渠道「余额 / 用量 / 套餐」机读 API 调研

> 任务树 `mroute` / leaf `mroute-W2-balanceapi` 交付物
> 调研日期：2026-11-13（web_search + web_fetch 逐渠道核对，出处见文末链接表）
> 目的：论证「DSH 插件通过 API 获取各渠道剩余 token/余额」的数据可得性，支撑派遣子会话前的模型选择（财务优先级：包月 > 限期算力券 > 预充值）。

**证据分级标注**：✅官方文档确认 ｜ 🔧第三方实测可用（官方未文档化） ｜ 📄文档/配额仅人工可见

---

## 一、对比总表（10 渠道）

| # | 渠道 | 余额/用量 API 端点 | 认证方式 | 返回关键字段 | 包月套餐剩余可机读 | 算力券/资源包可机读 | 速率/权限限制 | 结论 |
|---|------|-------------------|---------|-------------|------------------|-------------------|--------------|------|
| 1 | **DeepSeek 开放平台** | `GET https://api.deepseek.com/user/balance` ✅ | Bearer（普通模型 API Key） | `is_available`；`balance_infos[]{currency: CNY/USD, total_balance, granted_balance(未过期赠金), topped_up_balance(充值)}` | 无包月套餐（纯预充值+赠金） | 赠金只返回「未过期总额」，**无过期时间字段** | 普通 API Key 即可，未见专门限速文档 | **可机读**（金额级；无券有效期） |
| 2 | **智谱 BigModel（open.bigmodel.cn）** | 官方文档**无**余额/套餐 API 📄。第三方实测可用 🔧：① `GET https://open.bigmodel.cn/api/biz/account/query-customer-account-report`（现金账户）；② 资源包列表（biz gateway，含 `resourcePackageName / suitableModel / tokensMagnitude / status: EFFECTIVE\|EXPIRED`）；③ `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`（Coding Plan 配额 x/y） | ①裸 key 或 Bearer 均可（实测）；②③ 同站凭据 | ① `data{balance, rechargeAmount(充值), giveAmount(赠金), totalSpendAmount, frozenBalance, availableBalance}`；② 资源包名称/适用模型/token 数量/生效状态；③ 配额 已用/总额 | **部分可机读**：GLM Coding Plan 官方仅控制台「用量统计」页（5h 积分 + 周积分窗口）；未文档化 `quota/limit` 接口实测可用 | 资源包（限时算力券）：剩余量+生效状态可查 🔧，**过期时间字段未获证实** | 未文档化接口，随时可能变更/加签；Coding Plan 与预充值是**两个独立额度池**（coding 路由 `/api/coding/paas/v4` 与标准 API 分开计） | **部分可机读**（依赖未文档化接口，必须带降级预案） |
| 3 | **Moonshot / Kimi（原 platform.moonshot.cn）** | 国内：`GET https://api.moonshot.cn/v1/users/me/balance` ✅；国际：`GET https://api.moonshot.ai/v1/users/me/balance` ✅ | Bearer（MOONSHOT_API_KEY） | `data{available_balance(可用=现金+代金券), voucher_balance(代金券，不可为负), cash_balance(现金，可为负=欠费)}`（国内元 / 国际美元） | 无包月套餐（纯预充值+代金券） | 代金券余额可查；**过期时间 API 不返回**（仅文档提示"注意 voucher 有效期"） | 普通 API Key；注意 platform.moonshot.cn→platform.kimi.com、platform.moonshot.ai→platform.kimi.ai 已 301 迁移，**两站账户/Key 完全独立** | **可机读** |
| 4 | **阿里云百炼 DashScope** | 账户余额：BSSOpenAPI `QueryAccountBalance` ✅；资源包：BSSOpenAPI `QueryResourcePackageInstances` ✅（仅有效资源包，支持 `ProductCode / ExpiryTimeStart~End` 过滤）；Token Plan 包月订阅：bailian OpenAPI `ListSubscriptions` / `ListUsageRecords` / `ListSubscriptionSharedPackages`（`GET https://modelstudio.<region>.aliyuncs.com/tokenplan/subscription/...`）✅；CLI：`aliyun bailian ListSubscriptions`、`bl usage token-plan` | AccessKey + ACS3-HMAC-SHA256 签名（**Bearer 不支持**）；RAM 授权 `bss:DescribeAcccount` 等 | 余额金额；资源包实例含**有效期**；Token Plan 订阅档位 + 当月 Credits 消耗明细（剩余=额度−已用可自算） | **可机读**（订阅 + 用量记录两件套） | **可机读**（含有效期，全场最佳） | 需主账号/RAM 的 AccessKey（权限远大于模型 API Key，须最小权限 RAM 策略）；CLI/SDK 现成 | **可机读**（但凭证形态是 AK，不是模型 Key） |
| 5 | **火山引擎方舟 Ark** | 套餐（Agent Plan / Coding Plan）额度：官方 `arkcli usage plan` ✅（快照 `items[].periods[]{label: 5h/weekly/monthly/session, used, total, percent, reset_at}`；底层 Volcengine OpenAPI `ListSubscribeTrade` 等按 SKU 探测）；用量：`arkcli usage stats`（5–30 分钟延迟）；账单：`arkcli billing list`（T+1，按 EP/Key/产品拆分） | Volcengine AK/SK 签名（arkcli 与控制台 SSO 共用登录态）；套餐数据面 baseURL `.../api/plan/v4`（coding）/`/api/v3` | 套餐 quota 快照：各时间窗口 **已用/总额/占比/重置时间 reset_at**；Token 用量近实时；结算账单按月 | **可机读**（10 渠道中唯一官方给出套餐「剩余+重置时间」的；注意 reset_at 是窗口刷新不是订阅到期） | Token 资源包走火山计费中心拆账（billing 域），资源包实例经 BSS 类接口查 | AK/SK 凭证；usage 域与 billing 域口径不同（近实时 vs T+1）不可混用；官方开源 ark-cli + Agent Toolkit Skills | **可机读**（推荐直接调 arkcli 或复刻其 OpenAPI 调用） |
| 6 | **SiliconFlow 硅基流动** | `GET https://api.siliconflow.cn/v1/user/info`（国内）/ `https://api.siliconflow.com/v1/user/info`（国际）✅ | Bearer（API Token） | `data{balance, chargeBalance(充值), totalBalance(充值+赠金), status}` | 无包月套餐 | 赠金并入 `balance`，无过期时间、无分项明细 | 普通 API Token 即可 | **可机读** |
| 7 | **OpenRouter** | `GET https://openrouter.ai/api/v1/key` ✅（普通 inference Key 即可）；`GET https://openrouter.ai/api/v1/credits` ✅（需 Management Key） | Bearer | `/key`：`usage / usage_daily / usage_weekly / usage_monthly`、`limit / limit_remaining / limit_reset`、`budgets[]{limit_usd, remaining_usd, resets_at}`、`free_model_daily_requests{limit, remaining, used}`、`expires_at`；`/credits`：`total_credits / total_usage` | 无订阅套餐；但 key 级 `limit_remaining` + budget `remaining_usd/resets_at` 可当"类包月预算"机读 | 免费模型：`free_model_daily_requests`（每日剩余请求数）直接机读 | credits 端点需 Management Key（权限更高）；免费层有每日请求上限 | **可机读**（字段最全，白嫖额度也可读） |
| 8 | **OpenAI** | 用量/成本：`GET /v1/organization/usage/completions`、`GET /v1/organization/costs` ✅（官方 API reference，按天分桶）；余额：**无官方公开端点**——legacy `GET /v1/dashboard/billing/credit_grants` 已不在现行公开 API reference（第三方工具仅作 best-effort 兜底）🔧 | Admin API Key（org 级）；legacy 端点兼容旧版用户 Key | usage：按模型/日期 token 与成本分桶；legacy credit_grants：赠金/充值余额（未文档化，随时可废） | ChatGPT 订阅（Plus/Pro）与 API **计费完全独立**（官方帮助中心）；订阅内用量/额度**无 API**；部分订阅可给关联 API 组织发推广额度，仍走 API 侧计费 | 不适用（无算力券体系） | Admin Key 权限大（组织级）；usage 数据有延迟 | **部分可机读**（用量可读；余额无公开 API；订阅无 API） |
| 9 | **Anthropic** | 用量和成本 Admin API ✅（旧版 usage/cost 报告端点 + 新「用量和成本分析 API」，Admin Key `sk-ant-admin01-...`）；余额：**无公开 API** 📄 | Admin API Key | 按模型/工作空间的 token 与成本明细（与 Console 用量/费用页同源数据） | Claude Max/Ultra 订阅赠的每月 API credit 显示在 Console→Billing，**无 API**（第三方工具只能拿 spend，拿不到 remaining；个别工具靠 Cookie 抓 Console 私有接口 🔧） | 不适用 | Admin Key 仅组织管理员可建 | **部分可机读**（用量可读；余额仅人工） |
| 10 | **Google AI Studio / Gemini API** | **无余额查询 API** 📄。仅免费层/RPM/TPM 配额与 tier 消费上限文档（Free / Tier1 $250 / Tier2 $2,000 / Tier3 $20k+ 月消费帽）✅ | —（配额按项目+结算账号层级控制） | 无"剩余量"概念——免费层是速率限制（RPM/TPM/日请求），付费层是层级 spend cap | 无订阅套餐 API | 不适用 | 免费层数据无剩余可查，只能按文档静态配额做"理论上限" | **无 API**（配额文档化，无法机读剩余） |

---

## 二、分类清单

### A. 第一版插件可直接对接（模型 API Key 一把梭）

| 渠道 | 端点 | 能拿到什么 |
|------|------|-----------|
| DeepSeek | `/user/balance` | 总余额、赠金、充值拆分、is_available |
| Kimi（国内+国际双站） | `/v1/users/me/balance` | 可用/代金券/现金三分项 |
| SiliconFlow | `/v1/user/info` | 余额、充值、总额 |
| OpenRouter | `/key` | 用量（日/周/月）、key 限额余量、预算余量+重置时间、免费模型日额度 |

### B. 可机读但需要另一类凭证（AK / 管理密钥 / CLI）

| 渠道 | 凭证 | 端点/命令 | 备注 |
|------|------|----------|------|
| 阿里云百炼 | AccessKey（RAM 最小权限） | `QueryAccountBalance` / `QueryResourcePackageInstances` / `ListSubscriptions` / `ListUsageRecords` | **唯一能查资源包有效期的渠道** |
| 火山方舟 | AK/SK（或 arkcli SSO 登录态） | `arkcli usage plan` / `usage stats` / `billing list` | 唯一官方给出套餐窗口剩余+重置时间的渠道 |
| OpenRouter（可选） | Management Key | `/credits` | 总额度/总用量；普通 Key 的 `/key` 已够第一版 |

### C. 部分可机读 / 未文档化接口（带熔断降级）

| 渠道 | 接口 | 风险 |
|------|------|------|
| 智谱 | `open.bigmodel.cn/api/biz/account/query-customer-account-report`（现金/充值/赠金）、资源包列表（EFFECTIVE/EXPIRED + token 数）、`/api/monitor/usage/quota/limit`（Coding Plan 配额） | 从控制台前端 JS 挖出、官方未列；改版即失效；插件须把该渠道标为「尽力而为」，失败自动落人工登记 |

### D. 无 API / 仅人工登记（插件需手动录入余额兜底）

| 渠道 | 缺什么 | 人工登记什么 |
|------|--------|-------------|
| OpenAI | 余额无公开 API；ChatGPT 订阅额度无 API | 人工登记 API 余额（或接受 legacy credit_grants 不稳定）；订阅额度登记总额+到期日 |
| Anthropic | 余额无公开 API；Max/Ultra 订阅赠 credit 无 API | 人工登记余额与每月 credit 总额 |
| Google Gemini | 完全无余额/剩余 API | 免费层按文档静态配额登记（RPM/TPM/日额度），无剩余概念 |
| 智谱 GLM Coding Plan（官方侧） | 官方无用量 API，仅控制台用量统计页 | 若放弃未文档化接口，则人工登记 5h/周积分总额 + 本地估算消耗 |
| 一切订阅制（ChatGPT Plus、Claude Max 等） | 普遍无机读 | 人工登记 |

---

## 三、专项回答（任务书三问）

### Q1：包月套餐普遍能否量化「剩余」？

**不普遍——10 渠道中仅 2 家有官方机读的套餐剩余。**

- ✅ **火山方舟**（Agent Plan/Coding Plan）：官方 CLI 直接给 `used/total/percent/reset_at`（5h/weekly/monthly/session 四窗口），质量最高。
- ✅ **阿里云百炼**（Token Plan）：订阅 + 当月 Credits 用量两条 API，剩余可自算（总额−已用）。
- 🔧 **智谱 GLM Coding Plan**：官方只承诺「控制台用量统计页可看」，API 未文档化；第三方实测 `/api/monitor/usage/quota/limit` 可拿配额 x/y，但无稳定性承诺。
- 📄 **其余订阅制**（OpenAI ChatGPT 订阅、Anthropic Max/Ultra 赠 credit）：无 API，只可人工登记。
- 另注意：**包月套餐与预充值是两个独立额度池**（智谱 coding 路由与标准 API 分开计；方舟套餐制连金额账单都没有，只有额度口径），插件不能用「查到余额」代替「查到套餐剩余」。

**插件对包月渠道的策略**：优先走方舟/百炼的官方机读；智谱用未文档化接口+降级开关；其余订阅制采用 **「人工登记总额 + 本地用量估算」**——从 `llm/stream` 的 TokenUsage 按官方折算系数（智谱积分=（输入×系数+缓存×系数+输出×系数)/10000；方舟 AFP=（输入×系数+输出×系数)/10000，系数按模型查官方表）本地累计消耗，再与控制台快照人工对账校准。社区插件 DSH-TOKEN-feiyong 已验证该做法可行（实测对账比值 1.0000）。

### Q2：限期算力券普遍能否查「剩余 + 过期时间」？

**「剩余」大多可查，「过期时间」基本不可查。**

- ✅ 阿里云资源包：`QueryResourcePackageInstances` 既能查剩余又能按有效期过滤/返回——全场唯一。
- 🔧 智谱资源包（限时算力券/体验金）：第三方接口可查名称/适用模型/token 量/状态（EFFECTIVE|EXPIRED），过期时间字段未获证实。
- ✅ DeepSeek `granted_balance`（"未过期赠金"总额）与 Kimi `voucher_balance`：只回金额，**无过期时间**；SiliconFlow 赠金并入总额更无分项。

**策略**：过期时间统一人工登记（每张券一次性录入到期日，维护成本低）；调度按「剩余额 ÷ 剩余天数」衰减加权消耗限期券。

### Q3：综合策略建议（插件第一版形态）

1. **四层数据源分级**（对齐上表 A→D）：Key 直读 → AK/CLI 读 → 未文档化接口（熔断+降级）→ 人工登记。
2. **凭证隔离**：余额查询凭证 ≠ 模型调用 Key。AK、Management Key、智谱财务接口凭据要独立 credential 槽位 + 权限提示（AK 权限远大于模型 Key），并做「接口失效熔断」——非官方承诺的接口失败 N 次即标记该渠道 degraded，转入人工登记值。
3. **财务优先级落地**：包月（官方机读优先；无机读则人工登记+本地估算）> 限期券（剩余可读+过期日人工登记，按时间衰减先用）> 预充值（余额直读，低于阈值降权）。
4. **缓存与限频**：余额接口各家未承诺限速，建议 ≥60s 缓存 + 派遣时才刷新；OpenAI/Anthropic Admin API 有数据延迟，只作兜底参考。
5. **领域内先例**：DSH-TOKEN-feiyong（DSH 插件）已实测 DeepSeek/智谱/方舟三条链路（含智谱未文档化财务接口、方舟 `arkcli usage plan` 解析、AFP 系数对账），可直接借鉴其请求与降级写法。

---

## 四、出处链接

**官方文档**

| # | 链接 | 支撑内容 |
|---|------|---------|
| 1 | https://api-docs.deepseek.com/api/get-user-balance/ （中文版 https://api-docs.deepseek.com/zh-cn/api/get-user-balance/ ） | DeepSeek 端点、Bearer、balance_infos 字段 |
| 2 | https://docs.bigmodel.cn/cn/coding-plan/overview | GLM Coding Plan 5h/周积分窗口、积分抵扣公式、套餐不透支其他余额 |
| 3 | https://docs.bigmodel.cn/cn/coding-plan/faq | 套餐剩余仅「用量统计」页可看；coding Key 与标准 Key 分开管理 |
| 4 | https://platform.kimi.com/docs/api/balance | Kimi 国内站 /v1/users/me/balance 官方文档 |
| 5 | https://platform.kimi.ai/docs/api/balance.md | Kimi 国际站余额端点全文（OpenAPI：available/voucher/cash 三字段、Bearer、双站 Key 独立） |
| 6 | https://www.kimi.com/help/kimi-api/api-balance-and-usage | Kimi 官方帮助中心：余额接口与 voucher_balance 说明 |
| 7 | https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-queryresourcepackageinstances | QueryResourcePackageInstances（资源包实例、有效期过滤） |
| 8 | https://www.alibabacloud.com/help/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-overview | BSS OpenAPI 总览：QueryAccountBalance 查询账户余额 |
| 9 | https://help.aliyun.com/zh/user-center/developer-reference/api-calling-authorization | BSS 接口 RAM 授权（bss:DescribeAcccount 等） |
| 10 | https://www.alibabacloud.com/help/en/model-studio/list-subscription-shared-packages.md | 百炼 Token Plan 订阅 API（modelstudio 端点、ACS3 签名、Bearer 不支持） |
| 11 | https://developer.aliyun.com/article/1781076 | 百炼 Token Plan 监控实操：`aliyun bailian ListSubscriptions/ListUsageRecords`、`QueryCouponList` |
| 12 | https://docs.volcengine.com/docs/volcano-engine-skills/ark-usage-and-cost-analysis?lang=zh | 方舟官方 Agent Toolkit：套餐额度/用量/账单查询能力矩阵 |
| 13 | https://docs.volcengine.com/docs/ark/usage-and-diagnostics?lang=zh | arkcli usage/billing/doctor 命令参考（5–30min 延迟、T+1 出账口径） |
| 14 | https://github.com/volcengine/ark-cli/blob/main/skills/arkcli-usage/references/arkcli-usage-plan.md | arkcli usage plan：periods[]{used/total/percent/reset_at}、ListSubscribeTrade 探 SKU（官方开源仓库） |
| 15 | https://docs.byteplus.com/en/docs/modelark/models-and-plans | BytePlus ModelArk：arkcli plans（订阅套餐 list holdings/buy/renew）与 token 包路由区分 |
| 16 | https://docs.siliconflow.com/en/api-reference/userinfo/get-user-info | SiliconFlow /v1/user/info（balance/chargeBalance/totalBalance，Bearer） |
| 17 | https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key.md | OpenRouter /key 官方 OpenAPI：usage、limit_remaining、budgets(resets_at)、free_model_daily_requests |
| 18 | https://openrouter.ai/docs/client-sdks/typescript/sdks/credits/README | OpenRouter /credits 端点（Management Key） |
| 19 | https://developers.openai.com/api/reference/cli/resources/admin/subresources/organization/subresources/usage/methods/completions | OpenAI 官方 API reference：GET /organization/usage/completions（Admin Key） |
| 20 | https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform | OpenAI 官方帮助中心：ChatGPT 订阅与 API 计费相互独立；订阅赠 API 推广额度的口径 |
| 21 | https://platform.claude.com/docs/zh-CN/manage-claude/usage-cost-api | Anthropic 官方：用量和成本 Admin API（新旧两代，Admin Key），数据与 Console 用量/费用页同源 |
| 22 | https://ai.google.dev/gemini-api/docs/rate-limits | Gemini API 免费层配额、基于支出的速率限制、tier 体系 |
| 23 | https://aistudio.google.com/docs/billing.md | AI Studio 计费文档：tier 消费帽（Free/250/2000/20000+） |

**第三方实测/社区证据（标注 🔧 的出处）**

| # | 链接 | 支撑内容 |
|---|------|---------|
| 24 | https://github.com/singei8/DSH-TOKEN-feiyong/blob/main/CHANGELOG.md | DSH 插件实测：智谱 `query-customer-account-report` 现金余额接口（官方未列）、`/api/monitor/usage/quota/limit` 配额档、方舟 `arkcli usage plan` 解析与 AFP 系数对账（比值 1.0000）、DeepSeek 余额实测 |
| 25 | https://github.com/KiwiGaze/glm-for-copilot/blob/main/src/client/usage.ts （测试样例 usage.test.ts） | 智谱 biz gateway 账户报告字段（balance/rechargeAmount/giveAmount/frozenBalance）与资源包字段（resourcePackageName/suitableModel/tokensMagnitude/status EFFECTIVE\|EXPIRED） |
| 26 | https://github.com/yilewang/llm-for-zotero/blob/e0553224af95e1f568def73bb03e795353c685fc/src/providers/QUOTA.md | GLM 预充值与 Coding Plan 额度池分离（/api/coding/paas/v4 独立路由），2026-09 核对 |
| 27 | https://github.com/steipete/CodexBar/blob/c61e01e774c449b06324a1cc260af7c77cf17d47/docs/openai.md | OpenAI：Admin Key 优先 usage/costs；legacy `dashboard/billing/credit_grants` 已不在公开 API reference（best-effort 兜底） |
| 28 | https://github.com/yetone/magpie/issues/6031 | Anthropic 无余额 API 的第三方确认（Max/Ultra 订阅赠 credit 只显示在 Console Billing） |
| 29 | https://github.com/steipete/CodexBar/pull/4510 | Claude Console 余额/订阅赠金过期只能靠 Cookie 抓私有接口（无官方 API 的旁证） |
| 30 | https://iqilian.com/learn/kimi-balance-jiankong/ | Kimi 三层监控（余额接口/项目预算/单次 usage）与字段口径中文解读 |
| 31 | https://ai.codefather.cn/news/2038836406557716487 及 https://iqilian.com/learn/kimi-api-jifei/ | Kimi 平台域名迁移公告与双站独立体系（moonshot.cn→kimi.com 人民币；moonshot.ai→kimi.ai 美元） |

> 免责：标注 🔧 的接口为社区实测，非官方承诺，随时可能失效；插件实现必须按 §三.Q3 的熔断降级处理。标注 ✅ 的端点以调研日官方文档为准。
