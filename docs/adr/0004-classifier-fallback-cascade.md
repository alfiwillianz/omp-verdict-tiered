# 0004 - Classifier fallback cascade: uncertainty-gated second layer (shadow-first until the 2026-09-26 default-mode amendment)

---
status: accepted
date: 2026-09-21
---

## Background

The first-layer classifier (typically jev via `classifierModel`, ADR-0003) is fast (~1.2s, near-free) but under-judges at the margin: the local verdicts corpus (646 records, `research/classifier-fallback-model-feasibility.md`) shows jev already emits calibrated probabilities yet the pipeline consumed only the choice — 23 of 403 jev allows carried confidence below 50% (several with deny probability ≥ 35%) and were allowed anyway. A natural A/B in the corpus (one full day of jev, one of a haiku-class LLM) showed the stronger model resolves more and over-blocks some — evidence for depth, but not enough to forfeit the fast path for the ~82–94% of calls that need no depth.

The literature's answer to exactly this tradeoff is the LLM cascade (FrugalGPT, arXiv 2305.05176; RouteLLM, lmsys): a cheap first layer plus a gate that escalates only uncertain calls to a stronger second layer. The two originally proposed shapes were both rejected on the corpus evidence — fallback-for-asks-only (the ask population is too small for the payoff) and judge-everything (doubles cost on every call; LLM-as-judge reliability is itself limited).

## Decision

> **Amendment (2026-09-21, #67) — autonomy-floor semantics.** The sections below are the
> original 0.10.0 design. #67 reworked the gate from "when to consult a second opinion"
> into "who holds adjudication authority": `classifierFallbackConfidence` is renamed
> **`classifierMinConfidence`** (`number | null`, default null = off; the old key warns as
> renamed and is ignored — clean break in 0.11.0, no alias) and now means an **autonomy
> floor** — a jev verdict with confidence strictly below it is **demoted**, whatever the
> verdict (allow/ask/deny alike): cascaded to the fallback if configured, else asked of
> the human (headless → deny). The floor is a first-layer rule, independent of
> `classifierFallbackMode`, and works standalone — fixing the 0.10.0 wart where the
> threshold was inert without a fallback model. Consequences for the sections below:
> - Trigger set is now **demotion + fail-closed only** — the ask trigger is gone: a
>   high-confidence ask goes straight to the human (saves a call, respects the first
>   layer's confident request).
> - Decision 4's **safety ratchet is superseded**: under enforce the fallback **adjudicates
>   de novo**, with exactly one carve-out — a demoted first-layer **deny** that the
>   fallback would allow is asked of the human, never auto-allowed. Every other
>   combination applies as the fallback rules (a demoted allow can be re-allowed: the
>   absorb direction the cascade exists for).
> - Decision 5's failure semantics are refined: on a cascaded call, a failed or
>   unresolvable fallback **asks the human** (the tier that was to adjudicate is down;
>   headless → deny) — the first layer abstained, so there is no verdict to fall back to,
>   and nothing degrades silently.
> - Decision 6's "no exception for first-layer absence" is superseded with it: a
>   fail-closed origin under enforce is adjudicated de novo by the fallback (including
>   allow); shadow keeps the deny and records the opinion.
> - Shadow's promise is narrowed to what it always meant: **the second layer never changes
>   a verdict**; the demotion itself is deterministic first-layer behavior, active in both
>   modes whenever the floor is set.
> - Audit: records carry `demoted: true` when the floor fires; non-interactive asks of any
>   origin (native, demoted, escalated) record as their effective deny per the standing
>   convention; `fallback.effective` holds the applied verdict on enforce rows (failure
>   rows carry the `"ask"` the human got). Stats counters: triggered / agreed / overruled
>   (would-overrule in shadow) / errored.
> - LLM first layers emit no numeric confidence: floor and cascade are inert for them
>   (unchanged from the original design).

1. **Uncertainty-gated cascade, opt-in** via three config keys: `classifierFallbackModel` (`provider/id[:thinking]` spec, same format/validation as `classifierModel`; the feature is entirely off unless set), `classifierFallbackConfidence` (0–100, default 50), `classifierFallbackMode` (`"shadow"` | `"enforce"`, default `"shadow"`). Trigger precedence: first-layer **fail-closed → ask → jev confidence strictly below the threshold**. Resolution is config-only (no flag/env precedence) and never falls back to the session model — a second layer silently inheriting the session model would bill the same judgment twice, not add a second opinion.
2. **Confidence is hard-required in the jev adapter**: the decisions contract guarantees `choice + probabilities + confidence` on choice answers, so a missing or non-numeric confidence in `verdictText` throws, joining the existing malformed → fail-closed discipline. Contract drift therefore fails closed — and the cascade's fail-closed trigger means the second layer still runs on those calls. `parseJevConfidence(reason)` is exported for the gate; it returns null for non-jev reasons, so **LLM first layers gate on ask/fail-closed only** (they carry no numeric confidence).
3. **Shadow-first rollout** (superseded by the 2026-09-26 default-mode amendment): in shadow (the default then) the second layer runs on triggered calls and its outcome is recorded — an optional `fallback` sub-object on the audit record and session-memory counters surfaced via `/automode` — while the effective verdict never changes. This follows the #7 shadow-cache discipline (observe-only, session-memory stats, never an adjudication input).
4. **Enforce is a safety ratchet**: `effective = stricter(first, fallback)` with allow < ask < deny — the fallback may only escalate strictness, never relax. An escalation annotates the reason (`… (second-opinion classifier escalated allow to deny)`). The fallback receives the full `CLASSIFIER_SYSTEM + DENY_PATHS_HINT` prompt — unlike jev, it sees the denyPaths existence hint (with an LLM first layer, both layers see it).
5. **Failure semantics (grill decision, user override)**: once the user configures a second layer, its silent failure must not quietly degrade the gate to single-layer. In enforce, a failed fallback call (timeout/credential/parse — 15s per attempt) or an unresolvable model **denies the triggered call** through the existing fail-closed lane, and the failure row carries `fallback.effective: "deny"` like every other enforce row; untriggered calls never consult the fallback and stay single-layer. In shadow a failure is recorded (`fallback.error`, errored counter) and changes nothing.
6. **No ratchet exception for first-layer absence**: a no-model fail-closed (first layer never ran) triggers the cascade as well, but the ratchet means the resulting deny can never be relaxed by the fallback — the trigger is observability-only in enforce. An exception would hand adjudication to the second layer whenever the first layer is made to fail, including adversarially.
7. **Audit keeps first-layer semantics at the top level** (grill decision — shadow/enforce corpus comparability, old analysis scripts keep working): the enforced outcome lives in `fallback.effective` (enforce rows only, failure rows included). Evaluators must read enforce rows through the sub-object. Composes with #62: escalated interactive asks carry the sub-object into the deferred record and attach `userAnswer` at finalize.

## Known limitations

- A cascade raises *resolution*; it is not an injection defense — both layers read the same transcript, and jev "does not treat state as hostile". The rule floor and self-protection layer remain the deterministic backbone.
- Shadow data is only evaluable with the #62 ground-truth fields; without `userAnswer`, agreement rates say nothing about correctness.
- Enforce rows must be read via `fallback.effective` (the top-level verdict is the first layer's) — a documented trap for analysis scripts. On non-interactive records, an `effective` of `ask` was applied as its deny degradation (the usual ask-degradation rule); the top-level `degraded` flag reflects the first layer only.
- Sequential latency: a triggered call may spend the first layer's budget plus up to 15s of fallback budget *per attempt* (the two-tier retry mirrors the first layer's per-attempt 25s, so worst case ≈30s).
- Judge reliability limits apply to the second layer too (self-preference, inconsistency); the ratchet bounds the damage to over-strictness, never over-permissiveness.

## Alternatives considered

- **Fallback for asks only (original shape a)**: dominated — the ask population is the smallest slice; the gate would idle exactly where jev is weakest (confidently-wrong low-confidence allows).
- **Judge every first-layer verdict (original shape b)**: doubles cost on every call for a signal the confidence gate localizes to 6–18% of calls; LLM-as-judge reliability limits.
- **Confidence threshold → direct ask, no second model**: free, but converts uncertainty into precisely the human distraction the feature exists to reduce.
- **Swap the first layer to a strong LLM outright**: available today as a one-line config change; forfeits jev's fast path for the majority of calls that need no depth.
- **Fail-open to the first layer on fallback failure** (recommended in design, rejected by the maintainer in grill): a configured-but-broken second layer would degrade silently; availability is recoverable by fixing the config, silent degradation is not observable.
- **Ratchet exception rescuing fail-closed when the fallback is confident**: rejected — see Decision 6.

## Shadow → enforce flip criteria

Recorded as a minimum bar plus a human decision, never an automatic threshold: at least ~2 weeks of shadow data, an adequate triggered sample, and no ground-truth evidence of fallback false-allows on triggered calls. Flipping `classifierFallbackMode` is a config change effective in new sessions.

## Consequences

- The config surface grows by three keys (template + `_hint` updated); users who configure nothing see byte-identical behavior (pinned by tests: one model call per trigger flavor, non-jev reasons never confidence-trigger).
- `omp-verdict.ts` imports `parseJevConfidence` from the jev adapter (top-level side-effect-free — the import cannot register providers or touch the network; coupling noted in the PR).
- The audit schema gains an optional `fallback` sub-object; consumers ignoring unknown fields are unaffected, and `fallback.effective` is the only place the enforced verdict lives.
- The corpus question "is the first layer reliable?" becomes measurable once #62 ground truth accumulates; revisit shape (b) (judge everything) only if shadow data shows confidently-wrong first-layer allows are common.

## Amendment 2026-09-26 (#71)

status: accepted · date: 2026-09-26 · supersedes: the single-carve-out wording in Decision 6, and the fail-closed rows of the top-level audit semantics · grounding: [production audit](../../research/classifier-cascade-production-audit-en.md) + grilling dispositions.

**1. The relaxation carve-out covers every negative first-layer verdict, not only deny.** Under enforce, a demoted **ask** that the fallback would allow is now asked of the human (headless degrades to deny), exactly like the existing demoted-deny carve-out. The second layer may not auto-relax any negative verdict; it adjudicates freely elsewhere (demoted allow → anything, demoted ask → ask/deny). A **fail-closed** origin keeps full de novo authority including automatic allow: an absent layer emits no negative verdict, so the fallback's allow is a first ruling, not a relaxation — the alternative would turn a first-layer outage into full-session manual confirmation (observed: 26 consecutive failures inside one 178-call session). Rationale: relaxation errors are irreversible where over-ask errors cost one confirmation; production showed 24 ask→allow relaxations of which ~2 were genuinely contentious after the side-effect-free tools moved to `ignoreTools` (#69), costing ≈1 confirmation/day.

**2. An enforced fail-closed rescue records the applied verdict at the audit top level.** `source` stays `"fail-closed"`; `verdict` now carries the fallback's effective ruling instead of the pre-cascade default deny. Grounding: all 26 observed fail-closed rows carried `verdict: "deny"` while 25 were actually allowed — deny-rate statistics were distorted. Shadow rescues (no `effective`) keep the deny, which is the real outcome there. Reading-discipline change for analysis scripts: from this version on, fail-closed rows mean "first layer absent; verdict as applied", no longer "denied".

**3. `/automode` cascade summary counts `rescued-allow`** (fail-closed origin the fallback ruled allow; `would-rescue-allow` in shadow) distinctly from `overruled`.

**Costs:** enforce users gain ≈1 confirmation/day (the relaxed-ask population); cross-version audit analysis must treat fail-closed verdicts as version-dependent (before: always deny; after: the applied ruling).

## Amendment 2026-09-26 (default mode)

status: accepted · date: 2026-09-26 · supersedes: the shadow-by-default decision in this ADR's Decision section · grounding: the [production audit](../../research/classifier-cascade-production-audit-en.md).

**`classifierFallbackMode` now defaults to `"enforce"`** (0.12.0). `shadow` remains available as an explicit opt-in. Users who configure `classifierFallbackModel` without a mode get an active second layer; `/automode` shows a one-line activation hint whenever a configured second layer sits in shadow.

Rationale:

- The shadow-first default protected an unvalidated enforce semantics. That validation has since happened: the production audit (1265 verdicts, two hosts) exercised every layer boundary, and #71 tightened the exposure surface to its minimum — the fallback can no longer auto-relax any negative first-layer verdict (deny or ask), so the worst-case failure mode shadow was guarding against is structurally closed.
- The per-user observation period ("flip to enforce after ~2 weeks of shadow data") has diminishing value for new users: the cascade's behavior is now characterized; each user re-walking the shadow phase adds little signal.
- Known cost, accepted: configurations that set `classifierFallbackModel` but no mode change semantics on upgrade (shadow → enforce, records-only → adjudicating). The population is small (the keys shipped days earlier) and the change is loud in the CHANGELOG.

The flip criteria above are retained for their remaining use: an individual user deciding whether *their* second layer earns trust in their environment.

## Amendment 2026-09-28 (#81)

status: accepted · date: 2026-09-28 · supersedes: the confidence-gate criterion wherever this ADR words it through the output format (Decision 2's "returns null for non-jev reasons" framing, and the 2026-09-21 amendment's "LLM first layers emit no numeric confidence: floor and cascade are inert for them") · grounding: issue #81 design review (two rounds).

**1. The confidence gate requires protocol identity, not a parseable output format.** Demotion now fires only when the first-layer model **is a decisions model** (`isDecisionsModel` — the protocol api identity) **and** the reason carries a parseable jev confidence segment. Rationale: numeric confidence is a decisions-contract property (Decision 2's hard requirement), not a vendor trait. A format-only criterion mis-detects any LLM whose free-text reason happens to match the `jev: … (confidence N%…)` shape and silently demotes it through a gate that was never meant to apply — the protocol identity is the semantically correct anchor, not a stopgap. Normal paths are byte-identical; only that pathological path changes, from mis-demotion to correct no-demotion.

**2. Corpus comparability.** Pre-0.12.1 corpora may contain demoted rows whose first layer was an LLM emitting jev-shaped reasons; from 0.12.1 such rows cannot exist. Cross-version analysis must treat the demoted population as criterion-dependent. Likewise the audit `thinking` field: pre-0.12.1 jev rows may carry a configured thinking level; from 0.12.1 decisions models record `null` (the suffix was parsed, sent, and dropped) — that field's semantics are version-dependent too.

**3. Companion feedback (same issue, no new config keys).** The provider prefix stays the single source of truth — a `classifierBackend`/`classifierType` switch was reviewed and **rejected**: it would create a second source of truth with contradiction states, freezing extensibility against ADR-0003's "any model registered through pi" direction. Instead, four silent gaps surface as runtime feedback: (a) the floor's inapplicability to a non-decisions classifier warns once, neutrally, at the first gray-zone resolution (explicit and self-reflection paths alike; a purely rule-adjudicated session never sees it); (b) an unresolvable jev spec warns with wording naming the two real causes (a host without `registerProvider`, or a missing key), on both layers; (c) a thinking suffix on the jev spec warns once and is ignored; (d) the audit `thinking` field records `null` for decisions models (the suffix was parsed, sent, and dropped — recording it would misstate what ran).

**Upgrade path (named, not built):** when more decisions providers appear, the protocol-family enumeration behind `isDecisionsModel` is the seam to extend — one named protocol family per adapter, never a config switch.
