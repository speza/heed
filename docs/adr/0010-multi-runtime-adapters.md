# ADR-0010: Model multiple runtime adapters and capabilities

Status: accepted

## Context

Herdr is Heed's first live runtime, but it is terminal-oriented: it owns panes,
PTYs and workspace context. Other agent backends may expose structured
conversation and streaming API events without exposing a terminal, pane or
worktree. A user may also have agents from more than one backend at the same
time.

Treating every backend as a terminal would either hide useful API-backed
sessions or pull provider-specific runtime logic into the React experience.

## Decision

Heed is a control surface over one or more **runtime adapters**. Herdr is the
first adapter, not a permanent assumption about every Agent.

The browser-facing runtime contract will:

- identify the source runtime for every Agent;
- keep runtime-specific handles opaque to React;
- expose optional location metadata rather than requiring panes, tabs or
  workspaces; and
- declare capabilities per Agent/runtime, including terminal, output,
  structured conversation, workspace changes, spawning and lineage; and
- optionally expose a provider-owned external `openIn` action without making
  navigation a required runtime capability.

The adapter boundary remains server-side:

```text
React / WKWebView -> Heed runtime gateway -> Herdr, Amp, API, ...
```

The gateway may aggregate agents from several configured adapters. A source
being offline must not require other sources to disappear. Credentials and
provider protocols remain outside the browser.

`provider` describes model or agent provenance when available. `source` (the
runtime adapter) describes where the session is owned. These concepts must not
be conflated.

## Consequences

- Existing Herdr behavior remains unchanged while its normalized response
  carries a source descriptor and capabilities.
- Terminal, conversation and workspace controls can be rendered only when the
  selected runtime advertises them.
- An optional `openIn` action can send the user back to the provider's own
  surface; Heed validates it as an HTTP(S) link and does not proxy credentials.
- API-backed sessions can use a structured conversation surface later without
  pretending to be panes or terminal sessions.
- Mixed fleets need source-aware IDs and per-source health rather than one
  global Herdr availability flag.
- Parent/child lineage, spawning and result semantics remain capabilities;
  Heed must not infer them from shared workspaces or neighboring sessions.

## Non-goals

- Adding direct API authentication or bidirectional provider conversations in this slice.
- Building a provider marketplace or arbitrary extension UI.
- Moving PTY, process or agent execution ownership into Heed.

Amp Code's bounded, opt-in read-only CLI adapter is defined separately in
ADR-0011; it consumes this contract without changing the browser-facing model.
