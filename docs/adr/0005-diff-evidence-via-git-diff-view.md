# ADR-0005: Working-tree diffs via @git-diff-view/react

Status: accepted

## Context

Agent work needs to be inspectable: what actually changed in the working tree.
The evidence must be readable at HUD size, expandable per file, and shaped like
what a runtime would deliver — but the boundary forbids staging, commenting or
editing.

## Decision

- Working-tree changes render as a **stacked diff drawer**: a
  `<details>/<summary>` section per file (sticky header: chevron, file name +
  directory, `+adds / −dels`, kind chip) with **lazy bodies** — the diff mounts
  only when a file is expanded, so nothing heavy renders up front.
- Rendering uses **`@git-diff-view/react`** — the same library, version and
  theming approach as Observatory (`DiffFile.createInstance` + `DiffView`,
  unified mode, dark theme via `--diff-*` variables, truncation guards for
  oversized diffs). Parity over novelty.
- Patch data is **git-shaped unified diff text per file** (`--- /dev/null`,
  `+++ b/path`, `@@ …`, then content lines). The library's parser requires the
  file header before the hunk; bare `@@` strings parse as empty diffs.
- Syntax highlighting via the bundled lowlight highlighter, gated by size
  (≤100k characters / ≤3k lines), language inferred from the path extension.

## Consequences

- When Herdr lands, the mock `patch` field becomes whatever `git diff` emits
  for the session; nothing in the UI changes.
- Evidence only: no commenting, staging, committing or editing.
- Files stay collapsed by default; expansion is one click per file.
