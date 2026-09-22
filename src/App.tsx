import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useEffect, useMemo, useRef, useState } from "react";
import { initialAgents } from "./fixtures";
import { AmpTranscript } from "./AmpTranscript";
import { DiffDrawer } from "./DiffDrawer";
import { TerminalOutput } from "./TerminalOutput";
import { fetchAgentChanges, fetchAgentOutput, fetchRuntime } from "./runtime/client";
import { runtimeAgent } from "./runtime/map";
import type { RuntimeConnection, RuntimeOpenAction } from "./runtime/types";
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
function panelSize(
  drawer: Drawer | null,
  edge: Edge,
  _mode: FocusMode,
  hasConversationPeek = false,
) {
  // One stage size for every open drawer: ⌘-cycling swaps panes inside a
  // constant window, so switching can never flicker the native geometry.
  if (drawer !== null) {
    return edge === "right" ? { width: 1120, height: 860 } : { width: 1040, height: 840 };
  }
  return edge === "right"
    ? hasConversationPeek
      ? { width: 300, height: 260 }
      : { width: 76, height: 260 }
    : { width: 776, height: 76 };
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

function doneRevision(agent: Agent) {
  return agent.runtime?.revision ?? 0;
}

function isDoneAcknowledged(agent: Agent, acknowledgedDone: Readonly<Record<string, number>>) {
  return agent.status === "done" && acknowledgedDone[agent.id] === doneRevision(agent);
}

function canOpenAgentSurface(agent: Agent, demo: boolean) {
  return demo || Boolean(agent.runtime?.capabilities.terminal || agent.runtime?.capabilities.output || agent.runtime?.capabilities.conversation);
}

function agentSurfaceLabel(agent: Agent) {
  if (!agent.runtime || agent.runtime.capabilities.terminal) return "Terminal";
  if (agent.runtime.capabilities.conversation) return "Conversation";
  if (agent.runtime.capabilities.output) return "Output";
  return "Session";
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

interface NativePointerDetail {
  readonly x?: number;
  readonly y?: number;
}

function nativeInteractiveTarget(detail: NativePointerDetail) {
  if (typeof detail.x !== "number" || typeof detail.y !== "number") return null;
  return document
    .elementFromPoint(detail.x, detail.y)
    ?.closest<HTMLElement>("button, a, [role=\"button\"], summary") ?? null;
}

function safeExternalUrl(action: RuntimeOpenAction): string | undefined {
  try {
    const url = new URL(action.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function OpenInLink({ action, className = "chip chip-open" }: { readonly action?: RuntimeOpenAction; readonly className?: string }) {
  if (!action) return null;
  const url = safeExternalUrl(action);
  if (!url) return null;
  return (
    <a
      className={className}
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        if (hasBridge) {
          event.preventDefault();
          shellMessage("open-url", { url });
        }
      }}
    >
      {action.label}<span aria-hidden="true"> ↗</span>
    </a>
  );
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

function RuntimeTranscript({ agentId, sourceLabel }: { readonly agentId: string; readonly sourceLabel: string }) {
  const [output, setOutput] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setOutput(undefined);
    setError(undefined);
    setLoading(true);
    void fetchAgentOutput(agentId, controller.signal)
      .then((result) => setOutput(result.text))
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Runtime output could not be read.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [agentId]);

  return (
    <section className="runtime-output is-transcript">
      <header><span>{sourceLabel} transcript</span><small>Read-only thread history</small></header>
      {loading ? <p>Reading the latest thread output…</p> : null}
      {error ? <p className="runtime-error">{error}</p> : null}
      {!loading && !error && output ? <AmpTranscript markdown={output} /> : null}
      {!loading && !error && !output ? <small>No output was returned.</small> : null}
    </section>
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
  const surfaceLabel = agentSurfaceLabel(agent);
  return (
    <motion.section
      className="reply-card"
      initial={{ opacity: 0, y: 18, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.98 }}
      transition={enterTransition}
      aria-label={`${surfaceLabel} for ${agent.name}`}
    >
      <header className="reply-head">
        <StatusMark status={agent.status} />
        <strong>{agent.name}</strong>
        <span className="terminal-back-hint">Back to update rail <kbd>⌘W</kbd></span>
        <OpenInLink action={agent.runtime?.openIn} className="terminal-open-link" />
        <button className="icon-button" onClick={onClose} aria-label={`Close ${surfaceLabel.toLowerCase()} and return to update rail (Command-W)`} type="button"><Glyph name="close" /></button>
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
        ) : agent.runtime?.capabilities.output ? (
          <RuntimeTranscript agentId={agent.id} sourceLabel={agent.runtime.sourceLabel} />
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
  const workspaceSummary = workspaces > 0
    ? ` · ${workspaces} ${workspaces === 1 ? "workspace" : "workspaces"}`
    : "";
  const fleetSummary = filter === "attention"
    ? `${attentionSummary}${workspaceSummary}`
    : `${visible.length} ${visible.length === 1 ? "session" : "sessions"}${workspaceSummary}`;

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
                    disabled={agent.runtime?.sourceAvailable === false}
                    onFocus={() => setActiveId(agent.id)}
                    onMouseEnter={() => setActiveId(agent.id)}
                    onClick={() => onTerminal(agent.id)}
                    type="button"
                    data-agent-id={agent.id}
                    key={agent.id}
                  >
                    <span className="fleet-agent-copy"><strong>{agent.name}</strong><small>{agent.task}</small></span>
                    <span className="fleet-agent-meta"><b>{agent.workspace ?? (agent.runtime ? "Workspace unavailable" : "minimal-ade")}</b><small>{agent.runtime?.sourceLabel ?? agent.provider} · {agent.model}</small></span>
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
          <div className="fleet-keyboard-help"><span>↑↓ / J K</span> navigate <span>↵</span> open <span>D</span> changes <span>/</span> search <span>A</span> attention/all</div>
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
    onClose();
    if (index < matchedCommands.length) matchedCommands[index]?.run();
    else {
      const agent = matchedAgents[index - matchedCommands.length];
      if (agent) onSelectAgent(agent.id);
    }
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
        <footer><span>↑↓ navigate</span><span>↵ run</span><span>⌥Space focus rail</span><span>esc close</span></footer>
      </motion.div>
    </motion.div>
  );
}

function KeyboardHelp({ onClose }: { readonly onClose: () => void }) {
  const groups = [
    { title: "Global", shortcuts: [["⌥Space", "Focus update rail"], ["F", "Open full session list"], ["↑ ↓ / J K", "Cycle focused updates"], ["Enter", "Open selected update"], ["?", "Keyboard shortcuts"], ["⌘K", "Command palette"], ["Sidebar ×", "Hide Heed"]] },
    { title: "Agent list", shortcuts: [["↑ ↓ / J K", "Navigate"], ["↵ / T", "Open session surface"], ["D", "Workspace changes"], ["/", "Search"], ["A", "Attention / all"], ["Esc", "Collapse to sidebar"]] },
    { title: "Terminal", shortcuts: [["Esc", "Terminal input"], ["⌘W", "Back to update rail"], ["Wheel / PgUp PgDn", "Scroll"]] },
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
  onHover,
  connection,
}: {
  readonly attentionCount: number;
  readonly onFocusToggle: () => void;
  readonly onTriage: () => void;
  readonly onFleet: () => void;
  readonly onHelp: () => void;
  readonly onHover: () => void;
  readonly connection: RuntimeConnection;
}) {
  return (
    <footer className="hud-bar" onMouseEnter={onHover} onPointerEnter={onHover}>
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

function ConversationPeek({
  agents,
  navigationAgents,
  activeId,
  nativeHoverId,
  focusRequest,
  expanded,
  onActive,
  onSelect,
  onMore,
}: {
  readonly agents: readonly Agent[];
  readonly navigationAgents: readonly Agent[];
  readonly activeId: string;
  readonly nativeHoverId?: string;
  readonly focusRequest: number;
  readonly expanded: boolean;
  readonly onActive: (id: string) => void;
  readonly onSelect: (id: string) => void;
  readonly onMore: () => void;
}) {
  const activeButton = useRef<HTMLButtonElement>(null);
  const handledFocusRequest = useRef(0);
  const maxVisible = 5;
  const firstAgents = agents.slice(0, maxVisible);
  const activeAgent = navigationAgents.find((agent) => agent.id === activeId);
  const visibleAgents = activeAgent && !firstAgents.some((agent) => agent.id === activeId)
    ? [...firstAgents.slice(0, maxVisible - 1), activeAgent]
    : firstAgents;
  const hiddenCount = Math.max(0, navigationAgents.length - visibleAgents.length);

  useEffect(() => {
    if (!expanded || focusRequest === handledFocusRequest.current) return;
    handledFocusRequest.current = focusRequest;
    activeButton.current?.focus();
  }, [focusRequest, expanded]);

  const agentButton = (agent: Agent) => {
    const update = needsAttention(agent) ? agent.attention ?? statusLabels[agent.status] : statusLabels[agent.status];
    const active = agent.id === activeId;
    return (
      <button
        key={agent.id}
        ref={active ? activeButton : undefined}
        className={`conversation-peek-item status-surface-${agent.status} ${active ? "is-selected" : ""} ${agent.id === nativeHoverId ? "is-native-hover" : ""}`}
        data-agent-id={agent.id}
        type="button"
        aria-label={`${agent.name} · ${update}`}
        aria-current={active ? "true" : undefined}
        onFocus={() => onActive(agent.id)}
        onMouseEnter={() => onActive(agent.id)}
        onClick={() => onSelect(agent.id)}
      >
        <span className="conversation-peek-copy">
          <strong>{agent.name}</strong>
          <small>{update}</small>
        </span>
        <span className="conversation-peek-arrow" aria-hidden="true">↗</span>
        <span className="conversation-peek-mark"><StatusMark status={agent.status} /></span>
      </button>
    );
  };

  return (
    <aside
      className={`conversation-peek ${expanded ? "is-expanded" : "is-compact"}`}
      aria-label="Conversation updates"
    >
      <div className="conversation-peek-list">
        {visibleAgents.map(agentButton)}
        {navigationAgents.length > 0 ? (
          <button
            className="conversation-peek-more"
            type="button"
            onClick={onMore}
            aria-label={hiddenCount > 0 ? `View ${hiddenCount} more updates` : "View all updates"}
          >
            <span className="conversation-peek-more-label">
              {hiddenCount > 0 ? `+${hiddenCount} more updates` : "View all updates"}
            </span>
            <span className="conversation-peek-more-dots" aria-hidden="true">···</span>
          </button>
        ) : null}
      </div>
    </aside>
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
  const [drawer, setDrawer] = useState<Drawer | null>(demo ? "focus" : null);
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
  const [peekFocusRequest, setPeekFocusRequest] = useState(0);
  const [peekExpanded, setPeekExpanded] = useState(true);
  const peekHovered = useRef(false);
  const nativeHoverElement = useRef<HTMLElement | null>(null);
  const [nativeHoverAgentId, setNativeHoverAgentId] = useState<string>();
  const [windowFocused, setWindowFocused] = useState(true);
  const [acknowledgedDone, setAcknowledgedDone] = useState<Readonly<Record<string, number>>>({});
  const [connection, setConnection] = useState<RuntimeConnection>(demo ? "demo" : "connecting");
  const [actionError, setActionError] = useState<string>();
  const changesRequestRef = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 });

  const selectedTarget = agents.find((agent) => agent.id === selectedId);
  const selected = selectedTarget ?? runtimePlaceholder;

  function cancelPendingChanges(): number {
    const request = changesRequestRef.current;
    request.controller?.abort();
    request.controller = undefined;
    request.generation += 1;
    return request.generation;
  }

  useEffect(() => () => {
    cancelPendingChanges();
  }, []);

  useEffect(() => {
    if (!demo && selectedId && !selectedTarget) {
      cancelPendingChanges();
      if (replyOpen) {
        setReplyOpen(false);
        setActionError("The selected Agent is no longer available.");
      }
    }
  }, [demo, replyOpen, selectedId, selectedTarget]);

  const selectedParent = useMemo(
    () => (selected.parentId ? agents.find((agent) => agent.id === selected.parentId) : undefined),
    [agents, selected],
  );
  const selectedChildren = useMemo(() => agents.filter((agent) => agent.parentId === selected.id), [agents, selected]);
  const attentionAgents = useMemo(() => {
    const attention = agents.filter((agent) => !isDoneAcknowledged(agent, acknowledgedDone) && needsAttention(agent));
    return demo
      ? attention.sort((a, b) => attentionPriority[a.status] - attentionPriority[b.status] || a.name.localeCompare(b.name))
      : attention;
  }, [agents, acknowledgedDone, demo]);
  const workingPeekAgents = useMemo(
    () => agents.filter((agent) => agent.status === "working" && !needsAttention(agent)),
    [agents],
  );
  const donePeekAgents = useMemo(
    () => agents.filter((agent) => agent.status === "done" && !isDoneAcknowledged(agent, acknowledgedDone) && !needsAttention(agent)),
    [agents, acknowledgedDone],
  );
  const conversationPeekAgents = useMemo(
    () => [...attentionAgents, ...donePeekAgents, ...workingPeekAgents],
    [attentionAgents, donePeekAgents, workingPeekAgents],
  );
  const conversationPeekPreviewAgents = useMemo(() => {
    const attention = attentionAgents.slice(0, 3);
    const done = donePeekAgents.slice(0, 2);
    const workingSlots = Math.max(0, 5 - attention.length - done.length);
    return [...attention, ...done, ...workingPeekAgents.slice(0, workingSlots)];
  }, [attentionAgents, donePeekAgents, workingPeekAgents]);
  const [peekActiveId, setPeekActiveId] = useState("");
  const conversationPeekVisible = drawer === null && conversationPeekAgents.length > 0;

  useEffect(() => {
    if (!conversationPeekAgents.some((agent) => agent.id === peekActiveId)) {
      setPeekActiveId(conversationPeekAgents[0]?.id ?? "");
    }
  }, [conversationPeekAgents, peekActiveId]);

  useEffect(() => {
    if (demo) return;
    let active = true;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const snapshot = await fetchRuntime();
        if (!active) return;
        const next = snapshot.agents.map(runtimeAgent);
        setAgents((current) => next.map((agent) => {
          const existing = current.find((candidate) => candidate.id === agent.id);
          return existing?.changes.length ? { ...agent, workspace: existing.workspace, changes: existing.changes } : agent;
        }));
        setSelectedId((current) => {
          if (!current) return next[0]?.id ?? "";
          return current;
        });
        const sourceUnavailable = snapshot.sourceHealth.some((source) => !source.available);
        setConnection(snapshot.available ? sourceUnavailable ? "stale" : "live" : next.length > 0 ? "stale" : "offline");
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
  // The native window is the source of truth for when a geometry change has
  // actually landed: the web renders the committed geometry so it never
  // paints a layout the window cannot show yet (the switch/close flicker).
  const [rendered, setRendered] = useState<HudGeometry>({ drawer: demo ? "focus" : null, edge: "right", mode: "list" });
  const geometryTarget = { drawer, edge, mode: focusMode };
  const geometryTargetRef = useRef(geometryTarget);
  geometryTargetRef.current = geometryTarget;
  // A terminal opened from the compact rail must wait for the native stage to
  // acknowledge its full drawer size. Otherwise xterm measures the clipped
  // rail and opens the remote session at a tiny column count.
  const replyReady = replyOpen && rendered.drawer === drawer && (demo || selectedTarget !== undefined);

  // Post before paint: the native window should move in step with the first
  // frame of the new web layout, not one frame after it.
  useLayoutEffect(() => {
    shellMessage("resize", {
      ...panelSize(drawer, edge, focusMode, conversationPeekVisible),
      edge,
      drawer: drawerSize(drawer, edge, focusMode),
      conversationRail: conversationPeekVisible,
    });
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
  }, [drawer, edge, focusMode, conversationPeekVisible]);
  // Phase 2: once the committed layout is in the DOM (pre-paint), ack so the
  // shell moves the vibrancy glass together with the new content.
  useLayoutEffect(() => {
    if (hasBridge) shellMessage("commit", {});
  }, [rendered.drawer, rendered.edge, rendered.mode]);
  useEffect(() => {
    const commit = () => {
      setRendered({ ...geometryTargetRef.current });
    };
    window.addEventListener("heed:resized", commit);
    return () => window.removeEventListener("heed:resized", commit);
  }, []);
  useEffect(() => {
    const showRail = () => {
      cancelPendingChanges();
      setPaletteOpen(false);
      setReplyOpen(false);
      setEvidence(null);
      setWindowFocused(true);
      returnToUpdateRail();
    };
    const prepareHidden = () => {
      cancelPendingChanges();
      setPaletteOpen(false);
      setReplyOpen(false);
      setDrawer(null);
      setWindowFocused(false);
      setPeekExpanded(false);
    };
    window.addEventListener("heed:shown", showRail);
    window.addEventListener("heed:hidden", prepareHidden);
    return () => {
      window.removeEventListener("heed:shown", showRail);
      window.removeEventListener("heed:hidden", prepareHidden);
    };
  }, [conversationPeekAgents]);

  useEffect(() => {
    const expandPeek = () => {
      setWindowFocused(true);
      setPeekExpanded(true);
    };
    const compactPeek = () => {
      setWindowFocused(false);
      if (!peekHovered.current) setPeekExpanded(false);
    };
    window.addEventListener("focus", expandPeek);
    window.addEventListener("blur", compactPeek);
    return () => {
      window.removeEventListener("focus", expandPeek);
      window.removeEventListener("blur", compactPeek);
    };
  }, []);

  useEffect(() => {
    window.addEventListener("heed:rail-hover", handleNativeRailEnter);
    window.addEventListener("heed:rail-hover-end", handleNativeRailLeave);
    return () => {
      window.removeEventListener("heed:rail-hover", handleNativeRailEnter);
      window.removeEventListener("heed:rail-hover-end", handleNativeRailLeave);
    };
  }, [drawer, conversationPeekAgents, windowFocused]);

  useEffect(() => {
    const clearNativeHover = () => {
      nativeHoverElement.current?.classList.remove("is-native-hover");
      nativeHoverElement.current = null;
      setNativeHoverAgentId(undefined);
    };
    const handleNativePointer = (event: Event) => {
      const detail = (event as CustomEvent<NativePointerDetail>).detail;
      if (!detail) return;
      const target = nativeInteractiveTarget(detail);
      if (target === nativeHoverElement.current) return;
      nativeHoverElement.current?.classList.remove("is-native-hover");
      nativeHoverElement.current = target;
      target?.classList.add("is-native-hover");
      const id = target?.dataset.agentId;
      if (id && conversationPeekAgents.some((agent) => agent.id === id)) {
        setNativeHoverAgentId(id);
        setPeekActiveId(id);
      } else {
        setNativeHoverAgentId(undefined);
      }
    };
    const handleNativeClick = (event: Event) => {
      const detail = (event as CustomEvent<NativePointerDetail>).detail;
      if (!detail) return;
      const target = nativeInteractiveTarget(detail);
      if (target instanceof HTMLButtonElement) target.click();
    };
    window.addEventListener("heed:rail-pointer", handleNativePointer);
    window.addEventListener("heed:rail-click", handleNativeClick);
    window.addEventListener("heed:rail-hover-end", clearNativeHover);
    return () => {
      window.removeEventListener("heed:rail-pointer", handleNativePointer);
      window.removeEventListener("heed:rail-click", handleNativeClick);
      window.removeEventListener("heed:rail-hover-end", clearNativeHover);
      clearNativeHover();
    };
  }, [conversationPeekAgents]);

  function handleNativeRailEnter() {
    if (drawer !== null || conversationPeekAgents.length === 0) return;
    peekHovered.current = true;
    setPeekExpanded(true);
  }

  function handleNativeRailLeave() {
    peekHovered.current = false;
    if (!windowFocused) setPeekExpanded(false);
  }

  function handleHudMouseEnter() {
    if (hasBridge) return;
    handleNativeRailEnter();
  }

  function handleHudMouseLeave() {
    if (hasBridge) return;
    handleNativeRailLeave();
  }

  useEffect(() => {
    const toggleMainSurface = () => {
      cancelPendingChanges();
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

  useEffect(() => {
    const focusUpdateRail = () => {
      returnToUpdateRail();
    };
    window.addEventListener("heed:focus-list", focusUpdateRail);
    return () => window.removeEventListener("heed:focus-list", focusUpdateRail);
  }, [conversationPeekAgents]);

  function returnToUpdateRail(focusId?: string) {
    cancelPendingChanges();
    setPaletteOpen(false);
    setReplyOpen(false);
    setEvidence(null);
    setActionError(undefined);
    setDrawer(null);
    setPeekExpanded(true);
    setPeekActiveId(
      focusId && conversationPeekAgents.some((agent) => agent.id === focusId)
        ? focusId
        : conversationPeekAgents[0]?.id ?? "",
    );
    setPeekFocusRequest((request) => request + 1);
  }

  function acknowledgeDone(id: string) {
    const agent = agents.find((candidate) => candidate.id === id);
    if (!agent || agent.status !== "done") return;
    const revision = doneRevision(agent);
    setAcknowledgedDone((current) => current[id] === revision ? current : { ...current, [id]: revision });
  }

  function closeCurrentSurface() {
    if (paletteOpen) {
      cancelPendingChanges();
      setPaletteOpen(false);
    }
    else if (replyOpen) returnToUpdateRail(selected.id);
    else if (drawer === "help") setDrawer(helpReturnDrawer);
    else if (drawer === "diff") setDrawer(returnDrawer);
    else if (drawer === "focus" || drawer === "fleet") returnToUpdateRail(selected.id);
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

      if (event.key === "Escape" && replyOpen && !target?.closest?.(".terminal-frame")) {
        event.preventDefault();
        event.stopPropagation();
        returnToUpdateRail(selected.id);
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
      if (drawer === null && !replyOpen && !paletteOpen && !command && !event.altKey && !editable && event.key === "Enter" && peekActiveId) {
        event.preventDefault();
        event.stopPropagation();
        openPeekConversation(peekActiveId);
        return;
      }
      if (drawer === null && !replyOpen && !paletteOpen && !command && !event.altKey && !editable && key === "f") {
        event.preventDefault();
        event.stopPropagation();
        openFleet("all");
        return;
      }
      if (drawer === null && !replyOpen && !paletteOpen && !command && !editable && conversationPeekAgents.length > 0) {
        if (event.key === "ArrowDown" || key === "j") {
          event.preventDefault();
          event.stopPropagation();
          movePeekSelection(1);
          return;
        }
        if (event.key === "ArrowUp" || key === "k") {
          event.preventDefault();
          event.stopPropagation();
          movePeekSelection(-1);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeCurrentSurface();
        return;
      }
      if (command || event.altKey || editable) return;

      if (key === "t" && drawer === "focus" && !replyOpen && canOpenAgentSurface(selected, demo)) {
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
  }, [paletteOpen, replyOpen, drawer, returnDrawer, helpReturnDrawer, demo, selected.runtime, conversationPeekAgents, peekActiveId]);

  function selectAgent(id: string) {
    cancelPendingChanges();
    acknowledgeDone(id);
    if (conversationPeekAgents.some((agent) => agent.id === id)) setPeekActiveId(id);
    setSelectedId(id);
    setEvidence(null);
    setReplyOpen(false);
    setDrawer("focus");
  }

  function openFleet(filter: FleetFilter) {
    cancelPendingChanges();
    setPaletteOpen(false);
    setFleetFilter(filter);
    setReplyOpen(false);
    setDrawer("fleet");
  }

  function toggleFocusDrawer() {
    cancelPendingChanges();
    if (drawer === "focus") {
      returnToUpdateRail();
      return;
    }
    setReplyOpen(false);
    setDrawer("focus");
  }

  function movePeekSelection(step: number) {
    if (conversationPeekAgents.length === 0) return;
    setPeekActiveId((current) => {
      const index = conversationPeekAgents.findIndex((agent) => agent.id === current);
      return conversationPeekAgents[(Math.max(0, index) + step + conversationPeekAgents.length) % conversationPeekAgents.length]!.id;
    });
  }

  function activatePeek(id: string) {
    setPeekExpanded(true);
    setPeekActiveId(id);
  }

  function openPeekConversation(id: string) {
    if (!agents.some((agent) => agent.id === id)) return;
    setPeekActiveId(id);
    setDrawer("focus");
    openTerminal(id);
  }

  function toggleKeyboardHelp() {
    cancelPendingChanges();
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
    cancelPendingChanges();
    const agent = agents.find((candidate) => candidate.id === id);
    if (!agent) return;
    if (agent.runtime?.sourceAvailable === false) {
      setActionError(`${agent.runtime.sourceLabel} is unavailable; its retained Agent data is stale.`);
      return;
    }
    acknowledgeDone(id);
    setSelectedId(id);
    setEvidence(null);
    if (canOpenAgentSurface(agent, demo)) setReplyOpen(true);
    else setDrawer("focus");
  }

  async function openChangesFor(id: string) {
    const requestId = cancelPendingChanges();
    const agent = agents.find((candidate) => candidate.id === id);
    if (!agent) return;
    acknowledgeDone(id);
    setActionError(undefined);
    setSelectedId(id);
    setReturnDrawer(drawer === "fleet" ? "fleet" : "focus");
    if (agent.runtime?.sourceAvailable === false) {
      setActionError(`${agent.runtime.sourceLabel} is unavailable; its retained Agent data is stale.`);
      return;
    }
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
    const controller = new AbortController();
    changesRequestRef.current.controller = controller;
    try {
      const result = await fetchAgentChanges(id, controller.signal);
      if (
        requestId !== changesRequestRef.current.generation ||
        controller.signal.aborted
      ) return;
      setAgents((current) => current.map((candidate) => candidate.id === id ? { ...candidate, workspace: result.workspace, changes: result.files } : candidate));
      if (result.message) setActionError(result.message);
      setEvidence(null);
      setDrawer("diff");
    } catch (error) {
      if (
        controller.signal.aborted ||
        requestId !== changesRequestRef.current.generation
      ) return;
      setActionError(error instanceof Error ? error.message : "Workspace changes could not be read.");
    } finally {
      if (changesRequestRef.current.controller === controller) changesRequestRef.current.controller = undefined;
    }
  }

  async function openChanges() {
    if (!selectedTarget) return;
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
      <div
        className="hud"
        data-edge={rendered.edge}
        data-mode={rendered.mode}
        data-drawer={rendered.drawer ?? "rail"}
        onMouseEnter={handleHudMouseEnter}
        onPointerEnter={handleHudMouseEnter}
        onPointerMove={handleHudMouseEnter}
        onMouseLeave={handleHudMouseLeave}
      >
        {rendered.drawer === null && conversationPeekAgents.length > 0 ? (
          <ConversationPeek
            agents={conversationPeekPreviewAgents}
            navigationAgents={conversationPeekAgents}
            activeId={peekActiveId}
              nativeHoverId={nativeHoverAgentId}
              focusRequest={peekFocusRequest}
              expanded={peekExpanded}
            onActive={activatePeek}
            onSelect={openPeekConversation}
            onMore={() => openFleet("all")}
          />
        ) : null}
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
                <OpenInLink action={selected.runtime?.openIn} />
                <span className="bar-spacer" />
                {canOpenAgentSurface(selected, demo) ? <button className="chip chip-reply" onClick={() => { setEvidence(null); setReplyOpen(true); }} type="button">{agentSurfaceLabel(selected)} <kbd>T</kbd></button> : null}
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
              onClose={() => { cancelPendingChanges(); setDrawer(null); }}
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
          {replyReady ? (
              <TerminalCard
                key="reply"
                agent={selected}
                messages={selected.messages}
                onClose={() => returnToUpdateRail(selected.id)}
                actionError={actionError}
            />
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {paletteOpen ? (
            <CommandPalette
              agents={agents}
              onClose={() => { cancelPendingChanges(); setPaletteOpen(false); }}
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
          onHover={handleHudMouseEnter}
          connection={connection}
        />
      </div>
    </main>
  );
}
