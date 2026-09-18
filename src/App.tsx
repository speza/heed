import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useEffect, useMemo, useRef, useState } from "react";
import { initialAgents } from "./fixtures";
import { DiffDrawer } from "./DiffDrawer";
import { TerminalOutput } from "./TerminalOutput";
import { fetchAgentChanges, fetchRuntime } from "./runtime/client";
import { runtimeAgent } from "./runtime/map";
import type { RuntimeConnection } from "./runtime/types";
import type { Agent, AgentStatus, ChatMessage } from "./types";

type Drawer = "focus" | "fleet" | "diff" | "help";
type FleetFilter = AgentStatus | "attention" | "all";
type Evidence = "result";
type FocusMode = "map" | "list";
type Edge = "bottom" | "right";

interface HudGeometry {
  readonly drawer: Drawer | null;
  readonly edge: Edge;
  readonly mode: FocusMode;
}

const hasBridge =
  typeof window !== "undefined" &&
  !!(window as unknown as { webkit?: { messageHandlers?: { shell?: unknown } } }).webkit?.messageHandlers?.shell;

interface OrbitNode {
  readonly agent: Agent;
  readonly relation: "parent" | "child";
  readonly x: number;
  readonly y: number;
}

/** Panel geometry the native shell mirrors; width is constant so only height animates. */
function panelSize(drawer: Drawer | null, edge: Edge, _mode: FocusMode) {
  // One stage size for every open drawer: ⌘-cycling swaps panes inside a
  // constant window, so switching can never flicker the native geometry.
  if (drawer !== null) {
    return edge === "right" ? { width: 1120, height: 860 } : { width: 1040, height: 840 };
  }
  return edge === "right" ? { width: 76, height: 260 } : { width: 776, height: 76 };
}

function drawerSize(drawer: Drawer | null, _edge: Edge, _mode: FocusMode) {
  return drawer === null ? null : { width: 1000, height: 760 };
}

const statusLabels: Record<AgentStatus, string> = {
  working: "Working",
  waiting: "Waiting",
  "needs-you": "Needs you",
  done: "Done",
  failed: "Failed",
  unknown: "Unknown",
};

// One motion language: quick, crisp, no overshoot. The native window frame
// snaps instantly; these transitions own all perceived motion.
const easeOutExpo: [number, number, number, number] = [0.22, 1, 0.36, 1];
const enterTransition = { duration: 0.16, ease: easeOutExpo };
const exitTransition = { duration: 0.11, ease: "easeIn" as const };
const glideTransition = { duration: 0.18, ease: "easeOut" as const };

const attentionPriority: Record<AgentStatus, number> = {
  "needs-you": 0,
  failed: 1,
  working: 2,
  waiting: 3,
  done: 4,
  unknown: 5,
};

function needsAttention(agent: Agent) {
  return agent.status === "needs-you" || agent.status === "failed" || agent.attention !== undefined;
}

function shellMessage(type: string, payload: Record<string, unknown> = {}) {
  const bridge = (
    window as typeof window & {
      webkit?: {
        messageHandlers?: { shell?: { postMessage: (message: unknown) => void } };
      };
    }
  ).webkit?.messageHandlers?.shell;
  bridge?.postMessage({ type, ...payload });
}

function Glyph({ name }: { readonly name: "close" | "spark" | "branch" | "command" | "fleet" }) {
  const paths = {
    close: <path d="m5 5 10 10M15 5 5 15" />,
    spark: <path d="M10 2.5 12 8l5.5 2-5.5 2-2 5.5L8 12l-5.5-2L8 8l2-5.5Z" />,
    branch: <path d="M6 3v10a4 4 0 0 0 4 4h4M14 13l4 4-4 4M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />,
    command: <path d="M8 7H5.5a2.5 2.5 0 1 1 2.5-2.5V7Zm0 0v6m0 0H5.5A2.5 2.5 0 1 0 8 15.5V13Zm0 0h4m0 0v2.5a2.5 2.5 0 1 0 2.5-2.5H12Zm0 0V7m0 0h2.5A2.5 2.5 0 1 0 12 4.5V7Z" />,
    fleet: <path d="M4 4h4v4H4V4Zm8 0h4v4h-4V4ZM4 12h4v4H4v-4Zm8 0h4v4h-4v-4Z" />,
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      {paths[name]}
    </svg>
  );
}

function StatusMark({ status }: { readonly status: AgentStatus }) {
  return <span className={`status-mark status-${status}`} aria-label={statusLabels[status]} />;
}

function ApertureMark({ connection }: { readonly connection: RuntimeConnection }) {
  return (
    <svg className={`aperture-mark aperture-runtime-${connection}`} viewBox="0 0 128 128" aria-hidden="true">
      <circle className="aperture-ring" cx="64" cy="64" r="56" />
      <path className="aperture-datum" d="M6 94 122 34" />
      <circle className="aperture-signal" cx="91" cy="40" r="14" />
    </svg>
  );
}

function CentralAgentCard({ agent }: { readonly agent: Agent }) {
  return (
    <motion.article
      key={agent.id}
      className={`central-agent status-surface-${agent.status}`}
      initial={{ opacity: 0, scale: 0.94, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: -6 }}
      transition={enterTransition}
    >
      <div className="central-kicker">
        <span><StatusMark status={agent.status} />{statusLabels[agent.status]}</span>
        <span>{agent.elapsed}</span>
      </div>
      <h1>{agent.name}</h1>
      <p>{agent.task}</p>
      <div className="agent-meta">
        <span>{agent.runtime?.sourceLabel ?? agent.provider}</span>
        <i />
        <span>{agent.model}</span>
      </div>
      {agent.attention ? <div className="attention-chip">{agent.attention}</div> : null}
    </motion.article>
  );
}

function OrbitAgent({ node, onSelect }: { readonly node: OrbitNode; readonly onSelect: () => void }) {
  const { agent, relation, x, y } = node;
  return (
    <motion.button
      layout
      type="button"
      className={`orbit-agent orbit-${relation} status-surface-${agent.status}`}
      style={{ left: `calc(50% + ${x}px)`, top: `calc(50% + ${y}px)` }}
      initial={{ opacity: 0, scale: 0.78, x: "-50%", y: "-50%" }}
      animate={{ opacity: 1, scale: 1, x: "-50%", y: "-50%" }}
      exit={{ opacity: 0, scale: 0.82, x: "-50%", y: "-50%" }}
      transition={{ ...enterTransition, layout: glideTransition }}
      onClick={onSelect}
    >
      <span className="orbit-status"><StatusMark status={agent.status} /></span>
      <span className="orbit-copy">
        <strong>{agent.name}</strong>
        <small>{relation === "parent" ? "Parent" : agent.role}</small>
      </span>
      {agent.attention ? <span className="orbit-attention">!</span> : null}
    </motion.button>
  );
}

// Map canvas: 780×552 (the special view). Children ring the central card.
const mapLayout = {
  parent: { x: -300, y: 15 },
  withParent: [
    { x: 150, y: -195 },
    { x: 270, y: -25 },
    { x: 185, y: 115 },
    { x: 35, y: 205 },
  ],
  alone: [
    { x: -250, y: -190 },
    { x: 150, y: -200 },
    { x: 270, y: -5 },
    { x: 120, y: 190 },
    { x: -235, y: 205 },
  ],
  more: { x: -235, y: 205 },
} as const;

function Constellation({
  selected,
  nodes,
  overflow,
  onSelect,
  onMore,
}: {
  readonly selected: Agent;
  readonly nodes: readonly OrbitNode[];
  readonly overflow: number;
  readonly onSelect: (id: string) => void;
  readonly onMore: () => void;
}) {
  return (
    <section className="constellation" aria-label="Focused agent constellation">
      <svg className="relationship-layer" viewBox="-390 -276 780 552" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="edgeGradient" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="rgba(255,112,73,.4)" />
            <stop offset="1" stopColor="rgba(224,226,220,.12)" />
          </linearGradient>
        </defs>
        {nodes.map(({ agent, x, y }) => (
          <motion.path
            key={`${selected.id}-${agent.id}`}
            d={`M 0 0 C ${x * 0.42} ${y * 0.08}, ${x * 0.7} ${y * 0.86}, ${x} ${y}`}
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.24, ease: easeOutExpo }}
          />
        ))}
      </svg>
      <div className="central-slot">
        <AnimatePresence mode="wait">
          <CentralAgentCard agent={selected} />
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {nodes.map((node) => (
          <OrbitAgent key={node.agent.id} node={node} onSelect={() => onSelect(node.agent.id)} />
        ))}
      </AnimatePresence>
      {overflow > 0 ? (
        <motion.button
          layout
          type="button"
          className="orbit-more"
          style={{ left: `calc(50% + ${mapLayout.more.x}px)`, top: `calc(50% + ${mapLayout.more.y}px)` }}
          initial={{ opacity: 0, scale: 0.78, x: "-50%", y: "-50%" }}
          animate={{ opacity: 1, scale: 1, x: "-50%", y: "-50%" }}
          exit={{ opacity: 0, scale: 0.82, x: "-50%", y: "-50%" }}
          transition={{ ...enterTransition, layout: glideTransition }}
          onClick={onMore}
        >
          +{overflow} more
        </motion.button>
      ) : null}
      {nodes.some((node) => node.relation === "parent") ? (
        <span className="constellation-label parent-label">context</span>
      ) : null}
      <span className="constellation-label child-label">delegated work</span>
    </section>
  );
}

function EmptyState({ children }: { readonly children: string }) {
  return <div className="empty-state">{children}</div>;
}

function FocusRow({ agent, tag, onSelect }: { readonly agent: Agent; readonly tag?: string; readonly onSelect: () => void }) {
  return (
    <button className={`focus-row status-surface-${agent.status}`} onClick={onSelect} type="button">
      <span className="orbit-status"><StatusMark status={agent.status} /></span>
      <span className="orbit-copy">
        <strong>{agent.name}</strong>
        <small>{agent.role}</small>
      </span>
      {agent.attention ? <span className="orbit-attention">!</span> : null}
      <span className="focus-row-tag">{tag ?? agent.elapsed}</span>
    </button>
  );
}

function FocusListHead({ agent }: { readonly agent: Agent }) {
  return (
    <header className={`focus-list-head status-surface-${agent.status}`}>
      <div className="focus-list-head-row">
        <StatusMark status={agent.status} />
        <h1>{agent.name}</h1>
        <span className="focus-list-head-when">{statusLabels[agent.status]} · {agent.elapsed}</span>
      </div>
      <p className="focus-list-head-task">{agent.task}</p>
    </header>
  );
}

function FocusList({
  selected,
  parent,
  children,
  onSelect,
}: {
  readonly selected: Agent;
  readonly parent?: Agent;
  readonly children: readonly Agent[];
  readonly onSelect: (id: string) => void;
}) {
  return (
    <section className="focus-list" aria-label="Focused agent relationships">
      <FocusListHead agent={selected} />
      <div className="focus-list-rows">
        {selected.runtime ? (
          <div className="runtime-location">
            <span>{selected.runtime.sourceLabel} location</span>
            <dl>
              {selected.workspace || selected.runtime.location?.workspaceId ? (
                <div><dt>Workspace</dt><dd>{selected.workspace ?? selected.runtime.location?.workspaceId}</dd></div>
              ) : null}
              {selected.runtime.location?.tabId ? <div><dt>Tab</dt><dd>{selected.runtime.location.tabId}</dd></div> : null}
              {selected.runtime.location?.paneId ? <div><dt>Pane</dt><dd>{selected.runtime.location.paneId}</dd></div> : null}
              {selected.runtime.location?.cwd ? <div><dt>Directory</dt><dd>{selected.runtime.location.cwd}</dd></div> : null}
              {!selected.runtime.location ? <div><dt>Location</dt><dd>Not exposed by this runtime</dd></div> : null}
            </dl>
          </div>
        ) : (
          <>
            {parent ? <FocusRow agent={parent} tag="Parent" onSelect={() => onSelect(parent.id)} /> : null}
            <div className="focus-list-caption">delegated · {children.length}</div>
            {children.map((agent) => (
              <FocusRow key={agent.id} agent={agent} onSelect={() => onSelect(agent.id)} />
            ))}
            {children.length === 0 ? <div className="focus-list-empty">No delegated children yet.</div> : null}
          </>
        )}
      </div>
    </section>
  );
}

function EvidencePanel({ agent, evidence }: { readonly agent: Agent; readonly evidence: Evidence }) {
  return (
    <motion.div
      className="evidence-panel"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={enterTransition}
    >
      {evidence === "result" ? (
        agent.result ? (
          <div className="evidence-result">
            <div className="result-mark"><Glyph name="spark" /></div>
            <p>{agent.result}</p>
          </div>
        ) : (
          <EmptyState>No explicit result yet. Runtime state is not treated as completion.</EmptyState>
        )
      ) : null}
    </motion.div>
  );
}

function TerminalCard({
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
        <span className="terminal-back-hint">Back to agents <kbd>⌘W</kbd></span>
        <button className="icon-button" onClick={onClose} aria-label="Close terminal and return to agents (Command-W)" type="button"><Glyph name="close" /></button>
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

const fleetOrder: readonly AgentStatus[] = ["needs-you", "working", "waiting", "failed", "done", "unknown"];

function FleetView({
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

  const summaryEntries: readonly (FleetFilter | null)[] = ["all", "attention", "working", "waiting", "failed", "done"];
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
        const editing = event.target === search.current;
        if (editing) {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setQuery("");
            root.current?.focus();
          }
          return;
        }
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
            if (candidate === null) return null;
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
                    onFocus={() => setActiveId(agent.id)}
                    onMouseEnter={() => setActiveId(agent.id)}
                    onClick={() => onTerminal(agent.id)}
                    type="button"
                    data-agent-id={agent.id}
                    key={agent.id}
                  >
                    <span className="fleet-agent-copy"><strong>{agent.name}</strong><small>{agent.task}</small></span>
                    <span className="fleet-agent-meta"><b>{agent.workspace ?? "minimal-ade"}</b><small>{agent.runtime?.sourceLabel ?? agent.provider} · {agent.model}</small></span>
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

function CommandPalette({
  agents,
  onClose,
  onSelectAgent,
  onFleet,
  onSpawn,
  onChanges,
  live,
}: {
  readonly agents: readonly Agent[];
  readonly onClose: () => void;
  readonly onSelectAgent: (id: string) => void;
  readonly onFleet: (filter: FleetFilter) => void;
  readonly onSpawn: () => void;
  readonly onChanges: () => void;
  readonly live: boolean;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const commands = useMemo(
    () => [
      { id: "cmd-all", label: "All agents", hint: "fleet", run: () => onFleet("all") },
      { id: "cmd-working", label: "Show working now", hint: "fleet", run: () => onFleet("working") },
      { id: "cmd-attention", label: "Needs you", hint: "triage", run: () => onFleet("attention") },
      ...(live ? [] : [{ id: "cmd-spawn", label: "Spawn child", hint: "demo", run: onSpawn }]),
      { id: "cmd-changes", label: live ? "Workspace changes" : "Show changes", hint: "D", run: onChanges },
    ],
    [onFleet, onSpawn, onChanges, live],
  );

  const normalized = query.trim().toLowerCase();
  const matchedCommands = commands.filter((command) => command.label.toLowerCase().includes(normalized));
  const matchedAgents = agents
    .filter((agent) => `${agent.name} ${agent.task}`.toLowerCase().includes(normalized))
    .slice(0, 6);
  const total = matchedCommands.length + matchedAgents.length;

  useEffect(() => input.current?.focus(), []);

  function move(step: number) {
    if (total === 0) return;
    setActive((current) => (current + step + total) % total);
  }

  function run(index: number) {
    if (index < matchedCommands.length) matchedCommands[index]?.run();
    else {
      const agent = matchedAgents[index - matchedCommands.length];
      if (agent) onSelectAgent(agent.id);
    }
    onClose();
  }

  return (
    <motion.div className="palette-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
      <motion.div className="command-palette" initial={{ opacity: 0, y: -16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10, scale: 0.98 }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-input"><Glyph name="command" /><input
          ref={input}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
            else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
            else if (event.key === "Enter") { event.preventDefault(); run(active); }
          }}
          placeholder="Find an Agent or run a command…"
        /></div>
        <div className="palette-results">
          {matchedCommands.map((command, index) => (
            <button key={command.id} type="button" className={index === active ? "is-active" : ""} onMouseEnter={() => setActive(index)} onClick={() => run(index)}>
              <Glyph name="command" />
              <span><strong>{command.label}</strong></span>
              <kbd>{command.hint}</kbd>
            </button>
          ))}
          {matchedAgents.map((agent, index) => {
            const index_ = matchedCommands.length + index;
            return (
              <button key={agent.id} type="button" className={index_ === active ? "is-active" : ""} onMouseEnter={() => setActive(index_)} onClick={() => run(index_)}>
                <StatusMark status={agent.status} />
                <span><strong>{agent.name}</strong><small>{agent.task}</small></span>
                <kbd>↵</kbd>
              </button>
            );
          })}
        </div>
        <footer><span>↑↓ navigate</span><span>↵ run</span><span>⌥Space attention</span><span>esc close</span></footer>
      </motion.div>
    </motion.div>
  );
}

function KeyboardHelp({ onClose }: { readonly onClose: () => void }) {
  const groups = [
    { title: "Global", shortcuts: [["⌥Space", "Open / collapse main pane"], ["?", "Keyboard shortcuts"], ["⌘K", "Command palette"], ["Sidebar ×", "Hide Heed"]] },
    { title: "Agent list", shortcuts: [["↑ ↓ / J K", "Navigate"], ["↵ / T", "Open terminal"], ["D", "Workspace changes"], ["/", "Search"], ["A", "Attention / all"], ["Esc", "Collapse to sidebar"]] },
    { title: "Terminal", shortcuts: [["⌘W", "Back to agents"], ["Esc", "Terminal input"], ["Wheel / PgUp PgDn", "Scroll"]] },
  ] as const;

  return (
    <motion.section
      className="keyboard-help"
      initial={{ opacity: 0, y: 16, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.99 }}
      transition={enterTransition}
      aria-labelledby="keyboard-help-title"
    >
      <header>
        <div><span className="eyebrow">HEED · REFERENCE</span><h2 id="keyboard-help-title">Keyboard shortcuts</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close keyboard shortcuts" type="button"><Glyph name="close" /></button>
      </header>
      <div className="keyboard-help-groups">
        {groups.map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            <dl>{group.shortcuts.map(([keys, action]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{action}</dd></div>)}</dl>
          </section>
        ))}
      </div>
      <footer><span>Press</span><kbd>?</kbd><span>again to return</span></footer>
    </motion.section>
  );
}

function HudBar({
  attentionCount,
  onFocusToggle,
  onTriage,
  onFleet,
  onHelp,
  connection,
}: {
  readonly attentionCount: number;
  readonly onFocusToggle: () => void;
  readonly onTriage: () => void;
  readonly onFleet: () => void;
  readonly onHelp: () => void;
  readonly connection: RuntimeConnection;
}) {
  return (
    <footer className="hud-bar" data-native-drag>
      <button className="bar-agent" onClick={onFocusToggle} type="button" aria-label={`Runtime ${connection}; toggle focus drawer`}>
        <ApertureMark connection={connection} />
      </button>
      <button
        className={`bar-attention ${attentionCount === 0 ? "is-zero" : ""}`}
        onClick={onTriage}
        aria-label={attentionCount === 0 ? "0 need you · all clear" : `${attentionCount} need you`}
        type="button"
      >
        <span className="status-mark status-needs-you" aria-hidden="true" />
        <b>{attentionCount}</b>
        <span className="att-label">{attentionCount === 0 ? "all clear" : "need you"}</span>
      </button>
      <span className="bar-spacer" />
      <button className="icon-button" onClick={onFleet} aria-label="All agents" type="button"><Glyph name="fleet" /></button>
      <button className="icon-button help-button" onClick={onHelp} aria-label="Keyboard shortcuts" type="button">?</button>
      <button className="icon-button" onClick={() => shellMessage("hide")} aria-label="Hide panel" type="button"><Glyph name="close" /></button>
    </footer>
  );
}

const runtimePlaceholder: Agent = {
  id: "runtime-placeholder",
  name: "Connecting to runtimes",
  role: "Runtime",
  task: "Waiting for configured agent runtimes",
  status: "waiting",
  provider: "Configured runtime",
  model: "Local",
  elapsed: "now",
  messages: [],
  changes: [],
};

export function App({ demo = import.meta.env.MODE === "test" || new URLSearchParams(window.location.search).has("demo") }: { readonly demo?: boolean }) {
  const [agents, setAgents] = useState<readonly Agent[]>(demo ? initialAgents : []);
  const [selectedId, setSelectedId] = useState(demo ? "lead" : "");
  const [drawer, setDrawer] = useState<Drawer | null>(demo ? "focus" : "fleet");
  const [focusMode, setFocusMode] = useState<FocusMode>("list");
  // The right spine won the anchor trial (ADR-0006); bottom is retired.
  const edge: Edge = "right";
  const [replyOpen, setReplyOpen] = useState(false);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [fleetFilter, setFleetFilter] = useState<FleetFilter>(demo ? "all" : "attention");
  const [returnDrawer, setReturnDrawer] = useState<Drawer>(demo ? "focus" : "fleet");
  const [helpReturnDrawer, setHelpReturnDrawer] = useState<Drawer | null>(demo ? "focus" : "fleet");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [attentionFocusRequest, setAttentionFocusRequest] = useState(0);
  const [connection, setConnection] = useState<RuntimeConnection>(demo ? "demo" : "connecting");
  const [actionError, setActionError] = useState<string>();

  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0] ?? runtimePlaceholder;
  const selectedParent = useMemo(
    () => (selected.parentId ? agents.find((agent) => agent.id === selected.parentId) : undefined),
    [agents, selected],
  );
  const selectedChildren = useMemo(() => agents.filter((agent) => agent.parentId === selected.id), [agents, selected]);
  const attentionAgents = useMemo(() => {
    const attention = agents.filter(needsAttention);
    return demo
      ? attention.sort((a, b) => attentionPriority[a.status] - attentionPriority[b.status] || a.name.localeCompare(b.name))
      : attention;
  }, [agents, demo]);

  useEffect(() => {
    if (demo) return;
    let active = true;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const snapshot = await fetchRuntime();
        if (!active) return;
        if (!snapshot.available) {
          setConnection((current) => current === "live" || current === "stale" ? "stale" : "offline");
        } else {
          const next = snapshot.agents.map(runtimeAgent);
          setAgents((current) => next.map((agent) => {
            const existing = current.find((candidate) => candidate.id === agent.id);
            return existing?.changes.length ? { ...agent, workspace: existing.workspace, changes: existing.changes } : agent;
          }));
          setSelectedId((current) => next.some((agent) => agent.id === current) ? current : (next[0]?.id ?? ""));
          setConnection("live");
        }
      } catch {
        if (active) setConnection((current) => current === "live" || current === "stale" ? "stale" : "offline");
      } finally {
        if (active) timer = window.setTimeout(refresh, 2_000);
      }
    };
    void refresh();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [demo]);

  const nodes = useMemo<readonly OrbitNode[]>(() => {
    const slots = selectedParent ? mapLayout.withParent : mapLayout.alone;
    const related: OrbitNode[] = [];
    if (selectedParent) related.push({ agent: selectedParent, relation: "parent", ...mapLayout.parent });
    selectedChildren.forEach((agent, index) => {
      related.push({ agent, relation: "child", ...(slots[index] ?? mapLayout.more) });
    });
    return related;
  }, [selectedParent, selectedChildren]);

  // Keep the native panel geometry in step with the drawer stack.
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;
  const edgeRef = useRef(edge);
  edgeRef.current = edge;
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  // The native window is the source of truth for when a geometry change has
  // actually landed: the web renders the committed geometry so it never
  // paints a layout the window cannot show yet (the switch/close flicker).
  const [rendered, setRendered] = useState<HudGeometry>({ drawer: demo ? "focus" : "fleet", edge: "right", mode: "list" });
  const geometryTarget = { drawer, edge, mode: focusMode };
  const geometryTargetRef = useRef(geometryTarget);
  geometryTargetRef.current = geometryTarget;

  // Post before paint: the native window should move in step with the first
  // frame of the new web layout, not one frame after it.
  useLayoutEffect(() => {
    shellMessage("resize", { ...panelSize(drawer, edge, focusMode), edge, drawer: drawerSize(drawer, edge, focusMode) });
    if (!hasBridge) {
      setRendered(geometryTargetRef.current);
      return;
    }
    // Safety net: commit even if the shell's confirmation never arrives.
    const fallback = window.setTimeout(() => {
      setRendered(geometryTargetRef.current);
      shellMessage("commit", {});
    }, 150);
    return () => window.clearTimeout(fallback);
  }, [drawer, edge, focusMode]);
  // Phase 2: once the committed layout is in the DOM (pre-paint), ack so the
  // shell moves the vibrancy glass together with the new content.
  useLayoutEffect(() => {
    if (hasBridge) shellMessage("commit", {});
  }, [rendered.drawer, rendered.edge, rendered.mode]);
  useEffect(() => {
    const commit = () => setRendered({ ...geometryTargetRef.current });
    window.addEventListener("heed:resized", commit);
    return () => window.removeEventListener("heed:resized", commit);
  }, []);
  useEffect(() => {
    const showAttention = () => {
      setPaletteOpen(false);
      setReplyOpen(false);
      setEvidence(null);
      setFleetFilter("attention");
      setDrawer("fleet");
      setAttentionFocusRequest((request) => request + 1);
    };
    const prepareHidden = () => {
      setPaletteOpen(false);
      setReplyOpen(false);
      setFleetFilter("attention");
      setDrawer("fleet");
    };
    window.addEventListener("heed:shown", showAttention);
    window.addEventListener("heed:hidden", prepareHidden);
    return () => {
      window.removeEventListener("heed:shown", showAttention);
      window.removeEventListener("heed:hidden", prepareHidden);
    };
  }, []);

  useEffect(() => {
    const toggleMainSurface = () => {
      if (drawer !== null || paletteOpen || replyOpen) {
        setPaletteOpen(false);
        setReplyOpen(false);
        setEvidence(null);
        setDrawer(null);
        return;
      }
      setFleetFilter("attention");
      setDrawer("fleet");
      setAttentionFocusRequest((request) => request + 1);
    };
    window.addEventListener("heed:toggle-main", toggleMainSurface);
    return () => window.removeEventListener("heed:toggle-main", toggleMainSurface);
  }, [drawer, paletteOpen, replyOpen]);

  function closeCurrentSurface() {
    if (paletteOpen) setPaletteOpen(false);
    else if (replyOpen) setReplyOpen(false);
    else if (drawer === "help") setDrawer(helpReturnDrawer);
    else if (drawer === "diff") setDrawer(returnDrawer);
    else if (drawer === "focus") openFleet("attention");
    else if (drawer === "fleet") setDrawer(null);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const key = event.key.toLowerCase();
      const command = event.metaKey;

      // Capture the two application commands before xterm can forward them.
      if (command && key === "w") {
        event.preventDefault();
        event.stopPropagation();
        closeCurrentSurface();
        return;
      }
      if (command && key === "k") {
        event.preventDefault();
        event.stopPropagation();
        setPaletteOpen((open) => !open);
        return;
      }

      // Everything else belongs to xterm while the terminal has focus.
      if (target?.closest?.(".terminal-frame")) return;
      const editable = target?.closest?.("input, textarea, select, [contenteditable]");
      if (!command && !event.altKey && key === "?" && !editable) {
        event.preventDefault();
        event.stopPropagation();
        toggleKeyboardHelp();
        return;
      }
      // Fleet owns its complete keyboard model locally.
      if (target?.closest?.(".fleet-drawer")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeCurrentSurface();
        return;
      }
      if (command || event.altKey || editable) return;

      if (key === "t" && drawer === "focus" && !replyOpen && (demo || selected.runtime?.capabilities.terminal)) {
        event.preventDefault();
        setEvidence(null);
        setReplyOpen(true);
      } else if (key === "d" && drawer === "focus" && !replyOpen) {
        event.preventDefault();
        void openChanges();
      }
    };
    const onNativeBack = () => closeCurrentSurface();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("heed:back", onNativeBack);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("heed:back", onNativeBack);
    };
  }, [paletteOpen, replyOpen, drawer, returnDrawer, helpReturnDrawer, demo, selected.runtime]);

  function selectAgent(id: string) {
    setSelectedId(id);
    setEvidence(null);
    setReplyOpen(false);
    setDrawer("focus");
  }

  function openFleet(filter: FleetFilter) {
    setPaletteOpen(false);
    setFleetFilter(filter);
    setReplyOpen(false);
    setDrawer("fleet");
  }

  function toggleFocusDrawer() {
    setReplyOpen(false);
    setDrawer((current) => (current === "focus" ? null : "focus"));
  }

  function toggleKeyboardHelp() {
    if (drawer === "help") {
      setDrawer(helpReturnDrawer);
      return;
    }
    setHelpReturnDrawer(drawer);
    setPaletteOpen(false);
    setReplyOpen(false);
    setDrawer("help");
  }

  function openTerminal(id: string) {
    const agent = agents.find((candidate) => candidate.id === id);
    if (!agent) return;
    setSelectedId(id);
    setEvidence(null);
    if (demo || agent.runtime?.capabilities.terminal) setReplyOpen(true);
    else setDrawer("focus");
  }

  async function openChangesFor(id: string) {
    const agent = agents.find((candidate) => candidate.id === id);
    if (!agent) return;
    setActionError(undefined);
    setSelectedId(id);
    setReturnDrawer(drawer === "fleet" ? "fleet" : "focus");
    if (!agent.runtime) {
      if (!demo) {
        setActionError("No runtime is attached to this agent.");
        return;
      }
      setEvidence(null);
      setDrawer("diff");
      return;
    }
    if (!agent.runtime.capabilities.workspaceChanges) {
      setActionError(`${agent.runtime.sourceLabel} does not expose workspace changes.`);
      return;
    }
    try {
      const result = await fetchAgentChanges(id);
      setAgents((current) => current.map((candidate) => candidate.id === id ? { ...candidate, workspace: result.workspace, changes: result.files } : candidate));
      if (result.message) setActionError(result.message);
      setEvidence(null);
      setDrawer("diff");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Workspace changes could not be read.");
    }
  }

  async function openChanges() {
    await openChangesFor(selected.id);
  }

  function spawnChild() {
    const id = `worker-${Date.now()}-${Math.round(Math.random() * 1e4)}`;
    const child: Agent = {
      id,
      parentId: selected.id,
      name: "New collaborator",
      role: "Unassigned",
      task: "Starting from the selected Agent’s context",
      status: "working",
      provider: "Default profile",
      model: "Auto",
      elapsed: "now",
      messages: [],
      changes: [],
    };
    setAgents((current) => [...current, child]);
    selectAgent(id);
  }

  return (
    <main className="hud-root">
      <div className="hud" data-edge={rendered.edge} data-mode={rendered.mode}>
        {/* No exit animations on drawers: the window and web layout change in
            the same frame, so nothing lingers to flicker at the old size. */}
        {rendered.drawer === "focus" ? (
            <motion.section
              key="focus"
              className="focus-drawer"
              data-mode={rendered.mode}
              initial={{ opacity: 0, y: 18, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.99 }}
              transition={enterTransition}
            >
              <div className="focus-canvas">
                {/* Instant swap: the crossfade's wait-for-exit could leave the
                    canvas empty during rapid ⌘-cycling. */}
                {rendered.mode === "map" ? (
                  <div className="focus-mode-layer">
                    <Constellation
                      selected={selected}
                      nodes={nodes}
                      overflow={Math.max(0, selectedChildren.length - (selectedParent ? 4 : 5))}
                      onSelect={selectAgent}
                      onMore={() => openFleet("all")}
                    />
                  </div>
                ) : (
                  <div className="focus-mode-layer">
                    <FocusList selected={selected} parent={selectedParent} children={selectedChildren} onSelect={selectAgent} />
                  </div>
                )}
              </div>
              <AnimatePresence>
                {evidence ? <EvidencePanel agent={selected} evidence={evidence} key={evidence} /> : null}
              </AnimatePresence>
              <div className="focus-actions">
                {demo ? <div className="mode-toggle" role="group" aria-label="Focus layout">
                  <button type="button" className={rendered.mode === "map" ? "is-active" : ""} onClick={() => setFocusMode("map")}>Map</button>
                  <button type="button" className={rendered.mode === "list" ? "is-active" : ""} onClick={() => setFocusMode("list")}>List</button>
                </div> : null}
                {demo ? (
                  <button className={`chip ${evidence === "result" ? "is-active" : ""}`} onClick={() => setEvidence((current) => (current === "result" ? null : "result"))} type="button">
                    Result{selected.result ? <em aria-label="has result">✓</em> : null}
                  </button>
                ) : null}
                {(demo || selected.runtime?.capabilities.workspaceChanges) ? (
                  <button className="chip" onClick={() => void openChanges()} type="button">
                    {!demo ? "Workspace changes" : "Changes"}{selected.changes.length > 0 ? <em>{selected.changes.length}</em> : null}
                  </button>
                ) : null}
                <span className="bar-spacer" />
                {(demo || selected.runtime?.capabilities.terminal) ? <button className="chip chip-reply" onClick={() => { setEvidence(null); setReplyOpen(true); }} type="button">Terminal <kbd>T</kbd></button> : null}
                {demo ? <button className="chip chip-spawn" onClick={spawnChild} type="button"><Glyph name="branch" /> Spawn child</button> : null}
              </div>
            </motion.section>
          ) : null}
          {rendered.drawer === "fleet" ? (
            <FleetView
              agents={agents}
              selectedId={selected.id}
              filter={fleetFilter}
              onFilter={setFleetFilter}
              onClose={() => setDrawer(null)}
              onTerminal={openTerminal}
              onChanges={(id) => void openChangesFor(id)}
              keyboardActive={!replyOpen && !paletteOpen}
              focusRequest={attentionFocusRequest}
            />
          ) : null}
          {rendered.drawer === "diff" ? (
            <DiffDrawer
              agent={selected}
              onClose={() => setDrawer(returnDrawer)}
              onTerminal={demo || selected.runtime?.capabilities.terminal ? () => openTerminal(selected.id) : undefined}
            />
          ) : null}
          {rendered.drawer === "help" ? (
            <KeyboardHelp onClose={() => setDrawer(helpReturnDrawer)} />
          ) : null}
        <AnimatePresence>
          {replyOpen ? (
            <TerminalCard
              key="reply"
              agent={selected}
              messages={selected.messages}
              onClose={() => setReplyOpen(false)}
              actionError={actionError}
            />
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {paletteOpen ? (
            <CommandPalette
              agents={agents}
              onClose={() => setPaletteOpen(false)}
              onSelectAgent={selectAgent}
              onFleet={openFleet}
              onSpawn={spawnChild}
              onChanges={() => void openChanges()}
              live={!demo}
            />
          ) : null}
        </AnimatePresence>
        {actionError && !replyOpen ? <button className="runtime-toast" type="button" onClick={() => setActionError(undefined)}>{actionError}</button> : null}
        <HudBar
          attentionCount={attentionAgents.length}
          onFocusToggle={toggleFocusDrawer}
          onTriage={() => openFleet("attention")}
          onFleet={() => openFleet("all")}
          onHelp={toggleKeyboardHelp}
          connection={connection}
        />
      </div>
    </main>
  );
}
