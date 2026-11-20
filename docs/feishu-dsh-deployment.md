# DSH × 飞书接入与知识库部署方案

> 状态：聊天桥插件已安装并 active（@aiwayds/dsh-feishu 0.18.0）；飞书应用已创建，5 项应用身份权限已开通，两个知识库已建并分享给用户。知识库层使用官方 `@larksuiteoapi/lark-mcp` + 飞书多维表格（Bitable），MCP 配置已写入，待 DSH 重启后工具生效。
> 日期：2026-11-20。本文件是部署记录与操作手册，不含任何 App Secret / Token。

## 1. 目标与边界

1. 在飞书里与 DSH 会话对话、接收审批/提问卡片、在手机上继续桌面会话。
2. 建立两个知识库：
   - **个人知识库（Personal KB）**：用户私有的笔记、文档、灵感、决策记录；只有用户本人与用户授权的 DSH 实例可访问。
   - **Agent 公用知识库（Public KB）**：多个 Agent/多台虚拟机共享的事实、约定、证据、踩坑记录；按“可引用、可追溯、可冲突标注”的方式维护。
3. 为未来局域网多台虚拟机上的 Agent 协作预留结构，不在本阶段实现跨机网关。

## 2. 选型结论

### 2.1 聊天桥：@aiwayds/dsh-feishu 0.18.0

- 单 insert，不覆盖宿主行；与 DSH 0.2.2-rc.3 兼容（peer 仅可选 `@deepseek-ai/dsh-skill`）。
- 驱动**已有** DSH 会话，支持 `/resume`、审批卡、ask_user 卡、`/model` `/think` `/permission`、群聊 @、图片、后台推送、配对模式。
- 已安装、已 active；插件内置 `dsh-feishu-config` 技能作为配置正源。

### 2.2 知识库：@larksuiteoapi/lark-mcp 0.5.1 + Bitable

- 官方 OpenAPI MCP，Bitable 可读写；Docx 只能导入/读取，不能直接编辑（官方限制）。
- 本地部署在 `C:\Users\sir_c\.dsh\mcp\lark-mcp`（`npm install --ignore-scripts`，196 包）。
- 用 stdio + 环境变量传凭据，避免 secret 进命令行；MCP 配置开 `expandTemplates` 解析 `${credential:...}`。
- 工具面按 KB 需要裁剪（Bitable app/table/field/record、docx import/raw、drive permission、wiki read），避免系统提示膨胀。

### 2.3 为什么不用本地知识库插件

`dsh-knowledge-base` / `dsh-knowledge-base-local` 绑定单机存储，无法满足“飞书内查看 + 多机 Agent 共享”。飞书 Bitable 天然多端、可分享、可 API 读写，适合作为共享事实层。

## 3. 部署阶段

### 阶段 A：飞书应用与聊天桥（已完成 2026-11-20）

实际结果：应用 `DSH-Laptop`（`cli_ab8ab34341789d07`），机器人 open_id `ou_1e75a2bd06743b8b1bda165d39cf643d`，操作者 open_id `ou_6cfded525e9b85bc9e944ea0cabe6900`；`/feishu-onboard` 已成功，状态文件 `pairedOperators` 已写入。

1. 在 Web GUI 输入 `/feishu-onboard`。
2. 选择「没有 — 扫码一键创建（推荐）」。
3. 打开 ask 卡 detail 中的链接（或终端二维码），用手机飞书扫码确认。
4. 回到卡片点「我已完成确认」。
5. 插件写入：
   - 凭据 refs：`DSH_FEISHU_APP_ID`、`DSH_FEISHU_APP_SECRET`（`~/.dsh/.credentials.yaml`，经 DSH credentials 服务）
   - 管理员：`C:\Users\sir_c\.dsh\dsh-feishu-state.json` 的 `pairedOperators`
   - 同进程热激活，日志出现 `dsh-feishu: armed (1 operator(s), feishu)`
6. 在飞书私聊机器人发一条消息验证；再发 `/resume` 绑定本会话。

### 阶段 B：补知识库权限（已完成 2026-11-20）

扫码创建的应用默认只有 IM 六项权限。需要补：

| 权限 | 用途 |
|---|---|
| `bitable:app` | 多维表格读写 |
| `docx:document` | 云文档读取 |
| `docx:document:create` | 导入创建云文档 |
| `drive:drive` | 上传导入文件、加协作者 |
| `wiki:wiki` | 知识库节点读取（可选，预留） |

操作（实际执行）：打开
`https://open.feishu.cn/app/<APP_ID>/auth?q=bitable:app,docx:document,docx:document:create,drive:drive,wiki:wiki&op_from=openapi&token_type=tenant`

**必须带 `token_type=tenant`**；否则弹窗默认停在“用户身份权限”tab，5 个复选框全部 disabled。带此参数后 5 个复选框可勾选，点“确认开通权限”后表格立即显示“应用身份 / 已开通”；版本页仍显示“当前修改均已发布”，无需另建版本。API 复核：`GET /open-apis/drive/v1/files` 200、`GET /open-apis/wiki/v2/spaces` 200、`GET /open-apis/bitable/v1/apps/<fake>` 返回 91402（仅假 token）——权限已生效。

### 阶段 C：接入 lark-mcp（配置已写入，重启后生效）

实际：`lark-kb` 已追加到 `C:\Users\sir_c\.dsh\profiles\desktop\cordis.patch.yml`；15 个点号工具；`expandTemplates: true`。重启 DSH 后应出现 `mcp__lark-kb__*`。

在 `C:\Users\sir_c\.dsh\profiles\desktop\cordis.patch.yml` 追加：

```yaml
- insert:
    - id: lark-kb
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: lark-kb
        transport: stdio
        command: C:\Program Files\nodejs\node.exe
        args:
          - C:\Users\sir_c\.dsh\mcp\lark-mcp\node_modules\@larksuiteoapi\lark-mcp\dist\cli.js
          - mcp
          - -t
          - bitable.v1.app.create,bitable.v1.appTable.create,bitable.v1.appTable.patch,bitable.v1.appTable.delete,bitable.v1.appTable.list,bitable.v1.appTableField.list,bitable.v1.appTableField.create,bitable.v1.appTableRecord.create,bitable.v1.appTableRecord.update,bitable.v1.appTableRecord.search,bitable.v1.appTableRecord.batchCreate,docx.builtin.import,docx.v1.document.rawContent,drive.v1.permissionMember.create,wiki.v2.space.getNode
          - -l
          - zh
          - -c
          - snake
          - --token-mode
          - tenant_access_token
        env:
          APP_ID: ${credential:DSH_FEISHU_APP_ID}
          APP_SECRET: ${credential:DSH_FEISHU_APP_SECRET}
          LARK_DOMAIN: https://open.feishu.cn
        expandTemplates: true
        toolCallTimeoutMs: 60000
        failOnStartupError: false
        reconnect: true
```

注意：
- `-t` 必须用点号 API 名；snake 名会触发 `-32601`。
- `expandTemplates: true` 才会解析 `${credential:...}`，并把解析值加入脱敏集合。
- 若启动日志出现 `keytar.node` 缺失警告，可忽略；tenant token 模式不需要 user token 存储。
- 改完重启 DSH，让 MCP 客户端解析凭据并注册工具。

### 阶段 D：创建知识库（已完成 2026-11-20）

实际结果（脚本 `tmp/feishu-create-kb.mjs`，租户 token 直调 OpenAPI）：

- 个人库：`个人知识库（DSH）`，app_token `TBwwbtadwa8Ttesoq1bcpneonfh`，URL `https://dcnvmq0tna0s.feishu.cn/base/TBwwbtadwa8Ttesoq1bcpneonfh`；表 `知识条目`（`tblZMrjXfYHV4fW2`）。
- 公用库：`Agent 公用知识库（DSH）`，app_token `I0udbwofNa8D7ws7UNAcxYvFnue`，URL `https://dcnvmq0tna0s.feishu.cn/base/I0udbwofNa8D7ws7UNAcxYvFnue`；表 `知识条目`（`tblPu4WppPmHRPYM`）、`协作约定`（`tbl2Amjf6v8bWF2i`）、`Agent 登记`（`tbl56Bke6na6VNsM`）。
- 已写入种子：个人 2 条、公用知识 3 条、协作约定 2 条、Agent 登记 2 条。
- 已用 `drive_v1_permissionMember.create` 把两个 Bitable 以 `openid` / `full_access` / `container` 分享给操作者；复核成员列表含应用自身与操作者。
- 已通过 `im/v1/messages` 给操作者发送含两个链接的飞书消息（message_id `om_x100b7f35f36674a0c0608b2aa0d85e4`）。

## 4. 知识库结构

### 4.1 个人知识库 `知识条目`

| 字段 | 类型 | 说明 |
|---|---|---|
| 标题 | 文本（主字段） | 一句话主题 |
| 内容 | 多行文本 | 正文；长文可放这里 |
| 摘要 | 文本 | 便于列表扫描 |
| 标签 | 多选 | `DSH`、`飞书`、`插件`、`模型路由`、`Agent`、`运维`、`灵感`、`待整理` |
| 类型 | 单选 | `笔记`、`文档`、`对话`、`链接`、`代码`、`决策` |
| 来源 | 文本 | URL / 文件路径 / 会话 id |
| 状态 | 单选 | `草稿`、`已整理`、`归档` |
| 创建时间 | 创建时间 | 自动 |
| 更新时间 | 修改时间 | 自动 |
| 附件 | 附件 | 可选 |
| 关联项目 | 文本 | 可选 |

### 4.2 Agent 公用知识库 `知识条目`

| 字段 | 类型 | 说明 |
|---|---|---|
| 主题 | 文本（主字段） | 可检索的事实/结论标题 |
| 结论 | 多行文本 | 可直接引用的事实或判断 |
| 证据 | 多行文本 | 文件路径+行号 / URL / 命令输出摘要 |
| 适用范围 | 多选 | `全局`、`DSH插件`、`飞书集成`、`模型路由`、`部署运维`、`安全`、`其他` |
| 置信度 | 单选 | `高`、`中`、`低`、`待验证` |
| 维护者 | 文本 | Agent 名称 / 会话 id |
| 最后验证 | 日期 | 最近一次验证时间 |
| 状态 | 单选 | `生效`、`过期`、`争议`、`草案` |
| 创建时间 | 创建时间 | 自动 |
| 更新时间 | 修改时间 | 自动 |
| 相关条目 | 文本 | 关联主题或链接 |
| 备注 | 多行文本 | 可选 |

### 4.3 Agent 公用知识库 `协作约定`

| 字段 | 类型 | 说明 |
|---|---|---|
| 约定 | 文本（主字段） | 规则标题 |
| 内容 | 多行文本 | 具体规则 |
| 适用角色 | 多选 | `协调者`、`执行者`、`审计者` |
| 生效日期 | 日期 | 可选 |
| 状态 | 单选 | `生效`、`废止`、`草案` |

### 4.4 Agent 公用知识库 `Agent 登记`（可选）

| 字段 | 类型 | 说明 |
|---|---|---|
| Agent | 文本（主字段） | 唯一名称 |
| 主机 | 文本 | VM/机器标识 |
| 能力 | 多选 | `编码`、`调研`、`审计`、`运维`、`飞书` |
| 当前任务 | 文本 | 可选 |
| 最后心跳 | 日期 | 协调者更新 |
| 状态 | 单选 | `在线`、`离线`、`忙碌` |

## 5. 多 Agent 协作设计（预留）

- **个人库与公用库分离**：个人库只给个人 DSH 实例的凭据；公用库另建一个“公用 Agent”飞书应用或由中心网关持有凭据，避免把个人应用 secret 分发到多台 VM。
- **中心 MCP 网关**：在一台常驻机器上以 `streamable-http` 暴露 lark-mcp，只允许公用库的 app_token/table_id；其他 Agent 通过 MCP URL + Bearer 访问，不直接持有飞书 secret。
- **写入协议**：
  1. 先搜后写：用 `bitable_v1_appTableRecord_search` 按主题/标签查重。
  2. 事实必须带证据与置信度；不确定的写“待验证”。
  3. 冲突不覆盖：新增一条“争议”记录，在 `相关条目` 互链，由协调者裁决。
  4. 每次写入在 `维护者` 留下 Agent 名称/会话 id。
- **权限**：公用库对“公用 Agent 应用”开 `bitable:app` 读写；对普通 Agent 只读或按表授权。个人库不参与公用网关。

## 6. 验收清单

- [x] `/feishu-onboard` 成功，日志 `armed (1 operator(s), feishu)`
- [ ] 飞书私聊机器人能收到回复；`/resume` 能绑定会话
- [ ] 审批卡/提问卡在飞书可点，桌面端同步
- [x] 应用权限含 `bitable:app`、`docx:document`、`docx:document:create`、`drive:drive`、`wiki:wiki`，且已生效
- [ ] 重启后 `mcp__lark-kb__*` 工具出现
- [x] 两个 Bitable 创建成功，字段与上表一致
- [x] 用户能在飞书“我的空间/共享”看到两个 Bitable，且有完全访问权限（成员列表已复核；页面可见性待用户确认）
- [x] 种子记录可读回；个人库与公用库内容不混
- [ ] 断网/凭据错误时 MCP 启动失败不阻塞 DSH（`failOnStartupError: false`）

## 7. 实际部署记录（2026-11-20）

| 项 | 值 |
|---|---|
| 飞书应用 | `DSH-Laptop` / `cli_ab8ab34341789d07` |
| 机器人 open_id | `ou_1e75a2bd06743b8b1bda165d39cf643d` |
| 操作者 open_id | `ou_6cfded525e9b85bc9e944ea0cabe6900` |
| 聊天桥插件 | `@aiwayds/dsh-feishu@0.18.0`，active |
| 应用身份权限 | 5 项已开通（bitable:app、docx:document、docx:document:create、drive:drive、wiki:wiki） |
| 个人库 | app_token `TBwwbtadwa8Ttesoq1bcpneonfh`，table `tblZMrjXfYHV4fW2` |
| 公用库 | app_token `I0udbwofNa8D7ws7UNAcxYvFnue`，tables `tblPu4WppPmHRPYM` / `tbl2Amjf6v8bWF2i` / `tbl56Bke6na6VNsM` |

验证：
- `tmp/feishu-scope-test.mjs`：driveFiles 200、wikiSpaces 200、bitableFake 91402、docxFake 99992402。
- `tmp/feishu-create-kb.mjs`：两个 app 创建、4 张表创建、9 条种子写入、2 次分享、1 条飞书消息，均成功。
- `tmp/feishu-kb-verify.mjs`：两个 Bitable 的成员均含应用自身与操作者（full_access）；记录数 2 / 3+2+2。
- 待重启验证：`mcp__lark-kb__*` 工具出现；飞书私聊发 `/resume` 绑定会话。

**坑（必记）**：权限深链必须带 `&token_type=tenant`，否则“应用身份权限”tab 不激活，5 个复选框 disabled，点确认无效。这是本次唯一卡点。

## 8. 会话镜像群（fork，2026-11-20 已实测）

原 `@aiwayds/dsh-feishu` 是“单绑定 + `/resume` 切换”模型。为达到“每个根会话一个独立飞书会话、不用切来切去”的体验，fork 为 `@local/dsh-feishu-mirror`，新增 `SessionMirror`：

- 监听宿主 `session/created`，只处理根会话（`parentSession` 不存在、`origin !== 'subagent'`、`delegationDepth === 0`，且创建时间晚于镜像启动时间，避免回填旧会话）。
- 调 `im.chat.create` 建**仅含操作者与机器人**的私密群，群名 `DSH - <标题>`（超过 60 字符截断；标题为空时用 `新会话 <id 前 8 位>`）。
- 持久化 `chatBindings[chatId] = {sessionId,title,createdAt}` 与 `sessionToChat[sessionId] = chatId`；重载后仍可路由（`decodeMirrorMap` 同时接受对象与字符串）。
- 入站：群内文本免 @ 注入对应会话（`SessionBinder.bind(sessionId)` + `agent.followup(createUserMessage(...))`）；首条消息若群名仍是默认值，用消息前 24 字重命名群。
- 出站：监听 `session/event` 的 `assistant/message`，从 `event.data.message.content` 取最终文本，按 `sessionToChat` 回卡片到对应群。
- 管理私聊、`/resume`、审批/提问卡仍保留；MVP 镜像群暂只支持文本与最终回复（非流式），审批/ask 卡仍走管理私聊。

部署事实：

| 项 | 值 |
|---|---|
| fork 包 | `@local/dsh-feishu-mirror@0.19.0-mirror.8`（`plugin-feishu-mirror/`） |
| 配置 | `mirrorMode: group`、`mirrorGroupPrefix: DSH`、`operators: [ou_6cfded...]` |
| 新增权限 | `im:chat`（建群/改群名/读群）、`im:message.group_msg`（群内免 @ 收消息） |
| 测试群 | `oc_534926d3c1d2d4bd825d32a415b15882`（`DSH - 测试6`） |
| 入站证据 | 群内发“测试6” → 会话 `session-8029c90b-...` 的 projcache `turnOutline` 记录 prompt“测试6”、response“测试6 已收到 —— 镜像通道正常…” |
| 出站证据 | 飞书 `im/v1/messages` 返回助手回复卡 `om_x100b7f3681a608a8c0e1885d15988a8`（interactive） |

维护注意：

1. 一个飞书应用只能有一个 WebSocket 连接，所以镜像必须复用 `FeishuBot` 的同一 `LarkClient`，不能为每个群新建 bot。
2. 插件重载时 `session/created` 可能对旧会话再次触发；`startedAt` + `header.createdAt` 守卫用于避免回填建群（本次曾误建 3 个群，已删除并清理 state）。
3. `sessionToChat` 是 `sessionId -> chatId` 字符串，`chatBindings` 是 `chatId -> 对象`；两者 decoder 都要兼容。
4. 原插件 `@aiwayds/dsh-feishu` 与 fork 的 insert id 不同（`dsh-feishu` vs `dsh-feishu-mirror`），但同一 app 会争抢 WebSocket 锁；部署时只启用一个，原插件已 `disabled: true`。
