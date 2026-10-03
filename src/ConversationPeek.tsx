import { useEffect, useRef } from "react";
import type { Agent } from "./types";
import { needsAttention, StatusMark, statusLabels } from "./ui";

/** How long a newly arrived attention item keeps its arrival pulse. */
const FRESH_ATTENTION_MS = 12_000;

export function ConversationPeek({
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
    const attention = needsAttention(agent);
    const update = attention ? agent.attention ?? statusLabels[agent.status] : statusLabels[agent.status];
    const active = agent.id === activeId;
    const since = agent.runtime?.statusSince;
    const fresh = attention && since !== undefined && Date.now() - since < FRESH_ATTENTION_MS;
    return (
      <button
        key={agent.id}
        ref={active ? activeButton : undefined}
        className={`conversation-peek-item status-surface-${agent.status} ${active ? "is-selected" : ""} ${agent.id === nativeHoverId ? "is-native-hover" : ""} ${fresh ? "is-fresh" : ""}`}
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
          <small>{update}{agent.elapsed ? <em> · {agent.elapsed}</em> : null}</small>
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
