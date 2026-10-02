import { type CSSProperties, type Ref, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type AnsiLine, type AnsiSegment, compactLines, isRuleLine, lineText, parseAnsi } from "./ansi";
import { detectDialog } from "./dialog";
import { QuickReply, type QuickReplyHandle } from "./QuickReply";
import { fetchAgentScreen } from "./runtime/client";
import type { Agent } from "./types";
import { EmptyState, StatusMark, statusLabels } from "./ui";

const SCREEN_REFRESH_MS = 1_500;
const SCREEN_DEBOUNCE_MS = 90;
const MAX_SCREEN_LINES = 160;

interface ScreenState {
  readonly id: string;
  readonly lines?: readonly AnsiLine[];
  readonly error?: string;
}

interface Screen extends ScreenState {
  /** Re-reads the screen now, e.g. right after a reply. */
  readonly refresh: () => void;
}

// Last screen per Agent, so flicking back through a list paints immediately.
const screenCache = new Map<string, readonly AnsiLine[]>();

/** Polls an Agent's visible terminal screen while `enabled`. */
function useAgentScreen(id: string, enabled: boolean): Screen {
  const [state, setState] = useState<ScreenState>({ id });
  const refreshNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const load = async () => {
      const request = new AbortController();
      controller = request;
      try {
        const output = await fetchAgentScreen(id, request.signal);
        if (!active || request.signal.aborted) return;
        const lines = compactLines(parseAnsi(output.text)).slice(-MAX_SCREEN_LINES);
        screenCache.set(id, lines);
        setState({ id, lines });
      } catch (error) {
        if (!active || request.signal.aborted) return;
        setState((current) => ({
          id,
          ...(current.id === id && current.lines ? { lines: current.lines } : {}),
          error: error instanceof Error ? error.message : "The terminal screen could not be read.",
        }));
      } finally {
        // A manual refresh can overlap a poll; keep exactly one pending timer.
        if (timer) clearTimeout(timer);
        if (active) timer = setTimeout(load, SCREEN_REFRESH_MS);
      }
    };
    timer = setTimeout(load, SCREEN_DEBOUNCE_MS);
    refreshNow.current = () => {
      if (timer) clearTimeout(timer);
      controller?.abort();
      void load();
    };
    return () => {
      active = false;
      refreshNow.current = () => undefined;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [id, enabled]);

  const refresh = () => refreshNow.current();
  if (state.id === id) return { ...state, refresh };
  const cached = screenCache.get(id);
  return cached ? { id, lines: cached, refresh } : { id, refresh };
}

function segmentStyle(segment: AnsiSegment): CSSProperties | undefined {
  if (!segment.foreground && !segment.background && !segment.bold && !segment.dim && !segment.italic && !segment.underline)
    return undefined;
  return {
    ...(segment.foreground ? { color: segment.foreground } : {}),
    ...(segment.background ? { backgroundColor: segment.background } : {}),
    ...(segment.bold ? { fontWeight: 650 } : {}),
    ...(segment.dim ? { opacity: 0.62 } : {}),
    ...(segment.italic ? { fontStyle: "italic" } : {}),
    ...(segment.underline ? { textDecoration: "underline" } : {}),
  };
}

function ScreenLines({ lines }: { readonly lines: readonly AnsiLine[] }) {
  return (
    <>
      {lines.map((line, index) =>
        isRuleLine(line) ? (
          <div className="screen-rule" key={index} />
        ) : (
          <div className="screen-line" key={index}>
            {lineText(line) === "" ? " " : line.map((segment, part) => (
              <span key={part} style={segmentStyle(segment)}>{segment.text}</span>
            ))}
          </div>
        ),
      )}
    </>
  );
}

/**
 * Keeps a scroll container pinned to its end unless the reader scrolled away.
 * A new `subject` (another Agent) always starts pinned.
 */
function useStickToBottom(subject: string, content: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    pinned.current = true;
  }, [subject]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [content]);
  const onScroll = () => {
    const node = ref.current;
    if (node) pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
  };
  return { ref, onScroll };
}

function LiveScreen({ agent, screen }: { readonly agent: Agent; readonly screen: Screen }) {
  const scroll = useStickToBottom(agent.id, screen.lines);

  if (agent.runtime?.sourceAvailable === false) {
    return <EmptyState>{`${agent.runtime?.sourceLabel ?? "The runtime"} is unavailable, so its screen cannot be read.`}</EmptyState>;
  }
  return (
    <div className="agent-preview-screen" ref={scroll.ref} onScroll={scroll.onScroll} aria-label={`${agent.name} terminal screen`} role="log">
      {screen.lines ? <ScreenLines lines={screen.lines} /> : screen.error ? null : <div className="agent-preview-loading">Reading screen…</div>}
      {screen.error ? <p className="agent-preview-error">{screen.error}</p> : null}
    </div>
  );
}

function Transcript({ agent }: { readonly agent: Agent }) {
  const scroll = useStickToBottom(agent.id, agent.messages);
  if (agent.messages.length === 0) return <EmptyState>No transcript for this synthetic Agent.</EmptyState>;
  return (
    <div className="agent-preview-screen is-transcript" ref={scroll.ref} onScroll={scroll.onScroll} role="log" aria-label={`${agent.name} transcript`}>
      {agent.messages.map((message) => (
        <div className={`agent-preview-message is-${message.role}`} key={message.id}>
          <span>{message.role === "human" ? "you" : "agent"} · {message.time}</span>
          <p>{message.body}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only context for one Agent: identity, status and its live terminal
 * screen, so triage can happen without opening (and taking over) the terminal.
 */
export function AgentPreview({
  agent,
  identity = true,
  onTerminal,
  onChanges,
  onAcknowledge,
  onReplied,
  onReplyExit,
  replyRef,
}: {
  readonly agent: Agent;
  /** False when the surrounding surface already names the Agent. */
  readonly identity?: boolean;
  readonly onTerminal?: () => void;
  readonly onChanges?: () => void;
  readonly onAcknowledge?: () => void;
  /** Called after a quick reply is accepted, so runtime state can refresh. */
  readonly onReplied?: () => void;
  readonly onReplyExit?: () => void;
  readonly replyRef?: Ref<QuickReplyHandle>;
}) {
  const available = agent.runtime?.sourceAvailable !== false;
  const liveScreen = agent.runtime?.capabilities.output === true || !available;
  const screen = useAgentScreen(agent.id, liveScreen && available);
  const canReply = available && agent.runtime?.capabilities.reply === true;
  const blocked = agent.runtime?.rawStatus === "blocked";
  const dialog = useMemo(() => (blocked && screen.lines ? detectDialog(screen.lines) : undefined), [blocked, screen.lines]);
  const location = [agent.workspace, agent.role !== agent.workspace ? agent.role : undefined, agent.runtime?.location?.paneId]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className={`agent-preview status-surface-${agent.status}`} aria-label={`${agent.name} preview`}>
      {identity ? <header className="agent-preview-head">
        <StatusMark status={agent.status} />
        <div className="agent-preview-title">
          <strong>{agent.name}</strong>
          <small>{location || agent.provider}</small>
        </div>
        <span className="agent-preview-state">
          {agent.attention ?? statusLabels[agent.status]}
          {agent.elapsed ? <em>{agent.elapsed}</em> : null}
        </span>
      </header> : null}
      {identity && agent.task && agent.task !== agent.workspace ? <p className="agent-preview-task">{agent.task}</p> : null}
      {agent.runtime && !liveScreen ? (
        <EmptyState>{`${agent.runtime.sourceLabel} does not expose a screen for this Agent.`}</EmptyState>
      ) : liveScreen ? (
        <LiveScreen agent={agent} screen={screen} />
      ) : (
        <Transcript agent={agent} />
      )}
      {canReply ? (
        <QuickReply
          key={agent.id}
          ref={replyRef}
          agent={agent}
          dialog={dialog}
          reading={blocked && !screen.lines}
          onExit={onReplyExit}
          onSent={() => {
            screen.refresh();
            onReplied?.();
          }}
        />
      ) : null}
      {onTerminal || onChanges || onAcknowledge ? (
        <footer className="agent-preview-actions">
          {onTerminal ? <button className="chip chip-reply" type="button" onClick={onTerminal}>Open terminal <kbd>↵</kbd></button> : null}
          {onChanges ? <button className="chip" type="button" onClick={onChanges}>Workspace changes <kbd>D</kbd></button> : null}
          {onAcknowledge ? <button className="chip" type="button" onClick={onAcknowledge}>Mark seen <kbd>E</kbd></button> : null}
        </footer>
      ) : null}
    </section>
  );
}
