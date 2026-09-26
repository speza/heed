import { motion } from "motion/react";
import { TerminalOutput } from "./TerminalOutput";
import type { Agent, ChatMessage } from "./types";
import { EmptyState, enterTransition, Glyph, StatusMark } from "./ui";

export function TerminalCard({
  agent,
  messages,
  onClose,
  actionError,
}: {
  readonly agent: Agent;
  readonly messages: readonly ChatMessage[];
  readonly onClose: () => void;
  readonly actionError?: string;
}) {
  return (
    <motion.section
      className="reply-card"
      initial={{ opacity: 0, y: 18, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.98 }}
      transition={enterTransition}
      aria-label={`Terminal for ${agent.name}`}
    >
      <header className="reply-head">
        <StatusMark status={agent.status} />
        <strong>{agent.name}</strong>
        <span className="terminal-back-hint">Back to update rail <kbd>⌘W</kbd></span>
        <button className="icon-button" onClick={onClose} aria-label="Close terminal and return to update rail (Command-W)" type="button"><Glyph name="close" /></button>
      </header>
      <div className="reply-log">
        {messages.length === 0 && !agent.runtime ? <EmptyState>Nothing yet. Say what you need.</EmptyState> : null}
        {actionError ? <p className="runtime-error">{actionError}</p> : null}
        {messages.map((message) => (
          <div className={`message message-${message.role}`} key={message.id}>
            <span>{message.role === "human" ? "You" : "Agent"}</span>
            <p>{message.body}</p>
            <time>{message.time}</time>
          </div>
        ))}
        {agent.runtime?.capabilities.terminal ? (
          <section className="runtime-output">
            <header><span>Connected terminal</span><small>Wheel or PageUp/PageDown to scroll</small></header>
            <TerminalOutput agentId={agent.id} />
          </section>
        ) : null}
      </div>
    </motion.section>
  );
}
