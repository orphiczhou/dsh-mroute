# 任务书：orb-quota 浮球实测（DSH 重启后验收）

日期：2026-11-21 · 派发者：lead · 执行者：单会话 worker · 产物：`D:\Codes\DSH小插件\docs\11-orb-quota-verify.md`

## 0. 一句话目标

DSH 桌面端已重启，验证 **dsh-orb-quota（大肥鱼浮球 fork）** 是否已真正接管量化显示：①插件激活 ②浮球（卫星贴片/卡片）显示**多渠道额度读数** ③读数与 `quota` 插件快照一致 ④停用 quota 后能降级回 DeepSeek 账号余额。

## 1. 环境事实（必读，别踩坑）

- 桌面 profile：`C:\Users\sir_c\.dsh\profiles\desktop\`；依赖已确认：
  - `dsh-orb-quota => file:C:/Users/sir_c/AppData/Local/Temp/dsh-orb-quota-0.2.1-quota.1.tgz`
  - `dsh-quota-multi => file:C:/Users/sir_c/AppData/Local/Temp/dsh-quota-multi-0.14.10-multi.1.tgz`
- orb 运行目录：`C:\Users\sir_c\.dsh\dsh-orb\`（`floating-session.json` 每次启动重写，2026-11-21 12:23 有更新 ⇒ helper 起过）。
- 当前有 9 个 `electron` 进程在跑（StartTime 12:23），orb helper 大概率是其中之一。
- **本机 computer use 是 OFF**（`mcp__windows__*` 对模型隐藏）⇒ 不要尝试点击/拖拽浮球。
- 截图可以自己做：PowerShell + System.Drawing 抓全屏到 png，再用 read_image 看图（浮球永远置顶，全屏截图能拍到）。
- GUI 端口 **58697**（本次会话实测值；quota 面板路由是 `http://127.0.0.1:58697/plugins/dsh-quota/api/status`，GET 免 CSRF）。
- 宿主插件管理：`plugin_manager action=list_bundles`（找 `dsh-orb-quota` 行，看 enabled/installed）；`plugin_manager action=set_bundle target=<name> enabled:true|false` 可关开（会热重载，不要乱关别人）。
- PowerShell 5.1 打开 UTF-8 文件请用 `Get-Content -Raw -Encoding UTF8`，**不要用 Set-Content 写 JSON**（会带 BOM 弄坏宿主配置）。

## 2. 要回答的问题（逐条编号，报告里一一对应）

1. **安装与激活**：`dsh-orb-quota` 是否 installed + enabled + fiber active？quota-multi 是否也 active？给出 `plugin_manager` 原始回执关键字段。
2. **进程归属**：当前 electron 进程里，哪个是 orb helper（按命令行/父进程判断）？orb host 插件是否在跑（可在日志或 `floating-session.json` 里找证据）？
3. **浮球读数**（核心）：截全屏图，浮球**卫星贴片/卡片**上显示的是什么？是否出现**多渠道**（DeepSeek ¥ / 小米 ¥ / 智谱 % / opencode-go %）？把看到的文字逐字记录（截图存 `C:\Users\sir_c\AppData\Local\Temp\orb-quota-verify\*.png` 并在报告里给绝对路径）。
4. **一致性**：拿 `quota` 面板快照（`GET /plugins/dsh-quota/api/status`）与 `quota_refresh` 工具输出，和浮球读数做三方比对表（渠道 / 浮球显示 / 快照 remaining/display / 是否一致）。
5. **降级**：把 `dsh-quota-multi` 关掉（`set_bundle enabled:false`）→ 看浮球是否退回 **DeepSeek 账号余额**（截图+文字）→ **立刻恢复 enabled:true**，再截一张确认恢复。若关 quota 会连带让 mroute 的 `model_route_query` 报 absent，这是符合预期的，不要据此判失败；恢复后随口验证一次 `model_route_query` 有余额行即可。
6. **异常与缺口**：浮球没显示配额、显示 `--`、只显示一个渠道、读数与快照不一致等，逐条记录（含截图/日志摘录），并给出你的判断（是 orb 侧没拿到 quota 快照 / 拿到了没渲染 / 前端缓存）。

## 3. 允许的操作面

- 读：profile 配置文件、orb 运行目录、进程表、日志文件；HTTP GET 到 `127.0.0.1:58697`。
- 写：只在 `C:\Users\sir_c\AppData\Local\Temp\orb-quota-verify\` 下写截图与临时脚本；写报告 `D:\Codes\DSH小插件\docs\11-orb-quota-verify.md`。
- 改：**只允许** 临时 `set_bundle dsh-quota-multi enabled:false→true`（第 5 条），且必须在本轮结束前恢复，并在报告里写明恢复证据。
- 禁止：改任何插件源码、改 profile 的其它 bundle、删除 orb 目录、把 token/key 写进报告。

## 4. 报告格式（`docs/11-orb-quota-verify.md`）

```
# orb-quota 浮球实测（2026-11-21）
## 结论速览   表格：检查项 / 结果（PASS/FAIL/待用户目视） / 证据
## 1 安装与激活   （原始回执摘录）
## 2 进程归属
## 3 浮球读数     （逐字文本 + 截图路径）
## 4 三方一致性   表格
## 5 降级与恢复   时间线 + 恢复证据
## 6 异常与缺口   逐条 + 判断
## 7 需要用户拍板的点
```

## 5. 上报纪律

- 开工先回一条「brief_echo：我按 §2 六条逐项做」。
- 每完成 2 条发一条 progress（带证据摘要）。
- 全部完成后：把「一句话结论 + PASS/FAIL 清单 + 截图路径」作为最终答复回给 lead，同时确保报告已落盘。
- 若第 3/5 条因「浮球不可见/截图里没有」无法判定，**不要猜**——明确写「需用户目视」，并把你为排查做的取证列出来。
