# 06 — Replay UI
Status: draft · Size: large · Parent: [01-session-replay.md](01-session-replay.md)

## Goal

`apps/replay-ui` lets support and audit staff in one region find a user's session for a day and
replay it: the screen, the Redux state and the network calls on one timeline. Every gap in the
recording is visible, so "nothing changed" never looks like "not recorded" (D10). The UI is a
static single-page app served by `apps/server` under a strict CSP (D13, D30). It talks only to the
query API in [03-protocol.md](03-protocol.md) and drives the player only through `ReplayEngine` (D25).

## Decisions

Inherits D2, D10, D13, D16, D20, D25, D28, D30, D32, D33, D34, D36, D37, D38, D39 and 03-L2, L3,
L4, L8, L9, L11, L12, L14.

| # | Decision | Why |
|---|---|---|
| L1 | Built with **Bun's HTML bundler** (`Bun.build({ entrypoints: ['./index.html'] })`), not Vite. | Code-based routes need no router plugin. One toolchain (Bun-first). The output uses external script files only, which the CSP needs. |
| L2 | **Code-based TanStack Router routes.** Search params are checked with zod. Filters and the play position live in the URL. | A link or a reload shows the same list or frame. Bad ids are rejected before any request. |
| L3 | **Server data in TanStack Query, player state in Zustand.** The `ReplayEngine` instance lives in a plain `PlayerController`, outside React state. | The engine is an imperative object. Keeping it out of state avoids re-renders, and its lifetime is explicit (create, destroy). |
| L4 | **Snapshot windows inside one recording; one Replayer per span** (architect A6). A window runs from a FullSnapshot event's own position (03 `SessionDetail.snapshots`, with `idx`) up to the next anchor in the same recording, or to that recording's end. It **never crosses recordings**. One engine holds a **span**: the current window plus the next, which is added with `engine.append()`. At most 3 windows stay loaded; the engine is rebuilt only on evict or on a seek outside the span. | rrweb rebuilds the DOM at every FullSnapshot, and the recorder snapshots every store right after it (03-L11), so each window stands alone. Appending the next window means no rebuild at an edge, so playback never flashes there. Memory stays bounded. |
| L5 | The **scrubber seeks by raw time**; **action jumps seek by stream position** (D16). Back/next step through the action list's *current filter*. | Positions are exact when many events share a millisecond. The viewer decides what an "action" is. |
| L6 | The play head is written to the store at most **10 times a second**. `?pos=` is written to the URL **only on pause**, with `replace`. | Smooth playback without flooding React or browser history. |
| L7 | **State is rebuilt in the UI** from each window's store snapshots plus each action's top-level `changes`, step by step. A `$root` change replaces the whole value. The UI never imports rrweb; it parses only `sr:*` events (03-L1). | D25 keeps rrweb inside `recorder-engine`. Rebuilding forward is cheap; going back restarts from the span's first snapshot. |
| L8 | **One grant per browser** (D38; user, Q30, Q31): the first session open asks for a name and reason, and that grant covers every session opened in this browser for 8 h (05-L10), or until a server restart. The session list needs no prompt. Any 403 `{need:'access'}` shows the prompt. The UI remembers the viewer's name in `localStorage` for prefill; the reason is never stored. | Saves typing without weakening the "say why for each open" rule. |
| L9 | Times show in the **recorded user's local time** (`sr:meta.tz`; user, Q29, D42), with UTC on hover. Without a `tz`, the UI falls back to UTC and says so. The day filter is a **UTC day**, labelled as such. | Support works from what the user reports ("it happened at 9:05"); UTC on hover matches server logs. |
| L10 | Small, proven libraries: `@tanstack/react-virtual` (long lists), `microdiff` (Diff tab). A hand-written JSON tree (lazy, collapsed by default). | Large action lists and 2 MB stores must not freeze the page. |
| L11 | Until the server's query API lands (B3), the UI runs on a **mock Hono API** in `apps/replay-ui/mock/`, built from the 03 fixtures (including the framed `chunks-v1.bin`) and checked against the 03 zod schemas. | Lets B2 start in parallel with the server, against the same shapes. |
| L12 | **Every `t` is raw client time** (03-L12): the API's times, the engine's ticks, bands and notes. The UI shows `t + recording.clockOffsetMs` and seeks by raw `t`. | A per-chunk skew correction jitters and isn't monotonic; mixing corrected and raw times would put markers minutes off (devil X2). |
| L13 | **Chunks arrive framed and gzipped** (03 "Chunk response framing"). `readChunks` from `@sr/protocol` splits the response and inflates each blob in the browser with `DecompressionStream`. A chunk whose integrity isn't `ok` is never played: it counts as missing. | The server never inflates, so reads stay cheap (03-L8). One shared parser for the server's tests and the UI. A chunk that failed its check can't be trusted to show the screen (devil X1). |
| L14 | **The action list merges two sources** (architect A11). The API returns only the sparse kinds (03 `ActionKind`: clicks, inputs, navigation, errors, failed requests, fidelity, reports, hotspots) for the whole session. State rows and every request row come from the loaded span's own events. | The server stores far fewer rows: state actions at 5/s and 2 fetches/s for 8 hours would be about 200,000 rows per session. The UI already holds those events in memory. |
| L15 | **Every `/api/*` call sends `X-SR-UI: 1`** (03-L14), and **empty query params are left out** (no `user: ''`, no `to: ''`). | Without the header the server refuses the call and logs it as denied. `user=` would mean "the empty user", not "any user" (devil X25). |

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
│  ● still recording │ │  └╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱┘   │ │ ...                  │
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
  A chunk that fails the check turns the note red, and the server adds a `chunk-unreadable` band.
- **Bands and notes (D10, D34)** follow 03's table. Each `FidelityReason` has a label and a
  pattern, so colour is never the only cue.
  - **Gap bands** (the screen is incomplete): `pause-budget`, `quota`, `buffer-overflow` (amber,
    hatched), `popout` (purple, hatched), `hidden-tab` (grey, hatched). While the play head is
    inside one, a banner over the player names it, as above.
  - **Gap bands that run to the next full snapshot**: `missing-batches` and `chunk-unreadable`
    (red, hatched). Inside them the engine stops applying incremental events (`setGaps`), and the
    player covers the frame with a **"Screen unknown"** overlay while `onUnknown` says so (devil
    X1; wireframe below). The state panel says its values may be out of date.
  - **Thin bands** (the screen is still complete): `snapshot-slow`; `no-state` on the separate
    **state lane**.
  - **Notes** (a tick on the scrubber, with a tooltip): `pipeline-fallback`, `state-capped`, and
    `no-clean-close` at the end of a recording without `sr:close`: "Recording ended without a
    clean close: the last seconds may be missing" (devil X19).
- **Canvas (D34)** is drawn inside the replay by the engine's placeholder style. The `ⓘ Known gaps`
  popover lists canvas, popouts and `useState` values (D39).
- **Between recordings** (a reload or a closed tab) the scrubber shows a neutral gap. Playback
  **never plays the gap in real time**: at a recording's end the player jumps to the next
  recording's first frame, with a toast, "Skipped 42 min with no page open". A click inside the
  gap lands on the next recording's start (devil X25).
- **Rate-cap legend (D36)** lists the config version and the capped grid columns, or says "No rate
  caps: every change recorded". A change during the session shows one line per version, with times.

### Wireframe: screen unknown and long seeks

```
┌─────────────────────────────────────┐   ┌─────────────────────────────────────┐
│╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱│   │                                     │
│╱╱ Screen unknown                  ╱╱│   │  Loading 10:00–10:12                │
│╱╱ Batches 41–43 never arrived.    ╱╱│   │  ▓▓▓▓▓▓▓▓▓░░░░░░░░░░   18 of 42 MB  │
│╱╱ The screen shows again from the ╱╱│   │  A busy screen: this can take a     │
│╱╱ next full snapshot at 10:24:07. ╱╱│   │  few seconds.                       │
│╱╱ [Skip to 10:24:07]              ╱╱│   │                                     │
│╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱│   │                                     │
└─────────────────────────────────────┘   └─────────────────────────────────────┘
```

- **Screen unknown** covers the frame, so no frame inside the band looks complete (01 Acceptance).
  For `chunk-unreadable` the text reads "Part of this recording can't be read (its check failed,
  or its key was erased)". "Skip to …" seeks to the next full snapshot.
- **Long seeks** (architect A5; user, 2026-11-10) are described under "Long seeks" below.

### Wireframe: access prompt (D38)

```
┌──────────────── Open session ────────────────┐
│ u123 · blotter · 2026-11-10 10:02 (1h12m)    │
│ Your name  [Priya S.                       ] │  ← remembered on this browser, 2–80 chars
│ Reason     [INC-48213 order rejected       ] │  ← required every open, 3–200 chars
│ This open is logged with your name, reason   │
│ and IP address.                              │
│                      [Cancel] [Open session] │
└──────────────────────────────────────────────┘
```

It shows before anything under `/api/sessions/:id/*` loads, including on a deep link. Cancel goes
back to the list. If the grant expires mid-replay, the player pauses, the prompt shows "Your access
to this session expired", and the replay resumes at the same position after submit. The lengths
follow 03's `AccessReq`.

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
| Player | "Pick a session on the left." No full snapshot: "No screen recorded yet: recording may still be starting, or wasn't enabled." | Nothing for 300 ms, then the progress bar (Long seeks). "Buffering…" only when playback reaches the span's end before the next window arrived. | 404: "Not found in this region. Recordings stay in their region (D37)." Chunk failure: overlay + Retry, while the loaded span still plays. Engine failure: message + "Seek past this point". |
| Action list | "No actions in this session" / "No actions match the filter" + Clear | Skeleton rows. With `state` or `net` selected: "State and request rows: 10:00–10:36 loaded" | Inline + Retry |
| State panel | "No Redux store in this session" (with a `no-state` band: "this mini-app wasn't built with the plugin"). "No state yet at this point." A key the recorder left out shows "not recorded (deny-listed for volume)" or "not recorded (over 256 KB: 1.4 MB)". | Follows the window load | Inside a `missing-batches` or `chunk-unreadable` band: "State may be out of date: part of the recording is missing, until 10:24:07." |
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
import { Day, PosKey, UserId } from '@sr/protocol';
import { z } from 'zod';

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFound });
const sessionsLayout = createRoute({          // pathless: the left column + <Outlet/>
  getParentRoute: () => rootRoute, id: 'sessions', component: SessionsLayout,
  validateSearch: z.object({
    user: UserId.optional(),                   // same rule as ingest (03)
    day: Day.optional(),                       // UTC day (D31); default: today
    errors: z.boolean().optional() }),
  search: { middlewares: [retainSearchParams(['user', 'day', 'errors'])] },
});
const indexRoute = createRoute({ getParentRoute: () => sessionsLayout, path: '/', component: PickASession });
const replayRoute = createRoute({
  getParentRoute: () => sessionsLayout, path: 'replay/$sessionId',
  validateSearch: z.object({
    pos: PosKey.optional(),                                    // '<recordingId>:<seq>:<idx>' (03-L9)
    t: z.string().regex(/^(\d+:)?\d{1,2}:\d{2}$/).optional(), // elapsed from session start
  }),
  // The player chunk (engine + rrweb) loads only when a session opens.
  component: lazyRouteComponent(() => import('./routes/replay'), 'ReplayPage'),
});
const hotspotsRoute = createRoute({
  getParentRoute: () => rootRoute, path: 'hotspots',
  validateSearch: z.object({ day: Day.optional(), app: z.string().max(64).optional() }),
  component: lazyRouteComponent(() => import('./routes/hotspots'), 'HotspotsPage'),
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([sessionsLayout.addChildren([indexRoute, replayRoute]), hotspotsRoute]),
});
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
```

### API client and React Query hooks

```ts
// Sample — not final code. apps/replay-ui/src/api/client.ts
import { hc } from 'hono/client';
import type { QueryApi } from '../../mock/types';   // U10 switches to apps/server's QueryApi (L11)

/** Every /api call carries X-SR-UI: 1. The server refuses /api/* without it, so a forged
 *  recording can't call the API from the replay iframe with the viewer's cookie (03-L14). */
export const api = hc<QueryApi>('/', { headers: { 'X-SR-UI': '1' } });

/** Leaves out unset params: `user=` would mean "the empty user", not "any user" (L15). */
export const compact = <T extends Record<string, string | undefined>>(q: T) =>
  Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== '')) as { [K in keyof T]?: string };
```

```ts
// Sample — not final code. apps/replay-ui/src/api/queries.ts
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { posKey, readChunks } from '@sr/protocol';
import type { LoadChunk } from '@sr/recorder-engine/replay';   // types only (D25)
import type { ReplayWindow } from '../features/player/windows';
import { api, compact } from './client';
import { ApiError, unwrap } from './errors';   // non-2xx → ApiError; 403 {need:'access'} = no grant

// Access and not-found errors are answers, not glitches: don't retry them.
const retry = (n: number, e: unknown) => !(e instanceof ApiError && [400, 401, 403, 404].includes(e.status)) && n < 2;

export type SessionFilter = { user?: string; day: string; errors?: boolean };
export const sessionsQuery = (f: SessionFilter) => queryOptions({
  queryKey: ['sessions', f],
  queryFn: async () => unwrap(await api.api.sessions.$get({
    query: compact({ user: f.user, day: f.day, hasErrors: f.errors ? '1' : undefined }) })),
  placeholderData: keepPreviousData, staleTime: 30_000, retry,
});
export const sessionQuery = (id: string) => queryOptions({
  queryKey: ['session', id],
  queryFn: async () => unwrap(await api.api.sessions[':id'].$get({ param: { id } })),
  staleTime: 60_000, retry,
});
// actionsQuery(id): every row the API holds for the session (sparse kinds only, L14), following
// `after` pages of 1000. No `kinds` param: the list filters locally.

export type SeqRange = { fromSeq: number; toSeq: number };
export type WindowData = { chunks: LoadChunk[]; missing: SeqRange[] };
export type OnBytes = (done: number, total: number | null) => void;

export const windowQuery = (id: string, w: ReplayWindow, onBytes?: OnBytes) => queryOptions({
  queryKey: ['session', id, 'window', w.idx],
  queryFn: ({ signal }) => loadWindow(id, w, signal, onBytes),
  staleTime: w.live ? 0 : Infinity,   // closed windows never change
  gcTime: 2 * 60_000,                 // with L4's "≤ 3 windows", bounds memory
  retry,
});

const countBytes = (on: (n: number) => void) =>
  new TransformStream<Uint8Array, Uint8Array>({ transform(c, ctl) { on(c.byteLength); ctl.enqueue(c); } });

/** One window's chunks, following `next` when the 8 MiB cap cut the response (03). A chunk that
 *  failed its check or can't be read is never played: it joins `missing` (L13, devil X1). */
const loadWindow = async (id: string, w: ReplayWindow, signal: AbortSignal, onBytes?: OnBytes) => {
  const out: WindowData = { chunks: [], missing: [] };
  let cursor: string | undefined;
  do {
    const res = await api.api.sessions[':id'].chunks.$get(
      { param: { id }, query: compact({ from: posKey(w.from), to: w.to ? posKey(w.to) : undefined, cursor }) },
      { init: { signal } });
    if (!res.ok) throw await ApiError.from(res);
    const total = Number(res.headers.get('Content-Length')) || null;
    let done = 0;
    const body = res.body!.pipeThrough(countBytes((n) => onBytes?.((done += n), total)));
    const { header, batches } = await readChunks(body);    // splits the frames; inflates with DecompressionStream
    for (const { meta, events } of batches) {
      if (meta.integrity === 'ok') out.chunks.push({ recordingId: meta.recordingId, seq: meta.seq, events });
      else out.missing.push({ fromSeq: meta.seq, toSeq: meta.seq });
    }
    out.missing.push(...header.missing);
    cursor = header.next ?? undefined;
  } while (cursor);
  return out;
};

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
  t: number;                     // play head, raw client ms (L12); updated ≤ 10×/s (L6)
  pos: StreamPos | null;         // last event the engine applied
  span: { first: number; last: number } | null;   // windows loaded in the engine (L4)
  unknown: boolean;              // inside a missing-batches / chunk-unreadable band (devil X1)
  progress: { phase: 'fetch' | 'build'; done: number; total: number | null } | null;  // long seeks (A5)
  viewport: { width: number; height: number } | null;   // recorded size, for scale-to-fit
  follow: boolean;               // the action list scrolls with the play head
};
type PlayerActions = { patch: (p: Partial<PlayerState>) => void; reset: (id: string | null) => void };
const initial: PlayerState = { sessionId: null, status: 'idle', t: 0, pos: null, speed: 1, span: null,
  unknown: false, progress: null, viewport: null, follow: true, error: null };

// Plain data only: commands live in PlayerController, so the store is easy to test and inspect.
export const usePlayerStore = create<PlayerState & PlayerActions>()((set) => ({
  ...initial,
  patch: (p) => set(p),
  reset: (sessionId) => set({ ...initial, sessionId, speed: usePlayerStore.getState().speed }),
}));
```

Panel choices (action kinds, search text, state tab, selected store) live in a second
small `usePanelStore`, so a play-head tick never re-renders the filters. Components read with
selectors (`usePlayerStore((s) => s.status)`), or `useShallow` for several fields.

### Windows and spans (L4)

**Windows** (`windows.ts`): `buildWindows(detail)` turns `detail.snapshots` into one window per
FullSnapshot anchor. Positions order by recording, then `seq`, then `idx` (`comparePos`, 03-L9;
`lib/pos.ts` builds the order map from `detail.recordings`). `windowAtPos` and `windowAtTime`
binary-search them; a time between two recordings snaps to the next recording's first window.
The last window of each recording has `to: null`, and the chunk query leaves `to` out, so the
server reads to the end of `from`'s recording.

```ts
// Sample — not final code. apps/replay-ui/src/features/player/windows.ts
import { comparePos, type SessionDetail, type StreamPos } from '@sr/protocol';

export type ReplayWindow = {
  idx: number;                 // position in the session's window list
  rec: number;                 // its recording's index in detail.recordings (03-L9 order)
  from: StreamPos;             // the FullSnapshot event's own position (03 `snapshots`, with idx)
  to: StreamPos | null;        // the next anchor in the same recording; null: to the recording's end
  t0: number; t1: number;      // raw client ms (L12)
  live: boolean;               // the last window of a live session: it can still grow
};

/** One window per FullSnapshot anchor. A window never crosses recordings (03 Chunks, devil X25). */
export const buildWindows = (d: SessionDetail): ReplayWindow[] => {
  const order = new Map(d.recordings.map((r, i) => [r.recordingId, i]));
  const anchors = [...d.snapshots].sort((a, b) => comparePos(a, b, order));
  return anchors.map(({ t, ...from }, i) => {
    const next = anchors[i + 1];
    const rec = order.get(from.recordingId)!;
    const same = next?.recordingId === from.recordingId;
    return { idx: i, rec, from, to: same ? { recordingId: next.recordingId, seq: next.seq, idx: next.idx } : null,
             t0: t, t1: same ? next.t : d.recordings[rec]!.endedAt,
             live: d.live && !same && rec === d.recordings.length - 1 };
  });
};
```

**What a window loads.** The chunks route returns whole chunks (stored gzip blobs), so the chunk
that holds the next anchor belongs to both windows. The controller keeps the set of `seq`s already
in the engine and appends only new ones. The engine starts at the first FullSnapshot it is given
(04). Chunks with `integrity` other than `ok`, and the header's `missing` ranges, go to
`engine.setGaps()`.

**The span.** One engine holds windows `first..last`, all in one recording:
- **Append:** once 60 % of the current window has played, the controller fetches the next window
  and calls `engine.append()`. No rebuild, so the edge doesn't flash.
- **Evict:** when the span already holds 3 windows and the play head enters the last one, the
  controller rebuilds with just that window. The play head is just past a full snapshot, so the
  rebuild is quick and shows the same frame. The next window is appended as usual.
- **Seek:** inside the span, `engine.seek()` only. Before or past it, a rebuild at the target's
  window.
- **Rebuild without a blank:** the new engine is built in a hidden layer of the stage and swapped
  in after `load()` and `seek()`; only then is the old engine destroyed.
- **End of a recording:** the controller jumps to the next recording's first frame with the
  "Skipped …" toast. It never plays the time between recordings.

### Driving `ReplayEngine`

`04-recorder.md` owns the engine API (D25): `load(chunks) → {t0, t1, firstFrame}`,
`append(chunks)`, `setGaps(missing)`, `onUnknown(cb)`, `onSeekProgress(cb)` (feeds the "build" phase of the progress bar), `seek({pos} | {t})`, `play`, `pause`,
`setSpeed`, `onMarker`, `onTick({t, pos})`, `onViewport`, `onEnd`, `destroy`.

```ts
// Sample — not final code. apps/replay-ui/src/features/player/controller.ts
import type { QueryClient } from '@tanstack/react-query';
import type { SessionDetail, StreamPos } from '@sr/protocol';
import { createReplayEngine, type ReplayEngine } from '@sr/recorder-engine/replay'; // D25
import { windowQuery, type OnBytes, type SeqRange, type WindowData } from '../../api/queries';
import { isAccessError } from '../../api/errors';
import { buildWindows, windowAtPos, windowAtTime } from './windows';
import { hiddenLayer, showLayer } from './layers';
import { skippedToast } from './toasts';
import { usePlayerStore, type Speed } from './store';

type Target = { pos: StreamPos } | { t: number };   // t: raw client ms (L12)
const TICK_MS = 100;        // L6
const APPEND_AT = 0.6;      // append the next window once 60 % of the current one has played
const MAX_WINDOWS = 3;      // L4
const SLOW_MS = 300;        // show the progress bar after this long (A5)
const frame = () => new Promise((r) => requestAnimationFrame(r));

export const createPlayerController = (o: { qc: QueryClient; detail: SessionDetail; stage: HTMLElement }) => {
  const { patch } = usePlayerStore.getState();
  const windows = buildWindows(o.detail);
  const data = (i: number, onBytes?: OnBytes): Promise<WindowData> =>
    o.qc.ensureQueryData(windowQuery(o.detail.sessionId, windows[i]!, onBytes));
  let engine: ReplayEngine | null = null, layer: HTMLElement | null = null;
  let first = -1, last = -1, current = -1;     // the span: windows first..last, one recording
  let seqs = new Set<number>(), missing: SeqRange[] = [];
  let appending: Promise<void> | null = null;
  let gen = 0, lastTick = 0;                   // gen: bumped by every rebuild and by destroy
  const full = () => last - first + 1 >= MAX_WINDOWS;
  const sameRec = (a: number, b: number) => windows[a]?.rec === windows[b]?.rec;
  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) {
      patch(isAccessError(e) ? { status: 'access' } : { status: 'error', error: String(e) });
    }
  };

  /** Appends window i to the current engine: no rebuild, so the edge doesn't flash (A6). */
  const append = (i: number) => appending ??= (async () => {
    if (i !== last + 1 || !windows[i] || !sameRec(i, last) || full()) return;
    const my = gen;
    const d = await data(i);
    if (my !== gen) return;                    // a rebuild overtook us
    const add = d.chunks.filter((c) => !seqs.has(c.seq));   // the edge chunk is in both windows
    add.forEach((c) => seqs.add(c.seq));
    missing = [...missing, ...d.missing];
    engine!.append(add);
    engine!.setGaps(missing);
    last = i; patch({ span: { first, last } });
  })().finally(() => { appending = null; });

  /** A fresh engine holding window i, at `target`. Built in a hidden layer and swapped in when
   *  ready, so the screen never blanks. Used on open, on evict and on a seek outside the span. */
  const rebuild = async (i: number, target: Target | 'first-frame') => {
    const my = ++gen;
    const slow = setTimeout(() => patch({ progress: { phase: 'fetch', done: 0, total: null } }), SLOW_MS);
    try {
      const d = await data(i, (done, total) => my === gen && patch({ progress: { phase: 'fetch', done, total } }));
      if (my !== gen) return false;
      const nextLayer = o.stage.appendChild(hiddenLayer());
      const next = createReplayEngine({ root: nextLayer, assetUrl: (sha) => `/assets/${sha}` }); // D33
      const info = await next.load(d.chunks);              // → { t0, t1, firstFrame }
      if (usePlayerStore.getState().progress) { patch({ progress: { phase: 'build', done: 0, total: null } }); await frame(); }
      if (my !== gen) { next.destroy(); nextLayer.remove(); return false; }
      next.setGaps(d.missing);                             // "screen unknown" up to the next full snapshot (X1)
      wire(next);
      next.seek(target === 'first-frame' ? { pos: info.firstFrame } : target);   // synchronous
      next.setSpeed(usePlayerStore.getState().speed);
      engine?.destroy(); layer?.remove();                  // swap: the old frame stayed visible until now
      engine = next; layer = showLayer(nextLayer);
      first = last = current = i;
      seqs = new Set(d.chunks.map((c) => c.seq)); missing = d.missing;
      patch({ span: { first, last } });
      return true;
    } finally { clearTimeout(slow); if (my === gen) patch({ progress: null }); }
  };

  const onTick = ({ t, pos }: { t: number; pos: StreamPos }) => {
    const i = windowAtPos(windows, pos);
    if (i !== current) {
      current = i;
      if (i === last && full() && sameRec(i, i + 1)) void run(() => evict(i, pos));
    }
    const w = windows[current]!;
    if (t - w.t0 > (w.t1 - w.t0) * APPEND_AT) void run(() => append(current + 1));
    const now = performance.now();
    if (now - lastTick >= TICK_MS) { lastTick = now; patch({ t, pos }); }
  };

  // The span is full and the play head entered its last window: keep only that window (L4).
  const evict = async (i: number, pos: StreamPos) => {
    const playing = usePlayerStore.getState().status === 'playing';
    engine?.pause();
    if ((await rebuild(i, { pos })) && playing) play();
  };

  // The span ran out. Same recording: the next window wasn't appended in time ("Buffering…").
  // Next recording: jump to its first frame; the time between recordings is never played (X25).
  const onEnd = async () => {
    const next = windows[last + 1];
    if (!next) return patch({ status: 'ended' });
    if (!sameRec(last, last + 1)) {
      skippedToast(o.detail, windows[last]!, next);       // "Skipped 42 min with no page open"
      if (await rebuild(last + 1, 'first-frame')) play();
      return;
    }
    patch({ status: 'buffering' });
    if (full()) { if (await rebuild(last + 1, { pos: next.from })) play(); return; }
    await append(last + 1);
    play();
  };

  const wire = (e: ReplayEngine) => {
    e.onViewport((viewport) => patch({ viewport }));
    e.onTick(onTick);
    e.onUnknown(({ unknown }) => patch({ unknown }));          // the "Screen unknown" overlay (X1)
    e.onEnd(() => void run(onEnd));
  };

  const seek = (target: Target) => run(async () => {
    const i = 'pos' in target ? windowAtPos(windows, target.pos) : windowAtTime(windows, target.t);
    const resume = usePlayerStore.getState().status === 'playing';
    const snap = 't' in target && target.t < windows[i]!.t0;  // a time between recordings
    if (i >= first && i <= last && !snap) engine!.seek(target);  // inside the span: no rebuild
    else if (!(await rebuild(i, snap ? 'first-frame' : target))) return;
    if (resume) play(); else patch({ status: 'paused' });
  });

  // First frame = first DOM change after the first full snapshot (spike: the snapshot is an empty #root).
  const open = (start?: Target) => run(async () => {
    patch({ status: 'loading' });
    if (start) return seek(start);
    if (await rebuild(0, 'first-frame')) patch({ status: 'paused' });
  });

  const play = () => { engine?.play(); patch({ status: 'playing' }); };
  const pause = () => { engine?.pause(); patch({ status: 'paused' }); };
  const setSpeed = (speed: Speed) => { engine?.setSpeed(speed); patch({ speed }); };
  const destroy = () => {
    gen++; engine?.destroy(); layer?.remove(); engine = null; layer = null; first = last = current = -1;
  };

  return { open, seek, play, pause, setSpeed, destroy };
};
export type PlayerController = ReturnType<typeof createPlayerController>;
```

The page owns the controller. **A `useEffect` must not return a Promise** (spike lesson), so it
calls `void ctl.open(start)` and returns `ctl.destroy`. `start` comes from `?pos=` or `?t=` once;
later URL changes call `ctl.seek`. **Scale-to-fit** scales the UI's own stage `div` from
`viewport` with a `ResizeObserver`, so the UI never touches rrweb's wrapper element.

### Times (L12)

```ts
// Sample — not final code. apps/replay-ui/src/lib/time.ts
import type { SessionDetail } from '@sr/protocol';

/** Wall-clock ms for display only: raw client time plus that recording's offset (03-L12).
 *  Seeks, bands, markers and the scrubber all stay on raw time (devil X2). */
export const displayMs = (d: SessionDetail, t: number) => {
  const r = d.recordings.findLast((r) => r.startedAt <= t) ?? d.recordings[0];
  return t + (r?.clockOffsetMs ?? 0);
};

/** `?t=h:mm:ss` is time elapsed from the session's start, so raw t = startedAt + elapsed. */
export const tFromClock = (d: SessionDetail, clock: string) => d.startedAt + parseClock(clock);
```

- The scrubber maps pixels to raw `t` across the session's recordings; labels and tooltips use
  `displayMs`, then L9's local time with UTC on hover.
- `←`/`→` move 5 s of raw time. A step that lands between recordings snaps to the next one.

### Long seeks (architect A5)

Opening a session, or seeking outside the loaded span, can take a while on the busiest desk.
- **Under 300 ms:** nothing extra shows.
- **Downloading:** a bar over the player, "Loading 10:00–10:12 · 18 of 42 MB". Bytes are counted as
  they arrive, against `Content-Length` when the server sends one; without it the bar is
  indeterminate and shows the MB so far. If a prefetch already started that window, the bar is
  indeterminate too.
- **Building:** "Building the screen…", painted (one animation frame) before the engine's
  synchronous seek starts.
- **Target:** under 2 s. On the busiest desk a seek may take longer behind the bar (user,
  2026-11-10).
- A new seek or a session switch overtakes the old one (the `gen` token). Its download still
  finishes into the cache.

### Action list rows (L14)

```ts
// Sample — not final code. apps/replay-ui/src/features/actions/rows.ts
import { comparePos, posKey, type ActionRow } from '@sr/protocol';
import type { LoadChunk } from '@sr/recorder-engine/replay';
import { srEvent } from '../../lib/sr-events';   // { tag, payload, t } for a type-5 `sr:*` event, else null

export type Row = Omit<ActionRow, 'kind'> & { kind: ActionRow['kind'] | 'state'; local?: true };

/** State rows and every request row for the loaded span, built from its own events. */
export const localRows = (chunks: LoadChunk[]): Row[] => chunks.flatMap((c) =>
  c.events.flatMap((e, idx): Row[] => {
    const ev = srEvent(e);
    if (!ev) return [];
    const pos = { recordingId: c.recordingId, seq: c.seq, idx };
    if (ev.tag === 'sr:state' && ev.payload.op === 'action')
      return [{ pos, t: ev.t, kind: 'state', name: ev.payload.type ?? '', summary: changedKeys(ev.payload),
                app: ev.payload.store.split('/')[0], local: true }];
    if (ev.tag === 'sr:net')
      return [{ pos, t: ev.t, kind: 'net', name: `${ev.payload.method} ${ev.payload.status}`, summary: ev.payload.url,
                failed: ev.payload.status === 0 || ev.payload.status >= 400, local: true }];
    return [];
  }));

/** API rows plus local rows, in stream order. A failed request is in both lists and shows once. */
export const mergeRows = (fromApi: Row[], local: Row[], order: ReadonlyMap<string, number>) => {
  const seen = new Set(fromApi.map((r) => posKey(r.pos)));
  return [...fromApi, ...local.filter((r) => !seen.has(posKey(r.pos)))].sort((a, b) => comparePos(a.pos, b.pos, order));
};
```

- With `state` or "all requests" selected, the list says which part is loaded. Back/next with
  only those kinds selected moves within the loaded span.
- State rows take their mini-app from the store name (`<app>/redux#<n>`, 07-L9).

### State at a position

```ts
// Sample — not final code. apps/replay-ui/src/features/state/reconstruct.ts
import type { StreamPos } from '@sr/protocol';

/** One `sr:state` event from the loaded span, in stream order (03 SrPayload['sr:state']). */
export type StateStep = { pos: StreamPos; t: number; store: string; op: 'snapshot' | 'action';
  type?: string; state?: unknown; changes?: Record<string, unknown>; removed?: string[] };
export type StoreView = { value: unknown; since: StreamPos; partial: boolean };
export type StateCache = { upTo: number; stores: Map<string, StoreView> };   // upTo: index in steps
export const EMPTY: StateCache = { upTo: -1, stores: new Map() };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One step applied to a store's value. A snapshot replaces it. `$root` also replaces it: the
 *  store's state isn't a plain object (07 topDiff; devil X12). Values may be NotRecorded (03). */
const apply = (cur: unknown, s: StateStep): unknown => {
  if (s.op === 'snapshot') return s.state;
  if (s.changes && '$root' in s.changes) return s.changes.$root;
  const value = { ...(isObj(cur) ? cur : {}), ...s.changes };
  for (const k of s.removed ?? []) delete value[k];
  return value;
};

/** Every store after steps[0..upTo]. Forward reuses `prev`; backward restarts from the span's
 *  first step (L7). `partial`: no snapshot of that store yet in the span. */
export const stateAt = (steps: StateStep[], upTo: number, prev: StateCache = EMPTY): StateCache => {
  const base = prev.upTo <= upTo ? prev : EMPTY;
  const stores = new Map(base.stores);
  for (let i = base.upTo + 1; i <= upTo; i++) {
    const s = steps[i]!;
    const cur = stores.get(s.store);
    const snap = s.op === 'snapshot';
    stores.set(s.store, { value: apply(cur?.value, s), since: snap ? s.pos : cur?.since ?? s.pos,
                          partial: snap ? false : cur?.partial ?? true });
  }
  return { upTo, stores };
};
```

- **Snapshots per window:** the recorder snapshots every store at start and right after every
  FullSnapshot (03-L11), so each window starts with complete state.
- **Not recorded:** a `NotRecorded` value (`{ $sr: 'not-recorded', why, bytes? }`, 03) renders as a
  grey chip: "not recorded (deny-listed for volume)" for `denied`, "not recorded (over 256 KB:
  1.4 MB)" for `capped` (devil X3, X11). The Diff tab treats it as one opaque value.
- **Action tab:** the type and `changes` of the state action at or just before the play head (or
  the one clicked in the list).
- **Diff tab:** `microdiff(before[key], after[key])` for each changed key, shown as path, old and new.
- **State tab:** the rebuilt state, collapsed by default, with a search box. During playback it
  re-renders at most 4×/s.

### Build, dev and CSP

- `bun run build` runs `build.ts` (`Bun.build`, `splitting: true`, `minify: true`, an explicit
  `naming` that never writes under `assets/`) into `apps/replay-ui/dist/`. A test fails if
  `dist/index.html` holds an inline `<script>`, or if any file lands under `dist/assets/`, which
  would collide with `/assets/:sha256`. 05-C9 names Vite's `build.assetsDir`; the UI is built with
  Bun (L1), so the same rule applies to Bun's `naming` (devil X28).
- **The UI's own icons and fonts are inlined.** D30 allows images and fonts only from `/assets/`
  and `data:`. So icons are inline SVG or `data:` URLs, fonts are system fonts (or `data:`), and
  `index.html` sets a `data:` favicon; otherwise the browser's own `/favicon.ico` request is a CSP
  violation.
- `bun run dev` serves `index.html` through Bun's HTML import with hot reload, and proxies `/api`
  and `/assets` to `SR_API` (default: the mock on port 3310).
- `bun run preview` serves `dist/` with **the exact D30 CSP header**, so CSP problems show early.
- `apps/server` serves `dist/` with a history fallback for `/replay/*` and `/hotspots` (05).

### Contracts this UI uses

The 2026-11-10 contract requests (C1–C14) are all in 03 and 04 now. What the UI relies on:
- **03:** `SessionSummary` and `SessionPage`; `SessionDetail` with `recordings` (order,
  `clockOffsetMs`, `cleanClose`, `gaps`, `dups`), `snapshots` (FullSnapshot positions with `idx`
  and `t`), `bands`, `notes` and `rateCaps`; `ActionRow` and `ActionPage` (sparse kinds, `after`
  and `to` exclusive); the framed chunk response and `readChunks`; `NotRecorded`; `posKey`,
  `parsePos`, `comparePos` (L9); `X-SR-UI` (L14); the error bodies (`{need:'access'}`,
  `{error:'not-found'}`, `{error:'ui-header'}`).
- **04 (`ReplayEngine`, D25):** the API listed under "Driving `ReplayEngine`", plus
  `createReplayEngine({ root, assetUrl })` and the `LoadChunk` type.
- **05:** `QueryApi` from `apps/server/src/api` (U10); grants per 05-L10.
- **To confirm with 03:** an omitted `to` on the chunks route reads to the end of `from`'s
  recording (used for the last window of each recording).

## Guidelines

**Do**
- Seek actions by `pos` and the scrubber by raw `t`. Let the engine add the +1 ms.
- Show `t + clockOffsetMs`; never seek or compare with display times (L12).
- Create one controller per open session and destroy it on unmount or session switch.
- Check the `gen` token after every `await` in the controller.
- Call the API only through the shared client, so `X-SR-UI` is always sent; leave out empty params.
- Show every gap as a labelled band. Say "unchanged since received", never "verified".
- Parse search params with zod and reject bad ids before fetching.
- Use 03's types. Treat unknown `sr:*` tags and fields as "ignore" (03-L3).

**Don't**
- Import `rrweb` or `@rrweb/*` anywhere in `apps/replay-ui` (D25; a test enforces it).
- Add inline scripts, `eval`, or fonts and images from other origins or from `dist/` (D30).
- Store the reason, or prefill it from a URL.
- Build a fresh engine at every window edge, or play the time between recordings.
- Play events from a chunk whose integrity isn't `ok`.
- Render the full state JSON on every tick, or fetch a whole session's events at once.
- Keep the engine, DOM nodes or event arrays in React state or Zustand.

## Acceptance

- [ ] Routes `/`, `/replay/:id?pos=`, `/replay/:id?t=` and `/hotspots?day=&app=` work. A reload keeps filters and position. Bad params show a message and send no request.
- [ ] Every `/api/*` request carries `X-SR-UI: 1`, and none sends an empty query param (checked against the mock's request log).
- [ ] The list filters by user and UTC day, with an "errors only" toggle. Badges show errors, failed requests, reports, fidelity drops and "still recording". A session across UTC midnight shows on both days.
- [ ] Opening a session without a name and a reason is impossible. Cancel returns to the list. A reload within the grant doesn't prompt again. An expired grant pauses, prompts, then resumes at the same position.
- [ ] `?pos=` shows the frame before the app's reaction (D16). `?t=1:02:13` shows that time. A position outside the session opens at the start with a toast.
- [ ] Play/pause, back/next (following the action filter), all six speeds, scrubber drag and every shortcut work. Shortcuts do nothing while typing in a field or with a dialog open.
- [ ] Every `FidelityReason` shows as the band or note 03's table gives it, with a label and a pattern. A banner shows while the play head is inside a gap. Popout bands and the canvas placeholder are visible (D34).
- [ ] Inside a `missing-batches` or `chunk-unreadable` band the "Screen unknown" overlay covers the frame until the next full snapshot, so no frame inside it looks complete (devil X1). "Skip to …" lands on that snapshot. A recording without `sr:close` shows the "ended without a clean close" note.
- [ ] Playback never plays the time between recordings: at a recording's end it jumps to the next one's first frame with a "Skipped …" toast.
- [ ] A client clock 5 min off: markers, bands, the action list and the scrubber line up with the screen; labels show `t + clockOffsetMs` (devil X2).
- [ ] The rate-cap legend shows the config version and capped columns, or "No rate caps". A mid-session change shows both versions.
- [ ] Every session shows "identity: client-asserted" and "unchanged since received". A chunk with a failed hash check shows a red note and its band, and its events are never played.
- [ ] Action list: filters by kind (no mini-app filter in the MVP, Q27), failed requests in red, a click seeks by position, the list follows the play head until the user scrolls, and 10,000 rows scroll smoothly. State and request rows come from the loaded span, merged with the API's rows by position with no duplicates.
- [ ] State panel: Action / Diff / State are correct at any position (store snapshots + actions), with a store picker. `$root` stores, deny-listed and capped keys (`NotRecorded`), the no-store and `no-state` cases show correctly; inside an unknown band the panel says its state may be out of date.
- [ ] An 8-hour busy session fetches only the windows it plays (the current one and the next). A seek finishes in under 2 s; on the busiest desk it may take longer, with the progress bar after 300 ms (user, 2026-11-10). At most 3 windows stay in memory. Playback crosses a window edge with no rebuild and no flash, showing "Buffering…" only if the next window hasn't arrived.
- [ ] A framed chunk response, including an `unreadable` chunk with 0 bytes and a response cut by `next`, loads through `readChunks` and `DecompressionStream` (the mock serves `chunks-v1.bin`).
- [ ] Awkward states: switching sessions mid-load (no stale frame, no error); a background tab during playback; two replay tabs on different sessions; browser back/forward between sessions; window resize; going offline mid-load (error + Retry); a 404 (region note); refreshing a live session.
- [ ] Hotspots: day and app filters, sorting, and "open" lands on the pause position after the access prompt. Empty, loading and error states work.
- [ ] The built UI, served by `apps/server` with the D30 CSP, shows no CSP violations in the console, the iframe makes no network requests, and `dist/` has no inline scripts and nothing under `assets/`.
- [ ] Twenty session switches in a row leave no growing heap (old engines, layers and iframes are freed).

## Tasks

Commands for tier 1: `bunx tsc --noEmit -p apps/replay-ui` and `bun test apps/replay-ui`.
All paths are under `apps/replay-ui/`. Unit tests sit next to the code they test (`*.test.ts`),
inside each task's `owns:`.

- [ ] **U1 Scaffold** — owns: `package.json`, `tsconfig.json`, `index.html`, `build.ts`, `dev.ts`, `src/main.tsx`, `src/router.tsx`, `src/routes/*` (placeholders), `test/build.test.ts` — batch: B1 — depends on: 01 X1 (`tsconfig.base.json`, `biome.json`) — done when: the build writes `dist/` with no inline script and nothing under `dist/assets/`; `index.html` has a `data:` favicon; the three routes render placeholders; a test fails on any `@rrweb/*` import; tier 1 passes.
- [ ] **U2 API layer and mock** — owns: `src/api/**`, `mock/**` — batch: B2 — depends on: 03 T1, T2; U1 — done when: every mock response validates against the 03 schemas; the mock serves the framed `chunks-v1.bin`, and `windowQuery` loads it through `readChunks` (non-`ok` chunks go to `missing`, `next` is followed); every request carries `X-SR-UI: 1` and no empty param; the hooks are tested against the mock, including 403 `{need:'access'}`; `MOCK_SCENARIO=slow|error|empty|expired|live` works.
- [ ] **U3 Shell and session list** — owns: `src/routes/{root,sessions-layout,sessions-index}.tsx`, `src/features/sessions/**`, `src/styles/**` — batch: B2 — depends on: U2 — done when: filters sync with the URL; all badges render from fixtures; empty, loading and error show under the mock scenarios; search-param parsing is unit-tested.
- [ ] **U4a Windows, positions and times** — owns: `src/features/player/windows.ts`, `src/lib/{pos,time,sr-events}.ts` — batch: B3 — depends on: U1; 03 T2 — done when: unit tests cover one window per anchor at the FullSnapshot's own `idx`, no window across recordings, `to: null` at each recording's end, `windowAtTime` snapping between recordings, position order across recordings, `displayMs` with two recordings and different offsets, and clock parsing.
- [ ] **U4b Player controller and replay route** — owns: `src/features/player/{store,controller,layers,toasts}.ts`, `src/routes/replay.tsx` — batch: B3 — depends on: U4a, U2, U3; 04 R3's `ReplayEngine` (a `FakeReplayEngine` in the tests until it lands) — done when: controller tests with the fake engine cover append at 60 %, the shared edge chunk appended once, no rebuild at an edge, evict at 3 windows, a rebuild on a seek outside the span, the jump between recordings with its toast, `setGaps` from `missing` plus non-`ok` chunks, `onUnknown` → `unknown`, progress after 300 ms, destroy mid-load and the `gen` guard; deep links work on the mock.
- [ ] **U5 Controls, scrubber, bands, notes, overlays, shortcuts** — owns: `src/features/player/{Player,Controls,Scrubber,Bands,Legend,Notes,Overlays}.tsx`, `src/features/player/shortcuts.ts` — batch: B3 — depends on: U4b — done when: each `FidelityReason` fixture renders as 03's table says; the "Screen unknown" overlay and the progress bar render from the store; scrubber labels use `displayMs`; the shortcut map is unit-tested, including focus rules; legend and notes render from `SessionDetail`.
- [ ] **U6 Action list** — owns: `src/features/actions/**` — batch: B3 (parallel with U5, U7) — depends on: U4b — done when: `localRows` from fixture chunks, `mergeRows` with no duplicate failed requests, filters, virtualisation, click-to-seek by `pos`, follow mode and back/next targets are unit-tested.
- [ ] **U7 State panel** — owns: `src/features/state/**` — batch: B3 (parallel with U5, U6) — depends on: U4b — done when: `stateAt` tests cover snapshot + actions, removed keys, `$root`, `NotRecorded` values, several stores, a partial store, and "forward from cache equals full recompute"; the three tabs render fixture data.
- [ ] **U8 Access prompt and expiry** — owns: `src/features/access/**` — batch: B3 — depends on: U2, U4b — done when: the prompt blocks loading until granted; the name is remembered and the reason isn't; the lengths follow `AccessReq`; expiry mid-replay pauses and resumes at the same position (mock `expired`).
- [ ] **U9 Hotspots page** — owns: `src/routes/hotspots.tsx`, `src/features/hotspots/**` — batch: B4 — depends on: U2; 05 S8 hotspots API (or the mock) — done when: filters, sorting and the example link work on fixtures; empty, loading and error are covered.
- [ ] **U10 Real server and CSP** — owns: `src/api/client.ts` (from U2), `test/csp.test.ts` — batch: B4 — depends on: 05 S7 (query API); 04 R3 (the inert URL rewrite, devil X27); U1–U9 — done when: the UI type-checks against `QueryApi`; the golden session replays from `apps/server` with the D30 CSP and no violations. (qa writes the e2e specs in `specs` mode during B3–B4; they first run at the gate.)

## Risks

| Risk | Mitigation |
|---|---|
| A long seek on the busiest desk blocks the page while rrweb applies events synchronously; the bar can't move during that part. | "Building the screen…" is painted first; R0 measures the worst seek (end of a 12-min S2 window); checkpoints by mutation count (03 `checkpointMutations`) keep windows short; K5 re-measures with the built bundles. |
| Appending windows grows one Replayer's memory. | At most 3 windows per span; evict rebuilds with one window; a heap check in Acceptance. |
| The chunk holding the next anchor belongs to two windows and gets appended twice. | The controller tracks the `seq`s in the engine; U4b tests it. |
| A rebuild shows a blank frame. | The new engine is built in a hidden layer and swapped in after `seek`. |
| Huge action lists (state actions at 5/s, 2 fetches/s for 8 h). | The API stores sparse kinds only (L14); state and request rows come from the loaded span; virtualised list. |
| Rebuilding a 2 MB store on every tick. | Incremental `stateAt`, render ≤ 4×/s, collapsed tree. A worker later if needed (CSP allows same-origin workers). |
| The D30 CSP blocks the UI's own images and fonts (only `/assets/` and `data:` are allowed). | Icons and fonts inlined, a `data:` favicon; `bun run preview` and U10 check for violations. |
| The mock drifts from the real server. | The mock is validated by the same zod schemas and serves 03's `chunks-v1.bin`; U10 switches to the real type. |
| UTC days confuse APAC staff. | Labels; times in the recorded user's local time with UTC on hover (D42). |
| Old engines or iframes leak when switching sessions. | `destroy` plus the `gen` guard; a heap check in acceptance. |

## Open questions

All answered by the user on 2026-11-10 (01, Q27, Q29–Q32):
1. **Times:** the **recorded user's local time** (from `sr:meta.tz`), with UTC on hover (D42).
2. **Access:** one name + reason covers every session opened in that browser for 8 h (D38).
3. **Session list:** no prompt; searches are logged.
4. **Mini-app filter:** not in the MVP.
5. **Hotspots:** opens on yesterday.

## Log

- 2026-11-10 — drafted for the plan split (agent)
- 2026-11-10 — Reviewed and merged into `plan/` by the leader. The contract assumptions C1–C14 are now in 03 (shapes, `posKey`, bands and notes, paging) and 04 (`ReplayEngine`); D30 gained `style-src` in 01. `SessionDetail` also carries `notes` for single-event reasons.
- 2026-11-10 — Architect and devil review merged (agent draft for the leader): framed gzip chunks
  read with `readChunks` and `DecompressionStream`, `X-SR-UI` on every call, no empty params (A4,
  X14, X25); windows start at a FullSnapshot's own position and never cross recordings, and the
  player jumps between recordings (X25); one Replayer per span with `append()`, rebuilt only on
  evict or a seek outside the span, so the old edge flash is gone (A6); raw times with
  `clockOffsetMs` for display (X2); "Screen unknown" inside gap bands, the `no-clean-close` note
  and `NotRecorded` placeholders (X1, X3, X11, X19); sparse API action rows with state and request
  rows built locally, `$root` in `stateAt` (A11, X12); a progress bar for long seeks (A5, user); the
  Bun build must not write under `assets/` (X28); U4 split into U4a and U4b; U10 depends on R3
  (X27); access prompt lengths follow `AccessReq`.
- 2026-11-10 — Open questions answered (user): recorded user's local time with UTC on hover (D42); one prompt per browser for 8 h covering all sessions (D38); no prompt for the list; no mini-app filter in the MVP; Hotspots opens on yesterday.
- 2026-11-10 — Auditor pass (01): U1 depends on X1; U9 may start early as filler work once its dependencies are met.
