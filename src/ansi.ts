/** A run of text sharing one SGR style. */
export interface AnsiSegment {
  readonly text: string;
  readonly foreground?: string;
  readonly background?: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
}

export type AnsiLine = readonly AnsiSegment[];

interface SgrState {
  foreground?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

// Basic and bright palette entries resolve to theme tokens so terminal
// colours follow the active Heed theme (ADR-0009).
const BASIC_COLORS = [
  "var(--ansi-black)", "var(--ansi-red)", "var(--ansi-green)", "var(--ansi-yellow)",
  "var(--ansi-blue)", "var(--ansi-magenta)", "var(--ansi-cyan)", "var(--ansi-white)",
] as const;

const BRIGHT_COLORS = [
  "var(--ansi-bright-black)", "var(--ansi-bright-red)", "var(--ansi-bright-green)", "var(--ansi-bright-yellow)",
  "var(--ansi-bright-blue)", "var(--ansi-bright-magenta)", "var(--ansi-bright-cyan)", "var(--ansi-bright-white)",
] as const;

function xterm256(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 8) return BASIC_COLORS[index];
  if (index < 16) return BRIGHT_COLORS[index - 8];
  if (index < 232) {
    const cube = index - 16;
    const level = (value: number) => (value === 0 ? 0 : 55 + value * 40);
    return `rgb(${level(Math.floor(cube / 36))}, ${level(Math.floor(cube / 6) % 6)}, ${level(cube % 6)})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

/** Reads an extended colour (`38;5;n` or `38;2;r;g;b`), returning the colour and parameters consumed. */
function extendedColor(params: readonly number[], index: number): readonly [string | undefined, number] {
  const mode = params[index + 1];
  if (mode === 5) return [xterm256(params[index + 2] ?? -1), 2];
  if (mode === 2) {
    const [red, green, blue] = [params[index + 2], params[index + 3], params[index + 4]];
    const valid = [red, green, blue].every((channel) => channel !== undefined && channel >= 0 && channel <= 255);
    return [valid ? `rgb(${red}, ${green}, ${blue})` : undefined, 4];
  }
  return [undefined, 0];
}

function applySgr(state: SgrState, raw: string): void {
  const params = raw === "" ? [0] : raw.split(/[;:]/u).map((value) => (value === "" ? 0 : Number(value)));
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index]!;
    if (code === 0) {
      for (const key of Object.keys(state) as (keyof SgrState)[]) delete state[key];
    } else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 22) { delete state.bold; delete state.dim; }
    else if (code === 23) delete state.italic;
    else if (code === 24) delete state.underline;
    else if (code === 27) delete state.inverse;
    else if (code >= 30 && code <= 37) state.foreground = BASIC_COLORS[code - 30];
    else if (code >= 90 && code <= 97) state.foreground = BRIGHT_COLORS[code - 90];
    else if (code === 39) delete state.foreground;
    else if (code >= 40 && code <= 47) state.background = BASIC_COLORS[code - 40];
    else if (code >= 100 && code <= 107) state.background = BRIGHT_COLORS[code - 100];
    else if (code === 49) delete state.background;
    else if (code === 38 || code === 48) {
      const [color, consumed] = extendedColor(params, index);
      if (color) state[code === 38 ? "foreground" : "background"] = color;
      index += consumed;
    }
  }
}

function segment(text: string, state: SgrState): AnsiSegment {
  const foreground = state.inverse ? state.background ?? "var(--ansi-inverse-foreground)" : state.foreground;
  const background = state.inverse ? state.foreground ?? "var(--ansi-inverse-background)" : state.background;
  return {
    text,
    ...(foreground ? { foreground } : {}),
    ...(background ? { background } : {}),
    ...(state.bold ? { bold: true } : {}),
    ...(state.dim ? { dim: true } : {}),
    ...(state.italic ? { italic: true } : {}),
    ...(state.underline ? { underline: true } : {}),
  };
}

// CSI (with any parameters), OSC (BEL or ST terminated) and two-byte escapes.
const ESCAPE = /\u001b\[([0-9;:?<>=]*)([ -/]*)([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu;

/**
 * Parses terminal text into styled lines. Only SGR styling is interpreted;
 * cursor movement and other control sequences are dropped, which is enough
 * for a read-only snapshot of a terminal's visible screen.
 */
export function parseAnsi(input: string): AnsiLine[] {
  const lines: AnsiSegment[][] = [[]];
  const state: SgrState = {};
  const push = (text: string) => {
    const printable = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "");
    if (!printable) return;
    const line = lines[lines.length - 1]!;
    const previous = line.at(-1);
    const next = segment(printable, state);
    if (previous && sameStyle(previous, next)) line[line.length - 1] = { ...previous, text: previous.text + printable };
    else line.push(next);
  };
  const text = (value: string) => {
    const parts = value.replace(/\r\n?/gu, "\n").split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      push(part);
    });
  };

  let cursor = 0;
  for (const match of input.matchAll(ESCAPE)) {
    text(input.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (match[3] === "m" && !match[2]) applySgr(state, match[1] ?? "");
  }
  text(input.slice(cursor));
  return lines;
}

function sameStyle(left: AnsiSegment, right: AnsiSegment): boolean {
  return left.foreground === right.foreground &&
    left.background === right.background &&
    left.bold === right.bold &&
    left.dim === right.dim &&
    left.italic === right.italic &&
    left.underline === right.underline;
}

export function lineText(line: AnsiLine): string {
  return line.map((part) => part.text).join("");
}

/** A line drawn only with box-drawing or dash characters, e.g. a TUI separator. */
export function isRuleLine(line: AnsiLine): boolean {
  const text = lineText(line).trim();
  return text.length >= 8 && /^[─━═╌╍┄┅┈┉\-_—]+$/u.test(text);
}

/**
 * Trims trailing whitespace-only lines and collapses runs of blank lines so a
 * terminal screen reads as a compact transcript.
 */
export function compactLines(lines: readonly AnsiLine[]): AnsiLine[] {
  const compact: AnsiLine[] = [];
  let blank = 0;
  for (const line of lines) {
    const empty = lineText(line).trim() === "";
    blank = empty ? blank + 1 : 0;
    if (empty && (blank > 1 || compact.length === 0)) continue;
    compact.push(line);
  }
  while (compact.length > 0 && lineText(compact.at(-1)!).trim() === "") compact.pop();
  return compact;
}
