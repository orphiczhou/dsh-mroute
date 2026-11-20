# 00 · M0 侦察去险蓝图 — dsh-orb-quota（大肥鱼浮球 × 多渠道额度整合）

> 执行：orb-dev（subagent），2026-11-15。上游基线：`vendors/mini-yifan--dsh-orb-cordis/dsh-orb-cordis-main`（mini-yifan/dsh-orb-cordis，MIT，bundle `dsh-orb@0.2.1`）。
> 计划书正源：`docs/briefs/brief-orb-quota-integration.md`（v2 审核修正版）；裁决书：`brief-orb-quota-integration-review.md`。
> 本文 = M0 四项产出（构建链空跑 / PanelProvider 形状核对 / helper 渲染点定位 / webServer·connection catalog 确认）+ M1 改造蓝图（文件清单 / 接口冻结点 / 构建命令序列）。

## 1. M0 退出结论

**构建链全通，不触发降级路径（"只发 host 半"不启用），M1 按"完整 fork（host+helper+bundle）"实施。**

| # | M0 项 | 结果 | 证据 |
|---|---|---|---|
| ① | 构建链空跑（fork 上游原样→install→build→pack→tgz） | ✅ 全绿 | 上游原样复制到 `%TEMP%\orb-m0-spike`（ASCII）→ `pnpm.cmd install --no-frozen-lockfile`（9.1s，204 包，koffi prebuild 脚本正常跑）→ `pnpm.cmd build`（7 包 tsdown + bundle assemble 全部 Build complete）→ `node packages\bundle\scripts\pack.mjs`（PACK_EXIT=0，`dsh-orb-0.2.1.tgz` **59,867,615 字节**，1330 entries）。pack 依赖的 `tar`（bsdtar/GNU）与 `npm pack`+registry.npmmirror.com 平台包抓取（darwin koffi×2 / sherpa×2 等）全部在本机走通 |
| ② | PanelProvider/entries 形状核对 | ✅ 定案 | `plugin-quota-multi/src/client/controller.ts` L14-44：`PanelItem{label,used?,limit?,remaining?,percent?,resetAt?,display?,burnRatePerHour?,etaMinutes?,weeklySpent?,spendWindowMs?}`、`PanelProvider{id,label,status:'ok'|'error'|'missing-key'|'missing-mcp',message?,via?,keyRef?,keySource?,items[]}`；`/status` 顶层形状 http.ts L35-36（另含 refreshedAt/keys/httpPlatforms/formats/loginFlows/keyPlatforms/providerKeyRefs/alertPercent?/history/currentModel?）；`currentModel{provider,model,platform,summary}` config.ts L149-158。**凭据面复核：`keys` 走 `keyStatus()` 只出 `{configured,source,ref}`，无 value** |
| ③ | helper 渲染点定位 | ✅ 定案 | 接收链：host `broadcast({type:'lasso-balance',text,state})` → helper `main.ts` L610-619 存入 `chrome.lassoBalance` → `sendLassoSatellite()` L768-774 发 `orb:lasso-satellite` payload（`{...lassoBall, balanceText}`）→ `preload.cjs` L155-157 `onLassoSatellite` → `shell.js` L2956-2961 → `syncLassoSatellite()` L2601-2625 把文本写进 `#lasso-balance`（`floating.html` L105）。**M0 事实修正（裁决书 §6 预告属实）：卫星贴片自身没有现成 hover 展开 panel——"hover 展开"须在 M1 新增**（`#lasso-ball` 已有 `:hover` CSS L1149，加 mouseenter popover 无冲突）；panel 卡片挂 `#panel`（floating.html L15）内新元素；点击跳主窗口复用 socket `{type:'open-main'}` 通道（orb.ts L2284-2285 已有处理） |
| ④ | webServer/connection 运行时 catalog 确认 | ✅ 定案 | 本 build `cordis_inspect_list`→host Service 无参 catalog 实测：`connection` 服务含 `authenticatedUrl(baseUrl: string): string`；`webServer` 服务含 `getOrigin(): string`、`register(route)`；`deepseekAccount.getBalance(client)` 亦在列（balance.ts 依赖面成立）。与 orb index.ts L161-172 / open-main.ts L9-12 源码调用面一致 |

补充定案（M0 侦察新发现，回注 M1）：

- **update.ts 升级探针风险**：`UPDATE_REPO = 'mini-yifan/dsh-orb-cordis'`（update.ts L19），registry 探针按装机包名（fork 后为 `dsh-orb-quota`，registry 查不到）→ 回落 GitHub 上游 repo，**会把上游新版本当"可升级"推给用户，一键升级=用上游覆盖本 fork**。M1 处置：`UPDATE_REPO` 改指本 fork 占位 repo（404 → 无更新可推，更新卡自然静默），NOTICE.md 记录该决策。
- **pack.mjs 跨盘写入已内建兜底**：staging 在 `%TEMP%`（C 盘）、tarball 目标为 repo 根（D 盘）时 `rename` 抛 EXDEV，pack.mjs L149-153 显式 copyFile 兜底——fork 落在 `D:\Codes\DSH小插件\plugin-orb-quota\`（D 盘中文路径）不影响出包。
- **中文路径构建风险隔离**：M0 全链在 ASCII 路径验证；M1 fork 源码树在中文路径下编辑（read/write/edit 工具无碍，quota-multi 先例），install/build/pack 优先原地跑（node/pnpm 对 unicode cwd 本身无障碍；历史事故仅发生在"tgz 以 file: URL 被包管理器消费"），**tgz 产出后立即 move 到 `%TEMP%`，工作区零 tgz 残留**；若原地 install 意外受阻，降级方案=同步镜像到 `%TEMP%` ASCII 目录构建（已验证可行）。

## 2. M1 改造文件清单（fork = 上游全量复制 + 以下改动）

### 2.1 host 半（packages/host）

| 文件 | 改动 |
|---|---|
| `src/quota-feeder.ts` **（新增）** | `QuotaFeeder` 类（对齐 `BalanceMonitor` 骨架：inflight 去重、15s 最小间隔、失败保旧值、`lastError()`）+ 纯函数 `parseQuotaStatus()`/`pickUrgentRow()`/`rowChipText()`。取数：`GET {authenticatedUrl}/plugins/dsh-quota/api/status`（5s AbortController 超时）。**URL 只在内存使用，严禁日志/产出**（继承 open-main.ts L2-3 纪律） |
| `src/orb.ts` | 构造 feeder（deps：endpoint 由 `ctx.webServer.port`+`ctx.connection.authenticatedUrl` 合成，fetch/now/log 可注入）；`refreshBalance()` 按来源路由：`multi`→先 quota、降级时落 account，`account`→原逻辑；回合结束刷新（L1535-1536）与 5min 定时（L1952-1957）复用；广播：`lasso-balance` 载荷不变（旧 helper 兼容），新增 `{type:'lasso-quota', rows, current, state}`，`publishChrome()` chrome 载荷追加 `lassoQuota`；`setLassoConfig` 识别 `balanceSource`；新增 `quotaState()`/`setQuotaConfig()` 供 routes |
| `src/preferences.ts` | `LassoBallConfig` += `balanceSource: 'account'|'multi'|'off'`（默认 `'multi'`；迁移：旧文件无该字段时 `balance===false`→`'off'`，否则→`'multi'`——本 fork 定位即多渠道，降级态自动等价上游行为）；写盘时 `balance` 恒等 `balanceSource!=='off'`（chrome 载荷/旧 helper 语义连续）；`parseLassoBallPatch` += `balanceSource` 校验；新文件 `orb-quota.json`（dsh-orb home 内）`{yellowPercent: number=60, hidden: string[]}` + ProfileStore 读写/校验 |
| `src/routes.ts` | `snapshot()` += `quota: {source, yellowPercent, hidden, rows, current, state, refreshedAt, error}`；新路由 `POST /.dsh-orb/quota`（body 任取 `source`/`yellowPercent`/`hidden`，逐字段校验）→ `control.setQuotaConfig` |
| `src/update.ts` | `UPDATE_REPO` 改本 fork 占位 repo（防"升级回上游"覆盖，见 §1） |
| `tests/quota-feeder.test.ts` **（新增）** | 纯函数（解析/紧急度/tie-break/降级矩阵：404、非 200、JSON 坏、providers 空、全非 ok、部分 error）+ feeder 类（注入 fetch stub：inflight 合并、失败保旧值） |
| `tests/preferences.test.ts` | 既有 `lassoSatellite()` deepEqual 断言补 `balanceSource` 字段；新增迁移用例（legacy balance:false→off / true→multi / 显式 balanceSource 优先）+ orb-quota.json 读写用例 |

### 2.2 helper 半（packages/helper）

| 文件 | 改动 |
|---|---|
| `src/main.ts` | `ChromeState` += `lassoQuota`；消息分发新增 `lasso-quota` 分支（校验后存 chrome + `sendQuotaRows()`→`orb:lasso-quota`）；`readChrome()` 读 `lassoQuota`；`ipcMain.on('orb:open-main')`→`write({type:'open-main'})`（panel 卡片点击跳主窗口） |
| `preload.cjs` | `onQuotaRows(callback)`（`orb:lasso-quota`）+ `openMain()`（`orb:open-main`）两个面 |
| `assets/shell.js` | quota 行状态 + `readQuotaRows()` 校验；卫星 hover：`#lasso-ball` mouseenter/mouseleave 显隐 `#quota-popover`（圈选拖拽 `lassoPressing/lassoActive` 期间不弹）；panel 卡片 `#quota-card` 渲染（行=状态点+label+读数，点卡片头 `api.openMain?.()`）；文本进既有 i18n `messages` |
| `assets/floating.html` | 新增 `#quota-popover`（body 层，卫星旁）与 `#quota-card`（`#panel` 内、`#transcript` 前） |
| `assets/floating.css` | popover/卡片样式（沿用现有 token 风格；红/黄/灰状态点色） |

### 2.3 设置页（packages/client-settings）

| 文件 | 改动 |
|---|---|
| `client.js` | 小卫星卡：`balance` 单开关 → **余额来源三选**（DeepSeek 账号 / 多渠道聚合 / 关，select 组件沿用现有 select 样式）+ 黄档阈值 number（30-90，默认 60）+ 各渠道显隐 checkbox（来自 snapshot.quota.rows）；zh/en 文案新增（lassoBalanceSource* / lassoQuotaYellow* / lassoQuotaChannels*）；快照缺 `quota` 字段时整组降级隐藏（兼容旧 stub） |
| `tests/section.test.mjs` | stub snapshot += quota；断言三选/阈值/渠道行渲染与 mutate 目标 `/.dsh-orb/quota` |

### 2.4 bundle + 文档

| 文件 | 改动 |
|---|---|
| `packages/bundle/package.json` | `name`: `dsh-orb` → **`dsh-orb-quota`**；`version`: `0.2.1` → **`0.2.1-quota.1`**。**exports 子路径键经 M0 核对全部是相对键（`./host` 等），随包名自动解析，无需改动**（裁决书 M2-① 的实际落点只在 name） |
| `packages/bundle/scripts/assemble.mjs` | `NEW_CLIENT_ID`: `id: 'dsh-orb'` → `id: 'dsh-orb-quota'`（`OLD_CLIENT_ID` 不动：重写对象是 client-settings 构建产物里的 workspace id） |
| `packages/bundle/cordis.patch.yml` | 各 entry `name:`：`dsh-orb/computer-use`→`dsh-orb-quota/computer-use`、`…/code-agent`、`…/code-agent-registry`、`…/lasso-service`、`dsh-orb/host`→`dsh-orb-quota/host`、`dsh-orb`→`dsh-orb-quota`（末项 ui-settings-orb 行）。**五个 insert id 原样不动**：`preset-computer-use`/`orb-code-agent-registry`/`orb-lasso`/`orb-host`/`ui-settings-orb` |
| `NOTICE.md` **（新增）** | mini-yifan/dsh-orb-cordis（MIT）0.2.1 基线 + 移植即冻结声明 + 本 fork 改造点清单 + UPDATE_REPO 决策 + `/status` lockstep 义务 |
| `THIRD-PARTY-NOTICES.md` | 沿用上游全文，追加一节：本 fork 消费 dsh-quota-multi HTTP 快照（数据面无凭据值）说明 |
| `README.md` | 顶部 fork 横幅（对齐 quota-multi 先例） |

### 2.5 明确不动清单（防漂移）

- **`dshHomePath('dsh-orb', ...)` 全部保留**（orb.ts L351/ L545-569 voice 路径、index.ts L152 native、preferences workspace `dsh_orb`）——升级兼容裁决 M3，已装 0.2.1 用户的浮球位置/皮肤/开关无缝延续。
- 五个 insert id、`orb-host`/`ui-settings-orb` 插件 name、`exports` 相对键、`assemble.mjs` 的 `SELECTION_SPECIFIER`、`@dsh-orb/*` workspace 包名与全部 import、`console.error('dsh-orb: ...')` 日志前缀（外观性，保留降低 diff）。
- **llm/stream、agent/request 零触碰**（不注册监听；`agent/assistant-stream` 是上游既有行为）。
- plugin-quota-multi 目录零改动。

## 3. 接口冻结点（维护兜底，移植即冻结）

1. **quota `/status` 消费面（本 fork 只读以下字段，超出即视为越界）**：`providers[].{id,label,status,items[].{label,percent,display}}`、`currentModel.{platform}`、`alertPercent`。来源冻结于 dsh-quota-multi 0.14.10-multi.1（http.ts L20/L35-36、controller.ts L14-44、config.ts L147-158）。**lockstep 义务（裁决 m4）**：上述字段任何变更必须两个 fork 同步改版。
2. **路由前缀冻结**：`/plugins/dsh-quota/api`（quota 侧 install id `quota` 决定，勿随包名漂移）。
3. **地址/鉴权**：`ctx.webServer.port` + `ctx.connection.authenticatedUrl('http://127.0.0.1:${port}')`（运行时 catalog 已确认）。**authenticatedUrl 带凭据，严禁日志/产出文件**。
4. **广播契约**：`lasso-balance` 消息形状 `{text, state}` 不变（旧 helper 兼容底线）；新增 `lasso-quota {rows, current, state}`；chrome 载荷新增 `lassoQuota` 字段（旧 helper 忽略未知字段，向后兼容成立）。
5. **降级状态机**：非 200 / JSON 坏 / `providers` 非数组或空 / 无任何 `status==='ok'` 行 → quota `state:'unavailable'` → 静默退回 account 余额（复用 balance.ts `EMPTY_BALANCE`/`'unavailable'`/`'signed-out'`）；状态迁移记一行日志（仅迁移时，防刷屏）。
6. **贴片选行规则（确定性）**：候选=未隐藏的 ok 行；紧急=有 `percent` 且 `percent ≥ yellowPercent`（默认 60，可配 30-90）中最大者，**同百分比按 id 字典序**；无超阈值 → `currentModel.platform` 匹配行；再无 → id 字典序首行。红档 `percent ≥ alertPercent`（/status 下发，缺省 85）只影响显示色不影响排序。
7. **互斥安装**：同 insert id 与上游 dsh-orb 互斥，安装前上游 0.2.1 先 remove（lead 操作）；与 dsh-quota-multi 不同 insert id 正常共存。

## 4. 构建命令序列（M1 实测沿用，M0 已全量验证）

```powershell
# 0) fork：上游全量复制到 D:\Codes\DSH小插件\plugin-orb-quota\（源码树在中文路径，构建命令用 cmd 系可执行）
# 1) 依赖（本机 PATH pnpm 11.7.0 == packageManager，node v24.20.0）
pnpm.cmd install --no-frozen-lockfile
# 2) 构建（7 包 tsdown + bundle assemble；原地 assemble 进 packages/bundle）
pnpm.cmd build
# 3) 测试（node --test 全量 + computer-use 子套件）
pnpm.cmd test
# 4) 出包（pack.mjs：assemble→staging→koffi/zod/sherpa/node-cpal/pinyin-pro 自带 node_modules→平台包补抓→tar）
Push-Location packages\bundle; node .\scripts\pack.mjs; Pop-Location
# 5) tgz 立即移入 %TEMP%（ASCII 纪律；工作区零 tgz 残留），--ignore-scripts 不需要（tar 路线不走 npm pack 钩子）
Move-Item .\dsh-orb-quota-0.2.1-quota.1.tgz $env:TEMP\ -Force
```

- pack 依赖：`tar`（PATH 上 System32 bsdtar 实测可用）、`npm.cmd`（shell:true 解析）、registry.npmmirror.com（`DSH_ORB_PACK_REGISTRY` 可覆写）——M0 全部实测通过。
- 版本戳：直接改 `packages/bundle/package.json` 的 `version`（pack 不带 `--version` 也读 manifest）。
- M0 空跑记录存档：`%TEMP%\orb-m0-spike\`（tgz 59.9MB / 1330 entries；关键路径 cordis.patch.yml、dist/host/index.js、dist/helper/lib/main.js、dist/helper/assets/floating.html、node_modules/koffi+@koromix/koffi-win32-x64、dist/native-selection、dist/voice/child.js 均在）。
- M0 全量测试套件结果：**595 tests / 588 pass / 3 fail / 4 skipped**（TEST_EXIT=1）。3 个失败经定位全部是**上游 Windows 环境性失败**，与本次改造面无关：①`host\tests\deferred-install.test.ts:85`（4s 计时超时）②`host\tests\voice.test.ts:742`（listen 模式时序）③`voice\tests\child-capture.test.ts:164`（依赖 macOS `say` 语音命令，Windows ENOENT）。**本次改造面（balance/preferences/routes/orb/settings/helper 渲染）基线全绿**——M1 验收口径 = 该 588 基线不失 + 新增测试全绿 + 3 个已知环境性失败数量不增。完整日志 `%TEMP%\orb-m0-test.log`。

## 5. M1 执行顺序

1. fork 复制 + 改名涟漪三件套 + UPDATE_REPO + NOTICE/THIRD-PARTY/README（先让包身份正确）
2. host：preferences（balanceSource + orb-quota.json）→ quota-feeder（新文件+测试）→ orb.ts 接线 → routes
3. helper：main.ts + preload + floating.html/css + shell.js
4. 设置页：client.js + section.test.mjs
5. `pnpm test` 全绿 → `pnpm build` → pack → tgz 移 %TEMP% → 自检（改名残留 grep / 凭据纪律 grep / BOM 检查）
