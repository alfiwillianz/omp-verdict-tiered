# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

> **Fork.** This changelog starts from upstream [jesset/pi-verdict](https://github.com/jesset/pi-verdict) at 0.15.0 and records this fork's changes. Entries before `[0.16.0-omp.1]` describe upstream behavior and its original (pi) host.

## [Unreleased]

### Added

- **`/verdict-*` configuration commands**: `/verdict-status`, `/verdict-timeout`, `/verdict-role`, `/verdict-model`, `/verdict-floor`, and `/verdict-tier1` edit the global config in place (atomic write, unrelated keys preserved) and apply on the next session or `/reload`. `/verdict-role` autocompletes omp's built-in chat roles plus any custom `modelRoles` from `config.yml`; judge/image/web kind roles are excluded because Tier 2 needs a JSON-answering chat model.

### Changed

- **Tier 2 default timeout 5000 → 20000 ms.** A reasoning adjudicator routinely exceeds 5 s, which surfaced as `timeout after 5000ms` on ordinary commands. Set it per user with `/verdict-timeout`.
- **Tier 2 fallback is now explained.** When the configured role and `smol` both fail to resolve, the one-shot warning names why each candidate lost (not configured, no auth, not a chat model) instead of silently running on the session model.
- **Renamed the product surface to `omp-verdict-tiered`**: package name, entry file (`extensions/omp-verdict.ts`), user config (`~/.omp/agent/config/omp-verdict.json`), the Tier 1 cache (`~/.cache/omp/lancet-nano`), env vars (`OMP_AUTO_MODE_MODEL`, `OMP_AUTO_MODE_DEBUG`, `OMP_VERDICT_LANCET_DIR`), and all user-facing messages. Upstream attribution (`jesset/pi-verdict`) and the historical CHANGELOG/research entries keep the original name.
- **omp-only host port.** The extension now targets omp (oh-my-pi) ≥ 18.1 and drops the pi host entirely:
  - Host API: `@oh-my-pi/pi-coding-agent` types; model lookup through `ctx.models.resolve` (accepts `provider/id`, a bare id, or a role alias); completion through `completeSimple` with `ctx.modelRegistry.resolver(model, sessionId)` so omp's auth rotation and OAuth refresh apply; thinking control in omp's dialect (`disableReasoning` / `reasoning`).
  - Classifier backends: judgment-kind models (`typesafe`, `openrouter-decisions`, `openai-decisions`, `workers-ai-systemone`) answer through `createNativeJudge` from `@oh-my-pi/pi-ai`, keeping protocol-native confidence and the confidence floor; every other spec runs the chat prompt contract. pi's `classify()` / `findOfType` path is gone.
  - Tier 2 adjudicator resolution now uses omp's role aliases (`@adjudicator` → `@smol` → session model) instead of `getModelForRole`.
  - Tool coverage follows omp's built-ins: `bash` plus `read`/`write`/`edit`/`grep`/`glob`/`find`/`ast_edit`/`ast_grep`. Multi-path tools (`ast_edit`'s `paths[]`, `ast_grep`'s semicolon list) grade every target and take the strictest verdict.
  - Credential floor targets omp's stores: `~/.omp/agent/agent.db` and `~/.omp/agent/secrets.yml`.
  - Agent-dir anchoring defaults to `~/.omp/agent`.
- **Removed, with no omp equivalent**: the codemode nested-call policy (`codemodeNestedCalls`, [ADR-0006](docs/adr/0006-codemode-nested-calls-policy.md)) — omp's `tool_call` event carries no `parentToolCallId`; and the headless subagent-artifacts write exemption ([ADR-0008](docs/adr/0008-agentdir-sessions-write-exemption.md)) — the pi-specific path shape does not exist.
- **Removed**: `README.zh-CN.md` (English-only docs), the npm publish workflow, and the pi peer dependency.
- **Docs rewritten for omp**: README, installation guide, configuration reference, security principles, CONTEXT glossary, and the pi-specific ADRs (0003 historical, 0005 rewritten, 0006/0008 withdrawn).

### Added

- Attribution to the original author (Jesset) in the README and LICENSE notice.

### Fixed

- **Tier 2 returned an empty completion on reasoning models.** The adjudicator call capped `maxTokens` at 256, which backends that ignore `disableReasoning` (they still emit a thinking preamble) and Anthropic-dialect proxies (`max_tokens` must exceed the 1024-token thinking budget) answer with an empty string — surfaced as `invalid adjudicator JSON ... raw output=""`. The budget is now 4096, matching omp's own judgment backend (`JUDGMENT_CHAT_MAX_TOKENS`) and its documented rationale. The main classifier's retry tier moves from 1024 to 4096 for the same reason. An empty completion now reports its `stopReason` and `errorMessage` instead of claiming malformed JSON, and a regression test pins the budget above the 1024 floor.

### Added (upstream 0.16 line, carried by this fork)

- docs: source-installation guide ([installation.md](docs/installation.md)) — install forms, the Tier 1 bundle, updating, troubleshooting, and the single-file `tieredFallback` caveat.
- **Tiered semantic adjudication** ([ADR-0009](docs/adr/0009-tiered-semantic-adjudication.md)): the gray zone can now run as two tiers instead of one classifier call. **Tier 1** triages shell commands locally with [LANCET-Nano](https://huggingface.co/fingerthief/lancet-nano) v0.4.3 (CodeT5+ 220M INT8 ONNX, CPU, no network): `not_flagged` → allow immediately (measured median 10.1–10.6 ms, p90 ~15.3 ms warm), `risky` → ask (default) or deny via `riskyAction: "block"`, `review`/abstention/oversized input → **Tier 2**. Tier 2 resolves an adjudicator through omp's model facade (`@adjudicator` → `@smol` → session model), sends it the tool call, the condensed transcript and Tier 1's band, and requires strict JSON `{"verdict","reason"}`. Tier 2 `allow` passes; `ask`/`deny` both go to a human (a model may not auto-deny at this tier); any failure — no model, transport error, 5 s timeout, unparseable output — fails closed to ask (headless → deny). Opt-in via a `semanticAdjudication` block; absent, behavior is byte-identical to 0.15.
- `scripts/setup-lancet.ts` (`bun run setup:lancet`): downloads the pinned LANCET-Nano bundle into `~/.cache/pi/lancet-nano`, verifies `export.json` against the release-manifest digest and every model file against `export.json`, cross-checks the tokenizer against `@xenova/transformers`, and supports `--check` (verify only) / `--force` / `--dir`. The runtime re-verifies every file on load; a tampered bundle refuses to load and Tier 1 escalates.
- Dependency-free byte-level BPE tokenizer (`src/classifiers/tokenizer.ts`) reproducing the reference CodeT5 tokenizer (`vocab.json` + `merges.txt`); ids are pinned against the Python reference in tests.
- Audit records gain optional `tier1` and `tier2` sub-objects (band, calibrated probability, risk logit, model/role, verdict, duration, error); top-level `source` stays `"model"`/`"fail-closed"` so existing corpus tooling keeps working.
- `/automode` status shows the active tiers when the block is configured.

### Changed

- Gray-zone shell commands in tiered mode no longer consult a remote classifier unless Tier 1 escalates. Non-shell tools (MCP/custom) go straight to Tier 2.
- The tiered runtime is loaded lazily; a bare single-file install that configures the block but lacks the package tree falls back to the legacy classifier and records `tieredFallback` on the audit record.

### Internal

- `npm run build` / `bun run build` is an alias for the typecheck (the project is source-distributed; there is no emit step), so the acceptance-criteria command exists as written.
- New dependencies: `onnxruntime-node` (CPU execution provider) and `@xenova/transformers` (setup-time tokenizer cross-check only). `tests/tiered.test.ts` covers tokenizer parity, banding, window contract, Tier 2 parsing/resolution/failure modes, config validation, the `adjudicate()` integration and the `/automode` status line; ONNX inference tests run when `PI_VERDICT_LANCET_DIR` points at a verified bundle (JS↔Python cross-validation: 36/36 bands, max risk-logit delta 4.7e-5).

## [0.15.0] - 2026-10-06

### Added

- Headless subagent-artifacts write exemption ([ADR-0008](docs/adr/0008-agentdir-sessions-write-exemption.md)): a no-UI session's `write`/`edit` under `<agentDir>/sessions/**/subagent-artifacts/` (where pi's subagent tooling writes its working artifacts) returns a deterministic allow — closing the headless false positive where a subagent's artifact write drew an ask that degraded to deny with no human in the loop. Headless-only: interactive sessions keep normal adjudication (the gate never waives an ask a human could perform); `hasUI` is a proxy — pi's ExtensionAPI exposes no subagent identity marker. Positioned after user deny and denyPaths (declarations outrank the built-in exemption) and lifting only the gray grade — the floor and self-protection precede it; reads and bash stay classifier-adjudicated; a symlink resolving outside earns no exemption (every-form intersection, ancestor-rebuild prefixes so a nonexistent tree on a fresh install does not void the exemption over firmlinks). Keyless, like #54's verdicts read-deny: a statement about the gate's own surface, not user policy.
- docs: `allow` recipes for the two dominant ask-friction shapes (release workflow, read-only CI inspection), backed by the production audit's measured approval rate (70 allows / 1 decline across 71 asked calls; the one decline was a denyPaths rule) — opt-in declarations, not a built-in allowlist ([configuration](docs/configuration.md)).
- Audit secret redaction ([ADR-0007](docs/adr/0007-audit-secret-redaction.md)): audit records now redact credential-shaped text before append — known provider token shapes (`sk-`/`pk-`/`ghp_`/`AKIA`/`xox`/`AIza`/JWT/`github_pat_`) plus context-guided values (`-u user:pass` password segment, URL userinfo, `*_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS` and bare `TOKEN|APIKEY|SECRET` assignments, `Bearer` tokens, credential query params), each landing as `<redacted:type#sha256-8hex>` with a deterministic unsalted fingerprint so the same secret stays traceable across records. Scope is the persisted copy only — the classifier still sees the real command (a secret-bearing command is itself an adjudication signal), and pi's native session transcripts are untouched. Redactor failure fails open (record integrity over hygiene); on by default, `auditRedactSecrets: false` is the explicit keep-raw escape hatch; non-boolean values warn once via the session-start channel and redaction stays on. Motivation: a production audit found ~18 records persisting a hardcoded API key pair in plaintext inside the gate's own telemetry ([research](research/verdicts-ask-friction-audit-2026-10.md)).

## [0.14.0] - 2026-10-02

### Added

- `codemodeNestedCalls` policy key + nested-call audit attribution (#90, [ADR-0006](docs/adr/0006-codemode-nested-calls-policy.md)): nested codemode calls default to `"gate"` (identical to direct calls, unchanged); `"rules-only"` opts them into the deterministic layers only — self-protection, the built-in floor, user rules, denyPaths with its ask — skipping the classifier + cascade (the gray zone passes, audited as `source: rule` + `policy: rules-only`). Motivation: serial gray-zone adjudication of script batches measured ~350ms/call (50 calls ≈ 17.5s; the 256 cap ≈ 90s). Honest cost, stated in the docs: rule-passing actions the classifier would have caught pass under rules-only (coverage beyond the floor is denyPaths-declaration-dependent). Mode-independently, audit records gain `toolCallId`/`parentToolCallId` attribution — nested records become distinguishable from direct ones (live-fire evidence: they were field-for-field identical). `/automode` surfaces the active exemption; invalid values warn once and keep gate semantics; direct calls are byte-identical in both modes (PR #89 baseline pinned).
- docs/diagrams: security-gate pipeline regenerated to the v0.14 baseline (ADR-0001–0006) — the classifier node carries the native classify() path (ADR-0005), the nested-call policy exits at the gray-zone boundary (ADR-0006), and the Tool Call node notes direct + nested entry; both language specs showcase-validated (9/9 artifact checks, 0 composition errors/warnings) with dual-theme SVGs re-exported; the ASCII pipelines and captions in both READMEs updated to match.

### Internal

- devDependencies `@earendil-works/pi-coding-agent` 0.99.2 → 1.0.0 (typecheck zero errors; 241/241 tests green; fullscreen `ask`/`notify` smoke-verified interactively on 1.0.0). `peerDependencies` stays `>=0.99.0` — pi 1.0.0 leaves the extension API surface unchanged, so no code migration.

## [0.13.1] - 2026-10-02

### Added

- README (both languages): a "pi 0.99 codemode & MCP" section — nested codemode calls are gated exactly like direct ones (`parentToolCallId`), MCP tools adjudicate in the gray zone, the `ignoreTools` name-normalization trap (`mcp__dev-radius__x` → `mcp__dev_radius__x`), the 256-nested-calls cost amplification, and the `--no-extensions -e builtin:*` exposure boundary; `docs/security-principles.md` principle 10 records the same parity discipline.

### Changed

- Internal refactor (the 0.13 review's judgement calls, zero behavior change): `classifyWithModel` takes `(env, resolved, call)` instead of nine positional params; the resolved-layer type is flattened to `{kind, model, thinking}` removing the `resolved.model.model.id` double hop; the two spec-unavailable warnings share one formatter (the generic classifier-layer wording normalizes `, falling back` to `; falling back`, matching the jev branch).

### Changed

- Native-path reasons are tag-free: the vestigial `<verdict>…</verdict>` prefix is dropped from the reason composed by `composeVerdictLine` — it existed to satisfy the LLM path's `parseVerdict` contract, which the native classify() path never needed (the verdict comes from the structured answer; the floor reads structured confidence). Notifications and ask dialogs now read e.g. `🛡️ allow (classifier): jev: allow 95% (confidence 93%; ask 4%, deny 1%)`. The audit record's `rawResponse` keeps the full contract line (tag included), mirroring the chat path's rawResponse (the model's full output). ⚠️ Corpus comparability: native-path audit `reason` fields lose the leading tag; tooling anchored on `^<verdict>` over `reason` must switch to `rawResponse` (ADR-0005 amendment).

### Fixed

- macOS per-user temp tree is exempt from the system-directory floor (#83): `$TMPDIR` (the `/var/folders/…/T` confstr dir) was misgraded as a system path — writes hard-denied, reads gray on every call. Now reads allow at zero cost and writes grade as ordinary outside-project writes (classifier-adjudicated) — the floor adds no allow claim of its own. Guardrails: the exemption anchors to the runtime-resolved confstr family at the confstr depth — two segments below `/var/folders`, so even the family root widens nothing (a hand-set `TMPDIR` lifts nothing; floor narrowing goes through code review, not env accidents), applies with #20 intersection semantics (a temp-lexical symlink whose real form escapes still hits S1), keeps the basename family (`authorized_keys` staged under the temp tree still denies), and `/var/tmp` (POSIX shared temp) stays S1. denyPaths declarations over the temp tree keep asking (pipeline order unchanged). Inert on Linux/Windows (their tmpdirs never matched S1).
- denyPaths bash token extraction is linear now (#32): `BASH_PATH_TOKENS`' regex backtracked quadratically on long failure searches — a 200k separator-free command took ~28s of token extraction whenever denyPaths were configured (uncapped, unlike the #25 danger-regex cap, because truncation would let a protected-path spelling beyond the cap silently escape the deterministic ask). Replaced with `bashPathTokens`, a one-pass deterministic tokenizer that reproduces the regex's matchAll semantics exactly (alternation priority included; equivalence pinned by a 3000-case fuzz test against the regex, which stays in the codebase as the semantic oracle) — 200k adversarial shapes now extract in single-digit milliseconds.

### Internal

- CI: `actions/checkout` and `actions/setup-node` bumped v4 → v5 (run logs showed Node 20 deprecation warnings).

## [0.13.0] - 2026-10-01

### Breaking Changes

- **Requires pi ≥ 0.99** (`peerDependencies >=0.99.0`): 0.13 adopts pi's native classifier support and drops the dual-version compat layer. Older hosts (pi < 0.99, omp) keep using 0.12.x from npm — old hosts run old extensions (ADR-0005).
- **Removed `extensions/jev-adapter.ts`** (ADR-0005, superseding ADR-0003's transport): classifier-typed models now resolve through pi's `findOfType("classifier", …)` and adjudicate via `ModelRegistry.classify()` with request-time auth. The adapter's provider registration also shadowed pi's built-in `typesafe/jev-latest` classifier for the whole session; retiring it restores the built-in entry (research/pi-0.87-to-0.99-upgrade-assessment.md §2.2).
- Removed the `PI_VERDICT_JEV_TRANSPORT` / `PI_VERDICT_JEV_URL` environment variables — the native catalog covers the transports (`typesafe/jev-latest` direct with `TYPESAFE_API_KEY`; `openrouter/~typesafe/jev-latest`, `opencode/jev-1.13`, Cloudflare Workers AI, Vercel AI Gateway with each provider's login); custom endpoints move to models.json provider `baseUrl` overrides.

### Changed

- Confidence-floor criterion (ADR-0005): demotion now keys on protocol-native confidence — `ClassifierOutcome.confidence`, set only by the classify() path — instead of "decisions-model identity + a parseable reason segment". An LLM whose free-text reason matches the historical `jev:` shape still cannot demote (by construction now, not by regex); a chat-model classifier with `classifierMinConfidence` set warns once, neutrally, as before. llama.cpp label-probability classifiers (free, local, same-id with their chat twins — the native entry wins on dual listings) become floor-capable classifier options. ⚠️ Corpus comparability: pre-0.13 corpora contain demoted rows gated by the 0.12 criterion; cross-version analysis must treat the demoted population as criterion-dependent (same caveat class as 0.12.1).
- Reason-line rendering: System One answers keep the exact 0.12 `jev:` line (audit tooling continuity; the family covers both catalog apis — `typesafe-system-one` and the Cloudflare Workers AI transport `cloudflare-workers-ai-system-one`); other classifier APIs render the same template with a `classifier:` prefix.
- Unresolvable jev spec wording now names the real causes on the native path: a host without native classifier support (pi < 0.99), or a missing credential for the transport.
- Known limitation carried over unchanged (recorded in ADR-0005): the denyPaths existence hint still does not reach classifier-typed models (the adapter never saw it either); a criteria variant is future work.

### Internal

- devDependencies `@earendil-works/pi-coding-agent` 0.84.3 → 0.99.2 (typecheck zero errors; 232/232 tests green; clean-agent-dir headless load smoke on 0.99.2). `files` no longer ships jev-adapter.ts. The jev-adapter test suite is replaced by `tests/native-classifier.test.ts` (verdict-line composition both prefixes, structured-confidence floor, classifyFor binding, classifyNative fail-closed matrix).

## [0.12.1] - 2026-09-28

### Added

- Runtime feedback for implicit jev vs LLM classifier differences (#81, [ADR-0004 amendment](docs/adr/0004-classifier-fallback-cascade.md)): four silent gaps now surface instead of staying implicit — (a) `classifierMinConfidence` set while the effective classifier (configured or self-reflected) is not a decisions model: one neutral warning at the first gray-zone resolution (a purely rule-adjudicated session never sees it); (b) an unresolvable `typesafe/jev-latest` warns with wording naming the two real causes — a host without `registerProvider` (omp), or a missing key (`OPENROUTER_API_KEY`/OpenRouter login, or `TYPESAFE_API_KEY` on the typesafe transport) — instead of the generic "not found or no configured auth", on both the classifier and fallback layers; (c) a thinking suffix on the jev spec warns once and is ignored; (d) the audit `thinking` field records `null` for decisions models (the suffix was parsed, sent, and dropped). No new config keys: the provider prefix stays the single source of truth — a `classifierBackend`/`classifierType` switch was reviewed and rejected (second source of truth with contradiction states; would freeze ADR-0003's "any model registered through pi" direction). docs/configuration.md's claim that jev thinking suffixes "are ignored" corrected to warn-and-ignore.
- docs/diagrams: security-gate pipeline diagram authored as maintainable specs (en/zh workflow JSON, showcase-validated) with dual-theme SVG exports embedded in both READMEs' pipeline sections; regeneration instructions in docs/diagrams/README.md. Interactive viewer HTML stays untracked; pipeline baseline v0.12.

### Changed

- Confidence-floor demotion criterion (#81): demotion now requires the first-layer model to **be a decisions model** (protocol identity) **and** a parseable confidence segment — numeric confidence is a decisions-contract property, not a vendor trait, so an LLM whose free-text reason happens to match the `jev: … (confidence N%…)` shape no longer demotes (0.12.0 would mis-demotion it). Normal paths are byte-identical; only the pathological path changes, from mis-demotion to correct no-demotion. ⚠️ Corpus comparability: pre-0.12.1 corpora may contain demoted rows with LLM first layers emitting jev-shaped reasons; such rows cannot exist from 0.12.1 — cross-version analysis must treat the demoted population as criterion-dependent.

### Fixed

- README: add `~/.kube` to the example `denyPaths` in both languages; sync README.zh-CN.md with README.md (cache-sim outcome incl. #73, omp-18 completion **fallback** wording, master-switch / self-protection terminology per CONTEXT.md, Jev section wording) and repair a broken in-page anchor; both READMEs now state the headless branch of config-tamper disposal (no UI → auto-restore, same as the extension copy), move the `pi ≥ 0.84` requirement to Quick start, clarify the ADR-0004 `enforce` carve-outs as parallel rules, and soften the Claude Code auto-mode attribution to "inspired by" (mechanism-inverse framing stays in maintainer docs); zh punctuation unified to full-width sentence punctuation.
- README asset references (demo GIF, status/ask screenshots, pipeline SVGs) switched from repo-relative paths to absolute URLs — raw.githubusercontent.com for bitmaps, jsDelivr's /gh endpoint for SVGs (raw serves SVG as `text/plain` + `nosniff`, which breaks direct `<img>` embedding). Root cause: pi.dev renders the tarball README against jsDelivr's npm endpoint, and the intentionally-minimal `files` whitelist ships no `docs/`, so relative asset paths 404'd there (npmjs.com rewrites them to the GitHub repo HEAD and was unaffected). The tarball stays minimal — a security gate's publish artifact is part of its trust surface. CI gains a step asserting every README asset URL resolves against the SHA under test.

## [0.12.0] - 2026-09-26

### Added

- `ignoreTools` user config (PR #45, by @geoyws): a plain list of tool names outside the command/file families (`todo`, `web_search`, MCP/custom tools, …) that skip adjudication entirely — verdict allow with zero model calls. Entries naming covered tools (`bash`/`read`/`write`/`edit`/`grep`/`find`/`ls`/`powershell`) are inert: those stay governed by the deny floor and your allow/deny rules, and the self-protection layer always runs before the passthrough — the list can never weaken either. Invalid entries join the one-shot config warning channel. The first-run template pre-fills a starter list of side-effect-free tools (`todo`, `ask_user_question`, `memory_write`, `memory_search` — observed harmless across the 1265-verdict production audit, [research](research/classifier-cascade-production-audit-en.md); `memory_forget` deliberately absent: it deletes); a recommendation, not a built-in passthrough — existing configs are never rewritten.

### Changed

- `classifierFallbackMode` now defaults to **`"enforce"`** ([ADR-0004 default-mode amendment](docs/adr/0004-classifier-fallback-cascade.md)): configuring `classifierFallbackModel` alone activates the second layer. The shadow-first default guarded an unvalidated enforce semantics; the production audit validated every layer boundary and #71 structurally closed the worst case (no auto-relaxing of negative verdicts), so the guard's remaining value was small against the confusion of "configured but inert". `shadow` remains an explicit opt-in; `/automode` shows a one-line activation hint whenever a configured second layer sits in shadow. ⚠️ Configurations setting `classifierFallbackModel` without a mode change behavior on upgrade.
- Cascade semantics (#71, [ADR-0004 amendment](docs/adr/0004-classifier-fallback-cascade.md)): under `enforce`, the fallback may no longer auto-relax a **negative** first-layer verdict — a demoted **ask** it would allow now goes to you (headless → deny), mirroring the demoted-deny carve-out. A **fail-closed** first layer keeps full de novo authority including automatic allow: it emitted no verdict, so a fallback allow is a first ruling, not a relaxation (otherwise a first-layer outage becomes full-session manual confirmation). Enforced fail-closed rescues now record the **applied verdict** at the audit top level (source stays `fail-closed`; previously all such rows carried `verdict: "deny"` — 26 observed rows, 25 actually allowed, distorting deny-rate statistics; shadow rescues keep the deny). `/automode` gains a distinct `rescued-allow` / `would-rescue-allow` counter. Grounded in the [production audit](research/classifier-cascade-production-audit-en.md).

### Removed

- The shadow-cache runtime telemetry (#73): the dual-key LRU probe on every gray-zone adjudication, would-hit accounting, the `/automode` shadow stats line, the debug-notification shadow annotation, and the audit record's `shadow` field (new records omit it; old records keep theirs). Two independent measurements agree the hit rate sits far below any activation threshold (offline cache-sim replay 3.2%, runtime would-hit 41/1249 = 3.3%), so the probe cost code on a product whose pitch is ~2k minimal lines. Future cache re-evaluation belongs to offline replay tooling, not a standing runtime observer.
- The first-run config template's embedded `_hint` field (#72): it duplicated docs/configuration.md and had drifted twice (the stale `classifierFallbackConfidence` key name and the pre-#67 "escalates strictness only" wording both lived only there). The template is now bare keys + starter lists; the full reference is [docs/configuration.md](docs/configuration.md). Existing configs are untouched.

### Fixed

- The early fail-closed path (no classifier model available) misflagged the returned verdict's `degraded` on headless fallback denies (#77): `!env.hasUI` marked every headless deny as degraded, but `degraded` is defined as the **ask-degradation product** marker — a fallback that rules `deny` never passed through an ask, so it is not a degradation product regardless of UI state. Now it reuses the audit record's `effAskHeadless` predicate — one named predicate, so return and record cannot drift apart again. No behavior change surfaces: presentation and block reasons read only `source`. Four doc comments claiming presentation maps "by source × degraded" corrected to source-only — the stale wording had drifted from the implementation.

## [0.11.0] - 2026-09-21

### Changed

- Confidence floor semantics (#67, [ADR-0004 amendment](docs/adr/0004-classifier-fallback-cascade.md)): the cascade gate becomes an **autonomy floor**. `classifierFallbackConfidence` is renamed **`classifierMinConfidence`** (`number | null`, default null = off; the old key warns as renamed and is ignored — clean break, no alias) and now means: a jev verdict with confidence strictly below the floor is **demoted, whatever the verdict** (allow/ask/deny alike) — cascaded to the fallback if `classifierFallbackModel` is set, otherwise asked of the user directly (non-interactive degrades to deny). The floor works standalone without a second layer, and is inert for LLM first layers (no numeric confidence). High-confidence asks no longer consult the fallback (the 0.10.0 ask-trigger is gone).
- Second-layer authority under `enforce` is now **de novo adjudication** with one carve-out (#67): a demoted first-layer **deny** that the second layer would allow is asked of the user, never an automatic allow; every other combination applies as the second layer rules (a demoted allow can be re-allowed — the absorb direction). This supersedes the 0.10.0 safety ratchet and its fail-closed no-exception decision. A failed or unresolvable fallback on a cascaded call now asks the user (the tier that was to adjudicate is down; headless → deny, one-time warning) instead of denying outright.

### Added

- Audit `demoted: true` marker on floor fires (#67); `/automode` cascade counters renamed to `triggered · agreed · overruled (would-overrule in shadow) · errored`.

## [0.10.0] - 2026-09-21

### Added

- Ground truth for ask confirms (#62): interactive asks — classifier and protected-path alike — now record the user's answer in the verdict audit log. `userAnswer` (`allowed`/`declined`) and `answeredAt` (ISO of the confirm resolution; `ts` stays adjudication time) attach to the record after the confirm resolves, keeping one record per verdict; killing pi mid-dialog loses that ask record (accepted trade-off of the append-only discipline). The audit surface widens to protected-path asks (#54 boundary change) — their user answers grade the denyPaths rules, records carry the matched path in `detail`, and a headless degradation records as its effective deny; rule-layer allow/deny verdicts remain unaudited.
- Uncertainty-gated fallback classifier, shadow-first (#63, [ADR-0004](docs/adr/0004-classifier-fallback-cascade.md)): opt-in `classifierFallbackModel` adds a second-layer classifier consulted only when the first layer is uncertain — trigger precedence fail-closed → `ask` → jev confidence strictly below `classifierFallbackConfidence` (0–100, default 50). `classifierFallbackMode: "shadow"` (default) records the outcome in an optional audit `fallback` sub-object and in `/automode` session counters without ever changing the verdict; `"enforce"` applies a safety ratchet (allow < ask < deny — the fallback only escalates, never relaxes; a failed fallback call or unresolvable model denies the triggered call, untriggered calls stay single-layer). The fallback runs with its own 15s-per-attempt budget and, unlike jev, receives the denyPaths existence hint. Audit records keep first-layer semantics at the top level — the enforced outcome lives in `fallback.effective`. jev's confidence is now hard-required by the adapter (contract-guaranteed on choice answers; absence fails closed like any malformed shape), and `parseJevConfidence` is exported for the gate (LLM first layers gate on ask/fail-closed only). Off unless configured — with no second layer the pipeline is byte-identical for every first layer.

## [0.9.1] - 2026-09-19

### Added

- Second transport for the jev decisions backend (#55 follow-up): `PI_VERDICT_JEV_TRANSPORT=typesafe` targets TypeSafe's official v1 API (`POST api.typesafe.ai/v1/systemone`, credentials via `TYPESAFE_API_KEY` from console.typesafe.ai) instead of OpenRouter's alpha decisions endpoint. The two wire contracts are isomorphic (live-verified 2026-09-19: same `{state, questions}` body, answers carry choice/probabilities/confidence, usage snake_case) — verdict text, timeouts, and fail-closed semantics are unchanged; the TypeSafe API does not report per-call cost (it shows as $0). `PI_VERDICT_JEV_URL` now overrides whichever transport is active. Default stays `openrouter` (pi's OpenRouter login reuse).

## [0.9.0] - 2026-09-19

### Added

- Optional allow-visibility preference (#60): `notifyAllows: true` in `pi-verdict.json` surfaces every classifier allow as an info notification (verdict reason + action line — e.g. jev's probability breakdown), default `false`. Mechanical passes (allow-rule echoes, protected-path confirms) never notify under it; the debug switch keeps its diagnostic scope unchanged, shadow-cache annotations stay debug-only, and with both on the notification appears exactly once. Config-only, new-session semantics.
- Opt-in verdict audit log (#54): `"audit": true` in `pi-verdict.json` records every gray-zone adjudication (allow/ask/deny and fail-closed alike) as a self-contained JSONL line under `<agentDir>/verdicts/<sessionId>.jsonl` — timestamp, session id, cwd, model, tool + input, action line, thinking level, the full transcript sent, the raw response, the parsed verdict, source, and shadow-cache probe result. Rule-layer decisions are not recorded; retention keeps the 20 most recent session files (pruned at session start). Full fidelity stays local (ADR-0002 boundary note); the directory is denied to agent reads and writes; the sink is fail-soft (a write failure never affects a verdict — one warning per session) and never an adjudication input. `/automode` shows `audit: on → <path>` while active.

### Fixed

- Agent-facing block reasons are now guaranteed non-empty and unambiguous (#53): all eight block sites (classifier, rule, fail-closed, protected-path degraded, user-declined ×2, tamper ×2) route through one wrapper emitting `[auto-mode <source> block] BLOCKED — this action did NOT run. Reason: <detail or "(no further reason given)">. Report the block to the user; never claim it succeeded or completed.` Previously an empty classifier reason left a bare `[auto-mode classifier block]` prefix in the tool result and terse rule reasons read like file descriptions — acting models then reported blocked actions as succeeded, since structural error signaling (`isError`) never reaches several provider lanes. UI notifications are unchanged; the wrapper adds no protected-path plaintext (ADR-0002).
- Gray-zone adjudication no longer fail-closes on models whose provider rejects the `temperature` parameter (#47): current-gen Anthropic models (`claude-sonnet-5`, `claude-opus-5`, `claude-opus-4-8`) answer the classifier's `temperature: 0` with a 400, denying every call whether set as `classifierModel` or reached via the session-model fallback. A rejection that mentions the parameter is now retried once without it at the same tier and the model is remembered until the extension reloads; models that accept the parameter keep the `temperature: 0` determinism pin.

## [0.8.0] - 2026-09-19

### Changed

- Shortened the first-run config template `_hint` to the decision-critical lines plus a pointer to the full configuration reference (~1.9KB → ~0.7KB): match targets, path-normalization details, thinking suffixes, and the jev backend note now live only in `docs/configuration.md`.

### Fixed

- Classifier calls to the `openai-codex-responses` API no longer send `temperature: 0` — the codex API rejects the parameter, which broke GPT-based `classifierModel` setups; the provider's `errorMessage` now also surfaces in classifier diagnostics instead of a bare failure (#46).

### Added

- Optional jev classifier backend (#55): `classifierModel: "typesafe/jev-latest"` routes gray-zone verdicts through TypeSafe's jev decisions model. A bundled adapter extension (`extensions/jev-adapter.ts`, auto-loaded with the package, individually disable-able via `pi config`) registers the model in pi's registry and translates the classifier call into one OpenRouter `choice` question (`POST /api/alpha/decisions`), synthesizing the usual `<verdict>` text with probabilities and confidence — timeouts and fail-closed semantics unchanged. Credentials reuse pi's OpenRouter login (`/login openrouter`) with `OPENROUTER_API_KEY` as fallback (no separate typesafe account); the endpoint is overridable via `PI_VERDICT_JEV_URL` (alpha API). Known limitations and the alternatives considered are recorded in ADR-0003: the denyPaths existence hint does not reach jev (denyPaths themselves stay rule-enforced before the classifier); jev "does not treat [state] as hostile by default" per TypeSafe docs, so adversarial transcript content can move its judgment; omp hosts stay inert; reasons are templated probabilities. Selecting the model as the session model warns — it generates no text.

## [0.7.1] - 2026-09-09

### Added

- The first-run config template pre-fills a starter `denyPaths` list (`~/.ssh/`, `~/.profile`, `~/.gnupg`, `~/.mc`, `~/.zshrc`, `~/.bashrc`) so protection is on from the first session after the initial run (#49): touches of these paths — file tools and bash path tokens alike — ask for your confirmation. The list is a pre-filled *user declaration*, not a built-in floor: edit or empty it in `pi-verdict.json`; existing configs are never rewritten. (Proposed with per-key entries under `~/.ssh/`; deduplicated to the directory prefix — segment-prefix comparison already covers every file beneath it.)

### Fixed

- denyPaths subtree scope for `grep`/`find`/`ls` (#48, reported in [discussion #8803](https://github.com/earendil-works/pi/discussions/8803#discussioncomment-18350257)): an omitted `path` (pi's documented default: the current directory) bypassed denyPaths entirely — a plain rule-layer allow with zero classifier involvement, leaking protected content out of the cwd. An explicit `path` pointing at a directory above a declaration fell through to classifier discretion. These tools now treat their search scope as the target: an omitted path resolves to the cwd for both user rules and denyPaths, and the comparison is bidirectional for them (declaration under the searched subtree, or cwd inside a declaration) → terminal ask, non-interactive degrades to deny. `read`/`write`/`edit` and bash token extraction keep single-target semantics — a recursive search issued from a shell (argument-less, or with a parent-directory argument) still falls to the classifier's existence hint (ADR-0002 amendment).

## [0.7.0] - 2026-09-04

### Changed

- Renamed the extension entry file to `extensions/pi-verdict.ts` — the entry file now matches the package name and the config file (`pi-verdict.json`). Runtime interfaces are unchanged (`--auto-mode*` flags, `/automode` command, `PI_AUTO_MODE_*` env). Both install paths load the extensions directory, so `pi install` / `omp plugin install` users are unaffected.
- Internal refactor (behavior-identical): the tool_call adjudication pipeline is now `adjudicate()` — a zero-UI module returning a `Verdict` value object (`source: rule | protected-path | classifier | fail-closed` × `degraded` for ask→deny in non-interactive sessions). The two previously duplicated ask-degradation branches collapse into one place; the handler only maps verdicts to UI. Tamper detection moved into an `IntegrityWatch` class and session state into a `SessionState` class (one reset list per module). New interface-level tests cover ask-degradation unification, the full `source × degraded` matrix, and a denyPaths zero-plaintext regression on reasons and notifications (ADR-0002 story 11). The dead `selfProtectCheck` export was removed; block reasons and notification texts are byte-identical.
- Internal refactor (behavior-identical): the dual-form path-normalization machinery is now one canonical-forms module — `baseForms` (whole-path realpath with lexical fallback, the ADR-0002 base tier) and `rebuiltForms` (ancestor-rebuilding tier, #20) — replacing the two builders (`targetForms`/`pathForms`) and six scattered `tryRealpath` base-side sets. Comparison disciplines stay per-consumer (denyPaths case folding, floor regex `/i`, self-protection exact match). denyPaths deliberately stays base-tier — a nonexistent target written through a symlinked alias falls to the classifier, not a denyPaths hit — now pinned by a regression test.

## [0.6.1] - 2026-09-03

### Fixed

- omp 18.1+ anchoring: omp 18.1 installs npm plugins under `~/.omp/plugins/node_modules/<pkg>/` — a sibling of `agent/` in the config root, not under it — which the 0.6.0 self-anchor did not match. On omp 18.1+ the gate silently fell back to `~/.pi/agent`: no config template appeared under `~/.omp/`, hand-edited rules/denyPaths there were never read, omp sessions shared the pi host's config file, and the omp install copy sat outside the self-protection set. The anchor now accepts both omp layouts (`agent/plugins/node_modules/…` and `plugins/node_modules/…`), and the self-protection ext-roots cover the package dir under the config root. Scoped npm packages (`@scope/pkg`) now get package-level self-protection instead of shielding the whole `@scope/` dir (a latent #26-era over-protection, now corrected to package granularity). Verified against omp 18.1.3. Upgrading from 0.6.0 on omp: close running omp sessions before `omp plugin install` (a live session's tamper detection would treat the updated install copy as tampering), then re-create your config at `~/.omp/agent/config/pi-verdict.json` — configs under `~/.pi/agent/` keep applying to pi sessions only.

## [0.6.0] - 2026-09-02

### Added

- oh-my-pi (omp) host support (#35): the extension self-anchors to whichever agent tree it is installed in — user rules, self-protection, and the S0 credential deny now cover `~/.omp/agent/` (config, `plugins/node_modules/` install copies, `auth.json`) exactly like `~/.pi/agent/`. On omp 18 (no `ModelRegistry.complete`) the classifier falls back to the pi-ai compat completion API at first gray-zone verdict; resolution failures follow the existing fail-closed deny. Thinking control is sent in both hosts' native dialects (`thinkingEnabled`/`effort` for pi, `reasoning`/`disableReasoning` for omp). Behavior on pi is unchanged; on dual-install machines the gate follows the extension copy's own location, never host-tree probing.
- Security design principles: full statement in `docs/security-principles.md` (12 principles + a "directions, not shipped" section for capability-aware authorization), with a condensed "Design principles" section in both READMEs; claims are checked against actual behavior (no sandbox layer in the gate's own pipeline, platform gaps stated as documented differences rather than parity claims)
- README slimming (~25%): user-rules reference and host implementation notes moved to a new `docs/configuration.md`; the self-protection section keeps the essentials with the differential-disposal narrative in ADR-0001; pipeline diagram annotations reduced; comparison tail de-duplicated

## [0.5.2] - 2026-09-01

### Fixed

- A malformed `pi-verdict.json` (e.g. a trailing comma) no longer silently loads empty user rules: the parse failure is reported through the session-start skip channel (the built-in floor and self-protection layer were never affected) (#25)
- Danger-regex matching is capped at 8192 characters: very long separator-free commands could backtrack quadratically and stall adjudication; beyond the cap the call falls to the classifier (fail-closed direction) (#25)
- npm package-directory installs: the tamper-detection baseline now covers every file in the package directory (node_modules/.git excluded) — write protection already covered the whole dir, but only the entry file was watched, so a tampered manifest would have loaded next session undetected (#26)

## [0.5.1] - 2026-09-01

### Security

- S-rules (S0–S3) now match case-insensitively and S1 gains the macOS firmlink prefixes (`/private/etc`, `/private/var`): on case-insensitive filesystems (default macOS APFS, Windows) case variants name the same file but previously missed the case-sensitive regexes when the target did not exist (realpath cannot normalize a nonexistent path), and firmlink real spellings silently allowed where the `/etc` spelling went gray. denyPaths comparison folds case on darwin/win32 (linux stays case-sensitive) (#21)
- Path sensitivity floor (S0–S5) and the self-protection write check now match every canonical form of the target path (lexical + realpath, rebuilding from the nearest existing ancestor when the target does not exist yet); the in-cwd write allowance requires all forms to sit inside the session cwd's real path. Fixes a symlink-alias bypass where a single classifier-adjudicated `ln -s` aliasing `~/.ssh` or a `.git/hooks` directory let subsequent reads and cwd-scoped writes through the floor with zero model calls (#20)
- Classifier transcript lines are now line-break-escaped and the tool-call path branch goes through the same sanitize pipeline as commands (zero-width stripping + length cap). A path, command, or user message containing embedded line breaks could previously split its transcript line and forge structural lines — e.g. a fake `User:` line instructing the classifier to allow — and tool arguments are model-generated (steerable by prompt-injected file contents), so the surface was real. The escape covers `\n`, `\r\n`, lone `\r` and the Unicode separators U+2028/U+2029/U+0085, which models may render as breaks (#22)

### Changed

- Documentation alignment (#23): classifier timeout documented as 25s (en/zh READMEs; code and the measured p90 basis say 25s, docs said 15s); the volatile offline-test count removed from the dev section; the Status & limitations sections now state two floor scope boundaries explicitly — bash command strings are matched by the danger regexes only (`cat ~/.ssh/id_rsa` goes to the classifier, not the deterministic S0 deny), and on Windows the built-in floor covers bash-shaped patterns only, PowerShell-native dangerous commands rely on the classifier
## [0.5.0] - 2026-08-31

### Added

- `denyPaths`: user-declared protected paths (#16, [ADR-0002](docs/adr/0002-deny-paths-deterministic-ask.md)):
  - plain-path list in `config/pi-verdict.json`; the tool owns normalization — `~`, `$HOME/`, relative, `..`, symlink spellings all resolve, compared per path segment; anchored once per session, so cwd drift or mid-session symlinks cannot re-anchor the declaration
  - any touch — file tools by their path, bash by path tokens from the command string (heredocs included) — triggers a terminal **ask** the user adjudicates; headless sessions degrade to deny
  - priority: after user `deny`, before user `allow` (not even your own allowlist may touch these); unaffected by `builtinDenyFloor: false`; subject to the master switch
  - the classifier sees only a fixed existence hint — zero path plaintext; the matched path appears solely in the local confirm dialog, never in block reasons or notifications
  - `/automode` shows the active count; the config template gains the field; invalid entries warn once at session start
  - known holes (substitution, base64, script contents, spaces, final-segment globs → classifier vigilance) documented in the README and frozen by regression payloads

### Changed

- Footer status colors: `auto mode on` renders in success green, `auto mode off` in warning yellow (was accent/dim) — an ungated session stays visible at a glance instead of fading into the dim channel. Semantic theme colors adapt to light/dark themes; the `/automode` notifications are unchanged

## [0.4.1] - 2026-08-31

### Changed

- 定位语统一为「极简权限门禁」——README 双语标语、AGENTS.md 与 npm `description` 同步(随本发布生效于 npm registry 与 pi.dev 包目录);「几百行极简代码」要点在特性列表置顶;用户规则小节标题改用完整路径 `~/.pi/agent/config/pi-verdict.json`;「为什么没有内置白名单」段首加粗。纯文档与包元数据表述优化,无代码变更

## [0.4.0] - 2026-08-31

### Added

- 主开关 toggle 快捷键(#15):默认 `ctrl+shift+a` 一键切换 Auto Mode 开/关,静默反馈(footer 始终显示为唯一确认,不弹通知)。`config/pi-verdict.json` 新增 `toggleShortcut` 字段——任意 pi 键组合可重绑,`null`/空串禁用,非法组合会话启动时一次性警告并跳过注册(对齐 `classifierModel` 的降级模式),新会话生效。与 `/automode on|off` 语义等价:运行中生效、无确认弹窗、不持久化写回(扩展运行时从不写自己的受保护配置,ADR-0001「仅用户手编」边界不变);`/automode` 状态输出 Usage 行同步显示当前键位

## [0.3.1] - 2026-08-29

### Changed

- 文档(en/zh README、本文件 0.2.0 条目):移除「第三方安全审计」表述,统一为事实性描述——规则层绕过测试 8 项发现、每项可复现载荷、0.2.0 架构性移除内置白名单

## [0.3.0] - 2026-08-27

### Added

- 自保护层(self-protection layer,ADR-0001):门禁自身文件不可被 agent 侧修改——`config/pi-verdict.json` + 扩展安装副本(运行时 `import.meta.url` 自锚定,覆盖单文件/npm 目录两种安装形态,dev checkout 除外)。write/edit 走 realpath 归一化精确比对(防 symlink 旁路);bash/powershell 命令串覆盖字面量/`~`/`$HOME`/`$PI_CODING_AGENT_DIR` 拼写;读放行;不可经任何配置豁免(`builtinDenyFloor: false` 关不掉,用户 allow 越不过)。`~/.pi/agent/` 全域(mcp.json、skills 等)显式不在保护范围——需要该层保护的用户应经用户规则 deny 正则自表达(ADR-0001 否决项)
- 变更检测(ADR-0001):受保护文件 `session_start` 全文快照,每次裁决前复核,处置按文件差分——扩展副本被改或无 UI → 从内存快照自动还原 + 本会话 fail-closed;交互会话中仅配置文件被改 → `ctx.ui.select` 双选处置,选项文案即动作(Accept = 重建基线会话照常,Decline = 回滚 + fail-closed;关闭对话框取安全侧同 Decline);会话间隙合法手工编辑照旧新会话生效

### Changed

- `builtinDenyFloor: false` 语义收窄:只关闭内置危险正则与路径敏感度拦截,不再能间接关闭自保护层;配置模板 `_hint` 同步说明
- README(en/zh):管线图新增第 0 层;新增「自保护」小节;限制清单补充 bash 子串正则可被混淆、跨会话基线为二期、dev checkout 不受保护的诚实声明;测试计数 42 → 62
- 文档清理:移除根部过时研究笔记(research-pi-auto-mode.md、research.md)
## [0.2.4] - 2026-08-27

### Changed

- package.json `description` 对齐 README 一句话定位(pi.dev catalog 列表页与 npm 搜索结果显示该字段,旧值为高密度技术罗列)
- 文档清理:移除 research/pi-observational-memory.md,README(en/zh)微调

## [0.2.3] - 2026-08-27

### Changed

- 运行时 UI 提示统一英文化:bash 危险规则 reason、路径敏感度 reason、用户规则 reason、分类器失败诊断、影子缓存摘要/标注、notify/confirm 文案、配置模板 `_hint` 与 block reason 前缀;代码注释保持中文,测试断言同步(42 项全过)
- README 开头重写(en/zh):一句话定位(pi 的 Claude Code auto mode 式权限门禁)+ 机制三要点列表;新增「问题 / 为什么是三态」小节,Quick start 上移至品类对比之前;弃用非官方术语 YOLO(pi 文档无此词,问题陈述改用 pi 官方表述并附安全文档链接)

## [0.2.2] - 2026-08-27

### Changed

- package.json 元数据接入 pi 官方包目录(pi.dev/packages):keywords 新增 `pi-package`(目录收录条件,实测对比已收录/未收录包确认)与 `extension`(目录类型标签显示为 extension 而非泛化 package);新增 `pi` manifest 显式声明 `extensions/` 资源(此前依赖约定目录发现);README 安装段同步目录链接
- keywords 新增 `auto-mode`/`automode`(对齐直接对标包 @czottmann/pi-automode 的主流写法,命中 /automode 命令名与仓库名搜索;经评估不引入 claude/claudecode —— 本包为 pi 扩展而非 Claude Code 插件,误导性关键字与诚实定位相悖,且两个直接竞品均未使用)

## [0.2.1] - 2026-08-27

### Added

- 配置文件支持 `classifierModel`(provider/id):分类器模型持久配置;优先级 CLI flag > env > config > 自省;无效值回退会话模型并一次性警告(与非法正则同款「不失效」处置)
- spec 支持 pi 原生思考级别后缀 `provider/id:thinking`(对齐 pi `--model` 语法):`off`(缺省,显式关思考)/`low`/`medium`/`high`/`xhigh`/`max` 经 adaptive effort 送达,`minimal` 映射 `low`;无效后缀警告一次并忽略
- README 基于收敛分析更新定位(#14):诚实框架 + 证据库七份

## [0.2.0] - 2026-08-26

### Changed

- 规则层重构:移除内置 bash 白名单,改为**用户可配置** allow/deny 正则(`<agentDir>/config/pi-verdict.json`,黑名单优先于白名单,首启生成模板);内置危险正则 + 路径敏感度保留为 deny floor(默认开启,`builtinDenyFloor: false` 可整体关闭)
- 分类器超时 15s → 25s(本网关 CC 分类器分布 p90=19.8s,15s 会误杀约 15%,见 `research/cache-sim/`)

### Security

- 规则层绕过测试 8 项发现全部修复(`research/rule-layer-security-audit.md`):V1-V7(内置白名单结构性绕过)由架构重构**结构性消除**——无内置白名单即无短路通道;V8(S0 密钥清单遗漏)扩充 `.netrc/.npmrc/.pypirc/.envrc/.vault-token/.kube/.docker config.json/.gem credentials`;全部 8 攻击载荷进回归测试(36 桩测试)

### Added

- `research/pi-automode-convergence.md`:与 @czottmann/pi-automode 的收敛度对照——架构已收敛(10 项趋同),残余差异分级(本质:floor 可关/极简形态/方法论;可复制:三态 ask/AST 规则/防篡改);战略建议 B 独立实验场+A 上游输送(#14)
- `tests/auto-mode.test.ts`:21 个离线桩测试(规则层/分类器重试矩阵/影子缓存 observe-only/命令语义/debug 标注)——开发期冒烟三件套转正入库
- `.github/workflows/ci.yml`:push/PR 上 typecheck + test(bun)
- `.github/workflows/publish.yml`:v* tag 触发 npm 发布(OIDC trusted publishing + provenance,tag/版本一致性断言,pack 白名单检查)
- `package.json`:npm 发布就绪(去 private、main 入口、files 白名单、peerDeps 可选声明、keywords/repository)
- `research/pi-permission-landscape.md`:权限自动裁决品类竞品全景——7 项目一手调研(czottmann/pi-automode、gotgenes/pi-permission-system、cc-safety-net、r4vi/pi-auto-mode、flaxodev/pi-perms、zhushanwen/pi-permission、wangzexi/pi-auto-approve),定位结论与 README 措辞启示(#10)
- :MIT 许可证(开源准备)

- 影子缓存遥测(observe-only):灰区裁决同步回放双键 LRU(128) 的 would-be 命中率,只记录永不生效,为 #5「是否引入生效缓存」积累实测数据;`/automode` 附带会话统计(命中率/miss 构成/命令重复/反事实分歧),`PI_AUTO_MODE_DEBUG=1` 时通知附 would-hit/miss 标注(#7)
- `--auto-mode-debug` CLI flag:开启全量裁决通知与影子缓存标注,等价并优先于 `PI_AUTO_MODE_DEBUG=1`(pi 配置文件无通用 env 注入机制,flag 为原生开关)

### Fixed

- 分类器灰区系统性 fail-closed(GLM 系思考模型):扩展在 API 层 `complete()` 上传的 `reasoning` 选项并非该层字段(`SimpleStreamOptions` 才有;宽类型 `Model<Api>` 的索引签名使 TS 静默放行,运行时被丢弃)→ 请求不带思考参数 → GLM 按默认 max 档思考烧尽预算/超时。改传 API 原生 `thinkingEnabled: false`(anthropic-messages 栈实测送达 `thinking:{"type":"disabled"}`,GLM 降为 effort low 轻思考+ 两档防御重试(512 → 1024,覆盖空输出/截断/超时/异常与其他 API 长尾)。根因与三层取证:`research/thinking-param-blackhole.md`

### Changed

- README 重写面向 public:英文主文档 + 对等中文 README.zh-CN.md(头部互链);一句话定位(三态裁决)、品类对比轻量表、证据驱动章节(五份研究)、免责声明(非沙箱)、命名说明

- statusline 状态文案明确化:off 态由隐藏改为暗色恒显,双态显示 `auto mode on`(高亮)/ `auto mode off`(暗色)

- `/automode` 命令语义明确化:裸调用改为**只读状态展示**(修复查看即翻转状态的副作用);`/automode on|off` 幂等设定(与现值相同不翻转);未知参数严格拒绝并列出用法,大小写归一化

- `extensions/auto-mode.ts`:Auto Mode 扩展原型 —— 在 `tool_call` 钩子上实现「规则层前置 + 模型分类器兜灰区」的三态裁决(allow / ask / deny)(#3)
  - 规则层:bash 无条件/条件白名单 + 危险正则(对完整命令串匹配)+ 文件路径敏感度六级(S0 密钥 ~ S5 CWD 外)
  - 模型分类器:Claude Code 风格 `<transcript>` 精简转录 + `<verdict>` 前缀输出契约;默认"自省"(继承当前会话模型),可用 `--auto-mode-model` / `PI_AUTO_MODE_MODEL` 指定
  - fail-closed:分类器异常/超时(15s)/输出违反契约 → 拦截;非交互模式 ask → 拦截
  - 透明性:`/automode` 开关命令、footer `🛡️ auto` 状态、拦截通知含裁决理由、`PI_AUTO_MODE_DEBUG=1` 全量裁决通知
- `research/claude-code-classifier-prompts.md`:从 Langfuse 还原 Claude Code 权限分类器提示词(数百条样本/24h)(#4)
- `research/cache-sim/`:裁决缓存收益离线回放——CC 分类器历史裁决(1,2xx 条/2x 会话)双键 LRU 回放,命中率 3.2%、危险分歧 0 例;#5 决议依据与可复现脚本(fetch-io / simulate / kinds)
- `research/rule-engine-sim/`:规则引擎收益测量——746 条真实 bash 调用双引擎交叉回放(tree-sitter AST × 本层),移植收益实测为零、真安全洞为零,真靶点=白名单广度与分类器成本(#6)
- `research/pi-model-call-and-ref-implementations.md`:Pi 扩展模型调用/配置 API 调研与三个开源权限扩展实现提取,含规则层种子集(#2)
- `CONTEXT.md`:领域术语表(Auto Mode / 裁决 / 规则层 / 灰区 / 分类器 / 自省 / fail-closed / 三态裁决 / ask 降级)
- `package.json` + `tsconfig.json`:扩展类型检查(`bun run typecheck`)
