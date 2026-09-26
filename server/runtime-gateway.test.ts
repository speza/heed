import { describe, expect, test } from "vitest";
import type { RuntimeAgent, RuntimeCapabilities, RuntimeSource } from "../src/runtime/types";
import { MockApiRuntimeAdapter } from "./mock-runtime";
import { handleRuntimeRequest, RuntimeGateway, type RuntimeAdapter } from "./runtime-gateway";

const capabilities: RuntimeCapabilities = {
  terminal: false,
  output: true,
  conversation: false,
  workspaceChanges: false,
  spawn: false,
  lineage: false,
};

function agent(source: RuntimeSource, id: string): RuntimeAgent {
  return {
    id,
    source,
    name: id,
    kind: "assistant",
    status: "working",
    focused: false,
    revision: 1,
    capabilities,
  };
}

function adapter(source: RuntimeSource, snapshot: { readonly available: boolean; readonly agents: readonly RuntimeAgent[]; readonly error?: string }): RuntimeAdapter {
  return { source, snapshot: async () => ({ ...snapshot, fetchedAt: Date.now() }) };
}

describe("runtime gateway", () => {
  test("aggregates agents and sources without requiring a terminal", async () => {
    const herdr: RuntimeSource = { id: "herdr-local", kind: "herdr", label: "Herdr" };
    const api: RuntimeSource = { id: "api-test", kind: "api", label: "Test API" };
    const gateway = new RuntimeGateway([
      adapter(herdr, { available: true, agents: [agent(herdr, "herdr-local:one")] }),
      adapter(api, { available: true, agents: [agent(api, "api-test:one")] }),
    ]);

    const snapshot = await gateway.snapshot();

    expect(snapshot.available).toBe(true);
    expect(snapshot.sources).toEqual([herdr, api]);
    expect(snapshot.agents.map(({ id }) => id)).toEqual(["herdr-local:one", "api-test:one"]);
  });

  test("keeps available sources when another source is offline", async () => {
    const live: RuntimeSource = { id: "live", kind: "api", label: "Live API" };
    const offline: RuntimeSource = { id: "offline", kind: "other", label: "Offline" };
    const gateway = new RuntimeGateway([
      adapter(live, { available: true, agents: [agent(live, "live:one")] }),
      adapter(offline, { available: false, agents: [], error: "Connection refused" }),
    ]);

    const snapshot = await gateway.snapshot();

    expect(snapshot.available).toBe(true);
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.sources).toEqual([live, offline]);
    expect(snapshot.sourceHealth).toEqual([
      expect.objectContaining({ source: live, available: true, stale: false }),
      expect.objectContaining({ source: offline, available: false, stale: false, error: "Connection refused" }),
    ]);
    expect(snapshot.error).toBe("Offline: Connection refused");
  });

  test("retains stale agents and disables their actions during a source outage", async () => {
    const source: RuntimeSource = { id: "herdr-local", kind: "herdr", label: "Herdr" };
    let available = true;
    const runtime = agent(source, "herdr-local:one");
    const gateway = new RuntimeGateway([{
      source,
      snapshot: async () => ({ available, agents: available ? [runtime] : [], fetchedAt: Date.now(), ...(available ? {} : { error: "Herdr stopped" }) }),
    }]);

    const live = await gateway.snapshot();
    available = false;
    const stale = await gateway.snapshot();

    expect(live.agents).toHaveLength(1);
    expect(stale.available).toBe(false);
    expect(stale.agents).toHaveLength(1);
    expect(stale.agents[0]).toMatchObject({ id: "herdr-local:one", sourceAvailable: false, sourceStale: true });
    expect(stale.agents[0]?.capabilities).toEqual({
      terminal: false,
      output: false,
      conversation: false,
      workspaceChanges: false,
      spawn: false,
      lineage: false,
    });
    expect(stale.sourceHealth[0]).toMatchObject({ available: false, stale: true, error: "Herdr stopped" });
  });

  test("routes namespaced actions directly to their owning adapter", async () => {
    const first: RuntimeSource = { id: "first", kind: "other", label: "First" };
    const second: RuntimeSource = { id: "second", kind: "other", label: "Second" };
    let firstSnapshots = 0;
    let secondSnapshots = 0;
    const gateway = new RuntimeGateway([
      {
        source: first,
        snapshot: async () => { firstSnapshots += 1; return { available: true, agents: [agent(first, "first:one")], fetchedAt: Date.now() }; },
        openTerminal: async () => ({ sessionId: "00000000-0000-0000-0000-000000000001", message: "opened" }),
      },
      {
        source: second,
        snapshot: async () => { secondSnapshots += 1; return { available: true, agents: [agent(second, "second:one")], fetchedAt: Date.now() }; },
      },
    ]);

    await expect(gateway.openTerminal("first:one", { columns: 80, rows: 24 })).resolves.toMatchObject({ message: "opened" });

    expect(firstSnapshots).toBe(0);
    expect(secondSnapshots).toBe(0);
  });

  test("returns a capability error when a source has no terminal", async () => {
    const adapterInstance = new MockApiRuntimeAdapter();
    const gateway = new RuntimeGateway([adapterInstance]);
    const response = await handleRuntimeRequest(
      new Request("http://127.0.0.1/api/runtime/agents/mock-api%3Aresearch/terminal", { method: "POST", body: "{}" }),
      gateway,
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({ error: "Mock API does not expose an interactive terminal." });
  });

  test("rejects oversized runtime request bodies before dispatch", async () => {
    const gateway = new RuntimeGateway([new MockApiRuntimeAdapter()]);
    const response = await handleRuntimeRequest(
      new Request("http://127.0.0.1/api/runtime/agents/mock-api%3Aresearch/terminal", {
        method: "POST",
        body: JSON.stringify({ columns: 80, rows: 24, padding: "x".repeat(70_000) }),
      }),
      gateway,
    );

    expect(response?.status).toBe(413);
    await expect(response?.json()).resolves.toEqual({ error: "Runtime request body is too large." });
  });

  test("rejects duplicate source identities", () => {
    const source: RuntimeSource = { id: "duplicate", kind: "other", label: "Duplicate" };
    expect(() => new RuntimeGateway([adapter(source, { available: true, agents: [] }), adapter(source, { available: true, agents: [] })])).toThrow(
      "Duplicate runtime source: duplicate",
    );
  });
  test("rejects requests addressed to a non-loopback host", async () => {
    const gateway = new RuntimeGateway([]);
    const response = await handleRuntimeRequest(
      new Request("http://evil.test:4311/api/runtime", { headers: { origin: "http://evil.test:4311" } }),
      gateway,
    );
    expect(response?.status).toBe(403);
  });

  test("accepts loopback hosts with a matching or absent origin", async () => {
    const gateway = new RuntimeGateway([]);
    for (const url of ["http://127.0.0.1:4311/api/runtime", "http://localhost:5173/api/runtime", "http://[::1]:4311/api/runtime"]) {
      const response = await handleRuntimeRequest(new Request(url, { headers: { origin: new URL(url).origin } }), gateway);
      expect(response?.status).toBe(200);
    }
    const noOrigin = await handleRuntimeRequest(new Request("http://127.0.0.1:4311/api/runtime"), gateway);
    expect(noOrigin?.status).toBe(200);
  });

  test("rejects malformed agent ids as a bad request", async () => {
    const gateway = new RuntimeGateway([]);
    const response = await handleRuntimeRequest(new Request("http://127.0.0.1:4311/api/runtime/agents/%E0%A4%A/changes"), gateway);
    expect(response?.status).toBe(400);
  });
});
