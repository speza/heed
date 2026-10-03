import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { WebSocketServer } from "ws";
import { createRuntimeGateway } from "./runtime-config.ts";
import { handleRuntimeRequest, isTrustedLocalRequest } from "./runtime-gateway.ts";
import { terminalGateway } from "./terminal.ts";
import { bindTerminalSocket, terminalSocketTarget } from "./terminal-socket.ts";

const runtimeGateway = createRuntimeGateway();
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

class RequestBodyLimitError extends Error {}

export async function bodyFor(request: IncomingMessage): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const declaredLength = Number(request.headers["content-length"] ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) throw new RequestBodyLimitError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BODY_BYTES) throw new RequestBodyLimitError();
    chunks.push(bytes);
  }
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
  const requestUrl = new URL(`http://${request.headers.host ?? "127.0.0.1"}${request.url}`);
  if (!isTrustedLocalRequest(requestUrl, request.headers.origin)) {
    response.statusCode = 403;
    response.end("Request origin rejected.");
    return true;
  }
  let body: Uint8Array | undefined;
  try {
    body = await bodyFor(request);
  } catch (error) {
    if (error instanceof RequestBodyLimitError) {
      response.statusCode = 413;
      response.end("Runtime request body is too large.");
      return true;
    }
    throw error;
  }
  const result = await handleRuntimeRequest(
    new Request(requestUrl, {
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
      const onUpgrade = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
        const target = terminalSocketTarget(url);
        if (!target) return;
        if (target === "invalid" || !isTrustedLocalRequest(url, request.headers.origin)) {
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(request, socket, head, (webSocket) => {
          const binding = bindTerminalSocket(target, {
            send: (text) => webSocket.send(text),
            close: (code, reason) => webSocket.close(code, reason),
          });
          webSocket.on("message", (message, binary) => binding.receive(binary ? new Uint8Array() : message.toString()));
          webSocket.on("close", () => binding.close());
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
