import type { RuntimeCapabilities, RuntimeSource } from "../src/runtime/types.ts";
import { RuntimeAdapterError } from "./runtime-gateway.ts";
import type { RuntimeAdapter, RuntimeAdapterSnapshot, RuntimeOutputRequest } from "./runtime-gateway.ts";

const MOCK_SOURCE = { id: "mock-api", kind: "api", label: "Mock API" } as const satisfies RuntimeSource;
const MOCK_CAPABILITIES = {
  terminal: false,
  output: true,
  conversation: false,
  workspaceChanges: false,
  spawn: false,
  lineage: false,
} as const satisfies RuntimeCapabilities;

/**
 * Explicitly opt-in synthetic source used to exercise mixed runtime fleets.
 * It deliberately has no terminal, pane, workspace or process ownership.
 */
export class MockApiRuntimeAdapter implements RuntimeAdapter {
  readonly source = MOCK_SOURCE;

  async snapshot(): Promise<RuntimeAdapterSnapshot> {
    return {
      available: true,
      fetchedAt: Date.now(),
      agents: [
        {
          id: `${MOCK_SOURCE.id}:research`,
          source: MOCK_SOURCE,
          name: "API research",
          kind: "assistant",
          provider: "OpenAI",
          model: "gpt-5",
          status: "working",
          focused: false,
          revision: 1,
          capabilities: MOCK_CAPABILITIES,
        },
      ],
    };
  }

  async readOutput(id: string, request: RuntimeOutputRequest) {
    if (id !== `${MOCK_SOURCE.id}:research`) throw new RuntimeAdapterError(404, "That mock API Agent is no longer available.");
    return {
      text: "Synthetic API-backed output. This source intentionally has no terminal or workspace.\n",
      format: request.format,
      revision: 1,
      truncated: false,
    };
  }
}
