import { mkdtemp, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { inputCommand, normalizeSnapshot, StatusClock, workspaceChangesAt } from "./herdr";

const roots: string[] = [];

async function git(root: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `git exited ${code}`)));
  });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heed-herdr-"));
  roots.push(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Heed tests"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

async function commit(root: string, message: string): Promise<void> {
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", message]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Herdr workspace changes", () => {
  test("retains binary, mode-only and Git-quoted paths from NUL metadata", async () => {
    const root = await repository();
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, "run.sh"), "#!/bin/sh\necho base\n");
    await writeFile(join(root, "é.txt"), "base\n");
    await commit(root, "base");

    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 4]));
    await chmod(join(root, "run.sh"), 0o755);
    await writeFile(join(root, "é.txt"), "changed\n");

    const changes = await workspaceChangesAt(root);
    const byPath = new Map(changes.files.map((file) => [file.path, file]));

    expect([...byPath.keys()]).toEqual(expect.arrayContaining(["binary.bin", "run.sh", "é.txt"]));
    expect(byPath.get("binary.bin")).toMatchObject({ kind: "modified", binary: true, additions: 0, deletions: 0 });
    expect(byPath.get("run.sh")).toMatchObject({ kind: "modified", additions: 0, deletions: 0 });
    expect(byPath.get("run.sh")?.hunks.length).toBeGreaterThan(0);
    expect(byPath.get("é.txt")).toMatchObject({ kind: "modified", additions: 1, deletions: 1 });
  });

  test("retains empty and untracked files even when no textual hunk exists", async () => {
    const root = await repository();
    await writeFile(join(root, "tracked.txt"), "tracked\n");
    await commit(root, "base");
    await writeFile(join(root, "empty.txt"), "");

    const changes = await workspaceChangesAt(root);

    expect(changes.files.map((file) => file.path)).toContain("empty.txt");
    expect(changes.files.find((file) => file.path === "empty.txt")).toMatchObject({ kind: "added" });
  });

  test("bounds total Git work when many tracked files change", async () => {
    const root = await repository();
    const files = Array.from({ length: 65 }, (_, index) => `changed-${index}.bin`);
    await Promise.all(files.map((path, index) => writeFile(join(root, path), Buffer.from([0, index]))));
    await commit(root, "many binary files");
    await Promise.all(files.map((path, index) => writeFile(join(root, path), Buffer.from([0, index + 1]))));

    const changes = await workspaceChangesAt(root);

    expect(changes.files).toHaveLength(64);
    expect(changes.partial).toBe(true);
    expect(changes.message).toBe("Some workspace changes were omitted.");
  });

  test("does not read external contents through tracked, internal or dangling symlinks", async () => {
    const root = await repository();
    const external = await mkdtemp(join(tmpdir(), "heed-external-"));
    roots.push(external);
    const secret = "external-only-secret-content";
    await writeFile(join(external, "secret.txt"), secret);
    await writeFile(join(root, "target.txt"), "inside\n");
    await symlink("target.txt", join(root, "tracked-link.txt"));
    await symlink("target.txt", join(root, "internal-link.txt"));
    await commit(root, "symlink base");

    await symlink(join(external, "secret.txt"), join(root, "untracked-link.txt"));
    await symlink("missing.txt", join(root, "dangling-link.txt"));
    await rm(join(root, "tracked-link.txt"));
    await symlink(join(external, "secret.txt"), join(root, "tracked-link.txt"));

    const changes = await workspaceChangesAt(root);
    const changedPaths = new Set(changes.files.map((file) => file.path));
    const changedLinks = changes.files.filter((file) => file.path.endsWith("link.txt"));

    expect(changedPaths).toEqual(new Set(["dangling-link.txt", "tracked-link.txt", "untracked-link.txt"]));
    expect(changedLinks.every((file) => file.newFile === undefined)).toBe(true);
    expect(JSON.stringify(changes)).not.toContain(secret);
    await expect(readFile(join(root, "tracked-link.txt"), "utf8")).resolves.toBe(secret);
  });
});

describe("Herdr snapshot normalization", () => {
  function envelope(agents: readonly Record<string, unknown>[]) {
    return JSON.stringify({
      result: {
        snapshot: {
          version: "0.9.1",
          protocol: 22,
          workspaces: [{ workspace_id: "w1", label: "heed", worktree: { checkout_path: "/repo/heed" } }],
          agents,
        },
      },
    });
  }

  function pane(paneId: string, status: string, sequence: number) {
    return { pane_id: paneId, workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: status, state_change_seq: sequence };
  }

  test("orders by Herdr priority, then newest state change", () => {
    const snapshot = normalizeSnapshot(envelope([
      pane("w1:p1", "idle", 9),
      pane("w1:p2", "working", 4),
      pane("w1:p3", "blocked", 1),
      pane("w1:p4", "done", 3),
      pane("w1:p5", "working", 8),
      { pane_id: "w1:p6", workspace_id: "w1", tab_id: "w1:t1" },
    ]), 1_000);

    expect(snapshot.agents.map((agent) => agent.location.paneId)).toEqual(["w1:p3", "w1:p4", "w1:p5", "w1:p2", "w1:p1"]);
    expect(snapshot.agents[0]).toMatchObject({ status: "blocked", stateSequence: 1, location: { workspaceLabel: "heed", cwd: "/repo/heed" } });
  });

  test("reports time in state only from an observed transition", () => {
    const clock = new StatusClock();

    const first = normalizeSnapshot(envelope([pane("w1:p1", "working", 1)]), 1_000, clock);
    const unchanged = normalizeSnapshot(envelope([pane("w1:p1", "working", 1)]), 3_000, clock);
    const blocked = normalizeSnapshot(envelope([pane("w1:p1", "blocked", 2)]), 5_000, clock);
    const later = normalizeSnapshot(envelope([pane("w1:p1", "blocked", 2)]), 9_000, clock);

    expect(first.agents[0]?.statusSince).toBeUndefined();
    expect(unchanged.agents[0]?.statusSince).toBeUndefined();
    expect(blocked.agents[0]?.statusSince).toBe(5_000);
    expect(later.agents[0]?.statusSince).toBe(5_000);
  });

  test("treats a new turn in the same state as a fresh state", () => {
    const clock = new StatusClock();
    normalizeSnapshot(envelope([pane("w1:p1", "done", 1)]), 1_000, clock);

    const nextTurn = normalizeSnapshot(envelope([pane("w1:p1", "done", 4)]), 6_000, clock);

    expect(nextTurn.agents[0]?.statusSince).toBe(6_000);
  });

  test("rejects malformed snapshots without inventing agents", () => {
    expect(normalizeSnapshot("not json", 1_000)).toMatchObject({ available: false, agents: [] });
    expect(normalizeSnapshot(JSON.stringify({ result: {} }), 1_000)).toMatchObject({ available: false });
  });
});

describe("Herdr quick replies", () => {
  const agent = (status: "blocked" | "idle" | "working") => normalizeSnapshot(JSON.stringify({
    result: { snapshot: { agents: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: status }] } },
  }), 0).agents[0]!;

  test("submits prompts after an argument separator so text is never parsed as a flag", () => {
    expect(inputCommand(agent("idle"), { kind: "prompt", text: "--help me" })).toEqual(["herdr", "agent", "prompt", "w1:p1", "--", "--help me"]);
  });

  test("answers a blocking dialog with a literal choice or Escape", () => {
    expect(inputCommand(agent("blocked"), { kind: "choice", value: "1" })).toEqual(["herdr", "pane", "send-text", "w1:p1", "--", "1"]);
    expect(inputCommand(agent("blocked"), { kind: "key", key: "esc" })).toEqual(["herdr", "agent", "send-keys", "w1:p1", "esc"]);
  });

  test("refuses replies that do not match the agent's current state", () => {
    expect(() => inputCommand(agent("blocked"), { kind: "prompt", text: "hello" })).toThrow(/waiting at a dialog/);
    expect(() => inputCommand(agent("working"), { kind: "choice", value: "1" })).toThrow(/no longer waiting/);
  });
});
