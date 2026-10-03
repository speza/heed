# ADR-0012: Quick reply without taking over the terminal

Status: accepted (amends the Herdr integration specification's "no second
composer" rule)

## Context

ADR-0011 made the reason an Agent needs you visible from the list. Acting on
it still meant opening the interactive terminal, which takes over Herdr's
presentation of the pane. Most replies are tiny: approve an edit, pick an
option, or send one line ("run the tests again").

Herdr 0.9.1 exposes `agent prompt` (text plus Enter as one ordered submission)
but rejects it with `agent_blocked` while an Agent waits at an approval or
question dialog — exactly when a reply is most needed.

## Decision

- A runtime advertises a `reply` capability. Heed offers quick reply only when
  the selected Agent's runtime advertises it and is available.
- `POST /api/runtime/agents/:id/input` accepts exactly one of:
  - `{ kind: "prompt", text }` — trimmed, 1–8,000 characters, no control
    characters; sent with `herdr agent prompt <pane> -- <text>`;
  - `{ kind: "choice", value }` — a single digit 1–9, typed literally with
    `herdr pane send-text`;
  - `{ kind: "key", key: "esc" }` — sent with `herdr agent send-keys`.
- The adapter revalidates the pane against a fresh snapshot and requires the
  matching state: prompts only when the Agent is **not** blocked, choices and
  Escape only when it **is** blocked. A stale UI therefore cannot type a digit
  into an Agent's prompt or a prompt into a dialog.
- For a blocked Agent, Heed detects the dialog's numbered options (`❯ 1. Yes`,
  `› 1) Yes`) from the bottom of the visible screen and shows them, with the
  preceding line as the question. Detection is presentation only; the
  adapter does not interpret the screen.
- Keyboard: `R` focuses the prompt field, `1`–`9` answer the visible dialog,
  `Escape` in the field returns to the list. A reply counts as having seen a
  completed turn.

## Consequences

- Approvals and one-line follow-ups happen from triage; the terminal remains
  one key away for anything richer.
- Heed still keeps no chat history: the screen preview is the transcript.
- Dialog detection depends on agents numbering their options. When none are
  found, Heed says so and offers Escape and the terminal rather than guessing.
- The endpoint is a local mutation surface like terminal takeover: loopback
  only, origin-checked, size-bounded and revalidated per request.
