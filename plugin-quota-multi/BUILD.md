# BUILD.md — dsh-quota-multi 构建记录

> 构建/自检执行：agent-1（subagent），2026-11-13，Windows 10，PATH node v24.20.0，npm 走 `npm.cmd`（npm.ps1 被 ExecutionPolicy 挡）。
> 本 fork 曾以 `dsh-quota-xiaomi` 命名交付一轮；应用户要求改用多渠道含义后缀，定名 **`dsh-quota-multi`**（版本 `0.14.10-multi.1`），从 vendors 上游源码全新复制重建，全部改造点原样重放。**平台 id 保持 `xiaomi` / `xiaomi-token-plan` 不变**——那是与 DSH 模型供应商 id 对齐的平台标识，与插件包名无关。

## 1. 实际执行的命令序列与结果

在 `D:\Codes\DSH小插件\plugin-quota-multi` 内执行（顺序即依赖关系）：

| # | 命令 | 结果 |
|---|---|---|
| 1 | `npm.cmd install --no-audit --no-fund` | ✅ added 71 packages（devDeps + dependencies；`prepare` 钩子自动跑了一次 tsdown）。`npm.cmd ls --depth=0` 树核验完整 |
| 2 | `node --test --experimental-strip-types tests/*.test.ts` | ✅ **227/227 通过**（含新增 10 条 xiaomi 用例 + platform-map 一致性扩展；含 Windows 路径分隔符修正，见 §3） |
| 3 | `npx.cmd tsdown` | ✅ Host ESM `lib\index.js` 173.96 kB + Client CJS `lib\client.js`，两段 Build complete。必须用 `npx.cmd`（`npx` 解析到 npx.ps1 被 ExecutionPolicy 拒） |
| 4 | `node scripts/check-client-id.mjs` | ✅ `check-client-id: bundle registers "dsh-quota-multi" == package name ✓`——改名三处同步（package.json name / tsdown PACKAGE_ID / CLIENT_ID） |
| 5 | `npm.cmd prune --omit=dev --no-audit --no-fund` | ✅ removed 68 packages——node_modules 收敛到运行时面：仅 `@deepseek-ai/schemastery@3.19.0` |
| 6 | `npm.cmd pack --pack-destination $env:TEMP --ignore-scripts` | ✅ `$env:TEMP\dsh-quota-multi-0.14.10-multi.1.tgz`（253,906 bytes，7 files：lib 4 件 + cordis.patch.yml + README.md + package.json）。`--ignore-scripts` 跳过 prepare 钩子（不再重复构建）；**工作区目录内零 tgz 残留**（纪律见 §6） |

**上游 `pnpm build` 的两个组成步骤**（`tsdown && node scripts/check-client-id.mjs`）在第 3、4 步逐等执行。**`pnpm install --frozen-lockfile` 未用**：npm 路线以 package-lock.json 为准；上游 pnpm-lock.yaml 是冻结的上游工件，与本 fork 的 package.json 已不同步，勿用它装。**`pnpm link-harness` / `scripts/link-harness.sh` 未执行**：该脚本自述是「typecheck/build 解析与目标 dsh 相同代次宿主包」的 dev 对齐步骤，build 链不依赖它；本机 DSH 在 asar 内无 npm 全局可探测，且禁改宿主——跳过，不影响产物。

## 2. 依赖声明（修正版）

```
dependencies:        @deepseek-ai/schemastery@3.19.0     ← 唯一运行时自带依赖
devDependencies:     @deepseek-ai/dsh-credentials@0.0.1-rc.1 / @deepseek-ai/dsh-tools@0.0.1-rc.1
                     @deepseek-ai/cordis@4.1.0           ← 仅本地测试/类型解析用
                     + 上游原 devDeps（tsdown/typescript/react/@types/unrun）
```

- **修正理由**：实体安装时 `@deepseek-ai/dsh-credentials` / `dsh-tools` / `cordis` 由**宿主注入**（上游 dsh-quota@0.14.10 零 dependencies 实装可用的既有事实），不应随 bundle 发布；只有 schemastery 按 workspace 先例（AGENTS.md §4 schemastery 依赖坑：install_bundle 对本地目录不装 dependencies → 第三方插件必须自带）保留在 dependencies。
- 上轮 xiaomi 命名版是「装完再 prune」达成同一状态；本版直接把三个宿主包写进 devDependencies，`npm prune --omit=dev` 后 node_modules 天然只含 schemastery，无需事后清理。
- 构建期 tsdown 对 `@deepseek-ai/*` 一律 external（tsdown.config.ts L46），devDeps 在不在都不影响 build。

## 3. 与上游的偏离清单（供审计）

1. 新增小米适配器（`src/direct.ts`、`src/platform-map.ts`、`src/client/platform-map.ts` 导出面、测试），出处见 NOTICE.md；**平台 id `xiaomi` / `xiaomi-token-plan` 不变**
2. package.json：改名 `dsh-quota-multi`、版本 `0.14.10-multi.1`、依赖声明按 §2 修正版、keywords 补 xiaomi/mimo
3. tsdown.config.ts：`PACKAGE_ID`/`CLIENT_ID` = `dsh-quota-multi`（client-id 门禁要求）
4. tests/subscription.test.ts：上游一条用例硬编码 POSIX 路径分隔符（`/custom/codex/auth.json`），Windows 上 `path.join` 产出 `\` 而失败——期望值改用 `join()` 构造（源码未动，跨平台正确）
5. README.md 顶部加 fork 横幅；新增 NOTICE.md、BUILD.md、package-lock.json
6. `pnpm-lock.yaml`、`.github/workflows/publish.yml` 为上游冻结工件，本 fork 不使用（publish.yml 指向上游 trusted publisher，勿在本 fork 推送仓库上启用 Actions）

## 4. 产物

- `lib\index.js` / `lib\index.js.map` —— Host 半（ESM，入口 `src/index.ts`）
- `lib\client.js` / `lib\client.js.map` —— 浏览器半（CJS closure-factory，banner `window.__ModuleLoader__.load({ id: "dsh-quota-multi", factory: … })`）
- 安装入口：`cordis.patch.yml`（insert id `quota`，name `dsh-quota-multi`）
- 分发件：`$env:TEMP\dsh-quota-multi-0.14.10-multi.1.tgz`（npm pack 产物，ASCII 路径）
- 安装注意：**与上游 dsh-quota@0.14.10 互斥安装**（同 insert id `quota` + 同设置命名空间 `quota`）；tgz 消费时保持 ASCII 路径（见 §6）

## 5. 自检清单

### 5.1 `node --check` 通过的关键文件

```
OK  lib\index.js          （构建产物 Host 半）
OK  lib\client.js         （构建产物浏览器半）
OK  src\direct.ts         （适配器主改造文件）
OK  src\platform-map.ts   （映射表 Host 侧）
OK  src\client\platform-map.ts（映射表浏览器侧 re-export）
OK  tests\xiaomi.test.ts
OK  tests\platform-map.test.ts
OK  tests\subscription.test.ts
```

### 5.2 xiaomi 在产物中的命中（两份 platform-map 同步验证）

上游架构：`src/client/platform-map.ts` 是 Host 侧唯一真表的单行 re-export（上游注释记录过两份手抄副本单侧漂移导致置顶失效的坑）——单点改 `src/platform-map.ts` 即两半同步，测试钉死（`platformForProvider` 三条导入路径逐 id 一致）；构建后在两个 bundle 产物里复验：

| 产物 | 命中 |
|---|---|
| `lib\index.js` | `xiaomi-token-plan` **4 处**：L140 常量、L166 映射规则、L860 FORMATS 注册、L1289 目录项 format；另有端点 L754（usage）、L1281（balance）、L1288（token_plan） |
| `lib\client.js` | `xiaomi-token-plan` **2 处**：L462 常量、L488 内联映射规则（浏览器半认领卡片/置顶用） |

源码行号：`src/platform-map.ts` L22/L25（常量）、L59-60（规则）；`src/client/platform-map.ts` L13（re-export）；`src/direct.ts` 目录项在 CATALOG_EXTRA（`xiaomi` 条目 + `xiaomi-token-plan` 条目）。

### 5.3 测试结果

- 全量：`node --test --experimental-strip-types tests/*.test.ts` → **227 pass / 0 fail**（duration ~2.8s）
- 本 fork 新增/改动：`tests/xiaomi.test.ts`（10 条：目录项形状 keyRefs/envKeys/origins/ALL_DIRECT_REFS/CUSTOM_FORMATS、余额解析、授信/冻结/不可用状态、Token Plan 解析与推导、日用量聚合、UTC 日期）；`tests/platform-map.test.ts`（两半一致性 id 列表补 5 个 xiaomi 系 id + 新用例含大小写与 token-plan 优先级）；上游存量用例全绿（唯一 Windows 路径断言已按 §3-4 修正）

### 5.4 BOM / 凭据纪律

- `package.json` / `cordis.patch.yml` 首字节核验无 BOM（write/edit 工具产出，非 PowerShell Set-Content）
- 全部新代码只引用凭证**名**（`XIAOMI_API_KEY` / `MIMO_API_KEY` / `XIAOMI_TOKEN_PLAN_API_KEY` / `MIMO_TOKEN_PLAN_API_KEY`），key 值不落任何文件/日志/工具返回（`ProviderSnapshot.keyRef` 只回引用名，上游既有约定 src/config.ts L119-120）

## 6. 中文路径事故与 ASCII 路径纪律（2026-11-13 实录，lead 记录）

- **事故**：上一轮 `dsh-quota-xiaomi` 安装时，`install_bundle` 以工作区**中文路径**（`D:\Codes\DSH小插件\…`）下的 tgz/file: 引用消费，pnpm 对非 ASCII 路径做 file: URL 编码时损坏并**清空了源目录**。
- **纪律**：①插件 tgz 一律 `npm.cmd pack --pack-destination $env:TEMP`（ASCII 路径）产出，**不在工作区中文目录留 tgz**（本版自检：`Get-ChildItem *.tgz` 计数 0）；②install/消费 tgz 的路径保持 ASCII；③工作区源码目录本身可中文（read/write 工具无碍），风险只在「tgz 被包管理器以 file: URL 消费」这一步。

## 7. 维护兜底（移植即冻结，AGENTS.md §5）

- **端点漂移**：三端点（balance / token_plan / usage daily）与响应字段锚定官方文档 2026-11-13 版本（URL 见 NOTICE.md）；上游 MiMo 改字段时以官方文档为正源手工跟进
- **宿主 API 漂移**：fork 基于 dsh 0.14.10 时代的宿主服务面（credentials/settings/llm 目录）；宿主升级若动 `credentialRef`/settings forms 形状，同步风险点在 `src/controller.ts`/`src/state-store.ts`（上游同担）
- **key 形态**：余额/日用量端点官方口径要 `sk-` 普通按量 key；若把 `tp-` Token Plan key 填进 `XIAOMI_API_KEY`，卡片显示 401 类错误（预期行为）；Token Plan 卡需要 tp- 专属 key（本 fork 固定 cn 集群，sgp/ams 用户可后续加）
