import { describe, expect, test } from "vitest";
import { waitForServer, type ShellProcess } from "./shell";

function child(): { process: ShellProcess; exit: (code: number) => void } {
  let resolveExit!: (code: number) => void;
  const process: ShellProcess = {
    exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
    kill: () => undefined,
  };
  return { process, exit: resolveExit };
}

describe("Heed shell readiness", () => {
  test("requires the Heed-specific health response", async () => {
    const fake = child();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return new Response(JSON.stringify(calls === 1 ? { service: "other" } : { service: "heed" }), { status: 200 });
    };

    await waitForServer("4311", fake.process, fetcher);

    expect(calls).toBe(2);
    fake.exit(0);
  });

  test("stops waiting when the spawned adapter exits", async () => {
    const fake = child();
    const pending = waitForServer("4311", fake.process, async () => {
      fake.exit(1);
      throw new Error("connection refused");
    });

    await expect(pending).rejects.toThrow("exited before becoming ready");
  });
});
