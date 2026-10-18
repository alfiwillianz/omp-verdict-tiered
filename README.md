# pi-verdict

**[English](README.md)** | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/pi-verdict)](https://www.npmjs.com/package/pi-verdict)
[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://pi.dev)

**pi-verdict is a minimal permission gate for [pi](https://pi.dev), inspired by Claude Code's auto mode: every tool call gets checked before it runs — allow, deny, or ask you first.**

- Minimal — one readable core file (the classifier rides pi's native `classify()` since 0.13; tiered adjudication is an optional module)
- Built-in danger rules and your own allow/deny rules settle the clear cases first, at zero latency
- Everything else goes to a model classifier that sees the conversation context
- Any uncertainty or failure fails closed; nothing ever runs silently
- Self-protection: the gate guards itself against snooping and tampering

## The problem

pi has no built-in permission prompts — every tool call executes with the permissions of the pi process ([pi security docs](https://pi.dev/docs/latest/security)).

pi-verdict adds the missing gate: a model decides whether each call should run, based on the conversation context and your intent.

## Why three states

**verdict is an adjudication, not a switch.** Most classifiers in this space output a binary allow/block. Three states matter: `ask` routes genuinely ambiguous actions to a human (and degrades to `deny` in non-interactive sessions), so "not sure" never silently becomes "go ahead" — the goal is safe automation, not maximum automation: both approval fatigue and silent unsafe execution lose.

## Design principles

- **Fail closed** — uncertainty produces friction, never permission.
- **Deterministic floor before AI** — hard denies are never overridden by the classifier or user allow rules.
- **Semantics over syntax** — the classifier judges what an action *does*, not how long it is.
- **Judgments, not proofs** — a classifier `allow` is an informed opinion; the floor exists because that is all it is.
- **Minimal trusted input** — no tool results in the transcript (#22), zero path plaintext to the classifier (ADR-0002).
- **Canonical identity** — lexical + realpath dual-form matching; a workspace-*looking* path is not trusted as one (#20/#21).
- **The gate guards itself** — self-protection that no configuration can disable (ADR-0001).
- **A permission gate, not a sandbox** — stack OS isolation on top; this gate never replaces it.

Full statement in [docs/security-principles.md](docs/security-principles.md).

## Screenshots

![Demo: protected-path ask declined](https://raw.githubusercontent.com/jesset/pi-verdict/main/docs/demo.gif)

![Automode Status](https://raw.githubusercontent.com/jesset/pi-verdict/main/docs/images/status.png)
![Ask Permission](https://raw.githubusercontent.com/jesset/pi-verdict/main/docs/images/asked.png)

## Quick start

```bash
# install from npm (pi):
pi install npm:pi-verdict

# install from npm (oh-my-pi / omp):
omp plugin install npm:pi-verdict

# or directly from git — try it once
pi --extension ./extensions/pi-verdict.ts

```

Requires pi ≥ 0.99. Works in interactive and non-interactive (`-p`/json/rpc) sessions; in non-interactive modes `ask` degrades to `deny`.

### Hosts

pi-verdict 0.13+ requires **pi ≥ 0.99** and runs on pi only (native classifier support, [ADR-0005](docs/adr/0005-native-classifier-migration.md)). Older hosts — pi < 0.99 and [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) — keep using the **0.12.x** line from npm (old hosts run old extensions). The 0.12 line still self-anchors to whichever agent tree it is installed in and follows the extension copy's own location on dual-install machines; its classifier completion falls back to the pi-ai compat API on omp 18 (still fail-closed). Details: [docs/configuration.md](docs/configuration.md#host-notes-pi-and-oh-my-pi).

| | pi | omp (0.12.x line) |
|---|---|---|
| install | `pi install npm:pi-verdict` | `omp plugin install npm:pi-verdict` |
| extension copy | `~/.pi/agent/extensions/` | `~/.omp/plugins/node_modules/pi-verdict/` (omp 18.1+; ≤18.0: under `agent/`) |
| user rules | `~/.pi/agent/config/pi-verdict.json` | `~/.omp/agent/config/pi-verdict.json` |
| credential file (S0 hard deny) | `~/.pi/agent/auth.json` | `~/.omp/agent/auth.json` |

- `/automode` — show current status: on/off
- `/automode on`
- `/automode off`
- `ctrl+shift+a` — toggle the master switch silently (the always-on footer is the only feedback; rebind or disable via `toggleShortcut`)
- footer always shows `auto mode on` (green) / `auto mode off` (yellow)

| Option | Default | Description |
|---|---|---|
| `--auto-mode` / `--no-auto-mode` | on | master switch |
| `--auto-mode-model provider/id` | session model | classifier model ("self-reflection" by default) |
| `--auto-mode-debug` | off | full verdict notifications |
| `PI_AUTO_MODE_MODEL` | — | env form of the model flag |
| `PI_AUTO_MODE_DEBUG=1` | off | env form of debug (flag wins) |

### User rules (`~/.pi/agent/config/pi-verdict.json`)

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

- `allow`/`deny` are JS regex arrays; **`deny` wins over `allow`**, both beat the classifier
- `denyPaths` are plain paths you declare **protected** — touches trigger a terminal ask you adjudicate (non-interactive → deny); the classifier never learns the paths themselves, only that they exist. `grep`/`find`/`ls` compare their whole **search scope**: an omitted `path` (pi's default: the current directory) or a parent directory of a declared path triggers the ask as well. A fresh install pre-fills a **starter list** (`~/.ssh/`, `~/.gnupg`, `~/.mc`, shell rc/profile files)
- `ignoreTools` names uncovered tools (`todo`, `web_search`, MCP/custom tools) that skip adjudication — **allow with zero model calls**; entries naming covered tools (`bash`/`read`/`write`/`edit`/`grep`/`find`/`ls`/`powershell`) are inert: those stay governed by the deny floor and your allow/deny rules, and the self-protection layer always runs first. A fresh install pre-fills a **starter list** (`todo`, `ask_user_question`, `memory_write`, `memory_search` — observed harmless across the 1265-verdict production audit). Caveat: an exempted tool loses the classifier's `denyPaths` existence-hint vigilance (uncovered tools never hit the path extractor anyway); MCP tool names are normalized before matching — see [codemode & MCP](#pi-099-codemode--mcp-indirect-calls-are-still-gated)
- `builtinDenyFloor: false` turns off the built-in danger/path floor (your risk; the self-protection layer below always stays on)
- `classifierModel` pins the classifier model, e.g. `"zai/glm-5.3-flash:low"` (thinking suffix supported; default: session model with thinking off)
- `classifierModel: "typesafe/jev-latest"` opts into the **native jev classifier** — one structured `classify()` call per gray-zone verdict via pi's built-in classifier catalog (TypeSafe direct, or Jev on OpenRouter/OpenCode/Cloudflare/Vercel); see [ADR-0005](docs/adr/0005-native-classifier-migration.md)
- `semanticAdjudication` opts into **tiered adjudication** ([ADR-0009](docs/adr/0009-tiered-semantic-adjudication.md)): shell commands are triaged locally first by **Tier 1** — LANCET-Nano, a 111 MB INT8 ONNX model on CPU, no network ([setup](#tier-1-lancet-nano-setup)). `not_flagged` allows immediately (~10 ms), `risky` asks (or denies with `riskyAction: "block"`), `review`/oversized input escalates to **Tier 2**, a model resolved from the host registry (`tier2Role`: `"adjudicator"` → `"smol"` → session model) that sees the tool call, the conversation and Tier 1's band. Tier 2 `allow` passes; `ask`/`deny` both go to you; any failure (no model, network, 5 s timeout, bad JSON) fails closed to ask (headless → deny). Omit the block and behavior is exactly 0.15's single-classifier path. Non-shell tools bypass Tier 1 and go straight to Tier 2.
- `audit: true` records every **gray-zone adjudication** (the full transcript sent to the classifier, its raw response, the parsed verdict) as JSONL under `~/.pi/agent/verdicts/<sessionId>.jsonl` — one file per session, the 20 most recent kept. Interactive asks also record your answer (`userAnswer` ground truth, written after the confirm resolves), and protected-path asks are recorded too (#62); rule allow/deny stays unaudited. Local-only and full-fidelity (protected-path plaintext may appear — it never leaves your machine; [ADR-0002](docs/adr/0002-deny-paths-deterministic-ask.md) boundary note); secret-shaped text is redacted on append (`<redacted:type#fingerprint>`, deterministic so cross-record tracing survives — `auditRedactSecrets: false` opts out; [ADR-0007](docs/adr/0007-audit-secret-redaction.md)); the agent can neither read nor write the directory. `/automode` shows the audit state and path while on
- `notifyAllows: true` notifies on every **classifier allow** (reason + action line — e.g. jev's probability breakdown); default `false` keeps passes silent. Mechanical passes (your own allow rules, protected-path confirms) never notify; with both switches on the notification appears once
- `classifierMinConfidence` (optional, [ADR-0004](docs/adr/0004-classifier-fallback-cascade.md)) sets the **confidence floor**: a native-classifier verdict below it is demoted — cascaded to `classifierFallbackModel` if set (`enforce`, the default = the second layer adjudicates; a demoted **deny or ask** can never be auto-relaxed to an allow; a fail-closed layer emitted no verdict, so its rescue stands; `shadow` = records its opinion only and you are asked — `/automode` hints the activation switch), otherwise asked of you directly. At/above the floor the first layer is autonomous. The floor applies to native classifier models only (protocol-native confidence) — with a chat/LLM classifier it is inert, and a one-time warning says so. A natural pairing: jev first + a haiku/flash-class fallback

No built-in allowlist — every "always allow" claim is yours ([why](docs/configuration.md#why-no-built-in-allowlist)). Full reference: [docs/configuration.md](docs/configuration.md).

### Tier 1 Lancet-Nano setup

```bash
bun run setup:lancet            # ~/.cache/pi/lancet-nano (pinned v0.4.3, hash-verified)
bun run setup:lancet --check    # verify an existing bundle, no network
bun run setup:lancet --dir DIR  # custom location (must match tier1Lancet.modelPath)
```

The setup verifies `export.json` against the release manifest digest, every model file against `export.json`, and the tokenizer against the reference implementation. The runtime repeats the file check on every load — a tampered or missing bundle never produces a `not_flagged`; Tier 1 escalates with a one-shot warning. With the block configured but the bundle absent, shell commands go to Tier 2.

### Native jev classifier ([ADR-0005](docs/adr/0005-native-classifier-migration.md))

1. Install: `pi install npm:pi-verdict` (v0.13+; pi ≥ 0.99 required — older hosts keep 0.12.x)
2. Ensure a credential for one of the built-in Jev transports:
   - **TypeSafe direct** (`typesafe/jev-latest`): `export TYPESAFE_API_KEY=apikey_...` (self-service at console.typesafe.ai)
   - **OpenRouter** (`openrouter/~typesafe/jev-latest`, `openrouter/typesafe/jev-1.13`): `/login openrouter` inside pi, or `export OPENROUTER_API_KEY=sk-or-v1...`
   - also served on OpenCode Zen, Cloudflare Workers AI, and Vercel AI Gateway with each provider's login; llama.cpp chat models double as free local classifiers (`model.type: "classifier"` siblings)
3. Point the classifier at jev (applies to new sessions)
   - persistent: edit `~/.pi/agent/config/pi-verdict.json` outside pi and set `{ "classifierModel": "typesafe/jev-latest" }`
   - or try it once: `PI_AUTO_MODE_MODEL=typesafe/jev-latest pi`

**Notes**:
- Verdicts are structured `classify()` answers (choice + probabilities + confidence); the reason line keeps the historical `jev:` probability breakdown (tag-free — the `<verdict>` prefix survives only in the audit record's rawResponse), other classifier APIs render `classifier:`
- Classifier specs resolve through pi's classifier catalog first (`findOfType`), chat registry second; on same-id dual listings (llama.cpp) the native entry wins; thinking suffixes on a classifier spec warn once and drop (recorded `thinking: null`)
- Custom endpoints: override the provider's `baseUrl` in models.json (the 0.12 `PI_VERDICT_JEV_URL` escape hatch is gone, as is `PI_VERDICT_JEV_TRANSPORT` — transport choice is now the spec itself)
- Carried-over limit: the denyPaths existence hint still does not reach classifier-typed models ([ADR-0005](docs/adr/0005-native-classifier-migration.md)); on the TypeSafe direct transport per-call cost shows $0 (its API does not report it)

jev's calibrated confidence is exactly what the confidence floor keys on — pair it with a second layer (`"classifierMinConfidence", "classifierFallbackModel"`) so its low-confidence calls go to a deeper model instead of standing ([ADR-0004](docs/adr/0004-classifier-fallback-cascade.md)).

### pi 0.99 codemode & MCP: indirect calls are still gated

pi 0.99 can run model-written JavaScript in a QuickJS sandbox (`codemode`) that calls pi's tools, and MCP servers register tools as `mcp__<server>__<tool>`. Neither surface bypasses this gate:

- **Nested calls are gated exactly like direct ones** — pi routes every tool call a codemode script makes through the same `tool_call` pipeline (tagged `parentToolCallId`, ids `<parent>/<n>`); a blocked call returns as an error to the script, which the model sees
- **MCP tools land in the gray zone** — the rule layer covers the built-in command/file tools only; each `mcp__*` call is classified, fail-closed included
- **`ignoreTools` and MCP names**: tool names are normalized — every character outside `[A-Za-z0-9_]` becomes `_` (`mcp__dev-radius__x` → `mcp__dev_radius__x`); exemption entries must use the normalized form
- **Cost amplification**: one script may issue up to 256 nested calls; gray-zone calls classify one by one, so a slow LLM classifier multiplies per-call latency
- **Exposure boundary**: adding an MCP server auto-enables codemode, and `pi --no-extensions -e builtin:mcp` runs MCP tools with no extensions loaded — i.e. without this gate. The gate is itself an extension, so it cannot be active in a session that loads none; the boundary is inherent to pi's extension model, stated here rather than papered over
- **Batch latency is configurable** ([ADR-0006](docs/adr/0006-codemode-nested-calls-policy.md)): every nested call adjudicates individually and gray-zone adjudication is serial (~350ms/call measured), so large script batches pay real latency. `"codemodeNestedCalls": "rules-only"` opts nested calls into the deterministic layers only (rules, floor, self-protection, denyPaths + ask) — the gray zone passes; the trade-off is that rule-passing actions the classifier would have caught (e.g. a nested `bash head ~/.ssh/config` without a denyPaths declaration) pass too. Audit records carry `toolCallId`/`parentToolCallId` either way

### Self-protection (the gate guards itself — [ADR-0001](docs/adr/0001-self-protection-layer.md))

The gate's own files — the config and the installed extension copy — are **user-editable only**: writes from inside the gate hard-deny (reads pass); your editor never passes through the gate, the sudoers/visudo precedent.

- **Not disableable by any config** — `builtinDenyFloor: false` and user `allow` rules cannot touch this layer
- **Tamper detection** as the backstop: watched files are snapshotted at `session_start` and re-verified before every verdict — a changed extension copy is auto-restored and the session goes fail-closed; a changed config gets one explicit keep/restore confirm when a UI is available (headless auto-restores, same as the extension copy; [ADR-0001](docs/adr/0001-self-protection-layer.md) for the differential-disposal rationale)

---

## How it compares

| | three-state verdict | classifier sees context | fail direction | runtime deps |
|---|---|---|---|---|
| **pi-verdict** | ✅ allow / ask / deny | ✅ recent user intent + tool calls | **closed** (errors/timeout/bad output → deny; headless ask → deny; Tier 2 failure → ask) | **0** core (opt-in tiered runtime adds ONNX) |
| [@czottmann/pi-automode](https://github.com/czottmann/pi-automode) | rules 3-state, classifier 2-state | ✅ budgeted transcript | closed | 1 |
| [@zhushanwen/pi-permission](https://www.npmjs.com/package/@zhushanwen/pi-permission) | ✅ (outcome) | ❌ single-turn, no context | closed (→ ask) | 4 |
| [@gotgenes/pi-permission-system](https://github.com/gotgenes/pi-packages) | ✅ deterministic only | — (no built-in classifier) | closed | 3 |

Full landscape: [`research/pi-permission-landscape.md`](research/pi-permission-landscape.md) · convergence analysis with the closest architectural relative: [`research/pi-automode-convergence.md`](research/pi-automode-convergence.md).

Honest framing: pi-automode and pi-verdict have **converged on the same architecture** (deny floor → user rules → classifier, fail-closed — see the convergence analysis). What remains distinct here: a classifier that can say `ask` (runtime human-in-the-loop, not just rule-declared), a built-in floor you can turn off (`builtinDenyFloor` — user sovereignty), a self-protection layer that no config can turn off ([ADR-0001](docs/adr/0001-self-protection-layer.md) — gate integrity), a dependency-free core ([one readable file](extensions/pi-verdict.ts); the optional tiered runtime is a separate opt-in module), and the measurement habit — every design decision in this repo is backed by shipped research.

## Pipeline

![pi-verdict security gate — tool-call adjudication pipeline](https://cdn.jsdelivr.net/gh/jesset/pi-verdict@main/docs/diagrams/security-pipeline.en.svg)

*Diagram source & regeneration: [docs/diagrams/](docs/diagrams/README.md). Pipeline as of v0.14 — the ASCII version below is the text-faithful equivalent.*

```
tool_call
  │
  ├─ 0. Self-protection layer (ADR-0001; not disableable by any config)
  │     ├─ write/edit/bash touching the gate's own files → deny; reads pass
  │     └─ tamper detection: re-verify before every verdict →
  │         auto-restore + fail-closed, or one keep/restore confirm
  │
  ├─ 1. Rule layer (deterministic, zero latency)
  │     ├─ built-in deny floor: bash danger regexes + path sensitivity S0–S5
  │     ├─ your rules: user deny beats user allow
  │     ├─ denyPaths (ADR-0002): protected paths → terminal ask,
  │     │   before user allow; classifier sees an existence hint only
  │     ├─ ignoreTools: your declared uncovered tools → allow, zero model calls
  │     ├─ headless subagent-artifacts writes (ADR-0008): a no-UI session's
  │     │   write/edit under <agentDir>/sessions/**/subagent-artifacts/ →
  │     │   deterministic allow (interactive sessions keep the ask); your
  │     │   deny rules and denyPaths still outrank it
  │     └─ no built-in allowlist on your surfaces — every "always allow"
  │       claim is yours to make (the one built-in allow is pi's own
  │       subagent-artifacts subtree, headless-only, ADR-0008)
  │
  ├─ 2. Gray zone → nested-call policy, then semantic adjudication
  │     ├─ nested call (codemode) + codemodeNestedCalls=rules-only → pass;
  │     │   deterministic layers above already ran (ADR-0006)
  │     ├─ default: one classifier — native classify() (choice + probabilities +
  │     │   confidence; tag-free reason, full contract line in the audit
  │     │   rawResponse) or, on the chat path (session-model self-reflection),
  │     │   <verdict>…</verdict> prefix-anchored free text
  │     └─ tiered (ADR-0009, opt-in semanticAdjudication block):
  │           shell → Tier 1 LANCET-Nano (local, ~10 ms):
  │             not_flagged → allow; risky → ask (or deny); review/long → Tier 2
  │           all tools → Tier 2 model-registry adjudicator (role → smol → session):
  │             strict JSON; allow passes, ask/deny → human; failure → ask
  │
  └─ 3. Three-state adjudication
        ├─ allow → pass
        ├─ deny  → block, reason returned to the agent
        └─ ask   → human confirm; non-interactive modes degrade to deny

```

**fail-closed**: classifier exception / timeout (25s) / contract violation → deny; in tiered mode, Tier 2 failure (no model, network, 5s timeout, bad JSON) → ask (headless → deny). Never silently allow.

## Evidence-driven, not vibes-driven

Design decisions here are settled by measurement, and the lab notes ship with the repo:

- [`research/cache-sim`](research/cache-sim/README.md) — replayed 1.2k+ real classifier verdicts to measure verdict-cache hit rate (**3.2%** → serving cache declined; the runtime shadow telemetry built afterwards measured 3.3% and was later removed too, #73)
- [`research/thinking-param-blackhole.md`](research/thinking-param-blackhole.md) — three-layer forensic root-cause of thinking models burning the classifier budget; why the fix is `thinkingEnabled: false`
- [`research/rule-engine-sim`](research/rule-engine-sim/README.md) — measured a tree-sitter rule-engine port against 746 real bash calls (**absorbs 0 gray calls**) and rejected it
- [`research/pi-permission-landscape.md`](research/pi-permission-landscape.md) — the competitive landscape this README's positioning is checked against
- [`research/rule-layer-security-audit.md`](research/rule-layer-security-audit.md) — rule-layer bypass testing (8/8 reproduced → fixed architecturally in 0.2.0)
- [`research/pi-automode-convergence.md`](research/pi-automode-convergence.md) — where this project genuinely converges with pi-automode, and what remains distinct
- [`research/claude-code-classifier-prompts.md`](research/claude-code-classifier-prompts.md) — structural reconstruction of Claude Code's classifier design (via self-hosted Langfuse observations) that this extension's transcript contract descends from

## Status & limitations

- no built-in allowlist on user surfaces by design (see the [bypass writeup](research/rule-layer-security-audit.md); the one built-in allow is pi's own subagent-artifacts subtree, headless-only, [ADR-0008](docs/adr/0008-agentdir-sessions-write-exemption.md)); with an empty `allow` config most commands go to the classifier — point `--auto-mode-model` at a fast model if per-call latency matters
- the path sensitivity floor applies to file tools only: bash command strings are matched by the danger regexes alone, so e.g. `cat ~/.ssh/id_rsa` goes to the classifier rather than the deterministic S0 deny (the file-tool spelling `read ~/.ssh/id_rsa` does deny)
- on Windows the built-in floor covers bash-shaped patterns only — PowerShell-native dangerous commands (`Remove-Item -Recurse -Force`, `Invoke-Expression`, `Set-ExecutionPolicy`, …) rely on the classifier (fail-closed)
- on macOS the per-user temp tree (`$TMPDIR`, the `/var/folders/…/T` confstr dir) is exempt from the system-directory floor: reads allow at zero cost, writes adjudicate as ordinary outside-project writes (classifier). The exemption anchors to the runtime-resolved confstr family — a hand-set `TMPDIR` lifts nothing — and `/var/tmp` (POSIX shared temp) stays denied; symlink spellings whose real form escapes the temp tree still hit S1
- AGENTS.md is not passed to the classifier as downweighted intent evidence (Claude Code does this)
- parallel gray-zone calls are adjudicated serially
- self-reflection means the session model adjudicates — point `--auto-mode-model` at a lighter model if verdict latency/cost matters (open question tracked in the issue tracker)
- `denyPaths` bash extraction is token-level ([ADR-0002](docs/adr/0002-deny-paths-deterministic-ask.md)): command substitution, base64-embedded paths and external script contents produce no hit signal — those calls fall back to the classifier's existence-hint vigilance. MCP and custom tools bypass the extractor entirely (their gray-zone adjudication still carries the hint). Path normalization is base-tier only (ADR-0002): a nonexistent target written through a symlinked directory rebuilds no real form and produces no hit — that indirection falls to the hint vigilance too (the ancestor-rebuilding tier applies to the self-protection layer and the sensitivity floor, not denyPaths). Honest framing, same as the self-protection substring precedent: the deterministic layer is obfuscatable, which is exactly why a hit routes to *you* rather than silently deciding
- `denyPaths` bash tokens contain no spaces: a *declared* path containing spaces cannot be spelled in a bash command in a way the extractor sees — `cat "/path with space/x"` splits into two tokens and never hits (file tools still hit, their path is not tokenized). A glob covering the final segment of a base (`cat /proj/pers*` against `denyPaths: ["/proj/personal"]`) also misses — the base's own name never appears literally. A recursive search issued from a shell misses in both spellings — no path argument (defaults to the cwd, e.g. a bare `rg foo`) or a parent-directory argument (`rg foo <parent-of-a-declared-path>`): an argument-less command contributes no token at all and bash tokens otherwise compare one-directionally, while the file tools' bidirectional subtree compare covers the same shapes issued through `grep`/`find`/`ls`. All three holes fall back to the classifier's existence hint, alongside substitution/base64 above
- self-protection bash matching is substring regex — obfuscatable; the tamper-detection backstop catches within-session bypasses, but a cross-session baseline (hash + change confirmation at startup, incl. upgrade UX) is phase 2 per [ADR-0001](docs/adr/0001-self-protection-layer.md)
- dev checkouts (running the extension from a repo, not `<agentDir>/extensions/`) are not self-protected — the installed copy the *next* normal session loads is only covered by its own sessions' gate

**verdict is not a sandbox.** It runs inside the pi process and adjudicates tool calls; it does not contain malicious code, protect against a compromised process, or guard manual `!` shell escapes. For isolation, use an OS-level sandbox.

The name: the three-state **verdict** is the core concept. The UX keeps `/automode` — the mode concept traces back to Claude Code's auto mode, which this project borrows its transcript design from.

## Development

```bash
bun install
bun run typecheck
bun test          # offline stub tests: self-protection, tamper detection, deny floor, user rules, denyPaths, bypass regression, classifier retry, commands, toggle shortcut
```

Issue tracker and decision records live in the GitHub issues ("map" issue #1 indexes them).

## License

[MIT](LICENSE)
