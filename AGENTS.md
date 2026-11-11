# Session Replay — agent context

> **Single source of truth for every coding agent** (Claude Code, Copilot, Codex, Cursor, …).
> Edit **this file only**. `CLAUDE.md` imports it, and `.github/copilot-instructions.md` is
> generated from it: run `bun run sync:agents` after editing (`bun run check:agents` fails if
> they're out of sync).

## What this project is

A session-replay tool for our module-federation React apps. A recorder in the browser captures
everything the user saw: the screen via rrweb, plus Redux state, network calls and console messages, in one
timeline. A Bun + Hono + SQLite server stores it, one deployment per region, and support staff
replay it in a web UI.

- **Status: planning.** No product code until the user approves the plan. v1 (the pilot) is plans
  02–08; MVP2 (analytics infrastructure, after the pilot) is plan 09.
- This repo is the **baseline**. The real integration happens later in the user's own workspace
  (webpack 5 host + Vite 7 module-federation remotes, Redux + React `useState`, flexlayout-react +
  AG Grid, on-prem OpenShift).

## Read the plan first

Every task comes from a plan file. Start with the master, then your sub-plan:

| Plan | Covers |
|---|---|
| `plan/01-session-replay.md` | **Master:** goal, scope, decisions D1–D44, batches B0–B5, open questions, risks; tasks X1–X2 |
| `plan/02-spikes.md` | Performance spike (incl. console load), rrweb gate patch, module-federation spike; tasks K1–K5 |
| `plan/03-protocol.md` | **Shared contracts:** events (incl. `sr:console`), ingest, config, bridge, query API, `@sr/protocol/secrets`; tasks T1–T2 |
| `plan/04-recorder.md` | `packages/recorder-engine`, `packages/recorder`; tasks R0–R11 |
| `plan/05-server.md` | `apps/server`, `deploy/openshift`; tasks S1–S15 |
| `plan/06-replay-ui.md` | `apps/replay-ui` (flexlayout workspace, Mantine 9, light/dark, Vite + React Compiler); tasks U0–U11 |
| `plan/07-state-plugin.md` | `packages/state-plugin`, `fixtures/apps`; tasks PL0–PL7 |
| `plan/08-integration.md` | How-to guide for the real workspace; tasks I1–I6 (I6: post-MVP grid data log spike) |
| `plan/09-analytics.md` | **MVP2:** analytics infrastructure: facts at ingest, `analytics.db`, backfill, `$dom` probe, query API + CLI; tasks AN0–AN5, AN7 |

A task's `owns:` list is the set of files you may change. If you need to touch anything else,
stop and ask.

## Layout

| Folder | What lives there |
|---|---|
| `apps/` | `server` (Bun + Hono + SQLite; also serves the replay UI), `replay-ui` (TanStack Router SPA: Mantine 9, flexlayout-react, React Compiler, built with Vite). |
| `packages/` | `protocol` (shared zod contracts; entries `.`, `/publish` and `/secrets`, the last two with no imports), `recorder-engine` (the only rrweb importer), `recorder` (browser recorder), `state-plugin` (unplugin build plugin). |
| `fixtures/apps/` | Apps that imitate the real workspace, for tests. |
| `deploy/openshift/` | Per-region manifests. |
| `docs/integration/`, `examples/` | Integration guide material. |
| `docs/design/replay-ui/` | Static HTML mocks of the replay UI, light and dark (06 U0). Open `index.html` from disk. Never published. |
| `e2e/` | Gate-2 browser specs and their host page (task X2); `e2e/analytics/` in MVP2. |
| `spike/` | Throwaway experiments. Never imported by `apps/` or `packages/`. |
| `plan/` | Plan files. **Only the lead/planning session edits them**; coding agents report changes instead. |
| `scripts/` | Repo tooling (e.g. `sync-agent-context.ts`). |

## Commands

- Install: `bun install` at the repo root (one lockfile for all workspaces).
- Spike demo: `bun run spike` → demo http://localhost:3300, replay UI http://localhost:3300/replay.
- Sync agent context after editing this file: `bun run sync:agents`; verify with `bun run check:agents`.
- Type-check / tests: `bunx tsc --noEmit` and `bun test` (set up in batch B1).

**Tooling:** use Bun, never Node: `bun`, `bunx`, `bun add`, `bun test`. Node isn't on the PATH.
The one exception to Bun's bundler is `apps/replay-ui`, which builds with **Vite run under Bun**
(`bun --bun vite`; 06 L1), because React Compiler needs it in dev.

## Hard rules

1. **Contract first.** Shapes that cross a boundary live in `packages/protocol` (plan 03). Changes there are **additive only** and need the plan owner's approval. The recorder and app bundles import only the zod-free entries (`@sr/protocol/publish`, `@sr/protocol/secrets`) or use `import type`.
2. **Only `packages/recorder-engine` imports rrweb.** Pin every `@rrweb/*` package to one exact version.
3. **The recorder has no framework dependencies.** No React and no state libraries: it runs outside every mini-app.
4. **Never record secrets:** password fields, one-time codes, auth tokens (JWT/`Bearer`, `token`-style URL parameters, passwords in URLs) and secret-named keys, in state **and in console lines** (D43). Mask or strip them in the browser before anything is sent. Use `isSecretKey` and `maskCutToken` from `@sr/protocol/secrets`; never copy the list. In the MVP everything else is recorded unmasked on purpose (plan 01, D18).
5. **App performance first.** The recorder must stay inside the budget in plan 01 → Acceptance → Performance. When in doubt, it pauses and shows a band. Anything that runs per app call (the console wrapper, the DOM probe) applies its limit **before** it formats or queries, and passes straight through while recording is paused.
6. **Replay never runs app code or fires live requests.** The rrweb Replayer stays sandboxed, and the replay UI sends a strict CSP. Never enable `UNSAFE_replayCanvas`.
7. **The server acks only after commit.** SQLite needs local block storage, never NFS/CephFS.
8. **One owner per file among tasks that run at the same time.** Shared root files (`package.json`, `tsconfig.base.json`, `.gitignore`) change only through the root scaffold task (X1), a task whose `owns:` names them, or the plan owner.
9. **Long-lived data holds no free text** (MVP2, plan 09). Analytics summaries are kept 13 months: name things by stable ids (grid and column ids, `data-sr-*`, aria labels), never by cell or link text, and keep example text only in the 30-day tables. Analytics stays off (`analytics.extract`, `analytics.api`) until access is decided.

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
