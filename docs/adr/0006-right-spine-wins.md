# ADR-0006: The right spine wins; the bottom anchor is retired

Status: accepted (trial outcome); bottom geometry retained behind an unused branch

## Context

Two anchors were trialled: a 40×40 horizontal bar at the bottom of the screen,
and a vertical spine on the right edge. The bottom bar overlapped terminal
status lines and content in actual use (it sat above the Dock and covered the
bottom of the terminal); the right edge is margin in terminal-centric work.

## Decision

The **right spine** is the anchor. The bottom-anchored variant is retired from
the UI: its flip command is removed and the edge constant is fixed to `right`.
The geometry code paths for the bottom anchor remain in place, unused, in case
a future need (e.g. a different display context) revives them.

## Consequences

- Portrait drawers (lists, transcripts, diffs) match the content's natural
  shape; the Dock is never crowded.
- The map's "almost full-screen" expansion is freed from fighting a bottom bar.
- If the bottom anchor returns, it returns as an ADR amendment, not silently.
