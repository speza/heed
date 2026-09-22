import { spawn } from "node:child_process";
import type { RuntimeAgent, RuntimeCapabilities, RuntimeStatus, RuntimeSource } from "../src/runtime/types.ts";
import { RuntimeAdapterError } from "./runtime-gateway.ts";
import type { RuntimeAdapter, RuntimeAdapterSnapshot, RuntimeOutputRequest } from "./runtime-gateway.ts";

const COMMAND_TIMEOUT_MS = 10_000;
const TOP_TIMEOUT_MS = 4_000;
const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
const DEFAULT_THREAD_LIMIT = 40;
const MAX_THREAD_LIMIT = 100;
const SNAPSHOT_CACHE_MS = 1_500;

const AMP_SOURCE = { id: "amp-local", kind: "amp", label: "Amp Code" } as const satisfies RuntimeSource;
const AMP_CAPABILITIES = {
  terminal: false,
  output: true,
  conversation: false,
  workspaceChanges: false,
  spawn: false,
  lineage: false,
} as const satisfies RuntimeCapabilities;

export interface AmpCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface AmpThreadSummary {
  readonly id: string;
  readonly title?: string;
  readonly updated?: string;
  readonly messageCount: number;
  readonly state?: string;
}

export interface AmpRuntimeAdapterOptions {
  readonly command?: string;
  readonly threadLimit?: number;
  readonly cacheMs?: number;
  readonly run?: (argv: readonly string[]) => Promise<AmpCommandResult>;
  /** Override the live activity probe in tests or alternate CLI environments. */
  readonly runTop?: (argv: readonly string[]) => Promise<AmpCommandResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundedText(value: string, maximum = 240): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function commandError(result: AmpCommandResult, fallback: string): string {
  const output = boundedText(result.stderr || result.stdout);
  return output || fallback;
}

function command(argv: readonly string[]): Promise<AmpCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    const finish = (result: AmpCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
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
    child.on("error", (error) => finish({ exitCode: 127, stdout: "", stderr: error.message, truncated: false }));
    child.on("close", (code) => finish({
      exitCode: timedOut ? 124 : (code ?? 1),
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      truncated: stdoutBytes > MAX_COMMAND_BYTES || stderrBytes > MAX_COMMAND_BYTES,
    }));
  });
}

function firstJsonLine(argv: readonly string[]): Promise<AmpCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let buffered = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: AmpCommandResult, terminate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminate) child.kill("SIGTERM");
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < MAX_COMMAND_BYTES) stdout.push(chunk.subarray(0, MAX_COMMAND_BYTES - stdoutBytes));
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_COMMAND_BYTES) {
        finish({ exitCode: 413, stdout: Buffer.concat(stdout).toString("utf8"), stderr: "", truncated: true }, true);
        return;
      }
      buffered += chunk.toString("utf8");
      const lines = buffered.split(/\r?\n/gu);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          JSON.parse(line);
          finish({ exitCode: 0, stdout: line, stderr: Buffer.concat(stderr).toString("utf8"), truncated: false }, true);
          return;
        } catch {
          // Amp may write startup noise before the experimental JSON snapshot.
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < MAX_COMMAND_BYTES) stderr.push(chunk.subarray(0, MAX_COMMAND_BYTES - stderrBytes));
      stderrBytes += chunk.byteLength;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TOP_TIMEOUT_MS);
    child.on("error", (error) => finish({ exitCode: 127, stdout: "", stderr: error.message, truncated: false }));
    child.on("close", (code) => finish({
      exitCode: timedOut ? 124 : (code ?? 1),
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      truncated: stdoutBytes > MAX_COMMAND_BYTES || stderrBytes > MAX_COMMAND_BYTES,
    }));
  });
}

function configuredThreadLimit(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value)) return DEFAULT_THREAD_LIMIT;
  return Math.min(MAX_THREAD_LIMIT, Math.max(1, value));
}

function threadRows(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.threads)) return payload.threads;
  throw new Error("Amp returned an invalid thread list.");
}

function activityRows(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    for (const key of ["threads", "items", "activeThreads"]) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
}

function activityThreadId(row: Record<string, unknown>): string | undefined {
  for (const key of ["id", "threadId", "threadID"]) {
    if (typeof row[key] === "string" && row[key].trim() !== "") return row[key];
  }
  if (isRecord(row.thread)) {
    for (const key of ["id", "threadId", "threadID"]) {
      if (typeof row.thread[key] === "string" && row.thread[key].trim() !== "") return row.thread[key];
    }
  }
  return undefined;
}

function activityState(row: Record<string, unknown>): string {
  for (const key of ["state", "status", "agentState", "lastKnownAgentState"]) {
    if (typeof row[key] === "string" && row[key].trim() !== "") return row[key].trim();
    if (isRecord(row[key])) {
      for (const nestedKey of ["state", "status", "name"]) {
        if (typeof row[key][nestedKey] === "string" && row[key][nestedKey].trim() !== "") return row[key][nestedKey].trim();
      }
    }
  }
  return "running";
}

/** Parse the experimental first snapshot emitted by `amp top --stream-jsonl`. */
export function parseAmpTop(raw: string): ReadonlyMap<string, string> {
  const payload = JSON.parse(raw) as unknown;
  const states = new Map<string, string>();
  for (const value of activityRows(payload)) {
    if (!isRecord(value)) continue;
    const id = activityThreadId(value);
    if (id) states.set(id, activityState(value));
  }
  return states;
}

/** Parse the stable summary emitted by `amp threads list --json`. */
export function parseAmpThreadList(raw: string): readonly AmpThreadSummary[] {
  const rows = threadRows(JSON.parse(raw) as unknown);
  return rows.flatMap((row): AmpThreadSummary[] => {
    if (!isRecord(row) || typeof row.id !== "string" || row.id.trim() === "") return [];
    const title = typeof row.title === "string" ? boundedText(row.title, 160) : undefined;
    const updated = typeof row.updated === "string" ? row.updated : undefined;
    const messageCount = typeof row.messageCount === "number" && Number.isSafeInteger(row.messageCount) && row.messageCount >= 0
      ? row.messageCount
      : 0;
    const state = typeof row.state === "string"
      ? row.state
      : typeof row.status === "string"
        ? row.status
        : undefined;
    return [{
      id: row.id,
      ...(title ? { title } : {}),
      ...(updated ? { updated } : {}),
      messageCount,
      ...(state ? { state } : {}),
    }];
  });
}

/** Map Amp's thread state vocabulary onto Heed's runtime-neutral states. */
export function ampRuntimeStatus(state: string | undefined): RuntimeStatus {
  switch (state) {
    case "running":
      return "working";
    case "awaiting-approval":
      return "blocked";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

export function ampThreadAgent(thread: AmpThreadSummary): RuntimeAgent {
  const fallbackName = `Amp thread ${thread.id.slice(-8)}`;
  return {
    id: `${AMP_SOURCE.id}:${thread.id}`,
    source: AMP_SOURCE,
    name: thread.title || fallbackName,
    kind: "thread",
    provider: "Amp Code",
    openIn: { label: "Open in Amp", url: `https://ampcode.com/threads/${encodeURIComponent(thread.id)}` },
    ...(thread.state ? { status: ampRuntimeStatus(thread.state) } : { status: "idle" }),
    focused: false,
    revision: thread.messageCount,
    capabilities: AMP_CAPABILITIES,
  };
}

function tailLines(text: string, lines: number): { readonly text: string; readonly truncated: boolean } {
  const normalized = text.replace(/\r\n/gu, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const allLines = trailingNewline ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
  const start = Math.max(0, allLines.length - Math.max(1, lines));
  return {
    text: `${allLines.slice(start).join("\n")}${trailingNewline ? "\n" : ""}`,
    truncated: start > 0,
  };
}

export class AmpRuntimeAdapter implements RuntimeAdapter {
  readonly source = AMP_SOURCE;
  private readonly commandName: string;
  private readonly threadLimit: number;
  private readonly cacheMs: number;
  private readonly run: (argv: readonly string[]) => Promise<AmpCommandResult>;
  private readonly runTop: (argv: readonly string[]) => Promise<AmpCommandResult>;
  private cached?: { readonly fetchedAt: number; readonly snapshot: RuntimeAdapterSnapshot };

  constructor(options: AmpRuntimeAdapterOptions = {}) {
    this.commandName = options.command ?? process.env.HEED_AMP_BIN ?? "amp";
    this.threadLimit = configuredThreadLimit(options.threadLimit ?? envThreadLimit());
    this.cacheMs = options.cacheMs ?? SNAPSHOT_CACHE_MS;
    this.run = options.run ?? command;
    this.runTop = options.runTop ?? (options.run ?? firstJsonLine);
  }

  async snapshot(): Promise<RuntimeAdapterSnapshot> {
    const now = Date.now();
    if (this.cached && now - this.cached.fetchedAt < this.cacheMs) return this.cached.snapshot;

    const [result, liveStates] = await Promise.all([
      this.run([
        this.commandName,
        "threads",
        "list",
        "--json",
        "--limit",
        String(this.threadLimit),
      ]),
      this.liveStates(),
    ]);
    const fetchedAt = Date.now();
    if (result.exitCode !== 0 || result.truncated) {
      const snapshot: RuntimeAdapterSnapshot = {
        available: false,
        fetchedAt,
        agents: [],
        error: result.truncated ? "Amp returned more data than Heed can safely read." : commandError(result, "Amp Code is unavailable."),
      };
      this.cached = { fetchedAt, snapshot };
      return snapshot;
    }

    try {
      const threads = parseAmpThreadList(result.stdout);
      const agents = threads.map((thread) => ampThreadAgent({
        ...thread,
        ...(liveStates.has(thread.id) ? { state: liveStates.get(thread.id) } : {}),
      }));
      const snapshot: RuntimeAdapterSnapshot = { available: true, fetchedAt: Date.now(), agents };
      this.cached = { fetchedAt, snapshot };
      return snapshot;
    } catch {
      const snapshot: RuntimeAdapterSnapshot = { available: false, fetchedAt, agents: [], error: "Amp returned an invalid thread list." };
      this.cached = { fetchedAt, snapshot };
      return snapshot;
    }
  }

  private async liveStates(): Promise<ReadonlyMap<string, string>> {
    try {
      const result = await this.runTop([this.commandName, "top", "--stream-jsonl"]);
      if (result.exitCode !== 0 || result.truncated) return new Map();
      return parseAmpTop(result.stdout);
    } catch {
      // Activity is an enhancement; a healthy history list remains usable when
      // the experimental live probe is unavailable on an older Amp CLI.
      return new Map();
    }
  }

  async readOutput(id: string, request: RuntimeOutputRequest) {
    const threadId = await this.targetThread(id);
    const result = await this.run([this.commandName, "threads", "markdown", threadId]);
    if (result.exitCode !== 0 || result.truncated) {
      throw new RuntimeAdapterError(
        502,
        result.truncated ? "The Amp thread is too large for Heed to read." : commandError(result, "Amp thread output could not be read."),
      );
    }
    const bounded = tailLines(result.stdout, request.lines);
    return {
      text: bounded.text,
      format: "text" as const,
      revision: this.cached?.snapshot.agents.find((agent) => agent.id === id)?.revision,
      truncated: bounded.truncated,
    };
  }

  private async targetThread(id: string): Promise<string> {
    const prefix = `${AMP_SOURCE.id}:`;
    if (!id.startsWith(prefix)) throw new RuntimeAdapterError(404, "That Amp thread is not available.");
    const threadId = id.slice(prefix.length);
    const snapshot = await this.snapshot();
    if (!snapshot.available) throw new RuntimeAdapterError(503, snapshot.error ?? "Amp Code is unavailable.");
    if (!snapshot.agents.some((agent) => agent.id === id)) throw new RuntimeAdapterError(404, "That Amp thread is no longer available.");
    return threadId;
  }
}

function envThreadLimit(): number | undefined {
  const value = Number(process.env.HEED_AMP_THREAD_LIMIT ?? "");
  return Number.isSafeInteger(value) ? value : undefined;
}
