# 01 — 浮球多渠道余额视觉验收与修复记录

> 会话：orb-visual-2（视觉验收与修复工程师），2026-11-15。
> 范围：dsh-orb-quota 0.2.1-quota.1 多渠道余额展示元素的视觉缺陷定位与最小化修复。
> 交付物：修复源码 + 新 tgz `%TEMP%\dsh-orb-quota-0.2.1-quota.1.tgz`。

## 0. 验收方式声明（重要）

本会话**未获得图像输入能力**，无法真正「看图」：

- `read_image` 报错：当前模型 `deepseek-v4-pro` 不声明图像输入；
- Gemini 视觉通道（gemini-web MCP `gemini_analyze_media`）因 Cookie 过期（SNlM0e token 解析失败）不可用；
- 又派 GLM-5.3-Flash 子会话读图，同样报「不声明图像输入」。

因此以下全部异常判定均为**代码推断**（以「元素重叠遮挡」症状 + 渲染代码反推最可能的重叠对），**无一为「看图确认」**。已第一时间向 lead 上报视觉能力降级并转入纯代码诊断。

## 1. 渲染链路定位（用于反推重叠对）

新增多渠道展示元素有三处，均在既有 orb 渲染层上叠加：

| 新增元素 | DOM 位置 | 渲染/定位代码 |
|---|---|---|
| 卫星贴片多渠道版（56px 贴片，显示最紧急渠道） | `#lasso-ball` > `#lasso-balance`（`assets/floating.html` L112） | `assets/shell.js` `syncLassoSatellite()`/`syncLassoSatellitePosition()`（L2627/L2658）；文本来源 `host/src/quota-feeder.ts` `compactQuotaText()`（L227） |
| hover 气泡（多渠道卡片） | `#quota-popover`（body 层，`floating.html` L113） | `shell.js` `renderQuotaPopover()`/`positionQuotaPopover()`（L2736/L2747）；样式 `floating.css` L1530 |
| panel 卡片（多渠道卡片） | `#quota-card`（`#panel` 内、`#transcript` 前，`floating.html` L32） | `shell.js` `renderQuotaCard()`（L2725）；样式 `floating.css` L1616 |

既有元素：球本体 `#ball`（72px）、托盘 `#dock-tab`、header 按钮 `#history/#permission/#new-conversation`、原有贴片 `#lasso-ball`（本就是它，多渠道只是换了文本内容）、`#transcript`。

## 2. 异常清单（代码推断，带位置 → 根因 → 修复）

### 缺陷 A（major，代码推断）— 卫星贴片文字溢出，压到球本体

**症状推断**：多渠道贴片文本「`小米·余额¥57.93`」约 90+px 宽，远超贴片胶囊 72px 上限，`white-space:nowrap` 且无裁剪 → 文字溢出胶囊，与球本体 `#ball` 重叠、并被 96px 折叠窗口右缘裁断（贴片停在球缘，溢出方向即球体/窗口边缘）。

**根因（文件+行号）**：
- `packages/host/src/quota-feeder.ts` L227-235 `compactQuotaText()`：余额型行取值 `row.text.replaceAll(' ','').slice(0,10)`，把自带描述前缀「余额」一起带上（`小米·余额¥57.93`）；按字符截断（label 5 字 + 值 10 字 = 16 字）在 CJK/ASCII 混合宽度下远超胶囊宽度上限。
- `packages/helper/assets/shell.js` L334 `LASSO_BALANCE_MAX_WIDTH = 72`（胶囊宽度上限，原为账号余额短文本「¥57.93」设计）。
- `packages/helper/assets/floating.css` L1133-1148 `#lasso-balance`：`nowrap` 但无 `overflow:hidden`/`text-overflow`，文字无兜底裁剪。

**修复（最小化，不重构）**：
1. `quota-feeder.ts` `compactQuotaText()`：余额值去掉前导汉字段描述前缀（`replace(/^\p{Script=Han}+/u,'')`），`余额¥57.93` → `¥57.93`，chip 变 `小米·¥57.93`。
2. `floating.css` `#lasso-balance`：加 `max-width:100%; overflow:hidden; text-overflow:ellipsis;` 硬兜底——任何长度都不再溢出贴片胶囊压球。
3. 测试 `packages/host/tests/quota-feeder.test.ts`（chip text 用例）新增断言 `compactQuotaText(xiaomi) === '小米·¥57.93'` 锁定新语义。

### 缺陷 B（major，代码推断）— panel 卡片压住 header 按钮

**症状推断**：展开面板时 `#quota-card` 是 `#panel`（flex column）首个 in-flow 子元素，从面板内容区顶部（padding-top 20px 处）开始排；而 header 三按钮（history/permission/new-conversation）是 `position:absolute; top:12px; z-index:2`。卡片标题「多渠道额度」/刷新时间与三按钮同处 y∈[12,40]px 区间，被 z-index:2 的按钮压住遮挡。

**根因（文件+行号）**：
- `packages/helper/assets/floating.css` L344-350：header 三按钮 `position:absolute; top:12px; z-index:2`。
- `packages/helper/assets/floating.css` L461-470：`#transcript` 用 `padding-top:36px` 给 header 行留白，但卡片在 DOM 里排在 transcript 之前（`floating.html` L32/L39）。
- `packages/helper/assets/floating.css` L1616-1618：`#quota-card` 只有 `padding:8px 12px 6px`，没有 header 行留白 → 首个 in-flow 元素直接撞上绝对定位按钮。

**修复（最小化，纯 CSS）**：
1. `#quota-card` 顶部留白改为 `padding-top:36px`（与 transcript 一致，让出 header 行）。
2. `body.expand-down #quota-card { padding-top:8px }`（向下展开时 header 移到面板底边，顶部卡片无需留白）。
3. `#quota-card:not([hidden]) + #transcript { padding-top:0 }`（卡片可见时已承担 header 留白，transcript 不再重复留白，避免卡片与消息之间出现 36px 空档）。

### 缺陷 C（minor，代码推断）— 折叠态 hover 气泡短暂越界/压球，自愈

**症状推断**：折叠态窗口仅 96×96px，`#quota-popover` `min-width:170px` 无法容纳；`positionQuotaPopover()`（`shell.js` L2747-2757）把 left 夹到 `Math.max(2, innerWidth-width-2)`，在 96px 窗口里恒为 2，气泡右溢约 76px、压住球本体。

**根因**：`shell.js` L2747-2757 `positionQuotaPopover()` 的 clamp 无法让 170px 气泡挤进 96px 窗口。

**处置（不改动）**：这是**瞬态自愈**问题——悬停贴片必先触发 `body.pointerenter` → `syncExpand()` → `setExpanded(true)` 把窗口扩到 320×420px，随后的 `resize` → `syncLassoSatellitePosition()`（`shell.js` L3185）会重新定位气泡到正确位置；折叠态仅闪现一帧被裁断的气泡。判定为 minor，未改动（避免为瞬时闪烁引入回归风险），留待后续若用户感知再处理。

## 3. 确认正常的地方（代码复核，非看图）

- **球本体 × 托盘**：贴片 `#lasso-ball` 在 `body.docked` 下 `visibility:hidden`（`floating.css` L1177-1179），不压托盘 `#dock-tab`。
- **层叠顺序**：`#quota-popover` z-index 6 > `#lasso-ball` z-index 4 > `#panel`（auto），气泡浮于最上、贴片浮于面板——z-order 明确无误（`floating.css` L1081/L1532）。
- **panel 卡片行内文字**：`.quota-row-text` 已有 `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`（`floating.css` L1601-1607），单行不会横向溢出；卡片行数无上限但受 `#panel` flex 布局约束，不越面板容器。
- **贴片与球的位置关系**：贴片本就是「球缘徽标」（`floating.css` L1077 注释），贴片落在球缘属设计内；缺陷只在 A 的文字溢出胶囊，不涉及徽标定位本身。
- **数据管道**：host `lasso-balance`/`lasso-quota` 广播 → helper `sendLassoSatellite()`/`sendQuotaRows()`（`main.ts` L803/L812）→ shell.js 渲染链路完整，无视觉侧丢数据。

## 4. 修复清单与验证

| 文件 | 改动 |
|---|---|
| `packages/host/src/quota-feeder.ts` | `compactQuotaText()` 余额值去前导汉字段前缀 |
| `packages/helper/assets/floating.css` | `#lasso-balance` 加 ellipsis 兜底；`#quota-card` header 留白 + expand-down 回退 + transcript 去重复留白 |
| `packages/host/tests/quota-feeder.test.ts` | 新增 xiaomi 余额 chip 断言 |

验证结果（Windows 10，PATH node v24.20.0 + pnpm 11.7.0，`.cmd` 系）：

- `pnpm.cmd typecheck` → **EXIT=0**（5 个 tsconfig 全过）。
- `pnpm.cmd test` → **606 tests / 599 pass / 3 fail / 4 skipped**，与 M1 基线完全一致；3 个失败全部是既有 Windows 环境性失败（`deferred-install.test.ts` 计时、`voice.test.ts` listen 时序、`child-capture.test.ts` macOS `say` ENOENT），**本次改动零新增失败**。
- `pnpm.cmd build` → **EXIT=0**（host bundle 815.57 kB，assemble 原地产出）。
- `node packages\bundle\scripts\pack.mjs` → **EXIT=0**，tgz 已 move 到 ASCII 路径 `%TEMP%\dsh-orb-quota-0.2.1-quota.1.tgz`（57.1 MB / 1330 entries），tgz 内身份复核 `name=dsh-orb-quota`、`version=0.2.1-quota.1`，且 `floating.css`（`padding:36px 12px` / `#quota-card:not([hidden])+ #transcript`）与 `dist/host/index.js`（`Script=Han` 正则）均已进包。
- 工作区零 tgz 残留（递归扫描 0 命中）。

## 5. 备注

- 修复仅叠加在本 fork（dsh-orb-quota 0.2.1-quota.1），未触碰上游任何既有文件；改动三处均为本 fork 新增/改动文件。
- 未碰 llm/stream、agent/request 红线；`authenticatedUrl`/密钥值未落任何日志与本文档。
- 硬约束遵守：npm 用 `npm.cmd` 系、写文件无 BOM、tgz 移入 ASCII `%TEMP%`、工作区不留 tgz。

## 6. 第二轮修复（lead 实拍复验，2026-11-15 晚）

### 6.1 实拍证据（本轮恢复 Gemini 视觉通道，图为 lead 物理截图 + Gemini 交叉）

lead 反馈修复版已实装，物理截图 + Gemini 实拍双图交叉（`tmp/orb-quota-accept/orb-closeup.png` / `phys-full.png`）。本轮 `gemini_status` 恢复 healthy（token_fetched=true），用 `gemini_analyze_media` 复读两图确认：

- **orb-closeup.png**：球体位于右缘场景，卫星贴片（`#lasso-ball` 胶囊）在球体**下方**、与球体下半部重叠；贴片文字被截断为「智谱 C...」。
- **phys-full.png**：球停靠屏幕最右缘，球体右半部分超出屏幕边界被截断（右缘容器越界）。

lead 归纳三个残留缺陷（severity 见下），本会话据此做第二轮修复。

### 6.2 缺陷与修复（第二轮）

**缺陷 A（major，实拍确认）— 贴片朝屏幕外展开被右缘截断**
- 根因：`assets/shell.js` `syncLassoSatellitePosition()` 只按固定的 `lassoSatellite.position` 方向把贴片放到球缘，不感知球停靠的屏幕侧；球贴右缘时，朝右的方位（`right`/`top-right`/`bottom-right`）仍向右展开，容器伸到屏幕外被裁断。上游贴片是 lasso 卫星球贴片，主球 docked/贴右缘的方位适配是 fork 新增面，缺「朝左展开」分支。
- 修复（`shell.js`）：新增 `ballSideEdge()` 依据主进程经 `orb:expand-state` 镜像到 body 的类（`expand-left`/`docked-right` → 右缘、`expand-right`/`docked-left` → 左缘）判断球停靠侧；`syncLassoSatellitePosition()` 对「贴片指向屏幕边缘侧」的水平分量做镜像（`dx = -base[0]`），使贴片始终朝屏幕内部展开。**约束遵守**：不用 `window.screenX/screenY`（拖拽中会失效，`drag-input.test.ts` 有 `/\bscreen[XY]\b/` 硬断言），只用主进程下发、经 body 类镜像的方位信号。

**缺陷 B（major，实拍确认）— 贴片文案被截成「智谱 C...」信息量不足**
- 根因：`host/src/quota-feeder.ts` `compactQuotaText()` 用 `label.slice(0,5)` 把全名「智谱 Coding Plan · max」截成「智谱 C」，余额值还带「余额」前缀 + 两位小数，塞进 72px 胶囊只显示开头。
- 修复（`quota-feeder.ts`）：新增 `shortPlatformLabel()` —— 中文标签取前导 CJK 串（「智谱 Coding Plan · max」→「智谱」），ASCII 标签取 CamelCase 首字母（「OpenCode Go」→「OC」、「DeepSeek」→「DS」，短单词保留如「Kimi」）；余额值只取首个金额并**取整**（「余额 ¥57.93」→「¥58」），百分比行取整百分数。最终形态对齐 lead 要求：`智谱·40%` / `小米·¥58` / `OC·66%` / `DS·¥49`。

**缺陷 C（minor，实拍确认）— 贴片上缘轻压球底部**
- 根因：贴片中心落在球缘点（`targetX/Y = 球中心 + 方向*半径`），折叠态 96px 窗口内 72px 球 + 26px 贴片本就不足容纳，贴片必然叠在球缘上。
- 处置：**记录不修**。折叠态窗口空间不足是「球缘徽标」的固有形态，强行外移会与窗口越界冲突；仅在「贴片朝屏幕内展开」时不影响可读性。若后续要修，需在展开态单独加外移分支（折叠态除外）。

### 6.3 第二轮验证（Windows 10，node v24.20.0 + pnpm 11.7.0，`.cmd` 系）

- `node --check packages/helper/assets/shell.js` → EXIT=0；`pnpm.cmd typecheck` → EXIT=0。
- `pnpm.cmd test` → **607 tests / 600 pass / 3 fail / 4 skipped**（较上轮 +1 test=新增「shortens long platform labels」，3 fail 仍为既有 Windows 环境性：`deferred-install` 计时、`voice` listen 时序、`child-capture` macOS `say` ENOENT），**本轮零新增失败**；`drag-input.test.ts`「never reads a renderer-side window position while dragging」`/\bscreen[XY]\b/` 断言通过。
- `pnpm.cmd build` → EXIT=0（host bundle 816.44 kB）；`node packages\bundle\scripts\pack.mjs` → EXIT=0。
- 新 tgz：`%TEMP%\dsh-orb-quota-0.2.1-quota.1.tgz`（57.1 MB / 1330 entries，同名覆盖上轮，时间戳 2026-11-15 23:07:24）；tgz 内抽验 `dist/host/index.js` 含 `shortPlatformLabel`/`parseFloat` 取整、`dist/helper/assets/shell.js` 含 `ballSideEdge` 镜像分支。工作区零 tgz 残留、改动文件无 BOM。

### 6.4 遗留与复验提示

- 缺陷 C（贴片叠球底）记录不修（折叠态固有，minor）。
- 镜像依赖主进程 `orb:expand-state` 的 `horizontal`/`docked` 字段：初始默认停靠右缘时 `direction` 缺省为 `horizontal:'left'` → body 得 `expand-left` → 正确判为右缘；拖拽后折叠态的方向类可能滞后，仅在贴片方位含水平分量（`right`/`left`/角位）且用户把球从右缘拖到左缘且不展开的窄场景下有偏差，展开一次即校正。属可接受降级，如需彻底消除须主进程在折叠态也下发球侧（后续 backlog）。
- 建议 lead 复验：①球贴右缘（默认停靠 + 展开态）时贴片是否朝左展开、不再被右缘截断；②贴片文案是否为「智谱·40%」「小米·¥58」这类 ≤8 字符宽完整可读形式。
