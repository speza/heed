import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { FileChange } from "../src/types.ts";
import type { RuntimeAgent, RuntimeCapabilities, RuntimeChanges, RuntimeLocation, RuntimeSource } from "../src/runtime/types.ts";
import { RuntimeAdapterError } from "./runtime-gateway.ts";
import type { RuntimeAdapter, RuntimeAdapterSnapshot, RuntimeOutputRequest, RuntimeTerminalDimensions } from "./runtime-gateway.ts";
import { terminalGateway } from "./terminal.ts";

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
const MAX_CHANGED_FILES = 64;
const MAX_UNTRACKED_FILES = 40;
const MAX_UNTRACKED_FILE_BYTES = 256_000;
const MAX_SYNTAX_SOURCE_BYTES = 512_000;
const MAX_SYNTAX_SOURCE_CONCURRENCY = 4;

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

export interface GitChangeMetadata {
  readonly path: string;
  readonly status: string;
  readonly untracked?: boolean;
}

export function parseGitChangeMetadata(output: string): GitChangeMetadata[] {
  const fields = output.split("\0");
  const changes: GitChangeMetadata[] = [];
  for (let index = 0; index + 1 < fields.length;) {
    const rawStatus = fields[index++]!;
    const path = fields[index++]!;
    const status = rawStatus.split("\t", 1)[0] ?? rawStatus;
    if (status && path) changes.push({ status, path });
  }
  return changes;
}

function changeKind(status: string): FileChange["kind"] {
  return status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted" : "modified";
}

export function patchChange(metadata: GitChangeMetadata, patch: string): FileChange {
  const { path } = metadata;
  const lines = patch.split("\n");
  const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const binary = /^(Binary files|GIT binary patch)/mu.test(patch);
  const kind = changeKind(metadata.status);
  const fileHeader = patch.search(/^--- /mu);
  const renderablePatch = fileHeader >= 0 ? patch.slice(fileHeader) : patch;
  return {
    path,
    additions,
    deletions,
    kind,
    ...(binary ? { binary: true } : {}),
    hunks: renderablePatch ? [renderablePatch] : [],
  };
}

function syntaxSource(content: string): { readonly content: string } | undefined {
  return Buffer.byteLength(content) <= MAX_SYNTAX_SOURCE_BYTES && !content.includes("\0") ? { content } : undefined;
}

async function workingTreeSource(root: string, path: string): Promise<{ readonly content: string } | undefined> {
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return undefined;
  try {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) return undefined;
    if (!metadata.isFile() || metadata.size > MAX_SYNTAX_SOURCE_BYTES) return undefined;
    const [worktreeRoot, resolved] = await Promise.all([realpath(root), realpath(absolute)]);
    if (resolved !== worktreeRoot && !resolved.startsWith(`${worktreeRoot}${sep}`)) return undefined;
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

async function addSyntaxSourcesBounded(
  root: string,
  files: readonly ReturnType<typeof patchChange>[],
): Promise<readonly Awaited<ReturnType<typeof addSyntaxSources>>[]> {
  const results: Array<Awaited<ReturnType<typeof addSyntaxSources>> | undefined> = Array.from({ length: files.length });
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= files.length) return;
      results[index] = await addSyntaxSources(root, files[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_SYNTAX_SOURCE_CONCURRENCY, files.length) }, worker));
  return results as readonly Awaited<ReturnType<typeof addSyntaxSources>>[];
}

async function filePatch(root: string, metadata: GitChangeMetadata): Promise<CommandResult> {
  const args = metadata.untracked
    ? ["git", "-C", root, "diff", "--no-ext-diff", "--no-index", "--binary", "--", "/dev/null", metadata.path]
    : ["git", "-C", root, "diff", "--no-ext-diff", "--no-renames", "--binary", "HEAD", "--", metadata.path];
  return command(args, { allowExitOne: metadata.untracked });
}

export async function workspaceChangesAt(root: string): Promise<RuntimeChanges> {
  const trackedMetadata = await command(["git", "-C", root, "-c", "core.quotepath=false", "diff", "--name-status", "-z", "--no-renames", "HEAD", "--"]);
  if (trackedMetadata.exitCode !== 0 || trackedMetadata.truncated)
    throw new RuntimeAdapterError(502, trackedMetadata.truncated ? "The workspace change list is too large." : commandError(trackedMetadata, "Git status failed."));

  const untrackedResult = await command(["git", "-C", root, "ls-files", "--others", "--exclude-standard", "-z"]);
  if (untrackedResult.exitCode !== 0 || untrackedResult.truncated)
    throw new RuntimeAdapterError(502, untrackedResult.truncated ? "The untracked file list is too large." : commandError(untrackedResult, "Git status failed."));

  const tracked = parseGitChangeMetadata(trackedMetadata.stdout);
  const untracked = untrackedResult.stdout.split("\0").filter(Boolean).map((path): GitChangeMetadata => ({ path, status: "A", untracked: true }));
  const candidateMetadata = [...tracked, ...untracked.slice(0, MAX_UNTRACKED_FILES)];
  let partial = untracked.length > MAX_UNTRACKED_FILES || candidateMetadata.length > MAX_CHANGED_FILES;
  const metadata = candidateMetadata.slice(0, MAX_CHANGED_FILES);
  const parsedFiles: FileChange[] = [];
  for (const entry of metadata) {
    if (entry.untracked) {
      try {
        const file = await lstat(join(root, entry.path));
        if (!file.isSymbolicLink() && (!file.isFile() || file.size > MAX_UNTRACKED_FILE_BYTES)) {
          partial = true;
          continue;
        }
      } catch {
        partial = true;
        continue;
      }
    }
    const diff = await filePatch(root, entry);
    if ((diff.exitCode === 0 || diff.exitCode === 1) && !diff.truncated) parsedFiles.push(patchChange(entry, diff.stdout.trimEnd()));
    else partial = true;
  }
  const files = await addSyntaxSourcesBounded(root, parsedFiles);
  return {
    workspace: root,
    files,
    partial,
    ...(partial ? { message: "Some workspace changes were omitted." } : {}),
  };
}

async function workspaceChanges(agent: RuntimeAgent): Promise<RuntimeChanges> {
  const cwd = agent.location?.cwd;
  if (!cwd) throw new RuntimeAdapterError(404, "Herdr did not report a workspace for this agent.");
  const rootResult = await command(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  if (rootResult.exitCode !== 0) throw new RuntimeAdapterError(404, "The agent workspace is not a Git worktree.");
  return workspaceChangesAt(rootResult.stdout.trim());
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
