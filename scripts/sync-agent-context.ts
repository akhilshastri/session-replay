/**
 * Keeps `.github/copilot-instructions.md` in sync with `AGENTS.md`.
 *
 * AGENTS.md is the single source of truth for every coding agent. Claude Code imports it via
 * `@AGENTS.md` in CLAUDE.md; Copilot has no import syntax, so we generate a copy instead.
 *
 * Usage (root package.json scripts):
 *   bun run sync:agents   write the generated file
 *   bun run check:agents  exit 1 if the generated file is missing or stale
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Resolve from the repo root so the script works from any current directory.
const repoRoot = resolve(import.meta.dir, "..");
const sourcePath = join(repoRoot, "AGENTS.md");
const targetPath = join(repoRoot, ".github", "copilot-instructions.md");

const HEADER =
  "<!-- GENERATED from AGENTS.md by scripts/sync-agent-context.ts. Do not edit; edit AGENTS.md and run `bun run sync:agents`. -->";

// git autocrlf can turn either file into CRLF on checkout; compare on LF only.
const normalizeEol = (text: string) => text.replace(/\r\n/g, "\n");

const buildExpected = async () => `${HEADER}\n\n${await Bun.file(sourcePath).text()}`;

const write = async () => {
  await mkdir(dirname(targetPath), { recursive: true });
  await Bun.write(targetPath, await buildExpected());
  console.log("wrote .github/copilot-instructions.md from AGENTS.md");
};

const check = async () => {
  const inSync =
    existsSync(targetPath) &&
    normalizeEol(await Bun.file(targetPath).text()) === normalizeEol(await buildExpected());
  if (inSync) {
    console.log("in sync");
    return;
  }
  console.error("out of sync: run bun run sync:agents");
  process.exit(1);
};

if (process.argv.includes("--check")) await check();
else await write();
