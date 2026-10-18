# 0005 - Classifier backends on omp: typed judgments for judgment models, chat completions otherwise

---
status: accepted (rewritten for the omp fork)
date: 2026-10-01
---

The classifier has two possible backends, and which one runs depends on the model the user points `classifierModel` at.

## Judgment-kind models → typed judgments

omp ships a typed-judgment client for catalog models whose API answers structured questions directly: `typesafe` (TypeSafe's System One route, any compatible server), `openrouter-decisions`, `openai-decisions`, and `workers-ai-systemone`. These are **judge-kind** models — they are selected by omp's `judge` role and are not chat transports.

`@oh-my-pi/pi-ai` exposes `createNativeJudge(model, { apiKey })`, which returns a `Judge` with `judge({ state, questions }, { signal })`. The extension asks one `choice` question (`VERDICT_QUESTIONS.verdict`) whose criteria mirror `CLASSIFIER_SYSTEM`, with the transcript under `state.transcript`. The answer carries `choice`, `probabilities`, and `confidence` — protocol-native material, which is what the confidence floor gates on.

This path replaces pi's `ModelRegistry.classify()`: same shape of contract (one structured call, no prompt round-trip), different host API. The reason line keeps the historical `jev:` probability breakdown for the System One family (`typesafe`, `workers-ai-systemone`, `openrouter-decisions`); `openai-decisions` and any chat model render `classifier:`.

## Chat models → the prompt contract

Everything else — a `provider/id`, a bare id, or a role alias such as `@smol` — resolves through omp's `ctx.models.resolve()` facade and runs the chat path: a system prompt stating the three verdicts, the condensed transcript as the user message, and a `<verdict>allow|ask|deny</verdict> reason` reply. The call goes out through `completeSimple` with `apiKey: registry.resolver(model, sessionId)`, so omp's auth rotation, OAuth refresh, and provider quirks stay host-owned.

The chat path carries **no numeric confidence** — a free-text reply has none — so the confidence floor is inert there. That is the documented behavior, not a bug: a chat model's verdict is either taken as stated or fail-closed, and `classifierFallbackModel` exists for a second opinion.

## Resolution order

1. `--auto-mode-model` flag
2. `OMP_AUTO_MODE_MODEL` environment variable
3. `classifierModel` in `omp-verdict.json`
4. the session model (self-reflection)

A spec that does not resolve, or resolves to an entry without configured auth, falls back to the session model with a one-shot warning. Judgment-kind entries are skipped for Tier 2, which needs a generative JSON answer.

## Consequences

- **The confidence floor keys on protocol-native confidence**, so it applies to judgment models only. ⚠️ Corpus comparability: demoted rows require a judgment backend; cross-version analysis must treat the demoted population as backend-dependent.
- **The reason line keeps the probability breakdown for the System One family.** The audit record's `rawResponse` keeps the full contract line (tag included), mirroring the chat path's rawResponse.
- **A thinking suffix on a judgment model warns once and is dropped** — there is no reasoning to configure. On a chat model the suffix stays effective.
- **Carried-over limitation**: `VERDICT_QUESTIONS` has no denyPaths criteria variant. The existence hint is appended to the chat system prompt only; judgment models never saw it (parity with the adapter era).
- **No provider registration, no adapter extension.** A judgment model is a catalog entry; the extension builds the judge at call time.
