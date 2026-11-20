/**
 * mroute Config schema = 模型注册表（MVP）。
 *
 * ── Day 1 实测结论（2026-11-13，探针 tmp/day1-schemastery-probe/，@deepseek-ai/schemastery@3.19.0
 *    与宿主 asar 捆绑同版本号；完整结论见 docs/04-mvp-notes.md §1）──
 * 1. 嵌套 z.object 在 channels[] 元素内逐键存活（字节级一致）→ 本表用真嵌套对象，不做 JSON 字符串降级。
 * 2. z.record 缺失、z.dict 存在、z.any 存活——本表一律用固定形状字段，不用 record/dict/any。
 * 3. .volatile() 合法落点：顶层字段与数组字段合法；数组元素内字段抛错（宿主禁令）。
 *    → channels 数组整体 volatile（整条替换语义，读取走 .get()）；元素内 fallbacks/manual 不标。
 * 4. volatile 字段解析值为 Volatile 访问器，读取侧统一走 readVolatile()（lib/registry.js）双面兼容。
 *
 * 命名纪律（07 方案 §3.2-6）：LLM 路由提供者字段用 routeProvider（transportProvider v1 不设、不用）。
 * MVP 红线：无 balance/credential 等适配器字段（无 HTTP、无凭据面，M2 再入）。
 * M1 增量（0.2.0-m1.0）：manual.status 三值（FR-B1）/ capability 评级对象（FR-A3-3）/ enforce_gate
 * 缺省 false（FR-A6-3·NFR-0a，仅 schema 占位不接线）/ eval 预留位（07 §3.2-4）。
 * M2 增量（0.3.0-m2.0，quota 数据源接入）：渠道元素新增 `quota_platform`（显式声明 quota 平台
 * id，空=不接）+ `quota_account_verified`（账户语义核实标记，缺省 false）；顶层新增
 * `low_balance_threshold_cny`（低余额阈值，缺省 10 兼容 M1 常量）+ `quota_cache_ttl_seconds`
 * （quota 快照缓存 TTL，缺省 60）。红线（任务书 §3.8）：**仅当 quota_platform 非空且
 * quota_account_verified=true 才采信 machine 数值**——映射命中 ≠ 账户体系一致（GLM Coding
 * 包月订阅 ≠ quota zhipu 卡的 API 余额），未核实一律回落 manual。
 *
 * ── M5 探针结论（2026-11-20，脚本 plugin-mroute/tmp/m5-probe/probe-schema.mjs 与 tool-eval-probe.mjs）──
 * A. schemastery 形状（@deepseek-ai/schemastery@3.19.0，与宿主同版本）：
 *    1) `z.dict(z.object(嵌套对象)).default({}).volatile()` 在**顶层**合法，空表 {} 通过，`.get()` 可读；
 *    2) 真嵌套 z.object（scores 六维 default -1 / dimension_status z.dict(z.string()) / suggest / probe）
 *       逐键 roundtrip 一致，缺失维解析期回填 -1，JSON 序列化后六维全部 materialize；
 *    3) `JSON.parse(JSON.stringify(x))` 再 parse 幂等；4) 非法值解析期抛带路径错误
 *       （`$.model_eval.m.samples expected number …`）；5) **未知键被保留**（schemastery 不 strip）；
 *    6) 整表替换式写回（配置编辑）后两条目都在、samples 正确；7) 含 `/` `.` 的 dict 键合法。
 *    依据 1-7：model_eval 用 z.dict(z.object(...))（按统一模型名），eval_status 用顶层 z.object。
 * B. ctx.llm tools 注入（临时工具 mroute_eval_probe 实调，deepseek-official 与 xiaomi 两个 adapter）：
 *    `options.tools = [{name, description, parameters}]` **被 adapter 接受**，能产出 tool-call-delta
 *    与 finish.kind='tool-calls'（tool_calls[].id/name/argumentsDelta 可解析）⇒ tools 维可 graded，
 *    无需按计划降到 null。另实证：usage 恒倒数第二块、finish 恒最后一块；maxTokens=64 + effort=max
 *    会被 reasoning 吃满（finish=max-tokens、text 空）⇒ 单题 maxTokens 必须显式且留 reasoning 余量，
 *    effort 取共同档 high（见 lib/eval/runner.mjs 的 choosePinnedEfforts）。
 */
import z from '@deepseek-ai/schemastery'

/** channel_type 财务一级键闭集（monthly > voucher > prepaid）。 */
export const CHANNEL_TYPES = ['monthly', 'voucher', 'prepaid']
/** tier 能力分层闭集（overseas_sota > domestic_sota > bulk）。 */
export const TIERS = ['overseas_sota', 'domestic_sota', 'bulk']
/** manual.status 三值闭集（FR-B1，audit M-3 补齐；缺省 active，读侧缺字段=active 见 registry.js）。 */
export const MANUAL_STATUSES = ['active', 'disabled', 'exhausted']
/** capability 评级对象键集（FR-A3-3 v1.2 评级口径；MVP 布尔代理退役）。 */
export const CAPABILITY_KEYS = ['coding', 'tools', 'long_context', 'vision', 'world_knowledge', 'orchestration']
/** capability 评级字符串闭集（excellent > good > fair；无数据=键缺省）。 */
export const CAPABILITY_RATINGS = ['excellent', 'good', 'fair']

/**
 * 种子注册表：本机 5 provider（00 报告 §7 / 01§B-3 实测清单）。
 * manual 余额一律 "—" 占位（MVP 无自动余额；人工登记 M1 起可在设置面板改）。
 * models[] 为编辑期知识：opencode-go / xiaomi 清单待安装后按 listModels 实况首轮复核（reviewed_at 锚点语义）。
 * capability 评级为编辑期知识（FR-A3-3 v1.2 口径）：仅 zai 的 coding=excellent 有实测依据（GLM Coding 包月），
 * 其余渠道不臆造评级（键缺省 = 无数据，查询侧 reason 注明 M2 接入）。
 */
export const SEED_CHANNELS = [
  {
    id: 'zai-coding-cn',
    routeProvider: 'zai-coding-cn',
    models: ['glm-4.6'],
    channel_type: 'monthly',
    tier: 'domestic_sota',
    priority: 90,
    fallbacks: ['deepseek-official'],
    capability: { coding: 'excellent' },
    // quota 映射（M2/M4）：quota zhipu 卡 = ZAI_CODING_CN/ZHIPU 等 key 查智谱 Coding Plan 用量
    // （direct.ts:1003），条目是 5h/周用量窗口无余额数值（direct.ts:382-403）。窗口语义已由
    // quota-view 归一化为 mode=window（M4）；账户同源由用户 2026-11-20 明确确认
    // （「额度卡与渠道账户同源」）→ verified:true。
    quota_platform: 'zhipu',
    quota_account_verified: true,
    manual: { quota_total: '—', quota_used_est: '—', note: 'GLM Coding 包月；coding excellent' },
    reviewed_at: '2026-11-13',
  },
  {
    id: 'opencode-go',
    routeProvider: 'opencode-go',
    models: [],
    channel_type: 'monthly',
    tier: 'domestic_sota',
    priority: 80,
    fallbacks: ['zai-coding-cn'],
    // quota 映射（M2/M4）：opencode-go 平台存在（direct.ts:1022），quota 卡为用量窗口
    // （5h/本周/本月，无余额数值）→ quota-view 归一化为 mode=window；账户同源由用户
    // 2026-11-20 明确确认（「额度卡与渠道账户同源」）→ verified:true。
    quota_platform: 'opencode-go',
    quota_account_verified: true,
    manual: { quota_total: '—', quota_used_est: '—', note: 'opencode-go 包月；models[] 待首轮复核' },
    reviewed_at: '2026-11-13',
  },
  {
    id: 'deepseek-official',
    routeProvider: 'deepseek-official',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    channel_type: 'prepaid',
    tier: 'domestic_sota',
    priority: 70,
    fallbacks: ['deepseek-account', 'xiaomi'],
    // quota 映射（M2）：quota deepseek 卡用 DEEPSEEK_API_KEY 查官方 API 余额
    // （direct.ts:1000→271-289）。verified:true 依据链——用户澄清（2026-11-15）DeepSeek
    // 只有一个源：该 key 即 DSH deepseek 路由同一把 key，official/account 两渠道同源，
    // 映射同一张卡即同一账户。
    quota_platform: 'deepseek',
    quota_account_verified: true,
    manual: { quota_total: '—', quota_used_est: '—', note: '官方平台预充值' },
    reviewed_at: '2026-11-13',
  },
  {
    id: 'deepseek-account',
    routeProvider: 'deepseek-account',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    channel_type: 'prepaid',
    tier: 'domestic_sota',
    priority: 65,
    fallbacks: ['deepseek-official', 'xiaomi'],
    // quota 映射（M2）：同 deepseek-official——用户澄清（2026-11-15）DeepSeek 只有一个源，
    // 两行渠道同源同一账户，verified:true。
    quota_platform: 'deepseek',
    quota_account_verified: true,
    manual: { quota_total: '—', quota_used_est: '—', note: '账号渠道预充值' },
    reviewed_at: '2026-11-13',
  },
  {
    id: 'xiaomi',
    routeProvider: 'xiaomi',
    models: [],
    channel_type: 'prepaid',
    tier: 'bulk',
    priority: 50,
    fallbacks: ['deepseek-account'],
    // quota 映射（M2）：verified:true 依据链——①platform-map.ts:20-22 明证 xiaomi 平台 id 与
    // DSH provider id 对齐设计（同一把 XIAOMI_API_KEY → 同一账户）；②AGENTS §9 实录 quota_refresh
    // 实出小米卡余额 ¥57.93（适配器为本机真实账户直查）。
    quota_platform: 'xiaomi',
    quota_account_verified: true,
    manual: { quota_total: '—', quota_used_est: '—', note: '小米 bulk 跑量渠道；models[] 待首轮复核' },
    reviewed_at: '2026-11-13',
  },
]

/**
 * manual 子对象：D 类人工登记统一落点（00 §3.1 设计要点）。
 * status 三值（FR-B1 / audit M-3 补齐）：active=正常登记；disabled=人工停用；exhausted=额度耗尽挂起。
 * 语义消费方：warning 标注（FR-A6，M1 起非阻断标注）与 M2 账本 mask（FR-A2）。
 */
const manualSchema = z.object({
  status: z.union([...MANUAL_STATUSES]).default('active'),
  quota_total: z.string().default('—'),
  quota_used_est: z.string().default('—'),
  note: z.string().default(''),
}).default({})

/**
 * capability 评级对象（FR-A3-3 v1.2 评级口径，MVP 布尔代理退役）。
 * 值域 = CAPABILITY_RATINGS 评级字符串；键缺省 = 无数据（schemastery object 语义：缺键省略，
 * 不回填占位值），查询侧对无数据渠道 reason 注明 M2 接入、保持现状不过滤。
 * 真嵌套对象落位依据：Day 1 实测嵌套逐键存活（头注结论 1）；元素内字段禁标 volatile（结论 3）。
 */
const capabilitySchema = z.object({
  coding: z.union([...CAPABILITY_RATINGS]),
  tools: z.union([...CAPABILITY_RATINGS]),
  long_context: z.union([...CAPABILITY_RATINGS]),
  vision: z.union([...CAPABILITY_RATINGS]),
})

/**
 * modelCapabilitySchema（M3.1 / 任务书 §3.2）：渠道级「每模型能力档位」行。
 * 每行 model 引用本渠道 models[] 之一（读侧只告警不拒，registry.js 归一化）；四维评级
 * 与渠道级 capability 同闭集，键缺省 = 无数据。整表随 channels 数组整替保存。
 * volatile 裁决（m3.5 探针 + lead 裁决 A）：数组元素内字段禁标 volatile——调用期抛
 * `volatile fields require a fixed object path without an enclosing volatile field`；
 * 本字段随父级 channels 数组整体 volatile 落盘（isVolatilePath('channels.*') 整棵子树合法）。
 */
export const modelCapabilitySchema = z.object({
  model: z.string(),
  coding: z.union([...CAPABILITY_RATINGS]),
  tools: z.union([...CAPABILITY_RATINGS]),
  long_context: z.union([...CAPABILITY_RATINGS]),
  vision: z.union([...CAPABILITY_RATINGS]),
})

/** 单条渠道。整条替换语义：编辑 channels = 整表替换（volatile 数组），元素内字段不可再标 volatile（Day 1 C4）。 */
export const channelSchema = z.object({
  id: z.string(),
  routeProvider: z.string(),
  models: z.array(z.string()).default([]),
  channel_type: z.union([...CHANNEL_TYPES]).default('prepaid'),
  tier: z.union([...TIERS]).default('domestic_sota'),
  priority: z.number().step(1).min(0).max(100).default(50),
  fallbacks: z.array(z.string()).default([]),
  capability: capabilitySchema,
  /**
   * model_capability（M3.1）：每模型四维能力档位（advisory 标注，**不参与排序**）。
   * 缺省 [] = 旧数据无此字段；未知模型引用读侧告警、去重首个生效、闭集外评级丢弃。
   */
  model_capability: z.array(modelCapabilitySchema).default([]),
  manual: manualSchema,
  /**
   * quota_platform（M2）：显式声明的 quota 面板平台 id（空=不接 machine 通道）。
   * 采信前提之一；映射命中 ≠ 账户体系一致（任务书 §3.8），平台 id 由人工显式登记而非
   * includes 推导（platformForProvider 仅作读侧交叉核对告警，见 lib/registry.js）。
   */
  quota_platform: z.string().default(''),
  /**
   * quota_account_verified（M2）：账户语义核实标记（缺省 false）。
   * true = 用户确认渠道账户与 quota 平台卡为同一账户体系，machine 数值才被采信；
   * false = 即使映射命中也回落 manual（红线：拿错账号余额当建议比不显示更糟）。
   */
  quota_account_verified: z.boolean().default(false),
  reviewed_at: z.string().default(''),
})

/** 复核锚三件套（07 §3.2-8 的 MVP 子集：registry_version / reviewed_at / reviewed_against；指纹锚 M5 起）。 */
export const Config = z.object({
  registry_version: z.number().step(1).min(1).default(1).volatile(),
  reviewed_at: z.string().default('2026-11-13').volatile(),
  reviewed_against: z.string().default('mvp1 seed @2026-11-13（schemastery 3.19.0 探针通过）').volatile(),
  channels: z.array(channelSchema).default(SEED_CHANNELS).volatile(),
  /**
   * enforce_gate（FR-A6-3 / NFR-0a）：阻断类能力 opt-in 开关，**缺省必须 false**（schema 断言）。
   * M1 仅 schema 占位 + 读侧缺省（registry.js），**不接线 tools.guard、无任何 deny 路径**——
   * advisory-only（NFR-0）：阻断仅用户显式开启且属 M6 范围。
   */
  enforce_gate: z.boolean().default(false).volatile(),
  /** eval 评测子对象预留位（07 §3.2-4 / 05§5.3 验收 6）：M1 空 object 占位，M5 填充清单冻结。 */
  eval: z.object({}).default({}).volatile(),
  /**
   * low_balance_threshold_cny（M2，任务书 §4.5）：低余额阈值可配置，缺省 10 兼容 M1 内置常量
   * （tool-query.js LOW_BALANCE_THRESHOLD_CNY）。CNY 语义：machine 余额仅在币种为 CNY/未知时
   * 参与阈值判定（USD 等其它币种不臆测汇率，只显示不触发 low_balance）。
   */
  low_balance_threshold_cny: z.number().min(0).default(10).volatile(),
  /**
   * window_week_tight_pct（M4.5，任务书 §3.4）：周窗口已用百分比达到该值时渠道 tight（沉底）。
   * 用户裁决 2026-11-20「周的98%之前都不太会影响任务执行」→ 缺省 98；范围 1–100 的整数。
   * advisory-only：只改推荐顺序（仍留在 routes[]），不剔除不阻断。
   */
  window_week_tight_pct: z.number().step(1).min(1).max(100).default(98).volatile(),
  /** window_5h_hint_pct（M4.5）：5h 窗口已用百分比达到该值时 hint（只标注不沉底），缺省 95。 */
  window_5h_hint_pct: z.number().step(1).min(1).max(100).default(95).volatile(),
  /**
   * quota_cache_ttl_seconds（M2，任务书 §4.2）：quota 快照缓存 TTL（秒）。缺省 60——quota 插件
   * 自身每 5 分钟刷新（config.ts:135 默认 refreshIntervalMinutes=5），mroute 缓存只是去抖
   * loopback 调用。下限 5s 防误配成高频打点。
   */
  quota_cache_ttl_seconds: z.number().min(5).max(3600).default(60).volatile(),
  /**
   * model_aliases（M4.6 / 07 §3 方案 A）：跨渠道模型归并映射。
   * 形状 = { [渠道 id]: { [该渠道模型 id]: 规范名 } }；缺省 {} = 未归并（每个 id 自反）。
   * 写入面仅两处：设置面板「模型归并」卡整表 set、model_route_alias_suggest apply 合并写。
   * schemastery 写法裁决（tmp/m46-schemastery-probe，@deepseek-ai/schemastery@3.19.0 与宿主同版本）：
   * 两层 z.dict 在顶层 volatile 字段下完整 roundtrip（含 `org/model:tag`/空格/点号键）、缺省 {}、
   * 非字符串值解析期即拒；z.record 不存在、单层 z.dict 无法表达两层——故用 z.dict(z.dict(z.string()))。
   * advisory-only：只影响 models_index 分组与 model_capability 解析顺序，不改 channels[].models
   * 形状、不参与排序、不剔除、不阻断。
   */
  model_aliases: z.dict(z.dict(z.string())).default({}).volatile(),
  /**
   * model_ratings（M4.7 / 用户 2026-11-20 指令）：按**统一模型名（canonical）**登记四维能力档位。
   * 形状 = { [规范模型名]: { coding?: 评级, tools?: …, long_context?: …, vision?: … } }，缺省 {}。
   * 用户裁决原文：「模型能力评价功能，不应放在各个渠道设置，应该放在统一模型名那个模块，
   * 按统一模型名来设置。视觉能力，应该有无的选项。」→ 评级以规范名为准，渠道只是承载；
   * `'none'` 表示**明确无此能力**（视觉等），与「未登记」不同：未登记 = 无数据，不臆测。
   * 位置决策：与 model_aliases 同级（同为「统一模型」维度）；channels[].model_capability 保留为
   * 兼容旧数据的**回退层**（registry 解析顺序：model_ratings → 渠道级 model_capability → 渠道 capability）。
   * advisory-only：只进入 models_index 与文本标注，**不参与排序**、不剔除、不阻断。
   */
  model_ratings: z.dict(z.dict(z.union([...CAPABILITY_RATINGS, 'none']))).default({}).volatile(),
  /**
   * dynamic_snapshot（M4.9 / 任务书 m4.9-panel-dynamic-and-dims.md）：最近一次 model_route_query
   * 的动态层快照——client 无法直连宿主（origin=dsh-app://app，相对 fetch 打不到宿主 HTTP），
   * 面板只能经 describe 读回本字段渲染 chips 与摘要行。
   * 形状 = { as_of: ISO 时间串, rows: [{ id, state, reason, windows, worst_used_pct(-1=未知),
   * low_balance, display }] }，缺省 {as_of:'',rows:[]}。
   * state 四值：'ok' 无规则触发（面板 ✓）| 'hint' 5h 高水位只标注（·）| 'tight' 沉底（⚠）|
   * 'unknown' 精度不明预留态（?）；缺省/非法值按 'ok'。
   * M4.10 起 rows **保留全部渠道**（含 ok 行，顺序 = routes 顺序 = 当前排序）——用户实测缺陷：
   * 只存非 ok 行时「刚查过且全部正常」与「从没查过」在面板上无法区分，且各渠道窗口%/余额读数
   * 完全看不到。ok 行 reason 恒为 ''，windows/display 至少一者可读（都无则空串）。
   * 写入面**仅一处**：tool-query.js 组装结果后静默写回（TTL 30s + rows 深比较变化才写，失败静默）；
   * client 侧是**只读镜像**（formFromView 读入、buildSaveOps 不含该字段）。
   * advisory-only：纯展示，不影响 routes[] 排序与形状。
   * schemastery 探针（tmp/m49-probe/probe.mjs，@deepseek-ai/schemastery@3.19.0）：
   * 顶层固定路径 z.object(...).default({}).volatile() 构造/parse 均不抛，tight 行全字段
   * roundtrip byte-identical，缺省字段回填，.get() 读回完整。
   */
  dynamic_snapshot: z.object({
    as_of: z.string().default(''),
    rows: z.array(z.object({
      id: z.string(),
      state: z.string().default('ok'),
      reason: z.string().default(''),
      windows: z.string().default(''),
      worst_used_pct: z.number().default(-1),
      low_balance: z.boolean().default(false),
      display: z.string().default(''),
    })).default([]),
  }).default({}).volatile(),
  /**
   * model_eval（M5-MVP / 计划 §3）：按**统一模型名（canonical）**保存最近一轮自动评测摘要。
   * 形状 = { [canonical]: { last_run, applied_effort, instrument_healthy, scores(六维，-1=无有效样本),
   * dimension_status({'graded'|'sentinel'|'invalid'|'null'}；sentinel = 校准哨兵，scores 留正确率但
   * 不计入 composite/samples)、composite(-1，只对 graded 维求均值)、samples(仅 graded 样本)、
   * wilson_lb(-1 哨兵)、provisional、suggest{tier(相对当前档的上一档，已顶格为空), priority_delta, note},
   * evidence_refs(JSONL 路径), probe{ttft_ms,tps,samples}（MVP 不实采，恒 -1/0）} }，缺省 {}。
   * 写入面**仅一处**：model_eval_run 实跑后经 configEditor.edit 合并写（失败静默，只报 eval_status_error）；
   * 读侧是面板只读一行 + 未来 M5.1 的覆盖链（计划 §2：manual.status > 渠道 tier/priority >
   * model_ratings > model_eval.suggest——suggest 只展示，**排序链不消费**）。
   * 纪律：**永不写** channels[].tier / channels[].priority / model_ratings（advisory-only）。
   * schemastery 依据见文件头 M5 探针结论 A（顶层 z.dict(z.object) 嵌套 roundtrip、缺省回填、未知键保留）。
   */
  model_eval: z.dict(z.object({
    last_run: z.string().default(''),
    applied_effort: z.string().default(''),
    instrument_healthy: z.boolean().default(false),
    scores: z.object({
      coding: z.number().default(-1),
      tools: z.number().default(-1),
      long_context: z.number().default(-1),
      vision: z.number().default(-1),
      world_knowledge: z.number().default(-1),
      orchestration: z.number().default(-1),
    }).default({}),
    dimension_status: z.dict(z.string()).default({}),
    composite: z.number().default(-1),
    samples: z.number().default(0),
    wilson_lb: z.number().default(-1),
    provisional: z.boolean().default(true),
    suggest: z.object({
      tier: z.string().default(''),
      priority_delta: z.number().default(0),
      note: z.string().default(''),
    }).default({}),
    evidence_refs: z.array(z.string()).default([]),
    probe: z.object({
      ttft_ms: z.number().default(-1),
      tps: z.number().default(-1),
      samples: z.number().default(0),
    }).default({}),
  })).default({}).volatile(),
  /**
   * eval_status（M5-MVP / 计划 §3）：最近一次评测的**运行态**（与 model_eval 的模型摘要分开）。
   * 形状 = { as_of, state, run_id, note }，state ∈ 'running'（已开始、串行调用中）| 'ok'
   * （正常完成，不论分数高低）| 'failed'（判分器哨兵未通过 → 不写分数，只记失败）；空表 = 从未评测。
   * 写入面与 model_eval 同一处；面板只读展示「评测：…」一行。
   */
  eval_status: z.object({
    as_of: z.string().default(''),
    state: z.string().default(''),
    run_id: z.string().default(''),
    note: z.string().default(''),
  }).default({}).volatile(),
})
