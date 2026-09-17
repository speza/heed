# ADR-0002: Herdr is the runtime; this app is a thin control surface

Status: accepted

## Context

Building terminal hosting, process supervision or worktree management here
would duplicate Herdr and split the source of truth for agent sessions.

## Decision

This UI is a **thin control surface over Herdr**. It discovers sessions, reads
status and lineage, focuses panes, sends messages and requests spawns. It hosts
no terminals and supervises nothing. Agent state arrives through a
transport-neutral API, not through a growing JS/native bridge; the bridge stays
limited to window behaviour (summon/hide/layout).

## Consequences

- Mock data is synthetic and shaped like what Herdr would deliver
  (e.g. unified `git diff` patches for working-tree changes).
- Pane focus is delegated upward: when the UI wants to touch a terminal, it
  asks the runtime rather than reaching into it.
- The long-term identity question — "is this just a herdr(.dev) bar?" — is
  open (see ADR-0006).
