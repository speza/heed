#!/usr/bin/env bun

export {};

const port = process.env.HEED_PORT ?? "4311";
const server = Bun.spawn(["bun", "run", "server/index.ts"], {
  env: { ...process.env, HEED_PORT: port },
  stdout: "inherit",
  stderr: "inherit",
});

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {
      // The adapter is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error("The Heed runtime adapter did not start.");
}

try {
  await waitForServer();
  const shell = Bun.spawn(["swift", "run", "HeedShell"], {
    env: { ...process.env, MINIMAL_ADE_DEV_URL: `http://127.0.0.1:${port}/` },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await shell.exited;
} finally {
  server.kill();
  await server.exited;
}
