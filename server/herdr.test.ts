import { mkdtemp, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { workspaceChangesAt } from "./herdr";

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
