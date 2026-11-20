# DSH 插件市场扫描：相近插件调研（mroute 补充章）

- 扫描日期：2026-11-13
- 数据源：awesome-dsh-plugin 官方目录（`https://awesome-dsh-plugin.com/plugins.json`，**10,778 个插件**，updated 2026-11-12，本机下载 15MB 全量解析；另经 dshmarket README 交叉确认）
- 扫描方式：按目录自带分类 `usage`（用量与计费，150+ 条）与 `model`（模型与账号接入，200+ 条）全量提取 + 全目录关键词扫描（route/router/fallback/quota/balance/eval/bench/arena/ranking/评测/榜单/排名）
- 结论一句话：**单点能力全部有市场先例（技术路线被社区反复验证，风险进一步降低）；但「财务优先级 × 能力分层 × 多渠道余额机读 × 评测排名闭环 × 设置面板一体化」的全家桶不存在——立项的差异化空间成立。**

---

## 一、与七条需求的对照地图

### 需求 4（余额/用量查询）——先例最多，市场最拥挤

| 插件 | 热度 | 覆盖 | 与我们方案的差异 |
|---|---|---|---|
| **dsh-quota-panel** | ★12 / dl 1705 | 自动发现已配置 Key 的供应商：DeepSeek、OpenRouter、SiliconFlow、GLM、one-api/new-api、各类 Coding 套餐；**火山方舟 Agent/Coding Plan（AK/SK 签名 OpenAPI）**；**ChatGPT Plus/Pro 订阅用量（设备码登录/读 Codex CLI 登录态）**；告警阈值 | 渠道覆盖与我们 02 文档的 A/B 类高度重合（连方舟 AK/SK 路径都一致）；只显示+告警，不参与选路 |
| dsh-balance-monitor | ★1 | DeepSeek、Kimi、智谱 GLM、TeamoRouter 余额 | 同上 |
| dsh-musage | ★6 | 5 家套餐用量与余额（MiniMax/DeepSeek/Kimi/OpenRouter/智谱），跟随当前模型自动切换 | 有"跟随当前模型"思想 |
| dsh-token-dash | ★0/3079 | 按供应商月度预算、**订阅配额（GLM/Kimi Coding）**、账户余额 | 接近"包月+预充值分开看" |
| dsh-aliyun-balance / dsh-qwen-balance | ★12/★1 | 阿里云 BSS 余额+**代金券余额与到期日**（学生券） | 与我们 02 文档 BSS 路径一致，**唯一做券到期日的先例** |
| dsh-billing-balance | ★3 | DeepSeek 余额 + **火山方舟 Coding/Agent Plan 5h/周/月窗口+重置倒计时** | 方舟套餐机读的又一先例 |
| dsh-coding-plan-quota | ★1 | **15 个 coding plan** 用量或余额圆环 | 套餐覆盖面最广 |
| dsh-provider-usage（hub 版 ★32） | ★32 | **多 provider 用量框架（v2 适配器契约）**：放入一个 mjs 适配器即接入，设置页热插拔 | **适配器架构与我们 M2/M3 设计同构**，可直接借鉴其契约 |

### 需求 2/3（财务优先级/备选链）与子会话派遣——**核心竞品区，但无人做财务排序**

| 插件 | 热度 | 做什么 | 差距 |
|---|---|---|---|
| **dsh-llm-fallbacks** | ★26 / dl 9919 | 基于角色的模型重试与备用策略 | 失败回退有；**不看余额、不做财务优先级** |
| dsh-model-router（×2 同名） | ★4/4100、★2/682 | 模型池按步骤路由+思考等级；任务类型加权、视觉分流、会话信号（todo/上下文压力/token 预算）；逻辑 ModelID 聚合多家供应商+失败切换+冷却+健康度择优+**purpose 三档分级** | 分级是"任务用途"维度，不是"包月>券>预充值"财务维度 |
| **dsh-delegate-router** | ★2/1203 | **子代理调用 Flash/Pro 自动分派：轻任务便宜模型、重任务强模型**，手动覆盖 | 离"多子会话派遣模型选择"最近的插件；但按"任务轻重"分派，不按额度/财务状态 |
| dsh-autotier | ★1/2857 | 复杂意图强档规划+廉价档执行，简单意图全程廉价档，确定性护栏+TTL 升级回退 | 同上 |
| **dsh-quota-takeover** | ★1 | **额度接力：按平台顺序与模型档编排有序接力链，缺模型/平台冷却/额度耗尽自动跳过**，中断后续接 | **最接近财务优先级的先例**（按额度状态跳过格子），但绑定 OFM 网关，非通用 |
| dsh-teammate-model-picker | ★0 | 队友（continuable subagent）模型选择器：**队友额度用完直接换还有额度的模型继续跑** | 额度感知的子会话换模先例（手动） |
| dsh-llm-governor | ★1 | 多模型访问控制、月度 Credits、**手动/质量优先/额度优先/自动路由**、失败重路由 | **"额度优先路由"字样首见**；★1 说明极小众，覆盖渠道不明 |
| dsh-gemini-pool | ★8 | 多账号按**剩余额度挑选**账号，429 退避切换 | 账号池级额度选路 |
| dsh-role-router / dsh-model-switch / dsh-delegation-suite | ★5/★3/★1 | 按 default/planner/subagent 角色路由；Main/Subagent/web_search/生图显式路由；按角色最强模型+失败互备+可视化路由编辑 | 角色维度路由先例充分 |
| dsh-subagent-setup | ★0 | 命名模型路由：别名绑定子代理+模型+思考档位+令牌上限+「**何时使用**」供模型选路，委派时只写别名 | **"给模型的选路参考表"思想与我们 model_route_query 同源**（它是被动元数据，我们是主动查询+余额排序） |
| dsh-subagent-routes / dsh-subagent-route-pin / dsh-plugin-subagent-director ★24 / dsh-plugin-team-subagent-control / dsh-subagent-model-config | ★1/★2/★24/★0/★3 | 按工作区目录子代理路由表；包装 provider 让子代理走指定路由（**provider.start + startActivation 钩子**）；Team 成员级模型配置 | 子代理模型管控先例非常充分，均无余额联动 |

### 需求 7（评测→排名）——有零件，无闭环

| 插件 | 热度 | 做什么 | 差距 |
|---|---|---|---|
| dsh-model-health | ★3 | 设置页批量测试全部模型可用性与延迟 | 连通性≠能力排名 |
| **dsh-model-master** | ★19 | 对任意模型发**真实流式请求测 TTFT/TPS**，浏览 **OpenRouter 榜单** | 实测性能+榜单浏览有了；无评测集、无排名写回 |
| dsh-model-connection-test | ★1 | **经宿主 LLM 服务发最小对话请求**验证连通（报告宿主失败码/耗时，并发 3） | 与我们 M5 通道②同款技术路径（旁证） |
| **dsh-agent-bench** | ★1 | 隔离沙箱跑固定 Agent 用例+确定性断言，**对比两次运行指出换模型后哪条用例退化** | "换模型对比"正是排名需求的内核，但无持续排名体系 |
| dsh-freemodels-opencode | ★0 | 逐个发真实请求得出七档结论+**人工 S/A/B/C 评级**进模型选择器 | 人工评级排名的雏形（单渠道） |
| dsh-swarm-router | ★3 | 异质任务路由到最合适模型，**按模型统计 token、用真实反馈驱动排名** | "真实反馈驱动排名"思想首见；无独立评测集 |
| **dsh-eval-harness** | ★14 | YAML 用例驱动真实 headless agent，断言工具调用/参数/返回与 token 用量，baseline 门禁 CI 回归 | 评的是 agent/插件而非"模型能力排名"，但**评测框架可直接复用** |
| dsh-tier-brain | ★0 | 发送前判断问题难度，提示"够用的模型与推理等级" | 分层推荐思想（提示级，非路由） |

### 需求 5（动态能力变化）——监测先例存在

- **dsh-big-coming**（★0）：每轮读模型目录+对关注模型发最小补全请求，比对系统指纹/模型名/信封结构/token 数，变化即告警——**模型版本漂移监测的现成先例**（可直接借鉴为注册表 `reviewed_against` 的自动锚点）。
- dsh-plugin-model-news-radar（★0）：按厂商官方来源采集模型发布资讯写日报——资讯层保鲜。

### 需求 6（设置面板编辑）——管理 UI 先例充分

dsh-model-management / dsh-model-tidy / dsh-provider-studio（★11，218 个供应商模板）/ dsh-model-groups / dsh-model-control 等大量模型管理设置页，验证了 W4 的结论（settings.section 可视化编辑是一等公民机制）。

---

## 二、对原论证的修正与增强

1. **技术路线全部获得市场实证背书**：多渠道余额适配（dsh-quota-panel 的渠道清单与我们 02 文档 A/B 类几乎一致）、方舟 AK/SK 套餐机读（两家先例）、阿里券到期日（dsh-qwen-balance）、子会话模型路由（6+ 个插件）、经宿主 llm 服务发测试请求（dsh-model-connection-test）、设置面板编辑（W4）。**没有一条技术路径是"只有我们这么想"的。**
2. **W1 结论的一处细化**：`dsh-subagent-custom` 展示了在 **`agent/request` 钩子上改写子代理自身的模型请求**（Jev 判定任务类别→改写 provider/model/effort）。这不推翻 W1§C（派遣工具参数层 tools/pre-execute 无 rewrite），但说明**子代理会话内部**存在另一条请求改写缝——若未来想做"派遣后按会话内实际任务改道"，此通道值得单独评估（仍不建议 v1 碰）。
3. **`llm/stream` 的实战用法补充**：dsh-budget（★10）在 llm/stream 瀑布上做记账与预算阻断、dsh-api-cost 做谷时延迟派发——瀑布被社区用于"记账/延迟/阻断"，与 W1"改道路由高风险"的判断一致（没人用它改 route）。

## 三、市场空白与立项定位（最终）

**空白确认**：10,778 个插件中，没有任何一个同时做到——
1. `channel_type`（monthly/voucher/prepaid）驱动的财务优先级排序（最接近的 dsh-quota-takeover 绑定单一网关、dsh-llm-governor 极小众且渠道覆盖不明）；
2. 限期算力券的"剩余÷剩余天数"衰减先用；
3. 评测→`suggested_tier/priority`→人工确认→写回注册表的排名闭环（零件齐全：评测框架 dsh-eval-harness、实测工具 dsh-model-master、人工评级 dsh-freemodels-opencode，无人串联）；
4. 多渠道余额机读（含包月/券/预充值三池分离口径）与派遣选路的联动。

**给用户的三条路**：
- **路 A（先试用，零开发）**：装 dsh-quota-panel（余额全景）+ dsh-delegate-router 或 dsh-llm-fallbacks（子代理分派/备选），验证痛点是否被覆盖 80%。适合先跑起来。
- **路 B（自研全家桶，原方案 M1–M6 不变）**：差异化=财务优先级引擎+券衰减+评测排名闭环+一体化面板；余额适配器实现可对照 dsh-provider-usage 的 v2 适配器契约设计，少走弯路。
- **路 B'（站在先例上组装）**：以 dsh-quota-panel 为余额层底座、借鉴 dsh-delegate-router 的分派思想，自研部分聚焦"财务排序引擎+评测闭环"两个空白模块——工作量介于 A/B 之间。

## 附：证据与检索方式

- 目录 JSON：awesome-dsh-plugin.com/plugins.json（10,778 条，count 字段与 2026-11-12 updated 水印）
- 分类：`usage`=用量与计费（150+），`model`=模型与账号接入（200+）；另有全目录关键词扫描（route/fallback/quota/balance/eval/bench/arena/ranking/评测/榜单/排名）
- 本地索引源可用：`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`（dshmarket README 建议，plugin_market 工具可加；添加索引源需用户操作）
- 热度口径：★=GitHub stars，dl=近 30 天 npm 下载（目录字段 downloads）
