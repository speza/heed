# ADR-0002: Herdr is the runtime; this app is a thin control surface

Status: accepted

## Context

Building terminal hosting, process supervision or worktree management here
would duplicate Herdr and split the source of truth for agent sessions.

## Decision

This UI is a **thin control surface over Herdr**. It discovers sessions, reads
status, renders a host-owned terminal stream, sends messages and inspects
workspace evidence. Herdr retains PTY and process ownership; the xterm surface
is an interactive renderer over Herdr's controller protocol. Agent state arrives through a transport-neutral API,
not through a growing JS/native bridge; the bridge stays limited to window
behaviour (summon/hide/layout).

## Consequences

- Mock data is synthetic and shaped like what Herdr would deliver
  (e.g. unified `git diff` patches for working-tree changes).
- Terminal frames, input, scrolling and resize go through the runtime adapter;
  the UI never reaches into or owns the source pane.
- The long-term identity question — "is this just a herdr(.dev) bar?" — is
  open (see ADR-0006).
