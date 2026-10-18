# 0008 - Headless subagent-artifacts write exemption

---
status: withdrawn in the omp fork (no matching host surface)
date: 2026-10-05 (withdrawn 2026-10-18)
---

> **Fork note.** This ADR is kept for the record. The exemption it describes is not
> implemented in this fork.

## What it did upstream

The pi subagent tooling had its agents write working artifacts under `<agentDir>/sessions/<project>/subagent-artifacts/outputs/<run-id>/…`. Those writes are model-issued `write` calls, so they flowed through the gate, graded gray (outside the project cwd), and — because a subagent session has no UI — an ask degraded to deny. The subagent's work failed with no human in the loop and no appeal path.

Upstream 0.14 added a **headless-only** deterministic allow for `write`/`edit` whose every canonical form sits under `<agentDir>/sessions/` **and** carries a `subagent-artifacts` directory segment. Boundary commitments: headless-only (an interactive session keeps its ask capability), the artifacts subtree rather than the whole sessions tree, every-form intersection (symlink aliases earn nothing), positioned after user deny and denyPaths, and scoped to write/edit only.

## Why it is withdrawn here

The exemption keys on a **pi-specific path shape produced by pi's own subagent tooling**. omp's `task` tool runs subagents in isolated worktrees and does not write a `subagent-artifacts` subtree under the agent dir; the path the exemption named does not occur. Keeping the code would create a dormant allow for a path shape nothing writes — a hole with no corresponding need.

The general shape is still worth remembering if an omp-native artifact tree ever appears: exempt exactly the tool-owned subtree, only when no UI exists to ask, and only after user declarations have had their say.

## Consequences

- No `runtimeWritePrefixes` set, no artifact exemption, no `isSubagentArtifactWrite`.
- Headless sessions adjudicate every write through the normal layers: floor, user rules, denyPaths, then the classifier (or the tiered pipeline).
- The lesson recorded in the original ADR still holds: `hasUI` is a proxy, and any future exemption must name a path shape the host actually owns.
