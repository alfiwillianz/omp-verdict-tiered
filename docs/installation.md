# Installing pi-verdict-tiered from source

This repository is the **`pi-verdict-tiered` fork** of [pi-verdict](https://github.com/jesset/pi-verdict), carrying the tiered semantic adjudication work ([ADR-0009](adr/0009-tiered-semantic-adjudication.md)) on top of the 0.15.0 line.

The fork is **not published to npm**. `pi install npm:pi-verdict` installs the upstream package, which has no tiered runtime — install this fork from a clone instead.

## Requirements

| Requirement | Notes |
|---|---|
| pi ≥ 0.99 | `pi --version`; the tiered line targets pi 1.x and needs native classifier support. |
| Bun | Used for dependency install, typecheck, tests, and the Tier 1 setup script. CI uses the latest Bun. |
| git | To clone the fork. |
| Disk and network for Tier 1 | The optional LANCET-Nano bundle is ~111 MB, downloaded once and hash-verified. |

## 1. Clone and prepare the checkout

```bash
git clone git@github.com:alfiwillianz/pi-verdict-tiered.git
cd pi-verdict-tiered
bun install
bun run typecheck
bun test          # optional: offline stub suite
```

There is no emit step. pi loads TypeScript extensions through jiti, so the checkout is the artifact — `bun run build` is an alias for the typecheck, and no `dist/` is produced.

`bun install` is not only for development: the tiered runtime imports `onnxruntime-node` lazily, and `scripts/setup-lancet.ts` uses `@xenova/transformers` for its tokenizer cross-check. Without the checkout's `node_modules`, Tier 1 cannot load and the setup script cannot verify the bundle.

## 2. Install the package into pi

### Option A — local checkout (recommended for a fork)

```bash
pi install "$PWD"
```

pi records the resolved path in `~/.pi/agent/settings.json` and loads the extension **in place**; nothing is copied. Keep the clone at that path — moving or deleting it breaks the install. Re-run `bun install` after dependency changes, then restart pi or run `/reload`.

Because the loaded extension sits in your checkout, the self-protection write layer treats it as a dev checkout: your edits are legitimate and are not blocked (the user config remains protected). That is the intended workflow for a fork.

### Option B — git install

```bash
pi install git:github.com/alfiwillianz/pi-verdict-tiered
```

pi clones the repository into `~/.pi/agent/git/github.com/alfiwillianz/pi-verdict-tiered` and installs its dependencies. This is the reproducible form for using the fork without editing it. Update with:

```bash
pi update git:github.com/alfiwillianz/pi-verdict-tiered
```

Changes made in a local clone do not affect a git install; push to the fork (or switch to Option A) to ship edits.

> **Self-protection note.** The install-copy protection recognizes `<agentDir>/extensions/` and the omp `plugins/node_modules/` layouts. pi 1.0's managed package locations — `<agentDir>/npm/node_modules/…` and `<agentDir>/git/…` — are not yet in that set, so a pi-managed git install loads without the tamper-detection baseline on its own copy (the user config stays protected). Option A has the same property by design: dev checkouts are out of scope ([ADR-0001](adr/0001-self-protection-layer.md)). Keep the checkout read-only if that matters to you.

### Option C — one invocation, no settings entry

```bash
pi -e "$PWD"
```

Loads the package directory for this run only. Loading `./extensions/pi-verdict.ts` from inside the checkout also works because its sibling `src/` tree stays resolvable; the caveat below applies to a copy taken out of the checkout.

### Do not install the single file if you want tiered adjudication

`extensions/pi-verdict.ts` is the entry point, but the tiered runtime lives in `src/classifiers/`. A bare copy — for example `cp extensions/pi-verdict.ts ~/.pi/agent/extensions/` — has no package tree beside it; a configured `semanticAdjudication` block then falls back to the legacy single-classifier path and stamps `tieredFallback` on the audit record. Install the package directory (Options A–C) to keep Tier 1 and Tier 2.

## 3. Install the Tier 1 bundle (optional)

From the checkout:

```bash
bun run setup:lancet            # ~/.cache/pi/lancet-nano (pinned v0.4.3, hash-verified)
bun run setup:lancet --check    # verify only, no network
bun run setup:lancet --dir DIR  # custom location; must match tier1Lancet.modelPath
bun run setup:lancet --force    # re-download even when the bundle verifies
```

The setup verifies `export.json` against the release manifest digest, every model file against `export.json`, and the tokenizer against `@xenova/transformers`. The runtime re-verifies files on every load; a tampered or missing bundle never produces `not_flagged` — Tier 1 escalates to Tier 2 with a one-shot warning.

Then enable the block in `~/.pi/agent/config/pi-verdict.json` (edit outside pi; the gate denies writes to its own config):

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

Full reference: [configuration.md](configuration.md#tiered-semantic-adjudication-adr-0009).

## 4. Restart and verify

- Restart pi (config and package changes take effect in a new session), or run `/reload` after source-only edits.
- `pi list` shows the package source.
- `/automode` shows the active tiers when `semanticAdjudication` is configured; the footer shows `auto mode on`.
- With `audit: true`, tiered verdict records carry `tier1` / `tier2` sub-objects.

## Updating

Local checkout (Option A):

```bash
cd ~/src/pi-verdict-tiered
git pull
bun install
```

Then restart pi. If the LANCET bundle pin changed, re-run `bun run setup:lancet --force`; `--check` verifies the current bundle without network.

Git install (Option B):

```bash
pi update git:github.com/alfiwillianz/pi-verdict-tiered
```

## Uninstall

```bash
pi remove "$PWD"                                         # Option A / C
pi remove git:github.com/alfiwillianz/pi-verdict-tiered  # Option B
```

The user config at `~/.pi/agent/config/pi-verdict.json` is not removed; delete it manually if you want a clean slate.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `pi install` rejects the path | Use an absolute path to the checkout; confirm `pi --version` is ≥ 0.99. |
| Package missing after moving the clone | A local install stores the resolved path; re-run `pi install <new-path>` and remove the old entry. |
| Tier 1 always escalates, or warns once | Bundle missing, unverified, or `tier1Lancet.modelPath` points elsewhere. Run `bun run setup:lancet --check`. |
| Audit record has `tieredFallback` | The loaded copy is a bare single file; install the package directory. |
| `onnxruntime-node` fails to load | Run `bun install` in the checkout and restart; confirm the platform has a prebuilt ONNX Runtime binary. |
| Tier 2 always uses the session model | pi 1.0.0 has no `getModelForRole`; the documented fallback is the session model. |
| Config edits have no effect | A new session is required; edit `~/.pi/agent/config/pi-verdict.json` outside pi. |

## See also

- [Configuration](configuration.md) — user rules and the full `semanticAdjudication` reference
- [ADR-0009](adr/0009-tiered-semantic-adjudication.md) — tiered adjudication design
- [Security principles](security-principles.md) — fail-closed and self-protection boundaries
- Upstream project: [jesset/pi-verdict](https://github.com/jesset/pi-verdict)
