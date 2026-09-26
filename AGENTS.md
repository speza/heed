# Heed agent instructions

## Product boundary

- This repository is currently a UI/UX proof of concept, not an agent runtime.
- The hypothesis is a lightweight floating control surface centred on one
  Agent and its immediate parent/children.
- Preserve the minimal interaction loop: summon, understand, chat, inspect,
  spawn and dismiss.
- Do not add project management, an editor, a terminal multiplexer, workflow
  recipes, analytics dashboards or provider-specific runtime logic without an
  explicit product decision.
- Mock data must remain synthetic.

## Architecture

- `src/` owns the web experience and should remain usable in an ordinary
  browser.
- `Sources/HeedShell/` is a deliberately tiny macOS AppKit/WebKit shell.
- Keep the native bridge limited to window and operating-system behaviour.
- Future agent state should arrive through a transport-neutral API rather than
  through a growing JavaScript/native bridge.

## Quality

- Run `bun run check`, `bun run test` and `bun run build` after web changes.
- Run `swift build` after shell changes.
- Do not commit or push unless explicitly asked.
