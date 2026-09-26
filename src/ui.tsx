import type { Agent, AgentStatus } from "./types";

export const statusLabels: Record<AgentStatus, string> = {
  working: "Working",
  waiting: "Waiting",
  "needs-you": "Needs you",
  done: "Done",
  failed: "Failed",
  unknown: "Unknown",
};

// One motion language: quick, crisp, no overshoot. The native window frame
// snaps instantly; these transitions own all perceived motion.
export const easeOutExpo: [number, number, number, number] = [0.22, 1, 0.36, 1];

export const enterTransition = { duration: 0.16, ease: easeOutExpo };

export const glideTransition = { duration: 0.18, ease: "easeOut" as const };

export function needsAttention(agent: Agent) {
  return agent.status === "needs-you" || agent.status === "failed" || agent.attention !== undefined;
}

export function shellMessage(type: string, payload: Record<string, unknown> = {}) {
  const bridge = (
    window as typeof window & {
      webkit?: {
        messageHandlers?: { shell?: { postMessage: (message: unknown) => void } };
      };
    }
  ).webkit?.messageHandlers?.shell;
  bridge?.postMessage({ type, ...payload });
}

export function Glyph({ name }: { readonly name: "close" | "spark" | "branch" | "command" | "fleet" }) {
  const paths = {
    close: <path d="m5 5 10 10M15 5 5 15" />,
    spark: <path d="M10 2.5 12 8l5.5 2-5.5 2-2 5.5L8 12l-5.5-2L8 8l2-5.5Z" />,
    branch: <path d="M6 3v10a4 4 0 0 0 4 4h4M14 13l4 4-4 4M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />,
    command: <path d="M8 7H5.5a2.5 2.5 0 1 1 2.5-2.5V7Zm0 0v6m0 0H5.5A2.5 2.5 0 1 0 8 15.5V13Zm0 0h4m0 0v2.5a2.5 2.5 0 1 0 2.5-2.5H12Zm0 0V7m0 0h2.5A2.5 2.5 0 1 0 12 4.5V7Z" />,
    fleet: <path d="M4 4h4v4H4V4Zm8 0h4v4h-4V4ZM4 12h4v4H4v-4Zm8 0h4v4h-4v-4Z" />,
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      {paths[name]}
    </svg>
  );
}

export function StatusMark({ status }: { readonly status: AgentStatus }) {
  return <span className={`status-mark status-${status}`} aria-label={statusLabels[status]} />;
}

export function EmptyState({ children }: { readonly children: string }) {
  return <div className="empty-state">{children}</div>;
}
