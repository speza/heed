import { AnimatePresence, motion } from "motion/react";
import type { Agent } from "./types";
import { EmptyState, enterTransition, easeOutExpo, glideTransition, Glyph, StatusMark, statusLabels } from "./ui";

export type Evidence = "result";

export interface OrbitNode {
  readonly agent: Agent;
  readonly relation: "parent" | "child";
  readonly x: number;
  readonly y: number;
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
export const mapLayout = {
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

export function Constellation({
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
            <stop offset="0" style={{ stopColor: "var(--accent)", stopOpacity: 0.4 }} />
            <stop offset="1" style={{ stopColor: "var(--text)", stopOpacity: 0.12 }} />
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

export function FocusList({
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

export function EvidencePanel({ agent, evidence }: { readonly agent: Agent; readonly evidence: Evidence }) {
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
