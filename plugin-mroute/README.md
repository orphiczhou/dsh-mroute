# @local/dsh-plugin-mroute

DeepSeek Harness 的**模型路由参考**插件（M3：quota 数据源 + 设置面板可视化编辑）。在派遣子会话前，按**财务优先级**
（monthly > voucher > prepaid）对模型渠道排序，供指挥官会话选择派遣参数的 `provider/model`。

## 功能

- **`model_route_query` 工具**：读取模型注册表 → 用 `llm.listProviders()/listModels()` 活校验
  （provider 不存在 → 标 unknown 并全局沉底）→ 三级排序（channel_type 一级键 → tier → priority 降序 →
  id 兜底）→ 返回带排序理由的结构化列表与文本摘要。
- **机读余额（M2，balance_source=machine）**：经宿主 webServer `getOrigin()` 同进程 loopback 读取
  已安装 quota 插件（dsh-quota-multi）的面板快照 `GET /plugins/dsh-quota/api/status`，按渠道显式登记的
  `quota_platform` 归一化出余额视图。平台行匹配支持多账号形态（`平台id#keyRef`，如
  `opencode-go#OPENCODE_GO_API_KEY`）：多行命中时按快照 `providerKeyRefs` 反查渠道 keyRef 精选，
  未精选取首个前缀命中行并在 note 标注。**采信前提（账户语义红线）**：`quota_platform` 非空 **且**
  `quota_account_verified=true`（用户确认渠道与 quota 平台卡为同一账户体系）且平台行 ok 且余额可解析；
  任一不满足回落人工登记并在 note 标注原因。machine 行带 `balance{remaining, currency, display,
  as_of, source, degraded}`——**自动余额仅供参考（advisory），无任何阻断语义**。
  quota 插件未装/停用（端点 404，确定性缺席）或网络失败时无感回落 manual，行为与 M1 完全一致
  （404 缺席不进退避熔断、无 stale 标注，quota 重新激活后自动恢复 machine）。
- **quota 快照缓存（M2）**：TTL 缺省 60s（Config `quota_cache_ttl_seconds` 可调，热更）+ 单飞去重 +
  失败指数退避（5s×2^n 封顶 30min，失败结果占缓存位）+ 熔断状态机
  `ok → degraded → cooling → half-open → ok`（连续 3 次失败开熔断，冷却后半开试探一次成功才恢复）；
  降级期携带最近一次成功快照（stale，`degraded:true` 标注）；端点 404 为确定性缺席（不进退避熔断、
  无 stale，缺席结论按 TTL 缓存、过期自动重探测恢复）。查询时懒获取，无后台定时活动。
- **⚠ 标注（M1，非阻断）**：`manual.status=disabled|exhausted` 或余额低于阈值的渠道
  **仍保留在排序表中**，条目带 `warning{reason, suggestion}`（suggestion 取 fallbacks 首选或排序下一项）；
  `reviewed_at` 超过 90 天的渠道带 `review_alert`/`review_alerts[]` 复核提示。标注只是提醒，
  最终选择权在会话与用户（advisory-only）。M2：低余额阈值可配
  （Config `low_balance_threshold_cny`，缺省 10 兼容 M1）；machine 数值优先参与判定
  （仅 CNY/未知币种，USD 不臆测汇率）。
- **capability 评级（M1 标注级）**：channels[] 元素可登记 `{coding, tools, long_context, vision}` 评级
  （excellent/good/fair）；查询入参 `capability` 按评级匹配，命中/未满足/无数据均只在 reason 标注、不过滤。
- **DecisionRecord（FR-E2 最小版）**：每次查询追加一行 JSONL 到 `~/.dsh/mroute/decisions/decisions-YYYYMM.jsonl`
  （ts/args/top3/excluded_count），写失败静默降级不影响查询——插件唯一写面，本地审计用。
- **模型注册表**（插件 Config）：channels[] 渠道清单（id/routeProvider/models/channel_type/tier/priority/
  fallbacks/capability/manual{status,quota_total,quota_used_est,note}/
  **quota_platform/quota_account_verified**（M2）/reviewed_at），内置本机 5 provider
  种子数据（channels 为 volatile 数组，整条替换语义，热更生效）。
  种子 verified 现状：xiaomi=true（平台 id 与 DSH provider 对齐设计明证）；
  deepseek-official/deepseek-account=true（用户澄清单一源）；zai-coding-cn/opencode-go=false 待用户核实后在面板改 true。
- **设置面板「模型路由」分区（M3）**：DSH 设置页注册 `settings.section` 分区（order 18，落 models 与 orb 之间），
  可视化编辑渠道卡片（manual.status 三值、quota_total/quota_used_est/note、quota_platform、quota_account_verified
  开关旁挂账户依据提示、priority/tier/channel_type 枚举、fallbacks/models 列表）与顶层参数
  （low_balance_threshold_cny / quota_cache_ttl_seconds / enforce_gate 开关+advisory 警示）。
  保存走 `remote.settings.mutate`（数组整替 + 三顶层参），成功后 `model_route_query` 立即读到、重启仍在；
  并发写由 settings revision 乐观锁兜底（冲突提示重拉不覆盖他人修改）。advisory-only：面板只编辑建议数据，
  无阻断语义；不接触密钥（mroute 注册表无凭据字段，密钥仍走 DSH 模型提供商设置页）。
- **enforce_gate（M1 占位）**：阻断类 opt-in 开关，schema 缺省 false，M1 不接线任何拦截路径（M6 边界）；面板可改但常驻警示。
- **systemPrompt 一句提示**：新会话提示「派遣子会话前先调用 model_route_query」。

## 排序口径

1. `channel_type`：monthly(包月) > voucher(券) > prepaid(预充值) —— 财务一级键；
2. `tier`：overseas_sota > domestic_sota > bulk —— 能力分层；
3. `priority` 降序（同类内次级排序）；4. `id` 字典序兜底（全序确定性）。
活校验 unknown 的渠道**降权沉底**（不剔除），理由写入每条的 `reason`。

## MVP→M2 范围与红线

纯参考层：**无**评测与写回、**不改写**任何请求（不碰 `llm/stream` 与 `agent/request`）、
**不接触任何 API Key**（quota 快照本身不含密钥值；mroute 不读 credentials、不写 Config 存 key、
不打日志回显；设置面板不侧牌密钥——注册表无凭据字段）。唯一 HTTP 面 = 同进程 loopback
（`isLoopbackOrigin` 围栏：仅 127.0.0.1/localhost/[::1]，绝不外呼；quota 插件零改动、只读消费其面板快照）。
写面 = DecisionRecord 本地 JSONL 追加（观察面非控制面）+ 设置面板经 remote.settings 写自有 Config
（advisory 数据）。阻断类能力（enforce_gate→tools.guard）缺省关闭且未实现。
上游原始快照 JSON 不出宿主（归一化视图消费，keys/formats 等字段 parse 时即丢弃）。

## 使用

新会话中直接调用：

```
model_route_query {}                                  # 全量排序表
model_route_query { "tier_min": "domestic_sota" }     # 只看 domestic_sota 及以上
model_route_query { "capability": "coding" }          # capability 评级标注
```

被宿主策略门拒绝时，按返回列表顺序换下一项；带 ⚠ 标注的渠道仍可自主选用（建议而非禁令）。

## 自检

```
npm.cmd run check       # node --check 14 文件（含 client.js）
npm.cmd run selfcheck   # node --test 五套件（source/cache/view/degrade/client，58 断言组）
```

## 已知限制

- machine 余额仅覆盖「quota 插件已装 + 平台行 ok + 渠道 verified」的渠道；种子仅 xiaomi 为 verified。
- zai-coding-cn 的 quota zhipu 卡是用量窗口型（无余额数值），即使核实账户也不产生 machine 余额——包月
  订阅额度显示维持 manual 登记。
- capability 强过滤（评级门槛不入表）留待后续里程碑裁决；当前仅标注。
- `degraded` 恒 false（渠道级健康状态机未上线）；`exclude_degraded` 过滤已实现、当前无数据源。
- opencode-go / xiaomi 的 models[] 待安装后按 listModels 实况首轮复核。
- DecisionRecord 为最小版（top3 摘要）；逐项加减分与账本联动属后续里程碑。
- M3 设置面板：新增/删除渠道、provider/model 目录候选（remote.llm/session）属后续里程碑；面板 UI 未经
  浏览器实测（以 selfcheck 代码自查 + lead 浏览器实测验收，见 docs/05-m3-devlog.md §6）。
