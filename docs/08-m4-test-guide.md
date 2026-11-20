# 08 — 模型路由面板 真机验收卡

> 目的：用 10 分钟把 M3 残留的两步（双窗口冲突 / 语种回退）+ M4 / M4.5 / M4.6 三批新能力在真机上跑一遍。
> 版本基线：插件 `0.5.0-m4.5`（源码已含 M4.6），宿主分发 rev `5d2860a19749`、65797 字节。
> 记录方式：每条打 ✅ / ❌；❌ 写「看到什么 + 期望什么」，有截图更好。工具侧的读回我来做。

---

## 0. 一分钟准备

1. **强刷**：设置窗口按 `Ctrl+Shift+R`（**不要只点左侧导航** —— 面板是宿主按 `artifactRevision` 编译分发的模块，弱刷不会换代码，这是本轮踩过的坑）。
2. 确认没有出现「模型路由插件未启用或本部署无设置面板服务」这类错误行。
3. 若出现任何红色报错行，直接抄给我。

---

## 1. 静态检查（不用点开，2 分钟）

| # | 看哪里 | 期望 | 不符合说明 |
|---|---|---|---|
| 1.1 | 设置 → 左侧「模型路由」 | 分区存在、可进入 | 挂载失败 |
| 1.2 | 顶部 | 标题 + 简介 + 黄色 advisory 横幅「自动余额经 quota 插件读取…仅供参考」 | — |
| 1.3 | 5 张渠道卡 | `zai-coding-cn` / `opencode-go` / `deepseek-official` / `deepseek-account` / `xiaomi`，**全部默认折叠** | 折叠态未生效 |
| 1.4 | 折叠态卡头 | 渠道 id + 「路由提供方: xxx（只读）」+ 一排 chip（状态/付费类型/档位/`priority N`/余额平台/核实·待核实）+ 右侧箭头 | chip 缺失 |
| 1.5 | 「建议顺序（静态层）」卡 | 5 行：`#1 zai-coding-cn` → `#2 opencode-go` → `#3 deepseek-official` → `#4 deepseek-account` → `#5 xiaomi` | 顺序错=静态排序回归 |
| 1.6 | 「模型归并」卡 | 默认折叠，chip 显示「归并组 4」 | — |
| 1.7 | 字段名 | 中英双语，形如「手动状态 · manual.status」「能力档位 · tier」 | — |
| 1.8 | 任一**下拉**展开 | 选项文字在亮底上**看得清**（修复前是白底白字） | 下拉可读性未修好 |

---

## 2. 折叠 / 展开（30 秒）

- 点 `zai-coding-cn` 卡头 → 展开出现：手动状态、渠道类型、能力档位、优先级、余额平台、账户已核实开关、备注、模型列表、备选渠道、复核时间。
- 再点一次 → 折叠回 chip 视图。
- 折叠/展开 `opencode-go` 时，`zai-coding-cn` 的状态**不应**被带着变化（历史 bug：假 React 的 hook 槽位串位）。

---

## 3. 模型级档位 → 保存 → 读回（1 分钟）

1. 展开 `zai-coding-cn`。
2. 找到「模型档位」区：每行一个模型 id + 四个下拉（`coding` / `tools` / `long_context` / `vision`），未登记的显示「未登记」。
3. 把 `glm-5.3` 行的 `coding` 选 **excellent**。
4. 点「保存」→ 期望按钮短暂变「已保存」。
5. 折叠再展开，值应仍在（本地状态）；**回我一句「档位已保存」**，我用 `model_route_query` 验证 host 侧读回。

---

## 4. 阈值 → 动态沉底的活证据（1 分钟）

1. 顶层参数卡里「周窗口沉底阈值」默认 **98**、「5h 窗口提示阈值」默认 **95**、「低余额阈值（CNY）」默认 **10**、「quota 快照缓存 TTL」默认 **60**。
2. **可逆自测**：把「周窗口沉底阈值」临时改成 **1** → 保存。
3. 让我调 `model_route_query`：`zai-coding-cn`（本周 2~6%）与 `opencode-go`（本周 11~13%）应**整体沉到 deepseek-account / xiaomi 之后**，行尾出现 `⚠ 动态沉底: 本周窗口 N%（≥1% 沉底）（不阻断）`。
4. 改回 **98** → 保存 → 顺序恢复成 §1.5 的样子（沉底提示消失）。

> 说明：面板里的「建议顺序（静态层）」卡**不会**跟着变——它按设计只算静态层；动态沉底只在 host 工具的 `routes[]` / 文本里体现。

---

## 5. 模型归并（1 分钟）

1. 展开「模型归并」卡：应有 4 组 —— `deepseek-flash`（deepseek-account + deepseek-official）、`deepseek-v4-pro`（同两渠道）、`glm-5.3-flash`（zai + opencode-go）、`mimo-v2.6-flash`（opencode-go + xiaomi）。
2. 语义确认：**只有同 id 跨渠道被自动并**；不同 id（例：opencode-go 的 `deepseek-v4.1-flash` 与 deepseek 的 `deepseek-flash`）面板不猜。
3. 可选人工归并：把 `deepseek-v4.1-flash` 那行的规范名改成 `deepseek-flash` → 保存 → 组数变 5、该组成员 +1。**不做也不影响验收。**

---

## 6. 双窗口冲突（1 分钟，M3 §6 第 4 步）

1. 开**两个**设置窗口，都进「模型路由」。
2. 窗口 A：低余额阈值 10 → **20**，保存成功。
3. 窗口 B（**不刷新**）：同一字段 10 → **30**，点保存。
4. 期望：B 出现提示「设置已在别处修改，已刷新为最新值，请确认后重新保存（未覆盖他人修改）。」，字段值刷新为 **20**；再点保存即可成功。
5. 若 B 静默保存成功且 A 的值被覆盖 → 冲突未接住（❌）。

---

## 7. 语种回退（可选，M3 §6 第 5 步）

- 桌面端只有 `zh` / `en` 两套词条。切英文界面（或 DevTools 里把 `<html lang>` 改成 `en`）→ 双语字段名顺序变成「`manual.status` · 手动状态」。
- 词典里缺的键应回退成另一个语种原文，**不应**出现裸键名（如 `statusLabel`）。

---

## 8. 回滚清单（测完请恢复默认）

| 字段 | 默认值 |
|---|---|
| 周窗口沉底阈值 `window_week_tight_pct` | 98 |
| 5h 窗口提示阈值 `window_5h_hint_pct` | 95 |
| 低余额阈值 `low_balance_threshold_cny` | 10 |
| quota 快照缓存 TTL `quota_cache_ttl_seconds` | 60 |

---

## 9. 回报模板

```
1 静态：1.1✅ 1.2✅ … 1.8❌（选项仍是白底白字，见截图）
2 折叠：✅
3 档位：已保存（glm-5.3 coding=excellent）
4 阈值：周阈值改 1 后顺序 = zai… / 改回 98 已恢复
5 归并：4 组，未做人工归并
6 双窗口：B 提示冲突并刷新为 20 ✅
7 语种：未测
```

---

## 附录：我在工具侧会同步验证的三件事

1. `model_route_query capability=coding` → `routes[]` 顺序、`balance.mode`/`windows[]`、`dynamic` 字段、尾部「模型归并视图」。
2. 保存后 `model_capability` 是否落到 `C:\Users\sir_c\.dsh\profiles\desktop\cordis.patch.yml`（`channels[]` 内 `model_capability` 数组）。
3. `model_route_alias_suggest`（dry-run）与 `model_route_sync_models`（dry-run）保持幂等、无新告警。
