import type { FileChange } from "../types";

export type RuntimeStatus = "working" | "idle" | "blocked" | "done" | "unknown";
export type RuntimeConnection = "connecting" | "live" | "stale" | "offline" | "demo";
export type RuntimeKind = "herdr" | "amp" | "api" | "other";

/** The configured runtime that owns an Agent session. */
export interface RuntimeSource {
  readonly id: string;
  readonly kind: RuntimeKind;
  readonly label: string;
}

/** Optional surfaces exposed by a runtime; the UI must not infer these. */
export interface RuntimeCapabilities {
  readonly terminal: boolean;
  readonly output: boolean;
  readonly conversation: boolean;
  readonly workspaceChanges: boolean;
  readonly spawn: boolean;
  readonly lineage: boolean;
}

/** Runtime-neutral location metadata. A source may expose only some fields. */
export interface RuntimeLocation {
  readonly workspaceId?: string;
  readonly workspaceLabel?: string;
  readonly tabId?: string;
  readonly paneId?: string;
  readonly cwd?: string;
}

export interface RuntimeAgent {
  readonly id: string;
  readonly source: RuntimeSource;
  readonly name: string;
  readonly kind: string;
  readonly provider?: string;
  readonly model?: string;
  readonly status: RuntimeStatus;
  readonly location?: RuntimeLocation;
  readonly terminalTitle?: string;
  readonly focused: boolean;
  readonly revision: number;
  readonly interactiveReady?: boolean;
  /** False when this is retained data from a source that is currently unavailable. */
  readonly sourceAvailable?: boolean;
  readonly sourceStale?: boolean;
  readonly capabilities: RuntimeCapabilities;
}

export interface RuntimeSourceHealth {
  readonly source: RuntimeSource;
  readonly available: boolean;
  readonly stale: boolean;
  readonly fetchedAt: number;
  readonly error?: string;
}

export interface RuntimeSnapshot {
  readonly available: boolean;
  readonly version?: string;
  readonly protocol?: number;
  readonly fetchedAt: number;
  readonly sources: readonly RuntimeSource[];
  readonly sourceHealth: readonly RuntimeSourceHealth[];
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
