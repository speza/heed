#!/usr/bin/env bun

import { extname, join, normalize, resolve } from "node:path";
import { handleRuntimeRequest, isTrustedLocalRequest } from "./runtime-gateway.ts";
import { createRuntimeGateway } from "./runtime-config.ts";
import { terminalGateway, type TerminalServerMessage } from "./terminal.ts";

interface TerminalSocketData {
  readonly sessionId: string;
  readonly afterDeliveryId?: number;
  connection?: ReturnType<typeof terminalGateway.connect>;
}

const port = Number(process.env.HEED_PORT ?? "4311");
const root = resolve(import.meta.dir, "../dist");
const runtimeGateway = createRuntimeGateway();
const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function staticResponse(url: URL): Promise<Response> {
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = normalize(join(root, requested));
  if (!path.startsWith(`${root}/`) && path !== root) return new Response("Not found", { status: 404 });
  let file = Bun.file(path);
  if (!(await file.exists())) file = Bun.file(join(root, "index.html"));
  if (!(await file.exists())) return new Response("Build Heed first with `bun run build`.", { status: 503 });
  return new Response(file, {
    headers: {
      "content-type": contentTypes[extname(file.name ?? path)] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
    },
  });
}

const terminalSocketPath = /^\/api\/runtime\/terminal\/([0-9a-f-]{36})\/socket$/u;

const server = Bun.serve<TerminalSocketData>({
  hostname: "127.0.0.1",
  port,
  async fetch(request, runningServer) {
    const url = new URL(request.url);
    if (!isTrustedLocalRequest(url, request.headers.get("origin"))) return new Response("Request origin rejected.", { status: 403 });
    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json({ service: "heed", status: "ok" }, { headers: { "cache-control": "no-store" } });
    }
    const terminalSocket = terminalSocketPath.exec(url.pathname);
    if (terminalSocket?.[1]) {
      const rawAfter = url.searchParams.get("after");
      const afterDeliveryId = rawAfter === null ? undefined : Number(rawAfter);
      if (afterDeliveryId !== undefined && (!Number.isSafeInteger(afterDeliveryId) || afterDeliveryId < 0))
        return new Response("Invalid terminal replay cursor.", { status: 400 });
      if (!runningServer.upgrade(request, { data: { sessionId: terminalSocket[1], afterDeliveryId } }))
        return new Response("Terminal WebSocket upgrade failed.", { status: 400 });
      return;
    }
    const runtime = await handleRuntimeRequest(request, runtimeGateway);
    return runtime ?? staticResponse(url);
  },
  websocket: {
    open(socket) {
      try {
        socket.data.connection = terminalGateway.connect(socket.data.sessionId, (message: TerminalServerMessage) => {
          socket.send(JSON.stringify(message));
          if (message.kind === "closed") socket.close(1000, "Terminal closed");
        }, socket.data.afterDeliveryId);
      } catch (error) {
        socket.send(JSON.stringify({ kind: "closed", reason: error instanceof Error ? error.message : "Terminal unavailable." }));
        socket.close(1008, "Terminal unavailable");
      }
    },
    message(socket, message) {
      if (typeof message === "string") {
        const pending = socket.data.connection?.receive(message);
        if (pending) void pending.catch(() => socket.close(1011, "Terminal input failed"));
      }
      else socket.send(JSON.stringify({ kind: "error", message: "Terminal messages must be JSON text." }));
    },
    close(socket) {
      socket.data.connection?.close();
    },
  },
});

const shutdown = () => void terminalGateway.closeAll().finally(() => process.exit(0));
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`Heed · http://${server.hostname}:${server.port}`);
