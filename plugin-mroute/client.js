/**
 * mroute M3 客户端半（设置面板「模型路由」分区，形态①，方案 03 E.2）。
 *
 * 挂载：settings.section slot 一等公民机制（03 A.1/A.3；dsh-orb order:25 运行中实证）。
 * 数据链路：remote.settings.describe() 读镜像 → 草稿编辑 → remote.settings.mutate(ops, revision)
 * 数组整替写 channels → SETTINGS_CONFLICT 冲突重拉镜像 → 热更广播 settings/document-updated。
 *
 * 与 03 方案的一处偏离（devlog §1 留痕）：client 侧不用 configForms/settingsSchema 薄封装
 * （其精确 client API 在本 build 仅 minified 单行存在、.d.ts 被 asar 剔除、无法按 03 行号核对），
 * 改用其底层 remote.settings / remote.credentials 直连——host 侧契约已逐行核实
 * （dsh-api-settings-controller describe/mutate/replace + credentials describe/set/unset +
 *  SETTINGS_CONFLICT → RemoteError("settings/conflict")，见 devlog §4 证据）。
 *
 * 红线（任务书 §5）：
 * - advisory-only：本面板只编辑注册表数据，无阻断行为；enforce_gate 警示文案默认关语义。
 * - 密钥值不过读线：mroute 注册表无凭据字段（红线：mroute 不读不存密钥），channel 无 keyRef
 *   可侧牌，故本面板不展示 key 侧牌（不臆造 keyRef 映射），密钥仍走 DSH 模型提供商设置页。
 * - theme tokens（--dsw-alias-* / --dsw-static-* / --dsw-radius-*）only；禁 import 宿主 client UI 包；
 *   控件自写，类名 mroute- 前缀；React 来自浏览器模块表（ui-plugin.md L9）。
 * - 降级容错：remote.settings 缺席（旧 build/headless）时 apply 直接返回，不注册不报错（幂等激活）。
 *
 * 测试面：selfcheck/client.test.mjs 经 node:vm 沙箱加载本文件（仿 dsh-orb client-settings
 * section.test.mjs 模式：mock React + mock ctx），覆盖注册/渲染/保存 ops 构造/冲突重拉/降级/locale 键集。
 * exports.__mroute 为纯函数 + locale 词典的只读测试面（非插件契约）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-mroute',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement

    // ── 闭集（镜像 lib/config-schema.js 常量；host 为权威，此处仅供 UI 下拉，漂移风险见 devlog）──
    const CHANNEL_TYPES = ['monthly', 'voucher', 'prepaid']
    const TIERS = ['overseas_sota', 'domestic_sota', 'bulk']
    const MANUAL_STATUSES = ['active', 'disabled', 'exhausted']
    const CAPABILITY_KEYS = ['coding', 'tools', 'long_context', 'vision', 'world_knowledge', 'orchestration']
    const CAPABILITY_RATINGS = ['excellent', 'good', 'fair']
    // 静态层排序镜像（M3.1）：与 lib/ranking.js CHANNEL_TYPE_RANK / TIER_RANK 同值，previewRanking 专用。
    const CHANNEL_TYPE_RANK = { monthly: 0, voucher: 1, prepaid: 2 }
    const TIER_RANK = { overseas_sota: 0, domestic_sota: 1, bulk: 2 }
    const DIMENSION_LABEL_KEYS = { coding: 'dimCoding', tools: 'dimTools', long_context: 'dimLongContext', vision: 'dimVision', world_knowledge: 'dimWorldKnowledge', orchestration: 'dimOrchestration' }
    const RATING_LABEL_KEYS = { excellent: 'ratingExcellent', good: 'ratingGood', fair: 'ratingFair' }
    // dynamic_snapshot.rows[].state 闭集（M4.10；镜像 lib/dynamic-state.js DYNAMIC_STATES，host 为权威）。
    const DYNAMIC_ROW_STATES = ['ok', 'hint', 'tight', 'unknown']

    const NS = 'mroute'
    const SECTION_ID = 'model-route'
    const ORDER = 18 // 落在 models=10 与 orb=25 之间（03 E.2 / 任务书 §3.1）

    // ── locale 词典（zh/en；client UI 文案自包含，<html lang> 探测，仿 dsh-orb client-settings）──
    const zh = {
      nav: '模型路由',
      intro: '编辑渠道注册表与参数。保存后立即生效，model_route_query 与派遣建议随即读取新值；重启后仍在。',
      advisory: '本面板只编辑建议数据，不阻断、不改写、不代决策——最终选择权始终在会话与用户（advisory-only）。',
      loading: '加载中…',
      unavailable: '模型路由插件未启用或本部署无设置面板服务，无法在此编辑。',
      loadError: '无法加载模型路由设置。',
      retry: '重试',
      save: '保存',
      saving: '保存中…',
      saved: '已生效（model_route_query 立即可读）。',
      saveError: '保存失败：',
      conflict: '设置已在别处修改，已刷新为最新值，请确认后重新保存（未覆盖他人修改）。',
      topLevelTitle: '顶层参数',
      thresholdLabel: '低余额阈值（CNY）',
      thresholdHint: 'machine 余额低于此值触发 low_balance 标注（仅 CNY/未知币种参与比较）。',
      windowWeekLabel: '周窗口沉底阈值',
      windowWeekHint: '周窗口已用百分比达到此值时渠道沉底（只改建议顺序，不剔除不阻断），范围 1–100。',
      window5hLabel: '5h 提示阈值',
      window5hHint: '5h 窗口已用百分比达到此值时只加提示、不沉底，范围 1–100。',
      ttlLabel: 'quota 快照缓存 TTL（秒）',
      ttlHint: 'mroute 对 quota 面板快照的去抖缓存时长，范围 5–3600。',
      enforceGateLabel: '阻断语义',
      enforceGateWarning: 'advisory 红线：默认关闭。开启即启用阻断语义，与「不阻断」方向红线冲突，仅在明确需要时谨慎开启。',
      channelTitle: '渠道',
      idLabel: '渠道 id',
      providerLabel: '路由提供方',
      statusLabel: '手动状态',
      statusActive: 'active（正常登记）',
      statusDisabled: 'disabled（人工停用）',
      statusExhausted: 'exhausted（额度耗尽挂起）',
      statusShortActive: '正常',
      statusShortDisabled: '停用',
      statusShortExhausted: '耗尽',
      channelTypeLabel: '渠道类型',
      channelTypeMonthly: 'monthly（包月）',
      channelTypeVoucher: 'voucher（券）',
      channelTypePrepaid: 'prepaid（预充值）',
      channelTypeShortMonthly: '包月',
      channelTypeShortVoucher: '券',
      channelTypeShortPrepaid: '预充值',
      tierLabel: '能力档位',
      tierOverseas: 'overseas_sota（海外 SOTA）',
      tierDomestic: 'domestic_sota（国内 SOTA）',
      tierBulk: 'bulk（跑量）',
      tierShortOverseas: '海外 SOTA',
      tierShortDomestic: '国内 SOTA',
      tierShortBulk: '跑量',
      priorityLabel: '优先级（0–100）',
      priorityInvalid: 'priority 须为 0–100 的整数。',
      quotaPlatformLabel: '余额平台',
      quotaPlatformHint: 'quota 面板平台 id；留空 = 不接 machine 机读余额通道。',
      verifiedLabel: '账户已核实',
      verifiedOn: '已核实',
      verifiedOff: '待核实',
      verifiedHintZai: '2026-11-20 用户确认额度卡与渠道账户同源（智谱 Coding Plan 卡 = 该渠道用量），已核实。',
      verifiedHintOpencode: '2026-11-20 用户确认额度卡与渠道账户同源（opencode-go 用量窗口 = 该渠道），已核实。',
      verifiedHintDeepseek: '2026-11-15 用户澄清 DeepSeek 只有一个源（quota 卡 = 路由同源同 key）。',
      verifiedHintXiaomi: 'xiaomi 平台 id 与 DSH provider id 对齐，且 quota_refresh 实测背书。',
      verifiedHintGeneric: '仅当渠道账户与 quota 平台卡确为同一账户时才开启；拿错账号余额比不显示更糟。',
      modelsLabel: '模型列表',
      modelsHint: '每行一个模型 id；留空 = 未登记（待首轮复核）。',
      modelsEmptyHint: 'models[] 为空——可由宿主工具 model_route_sync_models 从 DSH 目录同步。',
      previewTitle: '建议顺序（静态层）',
      previewHint: '静态层排序：不含 provider 活校验、余额与 disabled/low_balance 告警；完整链路以 host 工具 model_route_query 为准。',
      previewEmpty: '无渠道',
      previewNeedHint: '能力需求匹配在 host 工具侧：调用 model_route_query 时传 need={coding|tools|long_context|vision: fair|good|excellent}，得到匹配模型与推荐落点；只作建议，不改渠道排序。',
      previewDispatchHint: '派遣子会话前先跑 mroute_dispatch_plan（派发预检）：返回可直接粘贴的 assignee 清单与余额/新鲜度，与 model_route_query 同源排序。',
      modelCapabilityLabel: '每模型能力档位',
      modelCapabilityHint: '只作建议标注，不参与排序；未登记 = 无数据。',
      modelCapabilityEmpty: '模型列表为空——先登记模型，再填能力档位。',
      modelRatingLabel: '统一模型名能力档位',
      modelRatingHint: '按统一模型名登记（跨渠道同一模型只填一次）；「无」= 明确不具备该能力，与「未登记」不同。只作建议标注，不参与排序。',
      modelCapabilityChip: '档位',
      dynamicTitle: '动态层（最近一次查询）',
      dynamicHint: '面板无法直连宿主，这里显示最近一次 model_route_query 写回的动态快照：全部渠道的当前读数（窗口百分比 / 金额余额）与沉底、提示原因。快照只读，保存不会修改它。',
      dynamicEmpty: '尚未收到任何查询快照：在会话里执行一次 model_route_query 后回到本页。',
      dynamicSunk: '沉底',
      dynamicHinted: '提示',
      dynamicNormalCount: '正常',
      dynamicOk: '正常',
      dynamicUnknown: '未知',
      dynamicLowBalance: '低余额',
      dynamicAsOf: '快照时间',
      modelUnlisted: '未在模型列表中',
      dimCoding: '编码',
      dimTools: '工具调用',
      dimLongContext: '长上下文',
      dimVision: '视觉',
      dimWorldKnowledge: '世界知识',
      dimOrchestration: '策划调度',
      ratingUnregistered: '未登记',
      ratingExcellent: '优秀',
      ratingGood: '良好',
      ratingFair: '一般',
      ratingNone: '无',
      fallbacksLabel: '备选渠道',
      fallbacksHint: '每行一个备选渠道 id（引用表中其它渠道）。',
      quotaTotalLabel: '总额度',
      quotaUsedLabel: '已用量估算',
      noteLabel: '备注',
      reviewedAtLabel: '复核时间',
      readOnly: '（只读）',
      aliasTitle: '模型归并',
      aliasHint: '同一模型跨渠道时归并到规范名。只有同 id 跨渠道可自动并（host 工具 model_route_alias_suggest 写自反映射）；不同 id 需人工改成同一规范名——本面板不猜同一性。只影响模型视图，不改排序、不阻断。',
      aliasCanonicalLabel: '规范名',
      aliasMergedTitle: '已归并（多渠道 / 已登记映射）',
      aliasUnmergedTitle: '未归并（单渠道）',
      aliasEmpty: '尚无模型登记——先在渠道卡编辑 models[]。',
      aliasMemberHint: '行内为「渠道 → 渠道模型 id」；失焦写入表单，点保存落盘。清空 = 取消该组归并。',
      aliasManualHint: '把两个不同 id 改成同一个规范名即可人工归并（工具不会自动猜同一性）。',
      aliasGroupChip: '归并组',
    }
    const en = {
      nav: 'Model routing',
      intro: 'Edit the channel registry and parameters. Changes apply immediately — model_route_query reads the new values right away and they persist across restarts.',
      advisory: 'This panel only edits advisory data. Nothing here blocks, rewrites, or decides for you — the final choice always stays with the session and the user (advisory-only).',
      loading: 'Loading…',
      unavailable: 'The model-route plugin is not active, or this deployment has no settings panel service to edit it here.',
      loadError: 'Could not load model-route settings.',
      retry: 'Retry',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Applied — model_route_query reads it immediately.',
      saveError: 'Save failed: ',
      conflict: 'Settings changed elsewhere and were reloaded. Review the latest values and save again (other changes were not overwritten).',
      topLevelTitle: 'Top-level parameters',
      thresholdLabel: 'Low-balance threshold (CNY)',
      thresholdHint: 'A machine balance below this triggers the low_balance note (CNY/unknown currencies only).',
      windowWeekLabel: 'Weekly window sink threshold',
      windowWeekHint: 'A weekly window usage at or above this sinks the channel (order only, never excluded or blocked), range 1–100.',
      window5hLabel: '5h hint threshold',
      window5hHint: 'A 5h window usage at or above this adds a hint only (no sinking), range 1–100.',
      ttlLabel: 'Quota snapshot cache TTL (seconds)',
      ttlHint: 'Debounce cache for the quota panel snapshot, range 5–3600.',
      enforceGateLabel: 'enforce_gate',
      enforceGateWarning: 'Advisory red line: off by default. Turning it on enables blocking semantics, which conflicts with the no-blocking direction — enable only when explicitly needed.',
      channelTitle: 'Channel',
      idLabel: 'Channel id',
      providerLabel: 'routeProvider',
      statusLabel: 'manual.status',
      statusActive: 'active (registered)',
      statusDisabled: 'disabled (manually stopped)',
      statusExhausted: 'exhausted (quota suspended)',
      statusShortActive: 'active',
      statusShortDisabled: 'disabled',
      statusShortExhausted: 'exhausted',
      channelTypeLabel: 'channel_type',
      channelTypeMonthly: 'monthly',
      channelTypeVoucher: 'voucher',
      channelTypePrepaid: 'prepaid',
      channelTypeShortMonthly: 'monthly',
      channelTypeShortVoucher: 'voucher',
      channelTypeShortPrepaid: 'prepaid',
      tierLabel: 'tier',
      tierOverseas: 'overseas_sota',
      tierDomestic: 'domestic_sota',
      tierBulk: 'bulk',
      tierShortOverseas: 'overseas SOTA',
      tierShortDomestic: 'domestic SOTA',
      tierShortBulk: 'bulk',
      priorityLabel: 'priority (0–100)',
      priorityInvalid: 'priority must be an integer between 0 and 100.',
      quotaPlatformLabel: 'quota_platform',
      quotaPlatformHint: 'Quota panel platform id; empty = no machine balance channel.',
      verifiedLabel: 'quota_account_verified',
      verifiedOn: 'verified',
      verifiedOff: 'unverified',
      verifiedHintZai: 'User confirmed on 2026-11-20 that the quota card and channel account share one source (Zhipu Coding Plan card = this channel usage) — verified.',
      verifiedHintOpencode: 'User confirmed on 2026-11-20 that the quota card and channel account share one source (opencode-go usage windows = this channel) — verified.',
      verifiedHintDeepseek: 'User clarified on 2026-11-15 that DeepSeek has one source (quota card = same key as the route).',
      verifiedHintXiaomi: 'xiaomi platform id aligns with the DSH provider id and is backed by quota_refresh testing.',
      verifiedHintGeneric: 'Enable only when the channel account is the same as the quota platform card; a wrong account balance is worse than no balance.',
      modelsLabel: 'models',
      modelsHint: 'One model id per line; empty = unregistered (pending first review).',
      modelsEmptyHint: 'models[] is empty — the host tool model_route_sync_models can sync it from the DSH catalog.',
      previewTitle: 'Suggested order (static layer)',
      previewHint: 'Static-layer ranking: excludes the provider live check, balances, and disabled/low_balance warnings; use the host tool model_route_query for the full chain.',
      previewEmpty: 'No channels',
      previewNeedHint: 'Capability matching lives in the host tool: call model_route_query with need={coding|tools|long_context|vision: fair|good|excellent} to get matching models and suggested picks. Advisory only; channel order is unchanged.',
      previewDispatchHint: 'Before dispatching a subagent, run mroute_dispatch_plan (dispatch preflight): it returns a paste-ready assignee list with balances and freshness, ranked from the same source as model_route_query.',
      modelCapabilityLabel: 'Per-model capability',
      modelCapabilityHint: 'Advisory labels only — they never affect ranking. Unregistered = no data.',
      modelCapabilityEmpty: 'No models yet — register models first, then set capability.',
      modelRatingLabel: 'Canonical-model capability',
      modelRatingHint: 'Rated per canonical model name (fill once per model, not per channel). "none" = the model explicitly lacks that capability, unlike "unregistered" (no data). Advisory only — never affects ranking.',
      modelCapabilityChip: 'caps',
      dynamicTitle: 'Dynamic layer (last query)',
      dynamicHint: 'The panel cannot reach the host directly; this shows the dynamic snapshot written by the last model_route_query: current readings for every channel (window percentages / money balance) plus sunk/hinted reasons. Read-only — saving never touches it.',
      dynamicEmpty: 'No query snapshot yet: run model_route_query once in a session, then come back to this page.',
      dynamicSunk: 'sunk',
      dynamicHinted: 'hinted',
      dynamicNormalCount: 'normal',
      dynamicOk: 'ok',
      dynamicUnknown: 'unknown',
      dynamicLowBalance: 'low balance',
      dynamicAsOf: 'snapshot time',
      modelUnlisted: 'not in models[]',
      dimCoding: 'coding',
      dimTools: 'tools',
      dimLongContext: 'long context',
      dimVision: 'vision',
      dimWorldKnowledge: 'world knowledge',
      dimOrchestration: 'orchestration',
      ratingUnregistered: 'unregistered',
      ratingExcellent: 'excellent',
      ratingGood: 'good',
      ratingFair: 'fair',
      ratingNone: 'none',
      fallbacksLabel: 'fallbacks',
      fallbacksHint: 'One fallback channel id per line (references other channels in the table).',
      quotaTotalLabel: 'manual.quota_total',
      quotaUsedLabel: 'manual.quota_used_est',
      noteLabel: 'manual.note',
      reviewedAtLabel: 'reviewed_at',
      readOnly: ' (read-only)',
      aliasTitle: 'Model aliases',
      aliasHint: 'Merge the same model across channels under one canonical name. Only identical ids are auto-merged (the host tool model_route_alias_suggest writes identity mappings); different ids need a manual canonical edit — this panel never guesses. View-only: no ranking change, no blocking.',
      aliasCanonicalLabel: 'canonical name',
      aliasMergedTitle: 'Merged (multi-channel / explicit mapping)',
      aliasUnmergedTitle: 'Unmerged (single channel)',
      aliasEmpty: 'No models registered yet — edit models[] in the channel cards first.',
      aliasMemberHint: 'Each line reads "channel → channel model id"; blur writes to the form, Save persists. Clear to drop the merge.',
      aliasManualHint: 'Set two different ids to the same canonical name to merge them manually (the tool never guesses).',
      aliasGroupChip: 'groups',
    }

    /** 主窗口 <html lang> + navigator.language 探测（仿 dsh-orb client-settings；无 locale 服务依赖）。 */
    function copy() {
      const lang = `${document.documentElement?.lang || ''}${navigator.language || ''}`
      return lang.toLowerCase().startsWith('zh') ? zh : en
    }

    /**
     * 字段名双语标签（2026-11-16 用户要求：所有要素字段名中英都有）。
     * 顺序随当前界面语言：中文界面「中文 · English」，英文界面「English · 中文」。
     * 两语言同文（如 models / tier 这类技术键）时只显示一次，避免重复。
     */
    function bi(key) {
      const a = zh[key]
      const b = en[key]
      if (a === undefined || a === null || a === '') return b === undefined ? key : b
      if (b === undefined || b === null || b === '' || b === a) return a
      return copy() === zh ? `${a} · ${b}` : `${b} · ${a}`
    }

    function toNumber(value, fallback) {
      const n = Number(value)
      return Number.isFinite(n) ? n : fallback
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /**
     * 远端调用信封解包（桌面端实测：`dsh-app://app` 下 `settings.describe()` 解析出 `{ok, value}`）。
     * ok === false → 抛带 code/name 的 Error（保留 conflict 分类）；非信封形态原样返回（向前兼容）。
     */
    function unwrapResult(response) {
      if (response && typeof response === 'object' && 'ok' in response) {
        if (response.ok === false) {
          const detail = response.error && typeof response.error === 'object' ? response.error : {}
          const error = new Error(typeof detail.message === 'string' ? detail.message : String(response.error))
          if (typeof detail.code === 'string') error.code = detail.code
          if (typeof detail.name === 'string') error.name = detail.name
          throw error
        }
        return response.value
      }
      return response
    }

    /** SETTINGS_CONFLICT / RemoteError("settings/conflict") 分类（devlog §4 证据）。 */
    function isConflictError(error) {
      if (error && error.code === 'settings/conflict') return true
      if (error && error.name === 'SettingsConflictError') return true
      return false
    }

    // ── 纯函数（selfcheck 直测；见 exports.__mroute）──

    /**
     * 读侧归一化每模型能力档位（M3.1）：只保留对象行的闭集评级键；非对象行丢弃。
     * model 允许空串存在，交给 validateChannel 报错（阻止保存），避免静默吞掉用户半成品。
     */
    function normalizeModelCapability(raw) {
      const rows = Array.isArray(raw) ? raw : []
      return rows
        .filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
        .map((row) => {
          const entry = { model: typeof row.model === 'string' ? row.model : '' }
          for (const key of CAPABILITY_KEYS) {
            if (CAPABILITY_RATINGS.includes(row[key])) entry[key] = row[key]
          }
          return entry
        })
    }

    /**
     * 读侧归一化归并映射（M4.6）：{渠道 id: {渠道模型 id: 规范名}}；丢弃非对象/空键/空规范名。
     * 与 host registry.aliasTableOf 同口径（client 不 import host 代码，闭集镜像纪律）。
     */
    function normalizeAliases(raw) {
      const out = {}
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
      for (const [channelId, models] of Object.entries(raw)) {
        if (typeof channelId !== 'string' || channelId === '') continue
        if (models === null || typeof models !== 'object' || Array.isArray(models)) continue
        const row = {}
        for (const [model, canonical] of Object.entries(models)) {
          if (typeof model !== 'string' || model === '') continue
          if (typeof canonical !== 'string') continue
          const name = canonical.trim()
          if (name === '') continue
          row[model] = name
        }
        if (Object.keys(row).length > 0) out[channelId] = row
      }
      return out
    }

    /**
     * 读侧归一化「统一模型名能力表」（M4.7）：{规范名: {维度: 评级}}。
     * 评级闭集 = 三档 + 'none'（明确无此能力，如无视觉）；非闭集值丢弃，空行丢弃。
     */
    function normalizeRatings(raw) {
      const out = {}
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
      for (const [name, row] of Object.entries(raw)) {
        if (typeof name !== 'string') continue
        const key = name.trim()
        if (key === '') continue
        if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
        const entry = {}
        for (const dimension of CAPABILITY_KEYS) {
          const value = row[dimension]
          if (value === 'none' || CAPABILITY_RATINGS.includes(value)) entry[dimension] = value
        }
        if (Object.keys(entry).length > 0) out[key] = entry
      }
      return out
    }

    /**
     * 归并分组（M4.6 面板纯函数）：按生效规范名聚合「渠道 × 渠道模型 id」。
     * merged = 任一成员有显式映射；crossChannel = 成员跨 ≥2 渠道；
     * 面板据此分「已归并（crossChannel||merged）」与「未归并（单渠道无映射）」两段。
     */
    function aliasGroups(channels, aliases) {
      const table = normalizeAliases(aliases)
      const map = new Map()
      for (const channel of Array.isArray(channels) ? channels : []) {
        const channelId = typeof channel?.id === 'string' ? channel.id : ''
        if (channelId === '') continue
        for (const model of Array.isArray(channel?.models) ? channel.models : []) {
          if (typeof model !== 'string' || model === '') continue
          const row = table[channelId]
          const explicit = row !== undefined && Object.prototype.hasOwnProperty.call(row, model)
          const canonical = explicit ? row[model] : model
          const group = map.get(canonical) ?? { canonical, members: [], merged: false }
          group.members.push({ channel: channelId, model, explicit })
          group.merged = group.merged || explicit
          map.set(canonical, group)
        }
      }
      return [...map.values()].map((group) => ({
        canonical: group.canonical,
        merged: group.merged,
        members: group.members.slice().sort((a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1
          : a.model < b.model ? -1 : a.model > b.model ? 1 : 0)),
        crossChannel: new Set(group.members.map((member) => member.channel)).size > 1,
      })).sort((a, b) => b.members.length - a.members.length
        || (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0))
    }

    /** 读侧归一化：填缺省、过滤 capability 到合法键、保留只读字段。 */
    function normalizeChannel(raw) {
      const src = raw && typeof raw === 'object' ? raw : {}
      const manual = src.manual && typeof src.manual === 'object' ? src.manual : {}
      const capability = CAPABILITY_KEYS.reduce((acc, key) => {
        const v = src.capability && typeof src.capability === 'object' ? src.capability[key] : undefined
        if (CAPABILITY_RATINGS.includes(v)) acc[key] = v
        return acc
      }, {})
      return {
        id: typeof src.id === 'string' ? src.id : '',
        routeProvider: typeof src.routeProvider === 'string' ? src.routeProvider : '',
        models: Array.isArray(src.models) ? src.models.map(String) : [],
        channel_type: CHANNEL_TYPES.includes(src.channel_type) ? src.channel_type : 'prepaid',
        tier: TIERS.includes(src.tier) ? src.tier : 'domestic_sota',
        priority: Number.isFinite(Number(src.priority)) ? Number(src.priority) : 50,
        fallbacks: Array.isArray(src.fallbacks) ? src.fallbacks.map(String) : [],
        capability,
        model_capability: normalizeModelCapability(src.model_capability),
        manual: {
          status: MANUAL_STATUSES.includes(manual.status) ? manual.status : 'active',
          quota_total: typeof manual.quota_total === 'string' ? manual.quota_total : '—',
          quota_used_est: typeof manual.quota_used_est === 'string' ? manual.quota_used_est : '—',
          note: typeof manual.note === 'string' ? manual.note : '',
        },
        quota_platform: typeof src.quota_platform === 'string' ? src.quota_platform : '',
        quota_account_verified: src.quota_account_verified === true,
        reviewed_at: typeof src.reviewed_at === 'string' ? src.reviewed_at : '',
      }
    }

    /** 单条渠道草稿校验（客户端第一道；host 写面为权威）。返回错误文案数组。 */
    function validateChannel(channel) {
      const errors = []
      if (typeof channel.id !== 'string' || channel.id.trim() === '') errors.push('id 不可为空')
      if (typeof channel.routeProvider !== 'string' || channel.routeProvider.trim() === '') errors.push('routeProvider 不可为空')
      if (!CHANNEL_TYPES.includes(channel.channel_type)) errors.push('channel_type 非法')
      if (!TIERS.includes(channel.tier)) errors.push('tier 非法')
      const p = Number(channel.priority)
      if (!Number.isInteger(p) || p < 0 || p > 100) errors.push('priority 须为 0–100 的整数')
      if (!MANUAL_STATUSES.includes(channel.manual?.status)) errors.push('manual.status 非法')
      const badStrings = (list) => !Array.isArray(list) || list.some((item) => typeof item !== 'string' || item.trim() === '')
      if (badStrings(channel.models)) errors.push('models 须为字符串数组（每项非空）')
      if (badStrings(channel.fallbacks)) errors.push('fallbacks 须为字符串数组（每项非空）')
      // model_capability（M3.1）：model 非空 + 同渠道内不重复（重复会令读侧静默去重，保存前先拦）
      if (!Array.isArray(channel.model_capability)) {
        errors.push('model_capability 须为数组')
      } else {
        const seenModels = new Set()
        for (const row of channel.model_capability) {
          const model = typeof row?.model === 'string' ? row.model.trim() : ''
          if (model === '') { errors.push('model_capability 的 model 不可为空'); break }
          if (seenModels.has(model)) { errors.push(`model_capability 模型 "${model}" 重复`); break }
          seenModels.add(model)
        }
      }
      return errors
    }

    /** 顶层参数校验。返回错误文案数组。 */
    function validateTopLevel(form) {
      const errors = []
      const threshold = Number(form.low_balance_threshold_cny)
      if (!Number.isFinite(threshold) || threshold < 0) errors.push('低余额阈值须为非负数')
      const weekTight = Number(form.window_week_tight_pct)
      if (!Number.isInteger(weekTight) || weekTight < 1 || weekTight > 100) errors.push('周窗口沉底阈值须为 1–100 的整数')
      const h5Hint = Number(form.window_5h_hint_pct)
      if (!Number.isInteger(h5Hint) || h5Hint < 1 || h5Hint > 100) errors.push('5h 提示阈值须为 1–100 的整数')
      const ttl = Number(form.quota_cache_ttl_seconds)
      if (!Number.isInteger(ttl) || ttl < 5 || ttl > 3600) errors.push('TTL 须为 5–3600 的整数')
      return errors
    }

    /** 归一化渠道 → 整条 plain（数组整替写入；空 capability / 空 model_capability 省略以对齐种子形状）。 */
    function channelToPlain(channel) {
      const capabilityRows = Array.isArray(channel.model_capability)
        ? channel.model_capability
          .map((row) => {
            const entry = { model: row.model }
            for (const key of CAPABILITY_KEYS) {
              if (CAPABILITY_RATINGS.includes(row[key])) entry[key] = row[key]
            }
            return entry
          })
          .filter((row) => typeof row.model === 'string' && row.model !== '' && Object.keys(row).length > 1)
        : []
      const out = {
        id: channel.id,
        routeProvider: channel.routeProvider,
        models: channel.models,
        channel_type: channel.channel_type,
        tier: channel.tier,
        priority: channel.priority,
        fallbacks: channel.fallbacks,
        manual: {
          status: channel.manual.status,
          quota_total: channel.manual.quota_total,
          quota_used_est: channel.manual.quota_used_est,
          note: channel.manual.note,
        },
        quota_platform: channel.quota_platform,
        quota_account_verified: channel.quota_account_verified,
        reviewed_at: channel.reviewed_at,
      }
      if (Object.keys(channel.capability).length > 0) out.capability = channel.capability
      if (capabilityRows.length > 0) out.model_capability = capabilityRows
      return out
    }

    /** 保存 ops：channels 数组整替 + 六个顶层 volatile 参数各一条 set + model_aliases 整替（不触碰 registry_version、reviewed 锚字段与 eval 占位）。 */
    function buildSaveOps(form) {
      return [
        { op: 'set', path: ['channels'], value: form.channels.map(channelToPlain) },
        { op: 'set', path: ['low_balance_threshold_cny'], value: form.low_balance_threshold_cny },
        { op: 'set', path: ['window_week_tight_pct'], value: form.window_week_tight_pct },
        { op: 'set', path: ['window_5h_hint_pct'], value: form.window_5h_hint_pct },
        { op: 'set', path: ['quota_cache_ttl_seconds'], value: form.quota_cache_ttl_seconds },
        { op: 'set', path: ['enforce_gate'], value: form.enforce_gate === true },
        { op: 'set', path: ['model_aliases'], value: normalizeAliases(form.model_aliases) },
        { op: 'set', path: ['model_ratings'], value: normalizeRatings(form.model_ratings) },
      ]
    }

    /** 枚举查表镜像（hasOwnProperty 防原型链键，与 lib/ranking.js rankOf 同口径）。 */
    function rankOf(table, value) {
      return Object.prototype.hasOwnProperty.call(table, value) ? table[value] : 9
    }

    /**
     * 静态层建议顺序（client 纯函数预览，M3.1 / 任务书 §3.1）：
     * 比较器与 lib/ranking.js rankChannels 同序（忽略 provider 活校验——预览不发 llm 请求，
     * unknown 恒 0）：channel_type → tier → priority 降序 → id 字典序。
     * 只读：不保存、不改写任何表单值；返回 [{ rank, channel, reason }]。
     */
    function previewRanking(channels) {
      const entries = (Array.isArray(channels) ? channels : []).map((channel, index) => ({ channel, index }))
      const keyOf = (channel) => ({
        channelType: rankOf(CHANNEL_TYPE_RANK, channel.channel_type),
        tier: rankOf(TIER_RANK, channel.tier),
        priority: -(Number(channel.priority) || 0),
        id: String(channel.id ?? ''),
      })
      entries.sort((a, b) => {
        const ka = keyOf(a.channel)
        const kb = keyOf(b.channel)
        return (
          ka.channelType - kb.channelType ||
          ka.tier - kb.tier ||
          ka.priority - kb.priority ||
          (ka.id < kb.id ? -1 : ka.id > kb.id ? 1 : 0) ||
          a.index - b.index
        )
      })
      return entries.map((entry, index) => {
        const channel = entry.channel
        const typeText = channel.channel_type === 'monthly' ? '包月优先' : channel.channel_type === 'voucher' ? '券次优' : '预充值兜底'
        const reason = [
          `channel_type=${channel.channel_type}（一级键 ${typeText}）`,
          `tier=${channel.tier}`,
          `priority=${channel.priority}（同类内降序生效）`,
          'id 兜底',
        ].join('；')
        return { rank: index + 1, channel, reason }
      })
    }

    /** describe 镜像 → 可编辑 form。 */
    function formFromView(view) {
      const value = view && typeof view.value === 'object' ? view.value : {}
      return {
        channels: Array.isArray(value.channels) ? value.channels.map(normalizeChannel) : [],
        low_balance_threshold_cny: toNumber(value.low_balance_threshold_cny, 10),
        window_week_tight_pct: toNumber(value.window_week_tight_pct, 98),
        window_5h_hint_pct: toNumber(value.window_5h_hint_pct, 95),
        quota_cache_ttl_seconds: toNumber(value.quota_cache_ttl_seconds, 60),
        enforce_gate: value.enforce_gate === true,
        model_aliases: normalizeAliases(value.model_aliases),
        model_ratings: normalizeRatings(value.model_ratings),
        // dynamic_snapshot（M4.9）：只读镜像——formFromView 读入，buildSaveOps 不含该字段。
        dynamic_snapshot: normalizeDynamicSnapshot(value.dynamic_snapshot),
      }
    }

    /** dynamic_snapshot 轻校验（只读镜像，M4.9/M4.10）：字段缺失回缺省，坏形状回空快照不抛。 */
    function normalizeDynamicSnapshot(raw) {
      const snap = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      const rows = Array.isArray(snap.rows) ? snap.rows : []
      const out = []
      for (const row of rows) {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id) continue
        out.push({
          id: row.id,
          // 四值（M4.10）：ok/hint/tight/unknown 之外一律按 ok（host 侧 DYNAMIC_STATES 同口径）。
          state: DYNAMIC_ROW_STATES.includes(row.state) ? row.state : 'ok',
          reason: typeof row.reason === 'string' ? row.reason : '',
          windows: typeof row.windows === 'string' ? row.windows : '',
          worst_used_pct: typeof row.worst_used_pct === 'number' && Number.isFinite(row.worst_used_pct) ? row.worst_used_pct : -1,
          low_balance: row.low_balance === true,
          display: typeof row.display === 'string' ? row.display : '',
        })
      }
      return { as_of: typeof snap.as_of === 'string' ? snap.as_of : '', rows: out }
    }

    /**
     * 动态行 → 渠道卡 chip 描述（M4.9/M4.10）：ok 行/无行 = null（零噪音）。
     * unknown（精度不明，预留态）给中性 `?` 芯片；hint 仍走 idle，原因优先。
     */
    function dynamicChipOf(row, text) {
      if (!row || row.state === 'ok') return null
      if (row.state === 'tight') {
        return { key: 'dynamic', tone: 'warn', label: `⚠ ${row.reason || text.dynamicLowBalance}` }
      }
      if (row.state === 'unknown') {
        return { key: 'dynamic', tone: 'idle', label: `? ${row.reason || text.dynamicUnknown}` }
      }
      return { key: 'dynamic', tone: 'idle', label: row.reason || row.windows || text.dynamicHinted }
    }

    /** 按 id 查动态行（M4.10）：rows 覆盖全部渠道（含 ok 行），非 ok 行才产出 chip。 */
    function dynamicRowById(snapshot, id) {
      const rows = snapshot && Array.isArray(snapshot.rows) ? snapshot.rows : []
      return rows.find((row) => row && row.id === id) || null
    }

    /** verified 开关旁挂依据提示 key（任务书 §4.A.2 依据链）。 */
    function verifiedHintKey(id) {
      if (id === 'zai-coding-cn') return 'verifiedHintZai'
      if (id === 'opencode-go') return 'verifiedHintOpencode'
      if (id === 'deepseek-official' || id === 'deepseek-account') return 'verifiedHintDeepseek'
      if (id === 'xiaomi') return 'verifiedHintXiaomi'
      return 'verifiedHintGeneric'
    }

    // ── 控件（自写，类名 mroute- 前缀；theme tokens only）──

    function Toggle(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: `mroute-switch${props.checked ? ' is-on' : ''}`,
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        disabled: props.disabled,
        onClick: () => { if (!props.disabled) props.onChange(!props.checked) },
      })
    }

    function SelectField(props) {
      return h('label', { className: 'mroute-field' },
        h('span', { className: 'mroute-field-label' }, props.label),
        h('span', { className: 'mroute-select-wrap' },
          h('select', {
            className: 'mroute-input',
            'aria-label': props.label,
            disabled: props.disabled,
            value: props.value,
            onChange: (event) => props.onChange(event.target.value),
          }, props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))),
        props.hint ? h('span', { className: 'mroute-hint' }, props.hint) : null)
    }

    function TextField(props) {
      return h('label', { className: 'mroute-field' },
        h('span', { className: 'mroute-field-label' }, props.label),
        h('input', {
          className: 'mroute-input',
          type: 'text',
          autoComplete: 'off',
          spellCheck: false,
          'aria-label': props.label,
          disabled: props.disabled,
          value: String(props.value ?? ''),
          onChange: (event) => props.onChange(event.target.value),
        }),
        props.hint ? h('span', { className: 'mroute-hint' }, props.hint) : null)
    }

    function NumberField(props) {
      return h('label', { className: 'mroute-field' },
        h('span', { className: 'mroute-field-label' }, props.label),
        h('input', {
          className: 'mroute-input',
          type: 'number',
          'aria-label': props.label,
          disabled: props.disabled,
          value: props.value,
          onChange: (event) => props.onChange(Number(event.target.value)),
        }),
        props.hint ? h('span', { className: 'mroute-hint' }, props.hint) : null)
    }

    /** 数组列表编辑（受控草稿，失焦整替提交）：每行一项；onChange 接收新数组（数组整替语义）。 */
    function ListField(props) {
      const [draft, setDraft] = React.useState(null)
      const committed = Array.isArray(props.value) ? props.value : []
      const committedText = committed.join('\n')
      React.useEffect(() => { setDraft(null) }, [committedText])
      const text = draft === null ? committedText : draft
      return h('label', { className: 'mroute-field mroute-field-wide' },
        h('span', { className: 'mroute-field-label' }, props.label),
        h('textarea', {
          className: 'mroute-input mroute-textarea',
          'aria-label': props.label,
          disabled: props.disabled,
          rows: 3,
          value: text,
          onChange: (event) => setDraft(event.target.value),
          onBlur: (event) => {
            const next = String(event.target.value).split(/\n/).map((line) => line.trim()).filter(Boolean)
            setDraft(null)
            props.onChange(next)
          },
        }),
        props.hint ? h('span', { className: 'mroute-hint' }, props.hint) : null)
    }

    /** tier 标签键（含下划线的闭集值不适用首字母大写拼接，显式映射）。 */
    function tierLabelKey(value) {
      if (value === 'overseas_sota') return 'tierOverseas'
      if (value === 'domestic_sota') return 'tierDomestic'
      return 'tierBulk'
    }

    /** short 键拼接：('status','active') → 'statusActive'；('statusShort','active') → 'statusShortActive'。 */
    function shortKey(prefix, value) {
      return prefix + String(value)[0].toUpperCase() + String(value).slice(1)
    }

    /** tier 短标签键（同上，下划线值显式映射）。 */
    function tierShortKey(value) {
      if (value === 'overseas_sota') return 'tierShortOverseas'
      if (value === 'domestic_sota') return 'tierShortDomestic'
      return 'tierShortBulk'
    }

    /**
     * 统一模型名能力档位编辑（M4.7 / 用户 2026-11-20 裁决）：一行 = 一个**规范名**，
     * 跨渠道同一模型只登记一次，不再逐个渠道设置。评级闭集 = 优秀/良好/一般 + 「无」；
     * 「无」= 明确不具备该能力（如无视觉），与「未登记」不同（未登记 = 无数据，不臆测）。
     */
    function ModelRatingEditor(props) {
      const text = props.text
      const disabled = props.disabled
      const ratings = normalizeRatings(props.ratings)
      const names = []
      for (const group of aliasGroups(props.channels, props.aliases)) {
        if (!names.includes(group.canonical)) names.push(group.canonical)
      }
      for (const name of Object.keys(ratings)) if (!names.includes(name)) names.push(name)
      const options = [
        { value: '', label: text.ratingUnregistered },
        ...CAPABILITY_RATINGS.map((rating) => ({ value: rating, label: bi(RATING_LABEL_KEYS[rating]) })),
        { value: 'none', label: text.ratingNone },
      ]
      const setRating = (name, dimension, value) => {
        const entry = { ...(ratings[name] || {}) }
        if (value === '') delete entry[dimension]
        else entry[dimension] = value
        const next = { ...ratings }
        if (Object.keys(entry).length > 0) next[name] = entry
        else delete next[name]
        props.onChange(next)
      }
      return h('div', { className: 'mroute-modelcaps' },
        h('div', { className: 'mroute-modelcaps-head' },
          h('span', { className: 'mroute-field-label' }, bi('modelRatingLabel')),
          h('span', { className: 'mroute-hint' }, text.modelRatingHint)),
        names.length === 0
          ? h('p', { className: 'mroute-muted' }, text.modelCapabilityEmpty)
          : names.map((name) => {
            const row = ratings[name] || {}
            return h('div', { className: 'mroute-modelcap', key: name },
              h('div', { className: 'mroute-modelcap-head' },
                h('span', { className: 'mroute-modelcap-id' }, name)),
              h('div', { className: 'mroute-grid mroute-modelcap-dims' },
                CAPABILITY_KEYS.map((dimension) => h('div', { key: dimension, className: 'mroute-modelcap-dim' },
                  SelectField({
                    label: bi(DIMENSION_LABEL_KEYS[dimension]),
                    value: row[dimension] === 'none' || CAPABILITY_RATINGS.includes(row[dimension]) ? row[dimension] : '',
                    disabled,
                    options,
                    onChange: (value) => setRating(name, dimension, value),
                  })))))
          }))
    }

    function ChannelCard(props) {
      const text = props.text
      const channel = props.channel
      const disabled = props.disabled
      const [open, setOpen] = React.useState(false) // 用户要求：进入面板时所有渠道卡默认折叠
      const update = (patch) => props.onChange({ ...channel, ...patch })
      const updateManual = (patch) => update({ manual: { ...channel.manual, ...patch } })
      const status = channel.manual.status
      const chip = (key, label, tone) => h('span', { key, className: `mroute-chip${tone ? ' is-' + tone : ''}` }, label)
      // 折叠态要点：状态 / 付费类型 / 能力档位 / 优先级 / 余额平台 / 账户核实
      const summary = [
        chip('status', text[shortKey('statusShort', status)] || status, status === 'active' ? 'ok' : status === 'exhausted' ? 'warn' : 'idle'),
        chip('type', text[shortKey('channelTypeShort', channel.channel_type)] || channel.channel_type),
        chip('tier', text[tierShortKey(channel.tier)] || channel.tier),
        chip('priority', `priority ${channel.priority}`),
        channel.quota_platform ? chip('platform', channel.quota_platform) : null,
        chip('verified', channel.quota_account_verified ? text.verifiedOn : text.verifiedOff, channel.quota_account_verified ? 'ok' : 'idle'),
        // M4.9 动态 chip：tight → ⚠ reason（warn）；hint → reason（idle）；无行/ok = 不渲染（零噪音）。
        dynamicChipOf(props.dynamicRow, text)
          ? chip('dynamic', dynamicChipOf(props.dynamicRow, text).label, dynamicChipOf(props.dynamicRow, text).tone)
          : null,
        Array.isArray(channel.model_capability) && channel.model_capability.length > 0
          ? chip('modelcap', `${text.modelCapabilityChip} ${channel.model_capability.length}`)
          : null,
      ]
      return h('section', { className: `mroute-card${open ? ' is-open' : ''}` },
        h('div', { className: 'mroute-card-head' },
          h('button', {
            type: 'button',
            className: 'mroute-card-toggle',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => setOpen((value) => !value),
          },
            h('span', { className: 'mroute-card-chevron', 'aria-hidden': 'true' }),
            h('span', { className: 'mroute-card-identity' },
              h('span', { className: 'mroute-card-id' }, channel.id || '—'),
              h('span', { className: 'mroute-card-provider' }, `${bi('providerLabel')}: ${channel.routeProvider || '—'}${text.readOnly}`))),
          h('div', { className: 'mroute-card-chips' }, summary)),
        open
          ? h('div', { className: 'mroute-card-body' },
            h('div', { className: 'mroute-grid' },
              SelectField({ label: bi('statusLabel'), value: status, disabled, options: MANUAL_STATUSES.map((value) => ({ value, label: text[shortKey('status', value)] })), onChange: (v) => updateManual({ status: v }) }),
              SelectField({ label: bi('channelTypeLabel'), value: channel.channel_type, disabled, options: CHANNEL_TYPES.map((value) => ({ value, label: text[shortKey('channelType', value)] })), onChange: (v) => update({ channel_type: v }) }),
              SelectField({ label: bi('tierLabel'), value: channel.tier, disabled, options: TIERS.map((value) => ({ value, label: text[tierLabelKey(value)] })), onChange: (v) => update({ tier: v }) }),
              NumberField({ label: bi('priorityLabel'), value: channel.priority, disabled, onChange: (v) => update({ priority: v }) })),
            h('div', { className: 'mroute-grid' },
              TextField({ label: bi('quotaPlatformLabel'), hint: text.quotaPlatformHint, value: channel.quota_platform, disabled, onChange: (v) => update({ quota_platform: v }) }),
              TextField({ label: bi('quotaTotalLabel'), value: channel.manual.quota_total, disabled, onChange: (v) => updateManual({ quota_total: v }) }),
              TextField({ label: bi('quotaUsedLabel'), value: channel.manual.quota_used_est, disabled, onChange: (v) => updateManual({ quota_used_est: v }) })),
            TextField({ label: bi('noteLabel'), value: channel.manual.note, disabled, onChange: (v) => updateManual({ note: v }) }),
            h(ListField, { label: bi('modelsLabel'), hint: text.modelsHint, value: channel.models, disabled, onChange: (v) => update({ models: v }) }),
            Array.isArray(channel.models) && channel.models.length === 0
              ? h('p', { className: 'mroute-hint mroute-models-empty' }, text.modelsEmptyHint)
              : null,
            h(ListField, { label: bi('fallbacksLabel'), hint: text.fallbacksHint, value: channel.fallbacks, disabled, onChange: (v) => update({ fallbacks: v }) }),
            h('div', { className: 'mroute-verified-row' },
              h('span', { className: 'mroute-field-label' }, bi('verifiedLabel')),
              h(Toggle, { checked: channel.quota_account_verified, label: bi('verifiedLabel'), disabled, onChange: (v) => update({ quota_account_verified: v }) }),
              h('span', { className: 'mroute-hint mroute-verified-hint' }, text[verifiedHintKey(channel.id)])),
            channel.reviewed_at ? h('p', { className: 'mroute-muted' }, `${bi('reviewedAtLabel')}: ${channel.reviewed_at}`) : null)
          : null)
    }

    /**
     * 动态层快照卡（M4.9 / M4.10，只读）：最近一次 model_route_query 写回的 dynamic_snapshot。
     * M4.10：只要 as_of 非空就**永远**渲染摘要行（`快照时间 … · 沉底 N · 提示 M · 正常 K`）与
     * 全部渠道行——state 映射 ⚠/·/✓/?，行尾读数优先 windows 否则 display（都空则不带）。
     * 旧实现按 rows.length 判空：rows 只存非 ok 行，于是「刚查过且全部正常」与「从没查过」
     * 在界面上完全一致，且各渠道窗口%/余额读数根本看不到（用户实测缺陷，M4.10 修）。
     * 只读镜像：不进保存链。
     */
    function DynamicCard(props) {
      const text = props.text
      const snap = props.snapshot || { as_of: '', rows: [] }
      const rows = Array.isArray(snap.rows) ? snap.rows : []
      const tightCount = rows.filter((row) => row.state === 'tight').length
      const hintCount = rows.filter((row) => row.state === 'hint').length
      const okCount = rows.filter((row) => row.state === 'ok').length
      const hasSnapshot = typeof snap.as_of === 'string' && snap.as_of !== ''
      return h('section', { className: 'mroute-card mroute-dynamic' },
        h('header', { className: 'mroute-card-head' },
          h('div', { className: 'mroute-card-identity' },
            h('h3', { className: 'mroute-card-id' }, bi('dynamicTitle')))),
        h('div', { className: 'mroute-card-body' },
          h('p', { className: 'mroute-hint' }, text.dynamicHint),
          hasSnapshot
            ? h('div', {},
              h('p', { className: 'mroute-dynamic-summary' },
                `${bi('dynamicAsOf')} ${snap.as_of} · ${text.dynamicSunk} ${tightCount} · ${text.dynamicHinted} ${hintCount} · ${text.dynamicNormalCount} ${okCount}`),
              rows.map((row) => {
                const glyph = row.state === 'tight' ? '⚠' : row.state === 'hint' ? '·' : row.state === 'unknown' ? '?' : '✓'
                const reading = row.windows || row.display
                const detail = row.reason || (row.state === 'ok' ? text.dynamicOk : row.state === 'unknown' ? text.dynamicUnknown : '')
                const tail = [detail, reading].filter(Boolean).join(' · ')
                return h('p', { key: row.id, className: 'mroute-dynamic-row' }, `${glyph} ${row.id}${tail ? ` — ${tail}` : ''}`)
              }))
            : h('p', { className: 'mroute-muted' }, text.dynamicEmpty)))
    }

    /**
     * 建议顺序（静态层）只读预览（M3.1 / 任务书 §3.1）：随表单实时重算，不发请求、不落盘。
     * 顶部固定说明「不含活校验/余额/告警，完整链路以 host 工具为准」，避免被误读为最终排序。
     */
    function PreviewCard(props) {
      const text = props.text
      const ranked = previewRanking(props.channels)
      return h('section', { className: 'mroute-card mroute-preview' },
        h('header', { className: 'mroute-card-head' },
          h('div', { className: 'mroute-card-identity' },
            h('h3', { className: 'mroute-card-id' }, bi('previewTitle')))),
        h('div', { className: 'mroute-card-body' },
          h('p', { className: 'mroute-hint' }, text.previewHint),
          h('p', { className: 'mroute-hint mroute-preview-need-hint' }, text.previewNeedHint),
          h('p', { className: 'mroute-hint mroute-preview-need-hint' }, text.previewDispatchHint),
          ranked.length === 0
            ? h('p', { className: 'mroute-muted' }, text.previewEmpty)
            : h('ol', { className: 'mroute-preview-list' }, ranked.map((item) => h('li', {
              key: item.channel.id || item.rank,
              className: 'mroute-preview-row',
            },
              h('span', { className: 'mroute-preview-rank' }, `#${item.rank}`),
              h('span', { className: 'mroute-preview-id' }, item.channel.id || '—'),
              h('span', { className: 'mroute-preview-meta' }, `${item.channel.channel_type} · ${item.channel.tier} · priority ${item.channel.priority}`),
              h('span', { className: 'mroute-preview-reason' }, item.reason))))))
    }

    /** 规范名输入（受控草稿，失焦整替提交；清空 = 取消该组归并）。 */
    function AliasCanonicalField(props) {
      const [draft, setDraft] = React.useState(null)
      React.useEffect(() => { setDraft(null) }, [props.value])
      const text = draft === null ? props.value : draft
      return h('label', { className: 'mroute-field mroute-alias-name' },
        h('span', { className: 'mroute-field-label' }, props.label),
        h('input', {
          className: 'mroute-input',
          type: 'text',
          autoComplete: 'off',
          spellCheck: false,
          'aria-label': props.label,
          disabled: props.disabled,
          value: text,
          onChange: (event) => setDraft(event.target.value),
          onBlur: (event) => {
            const next = String(event.target.value).trim()
            setDraft(null)
            props.onCommit(next)
          },
        }))
    }

    /**
     * 模型归并折叠卡（M4.6 / 07 §4）：按规范名分组显示「渠道 → 渠道模型 id」，规范名可编辑
     * （失焦写入表单，点保存才落盘）；未归并的单渠道模型单列——把它改成目标规范名即可人工归并。
     * 只读展示 + 表单编辑，不猜测同一性、不发请求、不改排序。
     */
    function AliasCard(props) {
      const text = props.text
      const disabled = props.disabled
      const [open, setOpen] = React.useState(false) // 与渠道卡一致：进入面板默认折叠
      const groups = aliasGroups(props.channels, props.aliases)
      const merged = groups.filter((group) => group.crossChannel || group.merged)
      const unmerged = groups.filter((group) => !(group.crossChannel || group.merged))
      const setCanonical = (group, value) => {
        const next = normalizeAliases(props.aliases)
        for (const member of group.members) {
          const row = next[member.channel] ?? {}
          if (value === '' || value === member.model) delete row[member.model]
          else row[member.model] = value
          if (Object.keys(row).length > 0) next[member.channel] = row
          else delete next[member.channel]
        }
        props.onChange(next)
      }
      const groupRow = (group) => h('div', { className: 'mroute-alias-group', key: group.canonical },
        h(AliasCanonicalField, {
          label: bi('aliasCanonicalLabel'),
          value: group.canonical,
          disabled,
          onCommit: (value) => setCanonical(group, value),
        }),
        h('div', { className: 'mroute-alias-members' },
          group.members.map((member) => h('span', {
            className: 'mroute-alias-member',
            key: `${member.channel}|${member.model}`,
          }, `${member.channel} → ${member.model}${member.explicit ? ' *' : ''}`))))
      return h('section', { className: `mroute-card mroute-alias${open ? ' is-open' : ''}` },
        h('header', { className: 'mroute-card-head' },
          h('button', {
            type: 'button',
            className: 'mroute-card-toggle mroute-alias-toggle',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => setOpen((value) => !value),
          },
            h('span', { className: 'mroute-card-chevron', 'aria-hidden': 'true' }),
            h('span', { className: 'mroute-card-identity' },
              h('h3', { className: 'mroute-card-id' }, bi('aliasTitle')))),
          h('div', { className: 'mroute-card-chips' },
            h('span', { className: 'mroute-chip' }, `${text.aliasGroupChip} ${merged.length}`))),
        open
          ? h('div', { className: 'mroute-card-body' },
            h('p', { className: 'mroute-hint' }, text.aliasHint),
            h('p', { className: 'mroute-hint' }, text.aliasMemberHint),
            groups.length === 0
              ? h('p', { className: 'mroute-muted' }, text.aliasEmpty)
              : h('div', { className: 'mroute-alias-sections' },
                h('div', { className: 'mroute-field-label' }, text.aliasMergedTitle),
                merged.length === 0
                  ? h('p', { className: 'mroute-muted' }, text.aliasManualHint)
                  : merged.map(groupRow),
                unmerged.length === 0
                  ? null
                  : h('div', null,
                    h('div', { className: 'mroute-field-label mroute-alias-unmerged-title' }, text.aliasUnmergedTitle),
                    unmerged.map(groupRow))),
            h(ModelRatingEditor, {
              text,
              channels: props.channels,
              aliases: props.aliases,
              ratings: props.ratings,
              disabled,
              onChange: props.onRatingsChange,
            }))
          : null)
    }

    function ModelRouteSection(props) {
      const text = copy()
      const settings = props.settings
      const remote = props.remote

      const [, bumpLocale] = React.useState(0)
      React.useEffect(() => {
        if (typeof MutationObserver !== 'function' || !document.documentElement) return undefined
        const observer = new MutationObserver(() => { bumpLocale((count) => count + 1) })
        observer.observe(document.documentElement, { attributeFilter: ['lang'] })
        return () => { observer.disconnect() }
      }, [])

      const [phase, setPhase] = React.useState('loading')
      const [revision, setRevision] = React.useState(0)
      const [form, setForm] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [error, setError] = React.useState('')
      const [diag, setDiag] = React.useState('')
      const [saveErrors, setSaveErrors] = React.useState([])

      async function load() {
        try {
          const result = unwrapResult(await settings.describe())
          const namespaces = result && Array.isArray(result.namespaces) ? result.namespaces : []
          const nsView = namespaces.find((n) => n.ns === NS)
          if (!nsView) {
            // 极简诊断：本 ns 不在宿主可见名单里时列出名单（只有 ns id，不含任何配置值）。
            setDiag(`namespaces: ${namespaces.map((n) => (n && n.ns !== undefined ? n.ns : '?')).join(', ') || '(none)'}`)
            setPhase('unavailable')
            return
          }
          setForm(formFromView(nsView))
          setRevision(typeof nsView.revision === 'number' ? nsView.revision : 0)
          setPhase('ready')
          setError('')
        } catch (err) {
          setPhase('error')
          setError(messageOf(err))
        }
      }

      React.useEffect(() => {
        let cancelled = false
        const wrapped = async () => { if (!cancelled) await load() }
        void wrapped()
        return () => { cancelled = true }
      }, [])

      // 其它入口（原生配置文档等）改写本 ns → settings/document-updated 广播 → 重拉镜像不覆盖他人修改。
      React.useEffect(() => {
        if (!remote || typeof remote.$on !== 'function') return undefined
        const off = remote.$on('settings/document-updated', (ns) => {
          if (ns !== NS) return
          if (busy) return
          void load()
        })
        return typeof off === 'function' ? off : undefined
      }, [busy])

      function onSave() {
        if (busy || !form) return
        const channelErrors = form.channels.flatMap((channel, index) =>
          validateChannel(channel).map((message) => `#${index + 1} ${channel.id || '?'}: ${message}`))
        const topErrors = validateTopLevel(form)
        const errors = [...channelErrors, ...topErrors]
        if (errors.length > 0) { setSaveErrors(errors); setNotice(''); return }
        setSaveErrors([])
        setBusy(true)
        setNotice('')
        setError('')
        const ops = buildSaveOps(form)
        // 先解包信封再分派：unwrapResult 的抛错必须进错误分支（放在 onFulfilled 里会变成未处理拒绝）。
        settings.mutate(NS, ops, revision).then((raw) => unwrapResult(raw)).then(
          (response) => {
            setForm(formFromView(response))
            setRevision(typeof response.revision === 'number' ? response.revision : revision + 1)
            setBusy(false)
            setNotice(text.saved)
          },
          (err) => {
            setBusy(false)
            if (isConflictError(err)) {
              // 冲突：重拉镜像（含他人修改）覆盖本地草稿，不静默覆盖他人改动。
              void load().then(() => setNotice(text.conflict))
              return
            }
            setError(`${text.saveError}${messageOf(err)}`)
          },
        )
      }

      function updateChannel(index, next) {
        setForm((prev) => {
          const channels = prev.channels.slice()
          channels[index] = next
          return { ...prev, channels }
        })
      }

      if (phase === 'loading') return h('div', { className: 'mroute-set' }, h('p', { className: 'mroute-muted' }, text.loading))
      if (phase === 'unavailable') return h('div', { className: 'mroute-set' },
        h('p', { className: 'mroute-banner', role: 'status' }, text.unavailable),
        diag ? h('p', { className: 'mroute-error', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, diag) : null)
      if (phase === 'error') {
        return h('div', { className: 'mroute-set' },
          h('p', { className: 'mroute-error', role: 'alert' }, `${text.loadError}${error}`),
          h('button', { type: 'button', className: 'mroute-button', onClick: () => { void load() } }, text.retry))
      }
      if (!form) return h('div', { className: 'mroute-set' }, h('p', null, text.nav))

      const disabled = busy
      return h('div', { className: 'mroute-set' },
        h('header', { className: 'mroute-hero' },
          h('div', { className: 'mroute-hero-text' },
            h('h2', { className: 'mroute-title' }, bi('nav')),
            h('p', { className: 'mroute-intro' }, text.intro))),
        h('p', { className: 'mroute-banner', role: 'status' }, text.advisory),
        h(PreviewCard, { text, channels: form.channels }),
        h(DynamicCard, { text, snapshot: form.dynamic_snapshot }),
        h(AliasCard, {
          text,
          channels: form.channels,
          aliases: form.model_aliases,
          ratings: form.model_ratings,
          disabled,
          onChange: (aliases) => setForm((prev) => ({ ...prev, model_aliases: aliases })),
          onRatingsChange: (ratings) => setForm((prev) => ({ ...prev, model_ratings: ratings })),
        }),
        h('fieldset', { className: 'mroute-fields', disabled },
          form.channels.map((channel, index) => h(ChannelCard, {
            key: channel.id || index,
            text,
            channel,
            disabled,
            dynamicRow: dynamicRowById(form.dynamic_snapshot, channel.id),
            onChange: (next) => updateChannel(index, next),
          })),
          h('section', { className: 'mroute-card' },
            h('header', { className: 'mroute-card-head' }, h('div', { className: 'mroute-card-identity' }, h('h3', { className: 'mroute-card-id' }, bi('topLevelTitle')))),
            h('div', { className: 'mroute-card-body' },
              h('div', { className: 'mroute-grid' },
                NumberField({ label: bi('thresholdLabel'), hint: text.thresholdHint, value: form.low_balance_threshold_cny, disabled, onChange: (v) => setForm((prev) => ({ ...prev, low_balance_threshold_cny: v })) }),
                NumberField({ label: bi('windowWeekLabel'), hint: text.windowWeekHint, value: form.window_week_tight_pct, disabled, onChange: (v) => setForm((prev) => ({ ...prev, window_week_tight_pct: v })) }),
                NumberField({ label: bi('window5hLabel'), hint: text.window5hHint, value: form.window_5h_hint_pct, disabled, onChange: (v) => setForm((prev) => ({ ...prev, window_5h_hint_pct: v })) }),
                NumberField({ label: bi('ttlLabel'), hint: text.ttlHint, value: form.quota_cache_ttl_seconds, disabled, onChange: (v) => setForm((prev) => ({ ...prev, quota_cache_ttl_seconds: v })) })),
              h('div', { className: 'mroute-verified-row' },
                h('span', { className: 'mroute-field-label' }, bi('enforceGateLabel')),
                h(Toggle, { checked: form.enforce_gate, label: bi('enforceGateLabel'), disabled, onChange: (v) => setForm((prev) => ({ ...prev, enforce_gate: v })) }),
                h('span', { className: 'mroute-hint mroute-verified-hint' }, text.enforceGateWarning))))),
        saveErrors.length > 0
          ? h('div', { className: 'mroute-error-block', role: 'alert' }, saveErrors.map((message) => h('p', { key: message, className: 'mroute-error' }, message)))
          : null,
        error ? h('p', { className: 'mroute-error', role: 'alert' }, error) : null,
        notice ? h('p', { className: notice === text.saved ? 'mroute-saved' : 'mroute-banner', role: 'status' }, notice) : null,
        h('div', { className: 'mroute-actions' },
          h('button', {
            type: 'button',
            className: 'mroute-button mroute-primary',
            disabled,
            onClick: onSave,
          }, busy ? text.saving : text.save)))
    }

    const style = `
/* mroute settings section — theme tokens only, mroute- prefixed classes */
.mroute-set { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 720px; min-width: 0; box-sizing: border-box; color: inherit; }
.mroute-set p { margin: 0; color: color-mix(in srgb, currentColor 68%, transparent); font-size: 13px; line-height: 1.5; }
.mroute-set h2, .mroute-set h3 { margin: 0; }
.mroute-hero { display: flex; align-items: center; gap: 14px; padding: 2px 0 6px; }
.mroute-title { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.25; }
.mroute-intro { margin: 3px 0 0; font-size: 13px; line-height: 1.5; color: color-mix(in srgb, currentColor 62%, transparent); }
.mroute-fields { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.mroute-fields:disabled { opacity: 0.6; }
.mroute-card { min-width: 0; max-width: 100%; box-sizing: border-box; border: 1px solid color-mix(in srgb, currentColor 9%, transparent); border-radius: 14px; padding: 16px 16px 17px; }
.mroute-card-head { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px 12px; min-width: 0; }
.mroute-card-toggle { flex: 1 1 240px; min-width: 0; display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.mroute-card-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2f6fed); outline-offset: 3px; border-radius: 8px; }
.mroute-card-toggle:hover .mroute-card-id { text-decoration: underline; text-underline-offset: 2px; }
.mroute-card-chevron { flex: none; position: relative; width: 14px; height: 18px; margin-top: 1px; opacity: 0.65; }
.mroute-card-chevron::before { content: ''; position: absolute; left: 4px; top: 5px; width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform 140ms ease; }
.mroute-card.is-open .mroute-card-chevron::before { transform: rotate(45deg); }
.mroute-card-identity { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
.mroute-card-id { font-size: 15px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.mroute-card-provider { display: block; margin-top: 2px; font-size: 12.5px; line-height: 1.45; color: color-mix(in srgb, currentColor 62%, transparent); overflow-wrap: anywhere; }
.mroute-card-chips { flex: 0 1 auto; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; }
.mroute-chip { display: inline-flex; align-items: center; white-space: nowrap; padding: 1px 8px; border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 14%, transparent); background: color-mix(in srgb, currentColor 4%, transparent); font-size: 11.5px; line-height: 1.7; }
.mroute-chip.is-ok { color: var(--dsw-alias-state-success-primary, #12b76a); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #12b76a) 38%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #12b76a) 10%, transparent); }
.mroute-chip.is-warn { color: var(--dsw-alias-state-warn-primary, #f79009); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f79009) 38%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f79009) 10%, transparent); }
.mroute-chip.is-idle { color: color-mix(in srgb, currentColor 55%, transparent); }
.mroute-card-body { margin-top: 14px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.mroute-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px 16px; align-items: start; min-width: 0; }
.mroute-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 12px; }
.mroute-field-wide { grid-column: 1 / -1; }
.mroute-field-label { font-size: 12.5px; font-weight: 500; line-height: 1.4; color: color-mix(in srgb, currentColor 84%, transparent); }
.mroute-input {
  box-sizing: border-box; width: 100%; min-width: 0;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 9px;
  background: color-mix(in srgb, currentColor 2.5%, transparent); color: inherit;
  font: inherit; font-size: 12.5px; line-height: 1.45; padding: 7px 10px;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.mroute-input:focus { outline: none; border-color: var(--dsw-alias-button-info-fill, #2f6fed); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-button-info-fill, #2f6fed) 15%, transparent); }
.mroute-select-wrap { position: relative; display: block; min-width: 0; }
.mroute-select-wrap::after {
  content: ''; position: absolute; right: 13px; top: 50%; width: 6px; height: 6px;
  border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
  transform: translateY(-70%) rotate(45deg); opacity: 0.5; pointer-events: none;
}
.mroute-select-wrap select.mroute-input { appearance: none; -webkit-appearance: none; padding-right: 30px; cursor: pointer; }
/* 原生下拉弹层在桌面端（dsh-app）会被系统按亮底绘制，而 option 文本继承深色主题的浅色文字 → 亮底浅字不可读。
   显式给 select 与 option 上不透明底/前景色（theme tokens），两种主题下都可读。 */
.mroute-select-wrap select.mroute-input { background-color: var(--dsw-alias-bg-overlay, rgba(127, 127, 127, 0.08)); }
.mroute-select-wrap option { background-color: var(--dsw-alias-bg-overlay, #ffffff); color: var(--dsw-alias-label-primary, #1f2329); }
.mroute-textarea { min-height: 56px; resize: vertical; }
.mroute-hint { font-size: 11px; line-height: 1.5; color: color-mix(in srgb, currentColor 56%, transparent); }
.mroute-verified-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; min-width: 0; }
.mroute-verified-hint { flex: 1; min-width: 0; margin-top: 1px; }
.mroute-muted { color: color-mix(in srgb, currentColor 58%, transparent); font-size: 12px; }
/* M4.10 动态层：摘要行与逐渠道行（读数用等宽数字，长原因可换行；无新主题 token） */
.mroute-dynamic-summary { font-variant-numeric: tabular-nums; font-size: 12.5px; line-height: 1.5; color: color-mix(in srgb, currentColor 80%, transparent); overflow-wrap: anywhere; }
.mroute-dynamic-row { font-variant-numeric: tabular-nums; font-size: 12px; line-height: 1.5; color: color-mix(in srgb, currentColor 66%, transparent); overflow-wrap: anywhere; }
/* M3.1 静态层建议顺序（只读预览；不含活校验/余额/告警） */
.mroute-preview .mroute-card-body { gap: 8px; }
.mroute-preview-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0; }
.mroute-preview-row { display: grid; grid-template-columns: auto auto 1fr; gap: 2px 10px; align-items: baseline; padding: 7px 0; border-top: 1px solid color-mix(in srgb, currentColor 7%, transparent); min-width: 0; }
.mroute-preview-row:first-child { border-top: 0; padding-top: 0; }
.mroute-preview-rank { font-variant-numeric: tabular-nums; font-weight: 600; font-size: 12.5px; }
.mroute-preview-id { font-weight: 600; font-size: 12.5px; overflow-wrap: anywhere; }
.mroute-preview-meta { font-size: 11.5px; color: color-mix(in srgb, currentColor 60%, transparent); overflow-wrap: anywhere; }
.mroute-preview-reason { grid-column: 1 / -1; font-size: 11px; line-height: 1.45; color: color-mix(in srgb, currentColor 56%, transparent); overflow-wrap: anywhere; }
/* M3.1 每模型能力档位（advisory 标注，不参与排序） */
.mroute-modelcaps { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.mroute-modelcaps-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.mroute-modelcap { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 1px solid color-mix(in srgb, currentColor 8%, transparent); border-radius: 10px; min-width: 0; }
.mroute-modelcap-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.mroute-modelcap-id { font-size: 12.5px; font-weight: 600; overflow-wrap: anywhere; }
.mroute-modelcap-warn { font-size: 11px; color: var(--dsw-alias-state-warn-primary, #f79009); }
.mroute-modelcap-dims { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px 10px; }
/* M4.6 模型归并卡（折叠；规范名可编辑，未归并单列） */
.mroute-alias .mroute-card-body { gap: 10px; }
.mroute-alias-sections { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.mroute-alias-group { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 6px 12px; padding: 8px 10px; border: 1px solid color-mix(in srgb, currentColor 8%, transparent); border-radius: 10px; min-width: 0; }
.mroute-alias-name { flex: 1 1 180px; min-width: 0; }
.mroute-alias-members { flex: 1 1 220px; display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 11.5px; line-height: 1.45; color: color-mix(in srgb, currentColor 62%, transparent); }
.mroute-alias-member { overflow-wrap: anywhere; }
.mroute-alias-unmerged-title { margin-top: 2px; }
.mroute-banner { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border: 1px solid color-mix(in srgb, currentColor 10%, transparent); border-radius: 10px; background: color-mix(in srgb, currentColor 2.5%, transparent); font-size: 12.5px; }
.mroute-error { color: var(--dsw-alias-state-error-primary, #d92d20); }
.mroute-error-block { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d92d20) 40%, transparent); border-radius: 10px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d92d20) 8%, transparent); }
.mroute-saved { color: var(--dsw-alias-state-success-primary, #12b76a); }
.mroute-actions { display: flex; justify-content: flex-end; gap: 8px; }
.mroute-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  background: color-mix(in srgb, currentColor 2%, transparent); color: inherit;
  border-radius: 8px; padding: 7px 12px; font: inherit; font-size: 12.5px; font-weight: 500;
  line-height: 1.2; white-space: nowrap; cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.mroute-button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 6%, transparent); border-color: color-mix(in srgb, currentColor 26%, transparent); }
.mroute-button:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #2f6fed); outline-offset: 2px; }
.mroute-button:disabled { opacity: 0.5; cursor: default; }
.mroute-primary { background: var(--dsw-alias-button-info-fill, #2f6fed); border-color: transparent; color: var(--dsw-alias-label-primary-inverted, #fff); }
.mroute-primary:hover:not(:disabled) { background: var(--dsw-alias-button-info-fill, #2f6fed); filter: brightness(1.06); }
.mroute-switch {
  width: 40px; height: 24px; border-radius: 999px; border: 0; padding: 0; flex: none;
  background: color-mix(in srgb, currentColor 18%, transparent); position: relative;
  cursor: pointer; transition: background 160ms ease;
}
.mroute-switch:hover:not(:disabled) { background: color-mix(in srgb, currentColor 26%, transparent); }
.mroute-switch::after {
  content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px;
  border-radius: 50%; background: var(--dsw-static-neutral-bluish-00, #fff);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); transition: transform 140ms ease;
}
.mroute-switch.is-on { background: var(--dsw-alias-button-info-fill, #2f6fed); }
.mroute-switch.is-on::after { transform: translateX(16px); }
.mroute-switch:focus-visible { outline: 2px solid var(--dsw-alias-button-info-fill, #2f6fed); outline-offset: 2px; }
.mroute-switch:disabled { opacity: 0.55; cursor: default; }
@media (max-width: 620px) {
  .mroute-grid { grid-template-columns: 1fr; }
  .mroute-card-chips { justify-content: flex-start; }
}
`

    // ── 临时自测结束 ────────────────────────────────────────────────────────────

    const inject = ['slots', 'remote', 'remote.settings', 'remote.credentials']

    function apply(ctx) {
      // 降级容错（任务书 §4.A.3）：settings 服务缺席（旧 build/headless）→ 不注册不报错。
      const remote = ctx && ctx.remote
      if (!remote || !remote.settings || typeof remote.settings.describe !== 'function') return
      // 热重载时重写 <style> 节点，而非「存在即跳过」（仿 dsh-orb client-settings，避免旧规则残留）。
      let styleNode = document.getElementById('dsh-mroute-settings-style')
      if (!styleNode) {
        styleNode = document.createElement('style')
        styleNode.id = 'dsh-mroute-settings-style'
        document.head.append(styleNode)
      }
      styleNode.textContent = style
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: ORDER,
        label: () => copy().nav,
        inject: () => ({ settings: ctx.remote.settings, remote: ctx.remote }),
      }, ModelRouteSection))
    }

    exports.apply = apply
    exports.inject = inject
    exports.__mroute = {
      zh, en,
      CHANNEL_TYPES, TIERS, MANUAL_STATUSES, CAPABILITY_KEYS, CAPABILITY_RATINGS,
      CHANNEL_TYPE_RANK, TIER_RANK,
      NS, SECTION_ID, ORDER,
      normalizeChannel, normalizeModelCapability, validateChannel, validateTopLevel, channelToPlain,
      buildSaveOps, formFromView, verifiedHintKey, previewRanking,
      normalizeAliases, aliasGroups, normalizeRatings,
      normalizeDynamicSnapshot, dynamicChipOf, dynamicRowById,
      ModelRatingEditor,
      unwrapResult,
    }
    return module.exports
  },
})
