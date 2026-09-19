import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "./App";
import { initialAgents } from "./fixtures";

vi.mock("./TerminalOutput", () => ({ TerminalOutput: () => <div className="terminal-frame" tabIndex={0} /> }));
vi.mock("@git-diff-view/react", () => ({
  DiffFile: { createInstance: () => ({ initTheme: vi.fn(), init: vi.fn(), buildUnifiedDiffLines: vi.fn() }) },
  DiffModeEnum: { Unified: "unified" },
  DiffView: () => <div data-testid="diff-view" />,
}));

afterEach(() => {
  cleanup();
  delete (document as unknown as { elementFromPoint?: Document["elementFromPoint"] }).elementFromPoint;
});

function mockElementFromPoint(target: Element | null) {
  const hitTest = vi.fn((_x: number, _y: number): Element | null => target);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: hitTest,
  });
  return hitTest;
}

describe("summoned hud", () => {
  test("every non-root fixture has an existing parent", () => {
    const ids = new Set(initialAgents.map((agent) => agent.id));
    expect(initialAgents.every((agent) => !agent.parentId || ids.has(agent.parentId))).toBe(true);
  });

  test("uses the aperture signal for runtime health without a separate dot", () => {
    const { container } = render(<App />);
    expect(screen.getByRole("button", { name: /Runtime demo; toggle focus drawer/ })).toBeInTheDocument();
    expect(container.querySelector(".aperture-runtime-demo")).toBeInTheDocument();
    expect(container.querySelector(".runtime-connection")).not.toBeInTheDocument();
  });

  test("surfaces needing-attention agents on the bar", () => {
    render(<App />);
    const triage = screen.getByRole("button", { name: /need you/ });
    expect(triage).toBeInTheDocument();

    fireEvent.click(triage);
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close fleet" }));
    expect(screen.queryByRole("heading", { name: "Needs you" })).not.toBeInTheDocument();
    expect(triage).toBeInTheDocument();
  });

  test("surfaces attention and completed conversations beside the collapsed rail", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Runtime demo; toggle focus drawer/ }));

    const peek = screen.getByRole("complementary", { name: "Conversation updates" });
    expect(within(peek).getByRole("button", { name: /Herdr adapter · Review patch/ })).toBeInTheDocument();
    expect(within(peek).getByRole("button", { name: /Interaction study · Done/ })).toBeInTheDocument();
    expect(within(peek).getByRole("button", { name: /more updates/ })).toBeInTheDocument();

    fireEvent.click(within(peek).getByRole("button", { name: /Herdr adapter/ }));
    expect(screen.getByLabelText("Terminal for Herdr adapter")).toBeInTheDocument();
  });

  test("acknowledges a completed conversation locally after opening it", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Runtime demo; toggle focus drawer/ }));
    const peek = screen.getByRole("complementary", { name: "Conversation updates" });
    fireEvent.click(within(peek).getByRole("button", { name: /Interaction study · Done/ }));
    expect(screen.getByLabelText("Terminal for Interaction study")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: "Conversation updates" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Interaction study · Done/ })).not.toBeInTheDocument();
  });

  test("focuses the update rail with the summon event and opens the full fleet with F", () => {
    render(<App />);

    fireEvent(window, new Event("heed:focus-list"));

    const peek = screen.getByRole("complementary", { name: "Conversation updates" });
    const first = within(peek).getByRole("button", { name: /Herdr adapter/ });
    expect(peek).toHaveClass("is-expanded");
    expect(document.activeElement).toBe(first);
    expect(first).toHaveAttribute("aria-current", "true");

    fireEvent(window, new Event("blur"));
    expect(peek).toHaveClass("is-compact");
    fireEvent.mouseEnter(document.querySelector(".hud")!);
    expect(peek).toHaveClass("is-expanded");
    fireEvent.mouseLeave(document.querySelector(".hud")!);
    expect(peek).toHaveClass("is-compact");
    fireEvent(window, new Event("focus"));
    expect(peek).toHaveClass("is-expanded");

    fireEvent.keyDown(window, { key: "f" });
    expect(screen.getByRole("heading", { name: "All agents" })).toBeInTheDocument();
  });

  test("mirrors inactive rail entry and exit from the native shell", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Runtime demo; toggle focus drawer/ }));

    const peek = screen.getByRole("complementary", { name: "Conversation updates" });
    fireEvent(window, new Event("blur"));
    expect(peek).toHaveClass("is-compact");

    fireEvent(window, new Event("heed:rail-hover"));
    expect(peek).toHaveClass("is-expanded");
    fireEvent(window, new Event("heed:rail-hover"));
    expect(peek).toHaveClass("is-expanded");

    fireEvent(window, new Event("heed:rail-hover-end"));
    expect(peek).toHaveClass("is-compact");
    fireEvent(window, new Event("heed:rail-hover-end"));
    expect(peek).toHaveClass("is-compact");
  });

  test("mirrors inactive pointer hover and first-click actions from the native shell", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Runtime demo; toggle focus drawer/ }));

    const peek = screen.getByRole("complementary", { name: "Conversation updates" });
    const first = within(peek).getByRole("button", { name: /Herdr adapter/ });
    const second = within(peek).getByRole("button", { name: /Migration review/ });
    const hitTest = mockElementFromPoint(first);

    fireEvent(window, new CustomEvent("heed:rail-pointer", { detail: { x: 12, y: 16 } }));
    expect(first).toHaveClass("is-native-hover");

    hitTest.mockReturnValue(second);
    fireEvent(window, new CustomEvent("heed:rail-pointer", { detail: { x: 12, y: 48 } }));
    expect(first).not.toHaveClass("is-native-hover");
    expect(second).toHaveClass("is-native-hover");
    expect(second).toHaveAttribute("aria-current", "true");

    fireEvent(window, new Event("heed:rail-hover-end"));
    expect(second).not.toHaveClass("is-native-hover");

    hitTest.mockReturnValue(peek);
    const hitTestsBeforeInvalidPointer = hitTest.mock.calls.length;
    fireEvent(window, new CustomEvent("heed:rail-pointer", { detail: {} }));
    expect(hitTest).toHaveBeenCalledTimes(hitTestsBeforeInvalidPointer);
    fireEvent(window, new CustomEvent("heed:rail-click", { detail: { x: 40, y: 40 } }));
    expect(screen.queryByLabelText(/Terminal for/)).not.toBeInTheDocument();

    hitTest.mockReturnValue(first);
    fireEvent(window, new CustomEvent("heed:rail-click", { detail: { x: 12, y: 16 } }));
    expect(screen.getByLabelText("Terminal for Herdr adapter")).toBeInTheDocument();
  });

  test("cycles collapsed updates with alternate arrow keys and opens the selected terminal", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Runtime demo; toggle focus drawer/ }));

    const peek = screen.getByRole("complementary", { name: "Conversation updates" });
    const first = within(peek).getByRole("button", { name: /Herdr adapter/ });
    const second = within(peek).getByRole("button", { name: /Migration review/ });
    expect(first).toHaveAttribute("aria-current", "true");

    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(second).toHaveAttribute("aria-current", "true");

    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByLabelText("Terminal for Migration review")).toBeInTheDocument();
  });

  test("recentres the selected child and opens its keyboard-navigable diff", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Floating prototype/ }));
    expect(screen.getByRole("heading", { name: "Floating prototype" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /changes/i }));
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText(/3 files · \+46 −0/)).toBeInTheDocument();

    const firstFile = screen.getByLabelText("src/App.tsx, added");
    const secondFile = screen.getByLabelText("src/styles.css, added");
    await waitFor(() => expect(document.activeElement).toBe(firstFile));
    fireEvent.keyDown(firstFile, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(secondFile));
    expect(secondFile.closest("details")).toHaveClass("is-active");

    fireEvent.keyDown(secondFile, { key: "Enter" });
    expect(secondFile.closest("details")).toHaveAttribute("open");
    fireEvent.keyDown(secondFile, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(firstFile));
  });

  test("spawns a child that immediately becomes the focus", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Spawn child/i }));
    expect(screen.getByRole("heading", { name: "New collaborator" })).toBeInTheDocument();
  });

  test("finds a session in the fleet and opens its terminal", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "All agents" }));
    expect(screen.getByRole("heading", { name: "All agents" })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Find session/i), { target: { value: "Herdr adapter" } });
    fireEvent.click(screen.getByRole("button", { name: /Herdr adapter/ }));

    expect(screen.getByLabelText("Terminal for Herdr adapter")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "All agents" })).toBeInTheDocument();
  });

  test("opens the terminal surface without a parallel message composer", () => {
    render(<App />);

    fireEvent.keyDown(window, { key: "t" });
    expect(screen.getByLabelText("Terminal for Synthesis lead")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
  });

  test("navigates the attention list into a terminal and back", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /need you/ }));

    const fleet = screen.getByRole("heading", { name: "Needs you" }).closest(".fleet-drawer")!;
    await waitFor(() => expect(fleet.querySelector(".is-selected")).toBeInTheDocument());
    fireEvent.keyDown(fleet, { key: "ArrowDown" });
    fireEvent.keyDown(fleet, { key: "Enter" });

    expect(screen.getByLabelText(/Terminal for/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    await waitFor(() => expect(screen.queryByLabelText(/Terminal for/)).not.toBeInTheDocument());
    expect(screen.getByRole("complementary", { name: "Conversation updates" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "f" });
    expect(screen.getByRole("heading", { name: "All agents" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "All agents" })).not.toBeInTheDocument());
    expect(screen.getByRole("complementary", { name: "Conversation updates" })).toBeInTheDocument();
  });

  test("toggles the main pane without hiding the sidebar", async () => {
    render(<App />);

    fireEvent(window, new Event("heed:toggle-main"));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Synthesis lead" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /need you/ })).toBeInTheDocument();

    fireEvent(window, new Event("heed:toggle-main"));
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeInTheDocument();
  });

  test("opens and closes keyboard help with the question-mark shortcut", () => {
    render(<App />);

    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(screen.getByRole("heading", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByText("Focus update rail")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(screen.queryByRole("heading", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Synthesis lead" })).toBeInTheDocument();
  });

  test("restores update-rail focus whenever the native panel is summoned", async () => {
    render(<App />);
    fireEvent(window, new Event("heed:hidden"));

    fireEvent(window, new Event("heed:shown"));
    const peek = await screen.findByRole("complementary", { name: "Conversation updates" });
    const first = within(peek).getByRole("button", { name: /Herdr adapter/ });
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: "f" });
    expect(screen.getByRole("heading", { name: "All agents" })).toBeInTheDocument();
  });

  test("restores fleet keyboard focus after choosing All agents in the palette", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /need you/ }));
    const fleet = screen.getByRole("heading", { name: "Needs you" }).closest(".fleet-drawer")!;

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const paletteSearch = screen.getByPlaceholderText(/Find an Agent or run a command/);
    fireEvent.change(paletteSearch, { target: { value: "All agents" } });
    fireEvent.keyDown(paletteSearch, { key: "Enter" });

    await waitFor(() => expect(screen.getByRole("heading", { name: "All agents" })).toBeInTheDocument());
    expect(document.activeElement).toBe(fleet);
    const before = fleet.querySelector(".is-selected")?.getAttribute("data-agent-id");
    fireEvent.keyDown(fleet, { key: "ArrowDown" });
    expect(fleet.querySelector(".is-selected")?.getAttribute("data-agent-id")).not.toBe(before);
  });

  test("returns from the terminal to the update rail with Escape or Command-W", async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "t" });

    const terminal = screen.getByLabelText("Terminal for Synthesis lead");
    expect(screen.getByText("Back to update rail")).toBeInTheDocument();
    expect(screen.getByText("⌘W")).toBeInTheDocument();
    const terminalInput = document.createElement("div");
    terminalInput.className = "terminal-frame";
    terminal.append(terminalInput);
    fireEvent.keyDown(terminalInput, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("Terminal for Synthesis lead")).not.toBeInTheDocument());
    expect(screen.getByRole("complementary", { name: "Conversation updates" })).toBeInTheDocument();

    // Command-W is also handled before the terminal guard when the terminal is open.
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByLabelText("Terminal for Synthesis lead")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    await waitFor(() => expect(screen.queryByLabelText("Terminal for Synthesis lead")).not.toBeInTheDocument());
    expect(screen.getByRole("complementary", { name: "Conversation updates" })).toBeInTheDocument();
  });
});
