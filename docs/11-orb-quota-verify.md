# 11 — orb-quota 浮球多渠道额度接管实测报告（M2 验收）

- 日期：2026-11-21（19:10–19:50 +08:00）
- 执行：验证会话（按任务书 `docs/briefs/orb-quota-verify.md` §2 六条逐项）
- 环境：DSH 桌面端重启后；GUI 端口 **58697**（非旧记 55802）；computer use = OFF（无法点击/悬停，全部证据走 PowerShell 截屏 + HTTP + 源码取证）
- 截图与脚本目录：`C:\Users\sir_c\AppData\Local\Temp\orb-quota-verify\`
- 红线遵守：未改任何插件源码；profile 中仅动过 `dsh-quota-multi` 的 enabled（任务书 §3 授权），已恢复 true（见 §6）。

## 结论速览

| # | 检查项 | 判定 |
|---|---|---|
| Q1 | fork 安装且启用 | **PASS** |
| Q2 | 重启后 helper 进程跑 fork 代码 | **PASS** |
| Q3 | 浮球显示多渠道读数 | **PASS（有条件）**——数据管道全通、贴片字样按 fork 逻辑应为 `OC·31%`；像素级目视确认受 PrintWindow 透明区渲染限制，需用户瞄一眼 |
| Q4 | quota_refresh ↔ API ↔ 浮球一致性 | **PASS** |
| Q5 | 降级退回账号余额 | **FAIL（发现缺陷 D1）**——停用 quota-multi 后贴片冻结旧多渠道读数 ≥150s，未按注释退回 DeepSeek 账号余额 |
| Q6 | 异常记录 | 完成（D1 major + 4 条 minor） |

**一句话结论：多渠道额度确实已经接管浮球显示（host feeder 拉到快照、pickUrgentRow 命中当前模型平台行、helper 渲染链完整），但"quota 失效→退回账号余额"这条降级路径存在 stale-ready 卡死缺陷，需修复。**

## 1. Q1 安装状态（PASS）

`plugin_manager action=list_bundles`（m00005）：

- `dsh-orb-quota` **v0.2.1-quota.1** installed=true enabled=true，rows 含 `orb-host` / `orb-lasso` / `preset-computer-use` / `orb-code-agent-registry` / `ui-settings-orb`。
- `dsh-quota-multi` **v0.14.10-multi.1** installed=true enabled=true，insert rowId `quota`（与上游互斥口径一致）。
- spill 全文：`C:\Users\sir_c\AppData\Local\Temp\dsh-spill-GfVW6I\session-fa8892a25afc\a1d3628727c3-plugin_manager.txt`

## 2. Q2 重启后进程证据（PASS）

- electron 主进程 pid **33624**（父 34644），命令行直指 fork：
  `C:\Users\sir_c\.dsh\dsh-orb\electron-runtime\electron.exe --user-data-dir=C:\Users\sir_c\.dsh\dsh-orb\helper-data\ce374be8b4b3a24a C:\Users\sir_c\.dsh\profiles\desktop\node_modules\dsh-orb-quota\dist\helper\lib\main.js`
  ——加载的是 **dsh-orb-quota**（fork）的 dist/helper/lib/main.js，不是上游 dsh-orb-cordis。
- `floating-session.json` LastWriteTime **2026/11/21 12:23:17**（本轮重启后新写）。
- 设备缩放 DSF=2.25（renderer 参数）。

## 3. Q3 浮球多渠道读数（PASS 有条件）

### 3.1 视觉抓图方法与环境坑

- 全屏 `CopyFromScreen` **拍不到浮球**（该 Electron 球窗在位图上只留壁纸——layered/DWM 排除）。
- `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2)` 能拍到内容：球窗鱼身像素验证通过（浅蓝 #B7CFF1 鱼体 vs 黑角）。但透明区被渲染为纯黑 ⇒ 深底上的深色字形不可读，这是本次无法像素级读出贴片字样的直接原因。
- 球窗：hwnd **177605180**，title「桌面 agent」，rect (1292,468)-(1388,564) 96×96，topmost=True visible=True。窗口清单见 `windows3.ps1` 输出。

### 3.2 代码取证链（正源 `C:/Users/sir_c/.dsh/profiles/desktop/node_modules/dsh-orb-quota/dist/host/index.js`）

1. **feeder 拉到快照**：`GET http://127.0.0.1:58697/plugins/dsh-quota/api/status` → HTTP 200，body 存 `quota-status.json`（refreshedAt 2026-11-21T11:13:01Z，7 个 provider 全 ok）。QuotaFeeder.read() 仅在 fetch 失败/非 ok/无 providers/无 healthy provider 时清空缓存转 unavailable——以上均未发生 ⇒ `state="ready"`。
2. **effectiveBalance()**（@~673001）：`balanceSource=="multi"`（DEFAULT_LASSO_SATELLITE.balanceSource="multi" @~32308）&& ready ⇒ `pickUrgentRow(rows, yellowPercent=60, current)`。
3. **选中行**：无渠道 percent≥60 ⇒ 回退 `row.id === snapshot.current`；`currentModel.platform = "opencode-go#OPENCODE_GO_API_KEY"` 恰等于行 id ⇒ 命中 OpenCode Go 行。
4. **贴片文本**：`compactQuotaText`（@~128468）= `shortPlatformLabel("OpenCode Go")`→ initials `OC` + `·` + round(max percent 31) ⇒ **「OC·31%」**。
5. **helper 渲染链**：main.js `lasso-balance` record → `chrome.lassoBalance.text` → `sendLassoSatellite()` IPC → shell.js `syncLassoSatellite()` 写 `#lasso-balance.textContent` + `.has-balance` 胶囊（CSS max-width 72 CSS px，注释示例即「小米·¥57.93」形态）。hover 弹层 `#quota-popover` 需要鼠标悬停，本环境无法触发（属正常交互闸，不算缺陷）。

### 3.3 像素旁证与保留意见

- 球窗下半区白色像素 461–491 个，跨 4 次定时采样稳定（`q3-ball-1..4.png`）；其中光标箭头占 x40-54,y68-95 一块，其余为类文字形簇（`scan2.ps1` 行图 / `ascii.ps1` ASCII 图）。
- **不能**从像素断言字样确为「OC·31%」（PrintWindow 黑底吞掉对比度 + 光标混入）。⇒ 最终请用户目视浮球右下角贴片：若显示 `OC·31%`（或数值随消耗缓动的同型文本）即完全坐实多渠道接管；若显示 `¥xx` 形态则是账号余额回退，请告知 lead 复查 feeder 状态。

## 4. Q4 三方一致性表（PASS）

| 渠道 | API 快照（quota-status.json 11:13Z） | quota_refresh 工具（11:17Z） | mroute machine（model_route_query 11:45Z） | 浮球理论读数 |
|---|---|---|---|---|
| deepseek | ¥27.14 | ¥27.14 | deepseek-official/account machine(¥26.91) | （非选中行） |
| zhipu | 5h 1% · 周 13% | 5h 1% · 周 14% | zai machine(5h 5% · 本周 14%) | （非选中行） |
| opencode-go#GO | 5h 2% · 周 31% · 月 15% | 5h 2% · 周 32% | opencode-go machine(5h 13% · 本周 35% · 本月 17%) | **贴片 OC·31%（选中）** |
| opencode-go#SOTA | 同上 | 同上 | — | （同 label 行） |
| xiaomi | ¥54.98（周耗 ¥2.95 / tokens 5,201,291 / 请求 33） | ¥54.98 同 | machine(¥54.89) | （非选中行） |

三源同源同值（分钟级消耗漂移内），证明浮球的数据面与 quota 面板/工具完全一致——浮球若显示即正确。

## 5. Q5 降级测试（FAIL —— 缺陷 D1）

过程（时间均 +08:00）：

1. 19:41 `set_bundle dsh-quota-multi enabled:false` → application:applied。
2. 即时 GET 快照路由 → **HTTP 404**（路由随插件卸载消失）。
3. 在停用窗口内于 t0/t25/t55/**t150s** 连续 PrintWindow 抓球：png sha256 恒为 `0BE57377…E3AA1B5A`（6222B），lowerWhite 恒 461 —— **画面零变化，贴片仍冻结在旧的多渠道读数**。
4. 19:45:3x `set_bundle dsh-quota-multi enabled:true` → applied；20s 后 GET → **HTTP 200 len=183914**（`post-restore-ball.png` 抓取，哈希仍同——恢复同样要等下一次触发）。
5. `model_route_query` 抽查：machine 读数恢复供给（11:45:49Z 快照）。

**根因（源码级）**：host 只有一个余额轮询定时器 `startBalancePoll()`，间隔 `BALANCE_REFRESH_MS = 3e5`（**5 分钟**，dist/host/index.js @~671700）；`quota.refresh(true)` 强制刷新只挂在 setLassoConfig / setQuotaPrefs / turn-done 三个事件上。quota-feeder 的 `MIN_REFRESH_GAP_MS=15000` 只是节流窗，**不是定时器**。⇒ 插件停用后，`refreshBalance` 最长 5 分钟不被调用；即使被调用，`effectiveBalance()` 在 cached 未清前仍返回 ready 旧行。行为与设计注释「multi-channel quota when ready, else the account」**不符**——stale-ready 卡死，降级退回账号余额在 ≤5min 窗口内不发生（恢复方向同理延迟）。

复现要点：disable dsh-quota-multi → 观察贴片 >150s 不变；期间无会话回合结束（turn-done 会顺带 force refresh 而掩盖现象）。

建议修法（供 lead 排期，不在本会话实施）：给 quota 态单独挂 15–30s 轻量 tick，或在 fetch 404/网络失败即刻 clear+broadcastBalance。

## 6. 恢复证据（任务书硬性要求）

- `set_bundle dsh-quota-multi enabled:true` 返回 `{"changed":true,"application":"applied"}`（19:45）。
- 恢复后 GET `/plugins/dsh-quota/api/status` → **HTTP 200**，len=183914。
- `model_route_query`（19:47）五行 balance=machine 正常（见 §4 表）。
- 收口前再查 `list_bundles`：dsh-quota-multi enabled=true、dsh-orb-quota enabled=true（见 §8 收口补记）。
- 除这两个 bundle 外未对 profile 做任何其它变更；未修改任何插件源码。

## 7. Q6 异常与观察清单

| 编号 | 级别 | 描述 |
|---|---|---|
| D1 | **major** | §5 降级 stale-ready 卡死（BALANCE_REFRESH_MS=300000 唯一驱动；无 quota 专用 tick） |
| D2 | minor | PrintWindow 对透明区返黑 ⇒ 第三方截屏工具难以自动化验证贴片字样（本报告因此只能"有条件 PASS"+用户目视） |
| D3 | minor | hwnd 13960844「Electron」280×46@(1107,32) visible=False，PrintWindow 恒返全黑 267B PNG（多次采样字节一致）——疑为 lasso overlay canvas 占位窗，无信息量；不影响判定 |
| D4 | minor | GUI 端口本轮实测 **58697**（AGENTS.md §7 记 55802）；每次宿主重启端口可能再变，任务书写死端口有脆性 |
| D5 | info | hover 多渠道卡片（#quota-popover）与 panel 卡片无法在本环境触发（computer use OFF + inspect exact-query 损坏双闸），仅验证了渲染函数与 DOM 存在性 |

## 8. 收口补记（复查证据）

- 收口复查 `list_bundles`（两页共 47 bundles，机读原文在会话 m00415/m00416）：`dsh-orb-quota` v0.2.1-quota.1 **enabled=true installed=true**（rows 含 orb-host）；**`dsh-quota-multi` v0.14.10-multi.1 enabled=true installed=true**（rowId `quota`）——恢复铁证直接来自 bundle 清单本身。
- 旁证两连查：`GET /plugins/dsh-quota/api/status` → HTTP 200 len=183914（19:48；停用期间为 404）；`model_route_query`（19:47）五行全部 balance=machine(…)（zai `5h 5% · 本周 14%`、opencode-go `5h 13% · 本周 35% · 本月 17%`、deepseek×2 `¥26.91`、xiaomi `¥54.89`），非 manual——quota 数据面已回供。
- D1 修法建议按 lead 裁决登记于 §5/§7，本轮不修代码、不改 plugin-orb-quota 源码（已遵守）。
- 关键截图绝对路径：
  - `C:\Users\sir_c\AppData\Local\Temp\orb-quota-verify\base-20261121-191146.png`（全屏基线，球不在位图内=D2 佐证）
  - `C:\Users\sir_c\AppData\Local\Temp\orb-quota-verify\pw-alpha.png`、`chip-now.png`（球窗 PrintWindow，鱼体可见）
  - `C:\Users\sir_c\AppData\Local\Temp\orb-quota-verify\q3-ball-1.png … q3-ball-4.png`（Q3 定时采样，白像素稳定）
  - `C:\Users\sir_c\AppData\Local\Temp\orb-quota-verify\deg-t0.png deg-t25.png deg-t55.png deg-t150.png`（Q5 降级窗口，四图字节级相同=冻结证据）
  - `C:\Users\sir_c\AppData\Local\Temp\orb-quota-verify\post-restore-ball.png`（恢复后）
  - `C:\Users\sir_c\AppData\Local\Temp\orb-quota-verify\quota-status.json`（API 快照原文，注意含 keyRef 名不含密钥值）
- 脚本：`screenshot.ps1 windows3.ps1 pw3.ps1/pw5.ps1 scan.ps1 scan2.ps1 ascii.ps1 shot.ps1 q5pre.ps1 grep*.cjs`（同目录）。
