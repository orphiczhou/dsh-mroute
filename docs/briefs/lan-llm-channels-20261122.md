# LAN DSH 实例模型渠道补齐（2026-11-22）

## 1. 结论

四台 LAN DSH web 实例（A/B/C/D）已从“只有 DeepSeek 官方渠道”补齐为本机桌面实例所用的 7 个 provider：

| 节点 | 实例 | DSH_HOME | 状态 |
|---|---|---|---|
| A | dsh-a `.23:3081` | `/home/orphic/.dsh-lan-a` | 7 provider，catalog failures=[] |
| B | dsh-b `.23:3082` | `/home/orphic/.dsh-lan-b` | 7 provider，catalog failures=[] |
| C | dsh-c `.21:3081` | `/home/orphic/.dsh-lan-c` | 7 provider，catalog failures=[] |
| D | dsh-d `.24:3081` | `C:\Users\User\.dsh-lan-d` | 7 provider，catalog failures=[] |

provider：`deepseek-official`、`opencode-go`、`zai-coding-cn`、`xiaomi`、`giteeinter`、`proma`、`opencodegosota`。

## 2. 做法

1. 以本机桌面 profile `C:\Users\sir_c\.dsh\profiles\desktop\cordis.patch.yml` 的 `llm-pi-ai` 段为模板，生成 `tmp/lan-llm-patch.yml`（`- insert:` → `id: llm-pi-ai`，完整 providers/models）。
2. 从本机 `C:\Users\sir_c\.dsh\.credentials.yaml` 提取远端需要的 7 个 refs，生成 `tmp/lan-credentials.yaml`（仅 `version: 1` + `refs:`，不含本地代理与飞书凭据）。
3. 每节点：
   - 备份 `profiles/lan/cordis.patch.yml` 为 `.bak-llm`；
   - 复制 `.credentials.yaml` 到该节点 DSH_HOME 并设为 600 / Windows 仅 User ACL；
   - 确保 patch 末尾换行后追加 `lan-llm-patch.yml`；
   - 重启 systemd（A/B/C）或计划任务 `DSH-LAN-D`（D）。

远端凭据文件路径：

- A `/home/orphic/.dsh-lan-a/.credentials.yaml`
- B `/home/orphic/.dsh-lan-b/.credentials.yaml`
- C `/home/orphic/.dsh-lan-c/.credentials.yaml`
- D `C:\Users\User\.dsh-lan-d\.credentials.yaml`

**不写入仓库、不写入日志。** 本文不记录任何密钥值。

## 3. 排除项

`glmflash-free` 未下发：它的 baseURL 是 `http://127.0.0.1:8484/v1`，属于本机本地代理，远端节点不可达。其余 7 个渠道（含默认 deepseek）全部下发。

## 4. 验证

### 4.1 目录（四节点）

`POST /api/session/modelCatalog` 均返回：

- `default = deepseek-official/deepseek-flash`
- `routableProviders` = 7 个 provider
- `failures = []`
- 模型分组（2026-11-22 下架后复测）：deepseek-official 2、opencode-go 5、zai-coding-cn 2、xiaomi 2、giteeinter 7、proma **5**、opencodegosota **5**；总数由 7 个 provider 保持不变，仅删除两个不可用模型。

### 4.2 实际模型调用（非 DeepSeek）

用临时 DSH 会话 `session/selectModel` + `session/prompt` 验证，不只看目录：

| 节点 | provider/model | 结果 | 会话 |
|---|---|---|---|
| A | zai-coding-cn/glm-5.3-flash | `OK` | `session-aff5c0b2-3c04-42b8-9b39-8541bbab7959` |
| B | zai-coding-cn/glm-5.3-flash | `OK` | `session-219f73a7-62c9-407b-b6f5-febdb0795c8d` |
| C | zai-coding-cn/glm-5.3-flash | `OK` | `session-45d37d50-4900-4f96-b8ba-49a6e1b1ab64` |
| D | zai-coding-cn/glm-5.3-flash | `OK` | `session-e78806da-ecfe-4791-8233-735e4b1d1858` |

A 额外验证：

- opencode-go/qwen3.8-flash → `OK`（`session-79b75ffb-8485-4d08-85f2-fd156e20be45`）
- xiaomi/mimo-v2.6-flash → `OK`（`session-d7c96646-cd53-4003-94d5-02545bacd992`）
- giteeinter/GLM-5.3-Flash → `OK`（`session-42782652-f16c-4829-b7f3-b8b651a7a240`）

不可用模型处置（2026-11-22）：

- proma/gpt-6.1-terra-1 曾 `selectModel` 成功、prompt accepted，但会话 idle 后无 assistant 文本（`session-2528c6b1-7f01-4d39-8d8c-3ff66ec82e18`）。
- opencodegosota/qwen3.8-max 同样 accepted 后无 assistant 文本（`session-f9e9d61e-9717-42e3-a9fc-ff07401c71a9`）。
- 用户已确认二者不可用；已从本机桌面与四节点 `cordis.patch.yml` 删除对应 `- id:` 块（保留 `qwen3.8-max-0902`），备份 `.bak-models-20261122`。四节点 `modelCatalog` 复测：`routableProviders` 仍 7、`failures=[]`，proma/opencodegosota 各 5 个模型。桌面 GUI 需重启后模型选择器才刷新。

## 5. 回滚

每节点 `profiles/lan/cordis.patch.yml.bak-llm` 与 `.credentials.yaml.bak-llm` 保留原文件；回滚时覆盖并重启对应服务/任务。

## 6. 安全边界

- `.credentials.yaml` 仅 600（A/B/C）或 `DESKTOP-G65JU1V\User:(F)`（D）；内容不入库、不进日志。
- 7 个 provider 的 API key 与桌面端同源；D 的 `web-lan.log` 含 launch token，仍按敏感文件管理。
- 该配置只影响模型路由目录与凭据；不改变 DSH web 端口、认证、调度器或状态面板。
