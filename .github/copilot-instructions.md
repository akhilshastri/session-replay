<!-- GENERATED from AGENTS.md by scripts/sync-agent-context.ts. Do not edit; edit AGENTS.md and run `bun run sync:agents`. -->

# Session Replay — agent context

> **Single source of truth for every coding agent** (Claude Code, Copilot, Codex, Cursor, …).
> Edit **this file only**. `CLAUDE.md` imports it, and `.github/copilot-instructions.md` is
> generated from it: run `bun run sync:agents` after editing (`bun run check:agents` fails if
> they're out of sync).

## What this project is

A session-replay tool for our module-federation React apps. A recorder in the browser captures
everything the user saw: the screen via rrweb, plus Redux state and network calls, in one
timeline. A Bun + Hono + SQLite server stores it, one deployment per region, and support staff
replay it in a web UI.

- **Status: planning.** No product code until the user approves the plan.
- This repo is the **baseline**. The real integration happens later in the user's own workspace
  (webpack 5 host + Vite 7 module-federation remotes, Redux + React `useState`, flexlayout-react +
  AG Grid, on-prem OpenShift).

## Read the plan first

Every task comes from a plan file. Start with the master, then your sub-plan:

| Plan | Covers |
|---|---|
| `plan/01-session-replay.md` | **Master:** goal, scope, decisions D1–D39, batches B0–B5, risks |
| `plan/02-spikes.md` | Performance spike, rrweb gate patch, module-federation spike |
| `plan/03-protocol.md` | **Shared contracts:** events, ingest, config, bridge, query API |
| `plan/04-recorder.md` | `packages/recorder-engine`, `packages/recorder` |
| `plan/05-server.md` | `apps/server`, `deploy/openshift` |
| `plan/06-replay-ui.md` | `apps/replay-ui` |
| `plan/07-state-plugin.md` | `packages/state-plugin`, `fixtures/apps` |
| `plan/08-integration.md` | How-to guide for the real workspace |

A task's `owns:` list is the set of files you may change. If you need to touch anything else,
stop and ask.

## Layout

| Folder | What lives there |
|---|---|
| `apps/` | `server` (Bun + Hono + SQLite; also serves the replay UI), `replay-ui` (TanStack Router SPA). |
| `packages/` | `protocol` (shared zod contracts), `recorder-engine` (the only rrweb importer), `recorder` (browser recorder), `state-plugin` (unplugin build plugin). |
| `fixtures/apps/` | Apps that imitate the real workspace, for tests. |
| `deploy/openshift/` | Per-region manifests. |
| `docs/integration/`, `examples/` | Integration guide material. |
| `spike/` | Throwaway experiments. Never imported by `apps/` or `packages/`. |
| `plan/` | Plan files. **Only the lead/planning session edits them**; coding agents report changes instead. |
| `scripts/` | Repo tooling (e.g. `sync-agent-context.ts`). |

## Commands

- Install: `bun install` at the repo root (one lockfile for all workspaces).
- Spike demo: `bun run spike` → demo http://localhost:3300, replay UI http://localhost:3300/replay.
- Sync agent context after editing this file: `bun run sync:agents`; verify with `bun run check:agents`.
- Type-check / tests: `bunx tsc --noEmit` and `bun test` (set up in batch B1).

**Tooling:** use Bun, never Node: `bun`, `bunx`, `bun add`, `bun test`. Node isn't on the PATH.

## Hard rules

1. **Contract first.** Shapes that cross a boundary live in `packages/protocol` (plan 03). Changes there are **additive only** and need the plan owner's approval.
2. **Only `packages/recorder-engine` imports rrweb.** Pin every `@rrweb/*` package to one exact version.
3. **The recorder has no framework dependencies.** No React and no state libraries: it runs outside every mini-app.
4. **Never record secrets:** password fields, one-time codes, auth tokens (JWT/`Bearer`, `token`-style URL parameters) and secret-named state keys. Mask or strip them in the browser before anything is sent. In the MVP everything else is recorded unmasked on purpose (plan 01, D18).
5. **App performance first.** The recorder must stay inside the budget in plan 01 → Acceptance → Performance. When in doubt, it pauses and shows a band.
6. **Replay never runs app code or fires live requests.** The rrweb Replayer stays sandboxed, and the replay UI sends a strict CSP. Never enable `UNSAFE_replayCanvas`.
7. **The server acks only after commit.** SQLite needs local block storage, never NFS/CephFS.
8. **One owner per file inside a batch.** Shared root files (`package.json`, `tsconfig.base.json`, `.gitignore`) change only through the scaffold task or the plan owner.

## Code style

- Write for the next reader: small single-purpose functions, early returns, descriptive names.
- TypeScript: `const fn = () => {}` over `function` declarations (except where hoisting or `this` is needed).
- Comments explain **why**, not what. Non-trivial modules start with a short header: what the module owns, how it fits in, and its main dependents.
- Prefer a proven package to hand-rolled code; check `package.json` first.
- Explanations and docs use simple language: short sentences, jargon defined once, a concrete example over an abstract one.

## Verifying

- Each task runs **tier-1 checks** for the packages it touched: type-check, lint and unit tests.
- e2e runs once per batch gate, not per task.
- Report the commands you ran and their results. If something fails, say so and show the output.

## Commits

- Numbered: `NNNN: <one-line summary>`, e.g. `0007: fix empty grid on first load`. Take the highest existing number + 1 (`git log --all -E --grep='^[0-9]{4}: ' --format=%s | sort -r | head -1`). Never reuse or renumber a number.
- Before starting a new change, commit what the last change left uncommitted. One change, one commit.
- Stage files **by name** (never `git add -A` / `.`), after reading the full `git status`.
- `.gitignore` is deny-by-default: a new file type must be allowed there on purpose.
- Never stage secrets (`.env*`, `*.credentials.json`, keys).
- No AI co-author trailers in commit messages.
- Local commits only. Push only when the user asks.
