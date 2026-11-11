# 10 — Health: AMPS command log and app vitals
Status: draft · Size: large · Parent: [01-session-replay.md](01-session-replay.md) · Target: **v1.1**, right after the pilot (after Gate 2)

## Goal

In a replay, support staff can see **whether the AMPS feed behind the screen was healthy, and what
each connection was subscribed to at any moment**. The recorder logs, for every AMPS client any
remote opens, the commands the UI sends (subscribe, unsubscribe, SOW queries and the rest), the
server's acknowledgement of each, and the connection's life (connect, logon, disconnect, reconnect,
failover, errors). It **never** records AMPS data messages.

The same replay also shows **the app's own health** (user, 2026-11-11): whether the app was slow or
frozen at that moment, and how memory and DOM size grew over the day, as samples every few seconds.

Example: "the blotter froze at 09:24" becomes "the positions connection dropped at 09:23:58
(`reason: heartbeat timeout`), reconnected to the second server and resubscribed 40 s later", or
"the grid's filter was `/book = 'EQ-NA'`".

## Decisions

Inherits D1, D16, D18, D25, D41 (narrowed in v1.1, see M6), D43 and hard rules 4 and 5.

| # | Decision | Why | Who |
|---|---|---|---|
| M1 | **Capture in the browser**, by the recorder, for every AMPS client any remote opens ("build our own, from the UI"). No server-side collector. | One place; the log sits in the session's own stream, so it needs no join to sessions; no access to production AMPS (01 Q44 dropped). | user, 2026-11-11 |
| M2 | **Record the commands the UI sends and every ack the server returns; never data messages or heartbeats.** Publish-type commands (`publish`, `delta_publish`, `sow_delete`) are kept as metadata only (topic, correlation id, size), never the body. | The need is feed health and subscriptions, not market data; volume stays tiny (a subscribe happens when a screen opens, not per tick). | user; publish metadata: leader |
| M3 | **Record everything** (commands, acks, lifecycle); **only failures** (failed acks, connection errors, disconnects) show as Actions rows by default. | The active subscriptions at the play head need the successes too ("errors only in log", user). | user |
| M4 | **Logon credentials** (password, token, any secret-named field) are stripped in the browser with `isSecretKey` / `maskCutToken` from `@sr/protocol/secrets`. Topics, filters and options are recorded unmasked (D18). | Hard rule 4. | rule |
| M5 | **The hook never touches the data path:** no work per data message, so the app pays nothing per tick and hard rule 5 holds without a rate measurement. | The busiest desks' message rates are unknown (user: "not sure"). | leader |
| M6 | **v1.1, after Gate 2.** The pilot keeps D41 (no WebSocket traffic). In v1.1, D41 narrows to "no AMPS data messages". | Pilot scope stays as planned. | user |
| M7 | **Replay UI:** a new **AMPS** tab (an 06-L23 panel module) shows each connection and its **active subscriptions at the play head** (topic, filter, options, since, confirmed / pending / failed), rebuilt from the log like State. Failures are Actions rows and scrubber markers. | The user's two questions: was the feed healthy, and what was subscribed with which topic and filter. | user; layout: designer |

| H1 | **App vitals** answer three questions (user): was the app **slow or frozen** then (main-thread busy %, long frames, input delay), **memory growth** over the day (JS heap), **DOM size growth** (node count). Not wanted: which mini-app caused it (per-remote attribution). | Support sees "the screen froze for 3.2 s at 09:24" next to the replay, and spots leaks across an 8-hour day. | user |
| H2 | **Sampled, never per event:** one `sr:health` sample per self-budget window (5 s): busy %, longest frame, frames over 50 ms, worst input delay, JS heap used and total, DOM node count. About 5,800 samples in 8 hours. | Cheap and bounded, whatever the app does. | leader; the architect confirms the fields |
| H3 | **From data the recorder already has:** busy time and long frames from the LoAF observer the self-budget runs; node count from rrweb's mirror; heap from `performance.memory` (Chrome only, coarse). **Never walk the DOM** to count nodes. | Hard rule 5: no new per-event work. | leader |
| H4 | **Lands with the AMPS log in v1.1, in this plan.** | One architect and one designer pass for both; the pilot stays as planned. | user |
| M10 | **A runtime off switch for the hook:** `config.amps.enabled` and the limits, copied by the loader onto the queue object and read from `localStorage` at boot. | The kill flag arrives after the boot logon; a hook bug must be stoppable without rebuilding every remote (devil). | leader |
| M8 | **The hook is the build plugin**: 07's plugin patches each `amps` `Client` class at build time (option a below). **On by default** when a remote upgrades the plugin; `amps: false` opts out; the server-side kill switch still turns it off everywhere. | Covers every remote, copy and version with zero work per data message; no app code changes. | architect; default: user |
| M9 | **AMPS logging continues inside pause bands**, like `sr:net`; it passes straight through only when recording is off (kill, quota, logout, stop). | Per-command volume is bounded, and the subscriptions view stays complete. | architect |
| H5 | **Vitals keep sampling inside pause and hidden-tab bands**, flagged `paused` / `hidden`; `nodes` is null while rrweb is stopped. Input latency comes from an Event Timing observer. | A pause happens exactly when the app is busiest. | architect |
| H6 | **Thresholds:** frozen = one frame ≥ 1,000 ms (`health.freezeMs`, config); slow = a 5 s window with busy ≥ 50 % or input delay ≥ 500 ms, adjacent windows merged (a replay-UI display rule). | About 1 s is where users stop feeling a response; 500 ms is where INP rates "poor". | architect, designer |

**Considered and set aside:** a server-side collector that subscribes to AMPS's `/AMPS/ClientStatus`
event topic and polls the admin REST API behind Galvanometer. It would cost the browser nothing and
gives exact server-side events (connect, logon, disconnect with reason, subscribe and unsubscribe
with topic, filter and options), but it needs production AMPS access per region and a join from AMPS
client names to sessions. The user chose browser capture (2026-11-11).

## Design

### The hook: the build plugin patches `Client.prototype` (architect, 2026-11-11)

Facts marked **[src]** come from reading the `amps@5.3.4-0.378635.60b2fcc` npm source (the latest
on npm, 2024-05-17), unpacked and read, not run.

| | **(a) Plugin patches `Client.prototype`** (chosen) | (b) Shared MF singleton | (c) WebSocket wrap |
|---|---|---|---|
| Coverage | Every remote built with the plugin, every copy and version (one patch per `Client` class, guarded by a symbol). Clients made before the recorder loads are covered too, because the patch sits in the app bundle. CommonJS `require` and a script-tag global get a build warning and a one-line `srAttachAmps(Client)` fallback. | Only remotes that share `amps` on one version; forcing a singleton changes which version a remote runs. | Every copy, but only sockets opened after `sr-recorder.js` loads, so boot-time logon and the first subscribes are lost; fixing that means wrapping in the loader for every user (breaks D22). |
| Cost per data message (M5) | **Zero.** `onMessage` and the handlers are closures inside each instance and are never touched; acks arrive through the promise `execute` returns **[src]**. | Same as (a). | **Not zero:** every frame passes through us, and finding acks means tracking header, body and SOW-batch state **[src]**. |
| Fragility | Public ES5 prototype methods **[src]**, plus contract tests per version. | Module-federation share-scope internals across webpack 5 and Vite. | Re-implements the client's undocumented framing (length frame, header, data, `bs` batches). |
| Integration | The plugin is already in every remote: an `amps` option, **on by default** (user), `amps: false` opts out. No app code changes. | Edit the MF config of every remote and the host; align versions. | None. |

**What the patch handles [src]:**
- **`execute`** carries `subscribe`, `sow`, `sowAndSubscribe`, the delta variants, `unsubscribe` and
  `sowDelete*`. It sets the command id (`cid`) synchronously and asks for a `processed` ack (plus
  `completed` for `sow`). The promise resolves with the sub id, rejects with `Error(reason)`, or with
  `{c:'timeout'}`. The patch skips `heartbeat`, uses a depth guard, calls the original first, copies
  only allow-listed header fields, and **returns `p.then(ok, err ⇒ record; rethrow)`** (not `p`), so an
  app's missing `.catch` still raises `unhandledrejection`.
- **`publish` and `deltaPublish`** without params write straight to the socket and get no ack unless
  asked. Rate-limited first (10/s per client, with a `dropped` count); metadata only (topic,
  correlation id, `bytes` when the data is a string). The data is never serialized.
- **Resubscribes** after a reconnect skip `execute`: `DefaultSubscriptionManager` calls
  `client.send(header)` directly and the ack goes to the original handler. A raw `send` outside
  `execute` between LoggedOn and Resubscribed is recorded as `resub: true`; those subs show status
  `resent`. (An optional one-shot interposer that catches their `processed` ack touches the client's
  internal `subscriptions` map; it ships only if the per-version contract tests pass.)
- **Connection life:** on the first `connect` per instance, add a state listener
  (`addConnectionStateListener` adds, never replaces; states Disconnected 0, Shutdown 1, Connected 2,
  LoggedOn 4, Resubscribed 32), and wrap the server chooser's `reportFailure`/`reportSuccess` (the
  disconnect reason arrives there as `{name: close code, message}`) and the `serverChooser(x)`
  setter. Failover = a different URI from the last connect. `disconnect()` is a life event with
  `byApp: true`. `onError` is rate-limited, cut at "while processing message (" (error 997 embeds the
  raw data message) and capped at 300 characters.
- **Secrets (M4):** the logon header carries `pw`, and URIs may carry `user:password@`. Fields are
  built from an allow-list, never by copying the header; `pw` is never read; URIs keep only
  `ws(s)://host:port/path`; `options`, `filter`, `correlationId` and `reason` go through
  `maskCutToken`, and `key=value` pairs whose key passes `isSecretKey` are masked. The pipeline
  scrubber (04 R7a) still runs afterwards.
- **Ledger per client** (active subs, state, server, last error), registered through the 07 bridge
  with a `snapshot()` handle like the Redux stores. Events before the recorder adopts the queue are
  dropped (03-L11); the recorder snapshots each client at adoption and after every FullSnapshot.
  Bounded: the active subs plus the last 20 failed. The kill flag makes everything pass straight
  through and drops the ledger.

The runtime is `__srAmps(Client)` in `@sr/state-plugin/runtime/amps`; the transform wraps each
`amps` import in a remote (named, namespace and default imports, and `include`d packages).

### Contracts (03, additive only)

```ts
// Sample — not final code. packages/protocol (H0)
export const AmpsCmd = z.enum(['subscribe','delta_subscribe','sow','sow_and_subscribe','sow_and_delta_subscribe',
  'unsubscribe','publish','delta_publish','sow_delete','flush','logon','other']);
const AmpsCmdFields = z.object({ cmd: AmpsCmd, cid: z.string(), subId: z.string().optional(),
  queryId: z.string().optional(), topic: z.string().optional(), filter: z.string().optional(),
  options: z.string().optional(), bookmark: z.string().optional(), batchSize: z.number().int().optional(),
  topN: z.number().int().optional(), orderBy: z.string().optional(), correlationId: z.string().optional(),
  bytes: z.number().int().optional(),          // publish-type: metadata only (M2)
  expectAck: z.boolean() });                   // false: a publish without an ack, so never "pending"
const AmpsSubView = AmpsCmdFields.extend({ since: z.number(),
  status: z.enum(['pending','confirmed','failed','resent']), reason: z.string().optional() });
const client = z.string();                     // '<app>/amps#<n>', like 07's store names
'sr:amps': z.discriminatedUnion('op', [
  z.object({ op: z.literal('snapshot'), client, app: z.string(), name: z.string(), lib: z.string(),
    tested: z.boolean(), state: z.enum(['new','connecting','connected','logged-on','disconnected','closed']),
    server: z.string().optional(), subs: z.array(AmpsSubView),
    lastError: z.object({ t: z.number(), name: z.string(), message: z.string() }).optional() }),
  z.object({ op: z.literal('life'), client, event: z.enum(['connecting','connected','logged-on',
    'disconnected','resubscribed','closed','error']), server: z.string().optional(),
    failover: z.boolean().optional(), code: z.string().optional(), reason: z.string().optional(),
    user: z.string().optional(), byApp: z.boolean().optional() }),
  AmpsCmdFields.extend({ op: z.literal('command'), client, resub: z.boolean().optional(),
    dropped: z.number().int().optional() }),
  z.object({ op: z.literal('ack'), client, cid: z.string(), status: z.enum(['success','failure','timeout']),
    reason: z.string().optional(), ms: z.number(),
    cmd: AmpsCmd.optional(), topic: z.string().optional() }),  // set on failures, so a server row stands alone
]),
'sr:health': z.discriminatedUnion('op', [
  z.object({ op: z.literal('sample'), windowMs: z.number(),
    busyPct: z.number().nullable(),       // Σ LoAF frame durations / window (frames > 50 ms)
    longestMs: z.number().nullable(), longFrames: z.number().int().nullable(),
    inputMs: z.number().nullable(),       // worst interaction duration (Event Timing ≥ 40 ms); 0 = none slow
    heapUsedMB: z.number().nullable(), heapTotalMB: z.number().nullable(),  // performance.memory
    nodes: z.number().int().nullable(),   // rrweb mirror size; null while rrweb is stopped
    hidden: z.boolean().optional(), paused: z.boolean().optional() }),
  z.object({ op: z.literal('freeze'), ms: z.number() }),   // t = frame end, inside the 3 s hold-back
]),
```
- **"Not available" is `null`, never 0** (no LoAF, no `performance.memory`, rrweb stopped).
- **Command ↔ ack:** matched by `(client, cid)`. Snapshot subs carry `cid`, so an ack that lands in a
  later window still matches.
- **`ActionKind`:** add `amps` and `freeze`. **`FidelityReason`:** add `amps-capped` (a note).
- **Config:** `amps: {maxPerRecording: 5000, publishPerSec: 10}` and `health: {enabled: true,
  windowMs: 5000, freezeMs: 1000}`, both `.prefault({})`. **`BridgeMsg`:** a `kind: 'amps'` variant.
- **Query:** `GET /api/sessions/:id/health` returns `HealthSeries` (columnar arrays per recording).
  If the Sessions-list badges land (designer), `counts.ampsFailures` and `counts.freezes`, each
  `.default(0)`.
- H0 checks that the discriminated union builds (every variant has its own `op`).

### Recorder

- `packages/recorder/src/amps/`: the intake. Routes `kind:'amps'` bridge messages, snapshots each
  client's handle, applies `maxPerRecording` with an `amps-capped` note.
- `packages/recorder/src/health/`: the vitals sampler: one 5 s timer; its own LoAF observer (a
  callback only per long frame, independent of the budget's observer); an **Event Timing** observer
  (only slow interactions reach it; a small departure from H3, the standard way to get input
  latency); O(1) reads of `performance.memory` and the mirror size.
- The engine's `stats()` gains `nodes`, read from `record.mirror.idNodeMap.size` (public JS in rrweb
  2.2.2, private in its types), so the read stays inside `recorder-engine` (hard rule 2).
- **Cost:** AMPS, about 10 string copies and one `mark()` per command; nothing per data message.
  Vitals: the timer, two observers that fire only on slow frames or inputs, and O(1) reads.
- **During pauses (open questions 2 and 5):** AMPS keeps logging inside pause bands, like `sr:net`
  (04: "sr:net and state keep flowing"); it passes straight through only when recording is off (kill,
  quota, logout, stop). Vitals keep sampling inside pause and hidden-tab bands, flagged `paused` or
  `hidden`; `nodes` is null while rrweb is stopped.
- **Thresholds (open question 6):** frozen = one frame ≥ 1,000 ms (`freezeMs`, config). Slow =
  `busyPct` ≥ 50 % in a window, a display rule (a replay-UI constant, not config).

### Server

Ingest still walks each batch once (`apps/server/src/ingest/**`):
- `sr:amps`: an ack with `failure` or `timeout`, or a life event `disconnected` (not `byApp`) or
  `error`, becomes an `amps` row: name `subscribe failed` or `disconnected`, summary `topic · reason`
  (≤ 200 characters), `failed: true`.
- `sr:health` `freeze` becomes a `freeze` row (name `frozen 3.2 s`).
- Every sample becomes a `marks` row with `kind 'health'` and a compact JSON array payload (no
  migration: `marks.kind` is TEXT). About 5,800 rows and roughly 300 KB per 8-hour session
  (estimate).
- New route `GET /api/sessions/:id/health` reads those marks by recording.

### Replay UI

- `features/amps/`: the Panel plus `reconstruct.ts` with `ampsAt(steps, upTo, prev)`, built like
  06's `stateAt`: a snapshot replaces that client's view; a command adds a pending sub; an ack
  confirms it or marks it failed; an unsubscribe (or `'all'`) removes it; a life event updates the
  connection; a client stays `partial` until the span's first snapshot.
- Actions: failure rows (`amps`, `freeze`) come from the API and show by default; success rows are
  local rows built from the span (06-L24) behind an "AMPS: all" chip, added in
  `features/actions/rows.ts`.
- `features/health/`: a whole-session heap and node chart from `/health` (one fetch per session);
  the loaded span's 5 s samples from `player/span.ts`; freeze bands from the rows; scrubber markers
  for `amps` and `freeze` rows. The designer picks a tab, a lane or both.

### Replay UI design (dx-ux-designer, 2026-11-11)

**Whole-session data.** The AMPS tab's view at the play head needs subscriptions made long before it
(a subscribe at 09:02 seen at 09:30). The recorder snapshots each client's ledger after every
FullSnapshot, so every loaded window starts complete, like Redux state (03-L11). The Log view works
like Actions (06-L14): failures for the whole session from the API, successes from the loaded span.
The Health charts use `/health` for the whole session.

**Placement.** Both tabs join `ts-logs`: Console · Network · AMPS · Health (Console stays selected).
It is the widest column, and it sits under the Player, so Health's plot lines up with the scrubber
(both use a 52 px gutter and 14 px right padding).

| Tab id | Name (tooltip) | Badge | Close |
|---|---|---|---|
| `amps` | AMPS ("Feed connections, subscriptions and commands") | AMPS failures in the session, red | yes |
| `health` | Health ("Was the app slow or frozen; memory and page size") | frozen frames, red | yes |

#### AMPS tab: `SegmentedControl` [At play head | Log]

```
│ [At play head|Log]  09:24:20 EST · 3 connections · 1 down       [⌕ Topic, filter or sub id  /] │
│ Status         Topic          Filter                               Command                 Options           Sub Since    │
│ ▾ orders · ⏚ Connected · amps-a.nam.example:9007 · since 09:02:15 · blotter-orders-u123             2 active │
│ ✓ Confirmed    orders         /trader = 'u123' AND /status IN (…)  sow_and_subscribe       oof               1   09:02:16 │
│ ✓ Confirmed    fills          /trader = 'u123'                     subscribe               —                 2   09:02:16 │
│ ▾ pricing · ⏚ Connected · amps-a… · since 09:02:15                                     1 active · 1 failed │
│ ✓ Confirmed    pricing_l1     /symbol IN ('AAPL','MSFT','NVDA')    sow_and_subscribe       conflation=250ms  1   09:02:17 │
│ ✖ Failed       pricing_depth  /symbol = 'AAPL'                     subscribe               —                 2   09:23:45 │
│ ▾ positions · ✕ Disconnected · heartbeat timeout · amps-a… · since 09:23:58 (22 s)            1 interrupted │
│ ◌ Interrupted  positions_v2   /book = 'EQ-NA'                      sow_and_delta_subscribe oof,conflation=1s 1   09:02:18 │
```
- One table; each connection is a 24 px group row with a collapse chevron. Topic, filter, command
  and options in monospace; times tabular. A row click expands a key-value view: command id, ack
  type, each ack with time, status and reason, and [Go to 09:23:45]. Under 900 px, Options and Sub id
  move into the expanded view; under 640 px, Command does too.
- **Connection states** (icon + word): Connected (PlugConnected, `--sr-success-icon`); Connecting /
  Reconnecting (attempt 3) (Refresh, dimmed); Disconnected · {reason} (PlugConnectedX,
  `--sr-danger-text`); Closed by the app (PlugConnectedX, dimmed: not a failure). After a failover:
  "amps-b.nam.example:9007 · failed over from amps-a at 09:24:36".

| Subscription status | Icon | Tooltip |
|---|---|---|
| Confirmed | Check | "The server confirmed it at 09:02:16 (38 ms)." |
| Pending | Clock | "Sent at 09:24:38. No ack yet at the play head." |
| Failed (red row) | CircleX | "Refused at 09:23:45: not_entitled." |
| Interrupted | CircleDashed | "The connection is down since 09:23:58, so nothing flows." |
| Resent | Refresh | "Sent again after the reconnect at 09:24:38. The client didn't report its ack." (the `resent` status, M9 / architect) |

A failed subscription stays listed until its connection ends or a retry succeeds; an unsubscribe
removes the row; `sow` queries appear only in the Log.

**Log view.** Chips, all on: Failures · Commands · Lifecycle · Publish; a Select "All connections ▾";
search. One row per command with its ack merged: time · connection · command · topic · filter ·
options · result ("✓ processed · 38 ms", "✖ not_entitled", "◷ no ack yet", "— no ack requested").
Lifecycle rows: connect, logon ("password [stripped]"), disconnect with reason, reconnect, failover,
client error. Publish rows: "publish · orders_cmd · cid c-7f3a · 412 B (body not recorded)". A row
click seeks; Follow (`F`) applies. A divider marks each recording: "Recording 2 · page reloaded
09:38:11 · connections start over". An unknown unsubscribe: "unsubscribe 9 · no matching subscribe
in this recording".

| State | Copy |
|---|---|
| No session | "Open a session to see its AMPS connections and subscriptions." |
| Pilot recording | "This session was recorded before AMPS logging (recorder 1.0.3)." |
| No client | "No AMPS connections in this session. The app didn't open an AMPS client while recording." |
| Before the first connect | "No AMPS connection at 09:02:14. The first one opens at 09:02:15." [Go to 09:02:15] |
| No page open | "No page open at 09:55. Connections start over with each page load." |
| Loading | 6 skeleton rows |
| Error | "Couldn't load the AMPS log (HTTP 500)." [Retry] |
| Inside a pause band (M9) | Gray strip: "Recording paused 09:24:10–09:25:52. AMPS commands were still logged." |

#### Vitals

**Busy lane:** a fourth scrubber lane, "Busy", 10 px, below State (the scrubber grows from 60 to
72 px). One bar per pixel column, its height the highest busy % in that column; `--sr-vital`, slow
windows in `--sr-warning-icon`; a dashed 1 px tick at 50 %. Inside pause bands the bars draw as
normal (H5). Without LoAF the lane uses the `no-state` dashes, tooltip "Busy time isn't available:
Firefox 140 doesn't report long frames."

**Health tab:**
```
│ [Session|10 min]  09:24:58 EST · window 09:24:55–09:25:00                                          │
│ Busy 64 % · Longest frame 410 ms · 9 frames over 50 ms · Input delay 380 ms · Heap 341 / 640 MB · DOM 47,800 │
│ Busy %    ┤- - - -▐█▌- - - - - - 50 % - - - - - - - - -┃- - - - - - - - - - - - - - - - - - - - -│
│           ┤▁▁▂▁▁▂███▅▂▁▁▁▁▁│▁▁▁▁▁▁▁▁┃░ no page ░│▁▁▂▃▃▂▁▁                                       │
│ Heap MB   ┤      ╱‾‾ used ── total ┃     ╱‾           ╱‾                                         │
│ DOM nodes ┤   ╱‾‾‾‾                ┃  ╱‾‾          ╱‾                                            │
│           09:10    09:20   ┃  09:30    09:40   09:50   10:00   10:10                             │
│ Slow and frozen (3)                                                                              │
│ ⧗ 09:24:05  Frozen 3.2 s · input delay 2,950 ms                                    (red, seeks) │
│ ▲ 09:24:00–09:24:15  Slow 15 s · busy up to 82 %                                                 │
```
- Three small multiples on one shared time axis, each ≥ 56 px, growing with the tab. Busy: bars, a
  dashed 50 % line, ⧗ on frozen windows. Heap: "used" a 2 px `--sr-accent-text` line with a 10 %
  wash, "total" a 2 px `--sr-vital` line, legend top right. DOM nodes: a 2 px accent line.
  Gridlines 1 px `--sr-divider`; play head 2 px accent. Pointer: crosshair + a tooltip with every
  value in that window; click seeks. Each recording starts its own line (reloads show a sawtooth);
  "No page open" uses `--sr-ground`. The "Slow and frozen" list is the table view of the charts and
  works from the keyboard.
- Without `performance.memory`: the Heap chart says "Memory isn't available: only Chrome and Edge
  report it." (DOM still draws). No session: "Open a session to see how the app performed."
  Loading: chart skeletons. Error: "Couldn't load app vitals (HTTP 500)." [Retry].

**Thresholds (H6, open question 6):** frozen = any single frame ≥ 1,000 ms (about where users stop
feeling a response). Slow = a 5 s window with busy ≥ 50 % **or** input delay ≥ 500 ms (where Web
Vitals' INP rates "poor"). Back-to-back slow windows merge into one stretch.

#### Actions rows, markers and Sessions badges (open question 3: yes)

| Item | Spec |
|---|---|
| New kinds (72 px column) | `amps` (Broadcast icon): "**positions disconnected** · amps-a · heartbeat timeout", "**subscribe failed** · pricing_depth · not_entitled". `freeze`, labelled "frozen" (Hourglass): "**Frozen 3.2 s** · input delay 2,950 ms". "slow" (Activity): "**Slow 15 s** · busy up to 82 %", a local row built from the samples. |
| Row colour | AMPS failures and frozen rows red; slow rows normal text with a warning-coloured icon. |
| Chips | "AMPS: failures ▾" (Failures by default; All commands and acks). "App: frozen ▾" (Frozen by default; Slow too). |
| Events-lane markers | ■ AMPS failure and ⧗ frozen, 8 px in `--sr-danger`, 24 px hit targets; overlapping markers merge. Tooltip: "09:23:58 ■ AMPS: positions disconnected (heartbeat timeout)". |
| `E` / `Shift+E` | Next or previous problem: error, failed request, AMPS failure or frozen frame. **The button becomes "Next problem (E)"** (leader). |
| Sessions badges | PlugConnectedX + count: "2 AMPS failures (disconnects, failed commands)"; Hourglass + count: "1 frozen screen (a frame of 1 s or more)". Hidden at 0, after ✖. "Errors only" is unchanged (devil fix 4). |

**Tokens:** one new token, `--sr-vital` (light gray-6 `#868e96`, 3.3:1 on white; dark dark-2
`#828282`, 4.0:1 on dark-7) for busy bars and the heap "total" line. Everything else reuses 06's
tokens. New icons (confirmed in the pinned set at H6/H7): PlugConnected, PlugConnectedX, Broadcast,
Hourglass, Activity, CircleDashed, HelpCircle; ■ and ⧗ are filled marker glyphs.

#### Mocks (new files in `docs/design/replay-ui/`; 01–09 stay as they are until v1.1)

| File | Variants |
|---|---|
| `10-amps.html` | `down` (default): play head 09:24:20, AMPS at play head, Actions with AMPS rows, scrubber markers and the Busy lane. `pending`: 09:24:38.5, positions on amps-b, Pending/Resent. `log`: Log view with the failure row expanded. `narrow`: AMPS dragged into `ts-state` at 566 px. |
| `11-health.html` | `now` (default): 09:24:58. `hover`: crosshair frozen at 09:24:06. `zoom`: 10 min view. `firefox`: not available. `max`: Health maximised. |
| `12-amps-health-states.html` | Gallery of every state above, a Sessions row with the new badges, the Layout menu with AMPS and Health, and the layout-migration toast. |

**Scenario data** (hostnames fake, `.example`): orders, pricing and positions each log on to
`amps-a.nam.example:9007` at 09:02:15 as `blotter-<remote>-u123` (passwords stripped), with the four
subscriptions above acked in 22–63 ms. 09:23:45: pricing `subscribe pricing_depth /symbol = 'AAPL'`
refused (`not_entitled`, 18 ms). 09:23:56: orders publishes to `orders_cmd` (412 B), acked
"persisted" in 9 ms. 09:23:58: positions disconnects (heartbeat timeout), retries from 09:24:31,
fails over to `amps-b.nam.example:9007` at 09:24:36 and resubscribes at 09:24:38.1, inside the pause
band. 09:24:05.4–09:24:08.6: one frozen frame of 3.2 s; slow windows 09:24:00–09:24:15 (52 / 82 /
64 %). R2 (09:38:11) and R3 (10:02:44): all three clients reconnect to amps-a and subscribe the same
way. Heap used/total: R1 182 → 352 / 640 MB, R2 176 → 241, R3 179 → 214. DOM nodes: R1 21,400 →
48,900, R2 21,200 → 33,000, R3 21,000 → 27,500. Baseline busy 4–12 %.

### Devil review fixes (binding; 2026-11-11)

These override anything above that disagrees.

**Blockers**
1. **Queue acks and Command-API publishes (M5).** `Client.prototype.ack` calls
   `this.execute(new Command('sow_delete')…)` once per consumed message when `ackBatchSize ≤ 1`
   [src]. So the patched `execute`, **before any other work**, returns the original promise
   untouched for `heartbeat`, for `sow_delete` with a bookmark, and for any call made inside `ack`
   (a depth flag set by a thin `ack` wrapper). Publish commands that go through `execute` take the
   same 10/s limit as `publish()`. H1's zero-work spy test includes a queue reader.
2. **A shared `Client` class (M8).** If a remote shares `amps` as a module-federation singleton (as
   07 Q4 does for `redux`), there is one class for every remote. The prototype patch stays once per
   class, but **the transform's import wrapper is a construct proxy that stamps each new instance
   with its remote's `app` and its `amps` option**; `amps: false` is checked per instance, and client
   ids (`<app>/amps#<n>`) come from the stamp, never from whichever remote patched the class first.
3. **Boot events before adoption (03-L11).** Adoption waits for first render, idle time and the
   config fetch, usually after the app has connected, logged on and subscribed. For `kind: 'amps'`
   the runtime keeps a **ring of the last 200 already-masked events** from before adoption, with
   their original times; the recorder drains it when it adopts the queue. 03-L11 gains this
   exception (additive). Boot failures then get rows, markers and badges like any other.

**Risks taken into the design**
4. **Disconnect noise.** Hidden tabs throttle timers and laptops sleep, so heartbeat timeouts are
   routine. A disconnect becomes an `amps` **failure row** only if no reconnect follows within 30 s
   **or** the tab was visible when it dropped; otherwise it is a lifecycle row only. **`hasErrors`
   keeps its meaning** (03-L15): "Errors only" stays errors + failed requests. A separate
   `hasProblems` filter is open question 7.
5. **Heap is coarse.** Chromium refreshes `performance.memory` at most about every 20 minutes, in
   coarse buckets, cached per renderer (it can survive a reload). `heapUsedMB`/`heapTotalMB` are
   **sent only when they change**; the UI draws a step line labelled "Chrome updates this about every
   20 min" and never implies a per-reload reset.
6. **Freezes LoAF can't see.** `sr:health` samples gain `lateMs`: how late the 5 s tick fired (timer
   drift, every browser). Busy is labelled "time in long frames" (frames over 50 ms), so a steady
   run of 45 ms frames reads low on purpose.
7. **A runtime off switch for the hook (M10).** `config.amps.enabled` (default true) and the limits
   are copied by the loader onto the queue object; the runtime reads the last known values from
   `localStorage` at boot, before the config fetch. Turning it off restores the original methods.
8. **Honest "no AMPS" copy.** Each remote's runtime registers "hook installed, 0 clients", so the UI
   can say "No AMPS connections" only when every remote has the hook; otherwise "orders: AMPS logging
   not installed in this build (plugin older than 1.1, or `amps: false`)". `sr:meta` gains
   `recorderVersion` (additive) for the "recorded before AMPS logging" copy.
9. **Caps and gaps.** Ledger snapshots continue after `amps-capped`. After the cap, or inside a
   `missing-batches` band, the AMPS tab shows a "partial" strip. `amps-capped` is a 15th
   `FidelityReason`: 06's bands table and U5's test grow in v1.1.
10. **False `resent` rows.** The publish store's replay and deferred `execute` sends also use raw
    `send` in the LoggedOn → Resubscribed window. Only subscribe-family headers count as `resent`;
    better, wrap `DefaultSubscriptionManager.prototype.resubscribe` when present.
11. **Secrets (M4).** `maskCutToken` runs after **every** cut (the 300-character `onError` cut
    included). If the 997 marker ("while processing message (") isn't found, the whole error text is
    dropped. In v1.1, 04's console formatter applies the same 997 cut, so an app's own
    `console.error(err)` can't carry an AMPS data message either (D41).
12. **Memory.** The ledger drops a client's handle when the client closes (`disconnect()` or
    Shutdown), so apps that make a client per screen don't grow memory (01's "no upward trend").
13. **Returning `p.then(...)`** is safe with the native `Promise` the bundle uses, provided: never
    wrap with `Promise.resolve` or `async`; the recording call sits in try/catch so a bug can't
    replace the rejection reason; and the timeout shape is `{commandId, message: {c: 'timeout'}}`.

**Nits:** the scrubber is 60 px in 06 and becomes 72 px with the Busy lane. "Unconfirmed" can't
happen for a subscription (`execute` always asks for `processed`): removed. "slow" is a local UI
row built from samples, not an `ActionKind`. `BridgeMsg` becoming a union updates the R6 and 07
types in v1.1. `amps` versions are semver prereleases, so module-federation `^5.3.4` ranges won't
match them (H2 documents exact `requiredVersion`s).

### Changes to other plans (apply when plan 10 is approved)

- **01 D41 (v1.1):** "No AMPS data messages or heartbeats; AMPS commands, acks and connection life
  are recorded through the build plugin's client hook (10)."
- **AGENTS.md rule 5:** add "Command-level hooks (fetch/XHR, AMPS) keep reporting during pause bands,
  like `sr:net`."
- **06 (v1.1):** panel inventory gains `amps` and `health` (home `ts-logs`); the default JSON adds
  both tabs to `ts-logs`; `sr.layout` becomes `v: 2` and **a v1 layout is kept**: the two tabs join
  `ts-logs` if it exists, else they stay closed, with a one-time toast "New panels: AMPS and Health,
  next to Console." [Show AMPS]; the Layout menu lists AMPS and Health after Network; the scrubber
  gains the Busy lane (60 → 72 px) and the legend ■, ⧗ and Busy; the shortcuts sheet says `E` = "Next
  problem: error, failed request, AMPS failure or frozen screen"; Visual system adds `--sr-vital`
  and the new icons; the Mocks table adds 10–12. U3b's badges, U5's markers and U6a's chips extend
  in v1.1 (H6, H7).
- **03/05:** `counts.ampsFailures` and `counts.freezes` (`.default(0)`); `hasErrors` keeps its meaning (03-L15).
- **03:** L11's pre-adoption ring for `kind: 'amps'` (devil fix 3); `sr:meta.recorderVersion`;
  `config.amps.enabled` (M10); `lateMs` in `sr:health` samples; `amps-capped` as a 15th reason.
- **04:** the console formatter applies the 997 cut (devil fix 11).
- **07:** the new runtime entry and transform. **08:** an integration step: upgrade the plugin, plus
  a dry-run check per remote.
- **Now, in the pilot (04 R6):** the recorder ignores bridge messages whose `kind` isn't `redux`, so
  a v1.1 plugin is safe next to a pilot recorder (applied 2026-11-11).

## Acceptance (draft)

- [ ] Every AMPS client any remote opens is captured: connect (server host), logon (credentials stripped), disconnect with reason, reconnect, failover, client errors.
- [ ] Every command the UI sends (`subscribe`, `delta_subscribe`, `sow`, `sow_and_subscribe`, `sow_and_delta_subscribe`, `unsubscribe`, and publish-type metadata) is recorded with topic, filter, options and sub id, and linked to its ack (success or failure, with reason).
- [ ] No data message, heartbeat or publish body is ever recorded; no password or token appears in any recorded logon (a secrets test).
- [ ] No work per data message: a P1-style run at a synthetic 5,000 messages/s (plus a queue reader acking each message) shows main-thread time with the hook on within 0.5 % of wall-clock of the hook off; a spy on the patched methods counts zero calls per data message.
- [ ] Hook on/off equivalence: same resolve values, rejection reasons, `unhandledrejection` counts and error-handler calls on the pilot apps' AMPS flows.
- [ ] Cases: a queue reader; a Command-API publish; a kill (and `amps.enabled: false`) mid-session; a shared `Client` class with one remote opted out; a v1.1 plugin next to a pilot recorder; the AMPS and Health tabs on pilot-era sessions; boot connect, logon and a failed boot subscribe all appear (pre-adoption ring).
- [ ] Replay: the AMPS tab shows connections and active subscriptions at any position; failures show as Actions rows (on by default) and scrubber markers.
- [ ] Vitals: one sample per 5 s window with busy %, longest frame, frames over 50 ms, worst input delay, heap used/total (Chrome) and DOM node count; a frozen stretch (one frame ≥ 1 s) is visible in the replay next to the screen; heap and node-count trends show across the whole session.
- [ ] Vitals cost: sampling adds no per-event work and never walks the DOM; without `performance.memory` or LoAF (non-Chromium) the sample says "not available" instead of 0.
- [ ] AMPS tab: every connection state and subscription status (Confirmed, Pending, Failed, Interrupted, Resent, Unconfirmed) renders as specified; the Log merges each ack into its command row; publish rows never show a body.
- [ ] Health: charts show "not available", never 0; the Health plot lines up with the scrubber in the default layout; the "Slow and frozen" list matches the charts and works from the keyboard.
- [ ] Sessions badges count AMPS failures (sustained or visible-tab disconnects only, devil fix 4) and frozen screens; "Errors only" is unchanged; `E` / `Shift+E` reach AMPS failures and frozen rows ("Next problem").
- [ ] A saved v1 layout gains the AMPS and Health tabs in `ts-logs` (or keeps them closed) with the one-time toast; nothing else in the layout moves.
- [ ] Mocks 10–12 and the built panels pass axe (`wcag22aa`) in both themes.
- [ ] Awkward states: reconnect with resubscribe; failover; a command with no ack yet (pending); unsubscribe of an unknown sub id; two remotes on the same server; a page reload (a new recording, connections start over); commands during a recording pause band.

## Tasks

Commands for tier 1: the touched packages' `bunx tsc --noEmit -p <pkg>` and `bun test <pkg>`
(`apps/replay-ui` with its compiler preload, 06). File names marked † are checked against the
pilot's R/PL/U task files before handoff.

- [ ] **H0 Contracts** — owns: `packages/protocol/src/{events,config,query,bridge}.ts`, `packages/protocol/fixtures/**` — depends on: none — done when: golden fixtures for every `sr:amps` op and both `sr:health` ops parse; the discriminated unions build; old fixtures still parse; tier 1 passes.
- [ ] **H1 AMPS runtime** — owns: `packages/state-plugin/src/runtime/amps/**`, `packages/state-plugin/{package.json,build.ts}`, the root `bun.lock` (rule 7) — depends on: H0 — done when: tests against real `amps` 5.3.4 with a fake socket cover connect, logon, ack success/failure/timeout (the real `{commandId, message:{c:'timeout'}}` shape), publish metadata through both `publish()` and `execute`, disconnect, failover, resubscribe (subscribe-family only), the kill flag and `amps.enabled`, the pre-adoption ring, the ledger snapshot and handle release on close, the construct-proxy stamp with one remote opted out of a shared class, **a spy showing zero calls across 10,000 data frames including a queue reader**, a hook on/off equivalence test (same resolve values, rejection reasons, `unhandledrejection` counts and error-handler calls), the secrets test (`pw`, URI userinfo, the 997 text and its missing-marker case), and a size ≤ 2 KB min+gzip.
- [ ] **H2 AMPS transform** — owns: `packages/state-plugin/src/transform/amps.ts`, `src/{options,plugin}.ts`† — depends on: H1 — done when: golden tests cover named, namespace and default imports, `include`d packages, `amps: false`, and the `require` warning, on both bundlers.
- [ ] **H3 Recorder AMPS intake** — owns: `packages/recorder/src/amps/**`, the queue-router file in `src/state/`† — depends on: H0 — done when: tests cover routing, snapshots at adoption and after FullSnapshot, the cap and its `amps-capped` note, and logging during a pause.
- [ ] **H4 Vitals sampler** — owns: `packages/recorder/src/health/**`, `packages/recorder-engine/src/record/{engine,types}.ts`, the recorder start-up file† — depends on: H3 — done when: fake-observer tests cover the window maths, the freeze event, `null` without LoAF or memory, and the paused/hidden flags.
- [ ] **H5 Server** — owns: `apps/server/src/ingest/**`, `apps/server/src/api/{health,query,index}.ts`, `apps/server/src/store/**` (the count columns), `apps/server/src/db/catalog.ts`, `apps/server/src/config/**`, `apps/server/src/jobs/rebuild.ts` (its marks rollup skips health marks), their tests — depends on: H0 — done when: tests cover the `amps` row rules (the disconnect noise rule), `freeze` rows, health marks, the `/health` route, the counts, and `hasErrors` unchanged. Not in parallel with 09's AN0/AN1 (shared files).
- [ ] **H6 UI AMPS, rows and badges** — owns: `apps/replay-ui/src/features/amps/**`, `src/features/actions/rows.ts`, `src/api/**` and `mock/**` (the `/health` client and fixtures too), `src/features/player/{Transport,Legend,LegendPopover}.tsx` ("Next problem", the new legend rows), the panel registry and tab badges in `src/features/workspace/`, the Sessions badge file in `src/features/sessions/`†, the `E` targets in `src/features/player/shortcuts.ts` — depends on: H0 — done when: `ampsAt` tests cover every awkward state in Acceptance (including the partial strip after a cap or gap); the `amps` / `freeze` / slow rows, chips, badges and "Next problem" targets are unit-tested; the tab matches mock 10.
- [ ] **H7 UI Health and the Busy lane** — owns: `apps/replay-ui/src/features/health/**`, `src/features/player/{Scrubber,Bands}.tsx` (the Busy lane and markers), the `sr.layout` v2 migration file in `src/features/workspace/`† — depends on: H5, H6 — done when: fixtures render, including "not available", heap as a step line and `lateMs`; the v1 → v2 layout migration is unit-tested; the view matches mock 11.
- [ ] **H8 Gate** — owns: `e2e/health/**`, `fixtures/apps/amps-*/**`, a fake AMPS WebSocket server in `fixtures/amps-server/**` (real AMPS runs only in WSL), the root `package.json` workspaces entry for them (rule 8) — depends on: all — done when: the specs are written; they run at the gate, including the main-thread comparison in Acceptance.

H1 ∥ H3 ∥ H5 can run together, then H2 ∥ H4 ∥ H6, then H7, then H8 (at most 3 agents at once; not alongside 09's AN0/AN1).

## Risks (draft)

| Risk | Mitigation |
|---|---|
| Each remote bundles its own copy and version of the `amps` client, so a hook misses some. | The architect's hook choice must cover every copy; an acceptance check per remote in the dry run. |
| The client API or wire format differs between versions. | Pin the supported versions; contract tests per version. |
| A command whose ack was never requested looks "pending" forever. | `expectAck: false` for publishes without an ack type; `execute` always asks for `processed` [src]. |
| Resubscribes after a reconnect skip `execute`, so their acks aren't seen. | Recorded as `resub: true` with status `resent`; the optional interposer ships only if per-version contract tests pass. |
| Returning a chained promise from `execute` shifts the app's microtask timing by one tick. | Contract tests on the pilot apps' AMPS flows; the kill flag restores the originals. |
| `amps` versions drift across remotes. | A contract test per supported version; Q4 lists the versions in use. |
| LoAF and `performance.memory` are Chromium-only; Event Timing is missing in Safari. | `null` = "not available"; the pilot runs on Chrome. |
| About 5,800 health marks per 8-hour session. | Thin them if the pilot shows that's too many. |
| Filters can carry account or book ids. | Recorded unmasked on purpose (D18), like the rest of the MVP. |
| `performance.memory` is non-standard and coarse (Chrome quantises it), so small leaks don't show. | Use it for day-long trends only; the precise API needs cross-origin isolation, which the apps don't have. |
| Vitals stop when recording pauses, which is exactly when the app is busiest. | The architect decides whether sampling continues inside pause bands (it is cheap). |

## Open questions

1. **Hook:** answered: (a), the build plugin, on by default (M8).
2. **AMPS logging while paused:** answered: yes, like `sr:net` (M9).
3. **Sessions badges:** answered: yes, AMPS failures and frozen screens (designer); "Errors only" is unchanged (devil fix 4).
4. Which `amps` client library and versions do the remotes use? (User to check in the real workspace.)
5. **Vitals while paused:** answered: yes, flagged (H5).
7. **A `hasProblems` Sessions filter** (AMPS failures, frozen screens) next to "Errors only"? Not in v1.1 unless the user asks (devil fix 4).
6. **Thresholds:** frozen = a frame ≥ 1 s; slow = busy ≥ 50 % or input delay ≥ 500 ms in a 5 s window, adjacent windows merged (H6; designer). The user may still adjust them.

## Log

- 2026-11-11 — Drafted by the leader from the user's AMPS brainstorm: feed health and active subscriptions (topic, filter); each remote has its own client; v1.1; browser capture of commands and acks, never data (M1–M7). A server-side `/AMPS/ClientStatus` + admin REST route was considered and set aside.
- 2026-11-11 — App vitals added (user): slow or frozen, memory growth, DOM size growth; v1.1 in this plan (H1–H4). File renamed from `10-amps.md`.
- 2026-11-11 — Architect and designer merged (leader). Hook: the build plugin patches `Client.prototype`, on by default (M8, user); AMPS logging and vitals continue in pause bands (M9, H5); `sr:amps` / `sr:health` contracts, recorder, server and UI flow; tasks H0–H8. Design: AMPS and Health tabs in `ts-logs`, the Busy lane, Actions kinds, markers and Sessions badges, thresholds (H6), `--sr-vital`, mocks 10–12. Leader calls: "Next problem (E)"; "Errors only" counts AMPS failures and frozen screens. 04 R6 now ignores non-Redux bridge messages.
- 2026-11-11 — Devil review merged (leader). Blockers fixed: queue acks and Command-API publishes skip or are limited in the patched `execute`; a construct proxy stamps each instance's remote and opt-out for shared classes; a 200-event pre-adoption ring (03-L11 exception) keeps boot events. Risks: the disconnect noise rule and `hasErrors` unchanged (reverses the leader's "Errors only" call); heap sent only on change and drawn as a 20-minute step line; `lateMs` timer drift; the `amps.enabled` runtime switch (M10); honest "no AMPS" copy and `recorderVersion`; a partial strip after caps or gaps; subscribe-family-only `resent`; secrets masked after every cut and the 997 cut in the console formatter; handle release on close; the `p.then` conditions. Tasks' `owns:` widened; Acceptance gains a tolerance, an on/off equivalence test and more cases.
