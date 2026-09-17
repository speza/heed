# ADR-0004: Pane model, spine, and always-defined keybinds

Status: accepted

## Context

The HUD needs one place that never moves (orientation), plus discrete surfaces
that slide out from it for work that is too big for a strip.

## Decision

- A permanent **spine** (40×176 capsule, floating 8px off the screen's right
  edge) carries the aperture mark (status-as-signal), the attention count, and
  pane controls. The spine never moves while summoned.
- **Panes** slide out left of the spine, right-anchored: focus (list by
  default; map as the big special view), fleet (triage/index), diff
  (working-tree changes). One pane at a time; Escape peels to the spine; a
  second Escape hides the whole HUD.
- The reply card is a summoned overlay anchored to the spine.
- **Keybinds are always defined** while the HUD is summoned: ⌘1 focus list,
  ⌘2 focus map, ⌘3 fleet, ⌘D diff, `R` reply, `Tab`/`⇧Tab` cycle
  attention agents, ⌘K palette, `Escape` peel, `Option+Space` summon/hide.
  The palette footer advertises them.

## Consequences

- Users keyboard-first triage without the mouse; the spine is the "what needs
  me" heartbeat (`N need you`, colour-coded signal dot).
- The bottom-anchored variant lost its trial (ADR-0006).
