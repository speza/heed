# ADR-0009: Theme components through semantic tokens

Status: accepted

## Context

Heed's initial palette mixed product meaning, component styling and literal
near-black/orange values. That made the windows visually heavy and would make
user-selectable themes require component rewrites.

## Decision

- Catppuccin Frappé is the default palette. It is lighter than Mocha and uses
  lavender rather than orange as the interaction accent.
- `src/themes.css` owns palette values and maps them to Heed's semantic tokens:
  base, mantle, crust, surfaces, text tiers, accent, attention, good, warning,
  error, panel, lines and shadow.
- Component CSS consumes semantic tokens. It must not attach product meaning to
  a literal palette colour.
- Interaction accent and runtime/Agent status are separate. Agent lifecycle
  colors mirror Herdr exactly: working yellow, blocked/needs-input red, unseen
  done blue, and idle/seen green. Failed/offline remains red, while selection
  uses neutral text/surface mixes.
- A future theme can be introduced with a `data-theme` token mapping without
  changing component layout or behavior.

## Consequences

- Frappé improves elevation and legibility without turning Heed into a light
  application.
- Catppuccin Macchiato, Mocha, Latte and user-provided mappings can be added at
  the theme boundary.
- Legacy literal colours should be migrated as their components are touched;
  new component styling must use semantic tokens from the outset.
