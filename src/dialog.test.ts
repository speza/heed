import { describe, expect, test } from "vitest";
import { parseAnsi } from "./ansi";
import { detectDialog } from "./dialog";

describe("dialog detection", () => {
  test("reads a Claude Code permission dialog with its question and highlighted option", () => {
    const dialog = detectDialog(parseAnsi([
      "⏺ Update(src/App.tsx)",
      "│ Do you want to make this edit to App.tsx?",
      "│ \u001b[36m❯ 1. Yes\u001b[0m",
      "│   2. Yes, allow all edits during this session (shift+tab)",
      "│   3. No, and tell Claude what to do differently (esc)",
      "",
    ].join("\r\n")));

    expect(dialog).toEqual({
      question: "Do you want to make this edit to App.tsx?",
      choices: [
        { value: "1", label: "Yes", highlighted: true },
        { value: "2", label: "Yes, allow all edits during this session (shift+tab)", highlighted: false },
        { value: "3", label: "No, and tell Claude what to do differently (esc)", highlighted: false },
      ],
    });
  });

  test("uses the last numbered run, not an earlier markdown list", () => {
    const dialog = detectDialog(parseAnsi([
      "Plan:",
      "1. Read the code",
      "2. Fix the bug",
      "",
      "Run tests?",
      "› 1) Yes, proceed (y)",
      "  2) No (esc)",
    ].join("\n")));

    expect(dialog?.question).toBe("Run tests?");
    expect(dialog?.choices.map((choice) => choice.label)).toEqual(["Yes, proceed (y)", "No (esc)"]);
  });

  test("ignores a single option or out-of-order numbering", () => {
    expect(detectDialog(parseAnsi("1. Only option"))).toBeUndefined();
    expect(detectDialog(parseAnsi("1. First\n3. Third"))).toBeUndefined();
    expect(detectDialog(parseAnsi("Nothing to answer here."))).toBeUndefined();
  });
});
