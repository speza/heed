#!/usr/bin/env bun

export interface ShellProcess {
  readonly exited: Promise<number>;
  kill(): void;
}

export async function waitForServer(
  port: string,
  child: ShellProcess,
  fetcher: (input: string) => Promise<Response> = fetch,
): Promise<void> {
  let childExitCode: number | undefined;
  const childExit = child.exited.then((code) => {
    childExitCode = code;
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (childExitCode !== undefined) throw new Error("The Heed runtime adapter exited before becoming ready.");
    try {
      const response = await fetcher(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const payload = await response.json() as { readonly service?: string };
        if (payload.service === "heed") return;
      }
    } catch {
      // The adapter is still starting.
    }
    if (childExitCode !== undefined) throw new Error("The Heed runtime adapter exited before becoming ready.");
    await Promise.race([new Promise<void>((resolve) => setTimeout(resolve, 100)), childExit]);
  }
  throw new Error("The Heed runtime adapter did not start.");
}

export async function runShell(): Promise<void> {
  const port = process.env.HEED_PORT ?? "4311";
  const server = Bun.spawn(["bun", "run", "server/index.ts"], {
    env: { ...process.env, HEED_PORT: port },
    stdout: "inherit",
    stderr: "inherit",
  });

  try {
    await waitForServer(port, server);
    const shell = Bun.spawn(["swift", "run", "HeedShell"], {
      env: { ...process.env, HEED_DEV_URL: `http://127.0.0.1:${port}/` },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exitCode = await shell.exited;
  } finally {
    server.kill();
    await server.exited;
  }
}

if (import.meta.main) await runShell();
