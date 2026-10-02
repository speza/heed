import { motion } from "motion/react";
import { enterTransition, Glyph } from "./ui";

export function KeyboardHelp({ onClose }: { readonly onClose: () => void }) {
  const groups = [
    { title: "Global", shortcuts: [["⌥Space", "Open what needs you"], ["F", "All Agents"], ["↑ ↓ / J K", "Cycle rail updates"], ["↵", "Open update's terminal"], ["⌘K", "Command palette"], ["?", "Keyboard shortcuts"], ["Spine ×", "Hide Heed"]] },
    { title: "Agent list", shortcuts: [["↑ ↓ / J K", "Move · preview screen"], ["↵ / T", "Open terminal"], ["D", "Workspace changes"], ["R", "Quick reply"], ["1–9", "Answer the agent's dialog"], ["E", "Mark a finished turn seen"], ["/", "Search (↵ opens)"], ["A", "Needs you / all"], ["Esc", "Back to the rail"]] },
    { title: "Terminal & changes", shortcuts: [["⌘W", "Back to the rail"], ["Esc", "Sent to the terminal"], ["Wheel / PgUp PgDn", "Scroll the terminal"], ["↵ / Space", "Expand a changed file"], ["T", "Terminal from changes"]] },
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
