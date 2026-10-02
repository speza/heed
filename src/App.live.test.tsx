import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchRuntime: vi.fn(),
  fetchAgentChanges: vi.fn(),
  fetchAgentScreen: vi.fn(),
  sendAgentInput: vi.fn(),
}));

vi.mock("./runtime/client", () => ({
  fetchRuntime: mocks.fetchRuntime,
  fetchAgentChanges: mocks.fetchAgentChanges,
  fetchAgentScreen: mocks.fetchAgentScreen,
  sendAgentInput: mocks.sendAgentInput,
}));
vi.mock("./TerminalOutput", () => ({
  TerminalOutput: ({ agentId }: { readonly agentId: string }) => <div className="terminal-frame" data-terminal-agent={agentId} />,
}));
vi.mock("@git-diff-view/react", () => ({
  DiffFile: { createInstance: () => ({ initTheme: vi.fn(), init: vi.fn(), buildUnifiedDiffLines: vi.fn() }) },
  DiffModeEnum: { Unified: "unified" },
  DiffView: () => <div data-testid="diff-view" />,
}));

import { App } from "./App";

const source = { id: "herdr-local", kind: "herdr", label: "Herdr" } as const;
const capabilities = {
  terminal: true,
  output: true,
  conversation: false,
  workspaceChanges: true,
  spawn: false,
  lineage: false,
  reply: true,
} as const;

function snapshot(agents: readonly Record<string, unknown>[], available = true) {
  return {
    available,
    fetchedAt: Date.now(),
    sources: [source],
    sourceHealth: [{ source, available, stale: !available, fetchedAt: Date.now(), ...(available ? {} : { error: "Herdr offline" }) }],
    agents,
  };
}

function runtimeAgent(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source,
    name,
    kind: "assistant",
    status: "working",
    focused: false,
    revision: 1,
    capabilities,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.fetchRuntime.mockReset();
  mocks.fetchAgentChanges.mockReset();
  mocks.fetchAgentScreen.mockReset();
  mocks.sendAgentInput.mockReset();
});

describe("live App navigation", () => {
  test("does not retarget an open terminal when its selected Agent disappears", async () => {
    mocks.fetchRuntime
      .mockResolvedValueOnce(snapshot([runtimeAgent("herdr-local:a", "Agent A")]))
      .mockResolvedValue(snapshot([runtimeAgent("herdr-local:b", "Agent B")]));

    render(<App demo={false} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: /Runtime live/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Runtime live/ }));
    fireEvent.keyDown(window, { key: "t" });
    expect(screen.getByLabelText("Terminal for Agent A")).toBeInTheDocument();

    await waitFor(() => expect(screen.queryByLabelText("Terminal for Agent A")).not.toBeInTheDocument(), { timeout: 4_000 });

    expect(screen.queryByLabelText("Terminal for Agent B")).not.toBeInTheDocument();
    expect(screen.getByText("The selected Agent is no longer available.")).toBeInTheDocument();
  });

  test("ignores a delayed changes response after Escape returns to the rail", async () => {
    let resolveChanges!: (value: { readonly workspace: string; readonly files: readonly []; readonly partial: false }) => void;
    mocks.fetchRuntime.mockResolvedValue(snapshot([runtimeAgent("herdr-local:a", "Agent A")]));
    mocks.fetchAgentChanges.mockImplementation(() => new Promise((resolve) => { resolveChanges = resolve; }));

    render(<App demo={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Runtime live/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Runtime live/ }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace changes" }));
    expect(mocks.fetchAgentChanges).toHaveBeenCalledWith("herdr-local:a", expect.any(AbortSignal));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("heading", { name: "Workspace changes" })).not.toBeInTheDocument();
    resolveChanges({ workspace: "/tmp/heed", files: [], partial: false });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Workspace changes" })).not.toBeInTheDocument());
    expect(screen.getByRole("complementary", { name: "Conversation updates" })).toBeInTheDocument();
  });

  test("opens changes for the active non-selected Fleet row", async () => {
    let resolveChanges!: (value: { readonly workspace: string; readonly files: readonly []; readonly partial: false }) => void;
    mocks.fetchRuntime.mockResolvedValue(snapshot([
      runtimeAgent("herdr-local:a", "Agent A"),
      runtimeAgent("herdr-local:b", "Agent B"),
    ]));
    mocks.fetchAgentChanges.mockImplementation(() => new Promise((resolve) => { resolveChanges = resolve; }));

    render(<App demo={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Runtime live/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Runtime live/ }));
    fireEvent.click(screen.getByRole("button", { name: "All agents" }));

    const row = screen.getByRole("button", { name: /Agent B/ });
    fireEvent.focus(row);
    await waitFor(() => expect(row).toHaveClass("is-selected"));
    const fleet = screen.getByRole("heading", { name: "All agents" }).closest(".fleet-drawer")!;
    fireEvent.keyDown(row, { key: "d" });
    expect(mocks.fetchAgentChanges).toHaveBeenCalledWith("herdr-local:b", expect.any(AbortSignal));

    resolveChanges({ workspace: "/tmp/heed", files: [], partial: false });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Workspace changes" })).toBeInTheDocument());
    expect(fleet).not.toBeInTheDocument();
  });

  test("does not reopen Diff after Fleet is closed while changes are pending", async () => {
    let resolveChanges!: (value: { readonly workspace: string; readonly files: readonly []; readonly partial: false }) => void;
    mocks.fetchRuntime.mockResolvedValue(snapshot([runtimeAgent("herdr-local:a", "Agent A")]));
    mocks.fetchAgentChanges.mockImplementation(() => new Promise((resolve) => { resolveChanges = resolve; }));

    render(<App demo={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Runtime live/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Runtime live/ }));
    fireEvent.click(screen.getByRole("button", { name: "All agents" }));
    const fleet = screen.getByRole("heading", { name: "All agents" }).closest(".fleet-drawer")!;
    fireEvent.keyDown(fleet, { key: "d" });
    expect(mocks.fetchAgentChanges).toHaveBeenCalledWith("herdr-local:a", expect.any(AbortSignal));

    fireEvent.click(screen.getByRole("button", { name: "Close fleet" }));
    resolveChanges({ workspace: "/tmp/heed", files: [], partial: false });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Workspace changes" })).not.toBeInTheDocument());
    expect(screen.getByRole("complementary", { name: "Conversation updates" })).toBeInTheDocument();
  });

  test("hides actions for a retained Agent from an unavailable source", async () => {
    const unavailableCapabilities = {
      terminal: false,
      output: false,
      conversation: false,
      workspaceChanges: false,
      spawn: false,
      lineage: false,
      reply: false,
    } as const;
    mocks.fetchRuntime
      .mockResolvedValueOnce(snapshot([runtimeAgent("herdr-local:a", "Agent A")]))
      .mockResolvedValue(snapshot([runtimeAgent("herdr-local:a", "Agent A", {
        sourceAvailable: false,
        sourceStale: true,
        capabilities: unavailableCapabilities,
      })], false));

    render(<App demo={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Runtime live/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Runtime live/ }));
    expect(screen.getByRole("button", { name: "Workspace changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Terminal/ })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole("button", { name: /Runtime stale/ })).toBeInTheDocument(), { timeout: 4_000 });
    expect(screen.queryByRole("button", { name: "Workspace changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Terminal/ })).not.toBeInTheDocument();
  });

  test("previews the active Agent's screen beside the list without opening its terminal", async () => {
    mocks.fetchRuntime.mockResolvedValue(snapshot([
      runtimeAgent("herdr-local:a", "Agent A", { status: "blocked" }),
      runtimeAgent("herdr-local:b", "Agent B"),
    ]));
    mocks.fetchAgentScreen.mockImplementation(async (id: string) => ({
      text: id === "herdr-local:a" ? "\u001b[1mAllow edit to App.tsx?\u001b[0m\r\n  1. Yes\r\n" : "Compiling…",
      format: "ansi",
      truncated: false,
    }));

    render(<App demo={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Runtime live/ })).toBeInTheDocument());
    act(() => window.dispatchEvent(new Event("heed:toggle-main")));

    expect(await screen.findByText("Allow edit to App.tsx?")).toBeInTheDocument();
    expect(mocks.fetchAgentScreen).toHaveBeenCalledWith("herdr-local:a", expect.any(AbortSignal));
    expect(screen.queryByLabelText(/Terminal for/)).not.toBeInTheDocument();
  });

  test("summons the full list when nothing needs attention", async () => {
    mocks.fetchRuntime.mockResolvedValue(snapshot([runtimeAgent("herdr-local:a", "Agent A")]));
    mocks.fetchAgentScreen.mockResolvedValue({ text: "", format: "ansi", truncated: false });

    render(<App demo={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Runtime live/ })).toBeInTheDocument());
    act(() => window.dispatchEvent(new Event("heed:toggle-main")));

    expect(screen.getByRole("heading", { name: "All agents" })).toBeInTheDocument();
  });

  test("drops an acknowledged turn from the attention list and the spine count together", async () => {
    mocks.fetchRuntime.mockResolvedValue(snapshot([
      runtimeAgent("herdr-local:a", "Agent A", { status: "done", stateSequence: 7, revision: 3 }),
      runtimeAgent("herdr-local:b", "Agent B", { status: "blocked" }),
    ]));
    mocks.fetchAgentScreen.mockResolvedValue({ text: "", format: "ansi", truncated: false });

    render(<App demo={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "2 need you" })).toBeInTheDocument());
    act(() => window.dispatchEvent(new Event("heed:toggle-main")));
    fireEvent.click(screen.getByRole("button", { name: /Agent A/ }));
    expect(screen.getByLabelText("Terminal for Agent A")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "w", metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "1 need you" }));
    expect(screen.getByRole("button", { name: /^Needs you 1$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Agent A/ })).not.toBeInTheDocument();
  });

  test("marks a finished turn seen from the preview without opening its terminal", async () => {
    mocks.fetchRuntime.mockResolvedValue(snapshot([runtimeAgent("herdr-local:a", "Agent A", { status: "done", stateSequence: 2 })]));
    mocks.fetchAgentScreen.mockResolvedValue({ text: "All tests pass.", format: "ansi", truncated: false });

    render(<App demo={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "1 need you" })).toBeInTheDocument());
    act(() => window.dispatchEvent(new Event("heed:toggle-main")));
    const fleet = screen.getByRole("heading", { name: "Needs you" }).closest(".fleet-drawer")!;
    fireEvent.keyDown(fleet, { key: "e" });

    expect(screen.getByRole("button", { name: "0 need you · all clear" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Terminal for/)).not.toBeInTheDocument();
  });

  test("sends a quick prompt to an idle Agent from the list and refreshes runtime state", async () => {
    mocks.fetchRuntime.mockResolvedValue(snapshot([runtimeAgent("herdr-local:a", "Agent A", { status: "idle" })]));
    mocks.fetchAgentScreen.mockResolvedValue({ text: "❯ ", format: "ansi", truncated: false });
    mocks.sendAgentInput.mockResolvedValue(undefined);

    render(<App demo={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Runtime live/ })).toBeInTheDocument());
    act(() => window.dispatchEvent(new Event("heed:toggle-main")));
    const fleet = screen.getByRole("heading", { name: "All agents" }).closest(".fleet-drawer")!;
    fireEvent.keyDown(fleet, { key: "r" });
    const field = screen.getByRole("textbox", { name: "Reply to Agent A" });
    expect(field).toHaveFocus();

    const refreshesBefore = mocks.fetchRuntime.mock.calls.length;
    fireEvent.change(field, { target: { value: "run the tests again" } });
    fireEvent.submit(field.closest("form")!);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sent"));
    expect(mocks.sendAgentInput).toHaveBeenCalledWith("herdr-local:a", { kind: "prompt", text: "run the tests again" });
    expect(mocks.fetchRuntime.mock.calls.length).toBeGreaterThan(refreshesBefore);
    expect(screen.queryByLabelText(/Terminal for/)).not.toBeInTheDocument();
  });

  test("answers a blocked Agent's dialog with a number key instead of a prompt", async () => {
    mocks.fetchRuntime.mockResolvedValue(snapshot([runtimeAgent("herdr-local:a", "Agent A", { status: "blocked" })]));
    mocks.fetchAgentScreen.mockResolvedValue({
      text: "Do you want to make this edit?\r\n❯ 1. Yes\r\n  2. Yes, allow all edits\r\n  3. No (esc)\r\n",
      format: "ansi",
      truncated: false,
    });
    mocks.sendAgentInput.mockResolvedValue(undefined);

    render(<App demo={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "1 need you" })).toBeInTheDocument());
    act(() => window.dispatchEvent(new Event("heed:toggle-main")));
    expect(await screen.findByRole("button", { name: /Yes, allow all edits/ })).toBeInTheDocument();
    expect(screen.getByText("Do you want to make this edit?", { selector: ".quick-reply-question" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Reply to Agent A" })).not.toBeInTheDocument();

    const fleet = screen.getByRole("heading", { name: "Needs you" }).closest(".fleet-drawer")!;
    fireEvent.keyDown(fleet, { key: "1" });

    await waitFor(() => expect(mocks.sendAgentInput).toHaveBeenCalledWith("herdr-local:a", { kind: "choice", value: "1" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Answered “Yes”");
  });

  test("shows a reply error without losing the typed prompt", async () => {
    mocks.fetchRuntime.mockResolvedValue(snapshot([runtimeAgent("herdr-local:a", "Agent A", { status: "idle" })]));
    mocks.fetchAgentScreen.mockResolvedValue({ text: "", format: "ansi", truncated: false });
    mocks.sendAgentInput.mockRejectedValue(new Error("This agent is waiting at a dialog; answer it before sending a prompt."));

    render(<App demo={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Runtime live/ })).toBeInTheDocument());
    act(() => window.dispatchEvent(new Event("heed:toggle-main")));
    const field = screen.getByRole("textbox", { name: "Reply to Agent A" });
    fireEvent.change(field, { target: { value: "continue" } });
    fireEvent.submit(field.closest("form")!);

    expect(await screen.findByRole("status")).toHaveTextContent("waiting at a dialog");
    expect(field).toHaveValue("continue");
  });

  test("shows how long each Agent has been in its observed state", async () => {
    mocks.fetchRuntime.mockResolvedValue(snapshot([
      runtimeAgent("herdr-local:a", "Agent A", { status: "blocked", statusSince: Date.now() - 5 * 60_000 }),
      runtimeAgent("herdr-local:b", "Agent B", { status: "working" }),
    ]));
    mocks.fetchAgentScreen.mockResolvedValue({ text: "", format: "ansi", truncated: false });

    render(<App demo={false} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "1 need you" })).toBeInTheDocument());
    act(() => window.dispatchEvent(new Event("heed:toggle-main")));
    act(() => screen.getByRole("button", { name: /^All \d+$/ }).click());

    expect(screen.getByRole("button", { name: /Agent A.*5m/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Agent B/ }).textContent).not.toMatch(/\d+[smhd]|now/);
  });
});
