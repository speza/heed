import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { WebSocketServer } from "ws";
import { createRuntimeGateway } from "./runtime-config.ts";
import { handleRuntimeRequest } from "./runtime-gateway.ts";
import { terminalGateway } from "./terminal.ts";

const runtimeGateway = createRuntimeGateway();

async function bodyFor(request: IncomingMessage): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function serve(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (!request.url?.startsWith("/api/runtime")) return false;
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const body = await bodyFor(request);
  const result = await handleRuntimeRequest(
    new Request(`http://${request.headers.host ?? "127.0.0.1"}${request.url}`, {
      method: request.method,
      headers,
      body: body ? Buffer.from(body) : undefined,
    }),
    runtimeGateway,
  );
  if (!result) return false;
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(Buffer.from(await result.arrayBuffer()));
  return true;
}

export function runtimeGatewayPlugin(): Plugin {
  return {
    name: "heed-runtime-gateway",
    configureServer(server) {
      const sockets = new WebSocketServer({ noServer: true });
      const terminalSocketPath = /^\/api\/runtime\/terminal\/([0-9a-f-]{36})\/socket$/u;
      const onUpgrade = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
        const match = terminalSocketPath.exec(url.pathname);
        if (!match?.[1]) return;
        const origin = request.headers.origin;
        if (origin && origin !== url.origin) {
          socket.destroy();
          return;
        }
        const rawAfter = url.searchParams.get("after");
        const afterDeliveryId = rawAfter === null ? undefined : Number(rawAfter);
        if (afterDeliveryId !== undefined && (!Number.isSafeInteger(afterDeliveryId) || afterDeliveryId < 0)) {
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(request, socket, head, (webSocket) => {
          let connection: ReturnType<typeof terminalGateway.connect> | undefined;
          try {
            connection = terminalGateway.connect(match[1]!, (message) => webSocket.send(JSON.stringify(message)), afterDeliveryId);
          } catch (error) {
            webSocket.send(JSON.stringify({ kind: "closed", reason: error instanceof Error ? error.message : "Terminal unavailable." }));
            webSocket.close(1008, "Terminal unavailable");
            return;
          }
          webSocket.on("message", (message, binary) => {
            if (!binary) void connection?.receive(message.toString());
          });
          webSocket.on("close", () => connection?.close());
        });
      };
      server.httpServer?.on("upgrade", onUpgrade);
      server.middlewares.use((request, response, next) => {
        void serve(request, response).then((handled) => {
          if (!handled) next();
        }).catch(next);
      });
      server.httpServer?.once("close", () => {
        sockets.close();
        void terminalGateway.closeAll();
      });
    },
  };
}
