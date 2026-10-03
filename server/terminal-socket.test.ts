import { describe, expect, test, vi } from "vitest";
import type { TerminalGateway } from "./terminal";
import { bindTerminalSocket, terminalSocketTarget } from "./terminal-socket";

const SESSION = "0f3b8d2e-6a4c-4f1e-9b7a-2c5d8e1f3a6b";

describe("terminal socket routing", () => {
  test("parses a session and optional replay cursor", () => {
    expect(terminalSocketTarget(new URL(`http://127.0.0.1/api/runtime/terminal/${SESSION}/socket`))).toEqual({ sessionId: SESSION });
    expect(terminalSocketTarget(new URL(`http://127.0.0.1/api/runtime/terminal/${SESSION}/socket?after=12`))).toEqual({ sessionId: SESSION, afterDeliveryId: 12 });
    expect(terminalSocketTarget(new URL(`http://127.0.0.1/api/runtime/terminal/${SESSION}/socket?after=-1`))).toBe("invalid");
    expect(terminalSocketTarget(new URL("http://127.0.0.1/api/runtime"))).toBeUndefined();
  });

  test("reports an unknown session as closed and rejects binary input", () => {
    const peer = { send: vi.fn(), close: vi.fn() };
    const gateway = { connect: () => { throw new Error("Terminal session not found."); } } as unknown as TerminalGateway;

    const binding = bindTerminalSocket({ sessionId: SESSION }, peer, gateway);
    binding.receive(new Uint8Array([1]));

    expect(JSON.parse(peer.send.mock.calls[0]![0] as string)).toEqual({ kind: "closed", reason: "Terminal session not found." });
    expect(peer.close).toHaveBeenCalledWith(1008, "Terminal unavailable");
    expect(JSON.parse(peer.send.mock.calls[1]![0] as string)).toMatchObject({ kind: "error" });
  });

  test("forwards gateway messages and closes the peer when the terminal closes", () => {
    const peer = { send: vi.fn(), close: vi.fn() };
    const release = vi.fn();
    const receive = vi.fn(() => Promise.resolve());
    let listener!: (message: { readonly kind: string }) => void;
    const gateway = {
      connect: (_id: string, next: typeof listener) => {
        listener = next;
        return { receive, close: release };
      },
    } as unknown as TerminalGateway;

    const binding = bindTerminalSocket({ sessionId: SESSION, afterDeliveryId: 3 }, peer, gateway);
    binding.receive('{"kind":"input","value":"y"}');
    listener({ kind: "closed" });
    binding.close();

    expect(receive).toHaveBeenCalledWith('{"kind":"input","value":"y"}');
    expect(peer.send).toHaveBeenCalledWith('{"kind":"closed"}');
    expect(peer.close).toHaveBeenCalledWith(1000, "Terminal closed");
    expect(release).toHaveBeenCalled();
  });
});
