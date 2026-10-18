# Security Design Principles

This document states the security design principles behind pi-verdict (omp fork) and how they map to what is actually shipped. It complements the [pipeline](../README.md#pipeline) section in the README and the [ADRs](./adr/). Where a principle describes a direction rather than shipped behavior, it says so explicitly — this document deliberately makes no claims the implementation does not back.

pi-verdict is a **fail-closed, layered permission gate** for coding agents. It is not a sandbox and does not attempt to formally prove that arbitrary agent-generated programs are safe.

## Principles

### 1. Fail closed by default

When the system cannot establish that an action is safe, it must not silently allow it. Classifier exceptions, malformed verdicts, timeouts, unavailable models, and non-interactive `ask` verdicts all degrade to `deny` — never to automatic approval.

```text
uncertainty → friction     (never: uncertainty → permission)
```

### 2. Deterministic floors come before AI

Some security properties must never depend on an LLM. The built-in deny floor (bash danger regexes + path sensitivity grades) and the self-protection layer adjudicate before the classifier is ever consulted. The classifier may interpret ambiguity; it must not override a hard deny — and neither can user allow rules.

### 3. The classifier judges semantics, not syntax

Coding agents routinely generate long pipelines, heredocs, embedded interpreters, and command substitutions. Regex floors and allowlists cannot realistically classify such payloads, so: **deterministic rules establish the floor; the classifier handles the remaining semantic ambiguity.** With tiered adjudication ([ADR-0009](./adr/0009-tiered-semantic-adjudication.md)), the first semantic pass is local and context-free (LANCET-Nano); only calls it will not clear — and every non-shell call — reach the model that sees the session. A long read-only pipeline may be complex but low-impact; a short heredoc may be syntactically simple but arbitrarily destructive. Decisions focus on what an action *does*, not how it is spelled.

Known limitation, stated honestly: bash-side path extraction is token-level — command substitution and base64-embedded paths produce no floor hit and fall to the classifier's vigilance ([ADR-0002](./adr/0002-deny-paths-deterministic-ask.md)).

### 4. Adjudicate by impact, not by complexity

A long command is not automatically dangerous, and a short one is not automatically safe — so the deciding axis is *impact*, never length or syntactic complexity: long read-only actions can auto-allow; short destructive ones deny or ask. This is what keeps protection meaningful without producing approval fatigue.

### 5. Verdicts are informed judgments, not proofs

A classifier `allow` means "consistent with policy and user intent as far as the model can tell" — it does **not** mean "proven incapable of causing harm." The same applies to Tier 1's `not_flagged`: a local model that saw only the command string found no risk, which is not a proof of safety. That distinction is fundamental to the security model and to why the deterministic floor exists at all.

### 6. Minimize the classifier's trusted input

The classifier receives only what it needs to judge: a condensed transcript (user messages + tool calls, **no tool results**), with the action under review pinned as the last line — hardened against forged-line injection (#22). When denyPaths are configured, the classifier gets an *existence hint* only — it never sees the path plaintext ([ADR-0002](./adr/0002-deny-paths-deterministic-ask.md)). This limits indirect prompt-injection surface without starving semantic adjudication.

### 7. Protected resources are matched by canonical identity

Path decisions use canonical filesystem identity, not lexical strings: lexical + realpath dual-form matching (#20), case folding on case-insensitive filesystems, macOS firmlink prefixes (#21), relative/`~`/`$HOME`/env-var spellings, and ancestor-realpath reconstruction for not-yet-existing targets. A path that merely *looks* workspace-local is not trusted as workspace-local.

### 8. The gate guards itself

The agent must not be able to rewrite the gate and immediately benefit from the rewrite. The self-protection layer ([ADR-0001](./adr/0001-self-protection-layer.md)) — not disableable by any configuration — protects the user-rules config and the extension's own installed copy (the omp plugin layouts and the plain extension dir), with tamper detection as the backstop for rule-layer bypasses (#26, #35).

### 9. User policy may restrict, and may only weaken by explicit opt-in

User rules are the user's own security declarations (deny beats allow; denyPaths are the stronger declaration channel). The self-protection layer cannot be weakened by anything. The built-in deny floor *can* be turned off — but only by an explicit, documented `builtinDenyFloor: false` in the user's own config file, i.e. a deliberate downgrade the user owns, never a silent or accidental weakening.

### 10. Platform differences are documented, not silently weaker

Security semantics must not silently degrade just because an action is expressed differently. Where full parity is not shipped, the gap is documented instead: on Windows the built-in floor covers bash-shaped patterns only — PowerShell-native dangerous commands rely on the classifier, which fails closed (see [Status & limitations](../README.md#status--limitations)). MCP tools (`mcp__*`) adjudicate in the gray zone with the classifier backstop, and `ignoreTools` entries are matched against normalized tool names.

### 11. Optimize for safe automation, not maximum automation

The objective is to maximize useful automation while minimizing unsafe automatic execution. Both extremes lose: "everything → ask" breeds approval fatigue and blind approvals; "everything ambiguous → allow" breeds silent unsafe execution. The three-state verdict exists for exactly this reason — auto-approve clearly low-impact actions, escalate the ambiguous ones, deny what violates hard policy.

### 12. A permission gate, not a sandbox

pi-verdict makes tool authorization safer and more explainable; it provides no OS-level isolation. For strong guarantees, stack it with what it deliberately is not: OS sandboxing, container isolation, filesystem/network restrictions, least-privilege execution. The strongest model is a *policy gate + semantic adjudication + technical isolation* — never any single mechanism.

## Directions (not yet shipped)

**Capability-aware authorization.** Decisions today key off tool names, paths, and command strings, with the classifier covering uncovered tools (MCP and custom tools land in the gray zone by construction — no user rule silently covers a tool it does not name). Expressing policy in terms of capabilities (`filesystem.write`, `network`, `credential-access`, `destructive`, …) instead of command spellings is a direction we find right, and it is not implemented today. When it ships, this section moves into the principles above.

## Summary

```text
                     Tool Call
                         │
                         ▼
              ┌─────────────────────┐
              │ Self-protection +   │
              │ deterministic floor │   (regexes, path grades, denyPaths — no LLM)
              └──────────┬──────────┘
                 deny ◄──┼──► clearly safe → allow
                         │
                       gray
                         ▼
              ┌────────────────────┐
              │  LLM classifier    │   (semantic judgment, fail-closed)
              └─────────┬──────────┘
                        ▼
              allow / ask / deny     (ask → human; non-interactive → deny)
```

Optionally stacked *outside* the gate: OS sandboxing / container / filesystem & network restrictions — pi-verdict complements isolation, it does not replace it.

> **Core principle: deterministic controls for what must never be allowed, LLMs for what syntax alone cannot decide, technical isolation to limit the consequences of inevitable mistakes.**
