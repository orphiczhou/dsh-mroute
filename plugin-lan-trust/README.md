# dsh-lan-trust · 可信 LAN 自动登录网关

> DSH Web 每个进程都会生成一次性 launch token；本插件**不修改 DSH 认证**，而是在同进程内新增一个只读入口网关：从启动行捕获 token，服务端完成 `token → dsh-auth cookie` 交换，把 cookie 交给可信网段浏览器，再 302 到干净的 DSH 地址。浏览器看不到 token。

- 版本：0.1.0
- 依赖：无外部依赖；DSH 0.2.2-rc.3 实测
- 边界：**只适用于直连、可信、不可路由到公网的 LAN**；使用者在 allowlist 内即获得 owner 级访问权

## 1. 为什么需要它

DSH Web 默认要求 `/` 带 `?token=<launch-token>` 或已签名 cookie，否则 401：

```text
dsh web authentication required; reopen the URL printed by dsh web.
```

`trustedHosts` 只放宽 Host/Origin fence，不放宽认证；DSH 0.2.2-rc.3 没有 `noAuth` / `trustedNetworks` 开关。直接改 `HostConnectionService` 也不可靠：运行时路由用的是 app-boot 打包副本，插件动态 import 到的类不是同一份。

网关方案不改 DSH 内部：DSH 的 3081 仍然要 token；只有网关端口（默认 3095）对 allowlist 免 token。

## 2. 工作方式

```text
浏览器 ──GET http://LAN:3095/──▶ gateway
                                  │ 读取进程内捕获的 launch token
                                  │ fetch http://127.0.0.1:3081/?token=...
                                  ▼
                              DSH Web
                                  │ 303 → /  + Set-Cookie: dsh-auth-...
                                  ▼
浏览器 ◀──302 / + Set-Cookie──── gateway
   │
   └──GET http://LAN:3081/ (带 cookie)──▶ DSH Web 200
```

- token 只存在 DSH 进程内存（`lib/token.js` 的滚动扫描器），不落盘、不写日志、不进浏览器 URL/HTML。
- 浏览器最终地址是 `http://LAN:3081/`，书签/历史不含 token。
- cookie 是 DSH 签名的 HttpOnly cookie，默认 30 天。

## 3. 安装

```bash
# 节点本地目录安装（示例：dsh-a）
dsh plugin --profile lan add /home/orphic/plugin-lan-trust
```

`package.json` 自带 `dsh.bundle.patch`，安装后 `dsh --profile lan --dump-config` 应出现：

```yaml
- id: lan-trust
  name: '@local/dsh-lan-trust'
  config:
    enabled: true
    port: 3095
    allowLoopback: true
    allowedCidrs: [192.168.3.0/24, 127.0.0.1/32, '::1/128']
```

bundle patch **没有 `origin`**（每节点不同），必须在 profile 的 `cordis.patch.yml` 里补：

```yaml
- id: lan-trust
  config:
    enabled: true
    origin: http://192.168.3.23:3081
    port: 3095
    allowedCidrs:
      - 192.168.3.0/24
      - 127.0.0.1/32
      - '::1/128'
```

A/B 同机必须错开端口：A `3095`、B `3096`；C/D 各自 `3095`。改 patch 后重启该实例的 systemd/计划任务。

> 远程 Windows 安装必须显式设置 `DSH_HOME`，并用 `dsh.cmd`（PowerShell 执行策略禁止 `.ps1` 包装）。安装时若 DSH 正在运行，可能因 `package.json` 被占用报 `EPERM rename`；先停计划任务/服务，装完再启动。

## 4. 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉则只加载不监听 |
| `origin` | **必填** | 本节点 DSH Web base，如 `http://192.168.3.23:3081`；不要带 token/path |
| `port` | `3095` | 网关端口；同机多实例必须不同 |
| `host` | `0.0.0.0` | 监听地址；只给 LAN 用，别做公网映射 |
| `allowedCidrs` | `192.168.3.0/24` + loopback | 直接 socket 源地址 CIDR；IPv4 + `::1/128` |
| `allowLoopback` | `true` | 是否允许 127.0.0.1/::1 |

不支持 `X-Forwarded-For`；放在反代后面会把所有请求看成反代地址，**不应这样部署**。

## 5. 路由

| 路径 | 行为 |
|---|---|
| `GET /health` | `{ok, tokenCaptured}`；不泄露 token |
| `GET /` / `GET /login` | 允许的源：302 + `set-cookie` + `location: origin/`；不允许：403；无 token：503；上游失败：502 |
| 其他方法 | 405 |

## 6. 验证

```bash
curl -s http://192.168.3.23:3095/health
# {"ok":true,"tokenCaptured":true}

curl -i http://192.168.3.23:3095/
# HTTP/1.1 302
# location: http://192.168.3.23:3081/
# set-cookie: dsh-auth-...; Path=/; HttpOnly

# 浏览器直接打开网关，最终落在 http://192.168.3.23:3081/，不需要 token
```

四节点实测（2026-11-21）：A `3095`、B `3096`、C `3095`、D `3095` 均返回 302 + cookie，浏览器最终进入 `DeepSeek Harness` 工作区页；非信任源拒绝由 CIDR 单测覆盖（本机无第二网段，端到端未做）。

## 7. 安全边界（必读）

- **allowlist 内 = owner**。网关和 DSH 的 owner Peer 等价；不要把 3095/3096 映射到公网，也不要放在不受信反代后面。
- 只信 `req.socket.remoteAddress`，不信 `X-Forwarded-For`。
- token 只在内存；但 DSH 自己的启动日志仍可能包含带 token 的 URL，日志权限要收紧。
- 网关无认证、无速率限制；LAN 内被入侵的主机可以拿到 owner 权限。需要更强隔离时，改用 WireGuard/Tailscale ACL 或面板级认证后再开。
- DSH 原生 3081 仍要 token；如果用户直接打开 3081 仍会 401，这是预期行为。

## 8. 限制与故障排查

- **tokenCaptured=false**：插件加载晚于启动行打印，或 DSH 改了日志格式；重启实例，确认 `apply` 在 `dsh web: http://...` 之前执行。日志里出现 `[lan-trust] module loaded` 只在 `LAN_TRUST_DEBUG=1` 时落盘。
- **监听失败**：端口被占用/无权限；`len`/`ss` 查端口，改 `port`。
- **403**：源地址不在 `allowedCidrs`；检查客户端真实 IP，勿加反代。
- **502**：`origin` 不可达或 token 过期；先 curl `origin/?token=` 手工验证。
- **cookie 不生效**：浏览器拒绝 HttpOnly/SameSite cookie 或访问的是 IP 与 cookie authority 不一致；用 `origin` 中的同一主机名/IP 打开。
- 调试：`LAN_TRUST_DEBUG=1` 时写 `$DSH_HOME/lan-trust-debug.log`；生产不要开。

## 9. 测试

```bash
node --test tests/*.test.mjs   # 16/16
```

覆盖 CIDR 解析/匹配、token 扫描、gateway 路由与 cookie 透传、index 配置校验。

## 10. 文件

- `lib/token.js` — stdout tee + 滚动 token 扫描
- `lib/trust.js` — IPv4/loopback CIDR 匹配
- `lib/gateway.js` — HTTP 网关 / token 交换 / cookie 透传
- `lib/index.js` — DSH 插件入口（`inject=[]`，不依赖宿主服务）
- `cordis.patch.yml` — bundle 默认（port/CIDR；origin 必填项留空）
