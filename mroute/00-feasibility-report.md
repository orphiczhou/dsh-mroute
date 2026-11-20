# 技术可行性论证报告：子会话派遣「模型选择优先参考」插件（mroute）

- 树节点：mroute / mroute-W3-synthesis
- 综合来源：`01-dsh-feasibility.md`（W1，DSH 侧机制调研）× `02-provider-apis.md`（W2，10 渠道余额/用量 API 调研）
- 报告日期：2026-11-13
- 面向读者：需要决策「是否立项、怎么做、第一步做什么」的用户
- 引用约定：`01§X` = 01 文档 X 节；`02§X` = 02 文档 X 节

---

## 1. 总体结论

**可行。推荐做「参考工具型」插件**：以 Host Tool（`model_route_query`，派遣前查询）为核心，Config 承载静态优先级/备选链，systemPrompt.section 加一句"派遣前先查"的提示，UI 面板作为人工查看的可选件——这套组合在宿主侧有同款先例（`list_subagent_models`），机制全部打通（01§A/§B/§D）。

**派遣参数层的"自动改写模型"不可行，也不必要**：宿主 `tools/pre-execute` 只允许 allow/deny、无 rewrite 通道（01§C-①）；且宿主已自带硬策略门 `assertAllowedModelSelection` 与 `tools.guard()` 拒绝能力，"拦截坏选择"是现成机制，插件补一个"参考+守门"层即可（01§C 结论）。`llm/stream` waterfall 理论上可全局改道，但作用面覆盖一切模型调用、可变语义未逐行验证，**高风险，不推荐**（01§C-②）。

**余额数据"渐进可得"而非"一步到位"**：10 渠道中 A 类（模型 Key 直读）4 家、B 类（AK/CLI 另类凭证）3 家、C 类（未文档化，需熔断）1 家、D 类（仅人工登记）覆盖其余（02§二）。包月套餐仅 2/10 官方可机读（火山方舟、阿里百炼），其余包月走「人工登记总额 + 本地 TokenUsage 按官方系数折算估算」，社区插件 DSH-TOKEN-feiyong 已验证对账比值 1.0000（02§三.Q1）。算力券剩余大多可查、过期时间基本不可查（唯阿里云资源包例外），过期日人工一次性登记 + 按剩余天数衰减先用（02§三.Q2）。

---

## 2. 需求逐条对照

| # | 用户需求 | 技术支撑点 | 依据 |
|---|---------|-----------|------|
| 1 | **能力分层**（overseas_sota / domestic_sota / bulk） | 插件自有注册表 `tier` + `capability` 字段承载分层判断；运行时用 `llm.listProviders()/listModels()/resolveModelInfo()` 校验该 provider/model 真实存在且 effort 合法（派遣前 `resolveCallConfig` 活校验兜底，路由错误派遣直接抛错不发生） | 注册面 01§A；llm 服务与活校验 01§B-3/B-2；分层标注属插件自有知识，靠 `reviewed_at` 人工复核保鲜（见 §5 风险 4） |
| 2 | **财务优先级：包月 > 算力券 > 预充值** | 注册表 `channel_type: monthly\|voucher\|prepaid` 驱动排序：包月优先（机读剩余的方舟/百炼直读；无机读的用人工登记+本地折算），限期券次之（剩余÷剩余天数衰减加权），预充值兜底（余额低于阈值降权）。注意包月与预充值是**两个独立额度池**，不能拿"有余额"冒充"套餐有剩余" | 财务三级策略 02§三.Q3.3；包月仅 2/10 机读 02§三.Q1；双额度池警示 02§三.Q1 末段、02§一 #2/#5；券衰减策略 02§三.Q2 |
| 3 | **替代备选（fallback 链）** | 注册表每渠道 `fallbacks[]` 显式声明备选序列；宿主缺省解析链本身就有回落语义（request > 插件 Config `agentOptions` ⊕ providerRouteDefaults > 父 route），插件静态子默认可直接被宿主吃掉、不必重造缺省机制；若所选 route 被策略门拒绝，lead 拿查询工具返回的排序列表换下一项即可 | 缺省链 01§B-1；策略门拒绝行为 01§C-①；config.agentOptions 可承接静态子默认 01§D 结论行 |
| 4 | **剩余 token / 余额查询** | 插件进程内可直接 Node fetch，正规接缝 `ctx.connection.fetch`；DeepSeek 官方余额甚至有宿主内先例 `deepseekAccount.getBalance`；密钥一律走 `ctx.credentials`（`modifyRecord` 记录 / `credentialRef` 键，describe 永不回显），**禁止进 Config**；凭证隔离：余额查询凭证 ≠ 模型调用 Key，AK 类凭证（百炼/方舟）权限远大于模型 Key，须最小权限 + 独立槽位 | HTTP 多通道与官方先例 01§E；密钥纪律 01§E + host-plugin.md L77；凭证隔离与熔断 02§三.Q3.2；各渠道端点明细 02§一 总表 / §二.A–D |
| 5 | **动态能力变化**（渠道上下线、余额波动、接口失效） | 三层保鲜：① 运行时发现——`llm.listModels()` 每次查询校验渠道还活着；② 余额/健康状态带 `health.state`（ok/degraded/unknown）+ 熔断（C 类接口失败 N 次 → 标 degraded → 落人工登记值）；③ 注册表级 `reviewed_at` + 人工复核提示（能力分层与折算系数是会过时的"编辑期知识"） | 熔断降级策略 02§三.Q3.2；注册表 reviewed_at 为本报告新增设计（§3）；llm 运行时发现 01§B-3 |

**覆盖判定**：5 条需求中 1/2/3/5 由"注册表 + 查询工具"完整支撑，4 的自动化程度分四级渐进覆盖（A 全自动 → D 纯人工），无任何一条需求落在"技术不可行"区。

---

## 3. 推荐架构

```
┌─ 注入层 ──────────────────────────────────────────────┐
│ ① Host Tool: model_route_query（核，模型消费）          │
│ ② systemPrompt.section："派遣前先查路由"（一句提示）      │
│ ④ UI 面板：余额/健康状态可视化（可选，人工消费）           │
└──────────────┬───────────────────────────────────────┘
┌─ 查询/排序层 ─▼───────────────────────────────────────┐
│ model_route_query{capability, budget, ...}             │
│ = 读注册表 → 逐渠道取余额（缓存优先）→ 财务/能力加权排序  │
└──────────────┬───────────────────────────────────────┘
┌─ 数据层 ─────▼───────────────────────────────────────┐
│ 模型注册表（Config，静态：tier/capability/priority/     │
│   fallbacks/reviewed_at）                              │
│ 余额获取层：A Key直读 / B AK·CLI / C 未文档化(熔断)      │
│   / D 人工登记 + 本地 TokenUsage 折算估算                │
│ 缓存（≥60s）+ 熔断（失败 N 次 → degraded）              │
│ 密钥：ctx.credentials（绝不进 Config）                  │
└──────────────────────────────────────────────────────┘
```

### 3.1 模型注册表 schema（Config 承载，示例 JSON）

```jsonc
{
  "registry_version": 3,
  "reviewed_at": "2026-11-13",              // 人工复核日期——能力分层/系数过时的复核锚点（§5 风险4）
  "reviewed_against": "DSH 0.2.2-rc.1 / 渠道官方文档 2026-11",
  "channels": [
    {
      "id": "deepseek-official",
      "provider": "deepseek-official",       // 与 llm.listProviders() 的 id 一致（01§B-3 实测 5 provider 之一）
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "channel_type": "prepaid",             // monthly | voucher | prepaid —— 财务优先级一级键（02§三.Q3.3）
      "tier": "domestic_sota",               // overseas_sota | domestic_sota | bulk —— 能力分层
      "priority": 70,                        // 同 channel_type 内的次级排序
      "capability": { "coding": "good", "tools": true, "long_context": true, "vision": false },
      "fallbacks": ["deepseek-account"],     // 本渠道不可用/被拒时的备选序列（需求3）
      "balance": {
        "adapter": "A",                      // A|B|C|D —— 02§二 四级分类
        "method": "host_get_balance",        // A 类；DeepSeek 走宿主内 deepseekAccount.getBalance 先例（01§E）
        "credential_ref": "mroute/deepseek-balance-key",
        "cache_ttl_s": 120,                  // ≥60s（02§三.Q3.4）
        "low_balance_threshold_cny": 10
      },
      "manual": null                         // D 类兜底字段；A/B/C 类为 null
    },
    {
      "id": "volc-ark",
      "provider": "…",
      "channel_type": "monthly",
      "tier": "domestic_sota",
      "priority": 95,
      "capability": { "coding": "good", "tools": true, "long_context": true, "vision": true },
      "fallbacks": ["zai-coding-cn"],
      "balance": {
        "adapter": "B",
        "method": "arkcli_usage_plan",       // 官方 CLI，items[].periods[]{used,total,percent,reset_at}（02§一 #5）
        "credential_ref": "mroute/volc-aksk",
        "cache_ttl_s": 300,
        "note": "reset_at 是窗口刷新时间，不是订阅到期日"
      },
      "manual": null
    },
    {
      "id": "zai-coding-cn",
      "provider": "zai-coding-cn",
      "channel_type": "monthly",             // GLM Coding Plan
      "tier": "domestic_sota",
      "priority": 90,
      "capability": { "coding": "excellent", "tools": true, "long_context": true, "vision": false },
      "fallbacks": ["deepseek-official"],
      "balance": {
        "adapter": "C",                      // 未文档化 quota/limit 接口（02§一 #2、§二.C）
        "method": "undocumented_quota_limit",
        "fallback_to_manual": true,          // 失败 N 次 → degraded → 落 manual 值
        "breaker_threshold": 3,
        "credential_ref": "mroute/zhipu-biz-cred"
      },
      "manual": { "quota_total": "…", "quota_used_est": "…", "grant_expires_at": null,
                  "last_recorded_at": "2026-11-13", "note": "Coding Plan 与预充值独立额度池" }
    },
    {
      "id": "anthropic-sub",
      "provider": "…",
      "channel_type": "monthly",
      "tier": "overseas_sota",
      "priority": 85,
      "capability": { "coding": "excellent", "tools": true, "long_context": true, "vision": true },
      "fallbacks": [],
      "balance": {
        "adapter": "D",                      // 订阅赠 credit 无 API（02§二.D）
        "method": "manual_plus_local_estimate",
        "estimate": { "source": "llm_stream_token_usage",     // 本地折算（02§三.Q1）
                      "coeff_table_ref": "anthropic-price-table@2026-11",
                      "reconcile_note": "与 Console Billing 快照人工对账校准" }
      },
      "manual": { "quota_total": "…", "quota_used_est": "…", "grant_expires_at": "2026-12-01",
                  "last_recorded_at": "2026-11-13", "note": "Max 订阅月度 credit，到期日人工登记" }
    }
  ]
}
```

设计要点：
- **`channel_type` 是财务排序一级键**（monthly > voucher > prepaid），`priority` 只在同类内生效——直接落地需求 2 的三级财务优先级（02§三.Q3.3）。
- **`voucher` 渠道**额外消费 `grant_expires_at`（人工一次性登记）与剩余量，按「剩余额 ÷ 剩余天数」衰减加权，先用快过期的券（02§三.Q2）。
- **`tier`/`capability` 是编辑期知识**，必须带 `reviewed_at`；`provider`/`models` 是运行期知识，每次查询用 `llm.listModels()` 活校验（01§B-3），两层分开保鲜。
- **`manual` 对象是 D 类与熔断降级的统一落点**：无论哪级适配器失败，查询层总能返回"人工登记值 + 估算值 + 数据新鲜度"，永不返回空。

### 3.2 余额获取层：A/B/C+D 四类适配器

| 适配器 | 覆盖渠道 | 凭证 | 机制 | 熔断/降级 |
|---|---|---|---|---|
| **A** Key 直读 | DeepSeek、Kimi 双站、SiliconFlow、OpenRouter(/key) | 普通模型 API Key（存 credentials） | Bearer GET 官方端点；DeepSeek 可走宿主 `deepseekAccount.getBalance` 先例 | 官方接口，失败即报 unknown，不静默 |
| **B** AK/CLI | 百炼（BSS + Token Plan，唯一能查资源包有效期）、方舟（arkcli usage plan，唯一官方给套餐剩余+reset_at）、OpenRouter /credits（可选 Management Key） | AccessKey/AK-SK（独立 credential 槽位 + 权限提示） | 官方 OpenAPI/CLI；方舟推荐复刻 arkcli 的 OpenAPI 调用 | 官方接口；AK 权限大，建议 RAM 最小权限 |
| **C** 未文档化 | 智谱（biz 网关余额/资源包/quota limit） | 站内凭据 | 第三方实测可用（02§二.C），官方随时可改版加签 | **强制熔断**：失败 N 次（默认 3）→ `health.state=degraded` → 落 `manual` 登记值，UI 提示"尽力而为" |
| **D** 人工登记 | OpenAI/Anthropic 余额与一切订阅制、Gemini（无剩余概念，只登记静态配额）、智谱官方侧兜底 | 无 | 用户在 Config/UI 录入总额+到期日；消耗由本地 TokenUsage 按官方折算系数累计，定期与控制台快照对账校准 | 系数表带版本引用；对账比值参考 DSH-TOKEN-feiyong 的 1.0000 实测做法 |

### 3.3 缓存与熔断

- **缓存**：余额查询 ≥60s TTL（各家未承诺限速，02§三.Q3.4）；派遣时才刷新过期条目；OpenAI/Anthropic Admin 用量数据本身有延迟（5–30min/T+1），只作参考不作硬门。
- **熔断**：每渠道维护 `health{state, last_check_at, last_error, consecutive_failures}`；C 类连续失败达 `breaker_threshold` 即 degraded；degraded 渠道在排序中降权并在工具返回里标注原因；恢复探测（成功一次）可回 ok。
- **口径隔离**：方舟 usage 域（近实时）与 billing 域（T+1）不混用（02§一 #5）；智谱 coding 路由与标准 API 是两个额度池（02§一 #2）——适配器内固定口径，排序层不跨口径相加。

### 3.4 注入方式（对齐 01§D 推荐组合）

1. **① Host Tool（核）**：`model_route_query`，`ctx.tools.register(defineTool(...))`，与宿主 `list_subagent_models` 同形态（01§A、§B-6）。
2. **③ Config**：注册表全量放插件 Config（schemastery 校验；volatile 字段可热更，01§A Config 行）。
3. **② systemPrompt.section**：一段固定提示"派遣子会话前先调 model_route_query，按返回排序选择 assignee"（01§A systemPrompt 行、§D-②）。
4. **④ UI 面板（可选，M4）**：`ctx.slots.inject()` + React 组件展示余额/健康/复核提示，只服务人工（01§D-④）。

---

## 4. 消费路径（指挥官派遣子会话前的实际流程）

```
lead 会话收到一个需要派遣子会话的任务
  │
  ├─（systemPrompt 已提示）lead 调用：
  │    model_route_query { capability: "coding", tier_min: "domestic_sota",
  │                        budget: "monthly_first", exclude_degraded: true }
  │
  ├─ 插件内部（毫秒级，余额走缓存）：
  │    读注册表 → 过滤 capability/tier → 逐渠道取余额/健康
  │    → 财务加权（monthly > voucher[衰减] > prepaid[低额降权]）
  │    → 健康降权（degraded 靠后并标注）→ 产出排序表：
  │
  │  返回示例：
  │  1. zai-coding-cn  (monthly, 剩余≈72%, health=ok, 理由: 包月优先+coding 强)
  │  2. volc-ark       (monthly, 窗口剩余 88%, reset_at=+3h, health=ok)
  │  3. deepseek-official (prepaid, ¥43.2, health=ok, 理由: 余额充足兜底)
  │  ⚠ anthropic-sub   (monthly, 人工登记+估算, 数据截至 2026-11-12)
  │
  ├─ lead 选第 1 名，填派遣参数：
  │    tree_dispatch { ..., assignee: { provider: "zai-coding-cn", model: "glm-…" } }
  │    （或 subagent { provider, model }；两个派遣口同构，01§B-7）
  │
  ├─ 宿主活校验：resolveCallConfig 通过则派遣发生；
  │    若被 assertAllowedModelSelection 拒（route 不在会话 policy 内），
  │    工具返回明确错误 → lead 换排序列表下一项重试（无需再查插件）
  │
  └─ 派遣完成；本次消耗由本地 TokenUsage 折算累计进 D 类估算账（如涉及）
```

要点：插件只提供"参考+守门"，**最终选择权与重试都在 lead**；宿主策略门是最后一道硬闸，插件排序表已把 policy 兼容性作为前置过滤输入（可结合 `list_subagent_models` 的 policy 过滤结果做交集，01§B-6）。

---

## 5. 风险清单

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| 1 | **未文档化接口失效**：智谱 biz 网关余额/资源包/quota limit 均从控制台前端挖出，改版/加签即失效（02§二.C） | 中高 | 强制熔断（失败 N 次 → degraded → 落人工登记值）；渠道标"尽力而为"；官方侧兜底 = 人工登记 5h/周积分 + 本地估算（02§三.Q1） |
| 2 | **密钥安全**：余额查询凭证 ≠ 模型 Key；百炼/方舟 AK 权限远大于模型 Key（可查账单、资源包） | 中高 | 全部走 `ctx.credentials`（modifyRecord/credentialRef，describe 永不回显），禁止进 Config（01§E + host-plugin.md L77）；AK 槽位独立 + 权限提示 + 建议最小权限 RAM 策略（02§三.Q3.2） |
| 3 | **包月估算漂移**：本地折算依赖官方系数表与缓存 token 计费口径；系数调价、口径变更、control 台对账缺失都会让估算偏离 | 中 | 系数表带版本引用（`coeff_table_ref`）；定期人工对账校准（先例比值 1.0000，02§三.Q1）；UI 显示"估算值 + 数据截至时间"，绝不冒充机读值；包月渠道优先接官方机读（方舟/百炼） |
| 4 | **能力分层过时**：`tier`/`capability`/`priority` 是编辑期知识，模型升级、渠道下线、新渠道上线都会让注册表失真 | 中 | 注册表带 `reviewed_at` + `reviewed_against`；查询返回里对 `reviewed_at` 超过阈值（如 90 天）的渠道附"建议人工复核"标注；运行期事实（provider/model 是否存在）每次用 `llm.listModels()` 活校验，不依赖注册表（01§B-3） |
| 5 | **llm/stream 全局改道**：理论可改 GenerateOptions route 实现自动换模型，但作用于所有模型调用（含父会话/compaction/标题生成），可变语义未逐行验证（01§C-②） | 高（若做） | **明确不做**；主方案为参考工具型。此项仅存档为"理论通道"，如未来确需，须先逐行验证 GenerateOptions 可变性与调用方区分，单独立项评审 |
| 6 | **数据延迟误判**：OpenAI/Anthropic Admin 用量 5–30min~T+1 延迟；方舟 usage 近实时但 billing T+1（02§一 #8/#9/#5） | 低 | 延迟口径写进适配器元数据；UI/工具返回标注"数据截至"；这类数据只降权参考，不作硬门槛 |
| 7 | **inspect exact-query 在本 build 损坏**（01§开篇注），开发期部分宿主类型证据依赖 asar JSDoc 而非 d.ts | 低（开发期） | 开发期以运行时行为实测为准；`ctx.tools.register` 形态已有 dsh-tool-subagent 实源码可抄（01§A） |

---

## 6. MVP 分期路线（每期带验收标准）

### M1：静态注册表 + 查询工具 + 手动余额登记（纯参考层，零外呼）
**内容**：插件骨架（Host Tool `model_route_query` + Config 注册表 schema + systemPrompt.section 提示）；注册表内置 10 渠道静态数据（tier/capability/priority/fallbacks/channel_type/reviewed_at）；余额全部走 `manual` 人工登记值；排序引擎（财务三级 + 健康占位）。
**验收标准**：
1. 插件可安装激活，`model_route_query` 在会话内可调用，返回带排序理由的渠道列表（含 manual 余额与"人工登记"标注）；
2. Config 不合 schema 的注册表在激活时报出可读校验错误；
3. `provider/models` 与 `llm.listProviders()` 交集校验生效——注册表写了不存在的 provider 时返回条目标 unknown 并降权；
4. systemPrompt.section 在新会话提示文本中出现。

### M2：A 类渠道自动余额 + 缓存 + 熔断框架
**内容**：A 类 4 渠道（DeepSeek/Kimi 双站/SiliconFlow/OpenRouter /key）Bearer 直读适配器；DeepSeek 优先走宿主 `deepseekAccount.getBalance`；统一缓存（≥60s TTL）；`health` 状态机与熔断器上线（先只对 A 类生效）。
**验收标准**：
1. 四渠道用真实 Key 各拉到一次真实余额，字段与 02§一 总表一致；
2. 缓存 TTL 内重复调用不产生新的出站请求（可由日志/计数证明）；
3. 密钥仅存在于 credentials 记录，Config/日志/工具返回中无明文（describe 不回显验证）；
4. 人为制造失败（错 Key）→ 渠道转 degraded 且排序降权，恢复正确 Key 后可回 ok。

### M3：B/C 类适配器 + D 类本地用量估算 + 券衰减
**内容**：百炼 BSS+Token Plan（ACS3 签名，RAM 最小权限提示）、方舟 arkcli usage plan（或复刻其 OpenAPI）、智谱未文档化三接口（熔断+降级 manual）；本地 TokenUsage 折算估算引擎（系数表版本化）；voucher 渠道「剩余 ÷ 剩余天数」衰减排序；OpenRouter /credits（Management Key，可选）。
**验收标准**：
1. 方舟返回 `periods[]{used,total,percent,reset_at}` 且 reset_at 正确理解为窗口刷新而非订阅到期；
2. 百炼资源包返回含有效期字段（全场唯一）并可参与衰减排序；
3. 智谱接口人为断网/改路径 → 连续 3 次失败后自动 degraded、落 manual 值、UI/工具返回标注"尽力而为"；
4. 本地折算与渠道控制台快照对账，误差比值有记录（对齐 DSH-TOKEN-feiyong 的对账方法，目标接近 1.0）。

### M4：UI 面板 + 策略门整合
**内容**：`ctx.slots.inject()` React 面板（余额/健康/reviewed_at 复核提示/估算账本展示与人工登记入口）；`tools.guard()` 补充拒绝（对注册表标记为"禁用/欠费"渠道的派遣给可读错误）；与 `subagentModelSelection` policy 的交集过滤（排序前先按会话 policy 过滤，01§B-4/B-6）。
**验收标准**：
1. 面板展示全部渠道余额/健康/数据新鲜度，人工登记可在面板完成并写回 Config；
2. 对 `manual.status=disabled` 或余额低于阈值的渠道，派遣守门给出含替代建议的可读拒绝；
3. policy 过滤生效：查询返回不含会话 policy 不允许的 route；
4. `reviewed_at` 超期的渠道在面板与工具返回中均带复核提示。

---

## 7. 结论与建议

**是否值得做：值得。**
- 技术侧全部关键机制已被宿主先例验证（查询工具同款 `list_subagent_models` 在线可用；第三方插件挂 Tool/UI 的形态在本机已被 tree-engine 等多个插件跑通，01§F）；
- 数据侧 10 渠道无"全不可得"的死局：4 家 Key 直读、2 家官方机读套餐剩余、1 家熔断兜底、其余人工登记+本地折算有实测先例（02§二/§三）；
- 用户痛点（包月/券先用、余额枯竭前切换、备选链）恰好落在"参考+守门"型插件的能力圈内，不需要不可行的"自动改写"。

**不建议做的部分**：llm/stream 全局改道（01§C-②）；以及第一版就追求 10 渠道全覆盖——C 类智谱与 B 类 AK 接入的维护成本不成比例，放 M3。

**第一步（本周可启动）**：做 M1——把 §3.1 的注册表 schema 定稿，实现 `model_route_query` 工具 + 排序引擎 + manual 登记，先在本机 5 个 provider（deepseek-official/deepseek-account/opencode-go/zai-coding-cn/xiaomi，01§B-3 实测）上跑通"查询→选路→派遣"闭环。M1 验收通过后，M2 的 A 类自动余额是纯增量工作（一个适配器接口 + 四个端点实现），风险已被 M1 的熔断框架兜住。

---

*本报告结论以 01/02 两份调研原文为准；引用章节号均可回溯核对。02 中标注 🔧 的接口为社区实测，随官方改版可能失效，实现必须按 §5 风险 1 的熔断降级处理。*
