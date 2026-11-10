# 06 — Replay UI
Status: draft · Size: large · Parent: [01-session-replay.md](01-session-replay.md)

## Goal

`apps/replay-ui` lets support and audit staff in one region find a user's session for a day and
replay it: the screen, the Redux state and the network calls on one timeline. Every gap in the
recording is visible, so "nothing changed" never looks like "not recorded" (D10). The UI is a
static single-page app served by `apps/server` under a strict CSP (D13, D30). It talks only to the
query API in [03-protocol.md](03-protocol.md) and drives the player only through `ReplayEngine` (D25).

## Decisions

Inherits D2, D10, D13, D16, D20, D25, D28, D30, D32, D33, D34, D36, D37, D38, D39 and 03-L2, L3, L4.

| # | Decision | Why |
|---|---|---|
| L1 | Built with **Bun's HTML bundler** (`Bun.build({ entrypoints: ['./index.html'] })`), not Vite. | Code-based routes need no router plugin. One toolchain (Bun-first). The output uses external script files only, which the CSP needs. |
| L2 | **Code-based TanStack Router routes.** Search params are checked with zod. Filters and the play position live in the URL. | A link or a reload shows the same list or frame. Bad ids are rejected before any request. |
| L3 | **Server data in TanStack Query, player state in Zustand.** The `ReplayEngine` instance lives in a plain `PlayerController`, outside React state. | The engine is an imperative object. Keeping it out of state avoids re-renders, and its lifetime is explicit (create, destroy). |
| L4 | **Snapshot windows.** A window runs from one full-snapshot chunk to the next (one per checkpoint, 10–15 min, or per page load; 05 calls these `snapshots`, the seek anchors). The UI loads the window under the play head, prefetches the next one, and keeps at most 3. | Each window stands alone: the DOM and every store get a fresh snapshot at a checkpoint. Seeks stay under 2 s and memory stays bounded. |
| L5 | The **scrubber seeks by time**; **action jumps seek by stream position** (D16). Back/next step through the action list's *current filter*. | Positions are exact when many events share a millisecond. The viewer decides what an "action" is. |
| L6 | The play head is written to the store at most **10 times a second**. `?pos=` is written to the URL **only on pause**, with `replace`. | Smooth playback without flooding React or browser history. |
| L7 | **State is rebuilt in the UI** from a snapshot plus each action's top-level `changes`, step by step. The UI never imports rrweb; it parses only `sr:*` events (03-L1). | D25 keeps rrweb inside `recorder-engine`. Rebuilding forward is cheap; going back restarts from the window's snapshot. |
| L8 | **Access is granted per session** (D38) by the server's grant (05-L10: 8 h, or until a server restart). Any 403 `{need:'access'}` shows the prompt. The UI remembers the viewer's name in `localStorage` for prefill; the reason is never stored. | Saves typing without weakening the "say why for each open" rule. |
| L9 | Times show in the **viewer's local time** with UTC on hover. The day filter is a **UTC day**, labelled as such. | Day files are UTC (D31); support staff think in local time. See open question 1. |
| L10 | Small, proven libraries: `@tanstack/react-virtual` (long lists), `microdiff` (Diff tab). A hand-written JSON tree (lazy, collapsed by default). | Large action lists and 2 MB stores must not freeze the page. |
| L11 | Until the server's query API lands (B3), the UI runs on a **mock Hono API** in `apps/replay-ui/mock/`, built from the 03 fixtures and checked against the 03 zod schemas. | Lets B2 start in parallel with the server, against the same shapes. |

## Design

### Routes

| Route | Search params | Screen |
|---|---|---|
| `/` | `user`, `day` (yyyymmdd, UTC), `errors` | Session list on the left, "Pick a session" in the centre |
| `/replay/$sessionId` | `pos` (`<recordingId>:<seq>:<idx>`), or `t` (`mm:ss` or `h:mm:ss` from session start); keeps `user`, `day`, `errors` | Three columns: list, player, actions + state |
| `/hotspots` | `day`, `app` | Daily degraded-screens report (D32) |

### Wireframe: replay screen

Badges: `⚠` errors, `✖` failed requests, `⚑` user reports, `▥` fidelity drops, `●` still recording.

```
┌ Session replay · NAM ────────────────────────────────── [Sessions] [Hotspots] [?] ─┐
├────────────────────┬─────────────────────────────────────────┬──────────────────────┤
│ User [u123       ] │ u123 · blotter 4.2.1 · 10:02–11:14      │ Actions   [/ search] │
│ Day  [2026-11-10]  │ ⓘ identity: client-asserted             │ [click][input][nav]  │
│      UTC day       │ ✓ unchanged since received (214 chunks) │ [error][state][net▾] │
│ [ ] errors only    │ ┌─────────────────────────────────────┐ │ app [all ▾]          │
│────────────────────│ │                                     │ │ 00:41 click Buy      │
│▸u123 10:02  1h12m  │ │   recorded screen, scaled to fit    │ │ 00:43 input qty=100  │
│  ⚠2 ✖1 ⚑1 ▥3       │ │   (sandboxed iframe, strict CSP)    │ │▶00:44 net POST 500   │ ← red
│ u123 08:15    22m  │ │  ┌╱╱╱╱ canvas not recorded ╱╱╱╱┐   │ │ 00:52 nav /positions │
│  ● still recording │ │  └╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱┘   │ │ ...                  │
│ u456 07:58  3h01m  │ └─────────────────────────────────────┘ │──────────────────────│
│  ▥1                │ ┌ ⏸ Recording paused (app busy)        ┐ │ State [blotter#1 ▾]  │
│ ...                │ │   00:47–00:58: the screen may have   │ │ [Action][Diff][State]│
│                    │ └   changed; resumes with a snapshot   ┘ │ orders/placed        │
│                    │ ◀ ▶ ▶  0.5 1 1.5 2 4 5  00:44/1:12:03 ⧉ │ ~ orders.o17.status  │
│                    │ |·|·▲··|▓▓▓|··▲·|▒▒|·······░░░░░░·····| │   "new" → "rejected" │
│                    │ |      state lane: ┄┄ no-state ┄┄     | │ State at 00:44.212   │
│                    │ ▲ error ▓ paused ▒ popout ░ loaded      │ ⓘ useState values    │
│                    │ Rate caps v2026-11-10.3: positions grid │   aren't captured;   │
│                    │ bid/ask/mid ≤ 2/s, flushed at actions   │   see screen (D39)   │
└────────────────────┴─────────────────────────────────────────┴──────────────────────┘
```

- **Header notes.** "identity: client-asserted" explains on hover that the browser sent the user
  id and nothing checked it (D20). "unchanged since received" explains that each chunk's sha256
  matched on read, which proves no change after receipt, not who sent it (D28). Never "verified".
  A chunk that fails the check turns the note red and adds a band.
- **Bands (D10, D34).** Each `FidelityReason` has a label and a pattern, so colour is never the
  only cue. Gaps: `pause-budget`, `missing-batches`, `quota`, `buffer-overflow` (amber or red, hatched),
  `popout` (purple, hatched), `hidden-tab` (grey). Notes, not gaps: `snapshot-slow` and
  `pipeline-fallback` (a tick). `no-state` draws on the thin **state lane**, because the screen is
  still complete. While the play head is inside a gap, a banner over the player names it, as above.
- **Canvas (D34)** is drawn inside the replay by the engine's placeholder style. The `ⓘ Known gaps`
  popover lists canvas, popouts and `useState` values (D39).
- **Between recordings** (a reload or a closed tab) the scrubber shows a neutral gap. Playback jumps
  over it with a toast, "Skipped 42 min with no page open".
- **Rate-cap legend (D36)** lists the config version and the capped grid columns, or says "No rate
  caps: every change recorded". A change during the session shows one line per version, with times.

### Wireframe: access prompt (D38)

```
┌──────────────── Open session ────────────────┐
│ u123 · blotter · 2026-11-10 10:02 (1h12m)    │
│ Your name  [Priya S.                       ] │  ← remembered on this browser
│ Reason     [INC-48213 order rejected       ] │  ← required every open, 5–500 chars
│ This open is logged with your name, reason   │
│ and IP address.                              │
│                      [Cancel] [Open session] │
└──────────────────────────────────────────────┘
```

It shows before anything under `/api/sessions/:id/*` loads, including on a deep link. Cancel goes
back to the list. If the grant expires mid-replay, the player pauses, the prompt shows "Your access
to this session expired", and the replay resumes at the same position after submit.

### Wireframe: Hotspots page (D32)

```
┌ Hotspots · NAM ──────────── Day [◀ 2026-11-09 ▶] UTC   App [all ▾] ─────────────────────┐
│ Screens where recording paused to protect app performance (D8). Each row is a source fix. │
│ App      Remote   Area (CSS path)                  Peak mut/s  Paused   Pauses Users  ▶   │
│ blotter  pricing  .positions [data-sr-grid=pos..]      14,200  38m 12s     41     7  open │
│ blotter  orders   .orders-blotter .ag-body              6,900   4m 03s      9     2  open │
│ (sorted by total paused time; "open" = example session at the pause, after access prompt) │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

The default day is yesterday (a complete day). Today shows "partial day".

### Empty, loading and error states

| Screen | Empty | Loading | Error |
|---|---|---|---|
| Session list | "No sessions on 2026-11-10 (UTC)". With a user: "No sessions for u123 that day. The user id must match exactly." | Skeleton rows; on a filter change, the old list stays, dimmed (`keepPreviousData`) | "Couldn't load sessions (HTTP 500)" + Retry. A bad user id shows an inline hint and sends no request. |
| Player | "Pick a session on the left." No full snapshot: "No screen recorded yet: recording may still be starting, or wasn't enabled." | "Loading 10:00–10:12…"; "Buffering…" at a window edge | 404: "Not found in this region. Recordings stay in their region (D37)." Chunk failure: overlay + Retry, while loaded windows still play. Engine failure: message + "Seek past this point". |
| Action list | "No actions in this session" / "No actions match the filter" + Clear | Skeleton rows | Inline + Retry |
| State panel | "No Redux store in this session" (with a `no-state` band: "this mini-app wasn't built with the plugin"). "No state yet at this point." | Follows the window load | "Snapshot skipped (over 256 KB): showing changes since 10:00:00" |
| Hotspots | "No degraded screens that day: recording was complete." | Skeleton table | Inline + Retry |

A **live session** (still recording) shows "Recorded up to 10:42. Refresh to load newer."

### Keyboard shortcuts

Ignored while focus is in a text field or a dialog is open. `?` shows this list.

| Key | Action | Key | Action |
|---|---|---|---|
| `Space` / `K` | Play / pause | `J` / `L` | Previous / next action (current filter) |
| `←` / `→` | Back / forward 5 s | `E` | Next error or failed request |
| `[` / `]` | Slower / faster | `1`–`6` | Speed 0.5 / 1 / 1.5 / 2 / 4 / 5 |
| `/` | Focus the action search | `F` | Toggle "follow play head" |
| `C` | Copy link at this position | `Esc` | Close dialog, leave a text field |

### Routes in code

```tsx
// Sample — not final code. apps/replay-ui/src/router.tsx
import { createRootRoute, createRoute, createRouter, lazyRouteComponent,
  retainSearchParams } from '@tanstack/react-router';
import { z } from 'zod';

const day = z.string().regex(/^\d{8}$/);   // UTC day (D31); default: today
const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFound });
const sessionsLayout = createRoute({          // pathless: the left column + <Outlet/>
  getParentRoute: () => rootRoute, id: 'sessions', component: SessionsLayout,
  validateSearch: z.object({
    user: z.string().regex(/^[A-Za-z0-9_.@-]{1,128}$/).optional(),   // same rule as ingest
    day: day.optional(), errors: z.boolean().optional() }),
  search: { middlewares: [retainSearchParams(['user', 'day', 'errors'])] },
});
const indexRoute = createRoute({ getParentRoute: () => sessionsLayout, path: '/', component: PickASession });
const replayRoute = createRoute({
  getParentRoute: () => sessionsLayout, path: 'replay/$sessionId',
  validateSearch: z.object({
    pos: z.string().optional(),                                // '<recordingId>:<seq>:<idx>'
    t: z.string().regex(/^(\d+:)?\d{1,2}:\d{2}$/).optional(), // from session start
  }),
  // The player chunk (engine + rrweb) loads only when a session opens.
  component: lazyRouteComponent(() => import('./routes/replay'), 'ReplayPage'),
});
const hotspotsRoute = createRoute({
  getParentRoute: () => rootRoute, path: 'hotspots',
  validateSearch: z.object({ day: day.optional(), app: z.string().max(64).optional() }),
  component: lazyRouteComponent(() => import('./routes/hotspots'), 'HotspotsPage'),
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([sessionsLayout.addChildren([indexRoute, replayRoute]), hotspotsRoute]),
});
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
```

### API client and React Query hooks

```ts
// Sample — not final code. apps/replay-ui/src/api/queries.ts
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { posKey } from '../lib/pos';
import type { ReplayWindow } from '../features/player/windows';
import { api } from './client';                // hc<QueryApi>('/'); B2 uses the mock's type (L11)
import { ApiError, unwrap } from './errors';   // non-2xx → ApiError; 403 {need:'access'} = no grant

// Access and not-found errors are answers, not glitches: don't retry them.
const retry = (n: number, e: unknown) => !(e instanceof ApiError && [401, 403, 404].includes(e.status)) && n < 2;

export type SessionFilter = { user?: string; day: string; errors?: boolean };
export const sessionsQuery = (f: SessionFilter) => queryOptions({
  queryKey: ['sessions', f],
  queryFn: async () => unwrap(await api.api.sessions.$get({
    query: { user: f.user ?? '', day: f.day, hasErrors: f.errors ? '1' : '' } })),
  placeholderData: keepPreviousData, staleTime: 30_000, retry,
});
export const sessionQuery = (id: string) => queryOptions({
  queryKey: ['session', id],
  queryFn: async () => unwrap(await api.api.sessions[':id'].$get({ param: { id } })),
  staleTime: 60_000, retry,
});
// userActionsQuery(id): the whole session's user actions, errors and failed requests only, via
// `actions?kinds=…&failedOnly=1`, following `after` pages of 1000 (05). State rows and all
// requests load per window (contract C4). windowQuery below also follows the `next` cursor.
export const windowQuery = (id: string, w: ReplayWindow, live: boolean) => queryOptions({
  queryKey: ['session', id, 'window', w.idx],
  queryFn: async () => unwrap(await api.api.sessions[':id'].chunks.$get({
    param: { id }, query: { from: posKey(w.from), to: w.to ? posKey(w.to) : '' } })),
  staleTime: live && !w.to ? 0 : Infinity,   // closed windows never change
  gcTime: 2 * 60_000,                        // with L4's "≤ 3 windows", bounds memory
  retry,
});
export const useGrantAccess = (sessionId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: { name: string; reason: string }) =>
      unwrap(await api.api.access.$post({ json: { sessionId, ...b } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session', sessionId] }),
  });
};
```

### Player store (Zustand)

```ts
// Sample — not final code. apps/replay-ui/src/features/player/store.ts
import { create } from 'zustand';
import type { StreamPos } from '@sr/protocol';

export const SPEEDS = [0.5, 1, 1.5, 2, 4, 5] as const;
export type Speed = (typeof SPEEDS)[number];
export type PlayerStatus =
  | 'idle' | 'loading' | 'paused' | 'playing' | 'buffering' | 'ended' | 'access' | 'error';

type PlayerState = {
  sessionId: string | null; status: PlayerStatus; speed: Speed; error: string | null;
  t: number;                     // play head, epoch ms; updated ≤ 10×/s (L6)
  pos: StreamPos | null;         // last event the engine applied
  windowIdx: number | null;      // snapshot window loaded in the engine (L4)
  viewport: { width: number; height: number } | null;   // recorded size, for scale-to-fit
  follow: boolean;               // the action list scrolls with the play head
};
type PlayerActions = { patch: (p: Partial<PlayerState>) => void; reset: (id: string | null) => void };
const initial: PlayerState = { sessionId: null, status: 'idle', t: 0, pos: null, speed: 1,
  windowIdx: null, viewport: null, follow: true, error: null };

// Plain data only: commands live in PlayerController, so the store is easy to test and inspect.
export const usePlayerStore = create<PlayerState & PlayerActions>()((set) => ({
  ...initial,
  patch: (p) => set(p),
  reset: (sessionId) => set({ ...initial, sessionId, speed: usePlayerStore.getState().speed }),
}));
```

Panel choices (action kinds, mini-app, search text, state tab, selected store) live in a second
small `usePanelStore`, so a play-head tick never re-renders the filters. Components read with
selectors (`usePlayerStore((s) => s.status)`), or `useShallow` for several fields.

### Driving `ReplayEngine` (lazy windows)

`04-recorder.md` owns the engine API (D25); the sample uses D25's calls plus C10–C12 below.

**Windows** (`windows.ts`): `buildWindows(detail)` turns `detail.snapshots` (contract C3) into
`{ idx, from, to, t0, t1 }`, one per anchor, from anchor *i* up to (not including) anchor *i+1*;
the last has `to: null`. An anchor is a chunk, so `from` is `{ recordingId, seq, idx: 0 }`; the
engine starts at the first full snapshot it is given (C11). `windowAtTime` / `windowAtPos`
binary-search them. Positions
order by recording start, then `seq`, then `idx` (`lib/pos.ts`, 03-L2); in a URL they are
`<recordingId>:<seq>:<idx>` (contract C2).

```ts
// Sample — not final code. apps/replay-ui/src/features/player/controller.ts
import type { QueryClient } from '@tanstack/react-query';
import type { SessionDetail, StreamPos } from '@sr/protocol';
import { createReplayEngine, type ReplayEngine } from '@sr/recorder-engine/replay'; // D25
import { windowQuery } from '../../api/queries';
import { isAccessError } from '../../api/errors';
import { buildWindows, windowAtPos, windowAtTime } from './windows';
import { usePlayerStore, type Speed } from './store';

type Target = { pos: StreamPos } | { t: number };
const TICK_MS = 100;       // L6
const PREFETCH_AT = 0.6;   // prefetch the next window once 60 % of this one has played

export const createPlayerController = (o: { qc: QueryClient; detail: SessionDetail; stage: HTMLElement }) => {
  const { patch } = usePlayerStore.getState();
  const windows = buildWindows(o.detail);
  const query = (i: number) => windowQuery(o.detail.sessionId, windows[i], o.detail.live);
  let engine: ReplayEngine | null = null;
  let loaded = -1, lastTick = 0;
  let gen = 0;             // bumped by every mount and by destroy; stale async work sees it and stops
  const prefetch = (i: number) => { if (windows[i]) void o.qc.prefetchQuery(query(i)); };
  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) {
      patch(isAccessError(e) ? { status: 'access' } : { status: 'error', error: String(e) });
    }
  };

  const onTick = ({ t, pos }: { t: number; pos: StreamPos }) => {
    const w = windows[loaded];
    if (t - w.t0 > (w.t1 - w.t0) * PREFETCH_AT) prefetch(loaded + 1);
    const now = performance.now();
    if (now - lastTick >= TICK_MS) { lastTick = now; patch({ t, pos }); }
  };

  // Continue across a window boundary: load the next window and keep playing (L4).
  const onEnd = async () => {
    if (!windows[loaded + 1]) return patch({ status: 'ended' });
    if (!o.qc.getQueryData(query(loaded + 1).queryKey)) patch({ status: 'buffering' });
    const info = await mount(loaded + 1);
    if (info) { engine!.seek({ pos: windows[loaded].from }); play(); }
  };

  /** Loads window i into a fresh engine. Returns null if a newer mount or destroy overtook it. */
  const mount = async (i: number) => {
    const my = ++gen;
    patch({ status: 'loading' });
    const events = await o.qc.ensureQueryData(query(i));
    if (my !== gen) return null;
    engine?.destroy();
    engine = createReplayEngine({ root: o.stage, assetUrl: (sha) => `/assets/${sha}` }); // D33
    engine.onViewport((viewport) => patch({ viewport }));
    engine.onTick(onTick);
    engine.onEnd(() => void run(onEnd));
    const info = await engine.load(events);   // → { t0, t1, firstFrame } (contract C11)
    if (my !== gen) return null;
    engine.setSpeed(usePlayerStore.getState().speed);
    loaded = i;
    patch({ windowIdx: i, status: 'paused' });
    prefetch(i + 1);
    return info;
  };

  const seek = (target: Target) => run(async () => {
    const i = 'pos' in target ? windowAtPos(windows, target.pos) : windowAtTime(windows, target.t);
    const resume = usePlayerStore.getState().status === 'playing';
    if (i !== loaded && !(await mount(i))) return;
    engine!.seek(target);            // the engine adds +1 ms to time seeks (spike lesson)
    if (resume) play(); else patch({ status: 'paused' });
  });

  // First frame = first DOM change after the first full snapshot (spike: the snapshot is an empty #root).
  const open = (start?: Target) => run(async () => {
    if (start) return seek(start);
    const info = await mount(0);
    if (info) engine!.seek({ pos: info.firstFrame });
  });

  const play = () => { engine?.play(); patch({ status: 'playing' }); };
  const pause = () => { engine?.pause(); patch({ status: 'paused' }); };
  const setSpeed = (speed: Speed) => { engine?.setSpeed(speed); patch({ speed }); };
  const destroy = () => { gen++; engine?.destroy(); engine = null; loaded = -1; };

  return { open, seek, play, pause, setSpeed, destroy };
};
export type PlayerController = ReturnType<typeof createPlayerController>;
```

The page owns the controller. **A `useEffect` must not return a Promise** (spike lesson), so it
calls `void ctl.open(start)` and returns `ctl.destroy`. `start` comes from `?pos=` or `?t=` once;
later URL changes call `ctl.seek`. **Scale-to-fit** scales the UI's own stage `div` from
`viewport` with a `ResizeObserver`, so the UI never touches rrweb's wrapper element.

### State at a position

```ts
// Sample — not final code. apps/replay-ui/src/features/state/reconstruct.ts
import type { StreamPos } from '@sr/protocol';

/** One `sr:state` event from the loaded window, in stream order (03 SrPayload['sr:state']). */
export type StateStep = { pos: StreamPos; t: number; store: string; op: 'snapshot' | 'action';
  type: string; body: Record<string, unknown>; removed?: string[] };
export type StoreView = { value: Record<string, unknown>; since: StreamPos; partial: boolean };
export type StateCache = { upTo: number; stores: Map<string, StoreView> };   // upTo: index in steps
export const EMPTY: StateCache = { upTo: -1, stores: new Map() };

/** Every store after steps[0..upTo]: a snapshot replaces, an action shallow-merges `changes`.
 *  Forward reuses `prev`; backward restarts at the window's fresh snapshots (L4). `partial`: no
 *  snapshot yet in this window (e.g. over the 256 KB cap). */
export const stateAt = (steps: StateStep[], upTo: number, prev: StateCache = EMPTY): StateCache => {
  const base = prev.upTo <= upTo ? prev : EMPTY;
  const stores = new Map(base.stores);
  for (let i = base.upTo + 1; i <= upTo; i++) {
    const s = steps[i];
    const cur = stores.get(s.store);
    if (s.op === 'snapshot') { stores.set(s.store, { value: s.body, since: s.pos, partial: false }); continue; }
    const value = { ...(cur?.value ?? {}), ...s.body };
    for (const k of s.removed ?? []) delete value[k];              // contract C9
    stores.set(s.store, { value, since: cur?.since ?? s.pos, partial: cur?.partial ?? true });
  }
  return { upTo, stores };
};
```

- **Action tab:** the type and `changes` of the state action at or just before the play head (or
  the one clicked in the list).
- **Diff tab:** `microdiff(before[key], after[key])` for each changed key, shown as path, old and new.
- **State tab:** the rebuilt state, collapsed by default, with a search box. During playback it
  re-renders at most 4×/s.

### Build, dev and CSP

- `bun run build` runs `build.ts` (`Bun.build`, `splitting: true`, `minify: true`) into
  `apps/replay-ui/dist/`. A test fails if `dist/index.html` holds an inline `<script>`, or if any
  file lands under `dist/assets/`, which would clash with `/assets/:sha256` (05's C9).
- `bun run dev` serves `index.html` through Bun's HTML import with hot reload, and proxies `/api`
  and `/assets` to `SR_API` (default: the mock on port 3310).
- `bun run preview` serves `dist/` with **the exact D30 CSP header**, so CSP problems show early.
- `apps/server` serves `dist/` with a history fallback for `/replay/*` and `/hotspots` (05).

### Contract assumptions (agreed 2026-11-10: now in 03 and 04)

The samples above rely on these additions. They are now defined in 03 (shapes, `posKey`, bands and notes, paging) and 04 (`ReplayEngine`), and the mock serves 03's `query-v1/` fixtures.
Most of the 03 items match the 05 draft's own request (its C6); the UI adds the rest.
- **03:** C1 zod schemas for `SessionSummary`, `SessionDetail`, `HotspotRow` and `ChunksResponse`.
  C2 positions in URLs as `recordingId:seq:idx`, plus `parsePos` / `comparePos` helpers.
  C3 `SessionDetail` has `snapshots` (seek anchors with `t`), ordered `recordings`, `live`, and
  **`bands`** (each fidelity start/end pair plus `missing` gaps, with times). C4 `actions` takes
  `kinds`, `after`, `limit` (05) **plus `failedOnly` and `to`**; `ActionRow` gains an optional `app`.
  C5 chunks carry `integrity: ok | mismatch | unreadable` (05). C6 a missing grant is 403
  `{need:'access'}` (05). C8 `QueryApi` is exported from `apps/server/src/api` (05). C9 how
  `sr:state` marks a removed top-level key.
- **04 (`ReplayEngine`):** C10 `seek({ t })` as well as `seek({ pos })`. C11 `load()` resolves
  `{ t0, t1, firstFrame }` and skips events before the first full snapshot. C12 `onTick({ t, pos })`,
  `onViewport`, `onEnd`.
- **D30:** C14 the CSP adds `style-src 'self' 'unsafe-inline'`. 05-L13 already proposes this.

## Guidelines

**Do**
- Seek actions by `pos` and the scrubber by `t`. Let the engine add the +1 ms.
- Create one controller per open session and destroy it on unmount or session switch.
- Check the `gen` token after every `await` in the controller.
- Show every gap as a labelled band. Say "unchanged since received", never "verified".
- Parse search params with zod and reject bad ids before fetching.
- Use 03's types. Treat unknown `sr:*` tags and fields as "ignore" (03-L3).

**Don't**
- Import `rrweb` or `@rrweb/*` anywhere in `apps/replay-ui` (D25; a test enforces it).
- Add inline scripts, `eval`, or fonts and images from other origins (D30).
- Store the reason, or prefill it from a URL.
- Render the full state JSON on every tick, or fetch a whole session's events at once.
- Keep the engine, DOM nodes or event arrays in React state or Zustand.

## Acceptance

- [ ] Routes `/`, `/replay/:id?pos=`, `/replay/:id?t=` and `/hotspots?day=&app=` work. A reload keeps filters and position. Bad params show a message and send no request.
- [ ] The list filters by user and UTC day, with an "errors only" toggle. Badges show errors, failed requests, reports, fidelity drops and "still recording". A session across UTC midnight shows on both days.
- [ ] Opening a session without a name and a reason is impossible. Cancel returns to the list. A reload within the grant doesn't prompt again. An expired grant pauses, prompts, then resumes at the same position.
- [ ] `?pos=` shows the frame before the app's reaction (D16). `?t=1:02:13` shows that time. A position outside the session opens at the start with a toast.
- [ ] Play/pause, back/next (following the action filter), all six speeds, scrubber drag and every shortcut work. Shortcuts do nothing while typing in a field or with a dialog open.
- [ ] Every `FidelityReason` has a band with a label and a pattern. A banner shows while the play head is inside a gap. Popout bands and the canvas placeholder are visible (D34).
- [ ] The rate-cap legend shows the config version and capped columns, or "No rate caps". A mid-session change shows both versions.
- [ ] Every session shows "identity: client-asserted" and "unchanged since received". A chunk with a failed hash check shows a red note and a band.
- [ ] Action list: filters by kind and mini-app, failed requests in red, a click seeks by position, the list follows the play head until the user scrolls, and 10,000 rows scroll smoothly.
- [ ] State panel: Action / Diff / State are correct at any position (snapshot + actions), with a store picker. The no-store, `no-state` and capped-snapshot cases show their messages.
- [ ] An 8-hour busy session fetches only the window under the play head. Any seek finishes in under 2 s. At most 3 windows stay in memory. Playback continues across a window edge, showing "Buffering…" if the network is slow.
- [ ] Awkward states: switching sessions mid-load (no stale frame, no error); a background tab during playback; two replay tabs on different sessions; browser back/forward between sessions; window resize; going offline mid-load (error + Retry); a 404 (region note); refreshing a live session.
- [ ] Hotspots: day and app filters, sorting, and "open" lands on the pause position after the access prompt. Empty, loading and error states work.
- [ ] The built UI, served by `apps/server` with the D30 CSP, shows no CSP violations in the console, the iframe makes no network requests, and `dist/` has no inline scripts.
- [ ] Twenty session switches in a row leave no growing heap (old engines and iframes are freed).

## Tasks

Commands for tier 1: `bunx tsc --noEmit -p apps/replay-ui` and `bun test apps/replay-ui`.
All paths are under `apps/replay-ui/`.

- [ ] **U1 Scaffold** — owns: `package.json`, `tsconfig.json`, `index.html`, `build.ts`, `dev.ts`, `src/main.tsx`, `src/router.tsx`, `src/routes/*` (placeholders), `test/build.test.ts` — batch: B1 — depends on: none — done when: the build writes `dist/` with no inline script; the three routes render placeholders; a test fails on any `@rrweb/*` import; tier 1 passes.
- [ ] **U2 API layer and mock** — owns: `src/api/**`, `mock/**` — batch: B2 — depends on: 03 T1, T2; U1 — done when: every mock response validates against the 03 schemas; the hooks are tested against the mock, including 403 `{need:'access'}`; `MOCK_SCENARIO=slow|error|empty|expired|live` works.
- [ ] **U3 Shell and session list** — owns: `src/routes/{root,sessions-layout,sessions-index}.tsx`, `src/features/sessions/**`, `src/styles/**` — batch: B2 — depends on: U2 — done when: filters sync with the URL; all badges render from fixtures; empty, loading and error show under the mock scenarios; search-param parsing is unit-tested.
- [ ] **U4 Player core** — owns: `src/features/player/{store,controller,windows}.ts`, `src/lib/{pos,time}.ts`, `src/routes/replay.tsx` — batch: B3 — depends on: U3; 04's `ReplayEngine` (a `FakeReplayEngine` in tests until it lands) — done when: unit tests cover windows, position order, clock parsing, and the controller with a fake engine (seek across windows, buffering, destroy mid-load, the `gen` guard); deep links work on the mock.
- [ ] **U5 Controls, scrubber, bands, notes, shortcuts** — owns: `src/features/player/{Player,Controls,Scrubber,Bands,Legend,Notes}.tsx`, `src/features/player/shortcuts.ts` — batch: B3 — depends on: U4 — done when: each `FidelityReason` fixture renders its band; the shortcut map is unit-tested, including focus rules; legend and notes render from `SessionDetail`.
- [ ] **U6 Action list** — owns: `src/features/actions/**` — batch: B3 (parallel with U5, U7) — depends on: U4 — done when: filters, virtualisation, click-to-seek by `pos`, follow mode and back/next targets are unit-tested.
- [ ] **U7 State panel** — owns: `src/features/state/**` — batch: B3 (parallel with U5, U6) — depends on: U4 — done when: `stateAt` tests cover snapshot + actions, removed keys, several stores, a partial store, and "forward from cache equals full recompute"; the three tabs render fixture data.
- [ ] **U8 Access prompt and expiry** — owns: `src/features/access/**` — batch: B3 — depends on: U2, U4 — done when: the prompt blocks loading until granted; the name is remembered and the reason isn't; expiry mid-replay pauses and resumes at the same position (mock `expired`).
- [ ] **U9 Hotspots page** — owns: `src/routes/hotspots.tsx`, `src/features/hotspots/**` — batch: B4 — depends on: U2; 05 hotspots API (or the mock) — done when: filters, sorting and the example link work on fixtures; empty, loading and error are covered.
- [ ] **U10 Real server and CSP** — owns: `src/api/client.ts`, `test/csp.test.ts` — batch: B4 — depends on: 05 query API; U1–U9 — done when: the UI type-checks against `QueryApi`; the golden session replays from `apps/server` with the D30 CSP and no violations. (qa writes the e2e specs in `specs` mode during B3–B4; they first run at the gate.)

## Risks

| Risk | Mitigation |
|---|---|
| **The D30 CSP as written breaks replay styling.** `default-src 'self'` with no `style-src` blocks inline `<style>` and `style` attributes, which rrweb's rebuilt DOM relies on. The about:blank iframe inherits the policy. *Not yet tested.* | C14 / 05-L13: add `style-src 'self' 'unsafe-inline'`. Inline CSS can't fetch: `url()` stays limited by `img-src` and `font-src`. U1's preview and U10 test it. |
| A short flash when playback crosses a window edge (a fresh engine rebuilds from the snapshot). | Acceptable for the MVP. If viewers notice, ask 04 for `append(events)`. |
| Huge action lists (state actions at 5/s, 2 fetches/s for 8 h). | Server-side filters (C4), state and request rows fetched per window, virtualised list. |
| Rebuilding a 2 MB store on every tick. | Incremental `stateAt`, render ≤ 4×/s, collapsed tree. A worker later if needed (CSP allows same-origin workers). |
| The mock drifts from the real server. | The mock is validated by the same zod schemas; U10 switches to the real type. |
| UTC days confuse APAC staff. | Labels, local times with UTC on hover; open question 1. |
| Old engines or iframes leak when switching sessions. | `destroy` plus the `gen` guard; a heap check in acceptance. |

## Open questions

Tracked in 01 as Q27 and Q29–Q32.

1. Times: show the viewer's local time (proposed), UTC, or the recorded user's time zone?
2. 05 proposes an 8 h grant per session, so a reload within it skips the prompt. Is 8 h right for audit, or should each new browser tab ask again?
3. Should the session list itself need a name and reason? Proposed: no; it is logged as a search.
4. Mini-app filter: clicks need an `app` field (C4). How does the recorder know a click's mini-app (for example a `data-sr-app` attribute on each remote's root)? For 04.
5. Hotspots default day: yesterday (proposed) or today?

## Log

- 2026-11-10 — drafted for the plan split (agent)
- 2026-11-10 — Reviewed and merged into `plan/` by the leader. The contract assumptions C1–C14 are now in 03 (shapes, `posKey`, bands and notes, paging) and 04 (`ReplayEngine`); D30 gained `style-src` in 01. `SessionDetail` also carries `notes` for single-event reasons.
