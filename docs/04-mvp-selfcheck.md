# 04-mvp-selfcheck.md — mroute MVP（mvp1-M）自检报告

- 树节点：mvp1 / leaf：mvp1-M-mvpdev
- 日期：2026-11-13
- 交付物：`plugin-mroute/`（完整 bundle）+ `docs/04-mvp-notes.md`（Day 1 实测）
- 本报告对应任务书 §3 产物 3：语法结果 / manifest 清单逐项 / 红线自查 / 已知限制 / lead 安装实测指引

---

## 1. 语法自检（node --check，PATH node v24.20.0）

| 文件 | 结果 |
|---|---|
| index.js | OK |
| lib/config-schema.js | OK |
| lib/registry.js | OK |
| lib/volatile.js | OK |
| lib/livecheck.js | OK |
| lib/errors.js | OK |
| lib/ranking.js | OK |
| lib/tool-query.js | OK |
| lib/prompt-section.js | OK |

9/9 通过（package.json scripts.check 汇总同一命令集）。

## 2. 离线冒烟测试（tmp/mvp-smoke/，mock ctx.llm + mock exec，同版 schemastery@3.19.0）

8 组断言全过（运行记录：`node tmp/mvp-smoke/mvp-smoke.mjs` 输出，junction 供包后已删）：

1. Config schema 默认值 = 5 种子渠道，volatile 访问器正确解出、manual 默认回填 ✓
2. readRegistry 双面读取（裸值面 / Volatile 引用面）✓；种子无悬空告警 ✓；悬空 fallbacks 告警（不拒写）✓
3. execute() 全链路排序顺序：`zai-coding-cn > opencode-go > deepseek-official > deepseek-account > xiaomi`
   （monthly 90/80 → prepaid domestic_sota 70/65 → prepaid bulk 50）✓
4. 返回对象键与 output.schema 声明逐字段一致（route 12 键 / meta 4 键 / 顶层 4 键）✓
5. unknown 降权：provider 缺席渠道沉底第 5 位 + livecheck=unknown + reason 含「沉底」✓；
   目录读取失败不缓存（两次 check 均实时、cache.size=0，route-pin L879-884 纪律）✓
6. tier_min=domestic_sota 过滤 + excluded 留痕 ✓
7. capability no-op 标注 + 文本渲染（中文清单 + 理由行 + 备注行）✓
8. 确定性重放：同输入两次全序一致 ✓

## 3. 红线自查（grep 证据）

| 红线 | 检查 | 结果 |
|---|---|---|
| 不碰 `llm/stream` / `agent/request` / `system-prompt/assemble` | grep `llm/stream\|agent/request\|system-prompt/assemble\|on\('` 于 plugin-mroute/ | 仅 index.js 注释与 README 文字提及；**代码零 `ctx.on(...)` 注册** ✓ |
| 无 HTTP 出站 / 无凭据面 | grep `fetch\|http\|credentials\|apiKey\|api_key\|secret\|token`（*.js） | **零命中** ✓（无 fetch、无 credentials inject、无密钥字段） |
| 不做 UI / 评测 / 写回 | 代码走查 | 无 slots.inject、无 webServer、无 configEditor 调用 ✓ |
| 不做 install_bundle | 本会话未调用 plugin_manager ✓（lead 亲自装） |
| 唯一提示注入 = systemPrompt.section（最弱机制） | lib/prompt-section.js 唯一 ctx.systemPrompt.section 调用；practices.md L17 允许 ✓ |

## 4. manifest 清单逐项（对照 asar skills/dsh-doc/references/host-plugin.md）

| 项 | 声明 | 判定 |
|---|---|---|
| name 唯一 | `@local/dsh-plugin-mroute` | ✓ |
| version | 0.1.0-mvp.1 | ✓ |
| type/exports | `"type":"module"`；`.`→./index.js；`./package.json`；`./locale/*.json`；`./icon`→./icon.svg | ✓ |
| files | index.js / lib/ / cordis.patch.yml / locale/*.json / icon.svg / README.md / LICENSE / NOTICE.md（本地目录安装链接 checkout，files 不过滤；清单与实文件 18 个一致） | ✓ |
| dsh.bundle.patch | ./cordis.patch.yml | ✓ |
| dsh.engines.dsh | `>=0.2.1-rc.3`（宿主 0.2.2-rc.3 满足；与已装先例 dsh-subagent-setup 同线） | ✓ |
| patch row | insert 一行：id `mroute`（唯一）、name 同包名、`config: {}`（种子由 schema default 承载，patch 注释注明） | ✓ |
| 导出形态 | name / inject / Config / apply 四导出；apply 函数形态，无 default export 混用；返回 cleanup dispose | ✓ |
| inject 名核实 | `tools` / `llm` / `systemPrompt`（dsh-subagent-setup 同款已装先例，非猜测） | ✓ |
| locale | en/zh 双语 meta.title + meta.description（无模板残留文案；英文 sentence case） | ✓（双文件 JSON parse 通过） |
| icon | 原创 SVG，36×36 viewBox，683B（限 256KiB），无背景块/无脚本/无 <text>，包内路径 | ✓ |
| detail 页 | 未设 meta.detail → 回落 README.md（host-plugin.md L34 允许）；README 含功能/用法/限制 | ✓ |
| 依赖显式声明/无构建/无安装脚本 | dependencies **已声明** `@deepseek-ai/schemastery ^3.19.0`（package.json:36-38；初版手写漏声明致激活失败 ERR_MODULE_NOT_FOUND，安装期修复回写，教训已固化 AGENTS.md §4）、无 scripts.install、纯 JS ESM（本行 2026-11-13 审计 m-1 回注更正：原「dependencies 空」为初版时点陈述，与当前代码不符） | ✓ |

## 5. 已知限制（MVP 范围内明示，不阻塞可行性结论）

1. `balance_source` 恒 manual（占位"—"，note 标注「自动余额 M2 接入」）；无健康状态机，`degraded` 恒 false（任务书明示占位）。
2. `capability` 参数 no-op（注册表无结构化能力数据；reason 中标注），M2 接入。
3. opencode-go / xiaomi 的 `models[]` 为空 + note「待首轮复核」——活校验模型级差异只标注不降权（建议性 catalog）。
4. 活校验为单 TTL 60s（任务书允许简化）；「读不到不缓存」纪律保留。
5. systemPrompt 一句提示与已装 dsh-subagent-setup 的路由清单段可能并存（07 方案 §4.4 同装二选一建议仍有效；MVP 不做互斥处理）。
6. 排序二级键 tier 方向（overseas_sota > domestic_sota > bulk）为 MVP 落码裁决，任务书未给方向（docs/04-mvp-notes.md §2.1 已记）。
7. 探针与冒烟均为 npm 同版本近似：宿主 loader 内嵌行为（volatile 更新路径、设置面板渲染）以 lead 安装实测为准（04-mvp-notes.md §1.5 降级预案待触发观察）。
8. **FR-A3-4 90 天 review_alerts 未实现（审计 m-3 补记）**：需求说明书 docs/01:117 的「reviewed_at 超 90 天附复核提示」属 FR 承接期 M1/P0 范围，MVP 未实现（种子 reviewed_at 均为当日暂无功能影响）；M1 后续随 policy.js/registry-read 复核锚告警一并落地。

## 6. lead 安装实测指引

### 6.1 安装

```
plugin_manager { action: "install_bundle", target: "D:/Codes/DSH小插件/plugin-mroute" }
```

- 预期：application=applied（或 restart-required → 重启后生效）；无需 approvedBuilds（无安装脚本）。

### 6.2 预期验证点（对应 00§6-M1 验收 + MVP 裁剪）

1. **manifest/资源**：Plugins 页出现 mroute 行，标题「模型路由参考」/「Model route advisor」，图标为「排序条+箭头」原创图形（en/zh 双语描述正确，无 metadata diagnostic）。
2. **systemPrompt**：新会话提示文本出现「派遣子会话前先调用 model_route_query……」段（section 名 tool:mroute:route-hint）。
3. **工具调用**：会话内调 `model_route_query {}`——预期返回 5 渠道排序表（顺序见本报告 §2-3），每条含 reason/note/balance_source=manual；`current` 字段显示当前会话路由。
4. **活校验降权**：把某渠道 routeProvider 改成本机不存在的值（设置面板或 patch config）→ 再次查询，该条沉底末位、livecheck=unknown、reason 含「未注册（可用: …）」；60s 内重复查询命中缓存，改回后恢复。
5. **过滤**：`model_route_query { "tier_min": "bulk" }` 全量；`{ "tier_min": "domestic_sota" }` 剔除 xiaomi 进 excluded。
6. **volatile 热更 + 嵌套存活（04-mvp-notes.md §1.5 降级预案触发观察点）**：设置面板编辑某渠道 manual.note 保存 → 不重启直接查询，note 变更生效且 manual 三键齐全；若键丢失 → 触发 JSON 字符串降级预案。
7. **可读校验错误**：patch config 写入不合 schema 的 channels（如 channel_type 拼错）→ 激活时报可读校验错误而非静默。
8. **停用回收（审计 M-2 配套检查项，lead 实测）**：`set_bundle` 停用插件（或 remove_bundle）后**新开会话**调 `model_route_query` → 预期工具不可见（not found）；systemPrompt 中 route-hint 段同时消失。实现已改「注册即 effect」（ctx.effect 包裹 dispose，先例 dsh-subagent-setup plugin/index.js:345-352），停用/卸载由宿主 fiber 精确回收；本会话无法自测停用路径，此项由 lead 在重装实测时顺带验证并回记结果。

### 6.3 卸载/回退

`plugin_manager { action: "set_bundle", target: "@local/dsh-plugin-mroute", enabled: false }` 停用；`remove_bundle` 移除。插件无持久化副作用（零写盘），停用即净。

---

*自检口径：执行者自查 + lead 定向复核（AGENTS.md §4，不用 adversarial）。全部证据可复现：语法（§1 命令）、冒烟（tmp/mvp-smoke/）、grep（§3 模式）、manifest（§4 逐项）。*

---

## 7. 审计修复回注（A 组 8 项，2026-11-13，对应 docs/03-audit-report.md §5 A 组）

| # | 修复内容 | 状态 | 落点与验证 |
|---|---|---|---|
| M-1 | NOTICE.md autotier 许可标签 MIT → **Apache-2.0** | ✅ 已修 | NOTICE.md 借鉴表 autotier 行（LICENSE:1-2 实证 Apache License 2.0；「仅参考未拷码」下 Apache-2.0 无携带义务，理由随行注明） |
| M-2 | 工具注册与 systemPrompt 注册改 **ctx.effect(() => dispose, 'mroute: …')** 包裹 | ✅ 已修 | index.js 两处注册均按先例（dsh-subagent-setup plugin/index.js:345-352）包裹；自制 disposers 数组与「apply 返回 dispose」**整体删除**（该宿主语义无文档明证）；§6.2 新增第 8 检查项「停用插件 → model_route_query 不可见」（lead 实测） |
| m-2 | 重复 id：采用**读侧真去重**（filter 首个生效） | ✅ 已修 | registry.js 读时去重（seenIds + continue），告警文案改「读时去重，仅首个生效」——文案与实现一致；排序层只见去重后清单 |
| m-3 | selfcheck §5 补记 FR-A3-4 缩水 | ✅ 已修 | §5 第 8 条（reviewed_at 90 天复核提示未实现，M1 后续） |
| m-8 | tool-query.js TIER_RANK 直读 → **rankOf（hasOwnProperty 口径）** | ✅ 已修 | ranking.js 的 rankOf 升为 export（本模块唯一实现），tool-query.js tier_min 过滤改 `rankOf(TIER_RANK, tier)` / `rankOf(TIER_RANK, tierMin)` 双侧统一，杜绝 `__proto__` 键旁路 |
| m-9 | registry.js channels 元素级 null 防御 | ✅ 已修 | 读侧 `filter(ch => ch !== null && typeof ch === 'object' && !Array.isArray(ch))`（比裁决书建议多挡数组元素） |
| m-10 | dependencies 锁 exact **3.19.0**（去 ^） | ✅ 已修 | package.json dependencies；**package-lock.json 根 specifier 同步 `^3.19.0` → `3.19.0`**（消除 npm ci 校验不一致）；node_modules 安装件（3.19.0）未动 |
| m-4 | NOTICE.md 增「依赖包出处」节 | ✅ 已修 | 三包版本/许可自 node_modules 安装件实读：schemastery@3.19.0 MIT（Shigma）、cosmokit@1.9.0 MIT（Shigma）、@standard-schema/spec@1.1.0 MIT（Colin McDonnell） |

修复后回归：**node --check 9/9 通过；离线冒烟 8 组断言全过**（含去重/防御/rankOf 改动后的排序顺序与 tier_min 过滤复测）；node_modules 零改动。未执行 install_bundle（lead 统一重装实测）。

---

## 8. M1 增量回归（0.2.0-m1.0，2026-11-13，执行者 m1-dev）

实现明细与逐项落点见 `docs/05-m1-devlog.md`；本节只记自检结果。

### 8.1 语法自检

| 文件 | 结果 |
|---|---|
| index.js / lib/config-schema.js / lib/registry.js / lib/volatile.js / lib/livecheck.js / lib/errors.js / lib/ranking.js / lib/tool-query.js / lib/prompt-section.js | OK |
| lib/decision-log.js（M1 新增） | OK |

10/10 通过（package.json scripts.check 已同步同一命令集；PATH node v24.20.0）。

### 8.2 离线冒烟（tmp/mvp-smoke/mvp-smoke.mjs 重写后实跑）

- **MVP 既有 8 组回归全过**：组 1/2/2b/2c/3/5/5b/6/8 原样；组 4（键一致性）按新 output schema 修订为「required 全在 + 无声明外键 + warning 形状」双向断言；组 7 按 capability 生效语义修订为命中/无数据三分断言（行为变更非回归，devlog §2-1）。
- **M1 新增 11 组全过**：
  1b schema 层四件（status 默认 active / zai coding=excellent / 无数据键省略 / enforce_gate 缺省 false+类型断言+opt-in 可过 / eval={} 占位）；
  2d status 读侧兼容（缺字段静默=active 零告警、非法值告警降级）；
  9 disabled 零拦截（在表、rank 原位 3、excluded 空、warning{disabled, fallbacks 首选}、渲染 ⚠）；
  9b exhausted + low_balance（quota_total='5'<10 CNY 阈值、rank 原位）+ 占位"—"恒不触发；
  10 enforce_gate 读侧缺省 false + true 透传；
  11 capability fair 未命中不过滤 + 字面 'null' 串视为无数据；
  12 DecisionRecord JSONL 落盘（文件名 YYYYMM、逐行 JSON.parse、形状五键、reason_head 截断、与 meta.generated_at 一致）；
  12b 写失败静默降级（baseDir=普通文件 → 查询仍返回 5 条 + warn 日志）；
  13 review_alerts 触发/不触发（超期文案含「建议人工复核」与阈值 90；空/不可解析日期不触发）。

### 8.3 M1 红线 grep（同 §3 口径复跑）

| 红线 | 结果 |
|---|---|
| llm-stream/agent-request/system-prompt-assemble/`.on(`/tools.guard 接线 | 仅 3 处注释（index.js:8 / config-schema.js:143 / registry.js:86），代码零命中 ✓ |
| HTTP 出站/凭据面（fetch/http/credentials/apiKey/api_key/secret/password） | 代码零命中 ✓（`token` 等仅 node_modules 第三方内部命中） |
| 唯一新增写面 | lib/decision-log.js 本地 JSONL 追加（无网络/无凭据），「零写盘」表述据此更新为「唯一写面=DecisionRecord」（devlog §2-6） ✓ |

### 8.4 已知限制变化（对 §5 的增量更新）

- §5-2「capability 参数 no-op」→ **M1 已升级为标注级生效**：命中/未满足/无数据三分 reason 标注；强过滤（不入 routes[]）仍留 M2 门槛映射裁决。
- §5-8「FR-A3-4 90 天 review_alerts 未实现」→ **M1 已实现**（工具返回侧；面板侧仍属 M4）。
- 新增：低余额阈值内置 10 CNY（M2 可配置化）；suggestion 不避开告警目标（M2 小改）；DecisionRecord 完整版（逐项加减分/meta 失败标注）属 M2 账本层。
- §6 lead 安装实测增补验证点：①查询返回含 warning/review_alert 字段且 disabled 渠道在表中；②`~/.dsh/mroute/decisions/decisions-YYYYMM.jsonl` 生成且逐行可 parse；③设置面板编辑 manual.status=disabled → 查询带 warning（volatile 热更）。安装坑提示（AGENTS.md §9 实录）：本插件位于中文路径，重装建议 `npm pack` 到纯 ASCII 路径再 install_bundle（本插件无 prepare 钩子，`--ignore-scripts` 安全）。
