# mroute — DSH 多子会话派遣的模型路由建议

> 一个 **advisory-only**（只建议、不阻断）的 DeepSeek Harness（DSH）插件：把已注册的模型渠道按**财务优先级 + 能力档位 + 实时余额 + 动态告警**排成一张可直接照抄的清单，供你在派发子会话时填 `assignee{provider, model}`。

`mroute` 不拦截、不改写、不替你做决定：它只负责「现在该用哪个模型、为什么、还剩多少额度」，最终选择权始终在会话与你手上。

- 插件版本：`0.8.2-m4.11`
- 宿主：DeepSeek Harness 0.2.2 系列（Cordis 插件体系）
- 自检：`136/136`（`npm run selfcheck`）+ 面板渲染内 23 项真机断言 + 洁净室 skill 测试 2/2

---

## 目录

- [为什么需要它](#为什么需要它)
- [核心特性](#核心特性)
- [排序与判定口径](#排序与判定口径)
- [四个工具](#四个工具)
- [设置面板](#设置面板)
- [使用细则 skill（mroute-dispatch）](#使用细则-skillmroute-dispatch)
- [多模型会话审计](#多模型会话审计)
- [安装](#安装)
- [仓库结构](#仓库结构)
- [文档索引](#文档索引)
- [开发与自检](#开发与自检)
- [设计红线](#设计红线)
- [环境坑（实测记录）](#环境坑实测记录)
- [许可与致谢](#许可与致谢)

---

## 为什么需要它

DSH 允许给子会话单独指定 `provider/model`。但一旦账号里挂了 5 个渠道、20 多个模型（包月订阅、代金券、预付费余额混在一起），每次派活都要重新回答三个问题：

1. **哪个渠道先用？**（包月已经付过钱，预付费是花一笔扣一笔）
2. **这个任务需要什么能力？**（写代码 / 长上下文 / 视觉 / 世界知识 / 规划调度）
3. **它还有额度吗？**（5 小时窗口、本周窗口、账户余额，快见底的渠道派长任务会中途断）

`mroute` 把这三个问题压成一次工具调用，并把答案排成「照抄即可」的清单。

## 核心特性

| 能力 | 说明 | 落点 |
|---|---|---|
| 财务优先排序 | `monthly`（包月）→ `voucher`（代金券）→ `prepaid`（预付费），同档内再按能力分层与人工优先级 | `plugin-mroute/lib/ranking.js` |
| 余额机读 | 经已装的 `dsh-quota`（quota-multi）插件面板快照读各渠道余额，带缓存/单飞/退避/熔断 | `lib/quota-source.js`、`lib/quota-cache.js`、`lib/quota-view.js` |
| 窗口型额度 | 识别 `5h 24% · 本周 25% · 本月 12%` 这类百分比窗口，不把「已用量」当余额 | `lib/quota-view.js`（`WINDOW_USED_RE`） |
| 动态沉底 | 周窗口 ≥98% 或余额 <¥10 的渠道自动沉到队尾（**只沉底、不剔除**），5h ≥95% 只提示 | `lib/dynamic-state.js` |
| 能力匹配 | 六维需求 `need`（AND 语义）→ 每个渠道给出匹配模型、`fit`/`min` 分数 | `lib/capability-need.js` |
| 模型归并 | 同一模型跨渠道不同叫法 → `model_aliases` 别名表 + 归并视图 | `lib/registry.js`、`lib/tool-alias-suggest.js` |
| 统一模型能力档位 | 按**规范模型名**登记六维评级（含「无」），不按渠道登记 | 顶层 `model_ratings` |
| 派发预检 | `mroute_dispatch_plan` 直接给可粘贴的 `provider/model` 清单 + 快照新鲜度 | `lib/tool-dispatch-plan.js` |
| 设置面板 | DSH 设置里新增「模型路由」分区：渠道卡、阈值、别名、能力档位、动态层 | `plugin-mroute/client.js` |
| 派发纪律 skill | `mroute-dispatch` skill 让任意会话按「先查 → 照抄 → 降级」三步走 | `skills/mroute-dispatch/` |
| 自动评测（MVP） | `model_eval_run` 在对话内跑一轮最小评测（4 判分题 + 1 校准哨兵 + vision 恒 null），只写建议值不排序 | `lib/tool-eval-run.mjs`、`lib/eval/` |

## 排序与判定口径

全序比较器（`lib/ranking.js`，越靠前越优先）：

```
1. livecheck 未知        （活校验失败的渠道沉底）
2. dynamicTight         （动态沉底：周窗口超阈值 / 余额低于阈值）
3. channel_type         monthly(0) < voucher(1) < prepaid(2)
4. tier                 overseas_sota(0) < domestic_sota(1) < bulk(2)
5. priority             （人工优先级，降序）
6. id                   （字典序兜底，保证结果稳定）
```

余额视图有四种形态（`lib/quota-view.js` 的 `mode`）：

- `amount`：金额型（`¥28.54`）—— 可判定低余额沉底
- `window`：窗口型（`5h 24% · 本周 25%`）—— 可判定窗口沉底/提示
- `status`：状态型（`在线`）—— 只展示，不参与判定
- `manual`：回落人工登记值（quota 插件停用/未核实账户时）

> 红线：**映射命中 ≠ 账户体系一致**。`quota_account_verified` 为 false 的渠道即使映射到某个平台行也不采信数值（例如包月订阅渠道 ≠ 同厂商 API 余额）。

## 五个工具

| 工具 | 用途 | 关键入参 |
|---|---|---|
| `mroute_dispatch_plan` | **派发预检**：返回可直接粘贴的 `provider/model` 清单 + 快照新鲜度 | `need?` `limit?`（1..10，默认 5）`channel_type?` |
| `model_route_query` | 完整体检表：全量 routes、余额、能力匹配、模型归并视图、告警 | `capability?` `tier_min?` `need?` |
| `model_route_sync_models` | 把渠道 `models[]` 与宿主模型目录对齐（默认 dry-run，`apply:true` 才写） | `apply?` |
| `model_route_alias_suggest` | 跨渠道同模型归并建议（默认 dry-run，`apply:true` 只写「同 id 跨渠道」） | `apply?` |
| `model_eval_run` | **自动评测（MVP）**：一轮最小评测，产出 `model_eval`/`eval_status` 建议值；默认 `dry_run:true` 零调用零写盘 | `models?` `limit?` `dry_run?` `allow_monthly?` `max_calls?` |

`need` 六维闭集：`coding` / `tools` / `long_context` / `vision` / `world_knowledge` / `orchestration`，取值 `fair` / `good` / `excellent`（AND 语义）。评级里另有 `none`：**明确无此能力**，与「未登记」是两件事。

典型输出（`mroute_dispatch_plan`）：

```
派发预检 · dispatch preflight（2026-11-20T13:53:31.708Z）
数据：quota 快照 2026-11-20T13:51:38.169Z · 新鲜（≤5 分钟） · 5/5 渠道机读可用
1. zai-coding-cn / glm-5.3  [monthly · domestic_sota · priority 90]  🌕 5h 1% · 本周 12%
2. opencode-go / qwen3.8-flash  [monthly · domestic_sota · priority 80]  🌕 5h 25% · 本周 26% · 本月 13%
3. deepseek-official / deepseek-flash  [prepaid · domestic_sota · priority 70]  💰 ¥28.54
用法：按顺序把 provider/model 填进 subagent/tree_dispatch 的 assignee；被宿主策略门拒绝就换下一项；全被拒则省略 assignee 继承父路由。
标记：🌕=运行态正常　🌓=有窗口告警　💰=金额型　⚠=需注意
```

## 设置面板

DSH 设置 →（左下角账号菜单）→「模型路由」分区（`settings.section`，order 18）：

- **渠道卡**：默认折叠，折叠态显示六枚 chips（状态 / 付费类型 / 档位 / priority / 余额平台 / 核实态），展开后可改 `channel_type`、`tier`、`priority`、`capability`、`models`、`fallbacks`、额度备注；
- **建议顺序（静态层）**：只读预览卡，用与 host 相同的比较器算一遍，方便对照；
- **动态层**：展示最近一次 `model_route_query` 写回的快照（沉底/提示/正常 + 读数），只读；
- **模型归并**：别名表编辑 + 一键「同 id 跨渠道」归并；
- **统一模型名能力档位**：按规范模型名给六维评级，含「无」；
- **阈值**：低余额阈值（默认 ¥10）、周窗口沉底阈值（默认 98%）、5h 提示阈值（默认 95%）、quota 缓存 TTL。

## 使用细则 skill（mroute-dispatch）

`skills/mroute-dispatch/`（已发布到 `~/.dsh/skills/mroute-dispatch/`）：

```
skills/mroute-dispatch/
├── SKILL.md                     # 何时用 / 三步流程 / 读取格式 / need 六维 / 常见坑 / 面板
├── check.mjs                    # 零依赖自检：frontmatter、触发词、行数、无敏感串
└── references/
    ├── tools.md                 # 四个工具的入参出参，逐条带源码行号
    └── troubleshooting.md       # 症状 → 原因 → 处置
```

三步流程：**先查**（`mroute_dispatch_plan`）→ **照抄**（填 `assignee`）→ **降级**（被策略门拒则换下一项，全被拒则省略 assignee）。

## 多模型会话审计

`plugin-mroute/devtools/audit-sessions.mjs`：只读扫描 DSH 会话日志（`~/.dsh/sessions/<slug>/session-*/session.v4.jsonl.zstd`，zstd + JSONL），还原「哪些会话派过子会话、派发前有没有查推荐、用了哪个模型、有没有被策略门拒」，输出合规统计与异常清单。方法与结论见 [docs/09-multi-model-session-audit.md](docs/09-multi-model-session-audit.md)。

本机实测（2026-11-21，95 个会话 / 41799 个事件 / 1.8s，零失败文件）：

| 指标 | 值 |
|---|---|
| 有派发的会话 | 20（92 次尝试：成功 76 / 失败 16） |
| 派发前查过推荐（响应率） | **70.0%**（14/20） |
| 派发前成功查到清单（查过推荐率） | **85.0%**（17/20） |
| 近 7 天响应率 | **77.8%**（14/18，`--since` 固定窗口；查过推荐 88.9%） |
| 按模型族 | glm 66.7%（12 有派发）/ deepseek 75.0%（8） |
| 预检工具分布 | `mroute_dispatch_plan` 9 · `model_route_query` 8 · 未查 3 |
| 异常 | 策略门拒绝 10 次 / 4 会话；unknown tool 16 次 / 6 会话 |

```powershell
node plugin-mroute/devtools/audit-sessions.mjs                    # 扫当前工作区会话，出控制台统计 + out/summary.json + out/audit-summary.md
node plugin-mroute/devtools/audit-sessions.mjs --since 2026-11-13T14:00:00Z   # 固定 7 天窗口（`--days` 会随运行时刻滑动，不可复现）
node plugin-mroute/devtools/audit-sessions.mjs --workspace dsh_orb --limit 20  # 指定工作区（slug 子串）
node plugin-mroute/devtools/audit-sessions.mjs --md docs/09.md --json out.json --top 5 --quiet
```

可用参数：`--workspace <slug 或路径子串>`、`--limit N`、`--days N`、`--since <ISO>`、`--json <path>`、`--md <path>`、`--root <sessions 根>`、`--decisions <dir>`、`--patch <yml>`、`--top N`、`--quiet`、`--help`。

> 红线：审计报告只含分类与计数，**不含 prompt 正文、密钥、token、cookie**；session id 只留前 8 位。

## 自动评测（M5-MVP，`model_eval_run`）

在对话内跑一轮**最小**自动评测：`suite lite/1` = 4 道判分题（coding / tools / long_context / orchestration）+ 1 道校准哨兵（world_knowledge，计分但**不进 composite**）+ 1 道恒 `null` 的 vision 占位。

- **默认 `dry_run:true`**：只做预算/白名单/档位预检并渲染计划，零模型调用、零写盘。
- **成本闸**：单题 `maxTokens` 512（coding 1024）· `max_calls` 默认 18 硬顶 40 · 默认只测 **prepaid** 渠道（`allow_monthly:true` 才纳入包月；voucher 不参与）· 日预算 200 次 · 每轮串行、单题 60s 超时。
- **调用纪律**（`lib/eval/runner.mjs`）：`ctx.llm.prepareCall(...)` 句柄一次性、`stream` 必须 spread `prepared.config`、effort 用共同档钉死（跨模型可比）、`finish.kind` 按维白名单（tools 允许 `stop|tool-calls`，其余只允许 `stop`），不在白名单一律记 `invalid` 且不写分。
- **写回面只有两处**：`model_eval[<规范模型名>]` 与 `eval_status{state: running|ok|failed}`；**永不写** `channels[].tier` / `channels[].priority` / `model_ratings`，排序链不消费。
- **结论强度**：Wilson 95% 下界；`samples < 12` 一律 `provisional`，此时最多给 `priority_delta`（±10，且 coding/tools 各维下界 ≥0.55），**永不给 tier**；`tier` 建议只在 `samples ≥ 12 且下界 ≥ 0.75` 时出现，且只提「相对上一档」。
- 证据：`<DSH_HOME>/mroute/eval-history/<run_id>.jsonl`（一行 = 一次真实调用）+ 同名 `.summary.json`。

```text
评测完成 · run eval-20261120-231846-e537 · suite lite/1 · 实调 5 次
instrument_healthy=true（判分器哨兵：5/5 通过）
deepseek-flash（deepseek-official/deepseek-flash, prepaid）samples=4 composite=1.00 wilson_lb=0.51 provisional=true effort=high
  维度：coding=graded(1.00) · tools=graded(1.00) · long_context=graded(1.00) · vision=null(-1) · world_knowledge=sentinel(1.00) · orchestration=graded(1.00)
  suggest：tier='' priority_delta=0 · provisional（samples=4<12）且 coding/tools 下界 0.21/0.21 未达 0.55：不给 priority_delta
```

> 为什么 `world_knowledge` 不计分：6 道题无法公平评价世界知识，且「最高山峰」这类题污染严重（多数模型必答对）。把它算进 `composite` 会近乎免费地抬高总分并让 `priority_delta` 偏 +4，污染唯一能落地的输出。设计与裁决见 [docs/10-m5-eval-plan.md](docs/10-m5-eval-plan.md)。

## 安装

```powershell
# 1) 以 link 目录形式装进当前 profile（开发态最省事）
plugin_manager action=install_bundle target="link:D:\Codes\DSH小插件\plugin-mroute"

# 2) 若新增了 client 半（设置面板），重启 DSH 让宿主重扫 client graph
#    仅改 client 代码时：plugin_manager action=set_bundle target=@local/dsh-plugin-mroute enabled:false → true（热重载，无需刷新页面）
```

装好后：

- 工具出现在**所有会话**（注册未限定 scope）；
- 系统提示会多一段派遣提示（`lib/prompt-section.js`，order 116.5），对当前 DSH 实例全局生效；
- 设置面板出现「模型路由」分区。

**依赖**：余额机读需要同时安装 [`dsh-quota-multi`](plugin-quota-multi/)（或上游 dsh-quota），并确保其面板快照接口 `/plugins/dsh-quota/api/status` 可用；未安装时 mroute 自动回落 `manual`，工具照常工作。

## 仓库结构

```
plugin-mroute/           # 主插件（host 半 + client 半 + 自检 + devtools）
mroute/                  # 论证文档 00-07d、vendors 清单
docs/                    # 算法定稿、里程碑 devlog、测试卡、任务书、审计报告
skills/mroute-dispatch/  # 本仓库产出的全局 skill
plugin-quota-multi/      # 多渠道额度插件（dsh-quota 的 fork，加小米 MiMo）
plugin-orb-quota/        # 大肥鱼浮球 × 多渠道额度（dsh-orb-cordis 的 fork）
plugin-lan-scheduler/    # LAN 多机 DSH 调度层（可靠性深化 + 审计）
plugin-lan-status/       # 只读多节点状态面板（独立 HTTP，无 client 半）
plugin-feishu-mirror/    # 飞书镜像插件
_template/               # 新插件脚手架
AGENTS.md                # 工作区协作方法与环境事实（指挥官/工人纪律）
```

## 文档索引

| 文件 | 内容 |
|---|---|
| [mroute/00-feasibility.md](mroute/00-feasibility.md) | 综合可行性报告（决策入口） |
| [mroute/03-ui-panel-feasibility.md](mroute/03-ui-panel-feasibility.md) | 设置面板可行性（bundle 双半注册） |
| [mroute/07-assembly-plan.md](mroute/07-assembly-plan.md) | 工程开工方案（复用/改造/自研三清单） |
| [docs/06-recommendation-algorithm.md](docs/06-recommendation-algorithm.md) | 推荐算法与维度定稿（排序键、need 六维、A/B 方案、裁决结论） |
| [docs/05-m3-devlog.md](docs/05-m3-devlog.md) | 里程碑 devlog（M3 → M4.11，含每个坑的实测证据） |
| [docs/08-m4-test-guide.md](docs/08-m4-test-guide.md) | 面板手工测试卡（强刷、折叠、阈值、冲突、语种） |
| [docs/09-multi-model-session-audit.md](docs/09-multi-model-session-audit.md) | 多模型会话审计报告 |
| [AGENTS.md](AGENTS.md) | 协作纪律 + 环境坑（type 数组、PS BOM、dsh-app:// 等） |

## 开发与自检

```powershell
cd plugin-mroute
npm.cmd run check      # node --check 全部源码
npm.cmd run selfcheck  # node --test selfcheck/*.test.mjs（136 项）
```

自检覆盖：排序全序键、余额视图四形态、窗口解析、动态沉底/提示阈值、能力匹配（含 `none`）、模型归并读写、schema 往返（schemastery）、工具入参校验先于 IO、面板纯函数（`previewRanking`/`normalizeRatings`/`unwrapResult`）。

## 设计红线

- **advisory-only**：不阻断、不改写、不代决策；`enforce_gate` 自始至终是占位，未接 `tools.guard`，无任何 deny 路径。
- **不碰 llm/stream 与 agent/request 路由**：换档唯一持久落点是宿主自己的 `agent.model.select()`（本项目不调用）。
- **凭据**：不读取、不落盘、不回显任何 API key；余额数据来自 quota 插件的快照（其中不含密钥值）。
- **可空字段用「不发键」表达**：宿主工具 schema 只接受单一 `type` 字符串，`['string','null']` 会让整个插件的工具注册静默失败。

## 环境坑（实测记录）

- 宿主工具 JSON schema **禁 type 数组**（`type: ['string','null']` → 注册抛错 → 该插件所有工具消失，fiber 仍 active）。
- 桌面端渲染进程 origin 是 `dsh-app://app`，相对路径 `fetch('/plugins/...')` 打不到宿主 HTTP；client ↔ host 只能走 `ctx.remote.*`，且返回值是 `{ok, value}` **信封**，必须解包。
- 设置面板分区由 client 模块分发，**改 `client.js` 后光点导航不生效**：要 `plugin_manager set_bundle` 关→开（ARTIFACT rev 由文件 stat 计算）。
- PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，导致 `set_bundle` 报 `Unexpected token '﻿'`；改 JSON 一律用 node 重写。
- schemastery `3.19.0`：`z.record` 不存在、用 `z.dict`；**数组元素内不得 `.volatile()`**（调用期抛 fixed-path 错）；`channels[]` 数组整体 volatile 合法。

## 许可与致谢

- 本项目自有代码：MIT（见 [LICENSE](LICENSE)）。
- `plugin-quota-multi/` 是 [Minokun/dsh-quota](https://github.com/Minokun/dsh-quota)（MIT）的 fork；`plugin-orb-quota/` 是 [mini-yifan/dsh-orb-cordis](https://github.com/mini-yifan/dsh-orb-cordis)（MIT）的 fork。各目录内 `NOTICE.md` / `BUILD.md` 记录上游版本与改动。
- `vendors/` 下的第三方参考源码未入库（体积大），来源清单见 [mroute/vendors-manifest.json](mroute/vendors-manifest.json)。
- 仓库不含任何密钥、token、cookie；不含 `tmp/`、`gemini-eyes/`（独立仓）、构建产物与二进制资产，详见 [.gitignore](.gitignore)。
