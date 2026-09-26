import { motion } from "motion/react";
import { enterTransition, Glyph } from "./ui";

export function KeyboardHelp({ onClose }: { readonly onClose: () => void }) {
  const groups = [
    { title: "Global", shortcuts: [["⌥Space", "Focus update rail"], ["F", "Open full session list"], ["↑ ↓ / J K", "Cycle focused updates"], ["Enter", "Open selected update"], ["?", "Keyboard shortcuts"], ["⌘K", "Command palette"], ["Sidebar ×", "Hide Heed"]] },
    { title: "Agent list", shortcuts: [["↑ ↓ / J K", "Navigate"], ["↵ / T", "Open terminal"], ["D", "Workspace changes"], ["/", "Search"], ["A", "Attention / all"], ["Esc", "Collapse to sidebar"]] },
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
