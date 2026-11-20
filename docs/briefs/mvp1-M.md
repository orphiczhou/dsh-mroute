# 任务书：mvp1-M-mvpdev —— mroute 插件 MVP（技术可行性测试切片）

> 执行者读此文件开工。树：mvp1 / leaf：mvp1-M-mvpdev。这是写代码的任务。

## 0. 必读（按序）
1. `D:/Codes/DSH小插件/AGENTS.md` —— 工作方法与环境坑（asar 只能 read 工具打开；schemastery 嵌套坑；红线）
2. `D:/Codes/DSH小插件/mroute/07-assembly-plan.md` 「M1 开工方案」章 —— 实现蓝图（包结构/schema 要点/排序伪代码/返回 schema 草案）
3. `D:/Codes/DSH小插件/mroute/00-feasibility-report.md` §3.1（注册表 schema 示例）、§4（消费路径）
4. asar 样板（只有 read 工具能读 asar）：
   - `D:/DSHarness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md`
   - 同目录 `templates/decoration/`（package.json / cordis.patch.yml / index.js / client.js / locale/ / icon.svg 最小样板，拷到工作区改）
   - 同目录 `references/practices.md`
5. 参考实现（普通文件系统，可 glob/grep/read）：
   - `vendors/twoweeks1995--dsh-subagent-setup/`（catalog-runtime.mjs 目录聚合 33 行可直抄；catalog.mjs 工具渲染）
   - `vendors/tkaiz0406--dsh-subagent-route-pin/`（index.js 871-903 活校验双 TTL）
   - `vendors/young-tim--dsh-llm-governor/`（routing/strategies.ts 排序策略形状）

## 1. MVP 范围（严格裁剪——可行性测试，非完整 M1）

### 做
1. **Day 1 环境实测（最先做）**：验证 schemastery 嵌套对象（z.object 嵌 z.object 数组）在本机是否存活（07c 记载 z.record 缺失/嵌套丢对象实录）。方法：`npm view schemastery` 确认包存在后在工作区临时目录 `npm i schemastery` 实测（node 优先用宿主捆绑的：先试 `node -v`；不行试 `D:/DSHarness/resources/runtime/bin/node.exe`）；装不了 npm 包则把探针写成 bundle 内自检代码待宿主实测。结论落盘 docs/04-mvp-notes.md，schema 形状跟随结论（对象 or JSON 字符串降级）。
2. **插件骨架**：`D:/Codes/DSH小插件/plugin-mroute/`：
   - package.json（name 建议 `@local/dsh-plugin-mroute`；engines.dsh 兼容声明参考样板）
   - cordis.patch.yml（insert 一行 Host row）
   - index.js（`export function apply(ctx, config)`；注册 Tool + systemPrompt.section）
   - Config schema = 模型注册表
   - locale/（zh/en 至少）、icon.svg（原创简洁，禁默认图）
3. **注册表 Config**：channels[]，字段 id/provider/models[]/channel_type(monthly|voucher|prepaid)/tier(overseas_sota|domestic_sota|bulk)/priority/fallbacks[]/manual{quota_total,quota_used_est,note}/reviewed_at。volatile 化按 07 方案 M1 要点 9 条。
4. **种子数据**：本机 5 provider——deepseek-official(prepaid/domestic_sota/70)、deepseek-account(prepaid/domestic_sota/65)、opencode-go(monthly/domestic_sota/80)、zai-coding-cn(monthly/domestic_sota/90, coding excellent)、xiaomi(prepaid/bulk/50)；fallbacks 合理成链；manual 余额占位 "—"。
5. **model_route_query 工具**：`ctx.tools.register(defineTool(...))`。
   - 入参：`{capability?, tier_min?, exclude_degraded?}`
   - 实现：读 Config → `llm.listProviders()/listModels()` 活校验（provider 不存在→标 unknown 降权；参考 route-pin 双 TTL 但 MVP 可简化为单 TTL 60s）→ 排序：channel_type 一级键(monthly>voucher>prepaid) → tier → priority → id 兜底
   - 返回：结构化列表，每条 {rank, provider, models, channel_type, tier, priority, balance_source:"manual"|"unknown", reason(排序理由), degraded:false(MVP 占位), note}
6. **systemPrompt.section** 一句提示：「派遣子会话前先调用 model_route_query 获取按财务优先级排序的模型渠道推荐」。

### 不做（出界，红线）
HTTP 余额适配器 / UI 面板 / 评测 / 写回 / **llm/stream 与 agent/request 任何改写（红线！）** / policy 交集 / install_bundle（lead 亲自装）。

## 2. 工程纪律
- 纯 JS ESM 无构建（样板形态）；禁 import 宿主 UI 包；MVP 无 HTTP 故无密钥面——保持无密钥面。
- 语法自检：每个 .js 过 `node --check`（node 路径见 Day 1）。
- manifest 自检：对照 host-plugin.md 检查清单（name/version/engines/patch 指向/locale key/icon）。

## 3. 产物
1. `D:/Codes/DSH小插件/plugin-mroute/`（完整 bundle）
2. `D:/Codes/DSH小插件/docs/04-mvp-notes.md`（Day 1 实测结论+降级预案；偏离 07 方案之处逐条+理由）
3. `D:/Codes/DSH小插件/docs/04-mvp-selfcheck.md`（自检报告：语法结果/manifest 清单逐项/红线自查（无 llm-stream、无 agent/request、无凭据面）/已知限制/**lead 安装实测指引**（install_bundle 命令参数+预期验证点））

## 4. 上报纪律（AGENTS.md §2）
开工 brief_echo → 阶段 progress（meta 带证据）→ 每几步 context(pct) → done（meta 精简，完整 self_check 用补充 progress）。树：mvp1，leaf：mvp1-M-mvpdev。水位 42% 自报 context；50% session_handoff 同层交接留痕。
