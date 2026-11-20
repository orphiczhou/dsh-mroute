# NOTICE

本包 `@local/dsh-feishu-mirror` 是 [`@aiwayds/dsh-feishu`](https://www.npmjs.com/package/@aiwayds/dsh-feishu) 0.18.0 的本地 fork，原作者 fan56，Apache-2.0。

- 上游仓库：<https://github.com/fan56/dsh-feishu>
- 上游版本：0.18.0（`lib/` 与 `skills/` 原样保留）
- 本 fork 修改：
  - 新增 `lib/mirror.js`：`SessionMirror` 监听宿主 `session/created`，为每个根会话创建飞书私密群并维护 `chatBindings` / `sessionToChat`；群内文本免 @ 注入对应会话，助手最终回复卡片回群。
  - `lib/config.js`：新增 `mirrorMode`、`mirrorGroupPrefix` 两个配置键。
  - `lib/state-store.js`：运行态增加 `chatBindings` 与 `sessionToChat`，并兼容字符串/对象两种映射值。
  - `lib/lark-client.js`：新增 `createChatGroup`、`updateChatName`。
  - `lib/bot.js`：启动/停止镜像路由器；入站消息在 group @ gate 之前交给镜像路由器。
  - `lib/index.js`：构造 `SessionMirror` 并注入 `FeishuBot`。
  - `cordis.patch.yml`：bundle 名改为 `@local/dsh-feishu-mirror`，insert id `dsh-feishu-mirror`。

原包 LICENSE 保留在 `LICENSE`（Apache-2.0）。本 fork 的修改同样按 Apache-2.0 发布。
