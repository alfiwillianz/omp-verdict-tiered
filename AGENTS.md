# AGENTS.md

## General

- Language convention: all docs, code comments, CHANGELOG entries, and release notes are written in English (this fork is English-only)
- Technical writing uses precise standard terminology; do not invent colloquial metaphors. If a concept needs a short form, use the standard term or annotate its meaning in parentheses on first use.
- YOU MUST: keep docs in sync with behavior — README.md / CHANGELOG.md (`[Unreleased]`) / CONTEXT.md for terminology / docs/adr/ for architecture decisions / the config template and docs/configuration.md

## Project

This repository is **omp-verdict-tiered**, the omp (oh-my-pi) fork of [pi-verdict](https://github.com/jesset/pi-verdict): a minimal permission gate extension (rule layer + model classifier). Read `CONTEXT.md` (glossary) and `docs/adr/` before touching domain terms or design decisions; design conclusions are backed by the measurements under `research/`.

### Gate self-reference (ADR-0001)

The extension's own security boundary is guarded by the extension itself, which constrains the development workflow:

- The agent cannot write `<agentDir>/config/omp-verdict.json` or the installed copy under `<agentDir>/extensions/` — the self-protection layer always denies, and no configuration exempts it
- Testing a new version = the user copies it into place from a terminal and restarts omp (the agent doing it would be blocked; the tiered line is multi-file, so install the package directory rather than copying the entry file). User-rule edits are the same: manual only.

### Release

- Release sequence: a `chore(release): bump version` commit, an annotated tag, and a GitHub Release; `gh release` is terminally blocked by the built-in deny floor, so the user runs it in a terminal
- This fork is published to npm as `omp-verdict-tiered`, versioned `<upstream-version>-omp.<n>` (see [docs/installation.md](docs/installation.md#versioning)). Publishing runs from the tag-driven `Publish` workflow; a local `npm publish` is the fallback when Actions is unavailable.

## Agent skills

### Issue tracker

Issues live as GitHub issues in this repo, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five default triage labels — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` — each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: a root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## Git conventions

- Feature branch naming: `feat/description-with-dash-separated-and-MAY-contain-issue-number`
- YOU MUST: always use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) when committing
- YOU MUST: update CHANGELOG before merging to main, following <https://keepachangelog.com/>
- YOU MUST: never commit code changes without the user's permission

## Tools

- When you need to read source from a GitHub project, you can always use the locally installed GitHub CLI (`gh api`)
- When you need to temporarily clone open-source code, use `/Volumes/RamDisk` instead of `/tmp` as the temporary directory
