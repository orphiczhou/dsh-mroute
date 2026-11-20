# NOTICE.md — 第三方借鉴出处表

mroute MVP 为手写实现，无整文件移植；以下为**形状/设计借鉴**（AGENTS.md §5 三分法之「改造借鉴/仅参考」），
逐项标注来源与许可。借鉴即冻结：不跟上游升级，漂移兜底见 mroute/07-assembly-plan.md §4.3。

| 借鉴内容 | 来源 | 许可 | 借鉴方式 |
|---|---|---|---|
| llm 目录聚合形状（listProviders + 逐家 listModels + current 提取 + 单家失败降级） | twoweeks1995/dsh-subagent-setup `plugin/catalog-runtime.mjs`（33 行） | MIT | 改造借鉴（重写为 livecheckAll + livecheck.js 双文件） |
| 活校验 TTL 缓存纪律与「catalog 读不到 ≠ 校验通过」注释教训 | tkaiz0406/dsh-subagent-route-pin `index.js:871-903` | MIT | 改造借鉴（双 TTL 简化为单 TTL 60s，失败短缓存纪律改「读不到不缓存」） |
| 排序 tie-break 全序形状（质量/倍率/字典序 + 稳定排序 + DecisionRecord 思想） | young-tim/dsh-llm-governor `src/routing/strategies.ts` | MIT | 仅参考（channel_type 财务一级键为 mroute 自研排序键） |
| Config volatile 落点与双面读取（resolveConfig 接受 Volatile 引用与裸值） | PerryLink/dsh-autotier `src/schema.ts`（头注与接口形状） | Apache-2.0 | 仅参考（未拷代码——Apache-2.0 下仅借鉴思想/形状无需携带许可文本；Day 1 实测独立验证，见 docs/04-mvp-notes.md §1） |
| 工具定义对象形状（name/description/parameters/output.schema+render/isConcurrencySafe/execute） | twoweeks1995/dsh-subagent-setup `plugin/tools.mjs`（createCatalogTool 形态） | MIT | 仅参考 |
| 插件清单结构（package.json dsh.engines / exports / files；patch row 形态） | asar 官方模板 skills/dsh-doc/templates/decoration/ 与 dsh-subagent-setup package.json | MIT / 官方文档 | 仅参考 |
| **lib/platform-map.js 整文件移植**（platformForProvider 供应商→平台映射表，连注释搬运） | Minokun/dsh-quota 0.14.10 fork **dsh-quota-multi**（本工作区 `plugin-quota-multi/src/platform-map.ts`，v0.14.10-multi.1） | MIT | **直接复用**（M2 移植即冻结：不跟上游升级；用途差异见 platform-map.js 头注——quota 插件运行时认领用，mroute 仅注册表读侧交叉核对告警，采信依据只有显式 quota_platform+verified） |
| M2 缓存/熔断设计意图（TTL 60s 级 + 单飞 inFlight + 失败指数退避 5s×2^n 封顶 30min 占缓存位 + stale 保留旧值 + loopback 围栏 + 200+HTML 先判 + AbortError 重抛 + fetch+AbortSignal.timeout 15s 传输纪律） | 本工作区 `mroute/07a-balance-adapters.md` §宿主侧配套 1-8（六包源码提炼）与 `mroute/07-assembly-plan.md` §3.2 | MIT（所引六包）/ 工作区自有 | 改造借鉴（设计纪律落码为 lib/quota-cache.js + lib/quota-source.js；未拷任何运行时代码） |
| M3 设置面板 client 模块形状（`window.__ModuleLoader__.load` 工厂 + `require('react')` + settings.section 注册 + `inject` props 工厂 + `<html lang>` locale 探测 + theme-token CSS + node:vm 沙箱 selfcheck 模式） | mini-yifan/dsh-orb-cordis 0.2.1 fork **dsh-orb-quota**（本工作区 `plugin-orb-quota/packages/client-settings/client.js` + `tests/section.test.mjs`） | MIT | **改造借鉴**（形状与测试模式借鉴，重写为 mroute 自有组件与词典，未拷任何运行时代码/样式块） |

## 依赖包出处（审计 m-4；版本与许可自 node_modules 安装件 package.json/LICENSE 实读，2026-11-13）

| 包 | 版本 | 许可 | 用途 | 义务 |
|---|---|---|---|---|
| @deepseek-ai/schemastery | 3.19.0（exact，与宿主捆绑同版本） | MIT（© 2021-present Shigma） | Config 注册表 schema 校验（dependencies 显式声明——漏声明会激活失败 ERR_MODULE_NOT_FOUND，见 AGENTS.md §4 安装期实录） | 保留版权与许可声明（本节即履行） |
| @deepseek-ai/cosmokit | 1.9.0 | MIT（© 2021-present Shigma） | schemastery 的传递依赖（非直接 import） | 随 schemastery 分发，同上 |
| @standard-schema/spec | 1.1.0 | MIT（© 2024 Colin McDonnell） | schemastery 的传递依赖（schema 标准接口） | 随 schemastery 分发，同上 |
