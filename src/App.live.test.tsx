import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchRuntime: vi.fn(),
  fetchAgentChanges: vi.fn(),
}));

vi.mock("./runtime/client", () => ({
  fetchRuntime: mocks.fetchRuntime,
  fetchAgentChanges: mocks.fetchAgentChanges,
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
});
