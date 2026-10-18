# Diagrams

Source-of-truth authoring specs for the documentation diagrams. The SVG is an
export artifact — regenerate it from the spec instead of editing by hand.

| file | role |
|---|---|
| `security-pipeline.workflow.json` | pipeline-diagram spec (source of truth) |
| `security-pipeline.en.svg` | exported embed for [README.md](../README.md) |

The SVG is dual-theme: it embeds a `prefers-color-scheme: dark` variant and
adapts automatically on GitHub and in most renderers.

## Regenerating

The spec authors with the [archify](https://github.com/tt-a1i/archify) workflow
skill (installed locally, not a repo dependency):

```bash
# 1. validate the edited spec (showcase gate: composition, labels, semantics)
archify validate workflow security-pipeline.workflow.json --quality showcase --json

# 2. render the checked interactive HTML (local artifact, not committed)
archify deliver workflow security-pipeline.workflow.json security-pipeline.en.html --quality showcase
```

Then open the HTML, use **Export → SVG (editable vector, dual-theme)**, and
replace `security-pipeline.en.svg`.

## Baseline

The spec predates this fork's omp port and still describes the upstream v0.14
pipeline, including two features this fork does not ship: the
`subagent-artifacts·headless` rule-layer allow (ADR-0008) and the
`nested·rules-only` policy (ADR-0006). Regenerate the diagram after updating
the spec to the omp pipeline in [README.md](../README.md#pipeline) — the ASCII
pipeline in the README is the current, text-faithful reference.
