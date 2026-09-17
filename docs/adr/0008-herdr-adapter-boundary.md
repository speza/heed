# ADR-0008: Integrate with Herdr through a local runtime adapter

Status: accepted

## Context

Heed's web experience is currently fixture-backed. The AppKit shell owns window
behaviour and exposes a small WebKit bridge for summon, hide and layout; it is
not an appropriate place to grow Herdr protocol or agent-control logic.

Herdr owns agent presence, pane state, status and terminal execution. The web
renderer must remain usable in an ordinary browser, while a browser cannot
safely or directly use Herdr's local socket. The integration also needs to
avoid making synthetic fields look like runtime truth.

## Decision

Heed will integrate with Herdr through a small Bun loopback adapter:

```text
React / WKWebView -> Heed local adapter -> Herdr
```

The adapter will:

- expose a transport-neutral JSON API to the web client;
- own Herdr pane IDs, protocol details and command error translation;
- invoke the stable Herdr CLI (`api snapshot`, `agent read` and
  `terminal session control`);
- poll snapshots initially and mirror Herdr's priority Agents-panel ordering;
- collect Git evidence on demand from the Herdr workspace/worktree path; and
- preserve the last successful snapshot when Herdr becomes unavailable.

A later adapter implementation may use Herdr's socket protocol and event
subscriptions without changing the browser contract.

The AppKit bridge remains limited to Heed window and operating-system
behaviour. Terminal navigation is deferred until Herdr exposes a first-class
client reveal contract (ADR-0007).

The first live surface includes every Herdr-recognized agent in the local
server. Ordinary shell panes are excluded. Selecting an agent is a Heed-local
operation; Heed does not navigate or activate an external Herdr client.

## Consequences

- Live mode has a truthful connection state instead of silently falling back to
  fixtures. Synthetic data remains available only through an explicit demo
  mode.
- Heed can triage, attach an interactive host-owned terminal stream and inspect
  workspace changes without requiring the operator to find the pane in Herdr
  first.
- Herdr's priority Agents-panel semantics remain the source of triage priority;
  React does not invent a second priority algorithm.
- Herdr status, pane topology and workspace metadata are runtime truth. Task,
  model, duration, structured result and agent-level ownership of Git changes
  are not fabricated when Herdr does not provide them.
- Parent/child lineage and spawning remain out of the first live integration.
  Heed must not infer lineage from shared workspaces, tabs or adjacent panes.
- The adapter becomes a local terminal control surface, so it must bind only to
  loopback, validate origins and revalidate target panes before mutations.

## Deferred decisions

- Replace CLI polling with a long-lived Herdr socket/event subscription.
- Define a durable parent/child lineage contract for spawning.
- Add structured provider conversations or result artifacts.
- Add OS-specific terminal tab selection beyond best-effort activation.
