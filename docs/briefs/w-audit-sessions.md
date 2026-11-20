# 任务书：多模型会话审计（W-audit）

## 0. 一句话
做一个**只读**的多模型会话审计器 + 一份审计报告：从 DSH 会话日志里还原「哪些会话派了子会话、用了哪些模型、派发前有没有查 mroute 推荐、有没有按清单走」，给出合规统计与异常清单。

## 1. 数据源（已侦察，别猜）
- **会话日志**：`C:\Users\sir_c\.dsh\sessions\<workspace-slug>\session-<uuid>\session.v4.jsonl.zstd`
  - 每个文件是 **zstd 压缩的 JSONL**（Node 24 自带 `node:zlib` 的 `zstdDecompressSync`，实测可用；不行再找 zstd 二进制）。
  - slug 是工作区路径的转义名（如 `--C-Users-sir_c-.dsh-dsh_orb--`）；本工作区 `D:\Codes\DSH小插件` 的 slug 自己发现（含 unicode 转义）。
  - 每行一个事件 JSON，事件结构自己 dump 前 3 行看清楚（关注 tool_call / tool_result / assistant text / session metadata，字段名如实记录到报告里）。
- **推荐侧日志**：`C:\Users\sir_c\.dsh\mroute\decisions\decisions-YYYYMM.jsonl`（`ts`/`args`/`top3[]`/`excluded_count`/`generated_at`，**只有 `model_route_query` 会写**，`mroute_dispatch_plan` 不写 —— 这点必须在报告里写明）。
- **渠道/模型注册表**：`C:\Users\sir_c\.dsh\profiles\desktop\cordis.patch.yml`（`channels[]`/`model_aliases`/`model_ratings`/`dynamic_snapshot`）。**只读**。

## 2. 交付物
1. `D:\Codes\DSH小插件\plugin-mroute\devtools\audit-sessions.mjs`（Node ≥22，**零依赖**）
   - 用法：`node audit-sessions.mjs [--workspace <slug 或路径子串>] [--limit N] [--json <out.json>] [--md <out.md>]`
   - 逐会话提取：`session_id`、工作区 slug、起止时间、**用到的模型**（主会话模型可从 system/header 事件取；取不到就标 `unknown`）、**派发次数**、每个子会话的 `provider/model`（子会话以自己的 session 目录出现，用父子关联或时间/标题启发式，找不到关联就标 `unlinked`）、**派发前是否调用过 `mroute_dispatch_plan` 或 `model_route_query`**（按 tool_call 事件的工具名 + 时间顺序判定：调用时间早于首次 subagent/tree_dispatch 调用 = `before`）、被拒证据（tool_result 里出现 `child LLM route is not allowed`）等。
   - 合规分类（每会话一个）：`compliant`（派发前查过且 assignee 与清单首项/前几项一致）、`compliant_fallback`（查过后被拒改填下一项）、`preflight_late`（查了但在派发之后）、`no_preflight`（没查）、`no_dispatch`（没派过子会话）、`unknown`。
   - 聚合统计：总会话数、有派发的会话数、响应率（`(compliant+compliant_fallback)/有派发`）、按模型族分组的响应率、Top N「派发前最常调用的工具」、按天时间线。
   - 异常清单：策略门拒绝次数、`unknown tool` 次数、`mroute` 工具报错次数、模型 `unknown` 的会话。
   - **只读红线**：绝不修改 `~/.dsh` 下任何文件；输出只写 `--json/--md` 指定路径（默认 `plugin-mroute/devtools/out/`）；漏 `--workspace` 时默认扫本工作区 slug。
   - 性能：会话数可能上千，用流式逐行处理，单文件失败（坏 zstd/坏行）只记 warning 不中断。
2. `D:\Codes\DSH小插件\docs\09-multi-model-session-audit.md`（审计报告，≥120 行）
   - §1 方法与数据源（含事件字段名实证、zstd 处理方式、slug 列表）；§2 覆盖范围（扫了多少会话/多少派发）；§3 合规统计表（总数/响应率/按模型族）；§4 典型样本 3 个（各贴关键事件时间线摘要，**不含 prompt 正文与任何密钥**）；§5 异常清单与解读；§6 局限（`dispatch_plan` 不写日志 → 只能靠 tool_call 事件；父子关联是启发式）；§7 复现命令。
3. 会话清单 JSON（可选，`plugin-mroute/devtools/out/summary.json`）作为机读证据。

## 3. 红线
- 不改 `plugin-mroute/lib/**` 与 `client.js`（这是纯 devtools 脚本 + 文档）。
- 报告与输出**不得包含**：prompt/消息正文原文、API key、token、cookie、任何 `credential` 值。只允许工具名、模型名、时间、计数、session id（可截断前 8 位）。
- 中文写报告；脚本注释中文。

## 4. 验收（DoD）
- `node plugin-mroute/devtools/audit-sessions.mjs --limit 50` 能跑通并打印统计摘要（贴前 20 行输出）。
- 报告 §1 必须给出**实际事件结构样例**（字段名 + 一行 truncate 到 120 字符的样例，且不含敏感正文——可用 `tool_call` 事件举例）。
- 报告里给出本工作区近 7 天的真实响应率数字（有多少会话派过子会话、其中多少派发前查过推荐）。
- 自报 3 个典型样本的 session id 前 8 位 + 分类结论。

## 5. 上报纪律
开工 brief_echo；done 控制在 40 行内：脚本路径/行数、跑通输出摘要、报告章节清单、真实统计数字、局限 3 条。
