# 插件工程规范（工作区标准）

> 适用范围：本工作区所有 DSH 插件目录。
> 分工：**编号法、环境坑、借鉴纪律的正源在 [AGENTS.md](../AGENTS.md)（§3/§4/§5）**；本文件只定义目录骨架、命名、流程与验收。两者冲突时以 AGENTS.md 为准，并把修正回写本文件。
> 维护：lead。修订遵循增补章纪律（AGENTS.md §3）：不改他人章节的既有结论，新结论写「一致性核对」。

## 1. 目录骨架（一个插件一个子目录，代码与文档同库）

```text
<plugin-name>/
├── README.md          # 必含：定位一句话、状态、安装/使用、文档导航、借鉴与许可
├── AGENTS.md          # 建议含：本插件特有约定与坑（勿复制通用规则，见 _template/AGENTS.md）
├── docs/              # 论证与需求文档，编号法见 AGENTS.md §3
│   ├── 00-立项报告.md
│   ├── 0x-专项调研/方案/需求/实测…
│   └── briefs/        # 本插件派发任务书（可选；跨插件共享的任务书放工作区 docs/briefs/）
├── <代码区>            # JS 插件惯用：index.js + lib/ + cordis.patch.yml + locale/ + icon.svg
├── package.json       # JS 插件必含（dsh 字段按宿主契约；dependencies 必须显式声明，见 AGENTS.md §4 schemastery 依赖坑）
├── tests/             # 测试与冒烟脚本/记录
├── NOTICE.md          # 有借鉴代码时必含（出处+上游版本+LICENSE，见 §5）
└── LICENSE            # 对外发布时
```

- **现状例外**（历史布局，不回改）：mroute 论证文档在 `mroute/` 根部、实现在 `plugin-mroute/`；gemini-eyes 为外部 fork 独立仓（junction 部署）。**新插件一律按本骨架**。
- 文档放哪：`mroute` 式「目录根部直放编号文档」与「docs/ 子目录」皆可，**新插件统一用 `docs/` 子目录**。

## 2. 命名规范

- 插件目录名 = 插件名，kebab-case（参考生态惯例 `dsh-<功能>`）。
- npm 包名：私有实验用 `@local/<name>`；准备发布再用实名。
- 文档文件名 `NN-主题.md`（编号 + 连字符 + 中文主题）；任务书 `briefs/<树名>-<节点>.md`。
- vendors 克隆命名 `<owner>--<name>/`（AGENTS.md §5）。

## 3. 立项到收口流程

0. **立项前**：扫 awesome-dsh-plugin 市场确认空白（方法范例 `mroute/06-market-scan.md`）→ 写 `docs/00-立项报告.md` → 工作区 README §2 登记。
1. **论证**：按编号法写专项调研与工程方案；07 工程方案用「直接复用/改造借鉴/自研核心」三分清单，逐项带源码出处 + LICENSE。
2. **实现**：任务书派发（自包含 prompt，AGENTS.md §1）；代码 + 测试同步落盘。
3. **实测**：装进 DSH profile 实测激活与核心功能（不实测不算完成）；记录落插件 docs/。
4. **审计**（可选）：专家团模式（AGENTS.md §6），blocker 清零才通过。
5. **收口**：验收清单（§4）自查 → lead 验收 → 更新工作区 README §2 状态。

## 4. 验收清单（DoD）

- [ ] 插件在目标 DSH build **安装并激活成功**（实测，非推断）
- [ ] 核心功能至少一次真机调用验证，证据留痕（输出摘录/截图/日志路径）
- [ ] `README.md` 齐：定位、状态、安装/使用、文档导航
- [ ] 论证文档齐：至少 00（立项）+ 07（工程方案）或等价记录
- [ ] 有借鉴代码时 `NOTICE.md` 齐、LICENSE 合规（AGENTS.md §5）
- [ ] `package.json` 的 dependencies 显式声明（AGENTS.md §4 依赖坑）
- [ ] 工作区 README §2 索引已登记/更新
- [ ] 本插件特有坑已回写插件 AGENTS.md（若具通用性，回写工作区 AGENTS.md §4）

## 5. 借鉴与许可（NOTICE 要求）

- 三分法与 vendors 纪律正源见 **AGENTS.md §5**，此处只规定 NOTICE 落盘格式：
  - 每项一行（或一小节）：`上游文件路径 → 本仓路径 ｜ 上游版本 ｜ LICENSE ｜ 借鉴方式（复用/改造/参考）`。
  - 无 LICENSE 的上游：只借鉴形状不抄实现，NOTICE 里注明「无 LICENSE，仅形状参考」。
  - 移植即冻结：上游版本号写进 NOTICE，之后不跟上游升级；漂移兜底（端点/宿主 API/finish 词表）写在插件 AGENTS.md。

## 6. 写作与交接纪律

- 增补章纪律、证据纪律正源见 **AGENTS.md §3**：不改上游原文；引用带章节号；结论必须带证据（文件路径+行号 / inspect 输出摘录 / 官方文档 URL）。
- 跨会话交接用 HANDOFF 文件落盘（先例 `docs/HANDOFF-M-mvpdev.md`）；任务书自包含（AGENTS.md §1）。
