import type {
  RuntimeAgent,
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

export type RuntimeAdapterSnapshot = Omit<RuntimeSnapshot, "sources">;

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

export class RuntimeGateway {
  private readonly adapters: readonly RuntimeAdapter[];

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
    return {
      available,
      ...(firstSuccessful?.version ? { version: firstSuccessful.version } : {}),
      ...(firstSuccessful?.protocol !== undefined ? { protocol: firstSuccessful.protocol } : {}),
      fetchedAt: Math.max(...results.map(({ snapshot }) => snapshot.fetchedAt), Date.now()),
      sources: this.adapters.map(({ source }) => source),
      agents: successful.flatMap(({ snapshot }) => snapshot.agents),
      ...(!available && errors.length > 0 ? { error: errors.join(" · ") } : {}),
    };
  }

  async readOutput(id: string, request: RuntimeOutputRequest): Promise<RuntimeOutput> {
    const { adapter } = await this.resolve(id);
    if (!adapter.readOutput) throw new RuntimeAdapterError(409, `${adapter.source.label} does not expose runtime output.`);
    return adapter.readOutput(id, request);
  }

  async readChanges(id: string): Promise<RuntimeChanges> {
    const { adapter } = await this.resolve(id);
    if (!adapter.readChanges) throw new RuntimeAdapterError(409, `${adapter.source.label} does not expose workspace changes.`);
    return adapter.readChanges(id);
  }

  async openTerminal(id: string, dimensions: RuntimeTerminalDimensions): Promise<RuntimeTerminalSession> {
    const { adapter } = await this.resolve(id);
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

  private async resolve(id: string): Promise<{ readonly adapter: RuntimeAdapter; readonly agent: RuntimeAgent }> {
    const results = await this.readAdapterSnapshots();
    for (const { adapter, snapshot } of results) {
      if (!snapshot.available) continue;
      const agent = snapshot.agents.find((candidate) => candidate.id === id);
      if (agent) return { adapter, agent };
    }
    throw new RuntimeAdapterError(404, "That Agent is no longer available.");
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

export async function handleRuntimeRequest(request: Request, gateway: RuntimeGateway): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/runtime" && !url.pathname.startsWith("/api/runtime/")) return undefined;
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) throw new RuntimeAdapterError(403, "Request origin rejected.");
    if (request.method === "GET" && url.pathname === "/api/runtime") return json(await gateway.snapshot());

    const terminalRelease = /^\/api\/runtime\/terminal\/([0-9a-f-]{36})$/u.exec(url.pathname);
    if (request.method === "DELETE" && terminalRelease?.[1]) {
      await gateway.releaseTerminal(terminalRelease[1]);
      return json({ ok: true, message: "Terminal session released." });
    }

    const terminalOpen = /^\/api\/runtime\/agents\/([^/]+)\/terminal$/u.exec(url.pathname);
    if (request.method === "POST" && terminalOpen?.[1]) {
      const payload = (await request.json()) as RuntimeTerminalDimensions;
      try {
        return json(await gateway.openTerminal(decodeURIComponent(terminalOpen[1]), payload));
      } catch (error) {
        if (error instanceof RuntimeAdapterError) throw error;
        throw new RuntimeAdapterError(409, error instanceof Error ? error.message : "Terminal session could not be opened.");
      }
    }

    const match = /^\/api\/runtime\/agents\/([^/]+)\/(output|changes)$/u.exec(url.pathname);
    if (!match) throw new RuntimeAdapterError(404, "Runtime endpoint not found.");
    const id = decodeURIComponent(match[1]!);
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
