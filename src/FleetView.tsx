import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { Agent, AgentStatus } from "./types";
import { EmptyState, enterTransition, Glyph, needsAttention, StatusMark, statusLabels } from "./ui";

export type FleetFilter = AgentStatus | "attention" | "all";

const fleetOrder: readonly AgentStatus[] = ["needs-you", "working", "waiting", "failed", "done", "unknown"];

export function FleetView({
  agents,
  selectedId,
  filter,
  onFilter,
  onClose,
  onTerminal,
  onChanges,
  keyboardActive,
  focusRequest,
}: {
  readonly agents: readonly Agent[];
  readonly selectedId: string;
  readonly filter: FleetFilter;
  readonly onFilter: (filter: FleetFilter) => void;
  readonly onClose: () => void;
  readonly onTerminal: (id: string) => void;
  readonly onChanges: (id: string) => void;
  readonly keyboardActive: boolean;
  readonly focusRequest: number;
}) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(selectedId);
  const root = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const normalized = query.trim().toLowerCase();
  const matchesFilter = (agent: Agent) =>
    filter === "all" || (filter === "attention" ? needsAttention(agent) : agent.status === filter);
  const visible = agents.filter(
    (agent) =>
      matchesFilter(agent) &&
      (!normalized || `${agent.name} ${agent.task} ${agent.role} ${agent.workspace ?? ""}`.toLowerCase().includes(normalized)),
  );
  const grouped = fleetOrder
    .map((status) => ({ status, agents: visible.filter((agent) => agent.status === status) }))
    .filter((group) => group.agents.length > 0);
  const ordered = grouped.flatMap((group) => group.agents);
  const workspaces = new Set(visible.map((agent) => agent.workspace).filter(Boolean)).size;
  const attentionSummary = visible.length === 0
    ? "No agents need attention"
    : `${visible.length} ${visible.length === 1 ? "agent needs" : "agents need"} attention`;
  const fleetSummary = filter === "attention"
    ? `${attentionSummary} · ${workspaces} ${workspaces === 1 ? "workspace" : "workspaces"}`
    : `${visible.length} ${visible.length === 1 ? "session" : "sessions"} across ${workspaces} ${workspaces === 1 ? "workspace" : "workspaces"}`;

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

  function activeAgent() {
    return ordered.find((agent) => agent.id === activeId) ?? ordered[0];
  }

  const summaryEntries: readonly FleetFilter[] = ["all", "attention", "working", "waiting", "failed", "done"];
  const summaryCount = (candidate: FleetFilter) =>
    candidate === "all"
      ? agents.length
      : candidate === "attention"
        ? agents.filter(needsAttention).length
        : agents.filter((agent) => agent.status === candidate).length;

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
        else if (event.key === "Enter" || key === "t") { const agent = activeAgent(); if (agent) { event.preventDefault(); event.stopPropagation(); onTerminal(agent.id); } }
        else if (key === "d") { const agent = activeAgent(); if (agent) { event.preventDefault(); event.stopPropagation(); onChanges(agent.id); } }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      }}
      initial={{ opacity: 0, y: 16, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.99 }}
      transition={enterTransition}
    >
      <header className="fleet-header">
        <div>
          <span className="eyebrow">HEED · LIVE AGENTS</span>
          <h2>{filter === "attention" ? "Needs you" : "All agents"}</h2>
          <p>{fleetSummary}</p>
        </div>
        <label className="fleet-search">
          <span>⌕</span>
          <input ref={search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find session, task or workspace…" />
        </label>
        <button className="icon-button" onClick={onClose} aria-label="Close fleet" type="button"><Glyph name="close" /></button>
      </header>
      <div className="fleet-body">
        <aside className="fleet-summary">
          {summaryEntries.map((candidate) => {
            const label = candidate === "all" ? "All sessions" : candidate === "attention" ? "Needs you" : statusLabels[candidate];
            return (
              <button
                key={candidate}
                className={`${filter === candidate ? "is-active" : ""} ${candidate !== "all" && candidate !== "attention" ? `status-surface-${candidate}` : "summary-attention"}`}
                onClick={() => onFilter(candidate)}
                type="button"
              >
                {candidate === "attention" ? <span className="status-mark status-needs-you" aria-hidden="true" /> : candidate === "all" ? null : <StatusMark status={candidate} />}
                <span>{label}</span><b>{summaryCount(candidate)}</b>
              </button>
            );
          })}
          <div className="fleet-note"><Glyph name="branch" /><p>Agents may come from different runtimes. Controls appear only when a runtime supports them.</p></div>
        </aside>
        <div className="fleet-list">
          <div className="fleet-scroll">
          {grouped.map((group) => (
            <section className={`fleet-group status-surface-${group.status}`} key={group.status}>
              <header><StatusMark status={group.status} /><strong>{statusLabels[group.status]}</strong><span>{group.agents.length}</span></header>
              <div className="fleet-rows">
                {group.agents.map((agent) => (
                  <button
                    className={agent.id === activeId ? "is-selected" : ""}
                    disabled={agent.runtime?.sourceAvailable === false}
                    onFocus={() => setActiveId(agent.id)}
                    onMouseEnter={() => setActiveId(agent.id)}
                    onClick={() => onTerminal(agent.id)}
                    type="button"
                    data-agent-id={agent.id}
                    key={agent.id}
                  >
                    <span className="fleet-agent-copy"><strong>{agent.name}</strong><small>{agent.task}</small></span>
                    <span className="fleet-agent-meta"><b>{agent.workspace ?? "No workspace"}</b><small>{agent.runtime?.sourceLabel ?? agent.provider} · {agent.model}</small></span>
                    <span className="fleet-elapsed">{agent.elapsed}</span>
                    {agent.attention ? <span className="fleet-attention">{agent.attention}</span> : <span className="fleet-open">↗</span>}
                  </button>
                ))}
              </div>
            </section>
          ))}
          {grouped.length === 0 ? (
            <EmptyState>{query ? "No matching Agent sessions." : filter === "attention" ? "All clear. Press A to browse all Agents." : "No Agent sessions."}</EmptyState>
          ) : null}
          </div>
          <div className="fleet-keyboard-help"><span>↑↓ / J K</span> navigate <span>↵</span> terminal <span>D</span> changes <span>/</span> search <span>A</span> attention/all</div>
        </div>
      </div>
    </motion.section>
  );
}
