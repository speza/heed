import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { AgentPreview } from "./AgentPreview";
import type { QuickReplyHandle } from "./QuickReply";
import type { RuntimeConnection } from "./runtime/types";
import type { Agent, AgentStatus } from "./types";
import { EmptyState, enterTransition, Glyph, StatusMark, statusLabels } from "./ui";

export type FleetFilter = AgentStatus | "attention" | "all";

// Mirrors Herdr's Agents-panel priority: blocked, unseen done, working,
// unknown, idle. Failed is Heed's synthetic-only status and sits with blocked.
const fleetOrder: readonly AgentStatus[] = ["needs-you", "failed", "done", "working", "unknown", "waiting"];

const filterLabels: Readonly<Record<FleetFilter, string>> = {
  attention: "Needs you",
  all: "All agents",
  ...statusLabels,
};

function emptyMessage(connection: RuntimeConnection, query: string, filter: FleetFilter, total: number): string {
  if (query) return "No matching Agent sessions.";
  if (connection === "connecting") return "Connecting to Herdr…";
  if (connection === "offline") return "Herdr isn't reachable. Start Herdr and Heed reconnects on its own.";
  if (filter === "attention" && total > 0) return "All clear. Press A to browse all Agents.";
  if (total === 0) return connection === "demo" ? "No Agent sessions." : "No Agents running. Start one in Herdr and it appears here.";
  return "No Agents in this state.";
}

export function FleetView({
  agents,
  selectedId,
  filter,
  isAttention,
  onFilter,
  onClose,
  onTerminal,
  onChanges,
  onAcknowledge,
  onReplied,
  canTerminal,
  canChanges,
  keyboardActive,
  focusRequest,
  connection,
}: {
  readonly agents: readonly Agent[];
  readonly selectedId: string;
  readonly filter: FleetFilter;
  /** The same attention rule the spine count uses, including local acknowledgements. */
  readonly isAttention: (agent: Agent) => boolean;
  readonly onFilter: (filter: FleetFilter) => void;
  readonly onClose: () => void;
  readonly onTerminal: (id: string) => void;
  readonly onChanges: (id: string) => void;
  /** Locally marks a completed turn as seen without opening its terminal. */
  readonly onAcknowledge: (id: string) => void;
  /** Called after a quick reply is accepted. */
  readonly onReplied: (id: string) => void;
  readonly canTerminal: (agent: Agent) => boolean;
  readonly canChanges: (agent: Agent) => boolean;
  readonly keyboardActive: boolean;
  readonly focusRequest: number;
  readonly connection: RuntimeConnection;
}) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(selectedId);
  const root = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const reply = useRef<QuickReplyHandle>(null);
  const normalized = query.trim().toLowerCase();
  const matchesFilter = (agent: Agent) =>
    filter === "all" || (filter === "attention" ? isAttention(agent) : agent.status === filter);
  const visible = agents.filter(
    (agent) =>
      matchesFilter(agent) &&
      (!normalized || `${agent.name} ${agent.task} ${agent.role} ${agent.workspace ?? ""}`.toLowerCase().includes(normalized)),
  );
  const grouped = fleetOrder
    .map((status) => ({ status, agents: visible.filter((agent) => agent.status === status) }))
    .filter((group) => group.agents.length > 0);
  const ordered = grouped.flatMap((group) => group.agents);
  const active = ordered.find((agent) => agent.id === activeId) ?? ordered[0];
  const canAcknowledge = (agent: Agent) => agent.status === "done" && isAttention(agent);
  const attentionCount = agents.filter(isAttention).length;
  const workspaces = new Set(visible.map((agent) => agent.workspace).filter(Boolean)).size;
  const workspaceSummary = `${workspaces} ${workspaces === 1 ? "workspace" : "workspaces"}`;
  const fleetSummary = filter === "attention"
    ? visible.length === 0
      ? `Nothing is waiting on you · ${agents.length} ${agents.length === 1 ? "agent" : "agents"} running`
      : `${visible.length} ${visible.length === 1 ? "agent needs" : "agents need"} you · ${workspaceSummary}`
    : `${visible.length} ${visible.length === 1 ? "session" : "sessions"} · ${workspaceSummary}`;

  useEffect(() => {
    if (!ordered.some((agent) => agent.id === activeId)) setActiveId(ordered[0]?.id ?? "");
  }, [activeId, ordered]);

  useEffect(() => {
    if (keyboardActive) root.current?.focus();
  }, [keyboardActive, focusRequest]);

  useEffect(() => {
    if (!activeId) return;
    [...(root.current?.querySelectorAll<HTMLElement>("[data-agent-id]") ?? [])]
      .find((element) => element.dataset.agentId === activeId)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  function move(step: number) {
    if (ordered.length === 0) return;
    const index = ordered.findIndex((agent) => agent.id === activeId);
    setActiveId(ordered[(Math.max(0, index) + step + ordered.length) % ordered.length]!.id);
  }

  return (
    <motion.section
      ref={root}
      className="fleet-drawer"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (!keyboardActive) return;
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        const target = event.target as HTMLElement;
        const editing = target === search.current;
        if (editing) {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setQuery("");
            root.current?.focus();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            move(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter" && active) {
            event.preventDefault();
            event.stopPropagation();
            onTerminal(active.id);
          }
          return;
        }
        const row = target.closest<HTMLElement>("[data-agent-id]");
        const control = target.closest("button, a, select, textarea, [contenteditable]");
        if (control && !row) return;
        if (event.key === "Enter" && row) return;
        if (!target.closest(".fleet-list") && target !== root.current) return;
        const key = event.key.toLowerCase();
        if (event.key === "ArrowDown" || key === "j") { event.preventDefault(); event.stopPropagation(); move(1); }
        else if (event.key === "ArrowUp" || key === "k") { event.preventDefault(); event.stopPropagation(); move(-1); }
        else if (event.key === "Home") { event.preventDefault(); event.stopPropagation(); setActiveId(ordered[0]?.id ?? ""); }
        else if (event.key === "End") { event.preventDefault(); event.stopPropagation(); setActiveId(ordered.at(-1)?.id ?? ""); }
        else if (event.key === "/") { event.preventDefault(); event.stopPropagation(); search.current?.focus(); }
        else if (key === "a") { event.preventDefault(); event.stopPropagation(); onFilter(filter === "attention" ? "all" : "attention"); }
        else if (event.key === "Enter" || key === "t") { if (active) { event.preventDefault(); event.stopPropagation(); onTerminal(active.id); } }
        else if (key === "d") { if (active) { event.preventDefault(); event.stopPropagation(); onChanges(active.id); } }
        else if (key === "r") { if (reply.current?.focus()) { event.preventDefault(); event.stopPropagation(); } }
        else if (/^[1-9]$/u.test(event.key)) { if (reply.current?.choose(event.key)) { event.preventDefault(); event.stopPropagation(); } }
        else if (key === "e") { if (active && canAcknowledge(active)) { event.preventDefault(); event.stopPropagation(); onAcknowledge(active.id); } }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      }}
      initial={{ opacity: 0, y: 16, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.99 }}
      transition={enterTransition}
    >
      <header className="fleet-header">
        <div className="fleet-title">
          <span className="eyebrow">{connection === "demo" ? "HEED · DEMO AGENTS" : "HEED · LIVE AGENTS"}</span>
          <h2>{filterLabels[filter]}</h2>
          <p>{connection === "stale" ? <span className="fleet-stale">Runtime unavailable · showing the last snapshot</span> : fleetSummary}</p>
        </div>
        <div className="fleet-filter" role="group" aria-label="Agent filter">
          <button type="button" className={filter === "attention" ? "is-active" : ""} aria-pressed={filter === "attention"} onClick={() => onFilter("attention")}>
            Needs you <b>{attentionCount}</b>
          </button>
          <button type="button" className={filter === "all" ? "is-active" : ""} aria-pressed={filter === "all"} onClick={() => onFilter("all")}>
            All <b>{agents.length}</b>
          </button>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close fleet" type="button"><Glyph name="close" /></button>
        <label className="fleet-search">
          <span aria-hidden="true">⌕</span>
          <input ref={search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find session, task or workspace…" aria-label="Search agents" />
          {query ? null : <kbd>/</kbd>}
        </label>
      </header>
      <div className="fleet-body">
        <div className="fleet-list">
          <div className="fleet-scroll">
            {grouped.map((group) => (
              <section className={`fleet-group status-surface-${group.status}`} key={group.status}>
                <header><StatusMark status={group.status} /><strong>{statusLabels[group.status]}</strong><span>{group.agents.length}</span></header>
                <div className="fleet-rows">
                  {group.agents.map((agent) => (
                    <button
                      className={agent.id === active?.id ? "is-selected" : ""}
                      disabled={agent.runtime?.sourceAvailable === false}
                      onFocus={() => setActiveId(agent.id)}
                      onMouseEnter={() => setActiveId(agent.id)}
                      onClick={() => onTerminal(agent.id)}
                      type="button"
                      data-agent-id={agent.id}
                      key={agent.id}
                    >
                      <span className="fleet-agent-copy">
                        <strong>{agent.name}</strong>
                        <small>{[agent.workspace, agent.task !== agent.workspace ? agent.task : undefined].filter(Boolean).join(" · ")}</small>
                      </span>
                      <span className="fleet-agent-side">
                        {agent.elapsed ? <span className="fleet-elapsed">{agent.elapsed}</span> : null}
                        {agent.attention ? <span className="fleet-attention">{agent.attention}</span> : null}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {grouped.length === 0 ? <EmptyState>{emptyMessage(connection, query, filter, agents.length)}</EmptyState> : null}
          </div>
        </div>
        <div className="fleet-preview">
          {active ? (
            <AgentPreview
              agent={active}
              onTerminal={canTerminal(active) ? () => onTerminal(active.id) : undefined}
              onChanges={canChanges(active) ? () => onChanges(active.id) : undefined}
              onAcknowledge={canAcknowledge(active) ? () => onAcknowledge(active.id) : undefined}
              onReplied={() => onReplied(active.id)}
              onReplyExit={() => root.current?.focus()}
              replyRef={reply}
            />
          ) : (
            <EmptyState>{filter === "attention" ? "When an Agent needs you, its screen appears here." : "Select an Agent to preview its screen."}</EmptyState>
          )}
        </div>
      </div>
      <div className="fleet-keyboard-help"><span>↑↓ / J K</span> navigate <span>↵</span> terminal <span>D</span> changes <span>/</span> search <span>R</span> reply <span>1–9</span> answer <span>E</span> mark seen <span>A</span> needs you / all <span>esc</span> close</div>
    </motion.section>
  );
}
