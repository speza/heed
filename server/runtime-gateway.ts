import type {
  RuntimeCapabilities,
  RuntimeChanges,
  RuntimeOutput,
  RuntimeSnapshot,
  RuntimeSource,
  RuntimeTerminalSession,
} from "../src/runtime/types.ts";

export interface RuntimeOutputRequest {
  readonly lines: number;
  readonly format: "ansi" | "text";
  readonly source: "visible" | "recent-unwrapped";
}

export interface RuntimeTerminalDimensions {
  readonly columns?: unknown;
  readonly rows?: unknown;
}

export type RuntimeAdapterSnapshot = Omit<RuntimeSnapshot, "sources" | "sourceHealth">;

/** Server-side implementation for one runtime source. */
export interface RuntimeAdapter {
  readonly source: RuntimeSource;
  snapshot(): Promise<RuntimeAdapterSnapshot>;
  readOutput?(id: string, request: RuntimeOutputRequest): Promise<RuntimeOutput>;
  readChanges?(id: string): Promise<RuntimeChanges>;
  openTerminal?(id: string, dimensions: RuntimeTerminalDimensions): Promise<RuntimeTerminalSession>;
  releaseTerminal?(sessionId: string): Promise<void>;
}

export class RuntimeAdapterError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface AdapterResult {
  readonly adapter: RuntimeAdapter;
  readonly snapshot: RuntimeAdapterSnapshot;
}

const UNAVAILABLE_CAPABILITIES: RuntimeCapabilities = {
  terminal: false,
  output: false,
  conversation: false,
  workspaceChanges: false,
  spawn: false,
  lineage: false,
};
const MAX_RUNTIME_REQUEST_BYTES = 64 * 1024;

export class RuntimeGateway {
  private readonly adapters: readonly RuntimeAdapter[];
  private readonly lastSuccessfulSnapshots = new Map<string, RuntimeAdapterSnapshot>();

  constructor(adapters: readonly RuntimeAdapter[]) {
    const sourceIds = new Set<string>();
    for (const adapter of adapters) {
      if (sourceIds.has(adapter.source.id)) throw new Error(`Duplicate runtime source: ${adapter.source.id}`);
      sourceIds.add(adapter.source.id);
    }
    this.adapters = adapters;
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    const results = await this.readAdapterSnapshots();
    const available = results.some(({ snapshot }) => snapshot.available);
    const successful = results.filter(({ snapshot }) => snapshot.available);
    const firstSuccessful = successful[0]?.snapshot;
    const errors = results
      .filter(({ snapshot }) => !snapshot.available && snapshot.error)
      .map(({ adapter, snapshot }) => `${adapter.source.label}: ${snapshot.error}`);
    const sourceHealth = results.map(({ adapter, snapshot }) => {
      if (snapshot.available) {
        this.lastSuccessfulSnapshots.set(adapter.source.id, snapshot);
        return {
          source: adapter.source,
          available: true,
          stale: false,
          fetchedAt: snapshot.fetchedAt,
        };
      }
      return {
        source: adapter.source,
        available: false,
        stale: this.lastSuccessfulSnapshots.has(adapter.source.id),
        fetchedAt: snapshot.fetchedAt,
        ...(snapshot.error ? { error: snapshot.error } : {}),
      };
    });
    const agents = results.flatMap(({ adapter, snapshot }) => {
      if (snapshot.available) {
        return snapshot.agents.map((agent) => ({ ...agent, sourceAvailable: true, sourceStale: false }));
      }
      const stale = this.lastSuccessfulSnapshots.get(adapter.source.id);
      return stale?.agents.map((agent) => ({
        ...agent,
        sourceAvailable: false,
        sourceStale: true,
        capabilities: UNAVAILABLE_CAPABILITIES,
      })) ?? [];
    });
    return {
      available,
      ...(firstSuccessful?.version ? { version: firstSuccessful.version } : {}),
      ...(firstSuccessful?.protocol !== undefined ? { protocol: firstSuccessful.protocol } : {}),
      fetchedAt: Math.max(...results.map(({ snapshot }) => snapshot.fetchedAt), Date.now()),
      sources: this.adapters.map(({ source }) => source),
      sourceHealth,
      agents,
      ...(errors.length > 0 ? { error: errors.join(" · ") } : {}),
    };
  }

  async readOutput(id: string, request: RuntimeOutputRequest): Promise<RuntimeOutput> {
    const adapter = await this.resolve(id);
    if (!adapter.readOutput) throw new RuntimeAdapterError(409, `${adapter.source.label} does not expose runtime output.`);
    return adapter.readOutput(id, request);
  }

  async readChanges(id: string): Promise<RuntimeChanges> {
    const adapter = await this.resolve(id);
    if (!adapter.readChanges) throw new RuntimeAdapterError(409, `${adapter.source.label} does not expose workspace changes.`);
    return adapter.readChanges(id);
  }

  async openTerminal(id: string, dimensions: RuntimeTerminalDimensions): Promise<RuntimeTerminalSession> {
    const adapter = await this.resolve(id);
    if (!adapter.openTerminal) throw new RuntimeAdapterError(409, `${adapter.source.label} does not expose an interactive terminal.`);
    return adapter.openTerminal(id, dimensions);
  }

  async releaseTerminal(sessionId: string): Promise<void> {
    await Promise.all(this.adapters.map((adapter) => adapter.releaseTerminal?.(sessionId)));
  }

  private async readAdapterSnapshots(): Promise<readonly AdapterResult[]> {
    return Promise.all(this.adapters.map(async (adapter): Promise<AdapterResult> => {
      try {
        return { adapter, snapshot: await adapter.snapshot() };
      } catch (error) {
        return {
          adapter,
          snapshot: {
            available: false,
            fetchedAt: Date.now(),
            agents: [],
            error: error instanceof Error ? error.message : "Runtime is unavailable.",
          },
        };
      }
    }));
  }

  private async resolve(id: string): Promise<RuntimeAdapter> {
    const namespaced = this.adapters.find(({ source }) => id.startsWith(`${source.id}:`));
    if (namespaced) return namespaced;
    const results = await this.readAdapterSnapshots();
    for (const { adapter, snapshot } of results) {
      if (!snapshot.available) continue;
      const agent = snapshot.agents.find((candidate) => candidate.id === id);
      if (agent) return adapter;
    }
    throw new RuntimeAdapterError(404, "That Agent is no longer available.");
  }
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Heed only serves loopback clients. Checking the Host header (not just Origin)
 * defeats DNS rebinding, where a hostile page's Origin and Host both name the
 * attacker's domain while the connection lands on 127.0.0.1.
 */
export function isTrustedLocalRequest(url: URL, origin: string | null | undefined): boolean {
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return false;
  return !origin || origin === url.origin;
}

function agentId(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new RuntimeAdapterError(400, "Agent id is not valid URL encoding.");
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

async function boundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RUNTIME_REQUEST_BYTES)
    throw new RuntimeAdapterError(413, "Runtime request body is too large.");
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_RUNTIME_REQUEST_BYTES) throw new RuntimeAdapterError(413, "Runtime request body is too large.");
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new RuntimeAdapterError(400, "Runtime request body is invalid JSON.");
  }
}

export async function handleRuntimeRequest(request: Request, gateway: RuntimeGateway): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/runtime" && !url.pathname.startsWith("/api/runtime/")) return undefined;
  try {
    if (!isTrustedLocalRequest(url, request.headers.get("origin"))) throw new RuntimeAdapterError(403, "Request origin rejected.");
    if (request.method === "GET" && url.pathname === "/api/runtime") return json(await gateway.snapshot());

    const terminalRelease = /^\/api\/runtime\/terminal\/([0-9a-f-]{36})$/u.exec(url.pathname);
    if (request.method === "DELETE" && terminalRelease?.[1]) {
      await gateway.releaseTerminal(terminalRelease[1]);
      return json({ ok: true, message: "Terminal session released." });
    }

    const terminalOpen = /^\/api\/runtime\/agents\/([^/]+)\/terminal$/u.exec(url.pathname);
    if (request.method === "POST" && terminalOpen?.[1]) {
      const payload = (await boundedJson(request)) as RuntimeTerminalDimensions;
      try {
        return json(await gateway.openTerminal(agentId(terminalOpen[1]), payload));
      } catch (error) {
        if (error instanceof RuntimeAdapterError) throw error;
        throw new RuntimeAdapterError(409, error instanceof Error ? error.message : "Terminal session could not be opened.");
      }
    }

    const match = /^\/api\/runtime\/agents\/([^/]+)\/(output|changes)$/u.exec(url.pathname);
    if (!match) throw new RuntimeAdapterError(404, "Runtime endpoint not found.");
    const id = agentId(match[1]!);
    const action = match[2]!;

    if (request.method === "GET" && action === "output") {
      const requestedLines = Number(url.searchParams.get("lines") ?? "200");
      const lines = Number.isInteger(requestedLines) ? Math.min(400, Math.max(20, requestedLines)) : 200;
      const format = url.searchParams.get("format") === "ansi" ? "ansi" : "text";
      const source = url.searchParams.get("source") === "visible" ? "visible" : "recent-unwrapped";
      return json(await gateway.readOutput(id, { lines, format, source }));
    }
    if (request.method === "GET" && action === "changes") return json(await gateway.readChanges(id));
    throw new RuntimeAdapterError(405, "Method not allowed.");
  } catch (error) {
    if (error instanceof RuntimeAdapterError) return json({ error: error.message }, error.status);
    return json({ error: "The Heed runtime gateway failed unexpectedly." }, 500);
  }
}
