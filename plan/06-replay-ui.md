# 06 — Replay UI
Status: draft · Size: large · Parent: [01-session-replay.md](01-session-replay.md)

## Goal

`apps/replay-ui` lets support and audit staff in one region find a user's session for a day and
replay it: the screen, the Redux state and the network calls on one timeline. Every gap in the
recording is visible, so "nothing changed" never looks like "not recorded" (D10). The UI is a
static single-page app served by `apps/server` under a strict CSP (D13, D30). It talks only to the
query API in [03-protocol.md](03-protocol.md) and drives the player only through `ReplayEngine` (D25).

The screen is a **flexlayout-react docking workspace** like the real app's (user, 2026-11-11): eight
tabs that viewers drag, split, maximise and close, saved per browser. It is built with **Mantine 9**,
its own component library (never the real app's CSS), in **light and dark** themes, with **React
Compiler** on and Vite as the build tool. Static HTML mocks of every screen live in
[`docs/design/replay-ui/`](../docs/design/replay-ui/index.html) (U0).

## Decisions

Inherits D2, D10, D13, D16, D20, D25, D28, D30, D32, D33, D34, D36, D37, D38, D39 and 03-L2, L3,
L4, L8, L9, L11, L12, L14.

| # | Decision | Why |
|---|---|---|
| L1 | Built with **Vite 8** (`@vitejs/plugin-react` 6), run under Bun (`bun --bun vite`). **React Compiler** runs in dev and build: `babel-plugin-react-compiler` 1.0 through `@rolldown/plugin-babel` and `reactCompilerPreset()`. `build.assetsDir: 'ui'`. Vite is used by `apps/replay-ui` only (user, 2026-11-11; replaces Bun's HTML bundler). | Bun's own React Compiler is experimental and documented for builds only, so dev would run uncompiled code and compiler bugs would show only at the gate (architect). Vite's `server.proxy` and `preview.headers` replace hand-written `dev.ts` and `build.ts`. The output still uses external script files only, which the CSP needs. |
| L2 | **Code-based TanStack Router routes.** Search params are checked with zod. Filters and the play position live in the URL. | A link or a reload shows the same list or frame. Bad ids are rejected before any request. |
| L3 | **Server data in TanStack Query, player state in Zustand.** The `ReplayEngine` instance lives in a plain `PlayerController`, outside React state. | The engine is an imperative object. Keeping it out of state avoids re-renders, and its lifetime is explicit (create, destroy). |
| L4 | **Snapshot windows inside one recording; one Replayer per span** (architect A6). A window runs from a FullSnapshot event's own position (03 `SessionDetail.snapshots`, with `idx`) up to the next anchor in the same recording, or to that recording's end. It **never crosses recordings**. One engine holds a **span**: the current window plus the next, which is added with `engine.append()`. At most 3 windows stay loaded; the engine is rebuilt only on evict or on a seek outside the span. | rrweb rebuilds the DOM at every FullSnapshot, and the recorder snapshots every store right after it (03-L11), so each window stands alone. Appending the next window means no rebuild at an edge, so playback never flashes there. Memory stays bounded. |
| L5 | The **scrubber seeks by raw time**; **action jumps seek by stream position** (D16). Back/next step through the action list's *current filter*. | Positions are exact when many events share a millisecond. The viewer decides what an "action" is. |
| L6 | The play head is written to the store at most **10 times a second**. `?pos=` is written to the URL **only on pause**, with `replace`. | Smooth playback without flooding React or browser history. |
| L7 | **State is rebuilt in the UI** from each window's store snapshots plus each action's top-level `changes`, step by step. A `$root` change replaces the whole value. The UI never imports rrweb; it parses only `sr:*` events (03-L1). | D25 keeps rrweb inside `recorder-engine`. Rebuilding forward is cheap; going back restarts from the span's first snapshot. |
| L8 | **One grant per browser** (D38; user, Q30, Q31): the first session open asks for a name and reason, and that grant covers every session opened in this browser for 8 h (05-L10), or until a server restart. The session list needs no prompt. Any 403 `{need:'access'}` shows the prompt. The UI remembers the viewer's name in `localStorage` for prefill; the reason is never stored. | Saves typing without weakening the "say why for each open" rule. |
| L9 | Times show in the **recorded user's local time** (`sr:meta.tz`; user, Q29, D42), with UTC on hover. Without a `tz`, the UI falls back to UTC and says so. The day filter is a **UTC day**, labelled as such. | Support works from what the user reports ("it happened at 9:05"); UTC on hover matches server logs. |
| L10 | Small, proven libraries: `@tanstack/react-virtual` (long lists), `microdiff` (Diff tab). A hand-written JSON tree (lazy, collapsed by default). Components come from Mantine (L18); icons are `@tabler/icons-react` inline-SVG components; fonts are the system stack. Exact versions are in "Workspace" below. | Large action lists and 2 MB stores must not freeze the page. Inline SVG and system fonts need nothing that D30 blocks. |
| L11 | Until the server's query API lands (B3), the UI runs on a **mock Hono API** in `apps/replay-ui/mock/`, built from the 03 fixtures (including the framed `chunks-v1.bin`) and checked against the 03 zod schemas. | Lets B2 start in parallel with the server, against the same shapes. |
| L12 | **Every `t` is raw client time** (03-L12): the API's times, the engine's ticks, bands and notes. The UI shows `t + recording.clockOffsetMs` and seeks by raw `t`. | A per-chunk skew correction jitters and isn't monotonic; mixing corrected and raw times would put markers minutes off (devil X2). |
| L13 | **Chunks arrive framed and gzipped** (03 "Chunk response framing"). `readChunks` from `@sr/protocol` splits the response and inflates each blob in the browser with `DecompressionStream`. A chunk whose integrity isn't `ok` is never played: it counts as missing. | The server never inflates, so reads stay cheap (03-L8). One shared parser for the server's tests and the UI. A chunk that failed its check can't be trusted to show the screen (devil X1). |
| L14 | **The action list merges two sources** (architect A11). The API returns only the sparse kinds (03 `ActionKind`: clicks, inputs, navigation, errors, failed requests, fidelity, reports, hotspots, console `error` and `warn`) for the whole session. State rows, every request row and console `info`, `log` and `debug` rows come from the loaded span's own events (03-L15). | The server stores far fewer rows: state actions at 5/s and 2 fetches/s for 8 hours would be about 200,000 rows per session. The UI already holds those events in memory. |
| L15 | **Every `/api/*` call sends `X-SR-UI: 1`** (03-L14), and **empty query params are left out** (no `user: ''`, no `to: ''`). | Without the header the server refuses the call and logs it as denied. `user=` would mean "the empty user", not "any user" (devil X25). |
| L16 | **One flexlayout-react 0.11 workspace** serves `/` and `/replay/$sessionId`, with eight tabs: Sessions, Player, Actions, Console, Network, State, Diff, Info ("Workspace and panels" below). Viewers drag, split, maximise and close tabs. **Player and Sessions can't be closed. No popouts and no floating windows.** The layout is saved per browser (`sr.layout`, versioned), with "Reset layout" and Undo. One session is open at a time (user, 2026-11-11). | Support staff know this docking model from the real app. Popouts would need a second window for the sandboxed player under the CSP. Two sessions side by side are two browser tabs, which keeps one engine and bounded memory (L4). |
| L17 | **Light and dark themes.** Mantine `defaultColorScheme="auto"` plus a System / Light / Dark menu, saved per browser (`sr.theme`). An **external** blocking `/theme-boot.js` sets `data-mantine-color-scheme` before the first paint. The recorded screen is never recoloured (user, 2026-11-11). | Follows the OS by default. Mantine's `ColorSchemeScript` is an inline script, which D30 blocks. One attribute drives Mantine, the `--sr-*` tokens and flexlayout's chrome, so nothing can drift apart. |
| L18 | **Mantine 9** (`core`, `hooks`, `dates`, `notifications`), its own component library, separate from the real app's custom CSS. Compact theme: 24 px toolbar controls through one `density.css`, plus the AA overrides in "Visual system". `@mantine/dates` days are plain `'YYYY-MM-DD'` strings. Notifications at `bottom-center`, at most 3, 4 s. No Spotlight. **Never a style nonce** (user chose Mantine over shadcn/ui, 2026-11-11). | All needed components in one versioned package family, so coder agents assemble screens instead of owning about 20 copied component files (architect). String days match L9's UTC `?day=` with no time-zone code. A nonce would turn off `'unsafe-inline'`, which rrweb and Floating UI's `style` attributes need. |
| L19 | **Lists, the axis and banners show the recorded user's wall-clock time** (D42). The transport shows wall-clock time plus elapsed time ("09:24:58 EST · +22:44 / 1:12:37"). | Replaces the old wireframe's elapsed `00:41` times: support works from the time the user reports. |
| L20 | **Player zoom:** Fit / 50 / 75 / 100 %, with the stage scrolling above Fit. Each session opens at Fit (user, 2026-11-11). | In the default layout a 2560-px recorded screen shows at about 40 %, where grid text is unreadable (designer). |
| L21 | **Go to time (`G`):** a popover that takes `hh:mm[:ss]` in the user's zone, or `+m:ss` from the start. Errors: "08:50 is before this session starts (09:02:14)." / "Use hh:mm, hh:mm:ss, or +m:ss from the start." (user, 2026-11-11). | A ticket names a time; typing it beats dragging the scrubber. |
| L22 | **The Player stage lives outside flexlayout**, in one host element that never moves. The Player tab holds only a measured slot; the host is positioned over it. The host holds only the engine's layers, marked `inert`; the overlays (banners, Screen unknown, the seek card, Buffering) render in the slot. The binder attaches the host before opening a session, and the host ignores pointer events during a tab drag (architect; devil, 2026-11-11). | flexlayout 0.11 keeps each tab's React state, but moves the tab's DOM element with `appendChild` when a tab moves or maximises. Moving an `<iframe>` reloads it, which wipes the page rrweb rebuilt. A host that never moves can't lose the frame. |
| L23 | **Each panel is a module at a fixed path:** `src/features/<id>/index.ts` exports `Panel` and, optionally, `TabExtra`. U1 creates the placeholders and the registry imports them. | Parallel tasks never edit a shared registry file. |
| L24 | **Actions, Console and Network share one row model**, computed once per (session, API rows, `spanRev`). The span's chunks live in a plain module (`player/span.ts`), not in the Query cache. | Three panels don't rebuild a 10,000-row list three times. Nothing observes window queries, so a window still in the span could be dropped after `gcTime`. Event arrays stay out of React state and Zustand. |
| L25 | **Everything stays in `apps/replay-ui`**; no `packages/ui`. | The app is the only consumer, and the user ruled out sharing with the real app. |

## Design

### Routes

| Route | Search params | Screen |
|---|---|---|
| `/` | `user`, `day` (yyyymmdd, UTC), `errors` | The workspace (L16). Player and the other panels show "Pick a session". |
| `/replay/$sessionId` | `pos` (`<recordingId>:<seq>:<idx>`), or `t` (`mm:ss` or `h:mm:ss` from session start); keeps `user`, `day`, `errors` | The same workspace with the session open |
| `/hotspots` | `day`, `app` | Daily degraded-screens report (D32); no workspace, no session bar |

### Workspace and panels (L16; designer, 2026-11-11)

| Tab id | Name (tooltip) | Content | Close | Notes |
|---|---|---|---|---|
| `sessions` | Sessions ("Find sessions by user and day") | Filters + session list | **No** | Starts in the **left border** (collapsible drawer). It can be dragged into the main area. |
| `player` | Player ("The recorded screen") | Banners, stage, scrubber, transport, rate-cap line | **No** | Its tab icon shows play/pause, so the state shows even when another tab covers it. It can't be dropped into a border (`onAllowDrop`). |
| `actions` | Actions ("Clicks, inputs, navigation, errors, requests and state changes, in order") | The merged timeline list (L14, D43). Kind chips. Drives `J`/`L` (L5). | yes | |
| `console` | Console ("Lines the app logged") | Console rows only: level chips, full message, stack expand | yes | Tab badge = number of error rows |
| `network` | Network ("Requests the app made") | Table: time, method, status, URL, duration | yes | Tab badge = number of failed requests |
| `state` | State ("Redux state at the play head") | Store picker, filter, JSON tree | yes | |
| `diff` | Diff ("What the last Redux action changed") | The old Action and Diff sub-tabs, merged: [Changes \| Payload] | yes | |
| `info` | Info ("Session details, recordings, gaps and legend") | Session facts, integrity, recordings table, known gaps, rate caps, full legend | yes | |

Grid data shows only on the recorded screen in v1; a future **Grids** tab waits for the I6 spike
(01 Q43; Open questions, item 14).

Console and Network are **extra views** over the same row model as Actions (L24); console and
request rows still appear in Actions too (D43, L14). Each panel keeps its own filter
(a filter store in its own folder). There is one **global** follow flag (`F`). Scrolling a list by hand turns follow
off, and the list shows a floating "Follow play head (F)" button.

**Default layout** (designed at 1920×1080; checked at 1440×900 and 2560×1440):

```
┌ header 40 ───────────────────────────────────────────────────────────────────────────┐
├ session bar 28 ──────────────────────────────────────────────────────────────────────┤
├──┬─────────────┬───────────────────────────────────────┬──────────────────────────────┤
│S │ Sessions    │ Player                  (w 64 / 70)   │ Actions          (w 36 / 58) │
│e │ border,     │                                       │                              │
│s │ 320 px,     │                                       ├──────────────────────────────┤
│s │ open        ├───────────────────────────────────────┤ State · Diff · Info  (42)    │
│28│             │ Console · Network            (30)     │                              │
└──┴─────────────┴───────────────────────────────────────┴──────────────────────────────┘
```

```json
{
  "global": {
    "tabEnableClose": true, "tabEnableRename": false, "tabEnablePopout": false, "tabEnableFloat": false,
    "tabSetEnableMaximize": true, "tabSetEnableDeleteWhenEmpty": true,
    "tabSetMinWidth": 240, "tabSetMinHeight": 120,
    "splitterSize": 4, "splitterExtra": 4, "enableEdgeDock": true, "borderMinSize": 240
  },
  "borders": [{ "type": "border", "location": "left", "size": 320, "selected": 0,
    "children": [{ "type": "tab", "id": "sessions", "name": "Sessions", "component": "sessions", "enableClose": false }] }],
  "layout": { "type": "row", "children": [
    { "type": "row", "weight": 64, "children": [
      { "type": "tabset", "id": "ts-player", "weight": 70, "children": [
        { "type": "tab", "id": "player", "name": "Player", "component": "player", "enableClose": false,
          "enableRenderOnDemand": false }] },
      { "type": "tabset", "id": "ts-logs", "weight": 30, "children": [
        { "type": "tab", "id": "console", "name": "Console", "component": "console" },
        { "type": "tab", "id": "network", "name": "Network", "component": "network" }] }] },
    { "type": "row", "weight": 36, "children": [
      { "type": "tabset", "id": "ts-actions", "weight": 58, "children": [
        { "type": "tab", "id": "actions", "name": "Actions", "component": "actions" }] },
      { "type": "tabset", "id": "ts-state", "weight": 42, "children": [
        { "type": "tab", "id": "state", "name": "State", "component": "state" },
        { "type": "tab", "id": "diff", "name": "Diff", "component": "diff" },
        { "type": "tab", "id": "info", "name": "Info", "component": "info" }] }] }] }
}
```
U3a checks every attribute name against flexlayout-react 0.11 before relying on it.

**Behaviour**
- **Panel registry** (`PANELS`): `{ id, name, component, home, closable }`. Homes: console and
  network → `ts-logs`; actions → `ts-actions`; state, diff and info → `ts-state`.
- **Saved layout:** `localStorage['sr.layout']` = `{ v: 1, json }`, written on `onModelChange`. If the
  key is missing, won't parse, has another `v`, lacks `player` or `sessions`, or names an unknown
  component: load the default. If a layout was stored before, also toast "Layout restored to the
  default: this version changed the panels." Two browser tabs: each reads once at load; the last
  save wins. No live sync.
- **A closed tab comes back** from Layout menu → Panels: into its home tabset if that still exists;
  else the active tabset, unless it holds the Player; else a new tabset on the root's right edge
  (`DockLocation.RIGHT`). The restored tab is selected.
- **Reset layout** applies the default at once and toasts "Layout reset." with [Undo] for 10 s. No
  confirm dialog.
- **Maximise:** the ⤢ button in a tabset toolbar, a double-click on the tab strip, or `M` for the
  Player. Restore with ⤡ (accent colour while maximised).
- **Hidden tabs do no per-tick work.** Visited tabs stay mounted (flexlayout's default). Each panel
  pauses its play-head subscription while hidden (`PanelFrame`, below).

### App shell

```
┌ [▶▮] Session Replay  [NAM]   Replay  Hotspots ─────────────── [◐] [▦ Layout ▾] [⌨] ┐  40, --sr-chrome
│ u123 · blotter 4.2.1 · Mon 10 Nov 2026 · 09:02:14–10:14:51 EST · 1h 12m · 3 recordings │  28, session bar
│                      ⓘ Identity: client-asserted   ✓ Unchanged since received   [Info] │
```
The **session bar** sits outside the layout, so no arrangement (not even a maximised Player) can
hide the identity and integrity notes. It is one line on wide screens; the left part truncates
first and the notes never truncate.

| Element | Mantine | Copy / behaviour |
|---|---|---|
| Shell | `AppShell header={{height:40}}`. `AppShell.Main` is a flex column: SessionBar, then the workspace. | — |
| Mark + title | 18 px inline SVG + `Text fw={600} size="md"` | "Session Replay" |
| Region | `Badge variant="default" size="sm"` + `Tooltip` | "NAM". Tooltip: "Region: North America. Recordings stay in their region." |
| Nav | `Button variant="subtle" size="xs"` via `createLink`. Active: text colour + 2 px accent underline. | "Replay", "Hotspots". "Replay" returns to the last replay URL (session + `pos`), else `/` with the kept filters. |
| Theme | `ActionIcon variant="subtle"` (IconSunMoon) + `Menu` | "System (dark now)" or "(light now)", "Light", "Dark", with a check on the current one (L17). |
| Layout | `Button variant="subtle" size="xs"` + `Menu`. Hidden on Hotspots. | See "Keyboard shortcuts and menus". |
| Shortcuts | `ActionIcon` (IconKeyboard), tooltip "Keyboard shortcuts (?)" | Opens the sheet. |
| No session | `Text c="dimmed"` | "No session open. Pick one in Sessions." |
| Zone | Tooltip on "EST" | "The user's time zone: America/New_York (UTC−5). Hover any time to see UTC." With no `tz`: "Times in UTC: this recording has no time zone." |
| Identity note (D20) | `Badge variant="default"` + IconInfoCircle + multiline `Tooltip` | "Identity: client-asserted". Tooltip: "The browser sent this user id and nothing checked it. The replay shows what the browser sent, not who sent it." |
| Integrity note (D28) | `IntegrityNote` from `features/player` (reads the store's `integrity`), IconCheck in `--sr-success-icon` | Before any chunk is read: "Integrity: checked as each part loads" (dimmed). All read chunks OK: "Unchanged since received". Tooltip: "All 38 chunks read so far matched their sha256. That shows nothing changed after the server received them. It doesn't show who sent them." **Never "verified".** |
| Integrity failed | IconCircleX + `--sr-danger-text` | "1 chunk failed its check". Tooltip: "Recording 1, chunk 41 didn't match its sha256 when read. It isn't played. The timeline marks it Unreadable." |
| Live | `Badge variant="light"` + dot | "Live · recorded up to 13:45" |
| [Info] | `Button variant="subtle" size="xs"` | Selects the Info tab and brings it to the front. |

**Opening a session**

| Step | What the viewer sees |
|---|---|
| 1. Filter | Sessions: type the user id and pick the UTC day. The old list stays dimmed while the new one loads. |
| 2. Pick | Click a row, or ↑/↓ then Enter. The URL becomes `/replay/$id`. The session bar fills from the list's cached summary; the Player shows "Waiting for access…" (dimmed). |
| 3. Access | The modal opens over the whole app. With a valid grant it's skipped (L8). |
| 4. Load | Detail, then the first window. Under 300 ms nothing extra shows; after that, the progress card. Then the first frame, paused. |
| Cancel | Back to `/` with the filters kept. Focus returns to the row. |
| Switch | Another row switches at once: the controller is destroyed; no prompt within the grant. Browser back returns to the previous session. |

### No session picked: `/`

```
┌ [▶▮] Session Replay [NAM]  Replay  Hotspots ─────────────── [◐] [Layout ▾] [⌨] ┐
│ No session open. Pick one in Sessions.                                          │
├──┬──────────────────────┬──────────────────────────────────┬────────────────────┤
│S │ Sessions             │ Player                       ⤢   │ Actions         ⤢  │
│e ├──────────────────────┼──────────────────────────────────┼────────────────────┤
│s │ User id              │                                  │ Open a session to  │
│s │ [u123             ×] │                ▷                 │ see its clicks,    │
│i │ Day (UTC)            │         Pick a session           │ inputs, requests   │
│o │ [‹][2026-11-10   ][›]│  Search by user id and day in    │ and errors.        │
│n │ [ ] Errors only      │  Sessions, then open one.        ├────────────────────┤
│s │ 4 sessions           │        [Show Sessions]*          │ State Diff Info ⤢  │
│  ├──────────────────────┤                                  ├────────────────────┤
│  │ 07:48–08:02 EST  14m ├──────────────────────────────────┤ Open a session to  │
│  │ u123 · risk-viewer   │ Console  Network             ⤢   │ see its Redux      │
│  │ 09:02–10:14 EST 1h12m├──────────────────────────────────┤ state.             │
│  │ u123 · blotter       │ Open a session to see its        │                    │
│  │        ⚠3 ✖2 ⚑1 ▥6  │ console lines.                   │                    │
│  │ 13:05–now     1h03m  │                                  │                    │
│  │ u123 · blotter ⚠1 ● Live                                │                    │
└──┴──────────────────────┴──────────────────────────────────┴────────────────────┘
```
\* [Show Sessions] appears only when the Sessions border is collapsed or the tab is behind another.

**Sessions panel**
- Controls: `TextInput size="xs"` with a clear button; `DatePickerInput size="xs"` (string
  `YYYY-MM-DD`, `maxDate` = today UTC) between prev/next `ActionIcon`s; `Checkbox size="xs"` "Errors
  only"; a dimmed count.
- Rows are 40 px with two lines, **earliest first**: time range in the user's own zone + duration;
  then `user · app version` + badges.
- Badges are Tabler icons + counts, hidden at 0: ⚠ "3 errors (uncaught + console.error)"
  (`errors + consoleErrors`), ✖ "2 failed requests", ⚑ "1 user report", ▥ "6 recording gaps",
  ● "Live: still recording".
- Row states: hover `--sr-hover`; open session `--sr-accent-tint` + 2 px accent left edge; focus
  ring. Keys ↑/↓ and Enter. "Show more" (`Button variant="subtle"`) when there's a `next` page.

### Replay screen: playing, gap banner, bands, follow, State

```
┌ [▶▮] Session Replay [NAM]  Replay  Hotspots ────────────────────────── [◐] [Layout ▾] [⌨] ┐
│ u123 · blotter 4.2.1 · Mon 10 Nov 2026 · 09:02:14–10:14:51 EST · 1h 12m · 3 recordings     │
│                       ⓘ Identity: client-asserted   ✓ Unchanged since received   [Info]    │
├──┬─────────────────────────────────────────────────────┬───────────────────────────────────┤
│S │ ▶ Player                                         ⤢  │ Actions                         ⤢ │
│  ├─────────────────────────────────────────────────────┼───────────────────────────────────┤
│  │┌───────────────────────────────────────────────────┐│ [⌕ Search actions   /] [Following]│
│  ││▧ Recording paused: app busy    [Skip to 09:25:52] ││ (✓Clicks)(✓Inputs)(✓Navigation)   │
│  ││  Paused 09:24:10–09:25:52 to keep the app fast.   ││ (✓Errors)(✓Requests: failed ▾)    │
│  ││  The screen may have changed in that time.        ││ (State)(✓Console: error, warn ▾)  │
│  │├───────────────────────────────────────────────────┤│ (✓Gaps)(✓Reports)(✓Hotspots) Clear│
│  ││     recorded blotter screen (Fit 41 %)            ││ 09:23:51 ⌨ input   Limit = 228.40 │
│  │└───────────────────────────────────────────────────┘│ 09:23:55 ⌖ click   Submit · .orde…│
│  │ Events  ◆    ▲      ▲✖⚑      ◆          ◆      ✖▲   │ 09:24:03 → nav     /positions     │
│  │ Screen  ▕▕▕░░▓▓▓▓▓[///]░XX░│░[\\\]░░◆┆ no page ┆░▔▔░ │ 09:24:08 ⚠ console AMPS: slow… ×4 │
│  │ State   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │▶09:24:10 ▧ gap     Paused (app bu…│
│  │         09:10    09:20 ┃  09:30    09:40   09:50 10:10│ 09:25:52 ▧ gap     Recording res… │
│  │ [⏮][▶][⏭] [⚠ Next error]  0.5× [1×] 1.5× 2× 4× 5×   │ 09:26:07 ✖ request POST 500 /api/… │
│  │ 09:24:58 EST  +22:44 / 1:12:37  [🕒] [Fit 41% ▾] [🔗] [Legend]│                           │
│  │ Rate caps v2026-11-10.3: positions grid bid, ask, mid at 2/s · pricing… │                  │
│  ├─────────────────────────────────────────────────────┼───────────────────────────────────┤
│  │ Console (2)  Network (2)                         ⤢  │ State  Diff  Info               ⤢ │
│  ├─────────────────────────────────────────────────────┼───────────────────────────────────┤
│  │ (✓✖ Error 2)(✓⚠ Warn 2)(Info)(Log)(Debug) [⌕ Filter]│ Store [orders/redux#1 ▾][⌕ Filter]│
│  │ 09:24:08 ⚠ AMPS: slow consumer on positions_v2… ×4 │ At 09:24:58 EST · after orders/pl…│
│  │ 09:26:07 ✖ Amend failed: 500 Internal Server E… ›  │ ▾ orders                 {2 keys} │
│  │ 09:45:10 ⚠ Each child in a list should have a … ×8 │   ▾ o-1783 •             {7 keys} │
│  │ 10:09:40 ✖ Cancel failed: network error (orde… ›   │       status • "pending"          │
│  │                                                     │   lastOrderId • "o-1783"          │
│  │                                                     │   blotterCache [not recorded · over 256 KB: 1.4 MB] │
│  │                                                     │   marketData [not recorded · deny-listed for volume]│
│  │                                                     │ ⓘ React useState values aren't captured. The screen shows them.│
└──┴─────────────────────────────────────────────────────┴───────────────────────────────────┘
```

**Player, top to bottom:** banner overlay (top of the stage; doesn't push the layout) → stage
(`--sr-stage` letterbox, scaled frame) → scrubber (60 px) → transport (32 px) → rate-cap line (18 px).
The stage renders in the fixed host (L22); its overlays render in the Player's slot, above it.

**Scrubber** (a labelled three-lane instrument; `forced-color-adjust: none`, so its patterns
survive Windows high-contrast mode)

| Part | Size | Content |
|---|---|---|
| Left gutter | 52 px | Lane labels "Events", "Screen", "State" (11 px, dimmed) |
| Events lane | 12 px | 8 px markers with 24 px hit targets: ▲ error, ✖ failed request (`--sr-danger`), ⚑ report (`--sr-accent-text`), ◆ note (`--sr-warning-icon`, with a 1 px tick down to the Screen lane). Markers whose hit targets would overlap merge; the tooltip lists them. |
| Screen lane | 18 px | Unplayed `--sr-track`, played `--sr-track-played`. Gap and unknown bands fill the lane with their pattern and 1 px ink edges; a band at least 72 px wide shows its short label on a chip. A recording boundary is a 1 px line. The time between recordings is drawn to scale: `--sr-ground` fill, dashed outline, "No page open · 11m" if at least 96 px wide. `snapshot-slow` is a 4 px dashed strip along the bottom. Minimum band width 3 px. |
| Loaded strip | 2 px | The loaded windows, in `--sr-loaded` |
| State lane | 6 px | `no-state` dashes; otherwise empty |
| Axis | 14 px | Local times (L19), at least 64 px apart (11 px, dimmed, tabular) |
| Play head | — | 2 px `--sr-accent-text` line across the lanes; a 12 px round thumb on the Screen lane |
| Hover | — | 1 px line + `Tooltip.Floating`: "09:24:58 EST · 14:24:58 UTC" / "+22:44" / "▧ Paused (app busy) 09:24:10–09:25:52 (1m 42s)" |
| Keyboard | — | `role="slider"`, `aria-valuetext="09:24:58 EST, 22 min 44 s of 1 h 12 min"`. ←/→ 5 s, PageUp/PageDown 1 min, Home/End. |

**Transport**
- Left: `ActionIcon`s ⏮ "Previous action (J)", ▶/⏸ "Play (Space)", ⏭ "Next action (L)", then
  `Button variant="light" color="red" size="xs"` "Next error (E)".
- Speed: `SegmentedControl size="xs"`: 0.5× 1× 1.5× 2× 4× 5×.
- Clock: "09:24:58 EST" (13 px/600, tabular); tooltip "09:24:58.212 EST · 14:24:58.212 UTC"; then
  "+22:44 / 1:12:37" (dimmed).
- Right: 🕒 Go to time (`Popover`, L21); Zoom `Menu` "Fit (41%)", "50%", "75%", "100%" (L20);
  🔗 `CopyButton` "Copy link (C)" → toast "Link copied. It opens at 09:24:58."; Legend `Popover`
  ("In this session", "Other kinds" collapsed, footer link "All details in Info").
- Rate-cap line (D36; dimmed, truncates, full text in the tooltip): "Rate caps v2026-11-10.3:
  positions grid bid, ask, mid at 2/s · pricing ladder last at 4/s". With no caps: "No rate caps:
  every change recorded." A mid-session change shows one line per version, with times.
- At the end: ▶ becomes ↺ "Replay from start", and an "End of session" pill shows.

**Bands and notes (D10, D34): every 03 `FidelityReason`.** Colour is never the only cue: each has a
pattern and a label ("Visual system" has the patterns).

| Reason | Kind | Short / long label | Banner (gap bands only) |
|---|---|---|---|
| `pause-budget` | gap | Paused / Paused (app busy) | **Recording paused: app busy.** "Paused 09:24:10–09:25:52 to keep the app fast. The screen may have changed in that time." [Skip to 09:25:52] |
| `hidden-tab` | gap | Tab hidden | **Tab in the background.** "The tab stayed hidden too long, so recording stopped 09:12:00–09:14:30. The app wasn't visible then." [Skip to 09:14:30] |
| `popout` | gap | Popout / Popout open | **Popout window open.** "A popout was open 09:40:05–09:43:20. Popouts aren't recorded, so what it showed is missing. This window is still recorded." |
| `quota` | gap | Quota / Daily quota reached | **Daily recording limit reached.** "This user hit the daily limit at 10:05:00. Nothing more was recorded until 00:00 UTC." |
| `buffer-overflow` | gap | Queue full / Upload queue full | **Upload queue full.** "The browser couldn't upload for too long, so the oldest parts were dropped: 09:30:00–09:31:10 is missing." [Skip to 09:31:10] |
| `missing-batches` | unknown | Missing / Data missing | "Screen unknown" overlay (below) |
| `chunk-unreadable` | unknown | Unreadable | "Screen unknown" overlay (below) |
| `snapshot-slow` | thin | Slow checkpoints | No banner. Tooltip: "Checkpoints were spaced out to keep the app fast. The screen is complete; seeking here is slower." |
| `no-state` | thin (State lane) | No state: pricing | No banner. Tooltip and State panel: "No state for pricing: it wasn't built with the plugin, or it uses Redux Toolkit. Its screens are still recorded." |
| `pipeline-fallback` | note | Upload fallback | "The upload worker failed at 09:40:12 and the page took over uploads." |
| `state-capped` | note | State key capped | "blotterCache was over 256 KB (1.4 MB) and isn't recorded from 09:05:12." |
| `no-clean-close` | note | No clean close | "Recording ended without a clean close: the last seconds may be missing." (devil X19) |
| `caps-off` | note | Rate caps off | "Rate caps were configured but not active in this recording, so every change was recorded." |
| `console-capped` | note | Console cap reached | "This recording hit its console line limit at 10:52:00. Later lines aren't recorded." |
| any unknown reason (03-L16) | note | the raw reason / "Recorded by a newer recorder: `<reason>`." | — |
| newer rrweb (03-L18; not a reason) | note at 0:00 | Newer recorder / "Recorded with rrweb 2.3.0; this replayer has 2.2.2. Some changes may not show. Ask for this region's server to be updated." | — |

- **Banner:** `Alert variant="light"`; yellow for pause, quota and overflow, violet for popout, gray
  for hidden-tab; the icon is a 16×16 swatch of the band's pattern. At most 2 banners, then "+1
  more", which opens the Legend. Order: quota, buffer-overflow, pause-budget, popout, hidden-tab.
- **Canvas (D34)** is drawn inside the replay by the engine's placeholder style. The Legend and
  Info's "Known gaps" list canvas, popouts, `useState` values (D39) and WebSocket messages (D41).
- **Between recordings** (a reload or a closed tab) the scrubber shows the "No page open" gap.
  Playback **never plays the gap in real time**: at a recording's end the player jumps to the next
  recording's first frame with the toast "Skipped 11m with no page open (09:51:30–10:02:44)." A
  click inside the gap lands on the next recording's start (devil X25).

**Action rows** are 24 px (WCAG 2.2 target size): time (58 px, tabular) · ▶ current-row gutter (10 px) · kind icon + label
(72 px: click, input, nav, request, state, console, error, gap, report, hotspot) · name (500) + " · "
+ summary (dimmed), one line with ellipsis, full text in the tooltip · ×count (`Badge size="xs"`).
The current row gets `--sr-accent-tint` + ▶; failed requests and errors use `--sr-danger-text` with
an icon. **Default filter:** everything on except **State** and "Requests: all" (Requests = failed
only); Console = error and warn. State rows at 5/s would drown the list (leader, 2026-11-11).

### Screen unknown and long seeks

```
┌──────────────────────────────────────────────┐  ┌──────────────────────────────────────────────┐
│╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳│  │ (old frame, dimmed to 35 %)                  │
│╳╳╳ ┌────────────────────────────────────┐ ╳╳╳│  │      ┌──────────────────────────────────┐    │
│╳╳╳ │ ⚠ Screen unknown                   │ ╳╳╳│  │      │ Loading 09:38–09:51              │    │
│╳╳╳ │ Batches 41–43 never arrived. The   │ ╳╳╳│  │      │ ▓▓▓▓▓▓▓▓▓░░░░░░░░░░  18 of 42 MB │    │
│╳╳╳ │ screen shows again from the next   │ ╳╳╳│  │      │ A busy screen can take a few     │    │
│╳╳╳ │ full snapshot at 09:33:40.         │ ╳╳╳│  │      │ seconds.                         │    │
│╳╳╳ │                [Skip to 09:33:40]  │ ╳╳╳│  │      └──────────────────────────────────┘    │
│╳╳╳ └────────────────────────────────────┘ ╳╳╳│  │                                              │
└──────────────────────────────────────────────┘  └──────────────────────────────────────────────┘
```
- **Screen unknown** (devil X1) covers the frame with an opaque fill in the band's own pattern, so no
  frame inside the band looks complete (01 Acceptance). On it, a `Paper withBorder shadow="md"`
  card: IconAlertTriangle, `Title order={5}`, body, and a filled `Button` "Skip to 09:33:40", which
  seeks to the next full snapshot. For `chunk-unreadable` the body reads: "Part of this recording
  can't be read: its check failed, or its key was erased. The screen shows again from the next full
  snapshot at 09:33:40." Playback keeps running underneath; the overlay lifts at the snapshot.
- **Long seeks** (architect A5): a `Paper` card over the stage, dimmed with `--sr-scrim`. Details
  under "Long seeks" below.

| Phase | Copy | Control |
|---|---|---|
| Download, size known | "Loading 09:38–09:51" · "18 of 42 MB" | `Progress value size="sm"` |
| Download, size unknown or prefetch | "Loading 09:38–09:51" · "18 MB so far" | `Progress value={100} striped animated` (static under reduced motion) |
| Building | "Building the screen…" | same, painted one frame before the seek |
| Footer, always | "A busy screen can take a few seconds." | dimmed |
| Buffering | "Buffering…" pill at the stage's top right | `Badge variant="default"` + `Loader size={10}` |

### Access prompt (D38, L8)

```
┌ Open session ─────────────────────────────────────── × ┐
│ u123 · blotter 4.2.1                                    │
│ Mon 10 Nov 2026 · 09:02–10:14 EST · 1h 12m              │
│ Your name                                               │
│ [Priya S.                                             ] │
│ Saved on this browser.                                  │
│ Reason                                                  │
│ [INC-48213 order rejected at 09:26                    ] │
│ 3–200 characters. Not saved.                            │
│ ⓘ Your name, reason and IP address are logged with each │
│   session you open. Access lasts 8 hours in this        │
│   browser.                                              │
│                                  [Cancel] [Open session] │
└─────────────────────────────────────────────────────────┘
```
- `Modal centered size={440} closeOnClickOutside={false}`; Esc and × act as Cancel. `TextInput
  size="sm"` for both fields (reason placeholder: "Ticket number and what you're checking").
  `Button variant="default"` "Cancel"; `Button` "Open session" (loading: "Opening…"). Focus goes to
  Reason if the name is prefilled, else Name. Enter submits. Lengths follow 03's `AccessReq`.
- It shows before anything under `/api/sessions/:id/*` loads, including on a deep link. Cancel goes
  back to the list.

| State | Copy |
|---|---|
| Name error | "Enter your name (2–80 characters)." |
| Reason error | "Enter a reason (3–200 characters)." |
| Server error | Inline `Alert color="red"`: "Couldn't save your access (HTTP 500). Try again." |
| Deep link (no summary yet) | "Session 01JCB7Q3V7MX4T2R" / "Details show after you give a reason." |
| Expired mid-replay | Title "Access expired". "Your 8-hour access in this browser has ended. Give a reason to keep watching from 09:24:58." Buttons "Back to sessions" / "Continue". The replay resumes at the same position, and plays again if it was playing. |

### Hotspots page (D32)

```
┌ [▶▮] Session Replay [NAM]  Replay  Hotspots ────────────────────────────────────── [◐] [⌨] ┐
│ Hotspots                                                                                   │
│ Screens where recording paused to keep the app fast. Each row is a fix for the app team.   │
│ Day (UTC) [‹][2026-11-09][›]  App [All apps ▾]                  4 areas · 47m 47s paused    │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ App ▴▾      Remote     Area (CSS path)                      Peak changes/s  Paused ▼   Pauses  Users  Example │
│ blotter     positions  .positions [data-sr-grid=positions] .ag-…  14,200  38m 12s ████   41     7  Open at 10:47 EST → │
│ blotter     orders     .orders-blotter [data-sr-grid=orders] .a…   6,900   4m 03s █       9     2  Open at 14:12 EST → │
│ blotter     pricing    .pricing-ladder [data-sr-grid=ladder]       5,300   2m 40s ▌       6     3  Open at 09:31 EST → │
│ risk-viewer —          .risk-heatmap .cell-grid                    3,100   2m 52s ▌       2     1  Open at 15:05 CST → │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```
- `Title order={3}` + dimmed intro; `DatePickerInput` + prev/next; `Select` "All apps"; `Table
  stickyHeader highlightOnHover` with sortable headers (`UnstyledButton` + sort icon). Default sort:
  Paused, descending. The default day is **yesterday**; "next day" is disabled on today, and today
  shows `Badge color="yellow"` "Partial day" ("Today isn't over (UTC). Numbers will grow.").
- Header tooltips: Area "CSS path of the busiest element"; Peak changes/s "Most DOM changes per
  second while paused"; Paused "Total time recording was paused here"; Example "The longest pause.
  Opens after the access prompt."
- Area cell: monospace, truncated in the middle, copy icon on hover. Paused cell: the number, then
  an in-cell bar (96 px max, 6 px tall, `--sr-loaded`). One series, so no legend.

### Empty, loading and error states

| Panel | No session | Empty | Loading | Error | Other states |
|---|---|---|---|---|---|
| Sessions | — | "No sessions on 2026-11-10 (UTC)." With a user: "No sessions for u123 on 2026-11-10 (UTC). The user id must match exactly." Errors only: "No sessions with errors that day." [Show all sessions] | 6 `Skeleton` rows. On a filter change the old list dims to 50 % with a 2 px striped bar on top (`keepPreviousData`). | "Couldn't load sessions (HTTP 500)." [Retry] | Bad user id: inline field error quoting 03's `UserId` rule; no request is sent. |
| Player | "Pick a session" / "Search by user id and day in Sessions, then open one." [Show Sessions] | "No screen recorded yet" / "Recording may still be starting, or it wasn't turned on for this user." | Long seek card. "Waiting for access…" behind the prompt. | 404: "Session not found in NAM" / "Recordings stay in the region where they were made (D37). Check the link, or open the replay UI for the user's region." [Back to sessions]. Window: "Couldn't load 09:38–09:51 (HTTP 503)." [Retry]; the loaded part keeps playing. Offline: "You're offline. The loaded part (09:02–09:38) still plays." [Retry]. Engine: "The player stopped at 09:33:02" / "This part of the recording couldn't be replayed." [Seek past this point] [Copy details] | Live end: "Recorded up to 13:45." [Load newer]. Toasts: "Skipped 11m with no page open (09:51:30–10:02:44)." · "No page open at 09:55. Jumped to 10:02:44." · "That position isn't in this session. Opened at the start." Malformed `pos`: "This link's position isn't valid." [Open at the start] |
| Actions | "Open a session to see its clicks, inputs, requests and errors." | "No actions in this session." / "No actions match these filters." [Clear filters] | 12 skeleton rows; footer "Loading actions… 2,000 so far" | "Couldn't load actions (HTTP 500)." [Retry] | Strip when local kinds are on: "State rows, all requests and info/log/debug lines: 09:02–09:38 loaded." |
| Console | "Open a session to see its console lines." | "No console lines in this session." / "No lines match." [Clear] | as Actions | as Actions | Disabled level chip: "Not recorded: this region records error and warn only." Row: "+37 similar lines dropped (rate limit)." Note row: "◆ Console limit reached at 10:52:00. Later lines aren't recorded." Stack not loaded: "The stack loads with this part of the recording." [Go to 09:26:07] |
| Network | "Open a session to see its requests." | Failed: "No failed requests in this session." All: "No requests in the loaded part (09:02–09:38)." | skeleton table | inline + [Retry] | Strip: "All requests: 09:02–09:38 loaded. Failed requests: whole session." Status 0 shows "Failed". |
| State | "Open a session to see its Redux state." | "No Redux store in this session." / "Apps built without the plugin, or with Redux Toolkit, show no state. Their screens are still recorded." · "No state yet at this point." · "No keys match "fills"." | "Loading state for 09:38–09:51…" + skeleton tree | inline + [Retry] | Yellow strip: "State may be out of date: part of the recording is missing until 09:33:40." · Yellow strip: "No snapshot of this store in the loaded part yet: some keys may be missing." · Gray strip: the no-state copy. Chips: "not recorded · over 256 KB: 1.4 MB", "not recorded · deny-listed for volume" (devil X3, X11). A dot • marks keys changed by the current action ("Changed by orders/placed"). |
| Diff | "Open a session to see what each Redux action changed." | "No state change yet at this point." / "orders/noop changed nothing." | follows the window | — | Header "orders/placed · orders/redux#1 · 09:23:56.412" + [Changes \| Payload]. Rows: `+` added (teal), `−` removed (red), `~` changed (yellow tint); path; before → after (monospace). |
| Info | "Open a session to see its details." | — | skeleton | inline + [Retry] | Sections: details, integrity, recordings table, known gaps, rate caps, full legend. |
| Hotspots | — | "No paused screens on 2026-11-09 (UTC). Recording was complete for every app." | 5 skeleton rows | "Couldn't load hotspots (HTTP 500)." [Retry] | Partial day badge. |

### Keyboard shortcuts and menus

Shortcuts don't run while focus is in a text field or a dialog or menu is open. `?` opens the
sheet: `Modal size="lg" title="Keyboard shortcuts"`, two columns, keys in `Kbd`.

| Group | Keys |
|---|---|
| Playback | `Space`/`K` Play or pause · `[` `]` Slower or faster · `1`–`6` Speed 0.5×–5× · `←` `→` Back or forward 5 s |
| Move through the session | `J` `L` Previous or next action (Actions filter, L5) · `E` Next error or failed request · `Shift+E` Previous one · `G` Go to a time (L21) · `C` Copy link at this moment |
| Panels | `/` Search the list you're in (otherwise Actions) · `F` Follow the play head on or off · `M` Maximise or restore the Player |
| General | `?` This list · `Esc` Close a dialog or menu, or leave a field |

Footer: "Shortcuts don't run while you type in a field or while a dialog or menu is open. ← → move
between tabs when a tab has focus." The scrubber's slider keys (←/→, PageUp/PageDown, Home/End)
work while it has focus.

**Layout menu** (`Menu`, `menuitemcheckbox` semantics): **Panels**: "Sessions" and "Player" checked,
disabled, with IconLock ("Can't be closed"); the other six are checked when open, and clicking one
closes or reopens it. Then a divider, "Maximise player   M", "Reset layout", a divider, and the
dimmed footnote "Saved in this browser."

### Visual system (Mantine 9 defaults plus AA overrides)

Hex values are Mantine's default palette (U3a confirms them against Mantine 9's `DEFAULT_THEME`).
Contrast ratios are against the surface in the Use column; qa re-checks with axe in both themes.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--sr-ground` | gray-2 `#e9ecef` | dark-9 `#141414` | ground, splitters, gaps between panels |
| `--mantine-color-body` | `#ffffff` | dark-7 `#242424` | panel content, dialogs, menus |
| `--sr-chrome` | gray-0 `#f8f9fa` | dark-8 `#1f1f1f` | header, session bar, tab strips, toolbars, table heads |
| `--sr-hover` | gray-1 `#f1f3f5` | dark-6 `#2e2e2e` | hover |
| `--sr-pressed` | gray-2 `#e9ecef` | dark-5 `#3b3b3b` | pressed, skeleton |
| `--sr-stage` | gray-3 `#dee2e6` | dark-9 `#141414` | letterbox. **The recorded screen is never recoloured.** |
| `--sr-divider` | gray-3 `#dee2e6` | dark-5 `#3b3b3b` | dividers |
| `--mantine-color-default-border` | gray-4 `#ced4da` | dark-4 `#424242` | menus, cards, default buttons |
| `--sr-control-border` **(override)** | gray-6 `#868e96`, 3.3:1 | dark-2 `#828282`, 4.0:1 | input, select, checkbox and chip outlines (Mantine's gray-4 is 1.5:1) |
| `--mantine-color-text` **(override)** | gray-9 `#212529`, 15.4 | gray-2 `#e9ecef`, 13.1 | body text |
| `--mantine-color-dimmed` **(override)** | gray-7 `#495057`, 8.2 | dark-1 `#b8b8b8`, 7.8 | secondary text (Mantine's gray-6 is 3.3 and dark-2 is 4.0: both fail) |
| `--sr-disabled` | gray-5 `#adb5bd` | dark-3 `#696969` | disabled only |
| primary filled (`primaryShade: 8`) | blue-8 `#1971c2`, white 5.0 | blue-8, white 5.0 | filled buttons (shade 6 is 3.6: fails) |
| `--sr-accent-text` | blue-8 `#1971c2`, 5.0 | blue-4 `#4dabf7`, 6.3 | links, active tab bar, play head |
| `--sr-accent-tint` | blue-0 `#e7f5ff` | `#243341` | current and selected rows, drag fill |
| `--mantine-primary-color-light-color` **(override)** | blue-9 `#1864ab`, 5.5 on tint | blue-4, 5.2 on tint | text on tint |
| `--sr-focus` | blue-8 | blue-4 | 2 px ring, 1 px offset |
| `--mantine-color-error` / `--sr-danger-text` **(override)** | red-9 `#c92a2a`, 5.45 | red-4 `#ff8787`, 6.7 | error text, failed rows |
| `--sr-danger` | red-6 `#fa5252` (non-text) | red-6 | markers, icons |
| `--sr-danger-tint` | red-0 `#fff5f5` | `#442b2b` | error rows, alerts |
| `--sr-warning-icon` | orange-9 `#d9480f` (non-text) | orange-4 `#ffa94d` | warning icons, note ◆. **Warning text stays body colour**: no Mantine orange or yellow reaches 4.5:1 on white. |
| `--sr-warning-tint` | yellow-0 `#fff9db` | `#44391f` | warning strips, banners |
| `--sr-success-icon` | green-8 `#2f9e44` | green-4 `#69db7c` | ✓ icons |
| `--sr-success-text` | teal-9 `#087f5b`, 5.0 | teal-4 `#38d9a9`, 8.6 | diff "+", JSON strings |
| JSON numbers / booleans / null | blue-8 / violet-9 `#5f3dc4` / dimmed italic | blue-4 / violet-3 `#b197fc` / dimmed italic | state tree |
| `--sr-track` / `--sr-track-played` | gray-3 / gray-5 `#adb5bd` | dark-5 / dark-3 | scrubber |
| `--sr-loaded` | blue-6 `#228be6` (blue-3 was 2.0:1 on white) | blue-7 `#1c7ed6` | loaded strip, Hotspots bars (3:1 as a graphic) |
| `--sr-scrim` | `rgba(33,37,41,.45)` | `rgba(0,0,0,.6)` | modal and seek overlays |

**Band patterns** (ink = the stripe colour; ink against the track ≥ 3.3:1 and against its own fill
≥ 3.8:1 in both themes). Every band has a 1 px `--mantine-color-body` gap on each side, because amber
ink against `--sr-track-played` is only about 2.1:1 (devil, 2026-11-11):

| Family | Fill (light / dark) | Ink (light / dark) | Patterns |
|---|---|---|---|
| Amber: `pause-budget`, `quota`, `buffer-overflow` | yellow-1 `#fff3bf` / `#44391f` | orange-9 `#d9480f` / orange-5 `#ff922b` | pause: 45° lines (2 px on, 6 px period). quota: horizontal lines (1.5 px, 4 px). overflow: dots (1.5 px, 5 px grid). |
| Violet: `popout` | violet-1 `#e5dbff` / `#332c49` | violet-7 `#7048e8` / violet-4 `#9775fa` | 135° lines |
| Gray: `hidden-tab` | gray-1 / dark-6 | gray-7 / dark-1 | vertical lines (1.5 px, 5 px) |
| Red: `missing-batches`, `chunk-unreadable` | red-1 `#ffe3e3` / `#4a2c2c` | red-9 / red-5 `#ff6b6b` | missing: crosshatch (45° + 135°). unreadable: 3 px checker. Both with 2 px top and bottom ink edges. |
| `snapshot-slow` | — | cyan-8 `#0c8599` / cyan-4 `#3bc9db` | dashes, 6 px on / 3 px off |
| `no-state` | — | gray-7 / dark-1 | dashes, 4 px on / 3 px off |

**Type, spacing, density** (theme overrides):
- Fonts: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
  monospace `"Cascadia Mono", Consolas, ui-monospace, Menlo, monospace`.
- `fontSizes` xs 11 / sm 12 / md 13 / lg 15 / xl 18 px (line heights 14 / 16 / 18 / 20 / 24). Body is
  md; data rows, tabs and controls are sm. Weights 400 / 500 / 600. `tabular-nums` on every time and
  number.
- `spacing` xs 4 / sm 8 / md 12 / lg 16 / xl 24. `radius` xs 2 / sm 3 (`defaultRadius`) / md 6 (menus,
  dialogs, toasts). Panels are square; chips stay pills.
- Heights: toolbar controls (`xs`) **24 px** (`density.css` sets the `*-xs` size variables on
  Mantine's static class names, e.g. `.mantine-Button-root { --button-height-xs: 24px }`; Mantine's own
  `xs` heights differ by component: inputs 30, ActionIcon 18, Button `compact-xs` 22); dialog fields
  (`sm`) 30 px (Mantine's is 36, so `density.css` sets `--input-height-sm` too); **rows 24 px**; session
  rows 40 px; tab strip 28 px; header 40 px; session bar 28 px.
- **The AA bar is WCAG 2.2 AA**, including 2.5.8 target size (24 × 24 px): clickable rows are 24 px,
  scrubber markers have 24 px hit targets, and markers whose targets would overlap merge into one
  (the tooltip lists them). axe runs with the `wcag22aa` tag (devil, 2026-11-11).
- `respectReducedMotion: true`; `Tooltip openDelay={400} withArrow`; `cssVariablesResolver` sets the
  overrides per scheme; shadows only on floating layers; no gradients.

**flexlayout 0.11 mapping** (`theme/flexlayout.css`, on the workspace container; it follows
`data-mantine-color-scheme` because it references Mantine and `--sr-*` variables): import one base
theme (`light.css`), then set `--flexlayout-color-background: var(--sr-ground)`, tabset background
`var(--sr-chrome)`, divider `var(--sr-divider)`, tab content `var(--mantine-color-body)`, selected
tab text `var(--mantine-color-text)` on body, unselected `var(--mantine-color-dimmed)` on
transparent, icons dimmed, toolbar hover `var(--sr-hover)`; splitter `var(--sr-ground)`, hover
`var(--sr-control-border)`, drag `var(--sr-accent-text)`; drag outline accent on `--sr-accent-tint`;
focus `var(--sr-focus)`; font 12 px; splitter 4 px. The selected tab in the **active** tabset gets
`box-shadow: inset 0 2px 0 var(--sr-accent-text)`; in an inactive tabset, the same in
`--sr-control-border`. Tab buttons 12 px/500, `0 10px` padding, × on hover, selection or focus. Count
badges (`Badge size="xs" variant="light" color="red"`) through `onRenderTab`. The left border strip
is 28 px, `--sr-chrome`, vertical label, 2 px accent bar when open.

**Icons** (`@tabler/icons-react`; U3a confirms names in the pinned set): PlayerPlayFilled /
PlayerPauseFilled, PlayerSkipBack / PlayerSkipForward, AlertTriangle, CircleX, Flag, Click,
CursorText, ArrowRight (nav), ArrowsDownUp (request), Database (state), Terminal2 (console), Texture
(gaps), Flame (hotspot), InfoCircle, SunMoon, LayoutBoard, Keyboard, ArrowsMaximize /
ArrowsMinimize, Link, Clock, ZoomScan, Search, Lock, Check, Copy, Bug (debug).

### Mocks (U0)

Static HTML in [`docs/design/replay-ui/`](../docs/design/replay-ui/index.html). The folder is
self-contained: shared `mock.css` (tokens, Mantine-like controls, flexlayout chrome, band patterns)
and `mock.js` (theme menu saved to `localStorage['mantine-color-scheme-value']`, tab switching, a
dashed "MOCK" pill that switches variants, the inlined Tabler sprite). No CDN, fonts, images or
frameworks; every page opens straight from disk. Designed at 1920×1080 (`min-width: 1280px`). The
recorded screen is a hand-drawn stand-in for the blotter app, in its own light colours. **Mocks are
never published:** they stay on this machine.

| File | Screen, variants |
|---|---|
| `index.html` | Links to every mock, plus the theme menu |
| `00-tokens.html` | Both palettes side by side with contrast ratios; type, spacing, radius; controls at rest, hover, focus, disabled; all 14 reason swatches; markers; flexlayout states; icon sprite |
| `01-replay-empty.html` | `/`, Sessions border open |
| `02-access-prompt.html` | Access prompt: first open, deep link, validation errors, submitting, server error, expired |
| `03-replay-playing.html` | Replay playing inside the pause band, with banner, Actions following, State tab; every other tab reachable |
| `04-replay-screen-unknown.html` | A: missing-batches overlay + State "may be out of date". B: chunk-unreadable + red integrity note |
| `05-replay-loading.html` | Fetch 18 of 42 MB; "18 MB so far"; Building; Buffering pill; "Skipped 11m" toast; live end "Load newer" |
| `06-panel-states.html` | Gallery: one card per panel × state in the table above |
| `07-hotspots.html` | Populated (2026-11-09), Partial day (2026-11-10), Empty, Loading, Error |
| `08-shortcuts.html` | Shortcuts sheet over the replay |
| `09-layout-and-menus.html` | Layout menu (Network closed), Theme menu, Player maximised, a frozen drag outline with edge-dock indicators, "Layout reset. Undo" toast |

**Scenario data** (shared by the mocks; U2's mock API fixtures may reuse it): NAM, user **u123**,
America/New_York, Mon 10 Nov 2026, 09:02:14–10:14:51 EST; blotter 4.2.1 with remotes orders 3.8.0,
pricing 2.14.2, positions 1.9.0; viewport 2560×1400; stores `orders/redux#1`, `positions/redux#1`
(pricing has no store: a `no-state` band). Recordings R1 09:02:14–09:38:05 (gap seq 41–43, offset
+1.2 s), R2 09:38:11–09:51:30 (no clean close), 11 min with no page open, R3 10:02:44–10:14:51
(offset −0.4 s). Bands: hidden-tab 09:12:00–09:14:30, pause-budget 09:24:10–09:25:52 (positions
grid, 14,200/s), missing-batches 09:33:02–09:33:40, popout 09:40:05–09:43:20, snapshot-slow
10:05:00–10:08:00. The story: an order is placed at 09:23:56, an amend fails with a 500 at 09:26:07
(console error, then a `TypeError` ×2, then a user report "Order stuck in pending"), and a cancel
fails with a network error at 10:09:32.

### Workspace (architect, 2026-11-11)

```
apps/replay-ui/
  package.json  tsconfig.json  vite.config.ts  csp.ts  index.html
  public/theme-boot.js            blocking classic script, copied to the root of dist/ (L17)
  mock/                           Hono mock API (U2)
  test/  build.test.ts  imports.test.ts  render.tsx  csp.test.ts
  src/
    main.tsx  router.tsx
    routes/       root · workspace · workspace-index · replay (lazy binder) · hotspots (lazy)
    theme/        scheme.ts · theme.ts · tokens.css · density.css · flexlayout.css
    shell/        Header · SessionBar · ThemeMenu · LayoutMenu · ShortcutsSheet
    ui/           EmptyState · InlineError · SkeletonRows · TimeText
    api/          client · queries · errors
    lib/          pos · time (incl. parseGoTo); srEvent comes from @sr/protocol/core (03-L17)
    features/
      workspace/  Workspace · panels · default-layout · persist · restore · reset · panel-events · PanelFrame · commands
      player/     store · commands · span · playhead · windows · Panel · TabIcon · Transport · Scrubber · Bands …
        stage/    host · useStageSlot · fit
        engine/   controller · layers   ← the only runtime importers of @sr/recorder-engine/replay (lazy chunk)
      rows/ actions/ console/ network/ state/ diff/ info/ access/ sessions/ hotspots/
```

**Scripts** need `--bun`, because Vite's bin starts with a `node` shebang and Node isn't on the PATH:
`"dev": "bun --bun vite"`, `"build": "bun --bun vite build"`, `"preview": "bun --bun vite preview"`,
`"mock": "bun mock/server.ts"`.

**Dependencies** (each the newest release at least 2 weeks old on 2026-11-11; U1 re-checks):
- Workspace: `@sr/protocol`, `@sr/recorder-engine` (`workspace:*`).
- React: `react`, `react-dom` 19.3.1.
- TanStack and state: `@tanstack/react-router` 1.170.46, `@tanstack/react-query` 5.105.0,
  `@tanstack/react-virtual` 3.14.23, `zustand` 5.0.16.
- Shared with the server, same exact versions: `zod` 4.6.7, `hono` 4.13.14.
- Mantine 9.7.4: `@mantine/core`, `hooks`, `dates`, `notifications`, plus `dayjs` 1.11.23 (a peer of
  dates).
- Other UI: `@tabler/icons-react` 3.50.0, `flexlayout-react` 0.11.1, `microdiff` 1.6.0.
- Dev: `vite` 8.3.5, `@vitejs/plugin-react` 6.1.2, `@rolldown/plugin-babel` 0.2.4, `@babel/core`
  7.29.7, `babel-plugin-react-compiler` 1.0.0, `@types/react` and `@types/react-dom` 19.3.0,
  `@testing-library/react` 16.3.3. Babel 7, because compiler 1.0 depends on `@babel/types` ^7.
- tsconfig extends `../../tsconfig.base.json` and adds `"types": ["vite/client", "bun"]`.

```ts
// Sample — not final code. apps/replay-ui/vite.config.ts
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { cspFor } from './csp';   // the D30 text; U10 asserts it equals apps/server's header
const api = process.env.SR_API ?? 'http://localhost:3310';
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: { port: 3320, strictPort: true, proxy: { '/api': api, '/assets': api } },
  preview: { port: 3321, strictPort: true, headers: { 'Content-Security-Policy': cspFor('http://localhost:3321') } },
  build: { assetsDir: 'ui', manifest: true, target: 'es2022' },   // never 'assets' (X28)
});
```
- `test/build.test.ts` fails on an inline script in `dist/index.html`, anything under `dist/assets/`,
  any font or image file, or a missing `dist/theme-boot.js`. It reads the manifest: rrweb and
  `@sr/recorder-engine/replay` are reachable only through the lazy replay chunk.
- The dev server injects inline scripts for React Refresh, so dev never sends the CSP; **preview
  does**, so CSP problems show before U10.

### Router and flexlayout

```
root (Header, Notifications)
 ├─ _workspace (pathless; user/day/errors, retained) → <Workspace>
 │     SessionBar · <div data-sr-workspace> <Layout/> </div> · <Outlet/>
 │     ├─ /                 → null (panels show their "no session" state)
 │     └─ replay/$sessionId → lazy binder; remountDeps: ({ params }) => params.sessionId
 └─ hotspots (lazy, no workspace)
```
- **Panels read the open session from the URL:** `useParams({ strict: false }).sessionId`.
- **The binder renders nothing visible.** It owns the access gate (U8), then
  `attachStage(workspaceEl)` and `createPlayerController({ stage: engineRoot })`. `remountDeps` gives a clean destroy and recreate
  when the session changes.
- **The `Model` is created once per Workspace mount** by `createModel(json, prev?)`, which also sets
  `setOnAllowDrop` so the Player never goes into a border. **Reset and Undo use
  `Model.fromJson(json, currentModel)`**, which adopts the old model's view state; a non-adopted
  model makes `<Layout>` remount every tab. `invalidateTabContentOnParentRender={false}`: panels get
  their data from hooks, not from the factory.
- **`panel-events.ts` fans events out.** flexlayout keeps one listener per event per node
  (`listeners.set`), so the fan-out registers once per node and `PanelFrame` and `useStageSlot` both
  subscribe. It registers again when the node object changes (a new model).
- **`PanelFrame`** gives each panel `{ node, visible }` and an error boundary.
- **`TabExtra` components render through `onRenderTab`:** the Player icon (from `status`), the
  Console and Network badges (from `counts.consoleErrors`, `counts.failedReqs`). Being components,
  they re-render on their own.

```ts
// Sample — not final code. src/features/player/stage/host.ts
/** One stage for the app's life. Never moved: moving an <iframe> reloads it (L22).
 *  It holds only the engine's layers, marked inert: nothing in the recorded page takes focus or
 *  typing, and the host adds nothing to Tab order or the reading order (devil, 2026-11-11). */
const host = document.createElement('div');                                   // absolute; overflow:auto for zoom
host.inert = true;
export const engineRoot = host.appendChild(document.createElement('div'));    // scaled; engine layers go here

/** Called by the binder BEFORE `ctl.open()`. The Player tab may not be rendered yet (another tab
 *  in front, or another tabset maximised, on a reload), but rrweb needs its iframe in the page. */
export const attachStage = (ws: HTMLElement) => { if (host.parentElement !== ws) ws.appendChild(host); };

/** Positions only. A missing, hidden or 0×0 slot hides the host and keeps its last size. */
export const placeStage = (slot: HTMLElement | null, visible: boolean) => {
  const ws = host.parentElement;
  const a = slot?.getBoundingClientRect();
  const shown = !!ws && !!a && visible && a.width > 0 && a.height > 0;
  if (shown) {
    const b = ws.getBoundingClientRect();
    Object.assign(host.style, { left: `${a.left - b.left}px`, top: `${a.top - b.top}px`,
                                width: `${a.width}px`, height: `${a.height}px` });
  }
  host.style.visibility = shown ? 'visible' : 'hidden';   // never display:none: no 0×0 rescale
};

// flexlayout drags tabs with native drag and drop; dragover goes to the element under the pointer,
// so the stage must not swallow it (edge-dock zones and the Player tabset body sit under it).
document.addEventListener('dragstart', () => { host.style.pointerEvents = 'none'; });
document.addEventListener('dragend', () => { host.style.pointerEvents = ''; });
```
- **The Player tab sets `enableRenderOnDemand: false`**, so its slot exists even when it was never
  shown, and the binder attaches the host to `[data-sr-workspace]` (already in the page when child
  effects run) before it opens the controller.
- `useStageSlot` calls `placeStage` at most once per animation frame: on a ResizeObserver of the
  slot and the workspace, on the TabNode's `resize` and `visibility` events, and on a `layoutRev`
  bump from `onModelChange`.
- **Overlays live in the slot, not the host** (banners, Screen unknown, the seek card, Buffering):
  the Player panel renders them over its slot with `position:absolute; z-index:2`, so they keep
  their place in Tab order and the reading order. U4b checks that flexlayout's tab content starts
  no stacking context of its own; if it does, the overlays move into the host and the plan changes.
- **Layering:** the workspace container gets `position:relative; isolation:isolate`, the host
  `z-index:1` (above tab content), the slot's overlays `z-index:2`; flexlayout's splitters (10), tab
  overlays (20), drag outlines and border overlays (1000) stay above. Mantine popovers render at body
  level, above all of it.

### Theme

| Piece | File | Owner |
|---|---|---|
| Reads `sr.theme` (`auto` / `light` / `dark`) and sets `data-mantine-color-scheme` on `<html>` | `public/theme-boot.js` | U1 |
| `localStorageColorSchemeManager({ key: 'sr.theme' })`, `defaultColorScheme="auto"` | `theme/scheme.ts` | U1 stub, then U3a |
| `createTheme`: fonts, sizes, spacing, radius, `primaryShade: 8`, `cssVariablesResolver` for the AA overrides | `theme/theme.ts` | U3a |
| `--sr-*` under `:root[data-mantine-color-scheme='light' \| 'dark']` | `theme/tokens.css` | U3a |
| 24 px `xs` controls | `theme/density.css` | U3a |
| Base `light.css` + `--flexlayout-*` mapped to `--sr-*`, and the tab rules | `theme/flexlayout.css` | U3a |
| Band patterns | `features/player/bands.css` | U5 |

- **One attribute switches the theme:** Mantine's own `data-mantine-color-scheme`. There is no
  second `data-theme` attribute to drift. A test reads `theme-boot.js` and `scheme.ts` and checks
  they use the same key.
- **Mantine's CSS is imported as `styles.layer.css`**, so our CSS wins without specificity fights.

### State and data flow
- **`usePlayerStore` gains** `spanRev` (bumped by every append and rebuild), `zoom: 'fit' | 0.5 |
  0.75 | 1` (back to `fit` for each session) and `fitScale`. `reset` keeps `speed` and `follow`.
- **Panels, the scrubber and shortcuts drive playback through `player/commands.ts`,** a facade that
  type-imports the controller. The binder binds it to the live controller; with no session open its
  calls do nothing.
- **`usePlayHead({ every })`** throttles reads to 10 a second (State: 250 ms). It unsubscribes while
  `PanelFrame` says the panel is hidden, and reads the current value again when it shows.
- **Row model (L24):** `useRowModel()` reads `spanRev` from the store and passes it **as an
  argument** to a single-entry memo, `buildRowModel(apiRows, spanRev)`, which reads
  `getSpanChunks()` inside. The compiler only sees dependencies it can read, so a mutable module
  must never be read during render without its revision (devil, 2026-11-11). Pure selectors run on
  the model: `selectActionRows(model, filter)`, `selectConsoleRows`, `selectNetworkRows`. J/L/E use
  the same selectors with the Actions filter store, so they work even when the Actions tab is closed.
- **Layout menu:** the list of open tabs is state, updated from `onModelChange`; the menu never
  walks the `Model` while rendering.
- **Integrity (D28):** the controller merges each window's `read` and `failed` into the store's
  `integrity`. Three readers: `IntegrityNote` (exported from `features/player`, L23, and rendered
  by the SessionBar), `Bands` (adds a `chunk-unreadable` band for a chunk that failed for the first
  time during playback, since `detail.bands` was fetched earlier; 05) and Info. The session bar
  says "Integrity: checked as each part loads" until the first window is read, then "Unchanged
  since received" (all read chunks `ok`), or the red "1 chunk failed its check".
- **Follow:** `RowList` scrolls to the current row while follow is on and the panel is visible. Only
  signs of user intent turn it off: wheel, touch, PageUp/PageDown, or dragging the scrollbar. The
  list's own scrolling never does.
- **Zoom (L20):** `fit.ts` watches the host and the recorded `viewport` and sets `fitScale`;
  `engineRoot` gets `transform: scale(…)`, and the host scrolls above Fit. The UI scales its own
  `div`, never rrweb's wrapper.
- **Go to time (L21):** `parseGoTo(detail, text)` returns `{ t }` or an error message; the result goes
  to `player.seek({ t })`. `G` opens the popover.
- **`M`** (maximise the Player) calls `workspace/commands.ts`.

### Routes in code

```tsx
// Sample — not final code. apps/replay-ui/src/router.tsx
import { createRootRoute, createRoute, createRouter, lazyRouteComponent,
  retainSearchParams } from '@tanstack/react-router';
import { Day, PosKey, UserId } from '@sr/protocol';
import { z } from 'zod';

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFound });
const workspaceLayout = createRoute({         // pathless: SessionBar + the flexlayout <Workspace> + <Outlet/>
  getParentRoute: () => rootRoute, id: 'workspace', component: WorkspaceLayout,
  validateSearch: z.object({
    user: UserId.optional(),                   // same rule as ingest (03)
    day: Day.optional(),                       // UTC day (D31); default: today
    errors: z.boolean().optional() }),
  search: { middlewares: [retainSearchParams(['user', 'day', 'errors'])] },
});
const indexRoute = createRoute({ getParentRoute: () => workspaceLayout, path: '/', component: () => null });
const replayRoute = createRoute({
  getParentRoute: () => workspaceLayout, path: 'replay/$sessionId',
  validateSearch: z.object({
    pos: PosKey.optional(),                                    // '<recordingId>:<seq>:<idx>' (03-L9)
    t: z.string().regex(/^(\d+:)?\d{1,2}:\d{2}$/).optional(), // elapsed from session start
  }),
  remountDeps: ({ params }) => params.sessionId,             // a new session = a clean destroy + create
  // The binder renders nothing visible: access gate, then the controller on the fixed stage (L22).
  // The player chunk (engine + rrweb) loads only when a session opens.
  component: lazyRouteComponent(() => import('./routes/replay'), 'ReplayBinder'),
});
const hotspotsRoute = createRoute({
  getParentRoute: () => rootRoute, path: 'hotspots',
  validateSearch: z.object({ day: Day.optional(), app: z.string().max(64).optional() }),
  component: lazyRouteComponent(() => import('./routes/hotspots'), 'HotspotsPage'),
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([workspaceLayout.addChildren([indexRoute, replayRoute]), hotspotsRoute]),
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
/** A chunk that failed its check when read (D28): never played, and kept apart from never-arrived
 *  batches so the UI can say "Unreadable" and the session bar stays honest (devil, 2026-11-11). */
export type FailedChunk = { recordingId: string; seq: number; integrity: 'mismatch' | 'unreadable' };
export type WindowData = { chunks: LoadChunk[]; missing: SeqRange[]; failed: FailedChunk[]; read: number };
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
  const out: WindowData = { chunks: [], missing: [], failed: [], read: 0 };
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
      out.read++;
      if (meta.integrity === 'ok') { out.chunks.push({ meta, events }); continue; }   // 04's one LoadChunk shape
      out.missing.push({ fromSeq: meta.seq, toSeq: meta.seq });            // the engine treats it as a gap
      out.failed.push({ recordingId: meta.recordingId, seq: meta.seq, integrity: meta.integrity });
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
  unknown: null | 'missing-batches' | 'chunk-unreadable';   // the "Screen unknown" overlay and its copy (devil X1)
  integrity: { read: number; failed: FailedChunk[] };       // chunks read so far; feeds IntegrityNote, Bands, Info
  progress: { phase: 'fetch' | 'build'; done: number; total: number | null } | null;  // long seeks (A5)
  viewport: { width: number; height: number } | null;   // recorded size, for scale-to-fit
  follow: boolean;               // one global flag (F): every list scrolls with the play head
  spanRev: number;               // bumped by every append and rebuild; keys the row model (L24)
  zoom: 'fit' | 0.5 | 0.75 | 1;  // L20; back to 'fit' for each session
  fitScale: number;              // set by stage/fit.ts from the host size and `viewport`
};
type PlayerActions = { patch: (p: Partial<PlayerState>) => void; reset: (id: string | null) => void };
const initial: PlayerState = { sessionId: null, status: 'idle', t: 0, pos: null, speed: 1, span: null,
  unknown: null, integrity: { read: 0, failed: [] }, progress: null, viewport: null, follow: true, error: null,
  spanRev: 0, zoom: 'fit', fitScale: 1 };

// Plain data only: commands live in PlayerController, so the store is easy to test and inspect.
export const usePlayerStore = create<PlayerState & PlayerActions>()((set) => ({
  ...initial,
  patch: (p) => set(p),
  // Speed and follow are the viewer's preferences, so they survive a session switch.
  reset: (sessionId) => set((s) => ({ ...initial, sessionId, speed: s.speed, follow: s.follow })),
}));
```

Panel choices (action kinds, search text, selected store) live in **one small store per panel**,
inside that panel's folder (`features/actions/filter.ts`, `features/console/filter.ts`, …), so a
play-head tick never re-renders the filters and parallel tasks never share a store file (devil,
2026-11-11). J/L/E read the Actions filter store. **`integrity`** is merged by the controller after
every window load (deduplicated by recording and `seq`). Components read with
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
  let lastPos: StreamPos | null = null;
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
    const add = d.chunks.filter((c) => !seqs.has(c.meta.seq));   // the edge chunk is in both windows
    add.forEach((c) => seqs.add(c.meta.seq));
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
      seqs = new Set(d.chunks.map((c) => c.meta.seq)); missing = d.missing;
      patch({ span: { first, last } });
      return true;
    } finally { clearTimeout(slow); if (my === gen) patch({ progress: null }); }
  };

  const onTick = ({ t, pos }: { t: number; pos: StreamPos }) => {
    lastPos = pos;                           // onUnknown names its reason from this (reasonAt)
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
    // The engine only says "unknown"; the controller names the reason from the chunk under the play
    // head: a failed chunk is "chunk-unreadable", anything else "missing-batches" (devil, 2026-11-11).
    e.onUnknown(({ unknown }) => patch({ unknown: unknown ? reasonAt(lastPos) : null }));
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

The binder (`routes/replay.tsx`) owns the controller and passes `stage: engineRoot`, the fixed
host's engine layer (L22), never an element inside a flexlayout tab. **A `useEffect` must not return
a Promise** (spike lesson), so it calls `void ctl.open(start)` and returns `ctl.destroy`. `start`
comes from `?pos=` or `?t=` once; later URL changes call `ctl.seek`. Panels reach the controller only
through `player/commands.ts`. **Scale-to-fit and zoom** (L20) live in `stage/fit.ts`, which scales
`engineRoot` from `viewport`, so the UI never touches rrweb's wrapper element.

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
import { srEvent } from '@sr/protocol/core';     // { tag, payload, t } for a type-5 `sr:*` event, else null (03-L17)

export type Row = Omit<ActionRow, 'kind'> & { kind: ActionRow['kind'] | 'state'; local?: true };

/** State rows and every request row for the loaded span, built from its own events. */
export const localRows = (chunks: LoadChunk[]): Row[] => chunks.flatMap((c) =>
  c.events.flatMap((e, idx): Row[] => {
    const ev = srEvent(e);
    if (!ev) return [];
    const pos = { recordingId: c.meta.recordingId, seq: c.meta.seq, idx };
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
- **Tolerant (03-L16):** an `ActionKind` this UI doesn't know renders as a generic row (a neutral
  icon, its `name` and `summary`), and the kind filter shows it under "Other".

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

- `bun run build` (`bun --bun vite build`, L1) writes `apps/replay-ui/dist/`: `index.html`,
  `theme-boot.js` at the root (from `public/`), and hashed bundles under `dist/ui/`
  (`build.assetsDir: 'ui'`). **Nothing may land under `dist/assets/`**, which would collide with
  `/assets/:sha256` (05-C9, devil X28). `test/build.test.ts` checks that, no inline `<script>`, no
  font or image files, and that rrweb is reachable only through the lazy replay chunk.
- **The UI's own icons and fonts are inlined.** D30 allows images and fonts only from `/assets/`
  and `data:`. So icons are Tabler inline-SVG components, fonts are the system stack, and
  `index.html` sets a `data:` favicon; otherwise the browser's own `/favicon.ico` request is a CSP
  violation. Mantine's CSS has no `url()` and no fonts; its runtime `<style>` tag for CSS variables
  is allowed by `style-src 'unsafe-inline'` (architect, checked in the 9.8.0 package; U1 re-checks the pinned 9.7.4).
- **Theme before first paint:** `index.html` loads `/theme-boot.js` as a blocking classic script
  (`script-src 'self'` allows it); Mantine's inline `ColorSchemeScript` is never used (L17).
- `bun run dev` (`bun --bun vite`, port 3320) proxies `/api` and `/assets` to `SR_API` (default: the
  mock on port 3310). Dev sends no CSP, because React Refresh injects inline scripts.
- `bun run preview` (port 3321) serves `dist/` with **the exact D30 CSP header** from `csp.ts`, so
  CSP problems show before U10.
- `apps/server` serves `dist/` (including `/ui/*` and `/theme-boot.js`) with a history fallback for
  `/replay/*` and `/hotspots` (05).

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
- Put the engine's layers and every player overlay in the fixed stage host (L22). Drive playback
  from panels, the scrubber and shortcuts only through `player/commands.ts`.
- Give each panel's play-head subscription to `usePlayHead`, so it pauses while the tab is hidden.
- Use Mantine components and the `--sr-*` tokens; check every new colour pair for AA in both themes.
- Show a colour, a pattern **and** a label for every band and note.

**Don't**
- Move the stage host, or put the engine or the replay iframe inside a flexlayout tab (L22).
- Read a flexlayout `Node` or `Model` while rendering: React Compiler may serve a stale value from a
  mutable object. Turn its events into state (`PanelFrame`). The escape hatch is `'use no memo'`.
- Use Mantine's `ColorSchemeScript`, or add a style nonce (it would turn off `'unsafe-inline'`).
- Copy the real app's CSS (L18), or recolour the recorded screen in dark mode (L17).
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
- [ ] Play/pause, back/next (following the action filter, even with the Actions tab closed), all six speeds, scrubber drag and keys, and every shortcut (including `M`, `Shift+E`, `G`) work. Shortcuts do nothing while typing in a field or with a dialog or menu open.
- [ ] Every `FidelityReason` shows as the band or note 03's table gives it, with a label and a pattern; an unknown reason and an unknown action kind (`batch-future.json`) still render (03-L16); a recording with a newer rrweb shows the "Newer recorder" note. A banner shows while the play head is inside a gap. Popout bands and the canvas placeholder are visible (D34).
- [ ] Inside a `missing-batches` or `chunk-unreadable` band the "Screen unknown" overlay covers the frame until the next full snapshot, so no frame inside it looks complete (devil X1). "Skip to …" lands on that snapshot. A recording without `sr:close` shows the "ended without a clean close" note.
- [ ] Playback never plays the time between recordings: at a recording's end it jumps to the next one's first frame with a "Skipped …" toast.
- [ ] A client clock 5 min off: markers, bands, the action list and the scrubber line up with the screen; labels show `t + clockOffsetMs` (devil X2).
- [ ] The rate-cap legend shows the config version and capped columns, or "No rate caps". A mid-session change shows both versions.
- [ ] Every session shows "Identity: client-asserted" and "Unchanged since received" in the session bar, in every layout, including with the Player maximised. A chunk with a failed hash check shows a red note and its band, and its events are never played.
- [ ] Action list: filters by kind (no mini-app filter in the MVP, Q27; the State chip is off by default), failed requests in red, a click seeks by position, the list follows the play head until the user scrolls, and 10,000 rows scroll smoothly. State and request rows come from the loaded span, merged with the API's rows by position with no duplicates. Console lines (D43) show as rows with a level icon, the message and a repeat count, with a level filter (error, warn, info, log, debug); a row click seeks like any row, and a chevron expands the stack once that span is loaded (seek, then expand). A `console-capped` note shows when a recording hit the console cap.
- [ ] State and Diff tabs: the state and the last action's changes ([Changes | Payload]) are correct at any position (store snapshots + actions), with a store picker. `$root` stores, deny-listed and capped keys (`NotRecorded`), the no-store and `no-state` cases show correctly; inside an unknown band the panel says its state may be out of date.
- [ ] An 8-hour busy session fetches only the windows it plays (the current one and the next). A seek finishes in under 2 s; on the busiest desk it may take longer, with the progress bar after 300 ms (user, 2026-11-10). At most 3 windows stay in memory. Playback crosses a window edge with no rebuild and no flash, showing "Buffering…" only if the next window hasn't arrived.
- [ ] A framed chunk response, including an `unreadable` chunk with 0 bytes and a response cut by `next`, loads through `readChunks` and `DecompressionStream` (the mock serves `chunks-v1.bin`).
- [ ] Awkward states: switching sessions mid-load (no stale frame, no error); a background tab during playback; two replay tabs on different sessions; browser back/forward between sessions; window resize; going offline mid-load (error + Retry); a 404 (region note); refreshing a live session.
- [ ] Hotspots: day and app filters, sorting, and "open" lands on the pause position after the access prompt. Empty, loading and error states work.
- [ ] The built UI, served by `apps/server` with the D30 CSP, shows no CSP violations in the console, the iframe makes no network requests, and `dist/` has no inline scripts and nothing under `assets/`.
- [ ] Twenty session switches in a row leave no growing heap (old engines, layers and iframes are freed).
- [ ] **Workspace (L16):** tabs drag, split by edge-dock, resize and maximise/restore; closable tabs close. Player and Sessions show no × and can't be closed or dropped into a border. No popout or float control exists anywhere.
- [ ] **Moving or maximising the Player tab doesn't reload the replay:** same frame, same play state, no engine rebuild, and the iframe isn't reloaded (L22). Hiding the Player behind another tab and showing it again rescales correctly; maximising Actions hides the stage. A reload with the Player behind another tab, or with another tabset maximised, opens and plays. Dragging a tab over the stage still finds the edge-dock and tabset drop targets.
- [ ] A reload keeps the layout. A corrupt or old-version layout falls back to the default with a toast. A closed tab comes back from the Layout menu into its home tabset, or the fallback. "Reset layout" restores the default, and Undo works for 10 s.
- [ ] **Theme (L17):** follows the OS by default and updates live when the OS changes; the menu choice persists per browser, and "System" goes back to following the OS. No flash of the wrong theme on load, and no CSP violation from theme code. flexlayout's tab chrome switches with the theme. The recorded screen is never recoloured.
- [ ] Both themes pass **WCAG 2.2 AA**: text 4.5:1, control boundaries, graphics and the focus ring 3:1, targets 24 × 24 px (axe with `wcag22aa` on every mock and on the built UI).
- [ ] Every reason shows its colour, pattern and label. Patterns survive Windows high-contrast mode.
- [ ] Hidden panels do no per-tick rendering (a performance trace during playback). Console and Network tab badges count error rows and failed requests.
- [ ] **Zoom (L20):** Fit / 50 / 75 / 100 % work, the stage scrolls above Fit, and each session opens at Fit. **Go to time (L21):** `G` opens it; `09:26:07`, `09:26` and `+24:00` seek correctly; a time before the start or a bad format shows the error copy and doesn't seek.
- [ ] React Compiler is active in dev, in tests and in the build (`react.memo_cache_sentinel` in the output); the build has nothing under `dist/assets/` and `theme-boot.js` at the root.

## Tasks

Commands for tier 1: `bunx tsc --noEmit -p apps/replay-ui` and
`bun test --preload ./apps/replay-ui/test/compiler-preload.ts apps/replay-ui`. The preload runs
`babel-plugin-react-compiler` on `apps/replay-ui/src/**/*.tsx`, so component tests run compiled code
(`bun test` doesn't run Babel; devil, 2026-11-11).
All paths are under `apps/replay-ui/`. Unit tests sit next to the code they test (`*.test.ts`),
inside each task's `owns:`.

- [ ] **U0 Design mocks** — owns: `docs/design/replay-ui/**` (repo root, not `apps/`) — batch: planning phase (the user asked for the mocks, 2026-11-11) — depends on: none — done when: the 11 files in "Mocks (U0)" open from disk with no network requests; the theme menu, tab switching and variant switching work; axe shows no contrast failures in either theme; **the user approves the look**.
- [ ] **U1 Scaffold** — owns: `package.json`, `tsconfig.json`, `vite.config.ts`, `csp.ts`, `index.html`, `public/theme-boot.js`, `src/main.tsx`, `src/router.tsx`, `src/routes/*` (placeholders), `src/theme/{scheme,theme}.ts` (stubs), `src/features/<every panel, access, hotspots>/index.ts` (placeholders, L23; each feature task then takes over its own), `test/{build,imports}.test.ts`, `test/render.tsx`, `test/compiler-preload.ts` — batch: B1 — depends on: 01 X1 (`tsconfig.base.json`, `biome.json`) — done when: `test/build.test.ts` passes (no inline script, nothing under `dist/assets/`, no font or image files, `theme-boot.js` at the root, rrweb only in the lazy chunk); `react.memo_cache_sentinel` appears in the built output (the import path doesn't survive minification), and a component test shows the preload compiles; `index.html` has a `data:` favicon; Mantine and flexlayout-react render in `preview` with the D30 header and no violations; a test fails on any `@rrweb/*` import; tier 1 passes.
- [ ] **U2 API layer and mock** — owns: `src/api/**`, `mock/**` — batch: B2 — depends on: 03 T1, T2; U1 — done when: every mock response validates against the 03 schemas; the mock serves the framed `chunks-v1.bin`, and `windowQuery` loads it through `readChunks` (non-`ok` chunks go to `missing`, `next` is followed); every request carries `X-SR-UI: 1` and no empty param; the hooks are tested against the mock, including 403 `{need:'access'}`; `MOCK_SCENARIO=slow|error|empty|expired|live` works. The fixtures may reuse the U0 scenario.
- [ ] **U3a Shell, theme, workspace** — owns: `src/routes/{root,workspace,workspace-index}.tsx`, `src/shell/**`, `src/theme/**` (takes over U1's stubs), `src/ui/**`, `src/features/workspace/**` — batch: B2 — depends on: U1, U2 — done when: unit tests on a `Model` cover load, fallback with the toast, restore with all three fallbacks, reset and Undo through adoption, the drop rule (Player never into a border), no float or popout, and the event fan-out; every flexlayout name the plan uses is checked against 0.11 (model attributes, the `invalidateTabContentOnParentRender` prop, `Model.fromJson(json, prev)`, the `--flexlayout-*` variables, and `setEventListener`: if it allows several listeners per event, `panel-events.ts` is dropped); the theme choice persists in `sr.theme` and a test checks `theme-boot.js` uses the same key; tab badges render from `counts`; header, session bar, Layout and Theme menus and the shortcuts sheet match the U0 mocks; tier 1 passes.
- [ ] **U3b Sessions panel** — owns: `src/features/sessions/**` — batch: B2 — depends on: U3a, U4a — done when: filters sync with the URL; all badges render from fixtures; empty, loading and error show under the mock scenarios; ↑/↓ and Enter open a row; search-param parsing is unit-tested.
- [ ] **U4a Windows, positions and times** — owns: `src/features/player/windows.ts`, `src/lib/{pos,time}.ts` (`srEvent` and the position helpers come from `@sr/protocol/core`, 03-L17) — batch: B2 filler (may start once U1 and 03 T2 are done) — depends on: U1; 03 T2 — done when: unit tests cover one window per anchor at the FullSnapshot's own `idx`, no window across recordings, `to: null` at each recording's end, `windowAtTime` snapping between recordings, position order across recordings, `displayMs` with two recordings and different offsets, clock parsing, the local/UTC formatters (L19), and `parseGoTo` (`hh:mm`, `hh:mm:ss`, `+m:ss`, before-start and bad-format errors, L21).
- [ ] **U4b Controller, stage and binder** — owns: `src/features/player/index.ts` (from U1; then to U5), `src/features/player/{store,commands,span,playhead}.ts`, `src/features/player/engine/**` (controller, layers, toasts), `src/features/player/stage/**` (host, useStageSlot, fit), a first `src/features/player/Panel.tsx` (the slot and a play button), `src/routes/replay.tsx` — batch: B3 — depends on: U4a, U2, U3a; 04 R3's `ReplayEngine` (a `FakeReplayEngine` in the tests until it lands) — done when: controller tests with the fake engine cover append at 60 %, the shared edge chunk appended once, no rebuild at an edge, evict at 3 windows, a rebuild on a seek outside the span, the jump between recordings with its toast, `setGaps` from `missing` plus non-`ok` chunks, `onUnknown` → `unknown`, progress after 300 ms, destroy mid-load, the `gen` guard and `spanRev`; `placeStage` math is tested; the host is never inside `.flexlayout__layout`; the commands facade does nothing with no session; zoom and `fitScale` are tested; `integrity` merges `read` and `failed` across windows; deep links work on the mock, **including a reload with the Player behind another tab or another tabset maximised**; a 0×0 slot hides the host; the host ignores pointer events during a tab drag; flexlayout's tab content is checked for its own stacking context (L22).
- [ ] **U6a Rows and Actions panel** — owns: `src/features/{rows,actions}/**` — batch: B3 — depends on: U4b — done when: `localRows` from fixture chunks, `mergeRows` with no duplicate failed requests, the single-entry memo (the model is built once for three callers), filters (State off by default), virtualisation, click-to-seek by `pos`, follow and its user-intent rules, and the J/L/E targets are unit-tested; so are console rows in the model (D43): levels, repeat counts, `dropped` counts, and `info`/`log`/`debug` rows from the loaded span.
- [ ] **U7 State and Diff panels** — owns: `src/features/{state,diff}/**` — batch: B3 (parallel with U6a, U8, U11) — depends on: U4b — done when: `stateAt` tests cover snapshot + actions, removed keys, `$root`, `NotRecorded` values, several stores, a partial store, and "forward from cache equals full recompute"; State and Diff ([Changes | Payload]) render fixture data; State updates at most 4×/s and does no work while hidden.
- [ ] **U8 Access prompt and expiry** — owns: `src/features/access/**`; takes over `src/routes/replay.tsx` from U4b (the gate) — batch: B3 — depends on: U2, U4b — done when: the prompt blocks loading until granted; the name is remembered and the reason isn't; the lengths follow `AccessReq`; every state in "Access prompt" renders; expiry mid-replay pauses and resumes at the same position (mock `expired`).
- [ ] **U11 Info panel** — owns: `src/features/info/**` — batch: B3 — depends on: U4a, U2 — done when: details, integrity ("read so far"), the recordings table, known gaps (canvas, popouts, `useState`, WebSocket D41), rate caps (one line per version) and the full legend render from fixtures; empty, loading and error are covered.
- [ ] **U5 Controls, scrubber, bands, overlays, shortcuts** — owns: `src/features/player/{Panel,TabIcon,Transport,Scrubber,Bands,Legend,LegendPopover,Notes,Overlays,Banner,Zoom,GoTo}.tsx` (takes over U4b's `Panel.tsx` and `index.ts`), `src/features/player/IntegrityNote.tsx`, `src/features/player/bands.css`, `src/features/player/shortcuts.ts` — batch: B3, after U6a — depends on: U4b, U6a (the J/L/E targets) — done when: each of the 14 `FidelityReason` fixtures renders with its colour, pattern and label as the bands table says, an unknown reason from `batch-future.json` renders as a note with its raw name, and `newerRrweb` shows its note; banners stack (2 + "more"); the "Screen unknown" overlay (copy by `unknown` reason) and the progress card render from the store in the Player's slot; `IntegrityNote` shows all three states, and a chunk that fails during playback adds an Unreadable band; scrubber labels use `displayMs` and local time; zoom and Go to time work; the Player tab icon follows `status`; the shortcut map is unit-tested, including `M`, `Shift+E`, `G` and the focus rules.
- [ ] **U6b Console and Network panels** — owns: `src/features/{console,network}/**` — batch: B3, after U6a — depends on: U6a — done when: level chips, the stack expand after a seek, dropped and `console-capped` rows, the Network table (time, method, status, URL, duration; status 0 shows "Failed"), the "loaded part" strips and the tab-badge counts are tested on fixtures.
- [ ] **U9 Hotspots page** — owns: `src/routes/hotspots.tsx`, `src/features/hotspots/**` — batch: B4 — depends on: U2; 05 S8 hotspots API (or the mock) — done when: filters, sorting, the Partial day badge and the example link work on fixtures; empty, loading and error are covered; it matches `07-hotspots.html`.
- [ ] **U10 Real server and CSP** — owns: `src/api/client.ts` (from U2), `test/csp.test.ts` — batch: B4 — depends on: 05 S7 (query API); 04 R3 (the inert URL rewrite, devil X27); U1–U9, U11 — done when: the UI type-checks against `QueryApi`; `csp.ts` matches `apps/server`'s header; the golden session replays from `apps/server` with the D30 CSP and no violations. (qa writes the e2e specs in `specs` mode during B3–B4; they first run at the gate.)

**Order inside B3** (architect): U4b → U6a, U7, U8 and U11 → U5 and U6b. The 3-agent limit is
shared with the 04 and 05 lanes, so the 06 lane usually holds one slot: take its tasks in that
order as slots free up.
No two tasks that run at the same time own the same file; every hand-off is sequential (U1's
placeholders and theme stubs → U3a and the panel tasks; U4b's `Panel.tsx` → U5; `replay.tsx` → U8).

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
| The Player remounts, or its iframe reloads, when its tab moves or maximises (flexlayout moves tab elements with `appendChild`). | L22's fixed stage host; Reset and Undo adopt the old model; an e2e test moves and maximises the tab and checks the same frame with no rebuild. **04 R0 check 9 proves the host in B0** (architect, 2026-11-11), so a miss changes this plan before U4b, not in the middle of B3. |
| The stage is measured while hidden behind another tab. | The host only becomes `visibility:hidden` and keeps its last size; never `display:none`. Rescale on the tab's visibility event. |
| The host covers flexlayout's chrome (splitters, drag outlines, the Sessions border overlay). | The z-index stacking in "Router and flexlayout", checked during a drag and with the border overlay open. |
| React Compiler serves stale values from mutable objects (a flexlayout `Node` or `Model`). | Never read node state while rendering; events into state (`PanelFrame`); `'use no memo'` as the escape hatch. |
| Components that call `useVirtualizer` or `useReactTable` aren't compiled (known-incompatible list). | Keep `RowList` thin; filtering and row rendering live in compiled code. The player's hot paths sit outside React (L3, L6). |
| Mantine's defaults fail AA (dimmed 3.3:1, primary-6 3.6:1, error red-6 3.3:1, input borders 1.5:1), and an upgrade could undo the overrides. | The overrides in "Visual system"; exact pins; axe in qa on the mocks and at the gate. |
| Mantine's 24 px density fights its defaults (its `xs` heights differ by component: inputs 30 px, ActionIcon 18 px, Button `compact-xs` 22 px; `sm` inputs are 36 px), and a Mantine upgrade can rename the size variables. | One `density.css` on Mantine's static class names; exact pins; one control at 24 px checked in U3a. A breaking Mantine major comes about once a year (user accepted this trade-off over shadcn/ui). |
| Two toolchains in a Bun-first repo (devil will ask). | Vite runs under Bun (`bun --bun vite`) and only for this app; the reasons are the stable compiler in dev and the built-in proxy and preview headers (L1). |
| `theme-boot.js` and the Mantine manager drift to different storage keys. | A test reads both and checks they use `sr.theme`. |
| Two browser tabs save layouts over each other. | Last save wins; each tab reads once at load (designer). |
| **Blocker (devil):** on a reload with the Player tab never shown, rrweb's iframe would be built in a detached host. | The binder attaches the host before `open()`; the Player tab sets `enableRenderOnDemand: false`; U4b tests the reload (L22). |
| **Blocker (devil):** "Unchanged since received" could be shown while a chunk failed its check during playback. | `WindowData.failed` and `read`, the store's `integrity`, `IntegrityNote`, a live Unreadable band and the `unknown` reason (U4b, U5). |
| The stage swallows tab drags, covers a maximised panel, or puts the overlays last in Tab order. | Pointer events off during a drag; a 0×0 slot hides the host; overlays in the slot and the host `inert` (L22). |
| Component tests run uncompiled code, so compiler-only bugs show at the gate. | `test/compiler-preload.ts` runs the compiler under `bun test`; mutable modules are read with their revision. |
| Parallel tasks share `features/player/index.ts` or one filter store. | `index.ts` passes U1 → U4b → U5; one filter store per panel folder. |

## Open questions

All answered by the user on 2026-11-10 (01, Q27, Q29–Q32):
1. **Times:** the **recorded user's local time** (from `sr:meta.tz`), with UTC on hover (D42).
2. **Access:** one name + reason covers every session opened in that browser for 8 h (D38).
3. **Session list:** no prompt; searches are logged.
4. **Mini-app filter:** not in the MVP.
5. **Hotspots:** opens on yesterday.

Redesign round, answered on 2026-11-11:
6. **Component library:** the real app's custom CSS stays out; the replay UI gets its own library.
   **Mantine 9** over shadcn/ui (user, after the architect's comparison) — L18.
7. **Sessions:** one session at a time (user) — L16.
8. **Layout:** drag, split, maximise and close tabs, saved per browser, with Reset layout; no popouts (user) — L16.
9. **Build:** Vite 8 with React Compiler in dev and build (user) — L1.
10. **Zoom and Go to time:** both (user) — L20, L21.
11. **Integrity wording:** "read so far", so no 03/05 contract change (leader).
12. **Actions State chip:** off by default (leader).
13. **Routing with flexlayout:** the layout lives in the pathless workspace route; child routes only set which session is open (architect).
14. **Grid data:** in v1, grid data shows only on the recorded screen in the Player (zoom makes cells
    readable); rows outside AG Grid's rendered viewport and capped columns (D36) are as recorded. A
    structured grid view waits for the I6 spike (01 Q43, 08 §13); its expected home is a future
    **Grids** tab, which the panel registry (L23) can take without touching other panels. Nothing is
    designed for it before Q43 is answered (user, 2026-11-11).

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
- 2026-11-10 — Console rows in the action list (01 D43, 03-L15): a level icon, message and count, a level filter, an expandable stack; `error` and `warn` come from the API, the other levels from the loaded span; U6 tests them. The MVP2 analytics page is out of scope until after 09.
- 2026-11-10 — Console and analytics review merged (leader): the ⚠ badge shows `errors + consoleErrors`; stacks expand after a seek loads the span; the `console-capped` note; U6 covers `dropped`.
- 2026-11-11 — Replay UI redesign (user asked; dx-ux-designer and architect, merged by the leader): one flexlayout-react 0.11 workspace with eight tabs, Player and Sessions locked, saved per browser with Reset and Undo, no popouts (L16); a fixed session bar for the identity and integrity notes; light and dark themes via an external `theme-boot.js` (L17); Mantine 9 chosen over shadcn/ui, with a 24 px density file and AA overrides (L18); wall-clock times (L19); zoom and Go to time (L20, L21); a fixed stage host outside flexlayout so moving the Player never reloads its iframe (L22); panel modules at fixed paths (L23); one row model for Actions, Console and Network (L24); no `packages/ui` (L25). L1 moves from Bun's bundler to Vite 8 with React Compiler. Design: new workspace, shell, screens, the full 14-reason bands table, visual system, mocks and workspace sections replace the three-column wireframes. Tasks: new U0 (mocks) and U11 (Info); U3 and U6 split into a/b; U1, U4b, U5 and U7 changed. New acceptance items and risks.
- 2026-11-11 — Devil review of the redesign merged (leader): blocker 1, the stage host is attached by the binder before `open()` and the Player tab never renders on demand; blocker 2, chunks that fail their check are tracked apart from missing batches (`WindowData.failed`, the store's `integrity`, `IntegrityNote`, a live Unreadable band, the `unknown` reason). Risks: pointer events off during tab drags, a 0×0 slot hides the stage, overlays in the slot with the host `inert`, a compiler preload for `bun test`, the row model keyed by `spanRev`, `player/index.ts` passed U1 → U4b → U5, one filter store per panel, B3 slots shared across lanes, WCAG 2.2 AA with 24 px rows and targets, Mantine `sm` override, `--sr-loaded` blue-6 and a body gap around bands. Nits: U3a checks every flexlayout name; the compiler check looks for `react.memo_cache_sentinel`. Grid data: v1 shows it on the recorded screen only; a future Grids tab waits for the I6 spike (user, Q43).
- 2026-11-11 — Overall architect and devil review (01 → Overall review resolution): one `LoadChunk` shape `{ meta, events }` (the window builder, `localRows` and the controller read `c.meta`); `srEvent` and the position helpers come from `@sr/protocol/core`; unknown reasons and action kinds render (03-L16); a "Newer recorder" note (03-L18); 04 R0 check 9 proves L22's stage host in B0. Both themes stay in v1 (user).
