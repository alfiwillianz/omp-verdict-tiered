# omp-verdict-tiered

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![omp extension](https://img.shields.io/badge/omp-extension-blueviolet)](https://omp.sh)

**A minimal permission gate for [omp](https://omp.sh) (oh-my-pi), inspired by Claude Code's auto mode: every tool call gets checked before it runs — allow, deny, or ask you first.**

> **Fork notice.** This is `omp-verdict-tiered`, a fork of [jesset/pi-verdict](https://github.com/jesset/pi-verdict) by **Jesset**, ported to run on **omp only**. The original project targets [pi](https://pi.dev); all credit for the design, the rule floor, the self-protection layer, and the research behind them belongs to the original author. See [Attribution](#attribution).

- Built-in danger rules and your own allow/deny rules settle the clear cases first, at zero latency
- Everything else goes to a model classifier that sees the conversation context
- Optional tiered adjudication: a local ONNX model triages shell commands before any network call
- Any uncertainty or failure fails closed; nothing ever runs silently
- Self-protection: the gate guards itself against snooping and tampering

## The problem

omp ships with no per-call permission prompt — every tool call executes with the permissions of the omp process. This extension adds the missing gate: a model decides whether each call should run, based on the conversation context and your intent.

## Why three states

**A verdict is an adjudication, not a switch.** Most classifiers in this space output a binary allow/block. Three states matter: `ask` routes genuinely ambiguous actions to a human (and degrades to `deny` in non-interactive sessions), so "not sure" never silently becomes "go ahead" — the goal is safe automation, not maximum automation: both approval fatigue and silent unsafe execution lose.

## Design principles

- **Fail closed** — uncertainty produces friction, never permission.
- **Deterministic floor before AI** — hard denies are never overridden by the classifier or user allow rules.
- **Semantics over syntax** — the classifier judges what an action *does*, not how long it is.
- **Judgments, not proofs** — a classifier `allow` is an informed opinion; the floor exists because that is all it is.
- **Minimal trusted input** — no tool results in the transcript, zero path plaintext to the classifier ([ADR-0002](docs/adr/0002-deny-paths-deterministic-ask.md)).
- **Canonical identity** — lexical + realpath dual-form matching; a workspace-*looking* path is not trusted as one.
- **The gate guards itself** — self-protection that no configuration can disable ([ADR-0001](docs/adr/0001-self-protection-layer.md)).
- **A permission gate, not a sandbox** — stack OS isolation on top; this gate never replaces it.

Full statement in [docs/security-principles.md](docs/security-principles.md).

## Quick start

```bash
git clone git@github.com:alfiwillianz/omp-verdict-tiered.git
cd omp-verdict-tiered
bun install

# install the package directory into omp (loaded in place)
omp plugin install "$PWD"

# or try it for one invocation
omp --extension "$PWD"
```

Full guide — install forms, the Tier 1 bundle, updating, troubleshooting: **[docs/installation.md](docs/installation.md)**.

Requires omp ≥ 18.1 and Bun. Works in interactive and non-interactive (`-p`/json/rpc) sessions; in non-interactive modes `ask` degrades to `deny`.

### Host layout

| | omp |
|---|---|
| install | `omp plugin install "$PWD"` from a clone ([guide](docs/installation.md)) |
| plugin copy | `~/.omp/plugins/node_modules/omp-verdict-tiered/` (omp ≥ 18.1; ≤18.0: under `agent/`) |
| user rules | `~/.omp/agent/config/omp-verdict.json` |
| credential store (S0 hard deny) | `~/.omp/agent/agent.db`, `~/.omp/agent/secrets.yml` |
| extension discovery | `~/.omp/agent/extensions/`, `<project>/.omp/extensions/` |

- `/automode` — show current status: on/off
- `/automode on`
- `/automode off`
- `ctrl+shift+a` — toggle the master switch silently (the always-on footer is the only feedback; rebind or disable via `toggleShortcut`)
- footer always shows `auto mode on` (green) / `auto mode off` (yellow)

| Option | Default | Description |
|---|---|---|
| `--auto-mode` / `--no-auto-mode` | on | master switch |
| `--auto-mode-model provider/id[:thinking]` | session model | classifier model, or `@role` (e.g. `@smol`) |
| `--auto-mode-debug` | off | full verdict notifications |
| `OMP_AUTO_MODE_MODEL` | — | env form of the model flag |
| `OMP_AUTO_MODE_DEBUG=1` | off | env form of debug (flag wins) |

### User rules (`~/.omp/agent/config/omp-verdict.json`)

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
    "ask",
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
      "modelPath": "~/.cache/omp/lancet-nano",
      "riskyThreshold": 0.85,
      "riskyAction": "ask"
    },
    "tier2Role": "adjudicator",
    "tier2TimeoutMs": 5000
  }
}
```

- `allow`/`deny` are JS regex arrays; **`deny` wins over `allow`**, both beat the classifier
- `denyPaths` are plain paths you declare **protected** — touches trigger a terminal ask you adjudicate (non-interactive → deny); the classifier never learns the paths themselves, only that they exist. `grep`/`glob`/`find`/`ast_grep` compare their whole **search scope**: an omitted `path` (omp's default: the workspace root) or a parent directory of a declared path triggers the ask as well. A fresh install pre-fills a **starter list** (`~/.ssh/`, `~/.gnupg/`, `~/.mc`, shell rc/profile files)
- `ignoreTools` names uncovered tools (`todo`, `ask`, MCP/custom tools) that skip adjudication — **allow with zero model calls**; entries naming covered tools (`bash`/`read`/`write`/`edit`/`grep`/`glob`/`find`/`ast_edit`/`ast_grep`) are inert: those stay governed by the deny floor and your allow/deny rules, and the self-protection layer always runs first
- `builtinDenyFloor: false` turns off the built-in danger/path floor (your risk; the self-protection layer below always stays on)
- `classifierModel` pins the classifier model, e.g. `"zai/glm-5.3-flash:low"` (thinking suffix supported; default: session model with thinking off). It also accepts an omp role alias (`"@smol"`, `"@slow"`, any configured role)
- `semanticAdjudication` opts into **tiered adjudication** ([ADR-0009](docs/adr/0009-tiered-semantic-adjudication.md)): shell commands are triaged locally first by **Tier 1** — LANCET-Nano, a 111 MB INT8 ONNX model on CPU, no network ([setup](#tier-1-lancet-nano-setup)). `not_flagged` allows immediately (~10 ms), `risky` asks (or denies with `riskyAction: "block"`), `review`/oversized input escalates to **Tier 2**, a model resolved from omp's model facade (`tier2Role`: `"adjudicator"` → `"smol"` → session model) that sees the tool call, the conversation and Tier 1's band. Tier 2 `allow` passes; `ask`/`deny` both go to you; any failure (no model, network, 5 s timeout, bad JSON) fails closed to ask (headless → deny). Omit the block and behavior is exactly 0.15's single-classifier path
- `audit: true` records every **gray-zone adjudication** (the full transcript sent to the classifier, its raw response, the parsed verdict) as JSONL under `~/.omp/agent/verdicts/<sessionId>.jsonl` — one file per session, the 20 most recent kept. Interactive asks also record your answer (`userAnswer` ground truth, written after the confirm resolves), and protected-path asks are recorded too; rule allow/deny stays unaudited. Local-only and full-fidelity (protected-path plaintext may appear — it never leaves your machine); secret-shaped text is redacted on append (`<redacted:type#fingerprint>`, deterministic so cross-record tracing survives — `auditRedactSecrets: false` opts out; [ADR-0007](docs/adr/0007-audit-secret-redaction.md))
- `notifyAllows: true` notifies on every **classifier allow** (reason + action line); default `false` keeps passes silent. Mechanical passes (your own allow rules, protected-path confirms) never notify
- `classifierMinConfidence` (optional, [ADR-0004](docs/adr/0004-classifier-fallback-cascade.md)) sets the **confidence floor**: a native-judgment verdict below it is demoted — cascaded to `classifierFallbackModel` if set (`enforce`, the default = the second layer adjudicates; a demoted **deny or ask** can never be auto-relaxed to an allow; `shadow` = records its opinion only and you are asked), otherwise asked of you directly. At/above the floor the first layer is autonomous. The floor applies to judgment-kind models only (protocol-native confidence) — with a chat model it is inert
- `classifierFallbackModel` / `classifierFallbackMode` control the second layer ([ADR-0004](docs/adr/0004-classifier-fallback-cascade.md))

No built-in allowlist — every "always allow" claim is yours ([why](docs/configuration.md#why-no-built-in-allowlist)). Full reference: [docs/configuration.md](docs/configuration.md).

### Tier 1 Lancet-Nano setup

```bash
bun run setup:lancet            # ~/.cache/omp/lancet-nano (pinned v0.4.3, hash-verified)
bun run setup:lancet --check    # verify an existing bundle, no network
bun run setup:lancet --dir DIR  # custom location (must match tier1Lancet.modelPath)
```

The setup verifies `export.json` against the release manifest digest, every model file against `export.json`, and the tokenizer against the reference implementation. The runtime repeats the file check on every load — a tampered or missing bundle never produces a `not_flagged`; Tier 1 escalates with a one-shot warning. With the block configured but the bundle absent, shell commands go to Tier 2.

### Classifier models on omp

The classifier runs on omp's **chat completion** path (`completeSimple`) with the session credential resolver, so OAuth refresh and key rotation stay host-owned. A **judgment-kind** model (`typesafe/jev-latest` and the other `*-decisions` / `systemone` APIs) answers through omp's typed-judgment client instead: one structured call returning a choice, probabilities, and a confidence — which is what the confidence floor gates on.

```json
{ "classifierModel": "typesafe/jev-latest" }
```

- **TypeSafe direct**: `export TYPESAFE_API_KEY=apikey_...` (self-service at console.typesafe.ai)
- **OpenRouter**: `/login openrouter` inside omp, or `export OPENROUTER_API_KEY=sk-or-v1...`
- also served on Cloudflare Workers AI and OpenAI Decisions with each provider's login

Notes:

- Verdicts from judgment models keep the historical `jev:` probability line; chat models render `classifier:`
- A thinking suffix on a judgment model warns once and is dropped (no reasoning to configure)
- Chat models are addressed as `provider/id`, a bare id, or a role alias (`@smol`, `@slow`, any configured role)

### Self-protection (the gate guards itself — [ADR-0001](docs/adr/0001-self-protection-layer.md))

The gate's own files — the config and the installed extension copy — are **user-editable only**: writes from inside the gate hard-deny (reads pass); your editor never passes through the gate, the sudoers/visudo precedent.

- **Not disableable by any config** — `builtinDenyFloor: false` and user `allow` rules cannot touch this layer
- **Tamper detection** as the backstop: watched files are snapshotted at `session_start` and re-verified before every verdict — a changed extension copy is auto-restored and the session goes fail-closed; a changed config gets one explicit keep/restore confirm when a UI is available (headless auto-restores; [ADR-0001](docs/adr/0001-self-protection-layer.md) for the differential-disposal rationale)

---

## Pipeline

```
tool_call
  │
  ├─ 0. Self-protection layer (ADR-0001; not disableable by any config)
  │     ├─ write/edit/ast_edit/bash touching the gate's own files → deny; reads pass
  │     └─ tamper detection: re-verify before every verdict →
  │         auto-restore + fail-closed, or one keep/restore confirm
  │
  ├─ 1. Rule layer (deterministic, zero latency)
  │     ├─ built-in deny floor: bash danger regexes + path sensitivity S0–S5
  │     ├─ your rules: user deny beats user allow
  │     ├─ denyPaths (ADR-0002): protected paths → terminal ask,
  │     │   before user allow; classifier sees an existence hint only
  │     ├─ ignoreTools: your declared uncovered tools → allow, zero model calls
  │     └─ no built-in allowlist on your surfaces — every "always allow"
  │       claim is yours to make
  │
  ├─ 2. Gray zone → semantic adjudication
  │     ├─ default: one classifier — a judgment model (choice + probabilities +
  │     │   confidence; tag-free reason, full contract line in the audit
  │     │   rawResponse) or, on the chat path (session-model self-reflection),
  │     │   <verdict>…</verdict> prefix-anchored free text
  │     └─ tiered (ADR-0009, opt-in semanticAdjudication block):
  │           shell → Tier 1 LANCET-Nano (local, ~10 ms):
  │             not_flagged → allow; risky → ask (or deny); review/long → Tier 2
  │           all tools → Tier 2 adjudicator (role → smol → session):
  │             strict JSON; allow passes, ask/deny → human; failure → ask
  │
  └─ 3. Three-state adjudication
        ├─ allow → pass
        ├─ deny  → block, reason returned to the agent
        └─ ask   → human confirm; non-interactive modes degrade to deny

```

**fail-closed**: classifier exception / timeout (25s) / contract violation → deny; in tiered mode, Tier 2 failure (no model, network, 5s timeout, bad JSON) → ask (headless → deny). Never silently allow.

## Status & limitations

- no built-in allowlist on user surfaces by design (see the [bypass writeup](research/rule-layer-security-audit.md)); with an empty `allow` config most commands go to the classifier — point `--auto-mode-model` at a fast model if per-call latency matters
- the path sensitivity floor applies to file tools only: bash command strings are matched by the danger regexes alone, so e.g. `cat ~/.ssh/id_rsa` goes to the classifier rather than the deterministic S0 deny (the file-tool spelling `read ~/.ssh/id_rsa` does deny)
- on Windows the built-in floor covers bash-shaped patterns only — PowerShell-native dangerous commands (`Remove-Item -Recurse -Force`, `Invoke-Expression`, `Set-ExecutionPolicy`, …) rely on the classifier (fail-closed)
- on macOS the per-user temp tree (`$TMPDIR`, the `/var/folders/…/T` confstr dir) is exempt from the system-directory floor: reads allow at zero cost, writes adjudicate as ordinary outside-project writes (classifier). The exemption anchors to the runtime-resolved confstr family — a hand-set `TMPDIR` lifts nothing — and `/var/tmp` (POSIX shared temp) stays denied; symlink spellings whose real form escapes the temp tree still hit S1
- `AGENTS.md` is not passed to the classifier as downweighted intent evidence (Claude Code does this)
- parallel gray-zone calls are adjudicated serially
- self-reflection means the session model adjudicates — point `--auto-mode-model` at a lighter model if verdict latency/cost matters
- `denyPaths` bash extraction is token-level ([ADR-0002](docs/adr/0002-deny-paths-deterministic-ask.md)): command substitution, base64-embedded paths and external script contents produce no hit signal — those calls fall back to the classifier's existence-hint vigilance. MCP and custom tools bypass the extractor entirely (their gray-zone adjudication still carries the hint). Path normalization is base-tier only: a nonexistent target written through a symlinked directory rebuilds no real form and produces no hit
- `denyPaths` bash tokens contain no spaces: a *declared* path containing spaces cannot be spelled in a bash command in a way the extractor sees. A recursive search issued from a shell misses in both spellings (no path argument, or a parent-directory argument); the file tools' bidirectional comparison covers those cases
- self-protection bash matching is substring regex — obfuscatable; the tamper-detection backstop catches within-session bypasses, but a cross-session baseline is phase 2 per [ADR-0001](docs/adr/0001-self-protection-layer.md)
- dev checkouts (running the extension from a repo) are not self-protected — the installed copy the *next* normal session loads is only covered by its own sessions' gate
- the classifier is one model call per gray-zone decision; `classifierMinConfidence` + `classifierFallbackModel` add a second opinion at the cost of a second call
- **omp-only.** This fork dropped the pi host: pi's `classify()` protocol, `getModelForRole()`, the codemode nested-call policy, and the headless subagent-artifacts exemption do not exist on omp and are not implemented here

**The gate is not a sandbox.** It runs inside the omp process and adjudicates tool calls; it does not contain malicious code, protect against a compromised process, or guard manual `!` shell escapes. For isolation, use an OS-level sandbox.

The name: the three-state **verdict** is the core concept. The UX keeps `/automode` — the mode concept traces back to Claude Code's auto mode, which this project borrows its transcript design from.

## Development

```bash
bun install
bun run typecheck
bun test          # offline stub suite: self-protection, tamper detection, deny floor, user rules, denyPaths, bypass regression, classifier retry, tiered pipeline, commands, toggle shortcut
```

Issue tracker and decision records live in the GitHub issues.

## Attribution

This fork exists because of **[Jesset](https://github.com/jesset)**'s original work on [pi-verdict](https://github.com/jesset/pi-verdict) (MIT). The rule floor, the denyPaths design, the self-protection layer, the classifier transcript contract, and the research notes under `research/` are theirs. This fork's changes are the omp port (host API adaptation, the judgment/chat classifier seams, omp tool names and credential paths) and the tiered adjudication work.

If you are on pi rather than omp, use the upstream project.

## License

[MIT](LICENSE) — original copyright © 2026 Jesset; fork modifications under the same license.
