# Session Replay

Records user sessions in our module-federation React apps (screen via rrweb, plus app state and
network events) and lets support replay them. Bun workspaces monorepo; Bun is the runtime and
package manager.

## Layout

| Folder | What lives there |
|---|---|
| `apps/` | Deployable apps: `server` (Bun + Hono + SQLite), `replay-ui` (support UI). Not created yet. |
| `packages/` | Shared libraries: `recorder` (browser), event types, build plugin for state capture. Not created yet. |
| `spike/` | Throwaway experiments. Never imported by `apps/` or `packages/`. |
| `plan/` | One plan file per feature: `plan/NN-name.md`. |

## Commits

This workspace uses numbered commits. Before starting a new change, commit whatever the last change left uncommitted. Each change gets its own commit.

- **Format:** `NNNN: <one-line summary>`, for example `0007: fix empty grid on first load`.
- **Next number:** take the highest existing `NNNN` and add 1. `git log --all -E --grep='^[0-9]{4}: ' --format=%s | sort -r | head -1` shows the latest one. Start at `0001`.
- Git history is the only counter. Don't keep a counter file. Never reuse or renumber a number.
- Before committing, read `git status` and stage files by name. Never stage secrets (`.env`, `*.credentials.json`, keys).
- `.gitignore` is deny-by-default: a new file type must be allowed there on purpose.
- These are local commits only. Push only when asked.

## For agents

What every agent brief would otherwise repeat. Agents read this first.

**Install:** `bun install` at the repo root (one lockfile for all workspaces).

**Dev server (spike):** `bun run spike` → demo app http://localhost:3300, replay UI http://localhost:3300/replay.
Start it once and reuse it. Put a time limit on waits.

**Test tiers:** not set up yet. Fill in when `apps/` and `packages/` exist.

**Project rules:**
- Recorder code must not depend on React or any state library: it runs outside every mini-app.
- Never record secrets (password fields, one-time codes, auth tokens, secret-named state keys): mask or strip them in the browser, before anything is sent. In the MVP everything else is recorded unmasked on purpose (`plan/01-session-replay.md`, D18).
