import { spawn } from "node:child_process";

type TerminalListener = (message: TerminalServerMessage) => void;

export type TerminalServerMessage =
  | {
      readonly kind: "frame";
      readonly deliveryId: number;
      readonly bytes: string;
      readonly columns?: number;
      readonly rows?: number;
      readonly sequence?: number;
      readonly full?: boolean;
    }
  | { readonly kind: "closed"; readonly deliveryId?: number; readonly reason?: string }
  | { readonly kind: "error"; readonly message: string };

type PendingTerminalMessage =
  | Omit<Extract<TerminalServerMessage, { readonly kind: "frame" }>, "deliveryId">
  | Omit<Extract<TerminalServerMessage, { readonly kind: "closed" }>, "deliveryId">
  | Extract<TerminalServerMessage, { readonly kind: "error" }>;

export interface TerminalProcess {
  readonly stdin: { write(value: string | Uint8Array): number | Promise<number> };
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

export type TerminalProcessFactory = (
  paneId: string,
  dimensions: { readonly columns: number; readonly rows: number },
) => TerminalProcess;

interface TerminalSession {
  readonly id: string;
  readonly process: TerminalProcess;
  readonly listeners: Set<TerminalListener>;
  readonly replay: TerminalServerMessage[];
  nextDeliveryId: number;
  replayBytes: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
  releasePromise?: Promise<void>;
  closed: boolean;
  processExited: boolean;
  stderr: string;
}

const MAX_SESSIONS = 16;
const MAX_REPLAY_MESSAGES = 128;
const MAX_REPLAY_BYTES = 512 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_FRAME_TEXT_BYTES = 512 * 1024;
const RECONNECT_GRACE_MS = 15_000;
const MIN_COLUMNS = 20;
const MAX_COLUMNS = 400;
const MIN_ROWS = 8;
const MAX_ROWS = 240;

function dimension(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function boundedDimensions(columns: unknown, rows: unknown): { readonly columns: number; readonly rows: number } | undefined {
  const validColumns = dimension(columns, MIN_COLUMNS, MAX_COLUMNS);
  const validRows = dimension(rows, MIN_ROWS, MAX_ROWS);
  return validColumns && validRows ? { columns: validColumns, rows: validRows } : undefined;
}

function frameMessage(value: unknown): PendingTerminalMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type.includes("closed")) {
    return { kind: "closed", ...(typeof record.reason === "string" ? { reason: record.reason } : {}) };
  }
  if (type.includes("error") || type.includes("conflict")) {
    return { kind: "error", message: typeof record.reason === "string" ? record.reason : "Herdr terminal stream failed." };
  }
  if (typeof record.bytes !== "string") return undefined;
  if (Buffer.byteLength(record.bytes) > MAX_FRAME_BYTES) {
    return { kind: "closed", reason: "Herdr terminal frame exceeded the safe limit." };
  }
  return {
    kind: "frame",
    bytes: record.bytes,
    ...(typeof record.cols === "number" ? { columns: record.cols } : {}),
    ...(typeof record.rows === "number" ? { rows: record.rows } : {}),
    ...(typeof record.sequence === "number" ? { sequence: record.sequence } : {}),
    ...(record.full === true ? { full: true } : {}),
  };
}

function spawnedTerminalProcess(
  paneId: string,
  dimensions: { readonly columns: number; readonly rows: number },
): TerminalProcess {
  const child = spawn("herdr", [
    "terminal", "session", "control", paneId,
    "--takeover",
    "--cols", String(dimensions.columns),
    "--rows", String(dimensions.rows),
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(127));
  });
  return {
    stdin: {
      write: (value) => new Promise<number>((resolve, reject) => {
        child.stdin.write(value, (error) => error ? reject(error) : resolve(typeof value === "string" ? Buffer.byteLength(value) : value.byteLength));
      }),
    },
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill: () => child.kill(),
  };
}

export class TerminalGateway {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(private readonly createProcess: TerminalProcessFactory = spawnedTerminalProcess) {}

  async open(paneId: string, rawDimensions: { readonly columns?: unknown; readonly rows?: unknown }) {
    const dimensions = boundedDimensions(rawDimensions.columns, rawDimensions.rows);
    if (!dimensions) throw new Error("Terminal dimensions are invalid.");
    if (this.sessions.size >= MAX_SESSIONS) throw new Error("Too many Heed terminal sessions are open.");

    const process = this.createProcess(paneId, dimensions);
    const sessionId = crypto.randomUUID();
    const session: TerminalSession = {
      id: sessionId,
      process,
      listeners: new Set(),
      replay: [],
      nextDeliveryId: 1,
      replayBytes: 0,
      closed: false,
      processExited: false,
      stderr: "",
    };
    this.sessions.set(sessionId, session);
    // Expire the session if no client ever connects; connect() cancels this.
    this.scheduleRelease(session);
    void this.consumeStdout(session);
    void this.consumeStderr(session).catch(() => undefined);
    void process.exited.then(() => {
      session.processExited = true;
      if (!session.closed) this.publish(session, { kind: "closed", ...(session.stderr.trim() ? { reason: session.stderr.trim() } : {}) });
      else this.scheduleRelease(session);
    }).catch(() => {
      session.processExited = true;
      if (!session.closed) this.publish(session, { kind: "closed", reason: "Herdr terminal process failed." });
      else this.scheduleRelease(session);
    });
    return { sessionId, message: "Connected to the Herdr terminal session." };
  }

  connect(sessionId: string, listener: TerminalListener, afterDeliveryId?: number) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Terminal session not found.");
    const oldest = session.replay.find((message): message is Exclude<TerminalServerMessage, { readonly kind: "error" }> => "deliveryId" in message);
    const oldestDeliveryId = oldest?.deliveryId;
    const latestDeliveryId = session.nextDeliveryId - 1;
    if (afterDeliveryId !== undefined && afterDeliveryId > latestDeliveryId)
      throw new Error("Terminal reconnect cursor is invalid.");
    if (oldestDeliveryId !== undefined && afterDeliveryId !== undefined && afterDeliveryId < oldestDeliveryId - 1)
      throw new Error("Terminal reconnect history expired.");
    if (!session.closed) this.cancelRelease(session);
    try {
      for (const message of session.replay) {
        if (!("deliveryId" in message) || afterDeliveryId === undefined || (message.deliveryId ?? 0) > afterDeliveryId)
          listener(message);
      }
    } catch (error) {
      if (session.closed || session.listeners.size === 0) this.scheduleRelease(session);
      throw error;
    }
    if (!session.closed) session.listeners.add(listener);
    else this.scheduleRelease(session);
    let pending = Promise.resolve();
    return {
      receive: (text: string) => {
        pending = pending
          .catch(() => undefined)
          .then(() => this.receive(session, text))
          .catch((error) => this.failReceive(session, error));
        return pending;
      },
      close: () => {
        session.listeners.delete(listener);
        if (session.listeners.size === 0) this.scheduleRelease(session);
      },
    };
  }

  async release(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.releasePromise) return session.releasePromise;
    const cleanup = (async () => {
      this.sessions.delete(sessionId);
      this.cancelRelease(session);
      session.closed = true;
      session.listeners.clear();
      if (!session.processExited) {
        try {
          await session.process.stdin.write(`${JSON.stringify({ type: "terminal.release" })}\n`);
        } catch {
          // The controller may already have exited.
        }
        try {
          session.process.kill();
        } catch {
          // Cleanup remains idempotent even when the controller is gone.
        }
      }
    })();
    session.releasePromise = cleanup;
    await cleanup;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.release(sessionId)));
  }

  private async receive(session: TerminalSession, text: string): Promise<void> {
    if (Buffer.byteLength(text) > MAX_FRAME_TEXT_BYTES || session.closed) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.publish(session, { kind: "error", message: "Invalid terminal message." });
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.kind === "input") {
      if (typeof message.value !== "string" || message.value.length > 32_768) return;
      await session.process.stdin.write(`${JSON.stringify({ type: "terminal.input", text: message.value })}\n`);
      return;
    }
    if (message.kind === "bytes") {
      if (!Array.isArray(message.bytes) || message.bytes.length < 1 || message.bytes.length > 32_768 ||
        !message.bytes.every((byte) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255)) return;
      await session.process.stdin.write(`${JSON.stringify({ type: "terminal.input", bytes: Buffer.from(message.bytes).toString("base64") })}\n`);
      return;
    }
    if (message.kind === "resize") {
      const dimensions = boundedDimensions(message.columns, message.rows);
      if (!dimensions) return;
      await session.process.stdin.write(`${JSON.stringify({ type: "terminal.resize", cols: dimensions.columns, rows: dimensions.rows })}\n`);
      return;
    }
    if (message.kind === "scroll") {
      const lines = dimension(message.lines, 1, 512);
      const direction = message.direction === "up" || message.direction === "down" ? message.direction : undefined;
      const source = message.source === "page-key" ? "page_key" : message.source === "wheel" ? "wheel" : undefined;
      if (!lines || !direction || !source) return;
      await session.process.stdin.write(`${JSON.stringify({
        type: "terminal.scroll",
        direction,
        lines,
        source,
        modifiers: 0,
      })}\n`);
    }
  }

  private async failReceive(session: TerminalSession, error: unknown): Promise<void> {
    if (!session.closed) {
      this.publish(session, { kind: "error", message: error instanceof Error ? error.message : "Terminal input failed." });
      this.publish(session, { kind: "closed", reason: "Terminal input failed." });
    }
    await this.release(session.id);
  }

  private async consumeStdout(session: TerminalSession): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of session.process.stdout) {
        pending += decoder.decode(chunk, { stream: true });
        while (true) {
          const newline = pending.indexOf("\n");
          if (newline < 0) {
            if (Buffer.byteLength(pending) > MAX_FRAME_TEXT_BYTES) {
              this.publish(session, { kind: "closed", reason: "Herdr terminal frame exceeded the safe limit." });
              await this.release(session.id);
              return;
            }
            break;
          }
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!line) continue;
          if (Buffer.byteLength(line) > MAX_FRAME_TEXT_BYTES) {
            this.publish(session, { kind: "closed", reason: "Herdr terminal frame exceeded the safe limit." });
            await this.release(session.id);
            return;
          }
          try {
            const parsed = JSON.parse(line) as unknown;
            const oversized = parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
              typeof (parsed as Record<string, unknown>).bytes === "string" &&
              Buffer.byteLength((parsed as Record<string, unknown>).bytes as string) > MAX_FRAME_BYTES;
            const message = frameMessage(parsed);
            if (message) {
              this.publish(session, message);
              if (message.kind === "closed") {
                if (oversized) await this.release(session.id);
                return;
              }
            }
          } catch {
            this.publish(session, { kind: "error", message: "Herdr returned an invalid terminal frame." });
          }
        }
      }
    } catch (error) {
      if (!session.closed) {
        this.publish(session, { kind: "error", message: error instanceof Error ? error.message : "Herdr terminal stream failed." });
        this.publish(session, { kind: "closed", reason: "Herdr terminal stream failed." });
      }
      await this.release(session.id);
    }
  }

  private async consumeStderr(session: TerminalSession): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of session.process.stderr) {
      session.stderr = (session.stderr + decoder.decode(chunk, { stream: true })).slice(-65_536);
    }
  }

  private publish(session: TerminalSession, pending: PendingTerminalMessage): void {
    if (session.closed) return;
    const message: TerminalServerMessage = pending.kind === "error"
      ? pending
      : { ...pending, deliveryId: session.nextDeliveryId++ };
    session.replay.push(message);
    session.replayBytes += Buffer.byteLength(JSON.stringify(message));
    while ((session.replay.length > MAX_REPLAY_MESSAGES || session.replayBytes > MAX_REPLAY_BYTES) && session.replay.length > 1) {
      const removed = session.replay.shift();
      if (removed) session.replayBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
    if (message.kind === "closed") session.closed = true;
    for (const listener of session.listeners) listener(message);
    if (message.kind === "closed") {
      session.listeners.clear();
      this.scheduleRelease(session);
    }
  }

  private scheduleRelease(session: TerminalSession): void {
    if (session.releaseTimer || session.releasePromise) return;
    session.releaseTimer = setTimeout(() => {
      session.releaseTimer = undefined;
      if (this.sessions.get(session.id) === session && session.listeners.size === 0) void this.release(session.id);
    }, RECONNECT_GRACE_MS);
    session.releaseTimer.unref?.();
  }

  private cancelRelease(session: TerminalSession): void {
    if (!session.releaseTimer) return;
    clearTimeout(session.releaseTimer);
    session.releaseTimer = undefined;
  }
}

export const terminalGateway = new TerminalGateway();
