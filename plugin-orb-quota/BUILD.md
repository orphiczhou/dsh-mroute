# BUILD.md — dsh-orb-quota 构建记录

> 构建/自检执行：orb-dev（lead 派发 subagent），2026-11-15，Windows 10，PATH node v24.20.0 + npm 11.19.0 + **pnpm 11.7.0（PATH 直装，与根 packageManager 字段一致）**。构建命令一律 `.cmd` 系（`.ps1` 被 ExecutionPolicy 挡）。
> 基线：mini-yifan/dsh-orb-cordis（MIT）bundle `dsh-orb@0.2.1` 全量 fork，改造清单见 [NOTICE.md](NOTICE.md)，工程蓝图见 [docs/00-blueprint.md](docs/00-blueprint.md)。

## 1. M0 构建链空跑（上游原样，ASCII 路径 `%TEMP%\orb-m0-spike`）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `pnpm.cmd install --no-frozen-lockfile` | ✅ 9.1s，204 包，koffi prebuild 脚本正常执行（pnpm-workspace.yaml `allowBuilds: koffi: true`） |
| 2 | `pnpm.cmd build` | ✅ 7 包 tsdown + bundle assemble 全部 Build complete |
| 3 | `node packages\bundle\scripts\pack.mjs` | ✅ `dsh-orb-0.2.1.tgz` **59,867,615 字节 / 1330 entries**；tar（System32 bsdtar）+ `npm pack`@registry.npmmirror.com 平台包补抓（darwin koffi×2、sherpa×2 等）全部走通；tgz 关键路径核验（cordis.patch.yml / dist/host / dist/helper/lib/main.js / dist/helper/assets/floating.html / node_modules/koffi+@koromix/koffi-win32-x64 / dist/native-selection / dist/voice/child.js） |
| 4 | `pnpm.cmd test`（基线） | **595/588 pass / 3 fail / 4 skipped**——3 个失败全部是上游 Windows 环境性失败：`host\tests\deferred-install.test.ts:85`（4s 计时）、`host\tests\voice.test.ts:742`（listen 时序）、`voice\tests\child-capture.test.ts:164`（macOS `say` 命令 ENOENT）。日志 `%TEMP%\orb-m0-test.log` |

**M0 退出结论：构建链全通，不触发「只发 host 半」降级，M1 完整 fork 成立。**

## 2. M1 构建（fork 目录，中文路径 `D:\Codes\DSH小插件\plugin-orb-quota`）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `pnpm.cmd install --no-frozen-lockfile` | ✅ 13.5s，204 包（中文路径无障碍——历史事故只发生在 tgz 被 pnpm 以 file: URL 消费那一步） |
| 2 | `pnpm.cmd typecheck` | ✅ 首轮 8 错（quota-feeder 字段/方法重名 + routes readonly 赋值 + helper 局部类型漏字段），修 3 轮后 **EXIT=0** |
| 3 | `pnpm.cmd build` | ✅ 全包 Build complete（host bundle 815.53 kB）+ assemble 原地产出 |
| 4 | `pnpm.cmd test` | ✅ **606 tests / 599 pass / 3 fail / 4 skipped**——3 fail 与 M0 基线完全同一组（环境性，见 §1-4），**新增 11 条测试全绿**（quota-feeder 8 条 + preferences 3 条 + section.test.mjs quota 交互断言并入既有用例），改动既有断言 5 处全部跟进新语义。日志 `%TEMP%\orb-m1-test2.log` |
| 5 | `node .\scripts\pack.mjs`（packages\bundle 内） | ✅ **`%TEMP%\dsh-orb-quota-0.2.1-quota.1.tgz`（57.1 MB / 1330 entries）**，产出后立即 move 到 `%TEMP%`（ASCII 纪律；工作区零 tgz 残留）。pack.mjs 的 tgz 文件名已改读 `manifest.name`（上游写死 `dsh-orb-` 前缀）。tgz 内身份复核：`name=dsh-orb-quota`、`version=0.2.1-quota.1`、`dependencies`/`scripts` 已剥空（自含 node_modules，宿主注入解析 peers）、六 entry name 全 `dsh-orb-quota*`、五个 app 级 insert id 原样 |

### 2.1 测试期望修正实录（对审计透明）

- `update.test.ts`：release tarball URL 期望值跟进 `UPDATE_REPO` 改道（`dshextensions/dsh-orb-quota` 占位 repo，防一键升级回上游覆盖 fork——见 NOTICE.md §7）。
- `install.test.mjs`：六个 patch entry name 期望、`manifest.name`、client.js id 重写断言、link/unpack 安装根目录、tgz 文件名全部跟进 `dsh-orb-quota` 改名。
- `section.test.mjs`：`name: dsh-orb` 正则断言 → `dsh-orb-quota`；mock `/lasso-satellite` 派生 `balance`（模拟 host 行为）；余额 Toggle 交互断言改 select `onChange`，新增黄档阈值/渠道显隐交互断言（POST `/.dsh-orb/quota`）。
- `preferences.test.ts`：`lassoSatellite()` deepEqual 补 `balanceSource`；新增迁移三态（legacy false→off / true→multi / 显式 source 优先）与 `orb-quota.json` 读写/去重/钳制用例。
- `quota-feeder.test.ts`（新）：首轮两处排序期望笔误（plain 档无 percent 时按 id 字典序：`opencode < xiaomi`）修正为实际确定性输出。

## 3. 自检清单

### 3.1 红线与纪律

- **llm/stream、agent/request 零触碰**：diff 无任何 `llm`/`agent/request` 监听注册（grep 复核）。
- **凭据纪律**：`authenticatedUrl` 全库 3 处使用（index.ts L164 上游既有、open-main.ts L11 类型、orb.ts L3401 新增 quotaStatusUrl），输出面只有「hostname 非 loopback 警告」与「不可用」两条固定文案，**带凭据 URL 零日志零落盘**；quota-feeder 错误信息只记 status 码/异常 message。
- **plugin-quota-multi 零改动**：本次 diff 不含 `plugin-quota-multi/` 任何文件。

### 3.2 改名残留检查（grep 全库）

- bundle 目录 `name: 'dsh-orb/…` / `name: dsh-orb$` / `'dsh-orb/host'` / `id: 'dsh-orb'` / `dsh-orb-${` → **0 命中**。
- 保留项（有意不动，NOTICE.md 记录）：`@dsh-orb/*` workspace 包名与 import、`dshHomePath('dsh-orb'/'dsh_orb', …)` 全部、`console.error('dsh-orb: …')` 日志前缀、voice 二进制名 `dsh-orb-voice-capture*`。
- 五个 app 级 insert id 原样：`preset-computer-use` / `orb-code-agent-registry` / `orb-lasso` / `orb-host` / `ui-settings-orb`（Select-String 复核）；六个 entry name 全部 `dsh-orb-quota*`。

### 3.3 BOM 检查

`packages/bundle/package.json`、`cordis.patch.yml`、`client-settings/client.js`、`helper/preload.cjs`、`NOTICE.md` 首字节 **全部无 BOM**（write/edit 工具产出）。

## 4. 维护兜底（移植即冻结）

- **`/status` 消费面冻结**：`providers[].{id,label,status,items[].{label,percent,display}}` + `currentModel.platform` + `alertPercent`，冻结于 dsh-quota-multi 0.14.10-multi.1；两 fork lockstep 共改（NOTICE.md §3）。
- **宿主服务面冻结**：`webServer.port` + `connection.authenticatedUrl()`（运行时 catalog 2026-11-15 确认）；宿主升级若改这两个服务形状，改点在 `orb.ts quotaStatusUrl()` 单点。
- **升级兼容**：`dshHomePath('dsh-orb', …)` 保留（裁决 M3），已装 0.2.1 用户的浮球位置/皮肤/balance 开关无缝延续；`lasso-capture.json` 旧文件迁移规则见 NOTICE.md §5。
- **升级探针**：UPDATE_REPO 占位 repo 双探针 404 → 更新卡静默；若未来自建发布渠道，改 `update.ts UPDATE_REPO` + 测试期望即可。
