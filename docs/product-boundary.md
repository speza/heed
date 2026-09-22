# Product boundary

## Scale without a global graph

The constellation is deliberately local: one focused Agent, its parent and its
direct children. Many sessions belong in a compact fleet index grouped by
attention state, with search across task and workspace. Selecting a fleet row
returns to the local constellation. This avoids asking a graph to be both a
mental model and a high-density operations table.

Herdr is the first runtime adapter and source of truth for the first live
slice. The normalized gateway contract is designed to aggregate agents from
multiple runtimes: a terminal-oriented source may expose panes and PTYs while
an API-oriented source may expose structured conversation without either.
Each Agent carries its source and declared capabilities; the UI must not infer
terminal, workspace, spawning or lineage support.

Herdr retains PTY and process ownership; Heed's xterm surface controls only
transient presentation size while it is attached. Amp Code is an optional,
read-only adapter over the local Amp CLI: it lists threads, overlays current
activity when available, and exposes bounded Markdown output plus a link back
to Amp's own thread surface, but does not own a terminal, workspace,
credentials or conversation writes (ADR-0010, ADR-0011). Direct API sessions
remain deferred.

Status: live Herdr triage hypothesis under evaluation

## Promise

Summon one lightweight surface, understand the current Agent operation, steer
it or one of its children, and get out of the way.

## Must prove

1. A focused constellation is faster to understand than a session list.
2. Parent-child delegation remains legible without becoming a graph editor.
3. Terminal context, result and change evidence can coexist without turning
   into an IDE.
4. The panel feels native to the laptop rather than like a dashboard in a small
   window.
5. The same web experience can adapt to a conventional mobile viewport.

## Explicitly absent

- real process launch or PTY ownership;
- provider authentication and session recovery in Heed;
- a project, ticket or workflow model;
- editing, staging, committing or merging code;
- arbitrary extension UI; and
- a global map of every historical Agent.
