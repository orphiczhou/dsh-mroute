# NOTICE — dsh-quota-multi

本包是 [Minokun/dsh-quota](https://github.com/Minokun/dsh-quota) 的 fork，新增小米 MiMo（Xiaomi MiMo 开放平台）余额/套餐查询适配器。上游原作与其余全部平台适配器的著作权归上游作者（Minokun）所有。

## 基座（直接复用）

- **上游**：Minokun/dsh-quota，**v0.14.10**（本工作区 vendors 存档 `vendors/Minokun--dsh-quota/dsh-quota-main/`，GitHub codeload main 快照，以 package.json version 0.14.10 锚定；zip 快照无 commit 号）
- **LICENSE**：MIT（上游 README「License」节与 npm 包 license 字段一致）
- **复用范围**：除下述「新增」外的全部源码（src/、tests/、scripts/、构建配置），原样保留
- **移植即冻结声明**：本 fork 自 2026-11-13 起不再跟随上游升级；上游端点漂移、宿主 API 漂移不自动同步，维护兜底见 `BUILD.md` 末尾

## 本 fork 新增（小米 MiMo 适配器）

- `src/direct.ts`：新增 `xiaomiBalance` / `xiaomiTokenPlan` 两个格式解析器、`xiaomiUsageRows` 附加行查询、`xiaomiUtcDate` 日期工具，以及 `CATALOG_EXTRA` 中 `xiaomi` / `xiaomi-token-plan` 两条目录项（**平台 id 保持 `xiaomi` / `xiaomi-token-plan` 不变**——那是与 DSH 模型供应商 id 对齐的平台标识，与插件包名无关）
- `src/platform-map.ts`：`platformForProvider` 新增 `xiaomi` / `xiaomi-token-plan` 两条映射规则
- `tests/xiaomi.test.ts`：新增；`tests/platform-map.test.ts` 一致性列表补 xiaomi 系 id
- 端点/响应结构依据（官方文档，2026-11-13 核对）：
  - 余额 `GET https://api.xiaomimimo.com/v1/platform/balance`（Bearer，普通 API Key `sk-`）— <https://mimo.mi.com/docs/zh-CN/api/asset/balance-get>
  - 套餐余量 `GET https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan`（Token Plan 专属 key `tp-`）— <https://mimo.mi.com/docs/zh-CN/api/asset/credits-get>
  - 日用量 `GET https://api.xiaomimimo.com/v1/platform/usage/daily?start_date=…&end_date=…`（UTC 自然日）— <https://mimo.mi.com/docs/zh-CN/api/asset/consumption-get>

## 借鉴出处（改造借鉴 / 仅参考，未整段复制）

- **bricika/dsh-quota-dashboard@0.2.5**（npm，MIT，Copyright (c) 2026 bricika）：端点路线（balance / token_plan / usage daily 三端点与 Bearer 认证形态、UTC 自然日参数、TP key 独立引用名）与响应结构对照（`balance_infos[]` 七字段、`quota{total/used/remaining}_credits`、日用量行 `consumed_amount/total_tokens/request_count`）。存档 `vendors/bricika--dsh-quota-dashboard/`（lib/host.js L846-900、lib/data.js L922-1000、README L72-74）。本 fork 的解析器代码为按官方文档独立实现，未整段复制其源码。
- **Yeoksin/dsh-usage-wallet**（GitHub main，MIT，Copyright (c) dougen 及 fork 贡献者）：仅参考——`sk-`/`tp-`/`ttp-` key 前缀判型、`/v1/models` 探活兜底思路，以及「推理网关无计费接口」这一过时断言的历史证据（其 lib/mimo.js L270-272 写于官方 V2.2.0 2026-11-03 上线余额接口之前）。存档 `vendors/Yeoksin--dsh-usage-wallet/`。未复制其任何实现代码。

## 附加依赖

- `dependencies` 显式声明 `@deepseek-ai/schemastery@3.19.0`（与宿主同版本；工作区先例：第三方插件须自带该依赖，install_bundle 对本地 link: 目录不装 dependencies）
- `devDependencies` 额外声明 `@deepseek-ai/dsh-credentials` / `@deepseek-ai/dsh-tools` / `@deepseek-ai/cordis`（npm 公网同源版本，**仅供本地跑测试/类型解析**；实体安装由宿主注入这些包，prune 后不随 bundle 交付）
