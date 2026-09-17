# ADR-0001: The constellation is local context, never a global graph

Status: accepted (carried from the original hypothesis, validated in use)

## Context

An agent development environment could render every session as one graph.
With real fleets (33+ sessions across 7 workspaces in the mock) a global graph
becomes unstable and unreadable, and it competes with search as a way to find
things.

## Decision

The constellation renders **local context only**: the focused Agent, its
parent, and its direct children. The fleet view is a compact, searchable index
grouped by attention state. Selecting a row re-centres the local constellation.

## Consequences

- The list view is the default; the map is a deliberate, near-full-screen
  special view opened from it (or ⌘2), not the durable mental model.
- Deep lineage (grandchildren) is reachable by recentring, not by zooming.
- Herdr's own UI remains the place for global portfolio views.
