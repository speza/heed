# ADR-0007: Focus-the-host-terminal (proposed)

Status: proposed (not implemented)

## Context

The HUD is a control surface over Herdr, but Herdr lives inside a terminal
(Ghostty, in the demo user's case) inside a tab. At some point the operator
wants to jump back to the place Herdr is running: the app, the window, the tab,
the pane.

## Decision (proposed)

Add an "Open in Herdr" affordance on panes that focuses the host terminal, via
a fidelity ladder:

1. **Activate the app** — `NSRunningApplication`/AppleScript `activate` on the
   terminal bundle that hosts the session. Reliable, no permissions beyond
   automation consent.
2. **Pick the window** — System Events (AX) window enumeration matched by
   title. Needs the Accessibility permission granted to this app.
3. **Pick the tab** — walk the window's tab AX children and match the session's
   tab title. Ghostty's AX support for tabs is the least reliable link; this
   should be verified against real Ghostty builds and may need Ghostty-side
   support (e.g. AppleScript dictionary or tab titles set to the session id).
4. **Best long-term: Herdr co-designs it** — Herdr reports the session→host
   mapping (bundle id, window/tab title, or a `focus` command in its CLI), and
   the HUD simply invokes it. The runtime owns the truth; the HUD only asks.

## Consequences

- Until Herdr provides the mapping, tab-level targeting is best-effort and
  permission-gated; app-level activation is the reliable floor.
- This keeps the HUD inside its boundary: it asks the runtime (or the OS) to
  focus; it never hosts or drives the terminal itself.
