# CONTEXT

本项目的领域术语表。只收录术语定义,不含实现细节与决策记录(决策见 docs/adr/)。

## 术语

### Auto Mode

本产品(pi-verdict)的核心裁决模式:工具调用的权限不由人工逐次批准,也不全然放行(Pi 默认的 YOLO 行为),而是由**规则层 + 模型分类器**自动判定。语义对齐 Claude Code 的 Auto Mode,但方向相反:Claude Code 是"默认提示 → 分类器自动批准",Pi 是"默认放行 → 分类器自动拦截"。命名分层:扩展实体与持久物(包、入口文件、配置文件)用产品名 pi-verdict;运行时接口(CLI flag、`/automode` 命令、env 变量)用功能名 auto-mode 前缀。

### 主开关 (master switch)

Auto Mode 门禁的启用状态:会话内存态,默认开启。有三个操作面——CLI flag(跨会话)、`/automode` 命令(会话内)、toggle 快捷键(会话内,用户可配可禁用)——三者**语义等价**:同一状态的不同入口,不因入口不同而引入额外规则(无运行中限制、无确认弹窗、无持久化写回)。差异仅在反馈:命令显式提示,快捷键静默切换,状态可见性由 footer 始终显示承载。

### 判定管线 (adjudication pipeline)

从 tool_call 到三态裁决的完整判定流程,按序:自保护层 → 内置 floor → 用户 deny → denyPaths ask → 用户 allow → 灰区交分类器(未覆盖工具的 ignoreTools 命中先于灰区直接放行);配置 `semanticAdjudication` 时灰区段为分层裁决(ADR-0009),否则为单分类器。ask 降级(无 UI → deny)与 fail-closed 内建于管线语义。实现形态:`adjudicate(session, call, env) → Verdict` 纯函数——零 UI 依赖的 deep module,表现(notify/confirm/select)由扩展 handler 承担。变更检测(门禁完整性)是管线前置的独立关注点,不属于判定管线。_Avoid_: 裁决管线(全仓统一用「判定管线」)。

### 裁决 (verdict)

对单次工具调用的判定结果。由 `tool_call` 钩子产出,放行则不做干预,拦截则返回 `{ block: true, reason }`。运行时载体为 `Verdict` 值对象(verdict / reason / detail / source / degraded):`detail` 为 UI-only 明文(受保护路径仅入本地确认框,ADR-0002 零泄漏承诺),`source` 区分 rule / protected-path / classifier / fail-closed,`degraded` 标记 ask 降级产物。

### 通知 (verdict notification)

门禁对用户的信息呈现通道,只承载**值得注意的判断**:deny/ask 恒通知;classifier 的 allow 经用户规则 `notifyAllows`(默认关)开启;机械放行恒静默——rule allow 是用户自己声明的正则回显,protected-path confirm 的可见性即确认框本身。与「裁决审计」分工:通知负责判断,审计日志负责完整记录。debug 开关(flag/env)使每次裁决全量通知(含放行),与 `notifyAllows` 正交;两者同开时 classifier allow 通知只呈现一条。

### 裁决审计 (verdict audit records)

灰区裁决的 opt-in JSONL 决策记录(#54)。`pi-verdict.json` 的 `"audit": true` 开启;每条记录自包含(时间戳/会话 id/cwd/模型/工具与输入/action 行/思考级别/完整转录/原始响应/解析裁决/来源/降级标记),按会话落 `<agentDir>/verdicts/<sessionId>.jsonl`,保留最近 20 个。#62 起审计面扩至 protected-path ask——其用户应答是对 denyPaths 声明质量的反馈;#71 起 enforce 获救的 fail-closed 行顶层 verdict 落生效裁决(source 仍为 fail-closed),其余行顶层语义不变——且交互式 ask 记录 ground truth(`userAnswer`/`answeredAt` 于确认应答后落盘,`ts` 仍为裁决时间;确认中途会话中断丢该条,已接受的代价);规则层 allow/deny 仍不入审计。observe-only:append-only、永不回流裁决输入;全保真(受保护路径明文仅存本地,ADR-0002 边界注;凭证明文经**审计脱敏**处置);目录对 agent 读写双拒(记录含不可信原始输出);写失败 fail-soft 不影响裁决。

### 审计脱敏

审计落盘前的确定性凭证改写(ADR-0007)。仅作用于 `AuditLog.append()` 这一落盘咽喉——判定管线与分类器输入保持原文(命令携带凭证这一事实本身是裁决信号);两层检测(精确前缀形态 + 上下文引导的值脱敏),命中替换为 `<redacted:类型#sha256 前 8 hex>`;指纹不加盐、具确定性——同凭证跨记录同指纹,保留聚类/追因能力。默认开启,`auditRedactSecrets: false` 显式关闭(无效值一次性警告且保持开启);脱敏失败 fail-open(记录完整性优先于卫生);pi 原生 session 转录与终端回显不在其覆盖范围。

### 规则层 (rule layer)

判定管线的第一段:确定性规则给出硬性 allow 或 deny。由两部分组成:**内置 deny floor**(bash 危险正则 + 文件路径敏感度分级,只做 deny 声明——误报方向安全;macOS 的 per-user 临时目录经运行时解析的 confstr 族豁免于系统目录分级,交集形态,`authorized_keys` 等文件名族不受豁免)与**用户规则**(allow/deny 正则,由用户配置并背书)。内置层不提供白名单(0.2.0 起,安全审计结论:白名单健全性需要 shell AST 分析)。嵌套调用策略(`codemodeNestedCalls`,ADR-0006):默认与直发同管线;rules-only 时嵌套调用仅走确定性层、灰区直接放行——分层豁免,非跳过。

### 双形匹配

路径类规则判定的归一化纪律:同一目标路径产出**全部规范形**——词法绝对形 + realpath 形;规则匹配对每个形逐一测试,任一形命中即生效。词法形位于 cwd 内而真实形出走 cwd 的 symlink 别名不得因此获得「项目内写入」放行(要求全部形位于 cwd 的词法/真实形之内)。纪律分两档:**基础档** = 整路径 realpath、失败降级词法形(实现 `baseForms`;denyPaths 与一切基址侧双形集合自始遵循,ADR-0002);**祖先重建档** = 目标尚不存在时自最近存在祖先的 realpath 逐级重建(实现 `rebuiltForms`;自保护层与路径敏感度 floor 自 #20 起遵循——误放行代价高的判定取强档)。denyPaths 不做祖先重建:不存在目标经 symlink 别名的写入不命中,落分类器 + 存在性话术兜底。_Avoid_: 只测词法形的单形匹配(对 symlink 别名整体旁路);把祖先重建记到 denyPaths 头上(denyPaths 是基础档,ADR-0002,有回归测试钉住)。

### 用户规则 (user rules)

`<agentDir>/config/pi-verdict.json` 中用户配置的 allow/deny 正则:deny 优先于 allow,黑名单命中即拦截;匹配目标为 bash 完整命令串 / 文件类工具的绝对路径。`builtinDenyFloor: false` 可整体关闭内置 deny floor(风险自担)。安全声明(「永远放行」)由用户背书而非作者。

### agentDir 自锚定 (agentDir self-anchoring)

`<agentDir>` 的解析纪律(#35,双宿主):`PI_CODING_AGENT_DIR` 显式覆盖恒优先;否则从扩展自身安装位置反推——位于 `<home>/<dot-dir>/(agent/)?(plugins/node_modules/<pkg>/)?extensions/` 之下时锚定到 `<home>/<dot-dir>/agent`(覆盖 pi 的 `~/.pi/agent` 与 omp 的 `~/.omp/agent`;omp 插件目录在 18.1+ 与 agent/ 平级(`<dot-dir>/plugins/...`),≤18.0 在其下,两种布局均匹配,配置树恒在 `<dot-dir>/agent/config/`);无从锚定时回退 `~/.pi/agent`(dev checkout)。**禁止**以宿主目录树存在性探测代替自锚定:双宿主并存的机器上,`~/.omp` 的存在不得让 pi 下的运行改道。自保护层的安装副本判定与 S0 凭据 deny 规则随同一锚点覆盖两种宿主形态。

### denyPaths (受保护路径)

用户在 config 中声明的敏感路径列表,是**路径语义声明**:归一化(`~` 展开、词法 resolve、realpath 消解符号链接,realpath 失败降级词法层,macOS/Windows 上大小写折叠)与路径段前缀比对由**工具负责**,提取范围覆盖文件类工具的绝对路径与 bash 命令串中可提取的路径 token。命中即 **ask 终局**(非交互降级 deny),优先于用户 allow、劣后于用户 deny 与内置 floor。与用户规则的 deny(正则黑名单,用户自负归一化假设)相对:同一安全声明,声明更强的通道。路径提取与命中判定全部在本地完成,分类器只见**存在性话术**(不知路径明文、不见命中调用的裁决)。_Avoid_: denyPath(单数)。泛指 "protected paths" 单独出现时易与自保护层的 protected files 混淆——本词条语境优先用全称 "user-declared protected path (denyPaths)" 或中文「受保护路径(用户声明)」。

### ignoreTools (工具豁免)

用户在 config 中声明的工具名列表,是**无副作用声明**:命令/文件族之外的未覆盖工具(`todo`、`web_search`、MCP/自定义工具)命中即跳过全部裁决——零模型调用直接 allow。条目列出已覆盖工具(`bash`/`read`/`write`/`edit`/`grep`/`find`/`ls`/`powershell`)时惰性无效:那些仍由 deny floor 与用户 allow/deny 规则治理;自保护层永远先于豁免执行,列表无法削弱任一层。与 denyPaths 的对称关系:一个声明「更严」(触碰即问),一个声明「更松」(免审放行),同为用户主权配置;首启模板预填无副作用入门列表(生产审计背书,可增删清空)。代价面:被豁免工具失去分类器的存在性话术警戒(未覆盖工具本就不进路径提取器)。_Avoid_: 称其为「内置白名单」——ignoreTools 是用户声明,项目无内置放行清单。

### 存在性话术 (existence hint)

注入分类器 system prompt 的固定背景句:告知用户配置了受保护路径,擦边行为(拷贝到临时目录再读、打包、间接引用)应从紧裁决。是 denyPaths 泄漏面为零承诺的推论:分类器知道"有",不知道"是什么"。

### 运行时数据豁免

无 UI 会话(`hasUI=false`,subagent 会话即此类)对 `<agentDir>/sessions/**/subagent-artifacts/` 子树的 write/edit 确定性放行(ADR-0008)。仅限 headless:交互会话保有 ask 能力,门禁不静默放弃人可执行的裁决;`hasUI` 是代理信号——pi 的 ExtensionAPI 无 subagent 身份标记(`parentToolCallId` 只标记 codemode 嵌套)。置于用户 deny 与 denyPaths 之后、gray 落分类器之前——用户声明压过内置豁免,且只抬 gray 档。双形从严(every 交集,前缀用祖先重建档);read 与 bash 不豁免。无配置键:与 #54 verdicts 读拒绝同类的"门禁对 pi 自身面的关系陈述",非用户策略。

### 自保护层 (self-protection layer)

判定管线中**不可经任何配置豁免**的内置 deny 规则集,保护对象是门禁自身的完整性(用户规则配置文件与扩展安装副本;0.12 及以前另含随包分发的 jev 适配器副本,该文件已随适配器退役消失)。与用户规则相对:后者可自由增删,前者连 `builtinDenyFloor: false` 也不能关闭。语义依据:门禁之内一切写入按定义均由 agent 发起,故受保护路径对工具调用恒 deny;用户在门禁之外(编辑器等)修改不受影响。_Avoid_: 黑名单(该词保留给用户规则的 deny 正则)。

### 变更检测 (tamper detection)

对受保护文件的完整性复核,作为规则层拦截可被绕过(命令混淆、MCP 旁路)时的纵深兜底。会话内:启动时快照,每次裁决前复核;不一致时差分处置——扩展副本被改或无 UI → 从快照**自动还原** + 本会话 fail-closed;仅配置文件被改且有 UI → **确认式**(保留 = 重建基线照常,还原 = 回滚 + fail-closed)。跨会话基线(持久哈希 + 启动比对确认)为二期。

### 灰区 (gray zone)

规则层未给出硬性结论的工具调用,移交模型分类器判定的集合。

### 分类器 (classifier)

对灰区工具调用做风险判定的模型调用。模型**可配置**,默认**自省**;后端形态不限生成式——原生分类器(分类器型模型)经 pi 的 `classify()` 协议通道接入(ADR-0005)。0.16 起可配置为**分层裁决**(ADR-0009):配置了 `semanticAdjudication` 块时,灰区由 Tier 1(本地 Lancet-Nano)+ Tier 2(模型注册表裁决器)两段组成;未配置时仍是单分类器路径。

### 分层裁决 (tiered adjudication)

ADR-0009 的两段式灰区语义:**Tier 1** 用本地 LANCET-Nano(INT8 ONNX,CPU,无网络)对 shell 命令做三档分诊——`not_flagged` 直接放行、`risky` 按 `riskyAction` 转 ask 或 deny、`review`(及任何弃权:超长、分词失败、推理错误、缺包)升级 **Tier 2**。Tier 2 从宿主模型注册表按角色解析裁决模型(`adjudicator` → `smol` → 会话模型),携带会话转录与 Tier 1 分诊结果,按严格 JSON 契约回答;`allow` 放行,`ask`/`deny` 一律转人工(模型不得在本层自动 deny),解析失败/超时/网络错误 fail-closed 为 ask(无 UI 降级 deny)。开关是配置块的有无;缺失时行为与 0.15 逐字节一致。_Avoid_: 把 Tier 1 的 `not_flagged` 当安全保证——它只是「本地模型未发现风险」,确定性 floor 仍是骨架。

### 自省 (self-reflection)

分类器的默认模型来源:继承当前会话正在使用的 provider/model 发起裁决调用(而非固定外部模型)。

### 伴生适配器 (bundled adapter)

**已退役(0.13,ADR-0005)**:0.12 及之前随包分发的 `extensions/jev-adapter.ts`,在 pi 模型注册表中把 typesafe 的 jev 呈现为 chat 形模型(`typesafe/jev-latest`),将分类器的模型调用翻译为 decisions 请求。pi 0.99 内置 classify() 后运输层价值被官方吸收,文件删除;老宿主(pi < 0.99 / omp)继续用 0.12.x。_Avoid_: 继续把 jev 接入称为「适配器」——现称呼为原生分类器路径。

### 类型化决策 (typed decision)

非生成式模型的输出形态:预定义选项上的取值 + 概率分布 + 置信度,构造上不可能产出约定 schema 之外的形态。jev 属此类,与 LLM 自由文本相对;reason 合成时透传概率与置信度。

### 原生分类器 (native classifier / classifier model)

经 pi ≥ 0.99 的 `classify()` 协议通道接入分类器层的模型,由宿主模型注册表的 `findOfType("classifier", …)` 解析、以 `model.type === "classifier"` 为类型身份(System One(jev 全 transport)/ llama.cpp 标签概率分类器)。是一切能力判定的锚点:数值置信度、思考级别不适用性等能力命题以**类型身份**为准——LLM 的自由文本恰好模仿 jev reason 格式不改变其身份(其裁决不携带置信度,floor 按构造不触发)。_Avoid_: decisions 模型(0.12 术语,已退役——见下)。

### decisions 模型 (decisions model) — 已退役术语

0.12 及之前的判定轴术语:经类型化决策协议接入、协议身份由 api 标识(`jev-decisions`)承载的模型。0.13 起被「原生分类器」取代(ADR-0005):判定轴从扩展自注册的协议身份改为宿主原生的模型类型。「decisions protocol / System One」保留为 jev 网络协议的史实名,reason 前缀 `jev:` 亦因此保留(审计语料连续性)。

### 裁决前缀契约 (verdict prefix contract)

分类器响应的文本形态约定:必须以 `<verdict>allow|ask|deny</verdict>` 开头、后随一行理由;违反即解析失败,按 fail-closed 处理。后端无论是生成式还是类型化决策,最终都归一到该形态。

### 三态裁决 (allow / ask / deny)

裁决的三档取值:规则层或分类器判定安全 → **allow**(自动放行);判定危险 → **deny**(自动拦截,返回 block 与理由);无法确定 → **ask**(转人工确认)。

### ask 降级

无 UI 可用时(非交互模式:`pi -p` / json / rpc)ask 的处置:一律按 deny 处理。是 fail-closed 在无人值守场景的推论。

### fail-closed

任何异常路径(分类器报错、超时、输出无法解析)的默认行为:拦截,绝不静默放行。

### 置信降级 (confidence demotion)

置信地板(`classifierMinConfidence`,ADR-0004)触发时第一层裁决被降级的机制:**原生分类器**的裁决 confidence 严格低于地板时,无论 allow/ask/deny 一律降级——级联到回退分类器(若配置),否则转人工 ask(非交互降级 deny)。不低于地板时第一层完全自主。地板可独立采用(无需第二层);判据为「协议原生置信度的存在」(ADR-0005):分类器路径的结构化 confidence 是唯一触发源,chat/LLM 路径不携带 confidence、按构造不触发——且不静默,首次灰区解析呈现一次中性警告(显式与自省路径皆然)。

### 无效配置须呈现 (inert configuration must surface)

配置纪律(#81):配置键声明的意图在生效模型的能力无法兑现时,必须产生运行时反馈——通常为每会话一次的**中性**警告(陈述事实,不评判配置:用户可能为将来的分类器切换预设地板),不得静默失效。惰性边界:纯规则裁决的会话不触发任何此类警告(反馈随首次灰区解析产生)。实例:置信地板对 chat 模型分类器、原生分类器 spec 上的思考后缀、不可解析的 jev spec(特化文案指向真实成因:宿主无原生分类器支持,或缺该 transport 的凭证)。

### 回退分类器 (fallback classifier)

级联的第二层(`classifierFallbackModel` 配置),仅在置信降级或第一层 fail-closed 时参与。enforce 模式(0.12.0 起默认)全权裁决(de novo),唯一例外族(#71):降级的 deny 或 ask 不可被自动放宽为 allow——否定性判定的人工裁决不可旁路;**fail-closed 获救**(rescue)不属放宽——第一层缺席而非给出否定性判定,第二层的任何裁决(含 allow)属首裁、照常自动生效。shadow 模式(显式选项,`/automode` 会提示激活开关)只记录意见——结果落审计记录的 `fallback` 子对象与 `/automode` 会话计数,降级调用仍由人工裁决,fail-closed 的 deny 照旧。fallback 调用失败或不可解析时,该级联调用转人工(非交互降级 deny)——该裁决的层级已失效,人工是下一级。审计顶层恒为第一层语义(`demoted: true` 标记降级),生效裁决在 `fallback.effective`(仅 enforce 行);#71 例外:enforce 获救的 fail-closed 行顶层 verdict 落生效裁决(deny 只是级联前默认,非第一层判断;shadow 行不受影响)。`/automode` 计数中 `rescued-allow`(shadow 为 would-rescue-allow)单列且**含于** overruled 口径。jev 侧 confidence 为硬要求(契约保证,缺失即 fail-closed)。
