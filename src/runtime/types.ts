import type { FileChange } from "../types";

export type RuntimeStatus = "working" | "idle" | "blocked" | "done" | "unknown";
export type RuntimeConnection = "connecting" | "live" | "stale" | "offline" | "demo";

export interface RuntimeAgent {
  readonly id: string;
  readonly paneId: string;
  readonly name: string;
  readonly kind: string;
  readonly status: RuntimeStatus;
  readonly workspaceId: string;
  readonly workspaceLabel?: string;
  readonly tabId: string;
  readonly cwd?: string;
  readonly terminalTitle?: string;
  readonly focused: boolean;
  readonly revision: number;
  readonly interactiveReady: boolean;
}

export interface RuntimeSnapshot {
  readonly available: boolean;
  readonly version?: string;
  readonly protocol?: number;
  readonly fetchedAt: number;
  readonly agents: readonly RuntimeAgent[];
  readonly error?: string;
}

export interface RuntimeOutput {
  readonly text: string;
  readonly format?: "ansi" | "text";
  readonly revision?: number;
  readonly truncated: boolean;
}

export interface RuntimeChanges {
  readonly workspace: string;
  readonly files: readonly FileChange[];
  readonly partial: boolean;
  readonly message?: string;
}

export interface RuntimeTerminalSession {
  readonly sessionId: string;
  readonly message: string;
}

export type RuntimeTerminalMessage =
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
