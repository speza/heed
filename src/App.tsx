import { AnimatePresence, motion } from "motion/react";
import { FormEvent, useLayoutEffect, useEffect, useMemo, useRef, useState } from "react";
import { initialAgents } from "./fixtures";
import { DiffDrawer } from "./DiffDrawer";
import type { Agent, AgentStatus, ChatMessage } from "./types";

type Drawer = "focus" | "fleet" | "diff";
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
const hudWidth = 720;

function panelSize(drawer: Drawer | null, edge: Edge, _mode: FocusMode) {
  // One stage size for every open drawer: ⌘-cycling swaps panes inside a
  // constant window, so switching can never flicker the native geometry.
  if (drawer !== null) {
    return edge === "right" ? { width: 866, height: 696 } : { width: 836, height: 686 };
  }
  return edge === "right" ? { width: 76, height: 232 } : { width: 776, height: 76 };
}

function drawerSize(drawer: Drawer | null, edge: Edge, mode: FocusMode) {
  if (drawer === "diff") return { width: 780, height: 600 };
  if (drawer !== "focus") {
    if (edge === "right") return drawer === "fleet" ? { width: 460, height: 640 } : null;
    return drawer === "fleet" ? { width: hudWidth, height: 574 } : null;
  }
  if (mode === "map") return { width: 780, height: 600 };
  return edge === "right" ? { width: 420, height: 400 } : { width: hudWidth, height: 376 };
}

const statusLabels: Record<AgentStatus, string> = {
  working: "Working",
  waiting: "Waiting",
  "needs-you": "Needs you",
  done: "Done",
  failed: "Failed",
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

function ApertureMark({ status }: { readonly status: AgentStatus }) {
  return (
    <svg className={`aperture-mark status-${status}`} viewBox="0 0 128 128" aria-hidden="true">
      <circle className="aperture-ring" cx="64" cy="64" r="50" />
      <circle className="aperture-signal" cx="64" cy="38" r="16" />
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
        <span>{agent.provider}</span>
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
        {parent ? <FocusRow agent={parent} tag="Parent" onSelect={() => onSelect(parent.id)} /> : null}
        <div className="focus-list-caption">delegated · {children.length}</div>
        {children.map((agent) => (
          <FocusRow key={agent.id} agent={agent} onSelect={() => onSelect(agent.id)} />
        ))}
        {children.length === 0 ? <div className="focus-list-empty">No delegated children yet.</div> : null}
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

function ReplyCard({
  agent,
  messages,
  draft,
  onDraft,
  onSend,
  onClose,
}: {
  readonly agent: Agent;
  readonly messages: readonly ChatMessage[];
  readonly draft: string;
  readonly onDraft: (draft: string) => void;
  readonly onSend: (body: string) => void;
  readonly onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const node = log.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    onSend(body);
  }

  return (
    <motion.section
      className="reply-card"
      initial={{ opacity: 0, y: 18, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.98 }}
      transition={enterTransition}
      aria-label={`Reply to ${agent.name}`}
    >
      <header className="reply-head">
        <StatusMark status={agent.status} />
        <strong>{agent.name}</strong>
        <button className="icon-button" onClick={onClose} aria-label="Close reply" type="button"><Glyph name="close" /></button>
      </header>
      <div className="reply-log" ref={log}>
        {messages.length === 0 ? <EmptyState>Nothing yet. Say what you need.</EmptyState> : null}
        {messages.map((message) => (
          <div className={`message message-${message.role}`} key={message.id}>
            <span>{message.role === "human" ? "You" : "Agent"}</span>
            <p>{message.body}</p>
            <time>{message.time}</time>
          </div>
        ))}
      </div>
      <form className="composer" onSubmit={submit}>
        <input
          ref={input}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          placeholder="Respond…"
          aria-label="Message"
        />
        <button type="submit" aria-label="Send message">↗</button>
      </form>
    </motion.section>
  );
}

const fleetOrder: readonly AgentStatus[] = ["needs-you", "working", "waiting", "failed", "done"];

function FleetView({
  agents,
  selectedId,
  filter,
  onFilter,
  onClose,
  onSelect,
}: {
  readonly agents: readonly Agent[];
  readonly selectedId: string;
  readonly filter: FleetFilter;
  readonly onFilter: (filter: FleetFilter) => void;
  readonly onClose: () => void;
  readonly onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
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
  const workspaces = new Set(agents.map((agent) => agent.workspace).filter(Boolean)).size;

  const summaryEntries: readonly (FleetFilter | null)[] = ["all", "attention", "working", "waiting", "failed", "done"];
  const summaryCount = (candidate: FleetFilter) =>
    candidate === "all"
      ? agents.length
      : candidate === "attention"
        ? agents.filter(needsAttention).length
        : agents.filter((agent) => agent.status === candidate).length;

  return (
    <motion.section
      className="fleet-drawer"
      initial={{ opacity: 0, y: 16, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.99 }}
      transition={enterTransition}
    >
      <header className="fleet-header">
        <div>
          <span className="eyebrow">OBSERVATORY · LIVE FLEET</span>
          <h2>{filter === "attention" ? "Needs you" : "All agents"}</h2>
          <p>{agents.length} sessions across {workspaces} workspaces</p>
        </div>
        <label className="fleet-search">
          <span>⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find session, task or workspace…" autoFocus />
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
          <div className="fleet-note"><Glyph name="branch" /><p>Herdr remains the runtime. This layer only indexes, focuses and sends commands.</p></div>
        </aside>
        <div className="fleet-list">
          {grouped.map((group) => (
            <section className={`fleet-group status-surface-${group.status}`} key={group.status}>
              <header><StatusMark status={group.status} /><strong>{statusLabels[group.status]}</strong><span>{group.agents.length}</span></header>
              <div className="fleet-rows">
                {group.agents.map((agent) => (
                  <button className={agent.id === selectedId ? "is-selected" : ""} onClick={() => onSelect(agent.id)} type="button" key={agent.id}>
                    <span className="fleet-agent-copy"><strong>{agent.name}</strong><small>{agent.task}</small></span>
                    <span className="fleet-agent-meta"><b>{agent.workspace ?? "minimal-ade"}</b><small>{agent.provider} · {agent.model}</small></span>
                    <span className="fleet-elapsed">{agent.elapsed}</span>
                    {agent.attention ? <span className="fleet-attention">{agent.attention}</span> : <span className="fleet-open">↗</span>}
                  </button>
                ))}
              </div>
            </section>
          ))}
          {grouped.length === 0 ? <EmptyState>No matching Agent sessions.</EmptyState> : null}
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
}: {
  readonly agents: readonly Agent[];
  readonly onClose: () => void;
  readonly onSelectAgent: (id: string) => void;
  readonly onFleet: (filter: FleetFilter) => void;
  readonly onSpawn: () => void;
  readonly onChanges: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const commands = useMemo(
    () => [
      { id: "cmd-all", label: "All agents", hint: "fleet", run: () => onFleet("all") },
      { id: "cmd-working", label: "Show working now", hint: "fleet", run: () => onFleet("working") },
      { id: "cmd-attention", label: "Needs you", hint: "triage", run: () => onFleet("attention") },
      { id: "cmd-spawn", label: "Spawn child", hint: "mock", run: onSpawn },
      { id: "cmd-changes", label: "Show changes", hint: "⌘D", run: onChanges },
    ],
    [onFleet, onSpawn, onChanges],
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
        <footer><span>↑↓ navigate</span><span>⏵ run</span><span>⌘1 list · ⌘2 map · ⌘3 fleet</span><span>esc close</span></footer>
      </motion.div>
    </motion.div>
  );
}

function HudBar({
  agent,
  attentionCount,
  onFocusToggle,
  onTriage,
  onFleet,
  onCommand,
}: {
  readonly agent: Agent;
  readonly attentionCount: number;
  readonly onFocusToggle: () => void;
  readonly onTriage: () => void;
  readonly onFleet: () => void;
  readonly onCommand: () => void;
}) {
  return (
    <footer className="hud-bar" data-native-drag>
      <button className="bar-agent" onClick={onFocusToggle} type="button" aria-label="Toggle focus drawer">
        <ApertureMark status={agent.status} />
      </button>
      {attentionCount > 0 ? (
        <button className="bar-attention" onClick={onTriage} type="button">
          <span className="status-mark status-needs-you" aria-hidden="true" />
          <b>{attentionCount}</b>
          <span className="att-label">need you</span>
        </button>
      ) : (
        <span className="bar-calm">All clear</span>
      )}
      <span className="bar-spacer" />
      <button className="icon-button" onClick={onFleet} aria-label="All agents" type="button"><Glyph name="fleet" /></button>
      <button className="icon-button" onClick={onCommand} aria-label="Commands" type="button"><Glyph name="command" /></button>
      <button className="icon-button" onClick={() => shellMessage("hide")} aria-label="Hide panel" type="button"><Glyph name="close" /></button>
    </footer>
  );
}

export function App() {
  const [agents, setAgents] = useState<readonly Agent[]>(initialAgents);
  const [selectedId, setSelectedId] = useState("lead");
  const [drawer, setDrawer] = useState<Drawer | null>("focus");
  const [focusMode, setFocusMode] = useState<FocusMode>("list");
  // The right spine won the anchor trial (ADR-0006); bottom is retired.
  const edge: Edge = "right";
  const [replyOpen, setReplyOpen] = useState(false);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [fleetFilter, setFleetFilter] = useState<FleetFilter>("all");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [extraMessages, setExtraMessages] = useState<Record<string, readonly ChatMessage[]>>({});

  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0]!;
  const selectedParent = useMemo(
    () => (selected.parentId ? agents.find((agent) => agent.id === selected.parentId) : undefined),
    [agents, selected],
  );
  const selectedChildren = useMemo(() => agents.filter((agent) => agent.parentId === selected.id), [agents, selected]);
  const visibleMessages = useMemo(
    () => [...selected.messages, ...(extraMessages[selected.id] ?? [])],
    [selected, extraMessages],
  );
  const attentionAgents = useMemo(
    () => agents.filter(needsAttention).sort((a, b) => attentionPriority[a.status] - attentionPriority[b.status] || a.name.localeCompare(b.name)),
    [agents],
  );

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
  const [rendered, setRendered] = useState<HudGeometry>({ drawer: "focus", edge: "right", mode: "list" });
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
    const sync = () => shellMessage("resize", { ...panelSize(drawerRef.current, edgeRef.current, focusModeRef.current), edge: edgeRef.current, drawer: drawerSize(drawerRef.current, edgeRef.current, focusModeRef.current) });
    window.addEventListener("heed:shown", sync);
    return () => window.removeEventListener("heed:shown", sync);
  }, []);

  function peelEscape() {
    if (paletteOpen) setPaletteOpen(false);
    else if (replyOpen) setReplyOpen(false);
    else if (drawer) setDrawer(null);
    else shellMessage("hide");
  }

  const peelRef = useRef(peelEscape);
  peelRef.current = peelEscape;

  // The native shell forwards Escape here so drawers peel before the panel hides.
  useEffect(() => {
    const onEscape = () => peelRef.current();
    window.addEventListener("minimal-ade:escape", onEscape);
    return () => window.removeEventListener("minimal-ade:escape", onEscape);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (meta && ["1", "2", "3", "d"].includes(event.key)) {
        // Always-defined pane binds: jump back to any pane from anywhere.
        event.preventDefault();
        setPaletteOpen(false);
        setEvidence(null);
        setReplyOpen(false);
        if (event.key === "1") {
          setDrawer("focus");
          setFocusMode("list");
        } else if (event.key === "2") {
          setDrawer("focus");
          setFocusMode("map");
        } else if (event.key === "d") {
          setDrawer((current) => (current === "diff" ? "focus" : "diff"));
        } else {
          openFleet("all");
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        peelRef.current();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (meta || event.altKey || target?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (event.key === "r") {
        if (drawer === "focus" && !replyOpen) {
          event.preventDefault();
          setEvidence(null);
          setReplyOpen(true);
        }
        return;
      }
      if (event.key === "Tab" && drawer === "focus" && attentionAgents.length > 0) {
        event.preventDefault();
        const ids = attentionAgents.map((agent) => agent.id);
        const index = ids.indexOf(selectedId);
        const next = event.shiftKey
          ? ids[(index - 1 + ids.length) % ids.length]!
          : ids[(index + 1) % ids.length]!;
        setSelectedId(next);
        setEvidence(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paletteOpen, replyOpen, drawer, selectedId, attentionAgents]);

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

  function sendMessage(body: string) {
    const now = new Date();
    const message: ChatMessage = {
      id: `local-${now.getTime()}`,
      role: "human",
      body,
      time: now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    setExtraMessages((current) => ({ ...current, [selected.id]: [...(current[selected.id] ?? []), message] }));
    setDrafts((current) => ({ ...current, [selected.id]: "" }));
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
                <div className="mode-toggle" role="group" aria-label="Focus layout">
                  <button type="button" className={rendered.mode === "map" ? "is-active" : ""} onClick={() => setFocusMode("map")}>Map</button>
                  <button type="button" className={rendered.mode === "list" ? "is-active" : ""} onClick={() => setFocusMode("list")}>List</button>
                </div>
                <button className={`chip ${evidence === "result" ? "is-active" : ""}`} onClick={() => setEvidence((current) => (current === "result" ? null : "result"))} type="button">
                  Result{selected.result ? <em aria-label="has result">✓</em> : null}
                </button>
                <button className="chip" onClick={() => { setEvidence(null); setDrawer("diff"); }} type="button">
                  Changes{selected.changes.length > 0 ? <em>{selected.changes.length}</em> : null}
                </button>
                <span className="bar-spacer" />
                <button className="chip chip-reply" onClick={() => { setEvidence(null); setReplyOpen(true); }} type="button">Reply <kbd>R</kbd></button>
                <button className="chip chip-spawn" onClick={spawnChild} type="button"><Glyph name="branch" /> Spawn child</button>
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
              onSelect={selectAgent}
            />
          ) : null}
          {rendered.drawer === "diff" ? (
            <DiffDrawer agent={selected} onClose={() => setDrawer(null)} />
          ) : null}
        <AnimatePresence>
          {rendered.drawer === "focus" && replyOpen ? (
            <ReplyCard
              key="reply"
              agent={selected}
              messages={visibleMessages}
              draft={drafts[selected.id] ?? ""}
              onDraft={(draft) => setDrafts((current) => ({ ...current, [selected.id]: draft }))}
              onSend={sendMessage}
              onClose={() => setReplyOpen(false)}
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
              onChanges={() => { setEvidence(null); setDrawer("diff"); }}
            />
          ) : null}
        </AnimatePresence>
        <HudBar
          agent={selected}
          attentionCount={attentionAgents.length}
          onFocusToggle={toggleFocusDrawer}
          onTriage={() => openFleet("attention")}
          onFleet={() => openFleet("all")}
          onCommand={() => setPaletteOpen(true)}
        />
      </div>
    </main>
  );
}
