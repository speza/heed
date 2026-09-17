# ADR-0007: Focus the host terminal

Status: proposed (deferred)

## Context

The HUD is a control surface over Herdr, but Herdr lives inside a terminal. At
some point the operator may want to jump from a selected Agent in Heed to the
same Agent in an already-open Herdr client.

The current Herdr CLI cannot complete that navigation. `herdr agent focus`
changes server-side focus, while each attached TUI client retains its own
visible selection. App activation only returns to whichever terminal tab was
previously active.

Experiments with opening another Herdr client reached the server-side focus but
created unwanted windows. Driving the existing client through synthetic
keyboard input required Accessibility permission, depended on local keybindings
and priority ordering, and only addressed the first nine agents.

## Decision

Do not ship **Open in Herdr** yet. Heed will not request Accessibility
permission, synthesize terminal input, open another terminal window, or expose
a server-side focus action that cannot fulfil the visible-navigation promise.

Reconsider the feature when Herdr exposes a first-class operation such as:

```text
agent.reveal(target, client?)
```

Herdr should own choosing or activating the appropriate client and selecting
the correct workspace, tab and pane. Heed should only request the reveal.

## Consequences

- The first integration remains focused on Heed's core hypothesis: triage, an
  interactive terminal surface and workspace evidence without opening Herdr.
- The native bridge remains limited to Heed window and operating-system
  behaviour.
- Users navigate to Herdr themselves when the lightweight Heed surface is not
  enough.
- No terminal-specific bundle IDs, Accessibility permission or keybinding
  assumptions become product requirements.
