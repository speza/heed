import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  agentTerminalSocketUrl,
  openAgentTerminal,
  parseTerminalMessage,
  releaseAgentTerminal,
} from "./runtime/client";
import { isModifiedTerminalKey, modifiedTerminalInput } from "./terminalKeyboard";

function decodeFrame(value: string): Uint8Array {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

const MAX_RECONNECT_DELAY_MS = 2_000;

/** Resolves xterm colours from the semantic theme tokens (ADR-0009). */
function terminalTheme(node: Element) {
  const style = getComputedStyle(node);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const accent = token("--accent", "#babbf1");
  return {
    background: "#00000000",
    foreground: token("--text", "#c6d0f5"),
    cursor: accent,
    selectionBackground: /^#[0-9a-f]{6}$/iu.test(accent) ? `${accent}33` : accent,
  };
}

export function TerminalOutput({ agentId }: { readonly agentId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Connecting to terminal…");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const node = host.current;
    if (!node) return;

    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: false,
      disableStdin: false,
      fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 2_000,
      theme: terminalTheme(node),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(node);
    fit.fit();

    let disposed = false;
    let terminalClosed = false;
    let sessionId: string | undefined;
    let socket: WebSocket | undefined;
    let resizeFrame: number | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempts = 0;
    let lastDeliveryId: number | undefined;
    let hasRenderedFrame = false;
    const boundedDimension = (value: number, minimum: number, maximum: number, fallback: number) =>
      Number.isInteger(value) && value > 0 ? Math.min(maximum, Math.max(minimum, value)) : fallback;
    const dimensions = () => ({
      columns: boundedDimension(terminal.cols, 20, 400, 80),
      rows: boundedDimension(terminal.rows, 8, 240, 24),
    });
    const sendMessage = (message: object) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const sendResize = () => sendMessage({ kind: "resize", ...dimensions() });
    const sendScroll = (direction: "up" | "down", lines: number, source: "wheel" | "page-key") =>
      sendMessage({ kind: "scroll", direction, lines: Math.min(512, Math.max(1, lines)), source });

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < 1) return;
      event.preventDefault();
      event.stopPropagation();
      sendScroll(event.deltaY < 0 ? "up" : "down", Math.round(Math.abs(event.deltaY) / 20), "wheel");
    };
    node.addEventListener("wheel", handleWheel, { capture: true, passive: false });

    terminal.attachCustomKeyEventHandler((event) => {
      if (isModifiedTerminalKey(event)) {
        const bytes = modifiedTerminalInput(event);
        if (bytes) sendMessage({ kind: "bytes", bytes: Array.from(bytes) });
        return false;
      }
      if (event.type !== "keydown" || (event.key !== "PageUp" && event.key !== "PageDown")) return true;
      sendScroll(event.key === "PageUp" ? "up" : "down", Math.max(1, terminal.rows - 2), "page-key");
      return false;
    });
    const input = terminal.onData((value) => sendMessage({ kind: "input", value }));

    const observer = new ResizeObserver(() => {
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        fit.fit();
        sendResize();
      });
    });
    observer.observe(node);

    const connectSocket = () => {
      if (disposed || terminalClosed || !sessionId) return;
      const candidate = new WebSocket(agentTerminalSocketUrl(sessionId, lastDeliveryId));
      socket = candidate;
      candidate.addEventListener("open", () => {
        if (socket !== candidate) return;
        reconnectAttempts = 0;
        setStatus("Connected to the Herdr terminal session.");
        sendResize();
        terminal.focus();
        if (revealTimer) clearTimeout(revealTimer);
        if (hasRenderedFrame) setReady(true);
        else revealTimer = setTimeout(() => setReady(true), 450);
      });
      candidate.addEventListener("message", (event: MessageEvent<string>) => {
        try {
          const message = parseTerminalMessage(event.data);
          if (message.kind === "error") {
            setStatus(message.message);
            return;
          }
          if (message.deliveryId !== undefined) lastDeliveryId = message.deliveryId;
          if (message.kind === "closed") {
            terminalClosed = true;
            setStatus(message.reason ?? "Terminal session closed.");
            setReady(false);
            return;
          }
          if (message.full) terminal.reset();
          terminal.write(decodeFrame(message.bytes), () => {
            hasRenderedFrame = true;
            if (revealTimer) clearTimeout(revealTimer);
            setReady(true);
          });
        } catch {
          setStatus("Terminal stream returned an invalid frame.");
        }
      });
      candidate.addEventListener("close", () => {
        if (disposed || terminalClosed || socket !== candidate) return;
        setReady(false);
        setStatus("Terminal stream reconnecting…");
        const delay = Math.min(MAX_RECONNECT_DELAY_MS, 250 * 2 ** reconnectAttempts++);
        reconnectTimer = setTimeout(connectSocket, delay);
      });
    };

    const initialDimensions = dimensions();
    void openAgentTerminal(agentId, initialDimensions.columns, initialDimensions.rows)
      .then((opened) => {
        if (disposed) {
          void releaseAgentTerminal(opened.sessionId);
          return;
        }
        sessionId = opened.sessionId;
        setStatus(opened.message);
        connectSocket();
      })
      .catch((error) => {
        setStatus(error instanceof Error ? error.message : "Terminal could not be opened.");
      });

    return () => {
      disposed = true;
      observer.disconnect();
      node.removeEventListener("wheel", handleWheel, { capture: true });
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (revealTimer) clearTimeout(revealTimer);
      socket?.close();
      input.dispose();
      terminal.dispose();
      if (sessionId) void releaseAgentTerminal(sessionId);
    };
  }, [agentId]);

  return (
    <div className={`terminal-frame${ready ? " is-ready" : " is-connecting"}`}>
      <div className="terminal-host" ref={host} role="region" aria-label="Connected terminal output" />
      {!ready ? <div className="terminal-overlay"><span>TERMINAL CONNECTION</span><strong>{status}</strong></div> : null}
    </div>
  );
}
