# Product boundary

## Scale without a global graph

The constellation is deliberately local: one focused Agent, its parent and its
direct children. Many sessions belong in a compact fleet index grouped by
attention state, with search across task and workspace. Selecting a fleet row
returns to the local constellation. This avoids asking a graph to be both a
mental model and a high-density operations table.

Herdr can remain the runtime and source of truth. A first real integration only
needs to discover sessions, read status and lineage, focus a pane, send a
message, and request a spawn. This POC should not duplicate terminal hosting,
process supervision or worktree mechanics.

Status: UI hypothesis under evaluation

## Promise

Summon one lightweight surface, understand the current Agent operation, steer
it or one of its children, and get out of the way.

## Must prove

1. A focused constellation is faster to understand than a session list.
2. Parent-child delegation remains legible without becoming a graph editor.
3. Chat, result and change evidence can coexist without turning into an IDE.
4. The panel feels native to the laptop rather than like a dashboard in a small
   window.
5. The same web experience can adapt to a conventional mobile viewport.

## Explicitly absent

- real process launch or terminal ownership;
- provider authentication and session recovery;
- a project, ticket or workflow model;
- editing, staging, committing or merging code;
- arbitrary extension UI; and
- a global map of every historical Agent.
