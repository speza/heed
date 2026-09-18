# Heed — floating agent instrument

A UI-first experiment for a beautiful, lightweight Agent control surface: a
summoned floating spine with panes that slide out beside it. One selected
Agent in the centre of the focus pane, its immediate relationships as a
stacked list or constellation, a compact fleet index for triage, and stacked
working-tree diffs as evidence. Live mode is a thin local control surface over
Herdr: it discovers recognized agents, renders an interactive live terminal
and shows workspace-level Git changes. An explicit fixture mode
remains available for UI work.

The UI wears the Heed identity with an aperture mark and a semantic
Catppuccin Frappé theme. Palette mappings live in `src/themes.css`, allowing
future themes without component rewrites (ADR-0009). Architecture decisions
live in `docs/adr/`; the long-term
identity question — whether this becomes a herdr(.dev) companion bar — is
tracked in `docs/adr/0007-focus-host-terminal.md`.

## Run in a browser

```sh
bun install
bun run dev
```

Open the URL printed by Vite. Herdr must be running for live data. Add
`?demo=1` to use the synthetic fixture fleet instead. To exercise a mixed fleet
locally, opt into the synthetic non-terminal adapter:

```sh
HEED_ENABLE_MOCK_RUNTIME=1 bun run dev
```

The mock source is deliberately opt-in and never mixed into normal live mode.

## Run as a macOS floating panel

```sh
bun install
bun run shell
```

The command builds the web experience, starts the loopback Herdr adapter and
opens it in a fixed-stage AppKit `NSPanel` backed by `WKWebView`. The window
never resizes while summoned; panes compose inside the stage (see
`docs/adr/0003-fixed-stage-window.md`).

- `Option+Space` globally opens or collapses the main attention pane while the
  sidebar remains visible. If Heed was explicitly hidden, it reopens at the
  attention list.
- The **spine** floats 8px off the right edge of the screen: the aperture
  mark (runtime health as a signal colour), the `N need you` triage count, and
  pane controls. Green is live, amber is connecting/stale, red is offline and
  grey marks fixture mode.
- In the attention list, `↑`/`↓` or `J`/`K` navigate, `Enter` or `T` opens the
  selected Agent's terminal, `D` opens workspace changes, `/` focuses search,
  and `A` toggles between attention and all Agents.
- In workspace changes, `↑`/`↓` or `J`/`K` navigate files, `Enter`/`Space`
  expands the active file, and `T` opens the terminal.
- `⌘W` closes the terminal or changes surface and returns to the preserved
  list. Bare `Escape` remains terminal input while xterm has focus.
- `?` opens a compact keyboard reference and returns to the previous surface
  when pressed again. `⌘K` opens the command palette.
- Outside the terminal, `Escape` backs out to
  the attention list, then collapses the main pane to the sidebar. Only the
  sidebar's close control hides Heed entirely.

## Product hypothesis

Summon one lightweight surface, see what needs you, and get out of the way.
The constellation is local context, never a global graph (ADR-0001); the fleet
is the escape hatch for scale. Herdr is the first runtime adapter and source of
truth for the live slice (ADR-0002, ADR-0010); this app provides only a thin
control and navigation layer. The normalized runtime contract is designed to
combine terminal-based and API-based sessions without requiring every Agent to
have a pane or PTY.

Additional real runtime adapters and remote runtimes remain outside this POC.
