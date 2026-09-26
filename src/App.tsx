import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette } from "./CommandPalette";
import { ConversationPeek } from "./ConversationPeek";
import { DiffDrawer } from "./DiffDrawer";
import { FleetView, type FleetFilter } from "./FleetView";
import { Constellation, type Evidence, EvidencePanel, FocusList, mapLayout, type OrbitNode } from "./Focus";
import { initialAgents } from "./fixtures";
import { HudBar } from "./HudBar";
import { KeyboardHelp } from "./KeyboardHelp";
import { fetchAgentChanges, fetchRuntime } from "./runtime/client";
import { runtimeAgent } from "./runtime/map";
import type { RuntimeConnection } from "./runtime/types";
import { TerminalCard } from "./TerminalCard";
import type { Agent, AgentStatus } from "./types";
import { enterTransition, Glyph, needsAttention, shellMessage } from "./ui";

type Drawer = "focus" | "fleet" | "diff" | "help";

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

/** Panel geometry the native shell mirrors; width is constant so only height animates. */
function panelSize(drawer: Drawer | null, edge: Edge, hasConversationPeek = false) {
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

function drawerSize(drawer: Drawer | null) {
  return drawer === null ? null : { width: 1000, height: 760 };
}

const attentionPriority: Record<AgentStatus, number> = {
  "needs-you": 0,
  failed: 1,
  working: 2,
  waiting: 3,
  done: 4,
  unknown: 5,
};

function doneRevision(agent: Agent) {
  return agent.runtime?.revision ?? 0;
}

function isDoneAcknowledged(agent: Agent, acknowledgedDone: Readonly<Record<string, number>>) {
  return agent.status === "done" && acknowledgedDone[agent.id] === doneRevision(agent);
}

/** Subscribes to a window event, always invoking the latest handler so it never sees stale state. */
function useWindowEvent(type: string, handler: (event: Event) => void, capture = false) {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const listener = (event: Event) => latest.current(event);
    window.addEventListener(type, listener, capture);
    return () => window.removeEventListener(type, listener, capture);
  }, [type, capture]);
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

export function App({ demo = new URLSearchParams(window.location.search).has("demo") }: { readonly demo?: boolean }) {
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
      ...panelSize(drawer, edge, conversationPeekVisible),
      edge,
      drawer: drawerSize(drawer),
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
  useWindowEvent("heed:resized", () => setRendered({ ...geometryTargetRef.current }));
  useWindowEvent("heed:shown", () => {
    setWindowFocused(true);
    returnToUpdateRail();
  });
  useWindowEvent("heed:hidden", () => {
    cancelPendingChanges();
    setPaletteOpen(false);
    setReplyOpen(false);
    setDrawer(null);
    setWindowFocused(false);
    setPeekExpanded(false);
  });
  useWindowEvent("focus", () => {
    setWindowFocused(true);
    setPeekExpanded(true);
  });
  useWindowEvent("blur", () => {
    setWindowFocused(false);
    if (!peekHovered.current) setPeekExpanded(false);
  });
  useWindowEvent("heed:rail-hover", () => handleNativeRailEnter());
  useWindowEvent("heed:rail-hover-end", () => {
    handleNativeRailLeave();
    nativeHoverElement.current?.classList.remove("is-native-hover");
    nativeHoverElement.current = null;
    setNativeHoverAgentId(undefined);
  });
  useWindowEvent("heed:rail-pointer", (event) => {
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
  });
  useWindowEvent("heed:rail-click", (event) => {
    const detail = (event as CustomEvent<NativePointerDetail>).detail;
    if (!detail) return;
    const target = nativeInteractiveTarget(detail);
    if (target instanceof HTMLButtonElement) target.click();
  });

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

  useWindowEvent("heed:toggle-main", () => {
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
  });
  useWindowEvent("heed:focus-list", () => returnToUpdateRail());

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

  useWindowEvent("heed:back", () => closeCurrentSurface());
  useWindowEvent("keydown", (rawEvent) => {
    const event = rawEvent as KeyboardEvent;
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

    if (key === "t" && drawer === "focus" && !replyOpen && (demo || selected.runtime?.capabilities.terminal)) {
      event.preventDefault();
      setEvidence(null);
      setReplyOpen(true);
    } else if (key === "d" && drawer === "focus" && !replyOpen) {
      event.preventDefault();
      void openChanges();
    }
  }, true);

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
    if (demo || agent.runtime?.capabilities.terminal) setReplyOpen(true);
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
