# 任务书：给 dsh-quota 补小米（Xiaomi MiMo）余额适配器

> 派发自 lead（root 会话）2026-11-13。执行者：独立 subagent。开工先读工作区 `AGENTS.md` 与本任务书全文。

## 1. 背景（一句话）

本机 DSH 已装 `dsh-quota@0.14.10`（多平台额度悬浮球，npm 实测可用），但**不支持小米 MiMo 渠道**；本机 DSH 模型目录里有 `xiaomi` provider（凭证引用 `XIAOMI_API_KEY`，bulk 跑量渠道）。目标：基于上游源码做一个 fork 版，补上小米渠道的余额/套餐查询，产出可安装的插件目录，由 lead 完成安装实测。

## 2. 已确认的环境事实（lead 亲测，直接可用）

- 本机 DSH 凭证域 refs：`XIAOMI_API_KEY` 已存在（`C:\Users\sir_c\.dsh\.credentials.yaml`）；mroute 注册表登记 `xiaomi → prepaid/bulk/priority 50`。
- DSH 模型目录 `list_subagent_models()` 返回的可配置 provider：`xiaomi`（`registerConfigurableProviders` 机制，设置页配置，apiKeyEnv=XIAOMI_API_KEY）。
- 已装 `dsh-quota@0.14.10` 的实测输出（`quota_refresh`）：DeepSeek ¥52.28、智谱 Coding Plan 窗口、OpenCode Go 窗口、gitee/proma 探活——**小米渠道完全缺席**。
- `dsh-quota` 的自动发现机制：直连平台 key 在 DSH 凭证域能解析（按 `apiKeyEnv` 引用）就自动出现卡片，平台映射表在 `src/platform-map.ts`（Host 侧）与 `src/client/platform-map.ts`（浏览器侧）**两份**，改动必须两份同步（上游注释明确警告过单侧漂移坑）。

## 3. 参考源码位置（vendors/，均已下载到本工作区）

| 路径 | 内容 | 用途 |
|---|---|---|
| `D:\Codes\DSH小插件\vendors\Minokun--dsh-quota\dsh-quota-main\` | dsh-quota 完整源码仓库（src/ + tests/ + docs/extending.md + scripts/），MIT | **改造基座** |
| `D:\Codes\DSH小插件\vendors\bricika--dsh-quota-dashboard\` | dsh-quota-dashboard@0.2.5（npm tgz），描述含「GLM / 小米 MiMo 余额」 | 小米余额查询参考 A |
| `D:\Codes\DSH小插件\vendors\Yeoksin--dsh-usage-wallet\` | dsh-usage-wallet（GitHub main），描述含「小米 MiMo 控制台余额与套餐用量（控制台 Cookie）」 | 小米余额查询参考 B（cookie 路线） |
| `D:\Codes\DSH小插件\vendors\dsh-quota\` | 已装版编译产物 lib/（含 .map） | 对照运行时行为 |

注意 vendors 源码的 LICENSE：dsh-quota 是 MIT（README 底部）；另两个 fork/参考实现开工时先确认各自 LICENSE 与 NOTICE 要求，产出物 NOTICE.md 必须记录借鉴出处与版本。

## 4. 要回答的问题清单（调研 → 逐条带证据：文件路径+行号）

1. **小米 MiMo 余额/套餐查询端点是什么？** 从参考 A/B 源码提取：完整 URL、HTTP 方法、认证头形态（Bearer API key？Cookie？签名？）、请求/响应 JSON 结构（字段名逐个列出）、余额字段与套餐窗口字段的映射。两个参考各自怎么实现，是否同一条端点路线。
2. **本机只有 `XIAOMI_API_KEY`（API key，无 console cookie），哪条路线可行？** 参考源码里小米查询用的是 API key 还是 cookie？若 API key 直查可行 → 主路线；若只有 cookie 路线 → 明确说明缺失什么，并给出「探活降级」方案（类似 gitee/proma 卡：无余额接口就只探测模型服务在线）。必要时用 `web_search` 补充小米 MiMo 开放平台（xiao mi mimo / mi coding 开放平台）公开 API 文档佐证，引用 URL。
3. **dsh-quota 源码里加一个直连平台要动哪几处？** 以现有自动发现平台（如 SiliconFlow/StepFun）为样板，列出：`src/platform-map.ts`、`src/client/platform-map.ts`、`src/direct.ts`（查询函数）、类型定义、面板文案/locale、tests——精确到文件与函数名。
4. **构建链路怎么跑通？** 上游 `pnpm build` 有 client-id 一致性门禁和 `link-harness` 对齐步骤；本机 PATH 有 node v24.20.0、pnpm 可用。确认 build 脚本要求，产出实际可用的构建命令序列。

## 5. 交付物（绝对路径，全部落盘后才能报 done）

1. **调研报告**：`D:\Codes\DSH小插件\docs\briefs\brief-quota-xiaomi-adapter-findings.md`
   - 问题 1-4 逐条回答，全部带文件路径+行号或 URL 证据；
   - 「一致性核对」小节：两个参考实现的小米路线是否冲突，冲突时以谁为准、为什么。
2. **fork 源码目录**：`D:\Codes\DSH小插件\plugin-quota-xiaomi\`
   - 从 `Minokun--dsh-quota\dsh-quota-main` 完整复制后改造（保留上游 LICENSE，新增 `NOTICE.md` 记录：基于 Minokun/dsh-quota 哪个 commit/版本、借鉴了 bricika/dsh-quota-dashboard 与 Yeoksin/dsh-usage-wallet 的哪些实现、移植即冻结声明）；
   - 新增 xiaomi 平台适配器（平台 id 建议 `xiaomi`，label「小米 MiMo」，凭证引用 `XIAOMI_API_KEY`，与 DSH 模型 provider id 对齐——这样自动发现直接命中）；
   - 两份 platform-map 同步改；面板/工具文案中英双语（跟随上游 locale 模式，en 文案不得含中文字符——上游有单测把关，别破坏）；
   - 若小米查询路线需要额外配置形态（如 AK/SK 双字段），按上游火山方舟（`src/ark.ts`）的处理样式做，不要发明新范式。
3. **构建产物**：`plugin-quota-xiaomi\dist\`（或上游 build 的实际产物目录）+ 在目录里写 `BUILD.md` 记录实际执行的构建命令序列与结果（成功/失败与原因）。
4. **自检清单**（BUILD.md 末尾）：`node --check` 通过的关键文件列表；xiaomi 平台在 platform-map 两份里各出现的位置（行号）；有测试则跑 tests 里相关用例并贴结果。

## 6. 环境坑（必读，前人实录）

- **npm 用 `npm.cmd`**（npm.ps1 被 ExecutionPolicy 挡）；本机跑 .ps1 前先 `Set-ExecutionPolicy -Scope Process Bypass -Force`。
- **写 JSON/配置文件禁止带 BOM**：PowerShell 5 `Set-Content -Encoding UTF8` 会写 BOM，宿主解析直接炸（今天刚踩过）。用 `[IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))`。
- **asar 归档**：DSH 检出 `D:/DSHarness/resources/app.asar/dsh/` 只有 read 工具能读；本任务原则上不需要进 asar。
- **schemastery**：`@deepseek-ai/schemastery` 若被引用必须显式进 dependencies；`z.record` 缺失、`z.dict` 存在、数组元素内 `.volatile()` 会抛错。
- **网络**：下载偶发「基础连接已经关闭」，重试或走代理 `http://127.0.0.1:7877`。
- **禁止红线**：不碰 llm/stream 改道、不改 agent/request 路由（本任务纯余额查询，天然不涉及，但写代码时别顺手引入）。
- **凭据纪律**：`XIAOMI_API_KEY` 的值严禁出现在任何产出文件/日志/工具返回里；代码只允许引用凭证名（`XIAOMI_API_KEY` 字符串本身可以出现）。
- **不要安装插件**：`install_bundle` 由 lead 在验收后执行；worker 只产出目录。同理 `pnpm link-harness` 若需要对齐本机 dsh，用环境探测（`npm root -g` 或 asar 路径只读），不要改动宿主。

## 7. 上报纪律

- 开工先 `brief_echo`（子会话对父回报用最终答复即可，无 tree_report 面）；
- 阶段 A（调研）完成先交中期结论（端点 + 可行路线判定），再进阶段 B（改造）；
- 完成 `done`：一句话结论 + 交付物路径清单 + 自检结果；上下文水位 ≥50% 时 `session_handoff` 同层交接并把交接文件路径报给父会话。

## 8. 验收口径（lead 执行，worker 自查对照）

- [ ] 调研报告四问全答且证据可回溯；
- [ ] `plugin-quota-xiaomi\` 目录结构完整（含 NOTICE.md、BUILD.md）；
- [ ] 构建产物存在且 `node --check` 通过；
- [ ] lead 安装后 `quota_refresh` 输出出现小米卡片（API key 路线出余额/套餐，探活路线出「模型服务 在线」均可接受，按调研结论预期）。
