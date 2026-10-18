# Configuration Reference

Everything the gate reads from disk lives in `<agentDir>/config/pi-verdict.json` (first run generates a template there; `PI_CODING_AGENT_DIR` overrides the location). This page is the full reference; the README keeps a quick-start subset.

## User rules

```json
{
  "allow": ["^ls\\b", "^git (status|log|diff)\\b"],
  "deny":  ["rm ", "docker ", "^/etc/"],
  "denyPaths": [
    "~/.ssh/",
    "~/.profile",
    "~/.gnupg",
    "~/.mc",
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

- `allow`/`deny` are JS regex arrays; **`deny` wins over `allow`**, both beat the classifier. Match targets: bash/powershell = the full command string; file tools = the resolved absolute path (`grep`/`find`/`ls` with an omitted `path` resolve to the cwd — pi's documented default); other tools (e.g. MCP) are not covered by rules and land in the gray zone.
- `denyPaths` are plain paths (not regexes) you declare **protected**: any tool call touching them — file tools via their path (scope tools via their whole search scope: omitted path/cwd, or a parent directory of a declaration), bash via path tokens extracted from the command string — triggers a **terminal ask** you adjudicate (non-interactive sessions degrade to deny). Not affected by `builtinDenyFloor: false`. The first-run template pre-fills a starter list (`~/.ssh/`, `~/.gnupg`, `~/.mc`, shell rc/profile files), active from the first session after the initial run — a pre-filled user declaration you can edit or empty; existing configs are never rewritten.
  The classifier only ever learns that protected paths *exist*; the paths themselves never leave your machine, and a matched path shows **only** in the local confirm dialog.
- `ignoreTools` is a plain list of tool names **outside** the command/file families (`todo`, `web_search`, MCP/custom tools, …) that skip adjudication entirely — verdict allow, zero model calls. Entries naming covered tools (`bash`/`read`/`write`/`edit`/`grep`/`find`/`ls`/`powershell`) are inert: those stay governed by the deny floor and your allow/deny rules, and the self-protection layer runs before any passthrough — the list can never weaken either. The first-run template pre-fills a starter list of side-effect-free tools (`todo`, `ask_user_question`, `memory_write`, `memory_search` — from the project's production audit, [research](../research/classifier-cascade-production-audit-en.md); `memory_forget` is deliberately absent: it deletes) — a recommendation, not a built-in passthrough: edit or empty it freely; existing configs are never rewritten. Caveat: an exempted tool that touches paths also drops the classifier's `denyPaths` existence-hint vigilance (uncovered tools never hit the path extractor). MCP tool names are normalized before any matching — every character outside `[A-Za-z0-9_]` becomes `_` (`mcp__dev-radius__x` → `mcp__dev_radius__x`) — so exemption entries must use the normalized form (see the README's [codemode & MCP](../README.md#pi-099-codemode--mcp-indirect-calls-are-still-gated) section).
- `builtinDenyFloor: false` turns the built-in danger/path floor off entirely (risk accepted by you; the classifier and your rules remain — the self-protection layer always stays on). macOS nuance (#83): the per-user temp tree (the runtime-resolved `$TMPDIR` confstr dir) is exempt from the system-directory grading — reads allow, writes grade as ordinary outside-project writes; a hand-set `TMPDIR` lifts nothing (confstr-family guard), `/var/tmp` stays denied, and `authorized_keys` staged under the temp tree still denies (basename family).
- `classifierModel: "provider/model-id"` sets the classifier model (e.g. a fast flash-class model); precedence is flag > env > config > session model (self-reflection); an invalid value falls back to the session model with a one-time warning.
- The spec accepts pi's native `--model` thinking suffix: `"zai/glm-5.3-flash:low"` sets classifier thinking to effort low (default without suffix: thinking explicitly off).
- `classifierModel: "typesafe/jev-latest"` opts into the **native jev classifier** (pi ≥ 0.99, [ADR-0005](adr/0005-native-classifier-migration.md)): one structured `classify()` call per gray-zone verdict, resolved through pi's classifier catalog (`findOfType`) with request-time auth. Transports are catalog entries — TypeSafe direct (`typesafe/jev-latest`, `TYPESAFE_API_KEY`, self-service at console.typesafe.ai; per-call cost shows $0 because its API does not report it), OpenRouter (`openrouter/~typesafe/jev-latest`, `openrouter/typesafe/jev-1.13` — `/login openrouter` or `OPENROUTER_API_KEY`), plus OpenCode Zen, Cloudflare Workers AI, and Vercel AI Gateway under each provider's login; llama.cpp chat models double as free local classifiers. The typed answer renders into the usual `<verdict>` text with probabilities and confidence (`jev:` prefix for System One, `classifier:` for other APIs), so timeouts and fail-closed semantics are unchanged. Same-id dual listings (llama.cpp chat + classifier) resolve to the native entry. Custom endpoints: override the provider's `baseUrl` in models.json (the 0.12 `PI_VERDICT_JEV_URL`/`PI_VERDICT_JEV_TRANSPORT` variables are gone — transport choice is the spec itself). Thinking suffixes are meaningless for classifier models — one warning per session, then ignored (the audit `thinking` field records `null`). Caveats ([ADR-0005](adr/0005-native-classifier-migration.md)): the denyPaths existence hint does not reach classifier-typed models (denyPaths themselves stay rule-enforced before the classifier); jev treats the transcript as data and "does not treat it as hostile by default" (TypeSafe docs), so adversarial transcript content can move its judgment; hosts without `classify()` (pi < 0.99, omp) cannot resolve the spec and fall back with a warning there.
- `toggleShortcut` rebinds the master-switch toggle key (`null` or empty disables it, not persisted).
- `audit: true` turns on the **verdict audit log** (#54): every gray-zone adjudication appends one self-contained JSONL record to `<agentDir>/verdicts/<sessionId>.jsonl` — timestamp, session id, cwd, model id, tool name + input, action line, thinking level, the full transcript sent, the raw response text, the parsed verdict + reason, source (`model`/`fail-closed`/`protected-path`), and the degraded flag. Rule-layer allow/deny decisions are never recorded; **protected-path asks are recorded** (#62) — their confirms are user adjudications that grade the denyPaths rules (the record carries the matched path in `detail`). Interactive asks (classifier and protected-path alike) record **ground truth** (#62): the record is written after the confirm resolves, carrying `userAnswer` (`allowed`/`declined`) and `answeredAt` (`ts` stays adjudication time); a non-interactive degraded ask records immediately as its effective deny, without the answer fields. Accepted trade-off of the deferred write: closing pi while a confirm dialog is open loses that ask record (one record per verdict, append-only — no pre-write/rewrite). Records of triggered calls carry an optional `fallback` sub-object when the second layer is configured (#63 — see above for its reading discipline). Retention keeps the 20 most recent session files (pruned at session start). Full fidelity by design: records may contain protected-path plaintext — that stays inside your machine ([ADR-0002](adr/0002-deny-paths-deterministic-ask.md) boundary note), and the directory is denied to agent reads *and* writes (records contain untrusted raw model output, including fail-closed failures). Secret-shaped text (provider-prefixed tokens, `-u`/`Bearer`/assignment/query values) is redacted on append — see `auditRedactSecrets` below. The sink is fail-soft: a write failure never affects or delays a verdict — one warning, then silent for the rest of the session. Never an adjudication input: append-only, never read back into gate decisions. `/automode` shows `audit: on → <path>` while active. Off by default; no `verdicts/` directory is created unless a recordable adjudication happens with audit on.
- `auditRedactSecrets` (default `true`, [ADR-0007](adr/0007-audit-secret-redaction.md)) — redacts credential-shaped text from audit records **before append**: known provider token shapes (`sk-…`, `pk-…`, `ghp_…`, `AKIA…`, `xox…`, `AIza…`, JWTs, …) plus context-guided values (the `-u user:pass` password segment, URL userinfo, `*_KEY|*_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS` and bare `TOKEN|APIKEY|SECRET` assignments, `Bearer` tokens, credential query params). Each match lands as `<redacted:type#sha256-8hex>` — the unsalted fingerprint is deterministic, so the same secret stays traceable across records (clustering survives; the plaintext never lands). Scope is the audit face only: the classifier still sees the real command (a secret-bearing command is itself an adjudication signal), and pi's native session transcripts are untouched by this key. A redactor failure fails open — record integrity over hygiene; the worst case equals redaction being off. `false` is the explicit keep-raw escape hatch (config-only, new-session semantics); non-boolean values warn once via the session-start channel and redaction stays on.
- `notifyAllows: true` surfaces every **classifier allow** as an info notification (verdict reason + action line) — the gate's judgment calls become visible, e.g. jev's probability breakdown (`jev: allow 66% (confidence 49%; ask 33%, deny 1%)`). Default `false`: notifications stay limited to what needs your attention (deny/ask/warnings) and passes stay silent. Mechanical passes never notify under this option — allow-rule hits are echoes of your own declarations, and a protected-path confirm's visibility is the dialog itself; complete records live in the verdict audit log instead. Orthogonal to the debug switch: with both on the classifier-allow notification appears exactly once. Config-only, new-session semantics.
- `classifierMinConfidence: 0–100` sets the **confidence floor** — the minimum confidence at which the first layer may adjudicate on its own ([ADR-0004](adr/0004-classifier-fallback-cascade.md), #67). A native-classifier verdict with confidence strictly below the floor is **demoted**: the call cascades to the second layer if `classifierFallbackModel` is configured, otherwise it is asked of you directly (non-interactive degrades to deny; any verdict — allow, ask, deny — demotes). At or above the floor the first layer is fully autonomous and nothing extra runs. The floor works standalone — it does not require a second layer. The rendered confidence floors rather than rounds (a true 49.6% renders 49% and cannot slip past a 50 floor), and confidence is hard-required by the classify() contract (drift fails closed). The floor applies to native classifier models only, keyed on the presence of protocol-native confidence (ADR-0005): a chat/LLM classifier never demotes — an LLM reason that happens to match the historical jev confidence format included — and a one-time neutral warning tells you when the effective classifier (configured or self-reflected) is a chat model. `null` (the default) = off; invalid values skip into the one-shot warning channel. The old key name `classifierFallbackConfidence` (0.10.0) warns as renamed and is ignored.
- `classifierFallbackModel: "provider/model-id"` adds an opt-in **second-layer classifier** consulted on exactly two occasions: a **demotion** (confidence below `classifierMinConfidence`) and a **fail-closed** first layer. It gets its own 15s-per-attempt budget (the two-tier retry can double it, mirroring the first layer's per-attempt 25s) and, unlike a native first layer, receives the denyPaths existence hint. Resolution is config-only and never falls back to the session model; an unresolvable model warns once per session (a jev spec gets wording that names the two real causes: a host without native classifier support, or a missing credential for the transport). High-confidence asks no longer consult it — a confident ask goes straight to you. A native-classifier second layer adjudicates without a confidence gate of its own — the floor is a first-layer rule, so the cascade never recurses.
- `classifierFallbackMode` (default `"enforce"` since 0.12.0) — `"shadow"` keeps the second layer **recording its opinion only** (audit `fallback` sub-object + `/automode` counters: `triggered · agreed · would-overrule · would-rescue-allow · errored`) and never changes any verdict: a demoted call is asked of you, a fail-closed deny stands. `"enforce"` — the second layer **adjudicates de novo**, with one carve-out family (#71): a demoted first-layer **deny or ask** that the second layer would allow is asked of you instead (never an automatic allow; headless degrades to deny). A **fail-closed** first layer keeps full de novo authority — it emitted no negative verdict, so a fallback allow is a first ruling and stands automatically. A failed or unresolvable fallback on a cascaded call falls to you as well — the tier that was to adjudicate is down (headless → deny, one-time warning). Audit reading: the top level keeps **first-layer semantics** (records of non-interactive asks — native, demoted, escalated — carry their effective deny, per the standing convention), `demoted: true` marks floor fires, and the applied verdict lives in `fallback.effective` (enforce rows, failure rows carry the `"ask"` you got) — except enforced **fail-closed rescues** (#71), whose top-level verdict is the applied ruling (a fail-closed layer's deny was only the default, never a judgment). An explicit `"shadow"` is the observation mode: flip to `"enforce"` (or drop the key) when the shadow data earns the layer your trust ([criteria](adr/0004-classifier-fallback-cascade.md)); config-only, new-session semantics.
- `semanticAdjudication` (optional, [ADR-0009](adr/0009-tiered-semantic-adjudication.md)) — turns the gray zone into a two-tier pipeline: local LANCET-Nano triage of shell commands (Tier 1) and a model-registry adjudicator for what it escalates (Tier 2). Full reference and bundle setup: [Tiered semantic adjudication](#tiered-semantic-adjudication-adr-0009). Omit the block to keep the single-classifier path unchanged.
- `codemodeNestedCalls` (default `"gate"`, [ADR-0006](adr/0006-codemode-nested-calls-policy.md)) — how nested calls (issued by codemode scripts, `parentToolCallId` set) adjudicate. `"gate"`: identically to direct calls, every layer. `"rules-only"`: nested calls keep every deterministic layer — self-protection, the built-in deny floor, your allow/deny rules, denyPaths with its terminal ask — and skip only the classifier + confidence cascade; the gray zone passes (audited as `source: rule` + `policy: rules-only` when audit is on). The trade-off, stated rather than papered over: rule-passing actions the classifier would have caught now pass — e.g. a nested `bash head ~/.ssh/config` passes unless `~/.ssh` is a denyPaths declaration (bash token extraction then asks). Motivation: serial gray-zone adjudication of script batches — measured ~350ms/call, so 50 nested calls ≈ 17.5s and the 256-call cap ≈ 90s of pure gating latency. Direct calls are unaffected in both modes; audit records gain `toolCallId`/`parentToolCallId` attribution either way.

## Tiered semantic adjudication ([ADR-0009](adr/0009-tiered-semantic-adjudication.md))

The optional `semanticAdjudication` block replaces the gray-zone classifier call with two tiers. **Omitting the block keeps the single-classifier path byte-identical** — the block is the switch, not a boolean inside it.

```json
{
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

- **`tier1Lancet`** — local triage of shell commands (`bash`, `powershell`, `cmd`; pi's `exec` is treated as bash). The model is [LANCET-Nano](https://huggingface.co/fingerthief/lancet-nano) v0.4.3: a CodeT5+ 220M encoder exported as a 111 MB INT8 ONNX encoder plus a float head, run on CPU through `onnxruntime-node` with no network access.
  - `not_flagged` → **allow immediately** (measured ~10 ms median warm on CPU).
  - `risky` → **ask** by default; `"riskyAction": "block"` makes it a deterministic **deny**.
  - `review`, or any abstention (more than 512 tokens, more than 8,192 bytes, unsupported shell, tokenizer/inference failure, missing bundle) → escalate to Tier 2. A long command is **never truncated** — the truncated tail could hide the risky part.
  - `riskyThreshold` (0–1, default `0.85`) is a **calibrated probability**; it is mapped back onto the model's logit scale, so banding stays exact. The shipped model boundary is `0.9912`; lower values make Tier 1 escalate more often (fewer local allows), higher values make it decide more locally. `not_flagged` is not a safety guarantee — the deterministic floor still runs first, and Tier 2 only sees what Tier 1 escalates.
  - `enabled: false` skips Tier 1 entirely: shell commands go straight to Tier 2 and its payload carries no triage block.
  - `modelPath` is the verified bundle directory (`~` expanded). Install it with `bun run setup:lancet` (see below).
- **`tier2Role`** (default `"adjudicator"`) — the role looked up through the host registry: `getModelForRole(role)` → `"smol"` → the session model. pi 1.0.0 has no role API, so the session model is the effective fallback there; OMP hosts resolve the configured role first. Classifier-typed entries are skipped (Tier 2 needs a generative JSON answer), as are entries without configured auth. Resolution is lazy — a Tier 1 `not_flagged` call never resolves a model or emits its warning.
- **`tier2TimeoutMs`** (default `5000`, 100–60000) — the hard ceiling for one Tier 2 call, enforced with `Promise.race` even if the provider ignores abort signals. On expiry the call fails closed.
- **Tier 2 verdict mapping**: `allow` → allow; `ask` and `deny` both → **ask**. A model may not auto-deny at this tier — automatic denial belongs to Tier 1's `risky` band, and an ask costs one keypress while a wrong deny is invisible. Headless sessions degrade the ask to deny.
- **Fail-closed**: no resolved model, transport error, timeout, or unparseable/malformed JSON → ask (headless → deny), with `source: "fail-closed"` on the verdict and the audit record. The reason names the failure; it never silently allows.
- **Non-shell tools** (MCP/custom tools, file tools that reach the gray zone) bypass Tier 1 and go straight to Tier 2 with the session transcript.
- **Audit**: gray-zone records gain optional `tier1` (`band`, `pRisky`, `riskLogit`, `reason`, `durationMs`) and `tier2` (`model`, `role`, `verdict`, `reason`, `durationMs`, `error`) sub-objects. Top-level `source` stays `"model"` for tier-produced verdicts and `"fail-closed"` for Tier 2 failures, so existing corpus queries keep working.
- **Single-file installs**: the tiered runtime lives under `src/classifiers/`. A bare copied `pi-verdict.ts` cannot load it; the gate then falls back to the legacy classifier path and stamps `tieredFallback` on the audit record — it never silently allows.

### Installing the Tier 1 bundle

```bash
bun run setup:lancet            # ~/.cache/pi/lancet-nano (pinned v0.4.3)
bun run setup:lancet --check    # verify an existing bundle, no network
bun run setup:lancet --dir DIR  # custom location (must match tier1Lancet.modelPath)
bun run setup:lancet --force    # re-download even when the bundle verifies
```

Integrity is checked twice: `export.json` against the digest published with the release, then every model file against the digests recorded in `export.json`; the tokenizer is cross-checked against `@xenova/transformers`. The runtime repeats the per-file check on every load, so a bundle tampered with after setup refuses to load (Tier 1 escalates with a one-shot warning). A missing bundle is not an error state — shell commands simply go to Tier 2.

Built-in (keyless) behaviors worth knowing about, both statements about the gate's relationship to pi's own surfaces rather than user policy: **headless subagent-artifacts writes pass** ([ADR-0008](adr/0008-agentdir-sessions-write-exemption.md)) — a no-UI session's `write`/`edit` under `<agentDir>/sessions/**/subagent-artifacts/` (where pi's subagent tooling writes its working artifacts) returns a deterministic allow; interactive sessions keep normal adjudication (the gate never waives an ask a human could perform), your `deny` rules and denyPaths declarations still outrank it, reads and bash are untouched, and a symlink resolving outside earns no exemption. **verdicts reads are denied** (#54, see `audit` above) — records contain untrusted raw model output.

## Recipes: trimming predictable asks with `allow`

The audit's ground truth ([research](../research/verdicts-ask-friction-audit-2026-10.md)): across 10 production sessions, 71 asked calls drew **70 approvals and 1 decline** — and the one decline was a denyPaths rule, not the classifier. Model-layer asks that repeat a stable shape are friction, not protection; the two shapes below (release workflow, read-only CI inspection) accounted for roughly two thirds of all asks. Since the built-in layer deliberately ships no allowlist, these are *your* declarations to make — adopt selectively, and keep `audit` on so corpus data keeps flowing:

```jsonc
"allow": [
  // read-only CI/registry inspection — zero shared state, all observed allows
  "^gh run (view|list|watch)\\b",
  "^gh (release view|issue view|pr view|pr checks)\\b",
  "^npm view\\b",
  "^gh api .*\\?.*--method GET",   // careful: gh api defaults to GET; tighten to your org if you use it

  // release workflow — shared state, but YOUR repo: adopt if you release through the agent
  "^git push(?!.*--force)\\b",     // force-push stays classifier-adjudicated (the floor denies it)
  "^gh pr (create|merge)\\b",
  "^git (branch -d|-D|push origin --delete)\\b"
]
```

Notes: user `allow` entries are full-command regexes for bash (and resolved absolute paths for file tools), tested after your `deny` list and denyPaths — a deny always wins. They cannot weaken the deny floor (danger regexes, path sensitivity) or the self-protection layer. If you want the confirm without the classifier round-trip instead, leave them out — an ask is one keypress; an allow rule is zero.

## Why no built-in allowlist?

Bypass testing of the rule layer ([writeup](../research/rule-layer-security-audit.md)) showed that allowlist robustness is very limited. On *your* surfaces (commands you run, paths you own) the built-in layer only makes **deny** claims (the sound direction); allow claims are yours. The one built-in allow is a statement about the gate's relationship to pi's own runtime surface — the sessions/ write exemption above — which your `deny` rules and denyPaths declarations outrank.

## Host notes (pi and oh-my-pi)

pi-verdict 0.13+ requires **pi ≥ 0.99** (native classifier support, `peerDependencies >=0.99.0`). Older hosts — pi < 0.99 and omp (whose kernel pi 0.99 adoption is pending) — keep using **0.12.x** from npm; old hosts run old extensions ([ADR-0005](adr/0005-native-classifier-migration.md)). This repository is the `pi-verdict-tiered` fork and is not published to npm; install it from a clone per [installation.md](installation.md). The extension self-anchors to whichever agent tree it is installed in. On a dual-install machine the gate follows the extension copy's own location — the mere presence of `~/.omp` never redirects a pi run (and vice versa).

Implementation details worth knowing if you hack on the extension:

- The completion seam binds `ModelRegistry.complete` when present (pi) and falls back to the pi-ai compat module (`@earendil-works/pi-ai/compat`) otherwise — the omp-era discipline, retained for chat-path classifiers. The native classify seam (`ModelRegistry.classify`) has no fallback: a host without it resolves no native layer, and a native spec stays unresolvable (fail-closed / fallback-with-warning).
- Thinking control is sent in both hosts' native dialects (`thinkingEnabled`/`effort` for pi, `reasoning`/`disableReasoning` for omp); each host reads its own fields and ignores the other's.
- omp installs npm plugins under `plugins/node_modules/<pkg>/` in its config root — under `<agentDir>/` up to omp 18.0, a sibling of `agent/` since omp 18.1; both layouts get the same whole-package-dir self-protection as the pi forms (ADR-0001). The user-rules config always lives under `<agentDir>/config/` on both layouts.
