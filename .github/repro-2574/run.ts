import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("This harness requires a native Windows runner.");
}

const root = process.cwd();

const logs = process.env.REPRO_LOG_DIR;

if (!logs) {
  throw new Error("REPRO_LOG_DIR is required.");
}

await mkdir(logs, { recursive: true });

const preload = join(
  dirname(fileURLToPath(import.meta.url)),
  "interference.ts"
);

const test = "src/services/meet-recording-import.test.ts";

const meta = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });

console.log(
  "Revision:",
  meta.stdout.toString().trim(),
  "Bun:",
  Bun.version,
  process.platform
);

for (const mode of [
  "shard",
  "alone",
  "interference",
  "alone",
  "interference",
]) {
  const sandbox = await mkdtemp(join(tmpdir(), "pr2574-repro-"));

  try {
    const args =
      mode === "shard"
        ? ["test", "--shard=4/4", "--parallel=2", "--timeout=30000"]
        : [
            "test",
            test,
            "--timeout=30000",
            ...(mode === "interference" ? ["--preload", preload] : []),
          ];

    const child = Bun.spawnSync([process.execPath, ...args], {
      cwd: join(root, "apps/server"),
      env: {
        ...process.env,
        NO_COLOR: "1",
        TEMP: sandbox,
        TMP: sandbox,
        TMPDIR: sandbox,
      },
      timeout: 240_000,
    });

    const output = child.stdout.toString() + child.stderr.toString();
    const stamp = Date.now();
    await Bun.write(join(logs, `${mode}-${stamp}.log`), output);
    console.log(mode, "exit", child.exitCode);
    console.log(output.split("\n").slice(-15).join("\n"));

    if (mode === "alone" && child.exitCode !== 0) {
      throw new Error("The isolated control must pass.");
    }

    if (
      mode === "interference" &&
      !(
        child.exitCode === 1 &&
        output.includes("expect(after).toEqual(before)") &&
        output.includes("nakama-meet-capture-test-")
      )
    ) {
      throw new Error(
        "Expected the shared-temp snapshot failure, not a different failure."
      );
    }
  } finally {
    await rm(sandbox, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 200,
    });
  }
}
