import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { FileChange } from "../src/types.ts";
import type { RuntimeAgent, RuntimeCapabilities, RuntimeChanges, RuntimeLocation, RuntimeSource } from "../src/runtime/types.ts";
import { RuntimeAdapterError } from "./runtime-gateway.ts";
import type { RuntimeAdapter, RuntimeAdapterSnapshot, RuntimeOutputRequest, RuntimeTerminalDimensions } from "./runtime-gateway.ts";
import { terminalGateway } from "./terminal.ts";

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 40;
const MAX_UNTRACKED_FILE_BYTES = 256_000;
const MAX_SYNTAX_SOURCE_BYTES = 512_000;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

interface HerdrAgentRecord {
  readonly pane_id?: string;
  readonly name?: string;
  readonly title?: string;
  readonly terminal_title_stripped?: string;
  readonly display_agent?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly workspace_id?: string;
  readonly tab_id?: string;
  readonly cwd?: string;
  readonly foreground_cwd?: string;
  readonly focused?: boolean;
  readonly revision?: number;
  readonly state_change_seq?: number;
  readonly interactive_ready?: boolean;
}

interface HerdrWorkspaceRecord {
  readonly workspace_id?: string;
  readonly label?: string;
  readonly worktree?: { readonly checkout_path?: string };
}

interface HerdrSnapshotEnvelope {
  readonly result?: {
    readonly snapshot?: {
      readonly version?: string;
      readonly protocol?: number;
      readonly agents?: readonly HerdrAgentRecord[];
      readonly workspaces?: readonly HerdrWorkspaceRecord[];
    };
  };
}

const HERDR_SOURCE = { id: "herdr-local", kind: "herdr", label: "Herdr" } as const satisfies RuntimeSource;
const HERDR_CAPABILITIES = {
  terminal: true,
  output: true,
  conversation: false,
  workspaceChanges: true,
  spawn: false,
  lineage: false,
} as const satisfies RuntimeCapabilities;

interface NormalizedAgent extends RuntimeAgent {
  readonly source: typeof HERDR_SOURCE;
  readonly capabilities: typeof HERDR_CAPABILITIES;
  readonly location: RuntimeLocation & { readonly workspaceId: string; readonly tabId: string };
}

type NormalizedSnapshot = Omit<RuntimeAdapterSnapshot, "agents"> & { readonly agents: readonly NormalizedAgent[] };

function boundedText(value: string, maximum = 240): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maximum);
}

async function command(argv: readonly string[], _options?: { readonly allowExitOne?: boolean }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < MAX_COMMAND_BYTES) stdout.push(chunk.subarray(0, MAX_COMMAND_BYTES - stdoutBytes));
      stdoutBytes += chunk.byteLength;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < MAX_COMMAND_BYTES) stderr.push(chunk.subarray(0, MAX_COMMAND_BYTES - stderrBytes));
      stderrBytes += chunk.byteLength;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout: "", stderr: error.message, truncated: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated: stdoutBytes > MAX_COMMAND_BYTES || stderrBytes > MAX_COMMAND_BYTES,
      });
    });
  });
}

function commandError(result: CommandResult, fallback: string): string {
  try {
    const payload = JSON.parse(result.stderr || result.stdout) as { error?: { message?: string; code?: string } };
    return boundedText(payload.error?.message ?? payload.error?.code ?? fallback);
  } catch {
    return boundedText(result.stderr || fallback);
  }
}

function status(value: string | undefined): NormalizedAgent["status"] {
  return value === "working" || value === "idle" || value === "blocked" || value === "done"
    ? value
    : "unknown";
}

async function readSnapshot(): Promise<NormalizedSnapshot> {
  const fetchedAt = Date.now();
  const result = await command(["herdr", "api", "snapshot"]);
  if (result.exitCode !== 0 || result.truncated) {
    return {
      available: false,
      fetchedAt,
      agents: [],
      error: result.truncated
        ? "Herdr returned more data than Heed can safely read."
        : commandError(result, "Herdr is unavailable."),
    };
  }
  try {
    const envelope = JSON.parse(result.stdout) as HerdrSnapshotEnvelope;
    const snapshot = envelope.result?.snapshot;
    if (!snapshot || !Array.isArray(snapshot.agents)) throw new Error("Agent inventory missing.");
    const workspaces = new Map(
      (snapshot.workspaces ?? [])
        .filter((workspace): workspace is HerdrWorkspaceRecord & { workspace_id: string } => Boolean(workspace.workspace_id))
        .map((workspace) => [workspace.workspace_id, workspace]),
    );
    const priority: Readonly<Record<string, number>> = { blocked: 0, done: 1, working: 2, unknown: 3, idle: 4 };
    const orderedAgents = snapshot.agents
      .map((agent, index) => ({ agent, index }))
      .sort((left, right) =>
        (priority[left.agent.agent_status ?? "unknown"] ?? 3) - (priority[right.agent.agent_status ?? "unknown"] ?? 3) ||
        (right.agent.state_change_seq ?? 0) - (left.agent.state_change_seq ?? 0) ||
        left.index - right.index,
      )
      .map(({ agent }) => agent);
    const agents = orderedAgents.flatMap((agent): NormalizedAgent[] => {
      if (!agent.pane_id || !agent.workspace_id || !agent.tab_id || !agent.agent) return [];
      const workspace = workspaces.get(agent.workspace_id);
      const cwd = workspace?.worktree?.checkout_path ?? agent.foreground_cwd ?? agent.cwd;
      return [{
        id: `${HERDR_SOURCE.id}:${agent.pane_id}`,
        source: HERDR_SOURCE,
        name: agent.name ?? agent.title ?? agent.terminal_title_stripped ?? `${agent.agent} · ${agent.pane_id}`,
        kind: agent.display_agent ?? agent.agent,
        status: status(agent.agent_status),
        location: {
          workspaceId: agent.workspace_id,
          ...(workspace?.label ? { workspaceLabel: workspace.label } : {}),
          tabId: agent.tab_id,
          paneId: agent.pane_id,
          ...(cwd ? { cwd } : {}),
        },
        ...(agent.terminal_title_stripped ? { terminalTitle: agent.terminal_title_stripped } : {}),
        focused: agent.focused === true,
        revision: agent.revision ?? 0,
        interactiveReady: agent.interactive_ready !== false,
        capabilities: HERDR_CAPABILITIES,
      }];
    });
    return {
      available: true,
      ...(snapshot.version ? { version: snapshot.version } : {}),
      ...(snapshot.protocol !== undefined ? { protocol: snapshot.protocol } : {}),
      fetchedAt,
      agents,
    };
  } catch {
    return { available: false, fetchedAt, agents: [], error: "Herdr returned an invalid snapshot." };
  }
}

function splitPatch(patch: string): string[] {
  const starts: number[] = [];
  const pattern = /^diff --git /gmu;
  for (let match = pattern.exec(patch); match; match = pattern.exec(patch)) starts.push(match.index);
  return starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length).trimEnd());
}

function patchPath(patch: string): string | undefined {
  const added = /^\+\+\+ b\/(.+)$/mu.exec(patch)?.[1];
  if (added) return added;
  const deleted = /^--- a\/(.+)$/mu.exec(patch)?.[1];
  return deleted;
}

function patchChange(patch: string): FileChange | undefined {
  const path = patchPath(patch);
  if (!path) return undefined;
  const lines = patch.split("\n");
  const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const binary = /^(Binary files|GIT binary patch)/mu.test(patch);
  const kind: FileChange["kind"] = /^--- \/dev\/null$/mu.test(patch)
    ? "added"
    : /^\+\+\+ \/dev\/null$/mu.test(patch)
      ? "deleted"
      : "modified";
  const fileHeader = patch.search(/^--- /mu);
  const renderablePatch = fileHeader >= 0 ? patch.slice(fileHeader) : patch;
  return { path, additions, deletions, kind, ...(binary ? { binary: true } : {}), hunks: [renderablePatch] };
}

function syntaxSource(content: string): { readonly content: string } | undefined {
  return Buffer.byteLength(content) <= MAX_SYNTAX_SOURCE_BYTES && !content.includes("\0") ? { content } : undefined;
}

async function workingTreeSource(root: string, path: string): Promise<{ readonly content: string } | undefined> {
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return undefined;
  try {
    const metadata = await stat(absolute);
    if (!metadata.isFile() || metadata.size > MAX_SYNTAX_SOURCE_BYTES) return undefined;
    return syntaxSource(await readFile(absolute, "utf8"));
  } catch {
    return undefined;
  }
}

async function headSource(root: string, path: string): Promise<{ readonly content: string } | undefined> {
  const result = await command(["git", "-C", root, "show", `HEAD:${path}`]);
  if (result.exitCode !== 0 || result.truncated) return undefined;
  return syntaxSource(result.stdout);
}

async function addSyntaxSources(root: string, file: NonNullable<ReturnType<typeof patchChange>>) {
  if (file.binary) return file;
  const [oldFile, newFile] = await Promise.all([
    file.kind === "added" ? undefined : headSource(root, file.path),
    file.kind === "deleted" ? undefined : workingTreeSource(root, file.path),
  ]);
  return { ...file, ...(oldFile ? { oldFile } : {}), ...(newFile ? { newFile } : {}) };
}

async function workspaceChanges(agent: RuntimeAgent): Promise<RuntimeChanges> {
  const cwd = agent.location?.cwd;
  if (!cwd) throw new RuntimeAdapterError(404, "Herdr did not report a workspace for this agent.");
  const rootResult = await command(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  if (rootResult.exitCode !== 0) throw new RuntimeAdapterError(404, "The agent workspace is not a Git worktree.");
  const root = rootResult.stdout.trim();
  const tracked = await command(["git", "-C", root, "diff", "--no-ext-diff", "--no-renames", "--binary", "HEAD", "--"]);
  if (tracked.exitCode !== 0 || tracked.truncated)
    throw new RuntimeAdapterError(502, tracked.truncated ? "The workspace diff is too large." : commandError(tracked, "Git diff failed."));

  const untrackedResult = await command(["git", "-C", root, "ls-files", "--others", "--exclude-standard", "-z"]);
  if (untrackedResult.exitCode !== 0) throw new RuntimeAdapterError(502, commandError(untrackedResult, "Git status failed."));
  const untracked = untrackedResult.stdout.split("\0").filter(Boolean);
  const patches = splitPatch(tracked.stdout);
  let partial = untracked.length > MAX_UNTRACKED_FILES;
  for (const relativePath of untracked.slice(0, MAX_UNTRACKED_FILES)) {
    try {
      const metadata = await stat(join(root, relativePath));
      if (!metadata.isFile() || metadata.size > MAX_UNTRACKED_FILE_BYTES) {
        partial = true;
        continue;
      }
    } catch {
      partial = true;
      continue;
    }
    const diff = await command(["git", "-C", root, "diff", "--no-ext-diff", "--no-index", "--binary", "--", "/dev/null", relativePath], { allowExitOne: true });
    if ((diff.exitCode === 0 || diff.exitCode === 1) && !diff.truncated && diff.stdout) patches.push(diff.stdout.trimEnd());
    else partial = true;
  }
  const parsedFiles = patches.map(patchChange).filter((file): file is NonNullable<typeof file> => file !== undefined);
  const files = await Promise.all(parsedFiles.map((file) => addSyntaxSources(root, file)));
  return {
    workspace: root,
    files,
    partial,
    ...(partial ? { message: "Some untracked or oversized files were omitted." } : {}),
  };
}

export class HerdrRuntimeAdapter implements RuntimeAdapter {
  readonly source = HERDR_SOURCE;

  async snapshot(): Promise<RuntimeAdapterSnapshot> {
    return readSnapshot();
  }

  async readOutput(id: string, request: RuntimeOutputRequest) {
    const agent = await this.targetAgent(id);
    const paneId = agent.location?.paneId;
    if (!paneId) throw new RuntimeAdapterError(404, "Herdr did not report a pane for this agent.");
    const result = await command([
      "herdr", "agent", "read", paneId,
      "--source", request.source,
      "--lines", String(request.lines),
      "--format", request.format,
    ]);
    if (result.exitCode !== 0) throw new RuntimeAdapterError(502, commandError(result, "Herdr output could not be read."));
    return { text: result.stdout, format: request.format, revision: agent.revision, truncated: result.truncated };
  }

  async readChanges(id: string): Promise<RuntimeChanges> {
    return workspaceChanges(await this.targetAgent(id));
  }

  async markViewed(id: string): Promise<void> {
    const agent = await this.targetAgent(id);
    const paneId = agent.location?.paneId;
    if (!paneId) throw new RuntimeAdapterError(404, "Herdr did not report a pane for this agent.");
    const result = await command(["herdr", "agent", "focus", paneId]);
    if (result.exitCode !== 0) throw new RuntimeAdapterError(502, commandError(result, "Herdr could not mark the agent viewed."));
  }

  async openTerminal(id: string, dimensions: RuntimeTerminalDimensions) {
    const agent = await this.targetAgent(id);
    const paneId = agent.location?.paneId;
    if (!paneId) throw new RuntimeAdapterError(404, "Herdr did not report a pane for this agent.");
    try {
      return await terminalGateway.open(paneId, dimensions);
    } catch (error) {
      throw new RuntimeAdapterError(409, error instanceof Error ? error.message : "Terminal session could not be opened.");
    }
  }

  async releaseTerminal(sessionId: string): Promise<void> {
    await terminalGateway.release(sessionId);
  }

  private async targetAgent(id: string): Promise<RuntimeAgent> {
    const snapshot = await readSnapshot();
    if (!snapshot.available) throw new RuntimeAdapterError(503, snapshot.error ?? "Herdr is unavailable.");
    const agent = snapshot.agents.find((candidate) => candidate.id === id);
    if (!agent) throw new RuntimeAdapterError(404, "That Herdr agent is no longer available.");
    return agent;
  }
}
