# pi-verdict

[English](README.md) | **[简体中文](README.zh-CN.md)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/pi-verdict)](https://www.npmjs.com/package/pi-verdict)
[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://pi.dev)

**pi-verdict 是 [pi](https://pi.dev) 的极简权限门禁，灵感来自 Claude Code 的 auto mode：每次工具调用执行前先过检查——放行、拦截，或先问你。**

- 极简——核心单文件可通读(0.13 起分类器走 pi 原生 `classify()`;分层裁决为可选模块)
- 内置危险规则与你的 allow/deny 规则以零延迟先行裁决明确情形
- 其余交给携带会话上下文的模型分类器
- 任何不确定或失败一律 fail-closed，绝不静默放行
- 自保护：门禁守护自身，防窥探与篡改

## 问题

pi 没有内置的逐次权限确认——每次工具调用都以 pi 进程自身的权限直接执行([pi 安全文档](https://pi.dev/docs/latest/security))。

pi-verdict 补上这道缺失的门禁，由模型基于上下文和你的意图判定是否可以运行。

## 为什么是三态

**verdict 是裁决，不是开关。** 本品类的分类器大多只输出二值 allow/block。三态有意义的地方在：`ask` 把真正含糊的动作转交人类确认(非交互会话中降级为 `deny`)，「不确定」永远不会静默变成「放行」——目标是安全的自动化而非最大的自动化：审批疲劳与静默危险执行都是败因。

## 设计原则

- **Fail closed**——不确定产生摩擦，绝不产生许可。
- **确定性 floor 先于 AI**——硬 deny 永不被分类器或用户 allow 规则覆盖。
- **语义优先于语法**——分类器判定的是动作**做什么可能会产生什么安全影响**，而不是命令有多长。
- **是判断，不是证明**——分类器的 `allow` 是有依据的判断；floor 的存在正因 allow 仅是判断。
- **最小化可信输入**——transcript 不含工具结果(#22)，分类器零路径明文(ADR-0002)。
- **规范化身份**——词法 + realpath 双形匹配；「看起来在项目内」的路径不因此被信任(#20/#21)。
- **门禁守护自身**——任何配置都关不掉的自保护层(ADR-0001)。
- **是权限门禁，不是沙箱**——请在上面叠加 OS 级隔离；本门禁不替代它。

完整表述见 [docs/security-principles.md](docs/security-principles.md)。

## 截图

![演示：受保护路径 ask 被拒绝](https://raw.githubusercontent.com/jesset/pi-verdict/main/docs/demo.gif)

![Automode Status](https://raw.githubusercontent.com/jesset/pi-verdict/main/docs/images/status.png)
![Ask Permission](https://raw.githubusercontent.com/jesset/pi-verdict/main/docs/images/asked.png)

## 快速开始

```bash
# 从 npm 安装(pi):
pi install npm:pi-verdict

# 从 npm 安装(oh-my-pi / omp):
omp plugin install npm:pi-verdict

# 或直接从源码 —— 试用一次
pi --extension ./extensions/pi-verdict.ts

```

需要 pi ≥ 0.99。交互与非交互(`-p`/json/rpc)会话均支持；非交互模式下 `ask` 降级为 `deny`。

### 宿主

pi-verdict 0.13+ 需 **pi ≥ 0.99**,仅支持 pi(原生分类器接入,[ADR-0005](docs/adr/0005-native-classifier-migration.md))。老宿主——pi < 0.99 与 [oh-my-pi](https://github.com/can1357/oh-my-pi)(omp)——继续使用 npm 上的 **0.12.x** 线(老宿主配老版本扩展)。0.12 线仍按自身安装位置自锚定到所在宿主的目录树,双宿主并存的机器上跟随扩展副本自身的位置;其在 omp 18 下的分类器模型调用回退 pi-ai compat API(仍然 fail-closed)。细节见 [docs/configuration.md](docs/configuration.md#host-notes-pi-and-oh-my-pi)。

| | pi | omp(0.12.x 线) |
|---|---|---|
| 安装 | `pi install npm:pi-verdict` | `omp plugin install npm:pi-verdict` |
| 扩展副本 | `~/.pi/agent/extensions/` | `~/.omp/plugins/node_modules/pi-verdict/`(omp 18.1+；≤18.0 在 `agent/` 下) |
| 用户规则 | `~/.pi/agent/config/pi-verdict.json` | `~/.omp/agent/config/pi-verdict.json` |
| 凭据文件(S0 硬 deny) | `~/.pi/agent/auth.json` | `~/.omp/agent/auth.json` |

- `/automode` —— 显示当前状态：开/关
- `/automode on`
- `/automode off`
- `ctrl+shift+a` —— 静默切换主开关(footer 始终显示为唯一反馈；键位可经 `toggleShortcut` 重绑或禁用)
- footer 恒显 `auto mode on`(绿色)/ `auto mode off`(黄色)

| 配置 | 默认 | 说明 |
|---|---|---|
| `--auto-mode` / `--no-auto-mode` | 开 | 主开关 |
| `--auto-mode-model provider/id` | 会话模型 | 分类器模型(默认"自省") |
| `--auto-mode-debug` | 关 | 全量裁决通知 |
| `PI_AUTO_MODE_MODEL` | — | 模型配置的环境变量形式 |
| `PI_AUTO_MODE_DEBUG=1` | 关 | 调试的环境变量形式(flag 优先) |

### 用户自定义规则(`pi-verdict.json`)

```json
{
  "allow": ["^ls\\b", "^git (status|log|diff)\\b"],
  "deny":  ["rm ", "docker ", "^/etc/"],
  "denyPaths": [
    "~/.ssh/",
    "~/.profile",
    "~/.gnupg",
    "~/.mc",
    "~/.kube",
    "~/.zshrc",
    "~/.bashrc"
  ],
  "ignoreTools": [
    "todo",
    "ask_user_question",
    "memory_write",
    "memory_search"
  ],
  "builtinDenyFloor": true,
  "classifierModel": null,
  "toggleShortcut": "ctrl+shift+a",
  "audit": false,
  "auditRedactSecrets": true,
  "notifyAllows": false,
  "classifierMinConfidence": null,
  "classifierFallbackModel": null,
  "classifierFallbackMode": "enforce",
  "semanticAdjudication": {
    "tier1Lancet": {
      "enabled": true,
      "modelPath": "~/.cache/pi/lancet-nano",
      "riskyThreshold": 0.85,
      "riskyAction": "ask"
    },
    "tier2Role": "adjudicator",
    "tier2TimeoutMs": 5000
  }
}
```

- `allow`/`deny` 为 JS 正则数组；**`deny` 优先于 `allow`**，两者都优先于分类器
- `denyPaths` 是你声明**受保护**的普通路径列表：触碰触发**终局 ask** 由你裁决(非交互降级 deny)；分类器只被告知路径**存在**，路径明文永不出本机。`grep`/`find`/`ls` 按**整个搜索范围**比较：省略 `path`(pi 默认：当前目录)或传入位于声明路径之上的父目录，同样触发 ask。全新安装会预填一份**入门列表**(`~/.ssh/`、`~/.gnupg`、`~/.mc`、shell rc/profile 文件)
- `ignoreTools` 列出规则未覆盖的工具(`todo`、`web_search`、MCP/自定义工具)：**直接放行、零模型调用**；列出已覆盖工具(`bash`/`read`/`write`/`edit`/`grep`/`find`/`ls`/`powershell`)的条目无效：它们仍受 deny floor 与你的 allow/deny 规则约束，自保护层也永远先行。全新安装会预填一份**入门列表**(`todo`、`ask_user_question`、`memory_write`、`memory_search`——来自项目 1265 条生产审计的观察)。注意：被豁免的工具失去分类器对 `denyPaths` 的存在性话术警戒(未覆盖工具本就不进路径提取器);MCP 工具名匹配前会归一化——见 [codemode 与 MCP](#pi-099-codemode-与-mcp间接调用同样受门禁)
- `builtinDenyFloor: false` 整体关闭内置危险/路径拦截(风险自担；下方自保护层永远开启)
- `classifierModel` 指定分类器模型，如 `"zai/glm-5.3-flash:low"`(支持思考后缀；缺省 = 会话模型且显式关思考)
- `classifierModel: "typesafe/jev-latest"` 启用**原生 jev 分类器**——每次灰区裁决经 pi 内置分类器目录发一次结构化 `classify()` 调用(TypeSafe 直连,或 OpenRouter/OpenCode/Cloudflare/Vercel 上的 Jev);详见 [ADR-0005](docs/adr/0005-native-classifier-migration.md)
- `semanticAdjudication` 启用**分层裁决**([ADR-0009](docs/adr/0009-tiered-semantic-adjudication.md)):shell 命令先由本地 **Tier 1** 分诊——LANCET-Nano(111 MB INT8 ONNX,CPU,无网络,[安装](#tier-1-lancet-nano-安装))。`not_flagged` 立即放行(约 10 ms);`risky` 转 ask(`riskyAction: "block"` 时 deny);`review` 或超长输入升级 **Tier 2**——从宿主模型注册表解析裁决模型(`tier2Role`: `"adjudicator"` → `"smol"` → 会话模型),它能看到工具调用、会话上下文与 Tier 1 分诊结果。Tier 2 `allow` 放行;`ask`/`deny` 都转人工;任何失败(无模型、网络、5 秒超时、JSON 不合法)fail-closed 为 ask(无 UI 降级 deny)。不配置该块时行为与 0.15 的单分类器路径完全一致。非 shell 工具跳过 Tier 1 直接进 Tier 2。
- `audit: true` 把每次**灰区裁决**(发给分类器的完整转录、其原始响应、解析出的裁决)以 JSONL 记录到 `~/.pi/agent/verdicts/<sessionId>.jsonl`——按会话一分文件，保留最近 20 个。交互式 ask 还会记录你的应答(`userAnswer` ground truth，确认结束后落盘)，protected-path ask 也入审计(#62)；规则 allow/deny 仍不入。仅存本机且全保真(受保护路径明文可能出现——永不出本机；[ADR-0002](docs/adr/0002-deny-paths-deterministic-ask.md) 边界注)；凭证明文在落盘前脱敏(`<redacted:类型#指纹>`，指纹具确定性、跨记录可追踪——`auditRedactSecrets: false` 可显式关闭；[ADR-0007](docs/adr/0007-audit-secret-redaction.md))；agent 对该目录读写双拒。开启时 `/automode` 会显示审计状态与路径
- `notifyAllows: true` 对每次 **classifier 放行**发通知(reason + action 行——如 jev 的概率分解)；默认 `false` 保持放行静默。机械放行(你自己的 allow 规则、protected-path 确认)永不通知；两开关同开时通知只出现一次
- `classifierMinConfidence`(可选，[ADR-0004](docs/adr/0004-classifier-fallback-cascade.md))设定**置信地板**：低于它的原生分类器裁决被降级——配置了 `classifierFallbackModel` 则级联(`enforce`，默认 = 第二层全权裁决；例外：降级的 **deny 与 ask** 永不被自动放宽为 allow；fail-closed 未产生裁决，其获救裁决照常生效；`shadow` = 只记录意见、由你裁决——`/automode` 会提示激活开关)，否则直接问你。不低于地板时第一层自主。地板仅作用于原生分类器模型(协议原生置信度)——chat/LLM 分类器下不生效，会有一次中性警告提示。天然搭配：jev 在前 + haiku/flash 级回退

没有内置白名单——每一条「永远放行」声明都归你([为什么](docs/configuration.md#why-no-built-in-allowlist))。完整参考：[docs/configuration.md](docs/configuration.md)。

### Tier 1 Lancet-Nano 安装

```bash
bun run setup:lancet            # ~/.cache/pi/lancet-nano(固定 v0.4.3,哈希校验)
bun run setup:lancet --check    # 只校验现有 bundle,不联网
bun run setup:lancet --dir DIR  # 自定义位置(需与 tier1Lancet.modelPath 一致)
```

安装脚本先以发布清单摘要校验 `export.json`,再以 `export.json` 校验每个模型文件,并与参考实现交叉校验分词器。运行时每次加载都会重新校验文件——被篡改或缺失的 bundle 绝不会产出 `not_flagged`,Tier 1 会升级并只警告一次。配置了块但未安装 bundle 时,shell 命令直接进 Tier 2。

### 原生 jev 分类器([ADR-0005](docs/adr/0005-native-classifier-migration.md))

1. 安装:`pi install npm:pi-verdict`(v0.13+;需 pi ≥ 0.99——老宿主继续用 0.12.x)
2. 为任一内置 Jev transport 准备好凭证:
  - **TypeSafe 直连**(`typesafe/jev-latest`):`export TYPESAFE_API_KEY=apikey_...`(console.typesafe.ai 自助发 key)
  - **OpenRouter**(`openrouter/~typesafe/jev-latest`、`openrouter/typesafe/jev-1.13`):pi 内 `/login openrouter`,或 `export OPENROUTER_API_KEY=sk-or-v1...`
  - 亦经 OpenCode Zen、Cloudflare Workers AI、Vercel AI Gateway 提供(各自登录);llama.cpp chat 模型自带免费本地分类器形态(同 id 的 `model.type: "classifier"` 孪生条目)
3. 将分类器指向 jev(新会话生效)
  - 持久：在 pi 之外编辑 `~/.pi/agent/config/pi-verdict.json` 并设置 `{ "classifierModel": "typesafe/jev-latest" }`
  - 或者临时试用一次:`PI_AUTO_MODE_MODEL=typesafe/jev-latest pi`

**说明**:
- 裁决为结构化 `classify()` 应答(choice + probabilities + confidence);reason 行保留历史 `jev:` 概率分解(无标签——`<verdict>` 前缀只存活于审计记录的 rawResponse),其余分类器 API 渲染 `classifier:`
- 分类器 spec 先经 pi 分类器目录解析(`findOfType`)、chat 注册表兜底;同 id 双型并存(llama.cpp)时原生条目优先;分类器 spec 上的思考后缀警告一次后丢弃(审计 `thinking` 记为 `null`)
- 自定义端点:在 models.json 覆盖 provider 的 `baseUrl`(0.12 的 `PI_VERDICT_JEV_URL` 逃生口与 `PI_VERDICT_JEV_TRANSPORT` 均已移除——transport 选择即 spec 本身)
- 沿袭限制:denyPaths 存在性话术仍不达分类器形态模型([ADR-0005](docs/adr/0005-native-classifier-migration.md));TypeSafe 直连的单次成本显示 $0(其 API 不返回 cost)

jev 的校准 confidence 正是置信地板的判定依据——搭配第二层使用(`"classifierMinConfidence", "classifierFallbackModel"`)，让低置信调用交由更深的模型复裁，而非就地生效([ADR-0004](docs/adr/0004-classifier-fallback-cascade.md))。

### pi 0.99 codemode 与 MCP:间接调用同样受门禁

pi 0.99 可以在 QuickJS 沙箱(`codemode`)里运行模型写的 JavaScript 去调用 pi 的工具,MCP 服务器则以 `mcp__<server>__<tool>` 注册工具。这两个新增面都不会绕过本门禁:

- **嵌套调用与直接调用同样过门**——pi 把 codemode 脚本发起的每一次工具调用都路由到同一条 `tool_call` 管线(带 `parentToolCallId`,id 形如 `<父id>/<n>`);被拦截的调用以错误形式回传脚本,模型可见
- **MCP 工具落入灰区**——规则层只覆盖内置命令/文件工具;每次 `mcp__*` 调用都走分类器,含 fail-closed
- **`ignoreTools` 与 MCP 工具名**:工具名会归一化——`[A-Za-z0-9_]` 之外的字符统一变 `_`(`mcp__dev-radius__x` → `mcp__dev_radius__x`);豁免条目必须写归一化后的形态
- **成本放大**:单个脚本最多可发 256 次嵌套调用,灰区调用逐个分类,慢的 LLM 分类器会把单次延迟成倍放大
- **暴露边界**:添加 MCP 服务器会自动开启 codemode,而 `pi --no-extensions -e builtin:mcp` 可在不加载任何扩展(即无本门禁)的情况下启用 MCP 工具。门禁自身即扩展,在完全不加载扩展的会话中无法生效;此边界为 pi 扩展模型的固有属性,此处显式陈述而非掩饰
- **批量延迟可配置**([ADR-0006](docs/adr/0006-codemode-nested-calls-policy.md)):每个嵌套调用独立裁决且灰区裁决为串行(实测 ~350ms/次),大脚本批次的判定开销可观。`"codemodeNestedCalls": "rules-only"` 让嵌套调用只走确定性层(规则、floor、自保护、denyPaths + ask)——灰区直接放行;代价是规则层放行、但分类器会拦的动作(如未声明 denyPaths 时的嵌套 `bash head ~/.ssh/config`)同样放行。两种模式下审计记录均携带 `toolCallId`/`parentToolCallId` 归因

### 自保护(门禁守护自身——[ADR-0001](docs/adr/0001-self-protection-layer.md))

门禁自身的文件——配置与扩展安装副本——**仅用户可改**：门禁之内的写入一律硬 deny(读放行)；你的编辑器修改不经门禁，同类先例是 sudoers 必须经 visudo。

- **不可经任何配置关闭**——`builtinDenyFloor: false` 与用户 `allow` 规则都动不了这一层
- **变更检测**作纵深兜底：受保护文件在 `session_start` 快照、每次裁决前复核——扩展副本被改 → 自动还原 + 本会话 fail-closed；配置被改 → 有 UI 时一次明确的双选确认(无 UI 时与扩展副本同样自动还原；差分处置的完整语义见 [ADR-0001](docs/adr/0001-self-protection-layer.md))

---

## 与品类对比

| | 三态裁决 | 分类器携带上下文 | fail 方向 | 运行时依赖 |
|---|---|---|---|---|
| **pi-verdict** | ✅ allow / ask / deny | ✅ 近期用户意图 + 工具调用 | **closed**(异常/超时/违约 → deny；非交互 ask → deny；Tier 2 失败 → ask) | **0** 核心(分层裁决运行时可选,含 ONNX) |
| [@czottmann/pi-automode](https://github.com/czottmann/pi-automode) | 规则三态，分类器二态 | ✅ 预算内裁剪的 transcript | closed | 1 |
| [@zhushanwen/pi-permission](https://www.npmjs.com/package/@zhushanwen/pi-permission) | ✅(outcome) | ❌ 单轮无上下文 | closed(→ ask) | 4 |
| [@gotgenes/pi-permission-system](https://github.com/gotgenes/pi-packages) | ✅ 纯确定性 | —(无内置分类器) | closed | 3 |

完整全景：[`research/pi-permission-landscape.md`](research/pi-permission-landscape.md) · 与最近架构亲缘的收敛分析：[`research/pi-automode-convergence.md`](research/pi-automode-convergence.md)。

诚实地说：pi-automode 与 pi-verdict 在**架构上已收敛**(deny floor → 用户规则 → 分类器，fail-closed——见收敛分析)。这里仍然不同的是：分类器能说 `ask`(运行时人工介入，而非仅由规则预声明)、内置 floor 可以关(`builtinDenyFloor`——用户主权)、任何配置都关不掉的自保护层([ADR-0001](docs/adr/0001-self-protection-layer.md)——门禁完整性)、零依赖的[可通读核心](extensions/pi-verdict.ts)(分层裁决运行时可选用独立模块)、以及测量的习惯——本仓库每个设计决策都有随库研究背书。

## 判定管线

![pi-verdict 安全门禁——工具调用判定管线](https://cdn.jsdelivr.net/gh/jesset/pi-verdict@main/docs/diagrams/security-pipeline.zh.svg)

*图源与再生成：[docs/diagrams/](docs/diagrams/README.md)。管线基准：v0.14——下方 ASCII 为文本等价版。*

```
tool_call
  │
  ├─ 0. 自保护层(ADR-0001;不可经任何配置关闭)
  │     ├─ write/edit/bash 触碰门禁自身文件 → deny;读放行
  │     └─ 变更检测:每次裁决前复核 →
  │         自动还原 + fail-closed,或一次保留/还原确认
  │
  ├─ 1. 规则层(确定性,零延迟)
  │     ├─ 内置 deny floor:bash 危险正则 + 路径敏感度 S0–S5
  │     ├─ 用户规则:deny 优先于 allow
  │     ├─ denyPaths(ADR-0002):受保护路径 → 终局 ask,先于用户 allow;
  │     │   分类器只见存在性话术
  │     ├─ ignoreTools:用户声明的未覆盖工具 → 直接放行,零模型调用
  │     ├─ headless subagent-artifacts 写入(ADR-0008):无 UI 会话对
  │     │   <agentDir>/sessions/**/subagent-artifacts/ 的 write/edit →
  │     │   确定性放行(交互会话仍可 ask);用户 deny 规则与 denyPaths
  │     │   声明仍然优先
  │     └─ 你的操作面上无内置白名单 —— 「永远放行」的声明由你自己做
  │       (唯一的内置放行是 pi 自身的 subagent-artifacts 子树,仅限
  │       headless,ADR-0008)
  │
  ├─ 2. 灰区 → 嵌套策略,再进语义裁决
  │     ├─ 嵌套调用(codemode)+ codemodeNestedCalls=rules-only → 放行;
  │     │   上方确定性层已全部跑完(ADR-0006)
  │     ├─ 默认:单分类器——原生 classify()(choice + probabilities +
  │     │   confidence;reason 无标签,完整契约行存审计 rawResponse)或
  │     │   chat 路径(会话模型自省)的 <verdict>…</verdict> 前缀锚定自由文本
  │     └─ 分层裁决(ADR-0009,需配置 semanticAdjudication 块):
  │           shell → Tier 1 LANCET-Nano(本地,约 10 ms):
  │             not_flagged → 放行;risky → ask(或 deny);review/超长 → Tier 2
  │           全部工具 → Tier 2 模型注册表裁决器(role → smol → 会话模型):
  │             严格 JSON;allow 放行,ask/deny → 人工;失败 → ask
  │
  └─ 3. 三态裁决
        ├─ allow → 放行
        ├─ deny  → 拦截,理由回传 agent
        └─ ask   → 人工确认;非交互模式降级为 deny

```

**fail-closed**：分类器异常 / 超时(25s)/ 输出违反契约 → 拦截;分层裁决下 Tier 2 失败(无模型、网络、5 秒超时、JSON 不合法)→ ask(无 UI 降级 deny)。绝不静默放行。

## 证据驱动，不靠直觉

这里的设计决策以测量定案，实验记录随仓库发布：

- [`research/cache-sim`](research/cache-sim/README.md) —— 回放 1.2k+ 条真实分类器裁决，实测裁决缓存命中率(**3.2%** → 缓存暂缓；其后建成的运行时影子遥测实测 **3.3%**，后来一并移除，#73)
- [`research/thinking-param-blackhole.md`](research/thinking-param-blackhole.md) —— 思考模型烧尽分类器预算的三层取证，以及为什么修复是 `thinkingEnabled: false`
- [`research/rule-engine-sim`](research/rule-engine-sim/README.md) —— 用 746 条真实 bash 调用实测 tree-sitter 规则引擎移植(**灰区吸收 0 条**)并否决
- [`research/pi-permission-landscape.md`](research/pi-permission-landscape.md) —— 本 README 定位所对照的竞品全景
- [`research/rule-layer-security-audit.md`](research/rule-layer-security-audit.md) —— 规则层绕过测试(8/8 复现 → 0.2.0 架构性修复)
- [`research/pi-automode-convergence.md`](research/pi-automode-convergence.md) —— 与 pi-automode 何处真正收敛、何处仍然不同
- [`research/claude-code-classifier-prompts.md`](research/claude-code-classifier-prompts.md) —— Claude Code 分类器设计的结构化还原(基于自托管 Langfuse 观测)，本扩展 transcript 契约的承袭来源

## 状态与限制

- 设计上在你的操作面无内置白名单(见[绕过测试](research/rule-layer-security-audit.md)与[用户自定义规则](#用户自定义规则pi-verdictjson)；唯一内置放行是 pi 自身的 subagent-artifacts 子树、仅限 headless,[ADR-0008](docs/adr/0008-agentdir-sessions-write-exemption.md))；allow 配置为空时大多数命令进分类器 —— 延迟敏感可 `--auto-mode-model` 指向轻量模型
- 路径敏感度 floor 只作用于文件类工具：bash 命令串仅匹配危险正则——`cat ~/.ssh/id_rsa` 走分类器而非确定性 S0 拦截(文件工具拼写 `read ~/.ssh/id_rsa` 会拦截)
- Windows 下内置 floor 仅覆盖 bash 形态模式——PowerShell 原生危险命令(`Remove-Item -Recurse -Force`、`Invoke-Expression`、`Set-ExecutionPolicy` 等)依赖分类器兜底(fail-closed)
- macOS 下 per-user 临时目录(`$TMPDIR`,`/var/folders/…/T` confstr 目录)豁免于系统目录 floor:读零成本放行,写按普通项目外写交分类器裁决。豁免锚定运行时解析的 confstr 族——手工设置 `TMPDIR` 不会解除任何保护;`/var/tmp`(POSIX 共享临时目录)维持拦截;真实形态逃逸临时树的符号链接拼写仍命中 S1
- AGENTS.md 未作为降权意图证据传入分类器(Claude Code 有此设计)
- 并行灰区调用串行裁决
- 自省意味着会话模型自身裁决 —— 若延迟/成本敏感，用 `--auto-mode-model` 指向轻量模型(开放问题见 issue tracker)
- `denyPaths` 的 bash 提取是 token 级([ADR-0002](docs/adr/0002-deny-paths-deterministic-ask.md))：命令替换、base64 内嵌路径、外部脚本内容不产生命中信号——这些调用回落到分类器的存在性话术警戒。MCP 与自定义工具完全绕过提取器(其灰区裁决仍带话术)。路径归一化亦为基础档(ADR-0002)：经符号链接目录写入尚不存在的目标不重建真实形、不产生命中——该间接路径同样由话术警戒覆盖(祖先重建档只适用于自保护层与路径敏感度 floor，不适用 denyPaths)。诚实表述，与自保护子串正则同例：确定性层可被混淆——这正是命中交由**你**裁决而非静默决定的原因
- `denyPaths` 的 bash token 不含空格：**声明路径本身含空格时**，bash 拼写无法被提取器识别——`cat "/path with space/x"` 被拆成两个 token 永不命中(文件类工具仍命中，其路径不经 token 化)。glob 覆盖基名末段(`denyPaths: ["/proj/personal"]` 时 `cat /proj/pers*`)同样漏过——基名自身从未字面出现。经 shell 发起的递归搜索在两种拼写下都漏过——不带路径参数(默认搜 cwd，如裸 `rg foo`)或带父目录参数(`rg foo <声明路径的父目录>`)：无参命令根本不产生 token，带参时 bash token 只做单向比较；同一形状经 `grep`/`find`/`ls` 工具发起则由双向子树比较覆盖。三个洞与上述替换/base64 一样回落到分类器的存在性话术
- 自保护 bash 匹配是子串正则——可被混淆绕过；变更检测兜底覆盖会话内绕过，跨会话基线(启动时哈希比对与变更确认，含升级 UX)按 ADR-0001 为二期
- dev checkout(从仓库而非 `<agentDir>/extensions/` 运行扩展)不受自保护——下一个正常会话加载的安装副本只在其自身会话的门禁内受保护

**verdict 不是沙箱。** 它在 pi 进程内裁决工具调用；不能遏制恶意代码、不能防护被攻陷的进程、不守护手工 `!` shell 逃逸。需要隔离请用操作系统级沙箱。

命名：三态**裁决(verdict)**是核心概念。UX 保留 `/automode` —— 模式概念上溯 Claude Code 的 auto mode，本项目亦借鉴了其 transcript 设计。

## 开发

```bash
bun install
bun run typecheck
bun test          # 离线桩测试:自保护 / 变更检测 / deny floor / 用户规则 / denyPaths / 绕过回归 / 分类器重试 / 命令 / toggle 快捷键
```

Issue tracker 与决策记录在 GitHub issues(「地图」issue #1 为索引)。

## 许可

[MIT](LICENSE)
