# 0006 - Nested codemode calls: layered exemption policy + audit attribution

---
status: withdrawn in the omp fork (not implementable on omp 18)
date: 2026-10-02
---

> **Fork note.** This ADR is kept for the record. The feature it describes does not
> exist in this fork, and `codemodeNestedCalls` is not a recognized config key.

## What it did upstream

pi ≥ 0.99's codemode runs model-written JavaScript whose tool calls re-enter the `tool_call` pipeline as nested calls (`parentToolCallId` set, ids `<parent>/<n>`). Gating them identically to direct calls amplified cost: gray-zone adjudication is serial, measured at ~350 ms per nested call — a 50-call `Promise.all` batch paid ~17.5 s of pure gating latency, and the 256-call cap ~90 s.

Upstream 0.14 therefore added `codemodeNestedCalls` (default `"gate"` = unchanged identity) with `"rules-only"` as an opt-in layered exemption: nested calls kept every deterministic layer — self-protection, the built-in deny floor, user rules, denyPaths with its terminal ask — and skipped only the classifier plus the confidence cascade, so the gray zone passed. Audit records carried `source: "rule"` and `policy: "rules-only"`, plus `toolCallId` / `parentToolCallId` attribution.

## Why it is withdrawn here

omp's `tool_call` event carries `toolName`, `toolCallId`, and `input` — **there is no `parentToolCallId`**. The host does not expose a parent linkage for calls issued from `eval` scripts or from `task` subagents, and the extension cannot infer one reliably (a subagent session presents as an independent session with its own id; an `eval` script's nested calls arrive as ordinary tool calls).

Without a trustworthy "is this nested?" signal, a `rules-only` mode would either:

- apply to every call (a complete bypass of the classifier — unacceptable), or
- apply to a guessed subset (a guessed exemption is a guessed hole).

Both are worse than not having the feature. The latency motivation also differs on omp: nested calls through `eval` are not capped at 256 per script in the same way, and the tiered path (ADR-0009) removes most of the per-call network cost anyway.

## What remains

- Every call is adjudicated identically, direct or nested.
- Audit records still carry `toolCallId`, so corpora can still distinguish call identity (just not parentage).
- If omp later exposes a parent linkage on the `tool_call` event, this ADR can be revisited; the deterministic-layer split it describes is still the right shape.
