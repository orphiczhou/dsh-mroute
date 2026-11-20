# M5-MVP-0 实施任务书（`model_eval_run` 最小可运行评测）

> 正源：`D:\Codes\DSH小插件\docs\10-m5-eval-plan.md`（§2 裁决、§3 数据模型、§4 调用纪律、§5 六维表、§7 范围、§8 验收、§9 护栏）。
> 本任务书只补充「怎么做、按什么顺序、怎么自证」。冲突时以 10 号计划为准；若计划与源码不符，**以源码为准并在 devlog 写「任务书纠偏」**。

## 0 一句话

给 `plugin-mroute` 加一个 `model_eval_run` 工具：能在一次调用里对 1–3 个规范模型跑 6 道小题（六维各 1 题），确定性判分、落 JSONL、把摘要写进新顶层 `model_eval`，**全程不改变任何既有排序/输出**。

## 1 开工顺序（不可跳步）

1. **schemastery 探针**（30 分钟内）：验证 `z.dict(z.object({...嵌套 scores/dimension_status...})).default({}).volatile()` 在宿主版本下能否构造、`.get()` 读回逐键完整、空表合法、非法值报错。结论写进 `plugin-mroute/lib/config-schema.js` 头注；不通过就走降级（`z.dict(z.any())` + 读侧校验）。
2. **`tools` 维 spike**（30 分钟）：`ctx.llm.prepareCall` 的 controls 是否接受 `tools`、`stream` 是否返回 `tool-calls` finish；实测结论决定 `tools` 维 `graded` 还是 `null`。**不许猜**。
3. 按 §7 的 8 个交付项顺序实现。
4. 自检 + 真机一轮（默认 prepaid 模型）。

## 2 硬约束（违反即返工）

- **零耦合**：`lib/ranking.js`、`assembleRouteTable`、`model_route_query`、`mroute_dispatch_plan` 的行为与输出**一个字节都不许变**（改动前先跑一次并把输出存到 `%TEMP%` 作基线，改完 diff）。
- `model_eval_run` **永不**写 `channels[].tier` / `priority` / `model_ratings`；只写 `model_eval` 与 `eval_status`。
- 写配置走 `ctx.fiber.entry` + `ctx.get('configEditor').edit(...)`；**失败静默**（只记日志 + 返回文本里给 `eval_status_error`），不许让工具抛出去。
- 宿主工具 JSON schema **禁 type 数组**（`type: ['string','null']` 会导致整套工具注册失败）；可空字段发单一 type，无值就不发该键。
- 工具注册必须**平级 try**（照 `index.js:116-127` 的写法），不许嵌套在别的 try 里。
- `maxTokens` 必须显式传（默认可达 131072）；finish 白名单：`stop` 成功、`tool-calls` 仅 tools 维算成功、`max-tokens|error|aborted` 失败、未知 kind 显式失败并落原文。
- 渠道白名单（L3）：MVP 默认只允许 `channel_type === 'prepaid'` 的渠道；包月渠道需显式 `allow_monthly: true`（默认 false）才可用。
- 不发任何出站 HTTP；凭据只走 `ctx.credentials`（本 MVP 不读密钥）。
- client 半只 require `react`；MVP 面板只加一行只读文本，**不加按钮**。

## 3 交付物

| # | 文件 | 内容 |
|---|---|---|
| 1 | `plugin-mroute/lib/config-schema.js` | 新增 `model_eval`、`eval_status`（§3 形状）+ 探针结论头注 |
| 2 | `plugin-mroute/lib/eval/suite-lite.mjs` | 6 题写死（`version:'lite/1'`）：coding/tools/long_context/vision/world_knowledge/orchestration 各 1 |
| 3 | `plugin-mroute/lib/eval/runner.mjs` | 串行执行、超时 60s/题、`max_calls`、usage/finish 采集、`applied_effort` 校验 |
| 4 | `plugin-mroute/lib/eval/score.mjs` | 确定性判分、哨兵 must-pass/must-fail、Wilson 95% LB、`dimension_status`、`suggest` 规则（§6） |
| 5 | `plugin-mroute/lib/eval/store.mjs` | `<DSH_HOME>/mroute/eval-history/<run_id>.jsonl` 追加写 + 摘要装配（原子写：临时文件 + rename） |
| 6 | `plugin-mroute/lib/tool-eval-run.mjs` | 工具定义与渲染（`dry_run` 默认 true；入参 `models/limit/dry_run/allow_monthly/max_calls`，**校验先于任何 IO**） |
| 7 | `plugin-mroute/index.js` | 平级 try 注册第 5 个工具 |
| 8 | `plugin-mroute/selfcheck/eval-run.test.mjs` + `package.json` | 新测试 ≥10 组；版本 `0.9.0-m5.0`；`check`/`selfcheck` 脚本链保持 |

文本报告格式（`dry_run` 与实跑都要能读）：

```
评测预检 · model eval
suite lite/1 · 6 题 · effort=max(钉死) · 渠道白名单 prepaid
将评测：deepseek-flash（deepseek-official, prepaid）· mimo-v2.6-flash（xiaomi, prepaid）
预算：≤18 次调用 · 单题 maxTokens 512 · 预计 <2 分钟
（dry_run：未写盘。加 dry_run:false 才会真正执行）
```

## 4 自检要求

- `node --check` 所有改动文件 0 错。
- `npm.cmd run check` exit 0；`npm.cmd run selfcheck` **≥146 条全绿**（现 136 + 新增）。
- 新增用例至少覆盖：finish 白名单四态、超时、哨兵破判、`vision` 必为 `null`/`-1`、`provisional` 触发、`suggest.priority_delta` 上限、`dry_run` 不写盘、`allow_monthly=false` 时排除包月渠道、`max_calls` 截断、JSONL 行数=调用数。
- **真机一轮**：`model_eval_run({dry_run:false, models:['deepseek-flash'], max_calls:6})`，贴出文本报告与 `eval-history/<run_id>.jsonl` 前两行（脱敏，不贴完整题面也行）。
- 零耦合 diff：`model_route_query` 与 `mroute_dispatch_plan` 改前/改后输出存 `%TEMP%` 并 `Compare-Object`，结论写进 devlog。

## 5 文档与收尾

- `docs/05-m3-devlog.md` 追加 **§22 M5-MVP-0**：探针结论、tools spike 结论、实现落点表、自检数字、真机证据、零耦合 diff 结论、已知坑。
- 卸载/热重载：改完用 `plugin_manager action=set_bundle target=@local/dsh-plugin-mroute enabled:false` → `true`（两轮都要 `application:"applied"`），**不要**用 install_bundle（本项目历史事故）。
- 临时文件一律放 `%TEMP%`，收尾删掉；工作区不留 `.bak`。

## 6 上报纪律

- 开工先回 6 行以内：你怎么理解任务、探针计划、预计卡点。
- 每完成一节回 3 行 progress（带了什么证据）。
- 完成时回 **≤15 行**：改了什么、自检数字、真机结果、零耦合 diff 结论、遗留风险。
- 遇下列情况**立即停下问我**，不要自行改设计：①schemastery 探针失败且降级方案也失败；②`ctx.llm.prepareCall` 实际签名与计划 §4 不符；③任何既有 136 条自检因你的改动失败且你判断需要改既有语义；④工具注册后 `Tool.listTools` 查不到 `model_eval_run`。
