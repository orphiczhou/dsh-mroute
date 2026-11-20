# 任务计划书：大肥鱼浮球 × 多渠道额度整合（orb-quota）

> 撰写：lead（root 会话），2026-11-15。**v2（审核修正版）**：异种子模型审核完成（裁决：修正后放行，blocker=0/major=3/minor=5，裁决书 `brief-orb-quota-integration-review.md`），3 条 major 与 5 条 minor 已全部回注本版。
> 流程：本计划书 → 异种子模型审核（✅ 完成）→ 实施派发 → lead 安装实测验收。

## 0. 背景与目标（一句话）

把已实测通过的 **dsh-quota-multi**（多渠道额度数据层：DeepSeek/智谱/OpenCode Go/小米 MiMo 等）聚合读数，显示到已装的 **dsh-orb 大肥鱼桌面浮球**（独立 Electron 常驻、置顶、浏览器关了也在）上——实现「独立桌面悬浮 + 全渠道余额」这个市场空白组合。

**用户命名纪律**：插件名不带渠道字样，用多渠道含义后缀。**定名 dsh-orb-quota**（v2 审核裁决：点明数据源、与 dsh-quota-multi 风格一致；备选 dsh-orb-multi 含义模糊，弃）。

## 1. 两块基座的现成能力（lead 已侦察，证据在案）

### 1.1 orb 侧（vendors/mini-yifan--dsh-orb-cordis/dsh-orb-cordis-main，MIT，已装 0.2.1）

- **现成余额链路**（DeepSeek 登录账号专供）：`packages/host/src/balance.ts`（204 行）定义 `BalanceMonitor` + `BalanceSnapshot{text,full,state}`；`orb.ts` L368-369 持有 monitor，L917 按 `lassoSatellite().enabled && lassoBall().balance` 启用，L1535 回合结束后主动刷新（注释明言"turn 结束是余额真正变动的时候"），L1966-1967 `broadcast({type:'lasso-balance', text, state})` 推给 helper；`routes.ts` L544/579 `lassoBalance()` 供设置页快照；`preferences.ts` L202-209 有 `balance: true` 默认开关。
- **展示面三级**：①56px 卫星贴片（`balance.ts` L32 注释 "Compact text for the 56px satellite"）②settings 卡片（`full` 分组文本）③helper panel（packages/helper，Electron 进程收广播）。
- **架构**：host 半（DSH host 进程内 cordis 插件）+ helper 半（独立 Electron，透明置顶窗）+ bundle（安装器）。monorepo pnpm workspace。
- **THIRD-PARTY-NOTICES.md 已存在**，fork 时沿用并追加。

### 1.2 quota-multi 侧（plugin-quota-multi/，我们的 fork，已装 0.14.10-multi.1）

- **稳定同源 HTTP API**：`src/http.ts` 注册 `/plugins/dsh-quota/api` 前缀路由；`/status` 返回 `{refreshedAt, providers: PanelProvider[], keys, httpPlatforms, currentModel, ...}`（`src/client/controller.ts` L368 是现成消费方）。PanelProvider 含 label/entries（条目文本、百分比、状态）；`currentModel{provider,model,platform,summary}` 可供「当前渠道」映射。
- **settings namespace 真实语义（v2 修正，审核 M1）**：`QUOTA_NS='quota'`（`src/config.ts` L21）**只持久化 `httpPlatforms`**（`state-store.ts` L22 `PERSISTED_KEYS`），运行时快照（providers/refreshedAt/history/currentModel）只活在**内存覆盖层**、不落 namespace——config.ts 头注释的「快照持久化」是 ≤0.1.5 旧语义残留。**跨插件取实时额度数据唯一可靠面 = HTTP `/status`**。
- **自动刷新**：默认 5 分钟（`refreshIntervalMinutes` 可调），凭证变更自动触发。

## 2. 架构决策（待审核裁决的核心问题）

### 2.1 数据从哪来——三条路线

| 路线 | 做法 | 优劣 |
|---|---|---|
| **A（主推，审核同意）** | orb host 半消费 quota 的 `/status` HTTP API | 单一数据源，零查询代码复制，quota-multi 升级只要 API 形状不变就不坏；缺省时 orb 退回现有 DeepSeek 账号余额。风险：跨插件消费无公开契约——用运行时探测（route 存在才启用）+ 冻结点写进维护兜底 |
| B | 把 quota-multi 的 direct.ts 适配器移植进 orb host | 双份查询代码 + 双份 key 管理 + 漂移风险；违反「移植即冻结」最小化原则（审核：反对正确） |
| C | quota-multi 侧主动推送快照给 orb | 方向反了（orb 是展示端）；quota 刷新节奏与 orb 展示节奏解耦更稳（审核：反对正确） |

**A 的实现要点（v2 修订，审核 Q1/M1/m3 + mroute M2 交叉实证）**：
- orb host 半新增 `quota-feeder.ts`——定时（对齐 BALANCE_REFRESH_MS 5min）+ 事件驱动（回合结束，沿用 orb.ts L1535 模式）拉 `/status`，归并成 `MultiBalanceSnapshot`，沿用 broadcast 通道（新增 `type:'orb-quota'` 消息或扩展 `lasso-balance` payload——helper main.ts L610/L772 已有现成接收渲染管道，向后兼容）。
- **地址/鉴权（审核已解，无需 M0 再探）**：orb 已注入 `webServer` + `connection` 服务（orb index.ts L22-29），现成取法 `ctx.webServer.port` + `ctx.connection.authenticatedUrl('http://127.0.0.1:${port}')`（orb index.ts L161-172；open-main.ts L9-12 同款）。**交叉实证（2026-11-15 mroute M2）**：同进程 loopback `GET /plugins/dsh-quota/api/status` 已被 mroute 方案采用并论证——GET 免 CSRF，`webServer.getOrigin()` 亦可取基址；quota 插件是 function-plugin 形态（controller 为闭包局部）**不可 inject 直取，HTTP 快照是唯一干净面**——进一步坐实 A 主路线、排除服务注入备选的必要性。
- **纪律（m3）**：authenticatedUrl 带凭据，**严禁写日志/任何产出文件**（orb 既有纪律 open-main.ts L2-3、orb index.ts L160-161）。

### 2.2 展示怎么排——三级展示面的多渠道路由

- **卫星贴片（56px 空间极小）**：默认显示「最紧急」的一条，hover 展开完整列表（helper 已有 hover 展开 panel 机制）。审核同意「最紧急优先」，轮播作可选项保留。**阈值口径（v2，审核 m2）**：quota 数据侧只有 `alertPercent=85`（红档，config.ts L147/L195）——orb 侧展示分档为自定约定，取条目 `percent` 字段（窗口型=已用百分比），黄档阈值做成偏好可配置（默认 60），**tie-break 确定性规则：同百分比按平台 id 字典序**；无超阈值渠道时显示 `/status.currentModel.platform` 对应渠道（映射已可行，审核 Q3 确认）。
- **panel 卡片**：展开 panel 时显示完整多渠道卡片（每家一行：label + 关键读数 + 状态点），点击卡片跳 DSH 主窗口 quota 面板（orb 有 open-main 能力）。
- **设置页**：`Settings → Floating Ball` 现有 balance 开关扩展为「余额来源：DeepSeek 账号 / 多渠道聚合 / 关」三选 + 各渠道显隐开关（沿用 preferences.ts 的 lassoBall 结构）。

### 2.3 降级与互斥

- **降级（v2 扩充，审核 m1）**：quota-multi 未装/未激活/route 404，**或 `/status` 200 但 providers 为空/全部非 ok**（无 key→missing-key、MCP 未注册→整行隐藏，quota 面板真实会出现）→ orb 静默退回现有 DeepSeek 账号余额（行为与上游 0.2.1 一致），日志一行。降级状态机直接复用 balance.ts 的 `EMPTY_BALANCE`/`'unavailable'`/`'signed-out'`（审核确认可行）。
- **互斥安装（v2 修正，审核 M2——insert id 口径，非「bundle id」）**：互斥靠 cordis.patch.yml 的 **insert id**。orb 上游有**五个** insert id：`preset-computer-use`/`orb-code-agent-registry`/`orb-lasso`/`orb-host`/`ui-settings-orb`——fork **全部保持不变**；安装前上游 dsh-orb 0.2.1 **先移除**（quota-multi 先例：包名不同但 `id: quota` 不变实现干净替换）。与 dsh-quota-multi 正常共存（不同插件、不同 insert id）。
- **package 改名涟漪（v2 新增，审核 M2）**：改名 `dsh-orb-quota` 波及三处，M1 逐项过：①bundle package.json 的 exports 子路径（L25-52）；②`assemble.mjs` 的 `OLD_CLIENT_ID`/`NEW_CLIENT_ID` 重写常量（L25-27）；③cordis.patch.yml 各 entry 的 `name:` 字段（如 `dsh-orb/host` → `dsh-orb-quota/host`）。
- 凭据纪律：orb 只消费快照文本/数字，**不碰 key、不碰 credentials**（现 orb balance.ts 本来就是这个模式，L4-5 注释明言；quota 侧 `keyStatus()` 也只出 ref/source 无 value，controller.ts L900-916——两条安全边界已对齐，审核确认）。

## 3. 实施阶段划分

- **M0 侦察与去险 spike（1 天，v2 调整，审核 m5）**：①构建链空跑——上游 fork 原样 `npm.cmd install` + 跑 bundle 构建脚本（pack.mjs 需 `tar`+`npm.cmd`+网络抓 darwin/win32 平台 prebuilds：koffi/zod/sherpa/node-cpal/pinyin-pro，pack.mjs L68-127），确认本机 Windows 能出 tgz；②PanelProvider/entries 确切形状核对（controller.ts + client 消费面）；③helper 侧 satellite/panel 渲染点定位（main.ts L610/L772 起）；④运行时 catalog 级确认 `webServer`/`connection` 服务面（本 build inspect exact-query 损坏，只能无参 catalog——审核 §6 诚实声明项）。**退出条件**：构建链空跑成功（不满足→立即降级「只发 host 半 + 复用已装 0.2.1 的 helper」并报 lead）或明确降级决策；蓝图落盘。产出：`plugin-orb-quota/docs/00-blueprint.md`（改造文件清单 + 接口冻结点 + 构建命令序列）。
- **M1 实现（1-2 天，M0 去险后成立）**：fork `vendors/mini-yifan--dsh-orb-cordis` → `plugin-orb-quota/`；按蓝图实现 quota-feeder + 三级展示 + 偏好设置 + 改名涟漪三件套（exports/assemble.mjs/cordis.patch.yml，见 §2.3）；**升级兼容决策（v2，审核 M3）：保留 `dshHomePath('dsh-orb', ...)`（orb.ts L351）**——已装 0.2.1 用户的浮球位置/皮肤/balance 开关无缝延续（互斥安装下无冲突，定位是「升级」非「新装」）；跑通构建链出 tgz；NOTICE.md + THIRD-PARTY-NOTICES.md 追加。
- **M2 验收（lead）**：安装（ASCII 路径 tgz 纪律，先 remove 上游 dsh-orb 0.2.1）→ 重启 DSH → 浮球上看到多渠道读数（小米 ¥/智谱百分比/OpenCode 窗口）→ quota_refresh 与浮球显示一致性抽查 → 降级测试（停用 quota-multi 后浮球退回 DeepSeek 余额）。

## 4. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| orb 构建链复杂（Electron helper 打包、安装器 bundle）在 Windows 本机跑不通 | 高 | M0 先空跑一次上游构建；不行则降级「只发 host 半 + 复用已装 orb 的 helper」（helper 不改，仅 host 推新消息类型被旧 helper 忽略——向后兼容） |
| 跨插件消费 quota API 无契约 | 中 | 运行时探测 + 形状断言 + 冻结点记录；**两 fork 的 `/status` 形状 lockstep 共版**（quota-multi 是我们的 fork，双端同步改——v2 补审核 m4） |
| 中文路径/编码坑复发 | 中 | 全程 ASCII 路径纪律（AGENTS.md §9 实录）；tgz 只进 $env:TEMP |
| 卫星贴片 56px 塞不下多渠道 | 低 | M1 按「最紧急一条 + hover 展开」做，不硬塞 |
| **升级兼容（v2 新增，审核 M3）**：已装 0.2.1 用户设置连续性 | 低 | **决策：保留 `dshHomePath('dsh-orb', ...)`**——浮球位置/皮肤/开关无缝延续（互斥安装下无冲突，定位为「升级」） |
| **宿主策略门拒显式 assignee（2026-11-15 mroute M2 实录）** | 低 | 实施派发**省略 assignee 继承父路由**（zai-coding-cn monthly，proven）；异种子审核已完成不受影响 |

## 5. 审核问题清单（✅ 已裁决——完整裁决见 `brief-orb-quota-integration-review.md`）

1. 路线裁决：**同意 A**（附 M1 事实修正：删 settings namespace 兜底；HTTP 为主，`ctx.provide` 服务注入仅列备选且 mroute M2 交叉实证已排除必要性）。
2. 命名裁决：**dsh-orb-quota**（不带渠道字样合规，点明数据源；备选 dsh-orb-multi 含义更模糊）。记录级，不阻断。
3. 贴片策略：**同意「最紧急优先 + hover 展开」**（m2 阈值/tie-break 细节已回注 §2.2）。
4. 降级：**方向同意**（互斥机制表述修正已回注 §2.3——insert id 口径 + 五 id 枚举 + 先移除上游；m1 空 providers 场景已补）。
5. 阶段：**基本合理**，M0 加码为 1 天 spike + 明确退出条件（已回注 §3）。
6. 风险：**2 处并入 major 已回注**（升级兼容行 + 互斥/涟漪），3 处 minor 已吸收（m3 日志纪律 §2.1、m4 lockstep §4、m5 M0 时长 §3）。
7. 红线：**零触碰**（审核逐条确认；m3 附注已回注）。

## 6. 交付物与验收口径（实施完成后）

- 源码 `D:\Codes\DSH小插件\plugin-orb-quota\`（NOTICE.md 记 mini-yifan/dsh-orb-cordis MIT 出处 + 移植即冻结；THIRD-PARTY-NOTICES.md 追加）
- tgz 产出到 `$env:TEMP`（ASCII 路径）
- lead 实测：浮球多渠道显示 + 一致性 + 降级，三项全过才算收口
