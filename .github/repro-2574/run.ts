import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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

const harness = dirname(fileURLToPath(import.meta.url));

const applied = Bun.spawnSync(["git", "apply", join(harness, "fix.patch")], {
  cwd: root,
});

if (applied.exitCode !== 0) {
  throw new Error(applied.stderr.toString());
}

const service = join(root, "apps/server/src/services/meet-recording-import.ts");

const original = await Bun.file(service).text();

for (const mode of [
  "fixed-shard",
  "fixed-interference",
  "fixed-interference",
  "fixed-interference",
  "fixed-interference",
  "fixed-interference",
  "leak-success",
  "leak-error",
]) {
  const sandbox = await mkdtemp(join(tmpdir(), "pr2574-fixed-"));

  try {
    if (mode === "leak-success") {
      const changed = original.replace(
        "    await rm(directory, { force: true, recursive: true });\n  }\n}",
        "    // Diagnostic mutation: omit cleanup.\n  }\n}"
      );

      if (changed === original) {
        throw new Error("Success cleanup mutation did not apply.");
      }

      await Bun.write(service, changed);
    }

    if (mode === "leak-error") {
      const changed = original
        .replace(
          "  try {\n    const video = join(directory,",
          "  let completed = false;\n  try {\n    const video = join(directory,"
        )
        .replace(
          "    return { filename: recording.name,",
          "    completed = true;\n    return { filename: recording.name,"
        )
        .replace(
          "    await rm(directory, { force: true, recursive: true });\n  }\n}",
          "    if (completed) await rm(directory, { force: true, recursive: true });\n  }\n}"
        );

      if (changed === original || !changed.includes("completed = true;")) {
        throw new Error("Error cleanup mutation did not apply.");
      }

      await Bun.write(service, changed);
    }

    const args =
      mode === "fixed-shard"
        ? ["test", "--shard=4/4", "--parallel=2", "--timeout=30000"]
        : [
            "test",
            test,
            "--timeout=30000",
            ...(mode === "fixed-interference" ? ["--preload", preload] : []),
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
    await Bun.write(join(logs, `${mode}-${Date.now()}.log`), output);
    console.log(mode, "exit", child.exitCode);
    console.log(output.split("\n").slice(-15).join("\n"));

    if (mode.startsWith("fixed-") && child.exitCode !== 0) {
      throw new Error("Fixed tests must pass.");
    }

    if (
      mode === "fixed-interference" &&
      !(await readdir(sandbox)).some((name) =>
        name.startsWith("nakama-meet-capture-test-")
      )
    ) {
      throw new Error("The unrelated test directory must remain intact.");
    }

    if (
      mode.startsWith("leak-") &&
      !(child.exitCode === 1 && /nakama-meet-\d+-/.test(output))
    ) {
      throw new Error(
        "The cleanup test must reject a leaked import directory."
      );
    }

    if (
      mode === "leak-error" &&
      output.includes("expect(after).toEqual(before)")
    ) {
      throw new Error(
        "The error mutation must reach the final cleanup assertion."
      );
    }
  } finally {
    await Bun.write(service, original);
    await rm(sandbox, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 200,
    });
  }
}

const clean = Bun.spawnSync(["git", "diff", "--exit-code", "--", service], {
  cwd: root,
});

if (clean.exitCode !== 0) {
  throw new Error("Diagnostic mutations were not restored.");
}
