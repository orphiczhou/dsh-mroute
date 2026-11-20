# 任务书：gemini-web MCP → 标准 API 服务可行性研究

> 派发人：lead ｜ 执行人：gemini-api-research ｜ 日期：2026-11-13
> 产出：`D:\Codes\DSH小插件\gemini-eyes\docs\api-service-feasibility.md`

## 背景（一句话）
本机 DSH 已有一个把 gemini.google.com 网页端桥接成 MCP 服务的 Python 项目（用户自己维护的 fork，已在工作区统一管理），用户想知道：**能否把它转换成标准的 API 服务，供本机 Agent 调用**。

## 研究对象与环境事实
- 仓库（唯一正源，含完整源码与文档）：`D:\Codes\DSH小插件\gemini-eyes`
- 技术栈：Python ≥3.10 + FastMCP，cookie 鉴权（复用浏览器 Google 会话，无官方 API/无 API Key），10 个 MCP 工具
- 必读（按序）：
  1. `D:\Codes\DSH小插件\AGENTS.md`（纪律与项目背景，重点 §2 §8）
  2. 仓库内 `README.md`（工作原理、模型档位、工具表）
  3. 仓库内 `INSTALL-FOR-AGENTS.md`（**§7 已知边界**很重要）
  4. `docs/review-20261102.md`
  5. 源码 `gemini_mcp/server.py`（工具注册、http transport、Bearer 中间件）
  6. `gemini_mcp/gemini_client.py`（StreamGenerate/上传/batchexecute/韧性重试/错误码）
  7. `gemini_mcp/cookie_extractor.py`、`tests/`（合成数据）
- uv 位置：`D:\Python314\Scripts\uv.exe`；跑测试在仓库目录下 `uv run pytest -q`（测试全合成数据、不联网、必须全绿——这也是你的验证手段之一）
- 已核实事实（lead 亲测，可直接引用）：server 已自带 `--transport http`（streamable HTTP，端口 8900，Bearer token 中间件，server.py 约 L97-100 与 L663-694）；`uv run python -c "...list_tools..."` 在工作区副本注册 10 工具全成功。你的研究要在此基础上往「标准 API 服务」延伸。
- 已知边界（来自 INSTALL §7）：同一份 Cookie 只允许一个客户端轮换 `__Secure-1PSIDTS`；网页端导入仓库上下文不能经 MCP 续聊；生视频异步 5~15 分钟；模型档位靠环境变量而非每请求参数。

## 安全红线（违反即任务失败）
1. **禁止读取/打印/复制 `C:\Users\sir_c\.config\gemini-web-mcp\cookies.json` 的任何内容**；凡涉及 Cookie 只讨论机制不碰内容。
2. **禁止对 gemini.google.com 发起任何真实调用**（不启动真实 server 连真实 Cookie 跑联调；分析靠读码 + 合成测试）。
3. 本任务**只做研究不改代码**：唯一允许写入的文件是本任务书指定的产出文档。
4. 报告里不得出现任何 Cookie 片段、token、账号标识。

## 要回答的问题（逐条回答，结论必须带证据：文件路径+行号 或 测试输出摘录）
1. **现状盘点**：当前对外接口形态有哪些（stdio MCP / streamable HTTP MCP）？鉴权、并发模型、超时与长任务（生视频轮询）如何处理？
2. **候选方案对比**：转成「标准 API 服务」至少有四条路线，逐一论证可行性+改造成本+适配面：
   - a) MCP streamable HTTP（现状已有，验证其完整性与缺口）；
   - b) OpenAI 兼容 `/v1/chat/completions`（含 `/v1/models`，流式 SSE 映射 StreamGenerate，图片经 base64/URL 内容部件映射 analyze_media 与 send_message 附件，generate_image 映射为返回 image_url 的 assistant 消息或专用扩展字段）；
   - c) 简洁自研 REST（按 10 个工具一一映射 `/tools/{name}` 或资源化端点）；
   - d) 挂进 DSH 侧（作为 HTTP MCP 被 dsh-mcp-client 消费的可行性——可查 DSH asar：`D:/DSHarness/resources/app.asar/dsh/` 下 `node_modules/@deepseek-ai/dsh-mcp-client/`。**注意：asar 只有 read 工具能读，pwsh/glob/grep 打不开**；读不到就明确标注「未能核实」并给验证建议，不许编造）。
   - 对比维度：本机 Agent 生态适配（DSH 子会话、Cherry Studio、OpenAI SDK 客户端）、流式体验、长任务语义、鉴权改造、Cookie 单写者约束的影响。
3. **映射难点逐个裁决**（每项给「能/难/不能 + 理由 + 证据」）：
   - 多轮会话：conversation_id ↔ OpenAI 无状态协议的 state 映射（metadata / 服务端 session 表等方案）
   - system prompt 注入位置
   - 错误码翻译：1013/1037/1050/1052/1060 → HTTP 状态与错误体
   - 每请求选模型/思考档：现在是环境变量（README 模型档位表）——改成每请求参数要动哪里，给行号级出处
   - 文件上传：resumable 两阶段 → multipart
   - 生图/生视频的同步/异步语义
4. **推荐方案**：给一个主推架构（端点清单、请求/响应示例 JSON、SSE 事件序列、鉴权设计、配置面 env 清单、目录/文件级落点——新文件放哪、复用 gemini_client 哪些方法），说明为什么不主推另外几条；以及一个最小可用版本（MVP）的裁剪边界。
5. **工作量与实施计划**：MVP 分几步、每步动哪些文件、估计代码量级、测试策略（合成测试怎么覆盖 SSE 与上传）；风险清单（网页端接口漂移、封号风险、单 Cookie 单写者对多 Agent 并发的约束及缓解——如多账号池/请求排队）。

## 产出要求
- 报告写到 `D:\Codes\DSH小插件\gemini-eyes\docs\api-service-feasibility.md`（中文，≤600 行）
- 结构：开头「一页结论」→ 上述 5 问逐条 → 末尾「证据索引表」（结论先行、证据可点验）
- 完成前用 `send_message` 把「一句话结论 + 3 条关键发现」发给父会话（lead）
- 最终回复给出：报告路径、一页结论、跑过的验证命令与结果（pytest 结果必须如实）

## 上下文纪律
读大文件用 offset/limit 分段读，别整读 gemini_client.py（约 1200 行）——先 grep 定位再精读相关段；报告写完即收尾，不发散。若上下文接近 50%，先 `session_handoff` 同层交接（继承同一任务书与产出路径）再继续。
