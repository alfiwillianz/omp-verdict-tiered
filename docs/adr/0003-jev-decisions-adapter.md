# 0003 - Jev decisions adapter: a non-generative model as the classifier backend

---
status: historical — superseded by ADR-0005, and not present in the omp fork
date: 2026-09-19
---

> **Fork note.** This ADR records the original pi-era design. The adapter extension it
> describes (`extensions/jev-adapter.ts`) was deleted upstream in 0.13 when pi gained
> native classifier support (ADR-0005). This omp fork reaches judgment models through
> omp's typed-judgment client instead, so no adapter exists here either. The record is
> kept because the research basis, the criteria, and the failure discipline still
> describe the classifier's contract.

## Background

TypeSafe's jev (released 2026-09-15) is a **decisions-modality** model: it takes unstructured state in and returns schema-constrained typed decisions (a chosen value plus a probability distribution and a confidence), generating no text. OpenRouter serves it only through the dedicated `POST /api/alpha/decisions` endpoint (`chat/completions` rejects it with an explicit 400), and it does not appear in the public model catalog. The original host's `openrouter` provider spoke chat completions only, while `classifierModel` resolved through the host model registry — jev could not enter that system without an adapter.

Research findings (`research/typesafe-jev-classifiermodel.md`, later revised and extended by `research/jev-classifier-model.md`): the classifier task maps exactly onto jev's `choice` primitive (a three-way allow/ask/deny pick); live in-repo measurements showed ~1.2 s latency and ~$0.000015 per call. However, TypeSafe's own jaggedness docs concede that **"State is data, and `jev-1.13` does not treat it as hostile by default"** — adversarial content can move its judgment, and the classifier's state is precisely a transcript containing untrusted file content.

## Decision (as originally made)

1. **Second bundled extension, lazily effective**: `extensions/jev-adapter.ts` shipped in the same package and registered `typesafe/jev-latest` via the host's provider registration. Unless `classifierModel` pointed at it or credentials resolved, the adapter took no part in adjudication.
2. **Credentials reuse the host's system, no second channel**: two transports shared one adapter; the OpenRouter transport resolved the host's provider auth, the TypeSafe transport read `TYPESAFE_API_KEY` through the same provider auth pipeline — never a bare fetch or a second credential store.
3. **Translation contract**: state = the classifier request's last user message (the transcript); the question is a fixed allow/ask/deny `choice` (criteria mirror `CLASSIFIER_SYSTEM`, keeping the evidence-not-instruction discipline and the err-on-ask default); the response is synthesized into a user-readable `<verdict>{choice}</verdict> jev: ask 63% (confidence 45%; allow 35%, deny 2%)`.
4. **Failure semantics unchanged**: the adapter set no internal timeout and passed `signal` through; the main extension's 25 s timeout, parse failures, and network errors all landed in the existing fail-closed deny.
5. **Self-protection coverage came for free**: under the same-package npm-dir install form, the adapter copy joined the tamper-detection baseline through whole-package enumeration.
6. **Misuse guard**: selecting a `typesafe/*` model via model selection warned (a decisions model generates no text and cannot drive a session).

## Known limitations (as recorded then)

- **The denyPaths existence hint did not reach jev**: the adapter ignored the incoming systemPrompt, where the hint lived; denyPaths themselves remained rule-enforced before the classifier, so only the gray-zone strictness signal was lost.
- **State injection surface**: jev does not treat state as hostile by default; mitigation rested on the rule layer running first and the main extension's transcript sanitization, but classifier-layer prompt-injection resistance was weaker than the LLM backend's.
- **The reason was a templated probability/confidence line**, not a natural-language explanation.
- The OpenRouter endpoint was alpha and its schema could evolve; TypeSafe's API did not report per-call cost (it surfaced as $0).

## Why it was superseded

Native classifier support landed upstream (ADR-0005), which made the hand-built adapter redundant. In this omp fork the equivalent capability arrives through omp's typed-judgment client: a judgment-kind catalog model answers the same `choice` question directly, with protocol-native probabilities and confidence, so neither an adapter nor a provider registration is needed.

## Consequences

- No adapter ships. `classifierModel` accepts a judgment-kind model spec, and the extension builds the judge from the catalog entry at call time.
- The historical contract survives in the reason line: judgment answers still render the `jev:` probability breakdown, so audit corpora stay comparable across the migration.
- The state-injection caveat is unchanged and still mitigated the same way: the deterministic layers run before the classifier, and the transcript is sanitized.
