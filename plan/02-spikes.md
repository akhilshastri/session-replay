# 02 — Spikes (P1 performance, P1a gate, P1b module federation)
Status: draft · Size: medium · Parent: [01-session-replay.md](01-session-replay.md)

## Goal

Answer the two riskiest unknowns **with measurements, before any production code**:

1. **P1:** can rrweb record every UI state on our real busiest screen within the performance
   budget? If not, which rate caps (D36) make it fit?
2. **P1b:** does the build plugin's call-site transform capture Redux stores under module
   federation (webpack 5 host + Vite 7 remote, `redux` shared as a singleton) without breaking
   sharing?

Spikes are throwaway (`spike/*`, never imported). Their output is **numbers and findings written
back into the plans**, not code to keep.

## Decisions

Inherits D8, D11, D16, D23, D36, D39 and the confirmed budget (parent Acceptance → Performance).

| # | Decision | Why |
|---|---|---|
| L1 | P1 and P1b run **in parallel** (batch B0). P1a runs first inside the P1 lane. | They share no files; P1 needs the gate to measure (a) against (c). |
| L2 | The P1 workload is **seeded and deterministic**: the same tick sequence on every run and variant. | A/B numbers are comparable only if the input is identical. |
| L3 | Measure in **real Chrome on Windows** (the users' browser), driven over CDP, not in headless-only mode. | LoAF, memory and timer behaviour differ in headless mode and in throttled background windows (seen in the 0002 spike). |
| L4 | P1 mimics **how the real app pushes ticks** into AG Grid (Q24). | Transactions, `setDataValue` and replacing `rowData` each produce very different DOM mutation patterns. |

## Design

### P1a — the `mutationGate` patch (lane 1, first)

The ~6-line hook D23(c) needs, carried with `bun patch` on the pinned `@rrweb/record`:

```diff
# Sample — not final code. Exact location verified in P1a (architect: record.js ~:1946).
- const observer = new mutationObserverCtor(
-   callbackWrapper(mutationBuffer.processMutations.bind(mutationBuffer)));
+ // SR-PATCH 1: let the host hold or coalesce records before rrweb processes them.
+ const process = mutationBuffer.processMutations.bind(mutationBuffer);
+ const gate = options.mutationGate;
+ const observer = new mutationObserverCtor(
+   callbackWrapper(gate ? (records) => gate(records, process, rootEl) : process));
```

The option must also be passed through `record()` and the shadow-DOM `bypassOptions` (architect
report). P1a ends with a self-check: `record({ mutationGate })` must call the gate at least once on
a test page, and the engine's `gateActive` flag must say so.

```bash
# How the patch is made and kept (Bun reads patchedDependencies only from the root package.json)
bun patch @rrweb/record          # opens an editable copy in node_modules
# …edit dist/record.js…
bun patch --commit node_modules/@rrweb/record   # writes patches/@rrweb%2Frecord@<ver>.patch
```

### P1 — performance stress test (lane 1, after P1a)

**The real screen** (user, Q2/Q2b):
- flexlayout-react with 10–25 grid tabs; visible and visited tabs are mounted;
- 4 busy AG Grids of up to 100 rows, open all day;
- per row, up to 4 market-data cells at 4 ticks/s, and up to 6 slower cells at about 1/s (*assumption*);
- ≈ 3,100 cell changes/s with about 35 rows rendered, ≈ 8,800/s with all 100 rendered, and cell flash adds 2–3 attribute mutations per change.

**Scenarios:**

| Id | Busy grids | Hidden mounted tabs | Rows rendered | Notes |
|---|---|---|---|---|
| S1 typical | 1 | 3 | ~35 | |
| S2 real max | 4 | 10 | ~35 | sorted on a live column |
| S3 stress | 4 | 25 | 100 | the self-budget must degrade, not jank |

Each runs with cell flash on and off, and at half, real and double the tick rate.

**Variants:**
- recorder off; `full`; `block` (the floor);
- D36 rate caps (1 / 2 / 4 states/s on the market-data columns), with emit-level (a) and with the gate (c);
- the upload pipeline on the main thread vs in `sr-worker.js` (decides D11);
- a do-nothing MutationObserver (the browser's own cost).

**Workload extras:** a 2 MB Redux store taking 200 actions/s on a deny-listed slice plus 5/s app
actions; 2 fetches/s; realistic typing (about 8 keys/s in bursts) plus a click every 3 s; route
changes and periodic checkpoints.

**Runs:** 5 min × 3 per variant (median), unthrottled and at 4× CPU throttling. An **8-hour soak** of S2.

```ts
// Sample — not final code: a seeded ticker that mimics the real tick profile (L2, L4).
import type { GridApi } from 'ag-grid-community';

const mulberry32 = (seed: number) => () => {           // tiny deterministic RNG
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const FAST = ['bid', 'ask', 'mid', 'last'];            // 4 ticks/s
const SLOW = ['execQty', 'notional', 'total', 'pnl', 'avgPx', 'filled']; // ~1 tick/s (assumption)

export const startTicker = (api: GridApi, rows: number, rate = 1, seed = 42) => {
  const rnd = mulberry32(seed);
  const fastEvery = 250 / rate;                         // 4/s at rate 1
  const fast = setInterval(() => {
    const update = Array.from({ length: rows }, (_, i) => ({
      id: `r${i}`, ...Object.fromEntries(FAST.map((c) => [c, +(100 + rnd() * 5).toFixed(2)])),
    }));
    // Replace with the real app's method once Q24 is answered (setDataValue vs transactions).
    api.applyTransaction({ update });
  }, fastEvery);
  const slow = setInterval(() => { /* same for SLOW columns at 1/s × rate */ }, 1000 / rate);
  return () => { clearInterval(fast); clearInterval(slow); };
};
```

```ts
// Sample — not final code: collecting metrics from real Chrome over CDP (L3).
// The page also registers: new PerformanceObserver(l => …).observe({ type: 'long-animation-frame', buffered: true })
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const before = await cdp.send('Performance.getMetrics');   // ScriptDuration, TaskDuration, JSHeapUsedSize
await page.waitForTimeout(5 * 60_000);
const after = await cdp.send('Performance.getMetrics');
const loaf = await page.evaluate(() => (window as any).__loaf);   // LoAF entries with script attribution
// Report: Δ ScriptDuration / wall-clock = main-thread %, per variant; LoAF frames ≥ 50 ms with recorder ≥ 10 ms.
```

**Metrics:**
- main-thread % from `Performance.getMetrics` deltas, and Profiler self-time per script file (serve `recorder.iife.js` and `sr-worker.js` as separate files so they're attributable);
- LoAF frames with attribution; Event Timing for clicks and keys;
- memory via `measureUserAgentSpecificMemory()` (needs COOP/COEP on the spike server);
- gzip bytes/min at the server;
- checkpoint duration, `postMessage` copy time, flush time inside a click;
- the record mix per cell update (`textContent` childList vs `nodeValue` characterData);
- an exactness hash at each action;
- **whether hidden mounted tabs still mutate the DOM**, and how much they add to snapshot size and time.

**Decision rules** (written back into plan 01 when P1 ends):
- If `full` meets the budget at S2: no default caps. D36 stays a tool for later.
- Else: choose the default caps per desk (Q19) from the curve. Use (c) if (a) can't meet the budget at S2.
- Worker: on if the main-thread pipeline costs more than about 0.5 % CPU at S2 (D11).
- If a checkpoint at S2 takes 50 ms or more: tune the snapshot fallback defaults.

### P1b — module federation call-site transform (lane 2, parallel)

```ts
// Sample — not final code. Before (app source):
import { createStore, applyMiddleware } from 'redux';
export const store = createStore(rootReducer, applyMiddleware(thunk));

// After the transform: the import specifier is unchanged, only the local binding is renamed (D4).
import { createStore as __sr$createStore, applyMiddleware } from 'redux';
import { wrapCreateStore as __srWrap } from '@sr/state-plugin/runtime';
const createStore = __srWrap(__sr$createStore, { app: 'blotter', file: 'src/store.ts' });
export const store = createStore(rootReducer, applyMiddleware(thunk));
```

**Fixture topology:**

```
spike/mf-plugin/
  host-webpack5/      React 17, ModuleFederationPlugin, shares redux as singleton, built WITH the plugin
  remote-vite7/       React 18, @module-federation/vite, shares redux, built WITH the plugin
  remote-plain/       React 18, built WITHOUT the plugin (must not break; shows a "no-state" band)
  early-store/        a store created at import time, before the recorder script loads
```

**Done when:**
- Redux actions from the host and from `remote-vite7` reach the bridge queue;
- `redux` is still loaded once (check `__FEDERATION__` share scope / network);
- `remote-plain` works unchanged;
- the early store is registered once the recorder starts;
- a wrong plugin order fails the build with the planned message.

## Guidelines

- Keep spikes ugly and fast. Don't build the real packages here; copy only what's needed.
- Same seed, same tick sequence, same machine for every variant. Close other apps while measuring.
- Record raw numbers in `spike/perf-grid/results/*.json` (gitignored), and the summary table in this plan.
- Write down every surprise in this plan's Log, even when it doesn't change a decision.

## Acceptance

- [ ] P1a: the gate fires on a test page; `gateActive` is true; un-patching sets it to false and the engine falls back to (a).
- [ ] P1: a results table for S1/S2/S3 × variants is in this plan, with the decision rules applied and D11, D36 defaults and Q19 written back to plan 01.
- [ ] P1: the hidden-tab question is answered with evidence.
- [ ] P1b: all five "done when" points pass for webpack 5 and Vite 7.

## Tasks

- [ ] **S1 P1a gate patch** — owns: `patches/`, root `package.json` (`patchedDependencies`), `.gitignore` (allow `*.patch`) — batch: **B0, lane 1** — depends on: — — done when: P1a acceptance passes.
- [ ] **S2 P1 harness** (stress page + ticker + CDP collector) — owns: `spike/perf-grid/` — batch: **B0, lane 1** — depends on: S1, Q24 — done when: one variant produces a full metrics JSON.
- [ ] **S3 P1 measurement runs + soak** — owns: `spike/perf-grid/results/` — batch: **B0, lane 1** — depends on: S2 — done when: the P1 acceptance items pass. The leader runs the long runs in the background with Bash; no agent sits idle during the 8-hour soak.
- [ ] **S4 P1b MF transform spike** — owns: `spike/mf-plugin/` — batch: **B0, lane 2** — depends on: — — done when: the P1b acceptance passes.

## Risks

| Risk | Mitigation |
|---|---|
| The ticker doesn't match the real app's update method, so the numbers mislead. | Q24 before S2; mirror the real code path. |
| A Windows desktop throttles a background Chrome window, skewing timings (seen in the 0002 spike). | Run in a dedicated, visible, focused window; repeat ×3 and take the median. |
| An 8-hour soak blocks the dev machine. | Run it overnight, in the background, outside agent runs. |

## Open questions

- **Q24:** how does the real app push ticks into AG Grid: `applyTransaction`, `applyTransactionAsync`, `rowNode.setDataValue`, or replacing `rowData`? And is cell flash on?

## Log

- 2026-11-10 — Created from plan 01's P1/P1a/P1b tasks when the user asked to split the plan (leader).
