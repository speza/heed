export type AgentStatus = "working" | "waiting" | "needs-you" | "done" | "failed";

export interface ChatMessage {
  readonly id: string;
  readonly role: "agent" | "human";
  readonly body: string;
  readonly time: string;
}

export interface FileChange {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly kind: "modified" | "added" | "deleted";
  readonly binary?: boolean;
  readonly oldFile?: { readonly content: string };
  readonly newFile?: { readonly content: string };
  readonly hunks: readonly string[];
}

export interface Agent {
  readonly id: string;
  readonly parentId?: string;
  readonly name: string;
  readonly role: string;
  readonly task: string;
  readonly status: AgentStatus;
  readonly provider: string;
  readonly model: string;
  readonly workspace?: string;
  readonly elapsed: string;
  readonly attention?: string;
  readonly messages: readonly ChatMessage[];
  readonly result?: string;
  readonly changes: readonly FileChange[];
}
