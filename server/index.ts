#!/usr/bin/env bun

import { extname, join, normalize, resolve } from "node:path";
import { handleRuntimeRequest, isTrustedLocalRequest } from "./runtime-gateway.ts";
import { createRuntimeGateway } from "./runtime-config.ts";
import { terminalGateway } from "./terminal.ts";
import { bindTerminalSocket, type TerminalSocketBinding, type TerminalSocketTarget, terminalSocketTarget } from "./terminal-socket.ts";

interface TerminalSocketData {
  readonly target: TerminalSocketTarget;
  binding?: TerminalSocketBinding;
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

const server = Bun.serve<TerminalSocketData>({
  hostname: "127.0.0.1",
  port,
  async fetch(request, runningServer) {
    const url = new URL(request.url);
    if (!isTrustedLocalRequest(url, request.headers.get("origin"))) return new Response("Request origin rejected.", { status: 403 });
    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json({ service: "heed", status: "ok" }, { headers: { "cache-control": "no-store" } });
    }
    const target = terminalSocketTarget(url);
    if (target === "invalid") return new Response("Invalid terminal replay cursor.", { status: 400 });
    if (target) {
      if (!runningServer.upgrade(request, { data: { target } }))
        return new Response("Terminal WebSocket upgrade failed.", { status: 400 });
      return;
    }
    const runtime = await handleRuntimeRequest(request, runtimeGateway);
    return runtime ?? staticResponse(url);
  },
  websocket: {
    open(socket) {
      socket.data.binding = bindTerminalSocket(socket.data.target, {
        send: (text) => socket.send(text),
        close: (code, reason) => socket.close(code, reason),
      });
    },
    message(socket, message) {
      socket.data.binding?.receive(message);
    },
    close(socket) {
      socket.data.binding?.close();
    },
  },
});

const shutdown = () => void terminalGateway.closeAll().finally(() => process.exit(0));
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`Heed · http://${server.hostname}:${server.port}`);
