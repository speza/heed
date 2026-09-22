import { describe, expect, test } from "vitest";
import { AmpRuntimeAdapter, ampRuntimeStatus, ampThreadAgent, parseAmpThreadList, parseAmpTop, type AmpCommandResult } from "./amp";

const ok = (stdout: string): AmpCommandResult => ({ exitCode: 0, stdout, stderr: "", truncated: false });

const threadList = JSON.stringify([
  { id: "T-123", title: "Review the adapter", updated: "2026-09-18T10:00:00.000Z", tree: "tree-1", messageCount: 7 },
  { id: "T-456", title: "", messageCount: 0 },
]);

describe("Amp runtime adapter", () => {
  test("parses Amp's array and normalizes bounded thread summaries", () => {
    expect(parseAmpThreadList(threadList)).toEqual([
      {
        id: "T-123",
        title: "Review the adapter",
        updated: "2026-09-18T10:00:00.000Z",
        messageCount: 7,
      },
      { id: "T-456", messageCount: 0 },
    ]);
    expect(parseAmpThreadList(JSON.stringify({ threads: [{ id: "T-envelope", messageCount: 2 }] }))).toEqual([
      { id: "T-envelope", messageCount: 2 },
    ]);
  });

  test("parses the live top snapshot and treats active threads as current state", () => {
    expect([...parseAmpTop(JSON.stringify({ threads: [{ id: "T-123", state: "awaiting-approval" }, { threadId: "T-456" }] }))]).toEqual([
      ["T-123", "awaiting-approval"],
      ["T-456", "running"],
    ]);
  });

  test("maps Amp lifecycle states without treating idle history as attention", () => {
    expect(ampRuntimeStatus("running")).toBe("working");
    expect(ampRuntimeStatus("awaiting-approval")).toBe("blocked");
    expect(ampRuntimeStatus("idle")).toBe("idle");
    expect(ampRuntimeStatus("error")).toBe("unknown");
    expect(ampThreadAgent({ id: "T-1", messageCount: 1 })).toMatchObject({
      id: "amp-local:T-1",
      source: { id: "amp-local", kind: "amp", label: "Amp Code" },
      status: "idle",
      capabilities: { output: true, terminal: false, workspaceChanges: false },
    });
  });

  test("lists threads and reads bounded markdown output without owning a terminal", async () => {
    const calls: string[][] = [];
    const run = async (argv: readonly string[]) => {
      calls.push([...argv]);
      if (argv.includes("markdown")) return ok("first\nsecond\nthird\n");
      if (argv.includes("top")) return ok(JSON.stringify({ threads: [{ id: "T-123", state: "running" }] }));
      return ok(threadList);
    };
    const adapter = new AmpRuntimeAdapter({ run, cacheMs: 0, threadLimit: 12 });

    const snapshot = await adapter.snapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.agents.map(({ id }) => id)).toEqual(["amp-local:T-123", "amp-local:T-456"]);
    expect(snapshot.agents[0]).toMatchObject({ status: "working", openIn: { label: "Open in Amp", url: "https://ampcode.com/threads/T-123" } });
    expect(snapshot.agents[1]).toMatchObject({ status: "idle" });

    const output = await adapter.readOutput("amp-local:T-123", {
      lines: 2,
      format: "ansi",
      source: "visible",
    });
    expect(output).toMatchObject({ text: "second\nthird\n", format: "text", revision: 7, truncated: true });
    expect(calls).toEqual([
      ["amp", "threads", "list", "--json", "--limit", "12"],
      ["amp", "top", "--stream-jsonl"],
      ["amp", "threads", "list", "--json", "--limit", "12"],
      ["amp", "top", "--stream-jsonl"],
      ["amp", "threads", "markdown", "T-123"],
    ]);
  });
});
