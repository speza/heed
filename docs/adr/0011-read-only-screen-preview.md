# ADR-0011: Triage with a read-only screen preview

Status: accepted

## Context

The attention list told the operator *that* an Agent needed them but not
*why*. Answering "what is it asking?" meant opening the interactive terminal,
which takes over Herdr's presentation of that pane, resizes it to Heed's
viewport and pulls the operator out of triage. Herdr already exposes a bounded,
non-invasive read of an Agent's visible screen (`herdr agent read`).

Herdr also reports no timestamps, so "how long has this been waiting?" had no
honest answer; rows showed a placeholder `live`.

## Decision

- The Agent list is master–detail. Moving through the list previews the active
  Agent's **visible screen** beside it, polled while shown, with SGR colour
  preserved and other control sequences dropped. It is read-only: no input,
  scrolling or resize reaches Herdr. The live focus pane shows the same
  preview under the Agent's location.
- The preview is labelled as the terminal screen, never as a structured result
  or conversation (consistent with the Herdr integration specification).
- The Herdr adapter records when it **observes** a status change (status or
  Herdr's state sequence) and returns `statusSince`. A pane first seen
  mid-state has no `statusSince`; the UI shows nothing rather than a guess.
- Locally acknowledged completed turns are keyed on Herdr's state sequence, not
  `revision`, so unrelated title updates do not resurface them. The spine
  count, rail and attention list share one attention predicate.
- Read-only adapter calls (screen, workspace changes) may validate the target
  pane against a snapshot under 1.5 s old; terminal takeover always revalidates
  with a fresh snapshot.

## Consequences

- Most triage — "approve this?", "it finished, here's the summary" — happens
  from the list without a terminal takeover. `Enter` still opens the terminal
  when the operator needs to act.
- Time in state appears only after the adapter has watched a transition, so a
  freshly started Heed shows durations progressively.
- Preview polling adds one `herdr agent read` per refresh while a list is open;
  it stops when the list closes.
