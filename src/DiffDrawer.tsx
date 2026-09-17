import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { DiffFile, DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import type { Agent, FileChange } from "./types";

function fileIdentity(path: string): { readonly name: string; readonly directory?: string } {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? { name: path } : { name: path.slice(separator + 1), directory: path.slice(0, separator) };
}

const MAX_RENDERED_DIFF_LINES = 5_000;
const MAX_HIGHLIGHT_DIFF_CHARACTERS = 100_000;
const MAX_HIGHLIGHT_DIFF_LINES = 3_000;

const highlightLangs: Readonly<Record<string, string>> = {
  tsx: "tsx",
  ts: "ts",
  css: "css",
  swift: "swift",
  js: "javascript",
  json: "json",
  md: "markdown",
};

function highlightLangFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return highlightLangs[extension] ?? "plaintext";
}

function DiffBody({ file }: { readonly file: FileChange }) {
  const diffLines = file.hunks.reduce((total, hunk) => total + hunk.split("\n").length, 0);
  const diffCharacters = file.hunks.reduce((total, hunk) => total + hunk.length, 0);
  const highlight =
    diffCharacters <= MAX_HIGHLIGHT_DIFF_CHARACTERS && diffLines <= MAX_HIGHLIGHT_DIFF_LINES;

  const lang = highlightLangFor(file.path);

  const diffFile = useMemo(() => {
    const prepared = DiffFile.createInstance({
      oldFile: file.oldFile
        ? { fileName: file.path, fileLang: lang, content: file.oldFile.content }
        : undefined,
      newFile: file.newFile
        ? { fileName: file.path, fileLang: lang, content: file.newFile.content }
        : undefined,
      hunks: [...file.hunks],
    });
    prepared.initTheme("dark");
    prepared.init();
    prepared.buildUnifiedDiffLines();
    return prepared;
  }, [file, lang]);

  if (diffLines > MAX_RENDERED_DIFF_LINES) {
    return <div className="diff-drawer__limit">Diff rendering is limited to {MAX_RENDERED_DIFF_LINES.toLocaleString()} lines.</div>;
  }

  return (
    <div className="diff-drawer__renderer">
      <DiffView
        diffFile={diffFile}
        diffViewFontSize={12}
        diffViewHighlight={highlight}
        diffViewMode={DiffModeEnum.Unified}
        diffViewTheme="dark"
        diffViewWrap={false}
      />
    </div>
  );
}

function DiffFileSection({
  file,
  index,
  active,
  expanded,
  onFocus,
  onToggle,
}: {
  readonly file: FileChange;
  readonly index: number;
  readonly active: boolean;
  readonly expanded: boolean;
  readonly onFocus: () => void;
  readonly onToggle: (expanded: boolean) => void;
}) {
  const identity = fileIdentity(file.path);
  const status = file.binary ? "binary" : file.kind;

  return (
    <details
      className={`diff-drawer__file${expanded ? " is-open" : ""}${active ? " is-active" : ""}`}
      open={expanded}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary
        aria-label={`${file.path}, ${status}`}
        className="diff-drawer__file-header"
        data-diff-index={index}
        onFocus={onFocus}
        tabIndex={active ? 0 : -1}
      >
        <span className="diff-drawer__chevron" aria-hidden="true" />
        <span className="diff-drawer__identity" title={file.path}>
          <strong className="diff-drawer__file-name">{identity.name}</strong>
          {identity.directory ? <span className="diff-drawer__file-directory">{identity.directory}</span> : null}
        </span>
        <span className="diff-drawer__counts">
          {file.additions ? <em>+{file.additions}</em> : null}
          {file.deletions ? <i>−{file.deletions}</i> : null}
        </span>
        <span className={`diff-drawer__kind diff-drawer__kind--${status}`}>{status[0].toUpperCase()}</span>
      </summary>
      {expanded ? (
        file.binary ? (
          <div className="diff-drawer__limit">Binary or oversized file · content omitted.</div>
        ) : (
          <DiffBody file={file} />
        )
      ) : null}
    </details>
  );
}

export function DiffDrawer({
  agent,
  onClose,
  onTerminal,
}: {
  readonly agent: Agent;
  readonly onClose: () => void;
  readonly onTerminal: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const root = useRef<HTMLElement>(null);
  const additions = agent.changes.reduce((total, change) => total + change.additions, 0);
  const deletions = agent.changes.reduce((total, change) => total + change.deletions, 0);

  useEffect(() => {
    setActiveIndex(0);
    setExpandedPaths(new Set());
  }, [agent.id]);

  useEffect(() => {
    if (agent.changes.length === 0) root.current?.focus();
    else root.current?.querySelector<HTMLElement>(`[data-diff-index="${activeIndex}"]`)?.focus();
  }, [activeIndex, agent.changes.length]);

  function move(index: number) {
    if (agent.changes.length === 0) return;
    setActiveIndex(Math.max(0, Math.min(index, agent.changes.length - 1)));
  }

  function setExpanded(path: string, expanded: boolean) {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (expanded) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  return (
    <motion.section
      ref={root}
      className="diff-drawer"
      tabIndex={-1}
      onKeyDown={(event) => {
        const key = event.key.toLowerCase();
        const target = event.target as HTMLElement;
        if (event.metaKey || event.ctrlKey || event.altKey || target.closest("button")) return;
        if (event.key === "ArrowDown" || key === "j") {
          event.preventDefault();
          move(activeIndex + 1);
        } else if (event.key === "ArrowUp" || key === "k") {
          event.preventDefault();
          move(activeIndex - 1);
        } else if (event.key === "Home") {
          event.preventDefault();
          move(0);
        } else if (event.key === "End") {
          event.preventDefault();
          move(agent.changes.length - 1);
        } else if (event.key === "Enter" || event.key === " ") {
          const active = agent.changes[activeIndex];
          if (!active) return;
          event.preventDefault();
          setExpanded(active.path, !expandedPaths.has(active.path));
        } else if (key === "t") {
          event.preventDefault();
          onTerminal();
        }
      }}
      initial={{ opacity: 0, y: 18, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.99 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
    >
      <header className="diff-drawer__header">
        <div>
          <span className="eyebrow">{agent.runtime ? "WORKSPACE CHANGES" : "WORKING DIRECTORY"} · {agent.workspace ?? "minimal-ade"}</span>
          <h2>{agent.runtime ? "Workspace changes" : agent.name}</h2>
          <p>{agent.changes.length} files · +{additions} −{deletions}</p>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close diff" type="button">
          <svg aria-hidden="true" viewBox="0 0 20 20">
            <path d="m5 5 10 10M15 5 5 15" />
          </svg>
        </button>
      </header>
      <div className="diff-drawer__body" role="region" aria-label="Changed files">
        {agent.changes.map((file, index) => (
          <DiffFileSection
            key={file.path}
            file={file}
            index={index}
            active={index === activeIndex}
            expanded={expandedPaths.has(file.path)}
            onFocus={() => setActiveIndex(index)}
            onToggle={(expanded) => setExpanded(file.path, expanded)}
          />
        ))}
        {agent.changes.length === 0 ? <div className="empty-state">No changes from HEAD in this workspace.</div> : null}
      </div>
      <div className="diff-drawer__keyboard-help"><span>↑↓ / J K</span> navigate <span>↵</span> expand <span>T</span> terminal <span>⌘W</span> back</div>
    </motion.section>
  );
}
