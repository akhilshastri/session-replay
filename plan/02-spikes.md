# 02 — Spikes (P1 performance, P1a gate, P1b module federation)
Status: draft · Size: medium · Parent: [01-session-replay.md](01-session-replay.md)

## Goal

Answer the riskiest unknowns **with measurements, before any production code**:

1. **P1:** can rrweb record every UI state on our real busiest screen within the performance
   budget, and **how many bytes per minute** does that upload? If it doesn't fit, which source
   fixes (D32) or rate caps (D36) make it fit?
2. **P1b:** does the build plugin's call-site transform capture Redux stores under module
   federation (webpack 5 host + Vite 7 remote, `redux` shared as a singleton) without breaking
   sharing?
3. **K5 (later, in B4):** do the budget, startup time and seek time still hold with the **built**
   `sr-loader.js` and `sr-recorder.js`, not the spike's own code?

Spikes are throwaway (`spike/*`, never imported). Their output is **numbers and findings written
back into the plans**, not code to keep.

## Decisions

Inherits D1 (one rrweb pin), D8, D11, D16, D23 (gate-only rate caps), D32, D36, D39 and the
confirmed budget (parent Acceptance → Performance).

| # | Decision | Why |
|---|---|---|
| L1 | **K1 (gate patch), K2 (P1 harness) and K4 (P1b) run in parallel** at B0 start. The rate-cap variants run once K1 lands; every other variant runs without the gate. | They share no files. Only the cap variants need the patch, so the harness doesn't wait for it. |
| L2 | The P1 workload is **seeded and deterministic**: the same tick sequence on every run and variant. | A/B numbers are comparable only if the input is identical. |
| L3 | Measure in **real Chrome on Windows** (the users' browser), driven over CDP, not in headless-only mode. | LoAF, memory and timer behaviour differ in headless mode and in throttled background windows (seen in the 0002 spike). |
| L4 | P1 mimics **how the real app pushes ticks** into AG Grid (Q24). | Transactions, `setDataValue` and replacing `rowData` each produce very different DOM mutation patterns. |
| L5 | **One rrweb pin for everything** (D1, devil X24). At B0 start the leader picks the newest `@rrweb/*` release that is at least 2 weeks old, with every `@rrweb/*` package on that exact version, and logs it here and in 01. The spikes, the K1 patch and production (R1) all use it. | Numbers measured on another version don't hold for production. The patch is version-specific, and Bun applies `patchedDependencies` only to that exact version. |
| L6 | **Bytes per minute are a headline result:** raw and gzip bytes/min per scenario, plus the full-snapshot size and time. The quota, rate limits, PVC size, ingest body limit and the S1 upload target are derived from them (architect A1, 05-L11). | The sizing in 01 Ops is a first assumption (about 100 KB/min for a busy grid). The architect estimates 1.5–7 MB/min gzip per busy user at S2, so storage and limits can't be set without P1. |
| L7 | **K5 re-runs the P1 harness on the built bundles** in B4, with the shipped defaults. | Minification, IIFE wrapping, the loader path and the real pipeline can all change the cost. 01's acceptance needs the numbers from what ships (devil X24). |

## Design

### P1a — the `mutationGate` patch (K1)

The ~6-line hook D23 needs, carried with `bun patch` on the pinned `@rrweb/record`. It adds a
`mutationGate` option to `record()` and exports a `mutationGateVersion` number. The gate gets each
batch of MutationRecords **and a `release` function**: the engine holds a capped cell's records,
and later hands them back through `release`, in order. rrweb then processes them against the live
DOM, so it builds the adds, removes and node ids itself (D23).

```diff
# Sample — not final code. In 2.2.2 the observer is created at record.js:1945–1946; K1 re-checks it on the pin (L5).
  const [ObserverCtor, releaseObserverConstructor] = mutationObserverCtor();
- const observer = new ObserverCtor(callbackWrapper(mutationBuffer.processMutations.bind(mutationBuffer)));
+ // SR-PATCH 1 (02 K1): the host may hold records and hand them back, in order, through release.
+ const process = mutationBuffer.processMutations.bind(mutationBuffer);
+ const gate = options.mutationGate;          // (records, release) => void
+ const release = callbackWrapper(process);   // release(heldRecords): rrweb processes them now
+ const observer = new ObserverCtor(callbackWrapper(gate ? (records) => gate(records, release) : process));
  …
- export { record };
+ const mutationGateVersion = 1;              // SR-PATCH 1: the engine reads this to set gateActive
+ export { mutationGateVersion, record };
```

- **Pass-through:** the option must also travel from `record()` into the observer options and the
  shadow-DOM and iframe `bypassOptions`, so every MutationObserver rrweb creates gets the gate
  (architect report). The patch also adds both names to `dist/index.d.ts`.
- **Detection:** the engine sets `gateActive = typeof mutationGateVersion === 'number'`. It reads
  the export through a namespace import (`import * as rr from '@rrweb/record'`), so an unpatched
  build still links instead of failing on a missing named export.
- **Release order:** held records are always released before a checkpoint, `stop`,
  `setRateCaps` and a `record()` restart, and at every user action (D23, devil X6). That rule
  lives in the engine (04 R9); K1 only proves the hook.
- **Self-check:** `record({ mutationGate })` calls the gate at least once on a test page;
  records released later, out of the callback, produce events that replay with zero "node not
  found" warnings; removing the patch makes `gateActive` false.

```bash
# How the patch is made and kept (Bun reads patchedDependencies only from the root package.json)
bun patch @rrweb/record          # opens an editable copy in node_modules
# …edit dist/record.js and dist/index.d.ts…
bun patch --commit node_modules/@rrweb/record   # writes patches/@rrweb%2Frecord@<pin>.patch
```

### P1 — performance stress test (K2 harness, K3 runs)

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

**Variants:**
- recorder off; `full`; `block` (the floor); a do-nothing MutationObserver (the browser's own cost);
- **source fixes** (D32, architect A2), each with `full`, and all three together:
  - a cell renderer whose `refresh()` sets an existing Text node's `nodeValue` (one small
    characterData record per change, instead of a childList remove + add);
  - cell flash off on the fast (market-data) columns;
  - grids in hidden flexlayout tabs suspended (no DOM updates while hidden, one refresh on show);
- **D36 rate caps through the gate** (D23): 1 / 2 / 4 states/s on the market-data columns, with a
  release at every click and key press. These need K1;
- the upload pipeline on the main thread vs in `sr-worker.js` (decides D11).

**Workload extras:**
- a 2 MB Redux store taking 200 actions/s on a deny-listed slice, plus 5/s app actions;
- **a large audit slice** (devil X11): at least 500 KB of orders and executions, not deny-listed,
  changed by 5–10 actions/s. Run once as one top-level key (over the 256 KB cap, so it becomes a
  placeholder) and once split into keys under the cap (serialized on every change);
- 2 fetches/s; realistic typing (about 8 keys/s in bursts) plus a click every 3 s; route changes
  and periodic checkpoints;
- **hide/show cycles** (devil X9): the browser tab hidden for 30 s, 5 min and 11 min (past the
  10-min limit) by bringing a second tab to the front, and flexlayout tab switches every 20 s.

**Run matrix** (keeps K3 to about a day of machine time, plus the soak):
- every variant at S2 (real tick rate, flash as the real app has it), unthrottled and at 4× CPU
  throttling;
- the tick-rate sweep (½×, 1×, 2×) and flash on/off for recorder off and `full`, at S1, S2 and S3;
- S1 and S3 also for the best source-fix combination and the chosen caps;
- 5 min × 3 per cell, median. An **8-hour soak** of S2 with `full`.

The harness loads the recorder from a bundle path (`--bundles <dir>`), so K5 can point it at the
built bundles without changing harness code.

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
// Sample — not final code: the source-fix renderer variant (D32). AG Grid calls refresh() on a
// value change; returning true keeps the cell's DOM, so rrweb sees one characterData record.
export class TextRefreshRenderer {
  private text = document.createTextNode('');
  private el = document.createElement('span');
  init(p: { value: unknown }) { this.text.nodeValue = String(p.value ?? ''); this.el.append(this.text); }
  getGui() { return this.el; }
  refresh(p: { value: unknown }) { this.text.nodeValue = String(p.value ?? ''); return true; }
}
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
const bytes = await fetch(`${spikeServer}/stats?run=${runId}`).then((r) => r.json()); // raw + gzip per batch
// Report: Δ ScriptDuration / wall-clock = main-thread %, per variant; LoAF frames ≥ 50 ms with
// recorder ≥ 10 ms; raw and gzip bytes per minute.
```

**Metrics:**
- **Headline: raw and gzip bytes per minute** per scenario and variant, counted at the spike
  server (gzip as received, raw after decoding), split by event kind (mutations, inputs, state,
  network, other);
- **Headline: full-snapshot size** (raw and gzip) **and time** (main-thread ms of each
  checkpoint) per scenario;
- main-thread % from `Performance.getMetrics` deltas, and Profiler self-time per script file
  (serve the spike recorder and `sr-worker.js` as separate IIFE files so they're attributable);
- LoAF frames with attribution; Event Timing for clicks and keys;
- memory via `measureUserAgentSpecificMemory()` (needs COOP/COEP on the spike server);
- `postMessage` copy time, flush time inside a click;
- for the cap variants: time inside the gate, and inside rrweb after each release;
- the record mix per cell update (`textContent` childList vs `nodeValue` characterData);
- mutation records per minute at S2 (feeds `checkpointMutations`, 03) and the size of a 12-min
  S2 window (feeds R0's worst-seek test, 04);
- an exactness hash at each action;
- **whether hidden mounted tabs still mutate the DOM**, and how much they add to snapshot size and time;
- hide/show: the resume snapshot's time and whether it ran in idle time; the 11-min case stops
  with a `hidden-tab` band;
- the audit slice: serializer time per action, and whether the per-key and total caps held.

**Decision rules** (written back into plan 01 and 05 when P1 ends):
- **Bytes (A1, 05-L11):**
  - a busy user's day = the S2 gzip median × 60 × 8 h; the daily quota is a fuse at about 3× that;
  - the per-user rate limit (bytes/min) = the S3 gzip peak minute with 2× headroom;
  - the PVC = 01's sizing formula with S1 as the typical user and S2 as the busy one (30 % of
    users), × 30 days retention, × 2 headroom;
  - the ingest body limit (starts at 4 MiB, 03) is at least 2× the largest full-snapshot batch,
    gzip; the 16 MiB gunzip cap stays above 2× the largest raw one (devil X10);
  - the S1 upload target in 01 Acceptance = the S1 gzip median + 25 %, so a later regression shows.
- **Budget:** if `full` meets it at S2, there are no default caps and D36 stays a tool for later;
  R9 may be deferred (Q19).
- **Else, in this order** (D32, Q19): the source fixes that fit go into 08 as the first levers for
  app teams; then default caps per desk from the gate-cap curve; then a larger budget or more
  storage for that desk.
- **Worker:** on if the main-thread pipeline costs more than about 0.5 % CPU at S2 (D11).
- **Checkpoints:** if one takes 50 ms or more at S2, tune the snapshot fallback defaults. Check
  `checkpointMinutes` and `checkpointMutations` against the S2 mutation rate and R0's seek time.
- **Hidden tabs:** if hidden mounted grids still mutate, "suspend hidden grids" goes first in 08.

### P1b — module federation call-site transform (K4)

```js
// Sample — not final code. Before (app source):
import { createStore, applyMiddleware } from 'redux';
export const store = createStore(rootReducer, applyMiddleware(thunk));

// After the transform (07-L1): the 'redux' specifier is unchanged. Only the local binding is
// renamed, and a hoisted function takes the original name, so there's no temporal-dead-zone error.
import { __srWrapCreateStore } from '@sr/state-plugin/runtime';
import { createStore as __sr$createStore, applyMiddleware } from 'redux';
function createStore() { return __srWrapCreateStore(__sr$createStore,
  { app: 'blotter', file: 'src/store.ts', lib: 'redux@4.2.1' }, arguments); }
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
- the early store's `register` is in the queue and its state is readable through the handle
  once the recorder stand-in starts (03-L11);
- a test plugin that rewrites `'redux'` before ours fails the build, naming the file (07-L2),
  while a file with only `import type { Reducer } from 'redux'` builds cleanly (devil X4);
- webpack 5 and Vite 7 run through `bunx --bun` on Windows, or the failure is logged for Q41.

### K5 — P1 again on the built bundles (B4)

The K2 harness, pointed with `--bundles` at R11's output, loads `sr-loader.js` with a script tag
the way a host does; the loader then fetches the config and `sr-recorder.js`. Same seeds and
scenarios as K3, with the defaults K3 chose (caps, worker, checkpoints).
- **Budget:** every item in 01 Acceptance → Performance, at S1 and S2, 5 min × 3, unthrottled and
  at 4×. The 8-hour soak repeats only if the 60-min memory differs from K3's.
- **Startup:** time to first render and to the first idle callback with no loader, with the loader
  for a non-enabled user (config only), and for an enabled user.
- **Seek:** the S2 session recorded by the built bundle, loaded into the bundled `ReplayEngine`
  (R3) in a bare page: open, a seek to the end of the longest window, and a seek across a
  window edge. Under 2 s, except on the busiest desk, where it is reported (01 Acceptance).

## Guidelines

- Keep spikes ugly and fast. Don't build the real packages here; copy only what's needed.
- Same seed, same tick sequence, same machine for every variant. Close other apps while measuring.
- Record raw numbers in `spike/perf-grid/results/*.json` and `results-built/*.json` (gitignored),
  and the summary tables in this plan.
- Write down every surprise in this plan's Log, even when it doesn't change a decision.

## Acceptance

- [ ] K1: the gate fires on a test page; `mutationGateVersion` is a number and `gateActive` is
  true; records released later replay with zero "node not found" warnings; without the patch
  `gateActive` is false and rate caps switch off (every change is recorded).
- [ ] P1: a results table for S1/S2/S3 × variants is in this plan, with **raw and gzip
  bytes/min and full-snapshot size and time as headline columns**. The decision rules are applied:
  D11, the D36 defaults, Q19 and the first source fixes are written back to 01 and 08; the quota,
  rate limit, PVC size, body limit and S1 upload target to 01 and 05.
- [ ] P1: the hidden-tab question is answered with evidence; the source-fix variants are ranked by
  cost saved; the hide/show cycles and the audit slice are measured.
- [ ] P1b: all "done when" points pass for webpack 5 and Vite 7.
- [ ] K5: the budget, startup time and seek time hold with the built bundles, or each difference
  from K3 is explained and logged (01 Acceptance, devil X24).

## Tasks

- [ ] **K1 P1a gate patch** — owns: `patches/`, root `package.json` (`patchedDependencies`),
  `.gitignore` (allow `*.patch`) — batch: **B0**, parallel with K2 and K4 — depends on: user
  approval, the rrweb pin (L5) — done when: the K1 acceptance passes. Runs before X1 or after it,
  never alongside: both edit the root `package.json` and `.gitignore` (01 rule 3).
- [ ] **K2 P1 harness** (stress page, ticker, source-fix variants, CDP collector, byte counter,
  `--bundles`) — owns: `spike/perf-grid/` except `results/` and `results-built/` — batch: **B0**,
  parallel with K1 and K4 — depends on: Q24, the rrweb pin (L5) — done when: one variant produces a
  full metrics JSON, including raw and gzip bytes/min and full-snapshot size and time. The cap
  variants are wired, and skip with a note until K1 lands.
- [ ] **K3 P1 measurement runs + soak** — owns: `spike/perf-grid/results/` — batch: **B0** —
  depends on: K2; K1 for the cap variants — done when: the P1 acceptance items pass. The leader
  runs the long runs in the background with Bash; no agent sits idle during the 8-hour soak.
- [ ] **K4 P1b MF transform spike** — owns: `spike/mf-plugin/` — batch: **B0**, parallel with K1
  and K2 — depends on: user approval — done when: the P1b acceptance passes.
- [ ] **K5 P1 on the built bundles** — owns: `spike/perf-grid/results-built/` — batch: **B4** —
  depends on: R11, K3 — done when: the K5 acceptance passes and the numbers are in this plan. The
  leader runs it in the background, as for K3.

## Risks

| Risk | Mitigation |
|---|---|
| The ticker doesn't match the real app's update method, so the numbers mislead. | Q24 before K2; mirror the real code path. |
| A Windows desktop throttles a background Chrome window, skewing timings (seen in the 0002 spike). | Run in a dedicated, visible, focused window; repeat ×3 and take the median. The hide/show cycles hide the tab on purpose and are measured separately. |
| An 8-hour soak blocks the dev machine. | Run it overnight, in the background, outside agent runs. |
| Bytes per minute come out far above the first assumption (the architect estimates 1.5–7 MB/min gzip per busy user at S2). | Bytes are a headline result (L6); the decision rules size the quota and PVC from them, and the source fixes and caps come before more storage (D32, Q19). |
| The gate patch doesn't apply to the chosen pin, or released records behave differently because the DOM has moved on. | K1's self-check replays released records with zero warnings. Without the patch `gateActive` is false and caps switch off. D24's vendoring rule applies after two failed upgrades. |
| The run matrix grows past what the machine can run in a day. | Every variant runs at S2 only; sweeps run only for recorder off and `full` (Run matrix). |
| The spike's code costs less than the shipped bundles. | K5 re-measures the built bundles (L7). |

## Open questions

- **Q24:** how does the real app push ticks into AG Grid: `applyTransaction`, `applyTransactionAsync`, `rowNode.setDataValue`, or replacing `rowData`? And is cell flash on?

## Log

- 2026-11-10 — Created from plan 01's P1/P1a/P1b tasks when the user asked to split the plan (leader).
- 2026-11-10 — Architect and devil review merged (agent draft for the leader): raw and gzip
  bytes/min and full-snapshot size and time are headline results, with rules that derive the
  quota, limits, PVC size and S1 upload target (A1); source-fix variants, hide/show cycles and a
  ≥ 500 KB audit slice (A2, X9, X11); rate caps through the gate only, so the emit-level variants
  and the "(a) vs (c)" comparison are gone (D23); the gate API is `mutationGate(records, release)`
  plus an exported `mutationGateVersion` (D23, X6); one rrweb pin chosen at B0 start (X24); K1, K2
  and K4 run in parallel; new K5 re-runs P1 on the built bundles (X24); the P1b sample follows
  07-L1 (X28); a run matrix keeps K3 to about a day.
