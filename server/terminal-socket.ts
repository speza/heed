import { terminalGateway, type TerminalGateway } from "./terminal.ts";

const TERMINAL_SOCKET_PATH = /^\/api\/runtime\/terminal\/([0-9a-f-]{36})\/socket$/u;

export interface TerminalSocketTarget {
  readonly sessionId: string;
  readonly afterDeliveryId?: number;
}

/**
 * Recognizes a terminal WebSocket URL. Returns `undefined` for other paths and
 * `"invalid"` for a terminal path with a malformed replay cursor.
 */
export function terminalSocketTarget(url: URL): TerminalSocketTarget | "invalid" | undefined {
  const sessionId = TERMINAL_SOCKET_PATH.exec(url.pathname)?.[1];
  if (!sessionId) return undefined;
  const rawAfter = url.searchParams.get("after");
  if (rawAfter === null) return { sessionId };
  const afterDeliveryId = Number(rawAfter);
  return Number.isSafeInteger(afterDeliveryId) && afterDeliveryId >= 0 ? { sessionId, afterDeliveryId } : "invalid";
}

export interface TerminalSocketPeer {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface TerminalSocketBinding {
  receive(message: string | Uint8Array): void;
  close(): void;
}

/** Connects one WebSocket peer to a gateway session with identical semantics in every server. */
export function bindTerminalSocket(
  target: TerminalSocketTarget,
  peer: TerminalSocketPeer,
  gateway: TerminalGateway = terminalGateway,
): TerminalSocketBinding {
  let connection: ReturnType<TerminalGateway["connect"]> | undefined;
  try {
    connection = gateway.connect(target.sessionId, (message) => {
      peer.send(JSON.stringify(message));
      if (message.kind === "closed") peer.close(1000, "Terminal closed");
    }, target.afterDeliveryId);
  } catch (error) {
    peer.send(JSON.stringify({ kind: "closed", reason: error instanceof Error ? error.message : "Terminal unavailable." }));
    peer.close(1008, "Terminal unavailable");
  }
  return {
    receive(message) {
      if (typeof message !== "string") {
        peer.send(JSON.stringify({ kind: "error", message: "Terminal messages must be JSON text." }));
        return;
      }
      void connection?.receive(message).catch(() => peer.close(1011, "Terminal input failed"));
    },
    close() {
      connection?.close();
    },
  };
}
