import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { AmpTranscript, parseAmpTranscript } from "./AmpTranscript";

afterEach(cleanup);

describe("Amp transcript parsing", () => {
  test("turns Amp Markdown role sections into conversation messages", () => {
    const document = parseAmpTranscript(`---
title: Example thread
threadId: T-example
---

# Example thread

## User
YOU

Please inspect **this**.

## Assistant
ASSISTANT

Here is the result:

\`\`\`ts
const answer = 42;
\`\`\`
`);

    expect(document.title).toBe("Example thread");
    expect(document.messages).toEqual([
      { role: "user", label: "You", body: "Please inspect **this**." },
      { role: "assistant", label: "Amp", body: "Here is the result:\n\n\`\`\`ts\nconst answer = 42;\n\`\`\`" },
    ]);
  });

  test("styles tool turns separately from user and assistant messages", () => {
    const document = parseAmpTranscript("## User\n\n**Tool Result:** `TU-1`\n\n```\n{}\n```\n\n## Assistant\n\n**Tool Use:** `shell_command`\n\n```json\n{}\n```");
    expect(document.messages.map(({ role, label }) => ({ role, label }))).toEqual([
      { role: "tool", label: "Tool result" },
      { role: "tool", label: "Tool use" },
    ]);
  });

  test("renders tool turns as collapsed disclosures", () => {
    render(<AmpTranscript markdown={"## Assistant\n\n**Tool Use:** `shell_command`\n\n```json\n{}\n```"} />);
    const disclosure = screen.getByText("Tool use").closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getAllByText("shell_command")).not.toHaveLength(0);
  });

  test("keeps a bounded partial export readable when role markers are absent", () => {
    expect(parseAmpTranscript("Latest output only").messages).toEqual([
      { role: "system", label: "Context", body: "Latest output only" },
    ]);
  });
});
