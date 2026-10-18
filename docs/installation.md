# Installing omp-verdict-tiered

This repository is the **`omp-verdict-tiered` fork** of [pi-verdict](https://github.com/jesset/pi-verdict), ported to run on **omp (oh-my-pi) only**. It carries the tiered semantic adjudication work ([ADR-0009](adr/0009-tiered-semantic-adjudication.md)) on top of the 0.15.0 line.

It is published to npm as [`omp-verdict-tiered`](https://www.npmjs.com/package/omp-verdict-tiered). A clone is only needed to develop, pin a commit, or read the source.

## Versioning

Releases follow `<upstream-version>-omp.<n>`: `0.15.0-omp.1` is the first fork release built on upstream 0.15.0, and `-omp.2`, `-omp.3`, … are subsequent fork releases that keep the same upstream base. When upstream cuts a new line (say 0.16.0), the fork moves to `0.16.0-omp.1`. Under semver's prerelease rules this sorts **below** the plain upstream version, which is what we want: `npm install omp-verdict-tiered` never resolves to an upstream `pi-verdict` build.

## Requirements

| Requirement | Notes |
|---|---|
| omp ≥ 18.1 | `omp --version`. The extension uses `ctx.models.resolve`, the judgment client, and the plugin layout introduced in 18.1. |
| Bun | Used for dependency install, typecheck, tests, and the Tier 1 setup script. |
| git | Only for a source install. |
| Disk and network for Tier 1 | The optional LANCET-Nano bundle is ~111 MB, downloaded once and hash-verified. |

### Disk footprint

An npm/plugin install is **~530 MB**, dominated by the ONNX runtime: `onnxruntime-node` ships prebuilt binaries for every platform (~288 MB unpacked) and `@xenova/transformers` adds ~138 MB. Both are regular dependencies because Tier 1 needs them at runtime. They are loaded lazily — a session that never reaches a shell gray-zone call does not pay the load cost — but the disk cost is unconditional. On a tight disk, either skip tiered adjudication or install from a clone and prune `node_modules/onnxruntime-node/bin` down to your platform.

## 1. Install the plugin

### Option A — npm (recommended)

```bash
omp plugin install omp-verdict-tiered
```

omp runs `bun install` in `~/.omp/plugins`, records the dependency in `~/.omp/plugins/package.json`, and loads the extension from `~/.omp/plugins/node_modules/omp-verdict-tiered/`. `onnxruntime-node` and `@xenova/transformers` come along as dependencies — see [disk footprint](#disk-footprint). Update with:

```bash
omp plugin upgrade omp-verdict-tiered
```

Pin a fork release explicitly with `omp plugin install omp-verdict-tiered@0.15.0-omp.1`; see [versioning](#versioning).

### Option B — git install

```bash
omp plugin install github:alfiwillianz/omp-verdict-tiered
```

omp clones the repository into its plugins tree and installs dependencies. Useful to track `main` between npm releases; update with `omp plugin upgrade omp-verdict-tiered`.

### Option C — local checkout (development)

```bash
git clone git@github.com:alfiwillianz/omp-verdict-tiered.git
cd omp-verdict-tiered
bun install
bun run typecheck
bun test          # optional: offline stub suite
omp plugin install "$PWD"
```

omp records the path in its plugin state (`~/.omp/plugins/omp-plugins.lock.json`) and loads the extension **in place**; nothing is copied. Keep the clone at that path — moving or deleting it breaks the install. Re-run `bun install` after dependency changes, then restart omp or run `/reload`.

Because the loaded extension sits in your checkout, the self-protection write layer treats it as a dev checkout: your edits are legitimate and are not blocked (the user config remains protected). That is the intended workflow for a fork.

There is no emit step. omp loads TypeScript extensions through its own module pipeline, so the checkout is the artifact — `bun run build` is an alias for the typecheck, and no `dist/` is produced.

### Option D — one invocation, no plugin entry

```bash
omp --extension "$PWD"
```

Loads the package directory for this run only. Loading `./extensions/omp-verdict.ts` directly from inside the checkout also works, because its sibling `src/` tree stays resolvable.

### Do not copy the single file if you want tiered adjudication

`extensions/omp-verdict.ts` is the entry point, but the tiered runtime lives in `src/classifiers/`. A bare copy of that one file into an extensions directory has no package tree beside it; a configured `semanticAdjudication` block then falls back to the legacy single-classifier path and stamps `tieredFallback` on the audit record. Install the package (Options A–D) to keep Tier 1 and Tier 2.

The manifest is the `omp` key in `package.json` (`{"omp": {"extensions": ["./extensions"]}}`), so omp discovers `extensions/omp-verdict.ts` as the entry point.

## 2. Install the Tier 1 bundle (optional)

Run it from wherever the package landed:

```bash
# npm or git install
bun run --cwd ~/.omp/plugins/node_modules/omp-verdict-tiered setup:lancet

# local checkout
bun run setup:lancet
```

Flags, in either form:

```bash
bun run setup:lancet            # ~/.cache/omp/lancet-nano (pinned v0.4.3, hash-verified)
bun run setup:lancet --check    # verify only, no network
bun run setup:lancet --dir DIR  # custom location; must match tier1Lancet.modelPath
bun run setup:lancet --force    # re-download even when the bundle verifies
```

The setup verifies `export.json` against the release manifest digest, every model file against `export.json`, and the tokenizer against `@xenova/transformers`. The runtime re-verifies files on every load; a tampered or missing bundle never produces `not_flagged` — Tier 1 escalates to Tier 2 with a one-shot warning.

Then enable the block in `~/.omp/agent/config/omp-verdict.json` (edit outside omp; the gate denies writes to its own config):

```json
{
  "semanticAdjudication": {
    "tier1Lancet": {
      "enabled": true,
      "modelPath": "~/.cache/omp/lancet-nano",
      "riskyThreshold": 0.85,
      "riskyAction": "ask"
    },
    "tier2Role": "adjudicator",
    "tier2TimeoutMs": 20000
  }
}
```

Full reference: [configuration.md](configuration.md#tiered-semantic-adjudication-adr-0009).

## 3. Restart and verify

- Restart omp (config and plugin changes take effect in a new session), or run `/reload` after source-only edits.
- `omp plugin list` shows the plugin.
- `/automode` shows the active tiers when `semanticAdjudication` is configured; the footer shows `auto mode on`.
- With `audit: true`, tiered verdict records carry `tier1` / `tier2` sub-objects.

## Updating

npm or git install (Options A–B):

```bash
omp plugin upgrade omp-verdict-tiered
```

Local checkout (Option C):

```bash
cd ~/src/omp-verdict-tiered
git pull
bun install
```

Then restart omp. If the LANCET bundle pin changed, re-run the setup with `--force`; `--check` verifies the current bundle without network.

## Uninstall

```bash
omp plugin uninstall omp-verdict-tiered
```

The user config at `~/.omp/agent/config/omp-verdict.json` is not removed; delete it manually if you want a clean slate.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `omp plugin install` rejects the path | Use an absolute path to the checkout; confirm `omp --version` is ≥ 18.1. |
| Plugin missing after moving the clone | A local install stores the resolved path; re-run `omp plugin install <new-path>` and uninstall the old entry. |
| Tier 1 always escalates, or warns once | Bundle missing, unverified, or `tier1Lancet.modelPath` points elsewhere. Run `bun run --cwd ~/.omp/plugins/node_modules/omp-verdict-tiered setup:lancet --check` (npm/git) or `bun run setup:lancet --check` (checkout). |
| `bun run setup:lancet` fails with "Script not found" | You are not in the package directory. Use the `--cwd ~/.omp/plugins/node_modules/omp-verdict-tiered` form. |
| Audit record has `tieredFallback` | The loaded copy is a bare single file; install the package directory. |
| `onnxruntime-node` fails to load | Reinstall the plugin (or `bun install` in the checkout) and restart; confirm the platform has a prebuilt ONNX Runtime binary. If `bun pm untrusted` lists blocked postinstalls, allow `onnxruntime-node`. |
| Tier 2 always uses the session model | No `@adjudicator` or `@smol` role is configured; set one in omp's model roles or accept the session-model fallback. |
| A `typesafe/jev-latest` classifier warns "judge-kind models" | Judgment models answer typed questions, not chat completions. That spec works for the classifier only through omp's judge client — if it is not resolving, check the provider credential. |
| Config edits have no effect | A new session is required; edit `~/.omp/agent/config/omp-verdict.json` outside omp. |
| Extension loads but never gates | Another extension or `--no-extensions` may be suppressing discovery; check `omp --verbose` startup output. |

## See also

- [Configuration](configuration.md) — user rules and the full `semanticAdjudication` reference
- [ADR-0009](adr/0009-tiered-semantic-adjudication.md) — tiered adjudication design
- [Security principles](security-principles.md) — fail-closed and self-protection boundaries
- Upstream project: [jesset/pi-verdict](https://github.com/jesset/pi-verdict)
