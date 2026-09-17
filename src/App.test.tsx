import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { App } from "./App";
import { initialAgents } from "./fixtures";

afterEach(cleanup);

describe("summoned hud", () => {
  test("every non-root fixture has an existing parent", () => {
    const ids = new Set(initialAgents.map((agent) => agent.id));
    expect(initialAgents.every((agent) => !agent.parentId || ids.has(agent.parentId))).toBe(true);
  });

  test("surfaces needing-attention agents on the bar", () => {
    render(<App />);
    const triage = screen.getByRole("button", { name: /need you/ });
    expect(triage).toBeInTheDocument();

    fireEvent.click(triage);
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeInTheDocument();
  });

  test("recentres the selected child and opens its stacked diff", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /Floating prototype/ }));
    expect(screen.getByRole("heading", { name: "Floating prototype" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /changes/i }));
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText(/3 files · \+46 −0/)).toBeInTheDocument();
  });

  test("spawns a child that immediately becomes the focus", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Spawn child/i }));
    expect(screen.getByRole("heading", { name: "New collaborator" })).toBeInTheDocument();
  });

  test("finds a session in the fleet and returns to its local constellation", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "All agents" }));
    expect(screen.getByRole("heading", { name: "All agents" })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Find session/i), { target: { value: "Herdr adapter" } });
    fireEvent.click(screen.getByRole("button", { name: /Herdr adapter/ }));

    expect(screen.getByRole("heading", { name: "Herdr adapter" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "All agents" })).not.toBeInTheDocument());
  });

  test("opens the reply card with R and sends a message", () => {
    render(<App />);

    fireEvent.keyDown(window, { key: "r" });
    expect(screen.getByPlaceholderText(/respond/i)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/respond/i), { target: { value: "Ship the bar first" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(screen.getByText("Ship the bar first")).toBeInTheDocument();
  });

  test("escape peels the reply, then the drawer, then hides the bar", async () => {
    render(<App />);

    fireEvent.keyDown(window, { key: "r" });
    expect(screen.getByPlaceholderText(/respond/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByPlaceholderText(/respond/i)).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Synthesis lead" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Synthesis lead" })).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: /need you/ })).toBeInTheDocument();
  });
});
