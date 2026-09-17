# Observatory — floating agent instrument

A UI-first experiment for a beautiful, lightweight Agent control surface: a
summoned floating spine with panes that slide out beside it. One selected
Agent in the centre of the focus pane, its immediate relationships as a
stacked list or constellation, a compact fleet index for triage, and stacked
working-tree diffs as evidence. The data is entirely synthetic; there is no
agent runtime or control plane yet.

The UI wears the Observatory identity (aperture mark, paper-and-ink theme,
signal accent). Architecture decisions live in `docs/adr/`; the long-term
identity question — whether this becomes a herdr(.dev) companion bar — is
tracked in `docs/adr/0007-focus-host-terminal.md`.

## Run in a browser

```sh
bun install
bun run dev
```

Open the URL printed by Vite.

## Run as a macOS floating panel

```sh
bun install
bun run shell
```

The shell bundles the current web build in a fixed-stage AppKit `NSPanel`
backed by `WKWebView`. The window never resizes while summoned; panes compose
inside the stage (see `docs/adr/0003-fixed-stage-window.md`).

- `Option+Space` summons and hides the instrument.
- The **spine** floats 8px off the right edge of the screen: the aperture
  mark (agent status as a signal colour), the `N need you` triage count, and
  pane controls.
- **Panes** slide out left of the spine, one at a time:
  - focus — the local constellation or a stacked list (`⌘1` list, `⌘2` map)
  - fleet — the compact triage index (`⌘3`)
  - diff — stacked working-tree changes for the focused Agent (`⌘D`,
    also the Changes chip)
- `R` opens the reply card; `Tab`/`⇧Tab` cycle Agents needing attention.
- `⌘K` opens the command palette (jump to agents, triage, changes, spawn).
- `Escape` peels: reply first, then the pane, then the spine; one more hides
  everything.

## Product hypothesis

Summon one lightweight surface, see what needs you, and get out of the way.
The constellation is local context, never a global graph (ADR-0001); the fleet
is the escape hatch for scale. Herdr remains the runtime and source of truth
(ADR-0002); this app provides only a thin control and navigation layer.

The eventual session transport, provider adapters and remote runtimes remain
outside this POC.
