# Heed ↔ Herdr integration

Status: implementation specification

## Purpose

Validate Heed's core hypothesis:

> See which Herdr agents need attention, read enough context to understand the
> situation, and respond without opening Herdr or hunting for the session.

Heed remains a thin control surface. Herdr remains the source of truth for
agent presence, pane state, lifecycle status and execution.

## First live slice

The first live version must support:

1. Discovering all Herdr-recognized agents in the local Herdr server.
2. Showing Herdr's status and triage ordering.
3. Selecting an agent in Heed without stealing terminal focus.
4. Attaching an interactive xterm surface to the selected Agent's Herdr terminal.
5. Inspecting workspace-level Git changes on demand.
6. Retaining the last snapshot and showing a stale/offline state if Herdr
   becomes unavailable.

Spawning is not part of this slice.

## Explicit non-goals

- Hosting a terminal or PTY in Heed.
- Replacing Herdr's workspace, tab or pane UI.
- Provider-specific conversation parsing.
- Claiming that terminal output is a structured agent result.
- Assigning a shared worktree diff to one individual agent.
- Editing, staging, committing or merging files.
- Inferring parent/child lineage from workspace or tab topology.
- Silently mixing synthetic fixture agents into live mode.

## Runtime boundary

```text
React / WKWebView
        │ same-origin localhost HTTP
        ▼
Heed Bun adapter
        │ CLI in the first implementation
        ▼
Herdr server
```

`bun run dev` and `bun run shell` should start the adapter as part of the
single command. The native shell loads the same loopback experience as the
browser. Swift continues to own only summon, hide, layout and OS-level
behaviour.

The adapter starts with CLI-backed polling. It may later switch to Herdr's
socket protocol and event subscriptions without changing this specification's
web API.

## Runtime API

The exact route names may change during implementation, but the contract is:

```text
GET    /api/runtime
GET    /api/runtime/agents/:id/output?source=visible&format=ansi&lines=200
POST   /api/runtime/agents/:id/terminal
WS     /api/runtime/terminal/:session/socket
DELETE /api/runtime/terminal/:session
GET    /api/runtime/agents/:id/changes
```

### `GET /api/runtime`

Returns a normalized snapshot:

```ts
interface RuntimeSnapshot {
  readonly available: boolean;
  readonly version?: string;
  readonly protocol?: number;
  readonly fetchedAt: number;
  readonly agents: readonly RuntimeAgent[];
  readonly error?: string;
}

interface RuntimeAgent {
  readonly id: string;
  readonly paneId: string;
  readonly name: string;
  readonly kind: string;
  readonly status: "working" | "idle" | "blocked" | "done" | "unknown";
  readonly workspaceId: string;
  readonly workspaceLabel?: string;
  readonly tabId: string;
  readonly cwd?: string;
  readonly terminalTitle?: string;
  readonly focused: boolean;
  readonly revision: number;
  readonly interactiveReady: boolean;
}
```

The adapter uses the Herdr pane ID as an opaque target. It must not expose
Herdr protocol records directly to React.

Only recognized agent panes are returned. Ordinary shell panes are not Heed
Agents.

### Status mapping

| Herdr status | Heed presentation |
| --- | --- |
| `working` | Working |
| `blocked` | Needs you |
| `idle` | Waiting |
| `done` | Done |
| `unknown` | Unknown |

The adapter mirrors Herdr's priority Agents-panel semantics (`blocked`, unseen
`done`, `working`, `unknown`, `idle`) and uses Herdr's state-change sequence for
ties. Heed does not add a separate browser-side priority algorithm. Initial
selection uses the adapter's ordering.

### `GET .../output`

The bounded output endpoint remains available for non-terminal evidence reads.
The terminal overlay uses Herdr's terminal controller:

```text
herdr terminal session control <pane-id> --takeover --cols N --rows N
```

The adapter validates the Agent and initial xterm dimensions, starts one
process-local controller, and returns an opaque random session handle. The
browser upgrades that handle to a same-origin WebSocket. Herdr terminal frames
flow to xterm in order; xterm fit changes send `terminal.resize` back through
the same controller. Wheel and PageUp/PageDown gestures send explicit
`terminal.scroll` records so Herdr's host viewport remains authoritative rather
than diverging into browser-local scrollback.

Frames receive bounded delivery identifiers and replay. A dropped socket may
reconnect to the same controller with its last delivery identifier during a
15-second grace period; an expired replay fails instead of silently omitting
terminal bytes. Closing the terminal overlay sends `terminal.release` and kills the
controller, allowing the existing Herdr client to reclaim presentation.

xterm text, paste and ordinary terminal keys travel as ordered
`terminal.input` records. Shift+Enter uses CSI-u byte input so supporting Agent
applications can distinguish it from ordinary Enter. Heed does not maintain a
second composer or synthetic chat history. Herdr retains the PTY, process, pane
scrollback and durable terminal state.

## Workspace changes

`GET .../changes` resolves the selected agent's workspace/worktree and reads
changes on demand.

The initial baseline is `HEAD`, including:

- staged changes;
- unstaged changes; and
- bounded untracked files.

The result is labelled **Workspace changes**, never “this agent's changes.” If
multiple agents share a checkout, the same workspace evidence may appear for
each selected agent. The adapter must not claim individual attribution.

If the cwd is not a Git worktree, the repository cannot be read, or limits are
exceeded, the UI shows an unavailable/partial evidence state rather than an
empty successful diff.

The existing diff drawer can remain the renderer. Git collection belongs in
the adapter, not the browser. For text files within the evidence bounds, the
adapter also returns the `HEAD` and working-tree source needed to align syntax
highlighting with hunk line numbers.

## UI behavior

### Live mode

- Fleet contains all recognized Herdr agents across all workspaces.
- Focus view shows the selected agent and truthful runtime metadata.
- The map/constellation does not invent relationships when lineage is absent.
- The interactive terminal and workspace changes are on-demand surfaces.
- `Option+Space` opens or collapses the main attention pane while preserving
  the sidebar. When Heed was explicitly hidden, it summons directly to the
  attention list. Arrow keys or `J`/`K` navigate it, `Enter`/`T` opens the
  active terminal, `D` opens changes, and `⌘W` returns to the preserved list
  selection.
- Workspace changes support the same full keyboard path: arrows or `J`/`K`
  select files, `Enter`/`Space` expands the active file, and `T` opens the
  selected Agent's terminal.
- Plain keys and bare `Escape` remain terminal input while xterm has focus;
  Heed reserves explicit Command shortcuts rather than terminal control keys.
- Outside xterm, `?` opens an in-product keyboard reference and returns to the
  invoking surface when toggled again.
- Spawn is hidden or disabled with an explanation.

Unsupported fields such as model, elapsed time, structured result and task are
omitted or shown as unavailable. They are not filled with fixture values.

### Connection state

- Initial load: `connecting`.
- Successful snapshot: `live`.
- Failed refresh after a prior success: retain the last snapshot and mark it
  `stale`.
- No successful snapshot: show an `offline` empty state.
- Commands are disabled while the adapter is unavailable.
- A live mode never silently falls back to fixtures.
- Synthetic data remains available through an explicit demo mode for design and
  tests.

Refresh starts with a two-second interval. Requests must be serialized or
sequence-checked so a slow response cannot overwrite a newer snapshot.

## Deferred spawning contract

Herdr currently does not expose durable parent/child lineage in its snapshot.
Heed therefore must not ship a real **Spawn child** action yet.

When lineage is available, the future endpoint may be:

```text
POST /api/runtime/agents/:id/spawn
```

The adapter would validate the parent, split or allocate a pane, start the
requested agent, optionally send its initial prompt, and return the new runtime
record. The returned parent relationship must come from a Herdr/Heed runtime
contract that survives refresh; a client-only `parentId` is not sufficient.

## Acceptance criteria

- With Herdr running, one command starts the adapter and UI.
- The fleet contains the same recognized agents as `herdr api snapshot`.
- Blocked agents surface in the attention count and preserve Herdr ordering.
- Selecting an agent does not change Herdr's focused pane.
- Terminal input, host scrolling and resize travel through the active Herdr
  terminal controller exactly once.
- The interactive terminal is usable without opening Herdr.
- The full attention-list → terminal → attention-list loop is keyboard
  operable without losing selection.
- Workspace changes match the `HEAD`-based adapter result and are labelled as
  workspace evidence.
- Stopping Herdr produces stale/offline UI rather than a crash or fake data.
- Existing fixture-mode UI remains testable.
- Web changes pass `bun run check`, `bun run test` and `bun run build`.
