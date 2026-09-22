# ADR-0011: Add Amp Code as an opt-in read-only runtime adapter

Status: accepted

## Context

Amp Code owns its local threads, credentials and execution environment. Heed
should be able to include those threads in the same lightweight fleet without
embedding Amp authentication, pretending an API thread is a terminal, or
creating a second process owner.

The installed Amp CLI already provides bounded scripting surfaces:
`amp threads list --json` returns thread summaries and `amp threads markdown`
returns a readable conversation transcript. The local CLI is preferable to
putting an access token in the browser or adding a second authentication flow to
Heed.

## Decision

Heed provides an **opt-in Amp Code runtime adapter** enabled with
`HEED_ENABLE_AMP_RUNTIME=1`.

The adapter:

- invokes the local `amp` executable without a shell;
- reads a bounded thread list with `amp threads list --json`;
- probes the experimental `amp top --stream-jsonl` snapshot to overlay the
  latest live state when available, while treating the history list as the
  fallback;
- namespaces each runtime ID as `amp-local:<thread-id>`;
- exposes an `Open in Amp` HTTP(S) link for each thread;
- exposes bounded, read-only Markdown output through the normalized output
  endpoint; and
- declares output support but no terminal, workspace changes, spawn, lineage or
  conversation-write capability.

`HEED_AMP_BIN` may point to an explicit CLI executable, and the adapter remains
unavailable when Amp is not installed or authenticated. Amp credentials remain
owned by the CLI (`amp login` or its documented environment configuration) and
never cross into React.

## Consequences

- Amp threads can appear beside Herdr agents without changing the UI's runtime
  contract or adding provider-specific logic to React.
- Selecting an Amp thread opens a read-only output surface rather than a fake
  PTY or a parallel message composer.
- Amp's local thread list is a history-oriented source; Heed uses the live
  `top` probe only for current lifecycle state and does not infer parent/child
  relationships, individual workspace ownership or completion semantics from
  it.
- The optional link returns users to Amp's own thread surface; Heed does not
  proxy or recreate that surface.
- Bidirectional conversation, live event subscriptions, remote orb control and
  workspace diff inspection remain future adapter capabilities.
