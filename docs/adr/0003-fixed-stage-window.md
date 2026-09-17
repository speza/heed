# ADR-0003: Fixed stage; the web owns the pixels; three-phase layout

Status: accepted (after five rounds of transition glitches)

## Context

The HUD is a transparent floating window: AppKit panel + WKWebView + vibrancy
surfaces. Every pane switch originally resized the window, which cascaded
through three independent async repaint pipelines (window server, vibrancy
sampling, WebKit). Resizing a transparent panel with a webview inside produces
stale-frame flicker that no JS-side ordering can fully hide.

## Decision

- The window is a **fixed stage** (1120×860 on the right spine). While any pane
  is open the window geometry never changes; panes compose right-anchored next
  to the spine, growing leftward into the stage.
- The **web owns all pixels** except the two vibrancy surfaces (spine-shaped,
  drawer-shaped) that sit behind the webview. All `backdrop-filter` usage was
  removed: over a transparent webview it is a visual no-op and its compositing
  layer glitches on element resize.
- Layout changes follow a **two-phase handshake**: the web posts target
  geometry (`layout`), the shell applies it and confirms (`resized`), the web
  swaps its layout and acks (`commit`), and only then does the shell move the
  vibrancy glass — so the glass never lands ahead of the content it backs.
- Click-through is dynamic: the shell toggles `ignoresMouseEvents` by
  hit-testing the current surface rects, so idle transparent regions pass
  clicks through to the desktop.

## Consequences

- Pane switching is a pure web content swap plus one synchronous glass
  reposition—no window resize during keyboard navigation.
- While a pane is open the stage is modal-ish: it may intercept clicks in its
  bounds. Escape, `Option+Space`, or a pane close control collapses the pane to
  the spine; only the spine's close control dismisses Heed entirely.
- WebKit resize repaint quirks and `backdrop-filter` compositing glitches are
  structurally excluded (the window never resizes; no backdrop-filter).
