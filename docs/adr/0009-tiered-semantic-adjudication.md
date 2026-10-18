# 0009 - Tiered semantic adjudication: local LANCET-Nano triage, model-registry escalation

---
status: accepted
date: 2026-10-17
---

The gray zone has been one classifier call since ADR-0005 (a typed judgment or a chat prompt). That call is the gate's dominant per-call cost and its dominant latency source: every ambiguous `bash`/`powershell` command, every uncovered MCP tool, every outside-project write waits for a network round-trip, and a classifier outage turns the gray zone into ask/deny.

The production corpus says most of that spend is unnecessary. Of the gray-zone calls that reach a classifier, the large majority are ordinary developer commands (`ls`, `git status`, `cargo build`, reads inside the project) whose risk is decidable from the command string alone. A local model that is right about those calls removes the network from the hot path; a model that is unsure should still get the full session context.

Decision: a **two-tier semantic pipeline**, opt-in via a `semanticAdjudication` block in `pi-verdict.json`. Absent block → the pre-0.16 single-classifier path, byte-identical.

## Tier 1 — local LANCET-Nano triage

- **Model**: `fingerthief/lancet-nano` v0.4.3, a CodeT5+ 220M encoder with a windowed pooling head, shipped as a 111 MB INT8 ONNX encoder plus a 4.7 MB float head (Apache-2.0 model, MIT runtime). Runs on CPU through `onnxruntime-node`; no network, no API key.
- **Scope**: shell tools only (`bash` on POSIX; `powershell`/`cmd` when omp runs a Windows shell). Non-shell tools bypass Tier 1 — the model classifies command strings, not paths or MCP arguments.
- **Contract reproduced from the reference runtime**: byte-level BPE (`vocab.json` + `merges.txt`), `<s>`/`</s>` framing, 510-payload-token windows with 64-token overlap, mean+max pooling of every payload token exactly once, projection → LayerNorm → 2-way head, banding on the raw risk logit. The **512-token window is the decision ceiling**: longer commands escalate instead of being truncated (a truncated tail can hide the risky part) or scored beyond the model's characterized context. The 8,192-byte cap is the reference runtime's own input limit.
- **Bands**:
  - `not_flagged` → **allow** immediately, zero network activity.
  - `risky` → **ask** (default) or **deny** when `tier1Lancet.riskyAction: "block"`. The task's acceptance criterion allows either; ask is the default because a local model's confident band is still a judgment, and `ask` keeps a human in the loop for a destructive command the user may have explicitly requested. `block` exists for users who want deterministic denial at this tier.
  - `review`, or any abstention (oversized input, tokenizer failure, inference error, missing bundle) → escalate to Tier 2.
- **Threshold**: `tier1Lancet.riskyThreshold` is a calibrated probability (default 0.85). It is mapped back onto the logit scale, so banding stays monotonic and exact; the shipped 0.9912 boundary remains available by setting it explicitly.
- **Integrity**: `scripts/setup-lancet.ts` downloads the pinned revision, verifies `export.json` against the release manifest digest, then every model file against `export.json`, then cross-checks the tokenizer against `@xenova/transformers`. The runtime repeats the per-file digest check on every load; a tampered bundle refuses to load and Tier 1 escalates.
- **Failure direction**: every unexpected condition is `review`, never `not_flagged`. A missing or broken bundle degrades to Tier 2 with a one-shot warning; it never silently allows.

## Tier 2 — model-registry adjudicator

- **Resolution**: omp's `ctx.models.resolve` with role aliases — the configured role (`@adjudicator`) → `@smol` → the session model. `role` defaults to `"adjudicator"` (`tier2Role`). Judge-kind entries are skipped — Tier 2 needs a generative JSON answer, not a label distribution. Entries without configured auth are skipped. Resolution is lazy: a Tier 1 `not_flagged` call never pays it or emits its warning.
- **Input**: a JSON payload with the tool name and arguments, the condensed transcript (the same #22-hardened builder the legacy classifier uses: recent user messages + tool calls, action pinned last, line-break forging defended), and Tier 1's band/probability/reason. The denyPaths existence hint is appended when protected paths are configured (zero plaintext, ADR-0002).
- **Contract**: strict JSON `{"verdict":"allow"|"ask"|"deny","reason":"brief string"}`. Fenced JSON is tolerated; prose, malformed JSON, an invalid verdict or a non-string reason are contract violations and fail closed. No `<verdict>` prefix — that contract belonged to the chat path's text parser.
- **Mapping**: Tier 2 `allow` → allow. Tier 2 `ask` **or** `deny` → **ask**. A model may not auto-deny at this tier: the task's contract reserves automatic denial for Tier 1's risky band, and an ask costs one keypress while a wrong deny is invisible. Headless sessions degrade the ask to deny (the standing rule).
- **Fail-closed**: no resolved model, transport error, timeout (`tier2TimeoutMs`, default 5,000 ms), or unparseable output → ask (headless → deny), `source: "fail-closed"` on the verdict and audit record. The timeout is enforced with `Promise.race`, so a provider that ignores abort signals cannot hold the gate open.

## Position in the pipeline

The tiered path replaces exactly the gray-zone classifier block: after self-protection, the built-in floor, user deny, denyPaths ask, user allow, the ADR-0008 artifact exemption, and the ADR-0006 nested-call policy. Rule-layer allows/denies still outrank it and still cost zero model calls.

`cmd` (Windows) is passed to the model's `cmd` shell profile. Tier 1 only runs when `tier1Lancet.enabled` is true; disabling it sends shell calls straight to Tier 2 with no triage block in the payload.

## Configuration

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

Absent block → legacy path. Invalid values fall back to their defaults and surface through the one-shot `skipped` warning channel, the standing invalid-config discipline. `riskyAction` is an addition to the task's schema: the task's step 4 mentions both `deny` and `prompt` modes without naming a key; `ask`/`block` is the minimal way to expose both without a second boolean.

## Audit

Gray-zone records gain optional `tier1` (`band`, `pRisky`, `riskLogit`, `reason`, `durationMs`) and `tier2` (`model`, `role`, `verdict`, `reason`, `durationMs`, `error`) sub-objects. The top-level `verdict` remains the applied verdict (post-headless-degradation), `source` stays `"model"` for tier-produced verdicts and `"fail-closed"` when Tier 2 failed or was absent — the existing corpus vocabulary is preserved, and tier provenance is additive. A single-file install that configures the block but cannot load the tiered runtime records `tieredFallback` on legacy rows.

## Consequences

- Benign shell commands resolve locally in ~10–15 ms (measured: median 10.1 ms over an 8-command acceptance sample on a 2-thread CPU session, max 16.2 ms; a 100-call latency run measured median 10.6 ms / p90 15.3 ms; the model card reports ~14 ms) with zero network activity — the acceptance target of <15 ms is met at the median and close at p90.
- Ambiguous commands reach a model that sees the session, which the local model cannot; a destructive command explicitly requested in the conversation can be allowed by Tier 2 where a context-free classifier would ask.
- Tier 2 failure now produces an ask rather than a deny (interactive sessions), which is the task's explicit fail-closed contract; headless behavior is unchanged (deny).
- Two new runtime dependencies (`onnxruntime-node`, `@xenova/transformers` — the latter only for the setup-time tokenizer cross-check and test fixtures). A session that never reaches a shell gray-zone call never loads the native binding.
- The local model's own limits are inherited: it misses roughly one in five risky commands and flags about one in eight safe ones at its shipped thresholds; `not_flagged` is not a safety guarantee. The deterministic floor remains the backbone, and Tier 2 covers only what Tier 1 escalates.
- The tiered runtime lives under `src/classifiers/`; the published package ships it, but a bare single-file copy cannot load it. That configuration falls back to the legacy classifier and records `tieredFallback`, rather than losing adjudication.
- Known limitation: Tier 1 sees only the command string. A benign-looking command that is dangerous because of session context (a path the user just discussed, an aliased function) is exactly what Tier 2 exists for — but only if Tier 1 escalates it. The `riskyThreshold` trade-off is the user's: lower means more escalations, higher means more local allows.

## Rejected alternatives

- **Judge every command locally and skip Tier 2**: the local model has no session context and its recall is ~78% on the benchmark; allowing its `not_flagged` is the design, but its `review`/`risky` must not be the last word.
- **Truncate long commands to 512 tokens**: a truncated tail can hide the destructive part; escalation is the safe direction and matches the task's contract.
- **Tier 2 deny → deny**: automatic denial from a model that already sees an ambiguous call inverts the gate's three-state purpose and hides errors; ask keeps the human in the loop.
- **Reuse the legacy `<verdict>` text contract for Tier 2**: a JSON contract is machine-checkable and rejects partial prose; the text prefix was a workaround for a parser, not a design.
- **Always-on tiered mode**: existing configurations must not change behavior on upgrade. The block's presence is the switch; the template ships it commented-in only for new installs (the template is a fresh file, so new users get the tiered path by default).
- **A separate `tier1Action` boolean plus `riskyAction`**: one enum carries the two meaningful modes without a contradiction state.
