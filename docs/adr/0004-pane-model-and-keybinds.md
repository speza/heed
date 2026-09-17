# ADR-0004: Attention-first pane and keyboard model

Status: accepted

## Context

The HUD needs one place that never moves, discrete surfaces for deeper work,
and a keyboard path that follows user intent rather than exposing internal
layout modes. Terminal applications must continue to receive ordinary,
modified and Escape keys without interference.

## Decision

- `Option+Space` globally opens or collapses the main attention pane without
  hiding the persistent spine. If Heed was explicitly hidden, it reopens at
  the attention list; it does not restore a terminal or other nested surface.
- A permanent **spine** (40×204 capsule, floating 8px off the screen's right
  edge) carries the aperture mark, attention count and global controls. The
  aperture signal exclusively represents runtime health (live green,
  connecting/stale amber, offline red, demo grey); Agent status remains on
  Agent-specific surfaces.
- The attention list is the keyboard home. `↑`/`↓` and `J`/`K` move the active
  Agent, `Home`/`End` jump, `/` focuses search, and `A` toggles attention/all.
- `Enter` and `T` open the active Agent's terminal. `D` opens its workspace
  changes. Mouse activation and Enter have the same primary behavior.
- `⌘W` backs out of terminal or changes to the preserved list and selection.
  `⌘K` opens the command palette; `?` opens a keyboard reference and toggles
  back to the surface that invoked it.
- While xterm has focus, plain keys—including bare `Escape`, control keys and
  option-modified keys—belong to the terminal. Heed reserves only explicit
  Command shortcuts.
- Outside xterm, `Escape` backs out toward the attention list, then collapses
  that pane to the persistent spine. Only the spine's close control hides Heed
  entirely.
- Tab retains normal focus-navigation semantics. Numbered pane shortcuts and
  hidden Tab-based Agent cycling are removed.

## Consequences

- The complete keyboard loop is `Option+Space`, navigate, `Enter`, work,
  `⌘W`, navigate again.
- Terminal programs retain their own keyboard model.
- Sidebar, command palette, labels and key handling should be backed by the
  same user-facing actions so their behavior cannot drift.
- The bottom-anchored variant remains retired by ADR-0006.
