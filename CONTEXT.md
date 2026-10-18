# CONTEXT

Domain glossary for this project. Terms only — no implementation detail, no decision records (those live in `docs/adr/`).

## Terms

### Auto Mode

The gate's core mode: tool-call permission is neither approved by hand each time nor left fully open (omp's default), but decided automatically by the **rule layer + model classifier**. Semantically aligned with Claude Code's auto mode, inverted: Claude Code prompts by default and the classifier auto-approves; omp allows by default and the classifier auto-blocks. Naming split: the product and its persistent artifacts (package, entry file, config file) use the product name `omp-verdict`; runtime interfaces (CLI flags, the `/automode` command, env vars) use the `auto-mode` prefix.

### Master switch

The gate's enabled state: session memory, on by default. Three surfaces — CLI flag (cross-session), `/automode` command (in-session), toggle shortcut (in-session, user-configurable and disableable) — are **semantically equivalent**: one state, different entry points, no extra rules per surface (no in-flight restriction, no confirmation dialog, no persistence write-back). Only the feedback differs: the command notifies, the shortcut is silent, and the always-on footer carries visibility.

### Adjudication pipeline

The full path from `tool_call` to a three-state verdict, in order: self-protection layer → built-in floor → user deny → denyPaths ask → user allow → gray zone to the classifier (an `ignoreTools` hit for an uncovered tool passes before the gray zone). With a `semanticAdjudication` block, the gray-zone segment is tiered ([ADR-0009](docs/adr/0009-tiered-semantic-adjudication.md)); without it, a single classifier. ask degradation (no UI → deny) and fail-closed are built into the pipeline semantics. Shape: `adjudicate(session, call, env) → Verdict` — a pure function with zero UI dependency; presentation (notify/confirm/select) belongs to the extension handler. Tamper detection is a pipeline precondition, not part of the pipeline. _Avoid_: "decision pipeline".

### Verdict

The judgment for one tool call. Produced by the `tool_call` hook: allow passes untouched, deny returns `{ block: true, reason }`. Runtime carrier is the `Verdict` value object (verdict / reason / detail / source / degraded): `detail` is UI-only plaintext (protected paths appear only in the local confirm dialog, per ADR-0002's zero-leak promise), `source` distinguishes rule / protected-path / classifier / fail-closed, `degraded` marks an ask that degraded to deny.

### Verdict notification

The gate's user-facing channel, carrying only **judgments worth attention**: deny and ask always notify; classifier allows notify when `notifyAllows` is on (default off); mechanical passes stay silent — a rule allow is an echo of the user's own regex, and a protected-path confirm is visible as the dialog itself. Division of labor with the audit log: notifications carry judgment, the audit log carries completeness. The debug switch (flag/env) notifies every verdict including allows; it is orthogonal to `notifyAllows`, and with both on the classifier-allow notification appears exactly once.

### Verdict audit records

Opt-in JSONL decision records for gray-zone adjudication (#54). Enabled by `"audit": true` in `omp-verdict.json`; each record is self-contained (timestamp, session id, cwd, model, tool and input, action line, thinking level, full transcript, raw response, parsed verdict, source, degraded flag), written per session to `<agentDir>/verdicts/<sessionId>.jsonl`, keeping the 20 most recent files. Since #62 the audit surface includes protected-path asks — the user's answer is feedback on the denyPaths declaration quality — and interactive asks record ground truth (`userAnswer` / `answeredAt` after the confirm resolves; `ts` stays adjudication time). Rule-layer allow/deny is still not recorded. Observe-only: recording never changes a verdict, and write failures stay fail-soft with a one-shot warning.

### Audit redaction

Deterministic credential rewriting before an audit record lands ([ADR-0007](docs/adr/0007-audit-secret-redaction.md)). Applies only at the `AuditLog.append()` sink — the pipeline and the classifier still see the real text (a secret-bearing command is itself an adjudication signal). Two layers (known token shapes + context-guided value redaction) replace matches with `<redacted:type#sha256-first-8-hex>`; the fingerprint is unsalted and deterministic, so the same secret keeps the same fingerprint across records and clustering survives. On by default; `auditRedactSecrets: false` disables it explicitly (invalid values warn once and stay on). Redaction failure is fail-open (record integrity over hygiene). Native omp session transcripts and terminal echo are out of scope.

### Rule layer

The pipeline's first segment: deterministic rules produce hard allow or deny. Two parts: the **built-in deny floor** (bash danger regexes + file-path sensitivity grading; deny-only claims, so false positives fail safe; the macOS per-user temp tree is exempt from system-directory grading via the runtime-resolved confstr family, intersection form, while the `authorized_keys` basename family stays in force) and **user rules** (allow/deny regexes configured and vouched for by the user). The built-in layer ships no allowlist (since 0.2.0; the security audit showed allowlist soundness needs shell AST analysis). Nested-call policy (`codemodeNestedCalls`, ADR-0006) does not exist in this fork — omp exposes no parent linkage.

### Dual-form matching

The normalization discipline for path rules: one target yields **every canonical form** — lexical absolute + realpath — and a rule fires if any form matches. A symlink alias whose lexical form sits inside the cwd but whose real form escapes must not earn an in-project write allowance (every form must sit inside the cwd's lexical/real forms). Two tiers: **base tier** = whole-path realpath, degrading to the lexical form on failure (`baseForms`; denyPaths and every base-side dual-form set follow it, ADR-0002); **ancestor-rebuild tier** = rebuild from the nearest existing ancestor's realpath when the target does not exist yet (`rebuiltForms`; self-protection and the sensitivity floor follow it since #20, where a false allow is expensive). denyPaths deliberately skips ancestor rebuilding.

### User rules

allow/deny regexes in `<agentDir>/config/omp-verdict.json`: deny beats allow, and a deny match blocks. Match targets are the full bash command string and file-tool absolute paths. `builtinDenyFloor: false` turns the whole built-in floor off (at the user's risk). Every "always allow" claim is the user's, never the author's.

### agentDir self-anchoring

How `<agentDir>` resolves (#35, omp-only): `PI_CODING_AGENT_DIR` always wins; otherwise the extension's own install path anchors it — a copy under `<home>/<dot-dir>/(agent/)?(plugins/node_modules/<pkg>/)?extensions/` anchors to `<home>/<dot-dir>/agent` (the plain `~/.omp/agent/extensions/` form, plus the plugin layouts: `<dot-dir>/plugins/...` since 18.1 and `<dot-dir>/agent/plugins/...` up to 18.0; the config tree always lives at `<dot-dir>/agent/config/`); an unanchored location (dev checkout) falls back to `~/.omp/agent`. **Existence probing is forbidden** as a substitute: on a machine with both trees, the presence of `~/.pi` must not redirect an omp run. The self-protection install-copy check and the S0 credential deny rule follow the same anchor.

### denyPaths (protected paths)

A user-declared list of sensitive paths — a **path-semantic declaration**: normalization (`~` expansion, lexical resolve, realpath symlink resolution degrading to lexical, case folding on macOS/Windows) and segment-prefix comparison are owned by the tool, and extraction covers file-tool paths plus extractable tokens in bash command strings. A hit is a **terminal ask** (headless degrades to deny), after user deny and the built-in floor, before user allow. Contrast with a deny regex (user-owned normalization assumptions): same security claim, stronger channel. Extraction and comparison run locally; the classifier only sees an **existence hint** (never the paths, never the hit call's verdict). _Avoid_: denyPath (singular).

### ignoreTools (tool exemption)

A user-declared list of tool names — a **no-side-effect declaration**: uncovered tools outside the command/file families (`todo`, `web_search`, MCP/custom tools) skip adjudication entirely, zero model calls. Entries naming covered tools (`bash`/`read`/`write`/`edit`/`grep`/`glob`/`find`/`ast_edit`/`ast_grep`) are inert: those stay governed by the deny floor and user rules, and the self-protection layer always runs first, so the list can never weaken either. Symmetric with denyPaths: one declares "stricter" (touch → ask), the other "looser" (exempt from review); both are user sovereignty. The first-run template pre-fills a starter list backed by the production audit. Cost: an exempted tool loses the classifier's existence-hint vigilance (uncovered tools never reached the path extractor anyway).

### Existence hint

A fixed background sentence injected into the classifier system prompt: the user has configured protected paths, so edge-probing (copy to temp then read, archive, indirect reference) must be judged strictly. It is the corollary of denyPaths' zero-leak promise: the classifier knows **that** paths exist, never **what** they are.

### Runtime data exemption

Upstream, a no-UI session's `write`/`edit` under `<agentDir>/sessions/**/subagent-artifacts/` passed deterministically (ADR-0008). **Not present in this fork**: the path shape is pi-subagent-tooling-specific and omp's `task` tool does not write it. Kept in the glossary only because the ADR is retained for the record.

### Self-protection layer

The built-in deny rule set that **no configuration can exempt**, protecting the gate's own integrity (the user-rules config and the extension's installed copy). Contrast with user rules: those are freely editable, while this layer cannot be turned off even by `builtinDenyFloor: false`. Rationale: every write inside the gate is by definition agent-initiated, so protected paths are always denied to tool calls; edits from outside the gate (your editor) are unaffected. _Avoid_: blacklist (reserved for user deny regexes).

### Tamper detection

Integrity re-verification of protected files, the backstop for rule-layer bypasses (command obfuscation, MCP side channels). Within a session: snapshot at start, re-verify before every verdict; on mismatch, differential disposal — a changed extension copy or no UI → **auto-restore** + fail-closed for the session; a changed config with a UI → **confirmation** (keep = re-baseline and continue, restore = roll back + fail-closed). A cross-session baseline (persisted hashes, startup comparison) is phase 2.

### Gray zone

Tool calls the rule layer does not settle — handed to the model classifier.

### Classifier

The model call that judges gray-zone risk. The model is **configurable** and defaults to **self-reflection**; the backend may be generative or not. Two backends ([ADR-0005](docs/adr/0005-native-classifier-migration.md)): **judgment-kind** models (`typesafe`, `openrouter-decisions`, `openai-decisions`, `workers-ai-systemone`) answer typed questions through omp's judgment client and carry protocol-native probabilities and confidence; every other spec runs the chat prompt contract. Since 0.16 the gray zone can also be **tiered** ([ADR-0009](docs/adr/0009-tiered-semantic-adjudication.md)): with a `semanticAdjudication` block, Tier 1 (local Lancet-Nano) plus Tier 2 (role-resolved adjudicator); without it, the single-classifier path.

### Tiered adjudication

ADR-0009's two-stage gray-zone semantics: **Tier 1** triages shell commands locally with LANCET-Nano (INT8 ONNX, CPU, no network) — `not_flagged` allows, `risky` becomes an ask (or deny per `riskyAction`), `review` and every abstention (oversized, tokenizer failure, inference error, missing bundle) escalate to **Tier 2**. Tier 2 resolves an adjudicator through omp's model facade (`adjudicator` → `smol` → session model), sends the tool call, the session transcript and Tier 1's band, and requires strict JSON; `allow` passes, `ask`/`deny` both go to a human (a model may not auto-deny at this tier), and parse failure/timeout/network error fail closed to ask (headless → deny). The block's presence is the switch; absent, behavior matches the single-classifier path. _Avoid_: treating Tier 1's `not_flagged` as a safety guarantee — it is "this local model found no risk in the command string".

### Self-reflection

The classifier's default model source: inherit the session's active provider/model for the adjudication call rather than pinning an external model.

### Bundled adapter

**Retired (0.13, ADR-0005)**: the `extensions/jev-adapter.ts` that shipped through 0.12, presenting TypeSafe's jev as a chat-shaped model in the host registry and translating classifier calls into decisions requests. Native judgment support absorbed the transport, and the file is gone. _Avoid_: calling the current jev integration an "adapter" — it is a judgment-kind catalog model.

### Typed decision

The output shape of a non-generative model: a chosen value from a predefined set, plus a probability distribution and a confidence. It cannot produce anything outside the agreed schema by construction. jev is one; an LLM's free text is the contrast. The reason line passes probabilities and confidence through.

### Judgment model (native classifier)

A model whose catalog API answers typed questions directly (`typesafe`, `openrouter-decisions`, `openai-decisions`, `workers-ai-systemone`). It is the anchor for capability claims: numeric confidence, and the non-applicability of thinking levels, follow from the **model kind**, not from the shape of a reason string — an LLM whose free text happens to mimic a jev reason does not acquire confidence, so the floor cannot fire on it by construction. _Avoid_: "decisions model" (0.12 term, retired).

### Verdict prefix contract

The chat backend's response convention: must begin with `<verdict>allow|ask|deny</verdict>` followed by one line of reason; a violation is a parse failure and fails closed. Judgment backends normalize to the same three-state outcome, but the reason line is composed from the structured answer instead.

### Three-state verdict (allow / ask / deny)

The three possible outcomes: rules or classifier find the call safe → **allow** (automatic pass); dangerous → **deny** (automatic block with a reason); indeterminate → **ask** (route to a human).

### ask degradation

When no UI is available (non-interactive modes: `omp -p` / json / rpc), every ask is treated as deny. It is fail-closed applied to unattended operation.

### fail-closed

The default on every error path (classifier error, timeout, unparseable output): block. Never silently allow.

### Confidence demotion

The mechanism behind the confidence floor (`classifierMinConfidence`, [ADR-0004](docs/adr/0004-classifier-fallback-cascade.md)): when a **judgment model's** confidence is strictly below the floor, the first layer's verdict is demoted regardless of allow/ask/deny — cascaded to the fallback classifier if configured, otherwise asked of the user (headless → deny). At or above the floor the first layer is autonomous. The floor works standalone. The trigger is **the presence of protocol-native confidence**: a structured judgment answer is the only source, so the chat path never triggers it by construction. On this fork the chat path also emits no inert-config warning for the floor — the behavior is documented instead.

### Inert configuration must surface

Configuration discipline: when a key's declared intent cannot be honored by the active backend's capabilities, the runtime must say so — usually a once-per-session **neutral** warning (states the fact, does not judge the config: the user may be pre-setting for a future switch), never silent failure. Lazy boundary: a session decided purely by rules triggers no such warning; feedback follows the first gray-zone resolution. Instances in this fork: a thinking suffix on a judgment model (warns once, dropped), and an unresolvable jev spec (specialized wording naming the real cause — a judge-kind model cannot serve the chat classifier path).

### Fallback classifier

The cascade's second layer (`classifierFallbackModel`), consulted only on confidence demotion or a first-layer fail-closed. In `enforce` mode (the default since 0.12.0) it adjudicates de novo, with one exception family (#71): a demoted **deny or ask** can never be auto-relaxed to an allow — a negative judgment's human adjudication must not be bypassed. A **fail-closed rescue** is not a relaxation: the first layer emitted no verdict, so the second layer's verdict (allow included) is a first decision and stands. `shadow` mode records its opinion only — the result lands in the audit record's `fallback` sub-object and in `/automode` session counters, the demoted call still goes to the user, and a fail-closed deny stands. If the fallback fails or is unparseable, that cascaded call goes to the user (headless → deny).
