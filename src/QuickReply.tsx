import { type Ref, useImperativeHandle, useRef, useState } from "react";
import type { Dialog } from "./dialog";
import { sendAgentInput } from "./runtime/client";
import type { RuntimeInput } from "./runtime/types";
import type { Agent } from "./types";

/** Lets a surrounding list drive the reply from its own keyboard model. */
export interface QuickReplyHandle {
  /** Focuses the prompt field; false when the Agent is waiting at a dialog. */
  focus(): boolean;
  /** Answers the visible dialog with a numbered option; false when unavailable. */
  choose(value: string): boolean;
}

type Status = { readonly kind: "sent" | "error"; readonly text: string };

/**
 * Answers an Agent without taking over its terminal. A blocked Agent gets its
 * on-screen dialog options (Herdr refuses prompts while a dialog is open);
 * any other Agent gets a one-line prompt.
 */
export function QuickReply({
  agent,
  dialog,
  reading = false,
  onSent,
  onExit,
  ref,
}: {
  readonly agent: Agent;
  readonly dialog?: Dialog;
  /** True until the screen that would contain the dialog has been read. */
  readonly reading?: boolean;
  readonly onSent?: () => void;
  /** Called when Escape leaves the prompt field. */
  readonly onExit?: () => void;
  readonly ref?: Ref<QuickReplyHandle>;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>();
  const input = useRef<HTMLInputElement>(null);
  const blocked = agent.runtime?.rawStatus === "blocked";

  async function send(reply: RuntimeInput, sentText: string) {
    if (pending) return;
    setPending(true);
    setStatus(undefined);
    try {
      await sendAgentInput(agent.id, reply);
      if (reply.kind === "prompt") setText("");
      setStatus({ kind: "sent", text: sentText });
      onSent?.();
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : "The reply could not be sent." });
    } finally {
      setPending(false);
    }
  }

  function choose(value: string) {
    const choice = blocked ? dialog?.choices.find((candidate) => candidate.value === value) : undefined;
    if (!choice) return false;
    void send({ kind: "choice", value }, `Answered “${choice.label}”`);
    return true;
  }

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (blocked) return false;
      input.current?.focus();
      return true;
    },
    choose,
  }));

  return (
    <div className="quick-reply" aria-busy={pending}>
      {blocked ? (
        <div className="quick-reply-dialog">
          <span className="quick-reply-question">{dialog?.question ?? "Waiting at a dialog"}</span>
          <div className="quick-reply-choices" role="group" aria-label="Dialog options">
            {dialog?.choices.map((choice) => (
              <button
                key={choice.value}
                type="button"
                className={`chip${choice.highlighted ? " is-highlighted" : ""}`}
                disabled={pending}
                onClick={() => choose(choice.value)}
              >
                <kbd>{choice.value}</kbd><span>{choice.label}</span>
              </button>
            ))}
            <button type="button" className="chip" disabled={pending} onClick={() => void send({ kind: "key", key: "esc" }, "Sent Escape")}>
              <kbd>esc</kbd><span>Dismiss</span>
            </button>
          </div>
          {dialog ? null : <small>{reading ? "Reading the dialog…" : "No numbered options found on screen. Open the terminal to answer."}</small>}
        </div>
      ) : (
        <form
          className="quick-reply-form"
          onSubmit={(event) => {
            event.preventDefault();
            const prompt = text.trim();
            if (prompt) void send({ kind: "prompt", text: prompt }, agent.status === "working" ? "Queued for the running turn" : "Sent");
          }}
        >
          <input
            ref={input}
            value={text}
            disabled={pending}
            maxLength={8_000}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              input.current?.blur();
              onExit?.();
            }}
            placeholder={agent.status === "working" ? `Queue a message for ${agent.name}…` : `Reply to ${agent.name}…`}
            aria-label={`Reply to ${agent.name}`}
          />
          <button type="submit" className="chip chip-reply" disabled={pending || !text.trim()}>Send <kbd>↵</kbd></button>
        </form>
      )}
      {status ? <p className={`quick-reply-status is-${status.kind}`} role="status">{status.text}</p> : null}
    </div>
  );
}
