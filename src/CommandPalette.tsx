import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FleetFilter } from "./FleetView";
import type { Agent } from "./types";
import { Glyph, StatusMark } from "./ui";

export function CommandPalette({
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
