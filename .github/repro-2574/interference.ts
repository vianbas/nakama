import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const readdir = fs.readdir;
let created = false;

spyOn(fs, "readdir").mockImplementation(async (...args) => {
  const entries = await readdir(...args);
  if (!created && resolve(String(args[0])) === resolve(tmpdir())) {
    created = true;
    const directory = await fs.mkdtemp(
      join(tmpdir(), "nakama-meet-capture-test-")
    );
    console.log(
      "Controlled sibling created after first temp snapshot:",
      directory
    );
  }
  return entries;
});
