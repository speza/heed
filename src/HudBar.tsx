import type { RuntimeConnection } from "./runtime/types";
import { Glyph, shellMessage } from "./ui";

function ApertureMark({ connection }: { readonly connection: RuntimeConnection }) {
  return (
    <svg className={`aperture-mark aperture-runtime-${connection}`} viewBox="0 0 128 128" aria-hidden="true">
      <circle className="aperture-ring" cx="64" cy="64" r="56" />
      <path className="aperture-datum" d="M6 94 122 34" />
      <circle className="aperture-signal" cx="91" cy="40" r="14" />
    </svg>
  );
}

export function HudBar({
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
