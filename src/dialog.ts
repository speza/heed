import { type AnsiLine, lineText } from "./ansi";

export interface DialogChoice {
  /** The digit that selects this option. */
  readonly value: string;
  readonly label: string;
  readonly highlighted: boolean;
}

export interface Dialog {
  readonly question?: string;
  readonly choices: readonly DialogChoice[];
}

const BORDER = /^[\s│┃|╎╏]+|[\s│┃|╎╏]+$/gu;
const OPTION = /^([❯›>▶➜→]\s*)?([1-9])[.)]\s+(\S.*)$/u;
// Only the bottom of the screen can hold the live dialog.
const DIALOG_WINDOW_LINES = 30;

/**
 * Finds the numbered options of a blocking dialog (e.g. `❯ 1. Yes`) at the
 * bottom of a terminal screen. Returns the last run numbered 1, 2, 3… with at
 * least two options, or nothing when the screen holds no recognisable dialog.
 */
export function detectDialog(lines: readonly AnsiLine[]): Dialog | undefined {
  const window = lines.slice(-DIALOG_WINDOW_LINES).map((line) => lineText(line).replace(BORDER, ""));
  let found: { readonly start: number; readonly choices: DialogChoice[] } | undefined;
  for (let index = 0; index < window.length; index += 1) {
    const first = OPTION.exec(window[index]!);
    if (first?.[2] !== "1") continue;
    const choices: DialogChoice[] = [];
    for (let cursor = index; cursor < window.length; cursor += 1) {
      const option = OPTION.exec(window[cursor]!);
      if (option?.[2] === String(choices.length + 1)) {
        choices.push({ value: option[2], label: option[3]!.trim(), highlighted: Boolean(option[1]) });
      } else if (option || window[cursor]!.trim() === "") {
        break;
      }
      // Other lines continue a wrapped option label; they are ignored.
    }
    if (choices.length >= 2) found = { start: index, choices };
  }
  if (!found) return undefined;
  const question = window.slice(0, found.start).reverse().find((line) => line.trim() !== "")?.trim();
  return { ...(question ? { question } : {}), choices: found.choices };
}
