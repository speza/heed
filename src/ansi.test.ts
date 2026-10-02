import { describe, expect, test } from "vitest";
import { compactLines, isRuleLine, lineText, parseAnsi } from "./ansi";

describe("ANSI screen parsing", () => {
  test("keeps SGR colour and weight while dropping other control sequences", () => {
    const [line] = parseAnsi("\u001b[2J\u001b[1;38;2;153;153;153mDone\u001b[0m · \u001b[31mfailed\u001b[39m");

    expect(lineText(line!)).toBe("Done · failed");
    expect(line).toEqual([
      { text: "Done", foreground: "rgb(153, 153, 153)", bold: true },
      { text: " · " },
      { text: "failed", foreground: "var(--ansi-red)" },
    ]);
  });

  test("splits CRLF lines and carries style across them", () => {
    const lines = parseAnsi("\u001b[32mone\r\ntwo\u001b[0m\r\nthree");

    expect(lines.map(lineText)).toEqual(["one", "two", "three"]);
    expect(lines[1]![0]).toMatchObject({ foreground: "var(--ansi-green)" });
    expect(lines[2]![0]!.foreground).toBeUndefined();
  });

  test("maps 256-colour cube indices and swaps inverse colours", () => {
    const [line] = parseAnsi("\u001b[38;5;196mred\u001b[0m\u001b[7mselected");

    expect(line![0]).toMatchObject({ foreground: "rgb(255, 0, 0)" });
    expect(line![1]).toMatchObject({ foreground: "var(--ansi-inverse-foreground)", background: "var(--ansi-inverse-background)" });
  });

  test("compacts blank runs and recognises separator rules", () => {
    const lines = compactLines(parseAnsi("\n\nfirst\n\n\n\nsecond\n────────────\n   \n"));

    expect(lines.map(lineText)).toEqual(["first", "", "second", "────────────"]);
    expect(isRuleLine(lines[3]!)).toBe(true);
    expect(isRuleLine(lines[0]!)).toBe(false);
  });
});
