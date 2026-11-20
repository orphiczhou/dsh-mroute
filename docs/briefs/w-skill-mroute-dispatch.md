# 任务书：mroute 使用细则 skill（W-skill）

## 0. 一句话
把 mroute 插件的「怎么用」写成一份可被 DSH 按需加载的 skill（`mroute-dispatch`），发布到本 DSH 全局 skills 目录，并用洁净室测试证明它有效。

## 1. 环境与已有资产（必读，别重复造）
- 插件：`D:\Codes\DSH小插件\plugin-mroute\`（v0.8.2-m4.11，工具 `model_route_query` / `mroute_dispatch_plan` / `model_route_sync_models` / `model_route_alias_suggest`）。
- 插件全局 systemPrompt 提示句：`plugin-mroute/lib/prompt-section.js`（`SECTION_TEXT`，order 116.5）。
- 设计/算法文档：`docs/06-recommendation-algorithm.md`（排序与维度定稿）、`docs/05-m3-devlog.md`（里程碑与坑）、`mroute/07-assembly-plan.md`。
- 全局 skills 目录：`C:\Users\sir_c\.dsh\skills\`（已有 dsh-flow-engine / html-explainer / meta-run-intake / rsi-harness 四个 skill，**照它们的目录形态**：`<name>/SKILL.md`）。
- 工作区副本目录用 `D:\Codes\DSH小插件\skills\mroute-dispatch\`（先在这里写，验收后我再发布到全局）。

## 2. 交付物
1. `D:\Codes\DSH小插件\skills\mroute-dispatch\SKILL.md`（≤160 行）
   - YAML frontmatter：`name: mroute-dispatch`、`description:` 2-4 句英文+中文混合的触发描述，必须覆盖这些触发词/场景：派遣子会话、选模型、模型优先级、余额/额度、包月渠道、策略门被拒、能力档位、模型归并、动态沉底、mroute_dispatch_plan、model_route_query、dispatch subagent model。
   - 正文用小标题分节，至少包含：
     1) **何时用**（要派 subagent/tree_dispatch 之前；要回答「用哪个模型/还有多少额度」时；面板设置怎么改）。
     2) **三步流程**：先 `mroute_dispatch_plan`（可选 `need`/`limit`/`channel_type`）→ 按返回顺序填 `assignee{provider,model}` → 被宿主策略门拒（`child LLM route is not allowed`）就换下一项，全被拒则省略 assignee 继承父路由。
     3) **怎么读返回**：`rank. provider / model [channel_type · tier · priority]`、`🌕/🌓/💰`、`fit=/min=`、`⚠` 尾注、头部 `queried_at` + 快照新鲜度（≤300s 新鲜）。
     4) **need 六维**：coding / tools / long_context / vision / world_knowledge / orchestration × fair|good|excellent（AND 语义，`none` 与「未登记」的区别）。
     5) **常见坑**：新鲜度过期要重查；quota 插件停用→余额回落 manual（工具仍可用）；`unknown tool` 多半是插件未激活或 schema 注册失败；advisory-only——工具只建议不阻断，最终选择权在会话与用户；不要硬编码模型名（渠道目录会变，用 `model_route_sync_models` 同步）。
     6) **面板**：设置 →（左下角账号菜单）→ 模型路由：渠道卡折叠、`低余额阈值/周阈值/5h 阈值`、模型归并、统一模型名能力档位（含「无」）、动态层（最近一次查询快照，只读）。
   - 纯 markdown、无 tab、不写任何密钥/token/路径中含用户名的敏感信息。
2. `D:\Codes\DSH小插件\skills\mroute-dispatch\references\tools.md`：四个工具的入参/出参/示例（照 `plugin-mroute/lib/tool-*.js` 的 schema 与 `docs/06` 对照，**逐条带源码行号**）。
3. `D:\Codes\DSH小插件\skills\mroute-dispatch\references\troubleshooting.md`：症状→原因→处置（unknown tool / 余额不显示 / 面板空态 / 保存 settings/conflict / BOM / 策略门拒绝 / stale 快照）。
4. 自检脚本 `D:\Codes\DSH小插件\skills\mroute-dispatch\check.mjs`（node，无依赖）：校验 frontmatter 存在且 `name` 与目录名一致、`description` 长度 40-600、SKILL.md 行数 ≤160、无 `\t`、references 两个文件存在且行数 ≥20、正文包含必需小标题关键词（`三步流程`/`need`/`advisory-only`/`mroute_dispatch_plan`）。跑 `node check.mjs` 输出 `OK` 或失败原因。

## 3. 红线
- **只写 skill**，不改 `plugin-mroute/` 任何代码（除发现文档与代码矛盾时在报告里指出，不擅自改）。
- 不复制 `docs/06` 全文（skill 要短、可执行），关键结论用一句话 + 指向文档章节。
- 不发布到全局（`C:\Users\sir_c\.dsh\skills`）——那一步由 lead 做（用户要求「确认有效好用后」才发布）。
- 中文正文（专业术语保留英文原词），English triggers 放 description。

## 4. 验收（你自报的 DoD）
- `node check.mjs` 输出 OK；`SKILL.md` 行数、frontmatter 原文、两个 references 的行数一并贴出。
- 报告里列出你从 `plugin-mroute/lib/*.js` 核对过的 5 处事实（工具名/入参名/闭集值/阈值默认值/新鲜度秒数）及行号，证明 skill 内容与代码一致（不要凭 `docs/` 二手描述）。
- 报告最后给出「洁净室测试建议」（lead 会在干净工作区派新会话验证 skill 是否被发现并遵循），列出 3 条可观测判据（如：新会话在派发前调用了 `mroute_dispatch_plan`、assignee 取自清单首项、被拒后有降级）。

## 5. 上报纪律
开工先回 brief_echo；完成后一次 done：文件清单 + 行数 + check 输出 + 5 处代码核对行号 + 3 条洁净室判据。别写长文，控制在 40 行内。
