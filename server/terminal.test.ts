import { afterEach, describe, expect, test, vi } from "vitest";
import { TerminalGateway, type TerminalProcess, type TerminalProcessFactory, type TerminalServerMessage } from "./terminal";

class ByteQueue implements AsyncIterable<Uint8Array>, AsyncIterator<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private readonly waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  private ended = false;

  write(value: string | Uint8Array): void {
    const chunk = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: chunk, done: false });
    else this.chunks.push(chunk);
  }

  end(): void {
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()!({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this;
  }

  next(): Promise<IteratorResult<Uint8Array>> {
    const chunk = this.chunks.shift();
    if (chunk) return Promise.resolve({ value: chunk, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface FakeProcess extends TerminalProcess {
  readonly stdoutStream: ByteQueue;
  readonly stderrStream: ByteQueue;
  readonly writes: string[];
  readonly resolveExit: (code: number) => void;
  readonly killed: { value: number };
}

function fakeFactory(options: { readonly rejectInput?: boolean } = {}) {
  const processes: FakeProcess[] = [];
  const factory: TerminalProcessFactory = () => {
    const stdoutStream = new ByteQueue();
    const stderrStream = new ByteQueue();
    const writes: string[] = [];
    const killed = { value: 0 };
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    let firstWrite = true;
    const process: FakeProcess = {
      stdin: {
        write: vi.fn((value: string | Uint8Array) => {
          if (options.rejectInput && firstWrite) {
            firstWrite = false;
            return Promise.reject(new Error("stdin broke"));
          }
          writes.push(typeof value === "string" ? value : Buffer.from(value).toString("utf8"));
          return Promise.resolve(typeof value === "string" ? Buffer.byteLength(value) : value.byteLength);
        }),
      },
      stdout: stdoutStream,
      stderr: stderrStream,
      exited,
      kill: () => { killed.value += 1; },
      stdoutStream,
      stderrStream,
      writes,
      resolveExit,
      killed,
    };
    processes.push(process);
    return process;
  };
  return { factory, processes };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function frame(bytes: string): string {
  return `${JSON.stringify({ type: "terminal.frame", bytes })}\n`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalGateway lifecycle", () => {
  test("releases a session that is opened but never connected", async () => {
    vi.useFakeTimers();
    const fake = fakeFactory();
    const gateway = new TerminalGateway(fake.factory);
    const opened = await gateway.open("pane", { columns: 80, rows: 24 });

    vi.advanceTimersByTime(15_000);
    await flush();
    expect(fake.processes[0]!.killed.value).toBe(1);
    expect(() => gateway.connect(opened.sessionId, () => undefined)).toThrow("Terminal session not found");
  });

  test("closes and kills an owned controller after an oversized frame", async () => {
    const fake = fakeFactory();
    const gateway = new TerminalGateway(fake.factory);
    const opened = await gateway.open("pane", { columns: 80, rows: 24 });
    const messages: TerminalServerMessage[] = [];
    gateway.connect(opened.sessionId, (message) => messages.push(message));

    fake.processes[0]!.stdoutStream.write(frame("x".repeat(300_000)));
    await flush();

    expect(messages).toContainEqual(expect.objectContaining({ kind: "closed" }));
    expect(fake.processes[0]!.killed.value).toBe(1);
    expect(() => gateway.connect(opened.sessionId, () => undefined)).toThrow("Terminal session not found");
  });

  test("expires closed sessions without DELETE and terminates live controllers", async () => {
    vi.useFakeTimers();
    const fake = fakeFactory();
    const gateway = new TerminalGateway(fake.factory);
    const opened = await gateway.open("pane", { columns: 80, rows: 24 });
    const connection = gateway.connect(opened.sessionId, () => undefined);

    fake.processes[0]!.stdoutStream.write(`${JSON.stringify({ type: "terminal.closed", reason: "done" })}\n`);
    await flush();
    expect(fake.processes[0]!.killed.value).toBe(0);

    vi.advanceTimersByTime(15_000);
    await flush();
    expect(fake.processes[0]!.killed.value).toBe(1);
    connection.close();
    expect(() => gateway.connect(opened.sessionId, () => undefined)).toThrow("Terminal session not found");
  });

  test("replays a closed session during reconnect grace and expires it afterward", async () => {
    vi.useFakeTimers();
    const fake = fakeFactory();
    const gateway = new TerminalGateway(fake.factory);
    const opened = await gateway.open("pane", { columns: 80, rows: 24 });
    const first = gateway.connect(opened.sessionId, () => undefined);
    fake.processes[0]!.resolveExit(0);
    await flush();

    const replay: TerminalServerMessage[] = [];
    gateway.connect(opened.sessionId, (message) => replay.push(message));
    expect(replay).toContainEqual(expect.objectContaining({ kind: "closed" }));

    vi.advanceTimersByTime(14_999);
    await flush();
    expect(() => gateway.connect(opened.sessionId, () => undefined)).not.toThrow();

    vi.advanceTimersByTime(1);
    await flush();
    expect(() => gateway.connect(opened.sessionId, () => undefined)).toThrow("Terminal session not found");
    first.close();
  });

  test("does not lose cleanup after an invalid reconnect cursor", async () => {
    vi.useFakeTimers();
    const fake = fakeFactory();
    const gateway = new TerminalGateway(fake.factory);
    const opened = await gateway.open("pane", { columns: 80, rows: 24 });
    gateway.connect(opened.sessionId, () => undefined);

    fake.processes[0]!.stdoutStream.write(`${JSON.stringify({ type: "terminal.closed", reason: "done" })}\n`);
    await flush();

    expect(() => gateway.connect(opened.sessionId, () => undefined, Number.MAX_SAFE_INTEGER)).toThrow("cursor is invalid");

    vi.advanceTimersByTime(15_000);
    await flush();
    expect(fake.processes[0]!.killed.value).toBe(1);
    expect(() => gateway.connect(opened.sessionId, () => undefined)).toThrow("Terminal session not found");
  });

  test("reports a failed stdin write, closes once and keeps later receives settled", async () => {
    const fake = fakeFactory({ rejectInput: true });
    const gateway = new TerminalGateway(fake.factory);
    const opened = await gateway.open("pane", { columns: 80, rows: 24 });
    const messages: TerminalServerMessage[] = [];
    const connection = gateway.connect(opened.sessionId, (message) => messages.push(message));

    await expect(connection.receive(JSON.stringify({ kind: "input", value: "a" }))).resolves.toBeUndefined();
    await expect(connection.receive(JSON.stringify({ kind: "resize", columns: 80, rows: 24 }))).resolves.toBeUndefined();

    expect(messages.filter((message) => message.kind === "closed")).toHaveLength(1);
    expect(fake.processes[0]!.killed.value).toBe(1);
  });

  test("handles a failed resize write with the same deterministic cleanup", async () => {
    const fake = fakeFactory({ rejectInput: true });
    const gateway = new TerminalGateway(fake.factory);
    const opened = await gateway.open("pane", { columns: 80, rows: 24 });
    const messages: TerminalServerMessage[] = [];
    const connection = gateway.connect(opened.sessionId, (message) => messages.push(message));

    await expect(connection.receive(JSON.stringify({ kind: "resize", columns: 100, rows: 30 }))).resolves.toBeUndefined();

    expect(messages).toContainEqual(expect.objectContaining({ kind: "closed" }));
    expect(fake.processes[0]!.killed.value).toBe(1);
  });

  test("evicts replay by bytes instead of retaining an unbounded frame count", async () => {
    const fake = fakeFactory();
    const gateway = new TerminalGateway(fake.factory);
    const opened = await gateway.open("pane", { columns: 80, rows: 24 });
    const connection = gateway.connect(opened.sessionId, () => undefined);

    fake.processes[0]!.stdoutStream.write(frame("x".repeat(200_000)));
    fake.processes[0]!.stdoutStream.write(frame("y".repeat(200_000)));
    fake.processes[0]!.stdoutStream.write(frame("z".repeat(200_000)));
    await flush();
    connection.close();

    expect(() => gateway.connect(opened.sessionId, () => undefined, 0)).toThrow("Terminal reconnect history expired");
    await gateway.release(opened.sessionId);
  });

  test("does not exhaust the session quota after repeated controller exits", async () => {
    vi.useFakeTimers();
    const fake = fakeFactory();
    const gateway = new TerminalGateway(fake.factory);
    const opened = await Promise.all(Array.from({ length: 16 }, () => gateway.open("pane", { columns: 80, rows: 24 })));
    fake.processes.forEach((process) => process.resolveExit(0));
    await flush();

    vi.advanceTimersByTime(15_000);
    await flush();

    await expect(gateway.open("pane", { columns: 80, rows: 24 })).resolves.toBeDefined();
    await gateway.closeAll();
    expect(opened).toHaveLength(16);
  });
});
