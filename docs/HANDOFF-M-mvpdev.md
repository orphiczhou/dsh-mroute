# HANDOFF-M-mvpdev — mroute MVP 开发进度留痕

- 会话：mvp1-M-mvpdev（独立会话，无需真交接——本文件为进度落盘保险）
- 更新时间：2026-11-13（开发完成时刻）

## 已完成（全部交付物就绪）

1. **Day 1 实测**：schemastery 嵌套对象探针通过（@deepseek-ai/schemastery@3.19.0，与宿主捆绑同版本号）
   —— 结论：真嵌套对象存活、不降级 JSON 字符串；z.record 缺失/z.dict 存在；volatile 数组元素内字段抛错、
   数组整体 volatile 合法（.get() 读回）。落盘 `docs/04-mvp-notes.md`。探针 `tmp/day1-schemastery-probe/`。
2. **插件 bundle**：`plugin-mroute/`（18 文件）——package.json / cordis.patch.yml / index.js（四导出+apply）/
   lib/ 七模块（config-schema/registry/volatile/livecheck/errors/ranking/tool-query/prompt-section）/ locale en+zh /
   icon.svg（原创）/ README / LICENSE(MIT) / NOTICE(借鉴出处表)。
3. **model_route_query**：读注册表 → llm 活校验（单 TTL 60s，读不到不缓存）→ channel_type 三级排序
   （monthly>voucher>prepaid → tier → priority 降序 → id 兜底；unknown 全局沉底）→ 带理由结构化列表。
4. **种子数据**：5 provider（zai-coding-cn/opencode-go monthly → deepseek-official/deepseek-account prepaid → xiaomi prepaid bulk），
   fallbacks 成链，manual 占位"—"。
5. **systemPrompt 一句提示**：tool:mroute:route-hint 段（任务书原文一句 + 拒绝时换下一项）。
6. **自检**：9 文件 node --check 全过；离线冒烟 8 组断言全过（tmp/mvp-smoke/）；红线 grep 零命中；
   manifest 清单逐项核对。落盘 `docs/04-mvp-selfcheck.md`（含 lead 安装实测指引）。

## 待 lead 执行

`plugin_manager install_bundle target="D:/Codes/DSH小插件/plugin-mroute"` → 按 04-mvp-selfcheck.md §6.2 七个验证点实测
（重点：volatile 热更后 manual 嵌套键存活 = 04-mvp-notes.md §1.5 降级预案触发观察点）。

## 红线遵守声明

无 llm/stream、无 agent/request、无 system-prompt/assemble 监听；无 HTTP/凭据面；无 UI/评测/写回；
未调用 install_bundle。所有 ctx.on 注册数 = 0（grep 证据见 selfcheck §3）。
