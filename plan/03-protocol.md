# 03 — Protocol (shared contracts)
Status: draft · Size: small · Parent: [01-session-replay.md](01-session-replay.md)

## Goal

One package, `packages/protocol`, that defines every shape crossing a boundary: browser ↔ server,
app ↔ recorder, server ↔ replay UI. With these contracts fixed first, the recorder, server, replay
UI and state plugin can be built **in parallel by different agents** against the same types, mocks
and golden fixtures. The package has three entries: `@sr/protocol` (zod schemas, types and helpers;
its only runtime dependency is `zod`), `@sr/protocol/publish` (the bridge helper, with no
imports at all), and `@sr/protocol/secrets` (`isSecretKey` and `maskCutToken`, with no imports;
used by the recorder's console formatter and state serializer and by the server, D43).

## Decisions

Inherits D2, D5, D11, D16, D20, D22, D29, D33, D36 from the parent plan. Local decisions:

| # | Decision | Why |
|---|---|---|
| L1 | Our events are **rrweb custom events** (`type: 5`) whose `data.tag` starts with `sr:`. The engine stamps and inserts them itself; it never uses `record.addCustomEvent`, which re-stamps (D2). | rrweb's Replayer keeps working on the mixed stream and ignores tags it doesn't know. |
| L2 | Every event has a **stream position** `{ recordingId, seq, idx }`, where `idx` is its index in the batch. Seeking to an action uses its position, not its time (D16). | Positions are unique and ordered even when many events share a millisecond. |
| L3 | Protocol version `v: 1` on every batch, bridge message and config. Changes are **additive only**: new tags or fields, never renamed or removed ones. The replay UI ignores unknown tags. | Old recordings must replay after upgrades (golden-recording tests). |
| L4 | **`zod` schemas are the source of truth.** TypeScript types come from `z.infer`, and the server validates every request with the same schemas. zod 4 form throughout: `z.record(z.string(), X)`. | One definition and no drift; Hono's validator takes zod directly. zod 4.6's one-argument `z.record(X)` passes at runtime but fails the type check. |
| L5 | JSON inside; gzip on the wire. A batch body is `gzip` (`Content-Encoding: gzip`) or plain JSON. The `pagehide` tail sends plain JSON, because `CompressionStream` is async. | Simple and debuggable; gzip makes the size fine. |
| L6 | The package scope is `@sr/*` in this baseline. The real workspace may rename it (see [08-integration.md](08-integration.md)). | |
| L7 | **`sentAt` travels in the `X-SR-Sent-At` header**, not in the body. | The recorder encodes and gzips a batch once and resends the same bytes on every retry (04-L9). A body field that changes per attempt would force a re-encode. |
| L8 | **Batch identity = SHA-256 of the decoded body bytes** (the exact JSON text the recorder encoded once). The server **stores the gzip bytes as they arrived**; it gzips only the plain `pagehide` tail. Integrity on read is a hash of the stored bytes, so reads never inflate. | The server never parses, re-stringifies and re-gzips a batch it already has. A gzip retry and a plain tail of the same batch still decode to the same bytes (architect A4). |
| L9 | **Positions in URLs and query strings are `recordingId:seq:idx`** (`posKey`). Positions in different recordings are ordered by the recording order in `SessionDetail.recordings`. **Every range is half-open:** `from`/`after` as stated per route, `to` always exclusive. | One readable form for deep links, cursors and query parameters, and one rule for every range (devil X25). |
| L10 | **`@sr/protocol/publish` has no imports.** App bundles (through the state plugin's runtime) import only this entry; the recorder uses `import type` only. | zod must never ship into the apps or the recorder (07-L5). |
| L11 | **Before a recorder adopts the queue, `publish` keeps only `register` messages and drops actions.** Each `register` carries the store's handle, so at start (and after every full snapshot) the recorder reads `getState()` itself. | The queue stays bounded by the number of stores, with no folding logic, and every screen keyframe gets a matching state snapshot (architect A9; devil X12, X13). |
| L12 | **Every `t` on the wire and in query DTOs is raw client time** (`Date.now()` ms in the recorded browser), the same clock rrweb uses. `SessionDetail` gives one `clockOffsetMs` per recording; the UI adds it only for display and seeks by raw `t`. | A per-chunk skew correction jitters with network latency and isn't monotonic; mixing corrected and raw times would put markers minutes off (devil X2). |
| L13 | **A write key per recording.** The recorder makes a random key per recording, keeps it in memory, in sessionStorage and in each queued batch row (another tab may upload leftovers), and sends it as `X-SR-Write-Key`. The server stores its hash with seq 0 (if seq 0 never arrives, with the first stored batch); later batches of that recording must match. It is not an identity token. | Session ids are visible in the session list, so without it anyone on the network could append batches to a colleague's live recording (devil X16). |
| L14 | **`/api/*` requires the header `X-SR-UI: 1`.** | The replay iframe can request same-origin images and styles, but it can't add headers, so a forged recording can't call the API with the viewer's cookie (devil X14). |
| L15 | **Console lines are `sr:console` events** (D43).<br>• **Action rows:** only `error` and `warn` lines become server action rows (`name` = the level, `summary` = the message cut to 200 characters, plus `count`). `info`, `log` and `debug` stay in the chunks and reach the action list as local rows (06-L14).<br>• **Counts:** `counts.errors` stays the count of `sr:error` events. The new `counts.consoleErrors` counts `console.error` lines not marked `same`.<br>• **`same: true`** marks an event whose Error object the other path already reported.<br>• **`dropped`** counts lines the rate limit dropped since the last line.<br>• **Cap:** a recording stops capturing console lines at `maxPerRecording` and emits a `console-capped` note. | Keeps the sparse action index small. Keeps `counts.errors` meaning what it meant, so the change stays additive (L3). Stops one React error from counting twice (devil R2–R4). |

## Design

### How the data flows

```mermaid
sequenceDiagram
  participant App as Host + mini-apps
  participant Rec as Recorder (browser)
  participant Srv as Server (region)
  participant UI as Replay UI
  Rec->>Srv: GET /sr/config?app=blotter&user=u123
  Srv-->>Rec: RecorderConfig {enabled, rateCaps, ...}
  App->>Rec: Redux actions via window.__SR_BRIDGE_Q__
  Rec->>Rec: rrweb events + sr:* events, stamped at capture
  loop every 5 s, or within 1 s of a user action (04-L8)
    Rec->>Srv: POST /sr/ingest (IngestBatch, gzip, X-SR-Sent-At, X-SR-Write-Key)
    Srv-->>Rec: 204 after commit (X-SR-Config-Version)
  end
  opt asset cache on (D33)
    Rec->>Srv: POST /sr/assets/missing {hashes}
    Rec->>Srv: PUT /sr/assets/:sha256 (only the missing ones)
  end
  UI->>Srv: GET /api/sessions?user=u123&day=20261110 (X-SR-UI: 1 on every /api call)
  UI->>Srv: POST /api/access {sessionId, name, reason}
  UI->>Srv: GET /api/sessions/:id (detail: recordings, snapshots, bands)
  UI->>Srv: GET /api/sessions/:id/actions?kinds=click,input&after=r1:0:3
  UI->>Srv: GET /api/sessions/:id/chunks?from=r1:0:0&to=r1:40:0 (stored gzip, framed)
  UI->>UI: inflate → ReplayEngine.load(chunks) → rrweb Replayer (sandboxed iframe)
```

### Events (`src/events.ts`)

```ts
// Sample — the shape to build, not final code.
import { z } from 'zod';

export const StreamPos = z.object({
  recordingId: z.string(),        // fresh per page load (D29)
  seq: z.number().int().min(0),   // batch number within the recording
  idx: z.number().int().min(0),   // event index within the batch
});

export const ConsoleLevel = z.enum(['error', 'warn', 'info', 'log', 'debug']); // D43

// Our custom event tags. rrweb's own event types (0–6) pass through untouched.
export const SrTag = z.enum([
  'sr:click', 'sr:input', 'sr:nav', 'sr:error', 'sr:report',
  'sr:state', 'sr:fidelity', 'sr:hotspot', 'sr:asset', 'sr:meta', 'sr:rate-caps',
  'sr:net', 'sr:redacted', 'sr:close', 'sr:console',
]);

export const FidelityReason = z.enum([
  'pause-budget',      // D8: the self-budget paused recording
  'hidden-tab',        // the tab stayed hidden past the limit, so recording stopped (04)
  'popout',            // D34: popout open, not recorded
  'snapshot-slow',     // checkpoint interval stretched (devil M10)
  'missing-batches',   // server-made: a seq gap; or a recorder-side drop
  'quota',             // daily quota hit
  'pipeline-fallback', // the worker failed; main-thread pipeline took over (D11)
  'buffer-overflow',   // the upload queue cap (50 MB / 72 h) dropped the oldest batches
  'no-state',          // a declared remote with no store captured
  'state-capped',      // a store key was over the size cap and replaced by a placeholder (04-L14)
  'chunk-unreadable',  // server-made: a chunk failed its hash check or its key was shredded
  'no-clean-close',    // server-made: the recording ended without an sr:close
  'caps-off',          // rate caps are configured but the gate patch is missing, so caps are off (04)
  'console-capped',    // the recording hit console.maxPerRecording; later lines aren't recorded (D43)
]);

const Rec = <T extends z.ZodTypeAny>(v: T) => z.record(z.string(), v);

/** Stands in for a state value that wasn't recorded (devil X3, X11). */
export const NotRecorded = z.object({ $sr: z.literal('not-recorded'), why: z.enum(['denied', 'capped']),
                                      bytes: z.number().int().optional() });

export const SrPayload = {
  'sr:click':    z.object({ label: z.string(), selector: z.string(),
                            app: z.string().optional() }),                   // reserved: no mini-app filter in the MVP (01 Q27)
  'sr:input':    z.object({ field: z.string(), value: z.string(),          // secrets → '****' (D18)
                            app: z.string().optional() }),
  'sr:nav':      z.object({ url: z.string() }),                              // token params stripped
  'sr:error':    z.object({ message: z.string(), stack: z.string().optional(),
                            count: z.number().int().optional(),               // repeats folded (D43)
                            dropped: z.number().int().optional(), same: z.boolean().optional() }), // L15
  'sr:console':  z.object({ level: ConsoleLevel, message: z.string(),       // bounded formatter, ≤ maxChars (04)
                            stack: z.string().optional(), count: z.number().int().optional(),
                            dropped: z.number().int().optional(), same: z.boolean().optional() }), // D43, L15
  'sr:report':   z.object({ note: z.string().optional() }),
  'sr:state':    z.object({
    store: z.string(), kind: z.literal('redux'),
    op: z.enum(['snapshot', 'action']),
    type: z.string().optional(),                                             // op = action: the action type
    state: z.unknown().optional(),                                           // op = snapshot; keys may hold NotRecorded
    changes: Rec(z.unknown()).optional(),                                    // op = action: changed top-level keys
    removed: z.array(z.string()).optional(),                                 // op = action: deleted top-level keys
  }),
  'sr:fidelity': z.object({ reason: FidelityReason, start: z.boolean(), detail: z.string().optional() }),
  'sr:hotspot':  z.object({ area: z.string(), remote: z.string().optional(),
                            mutationsPerSec: z.number(), pausedMs: z.number() }),
  'sr:asset':    z.object({ url: z.string(), sha256: z.string(), type: z.string() }),   // D33
  'sr:meta':     z.object({
    app: z.string(), appVersion: z.string().optional(),
    remotes: Rec(z.string()).optional(),                                     // remote name → entry URL
    libs: Rec(z.string()).optional(), pipeline: z.enum(['main', 'worker']),
    userAgent: z.string(), viewport: z.object({ w: z.number(), h: z.number() }),
    tz: z.string().optional(),                                               // IANA zone, e.g. 'Asia/Tokyo' (D42)
    tzOffsetMin: z.number().optional(),                                      // UTC offset at recording start
  }),
  'sr:rate-caps': z.object({ configVersion: z.string(), caps: Rec(Rec(z.number())) }), // D36 legend
  'sr:net':      z.object({ method: z.string(), url: z.string(),            // token params stripped
                            status: z.number().int(),                        // 0 = network error
                            ms: z.number() }),                               // from the engine's own fetch/XHR wrapper (04-L16)
  'sr:redacted': z.object({ jwt: z.number().int(), bearer: z.number().int(), basic: z.number().int(),
                            userinfo: z.number().int().optional(),            // scheme://user:password@ (D43)
                            urlParams: z.number().int() }),                  // scrubber counts per batch
  'sr:close':    z.object({ reason: z.enum(['pagehide', 'logout', 'user-switch', 'kill', 'stopped']) }), // clean end (devil X19)
} as const;
```

**Bands and notes.** A band is a `start: true` event plus a later `start: false` event with the
same reason. A note is a single `start: true` event with no end. The server adds the
server-made reasons to `SessionDetail` itself; they never appear in the stream.

| Kind | Reasons | Replay UI (06) |
|---|---|---|
| Gap band (the screen is incomplete) | `pause-budget`, `hidden-tab`, `popout`, `quota`, `buffer-overflow` | hatched band, banner while the play head is inside |
| Gap band that runs **to the next full snapshot** (the screen is unknown until then) | `missing-batches`, `chunk-unreadable` | hatched band; the engine shows "screen unknown" instead of applying incremental events (04) |
| Band, screen still complete | `snapshot-slow`; `no-state` on the state lane | thin band |
| Note | `pipeline-fallback`, `state-capped`, `no-clean-close`, `caps-off`, `console-capped` | a tick on the scrubber |

**When `no-state` starts and ends.** 10 s after recording starts, the recorder opens a `no-state`
band for each remote named in `sr:meta.remotes` that has no registered store with that `app`. The
band closes when such a store registers.

An `sr:*` event on the wire is an rrweb custom event:

```json
{ "type": 5, "timestamp": 1762743000123,
  "data": { "tag": "sr:state",
            "payload": { "store": "blotter/redux#1", "kind": "redux", "op": "action",
                         "type": "orders/placed", "changes": { "orders": { "...": "..." } },
                         "removed": ["draftTicket"] } } }
```

### Ingest batch (`src/ingest.ts`)

```ts
// Sample — the shape to build, not final code.
export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const UserId = z.string().regex(/^[A-Za-z0-9_.@-]{1,128}$/); // client-asserted in the MVP (D20)

export const IngestBatch = z.object({
  v: z.literal(1),
  sessionId: Id,
  recordingId: Id,
  seq: z.number().int().min(0),
  userId: UserId,
  app: z.string(),
  events: z.array(z.unknown()).min(1),                  // rrweb events + sr:* events
});
// Not in the body: sentAt and the write key. They travel in headers (L7, L13).
```

`POST /sr/ingest` request headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `Content-Encoding` | `gzip`, or absent for the plain `pagehide` tail (L5) |
| `X-SR-Sent-At` | client `Date.now()` at this attempt, in ms. Required: the server derives `clockOffsetMs` from `receivedAt − sentAt` (D31, L12) |
| `X-SR-Write-Key` | the recording's write key (L13). Required |

The server hashes the decoded body bytes for identity and stores the gzip bytes (L8). Responses:

| Status | Body | Meaning | What the recorder does |
|---|---|---|---|
| 204 | — | Committed (D31: acked only after commit). Also a same-`seq` batch with a **different** hash: stored as a flagged duplicate, never dropped (05) | Delete the batch from IndexedDB |
| 208 | — | Duplicate `(recordingId, seq)` with the same hash (a retry) | Delete the batch |
| 400 | `{reason:'invalid'\|'expired'}` | Fails the schema, a header is missing, or older than retention | Drop it; `missing-batches` band; next checkpoint now |
| 403 | `{reason:'user-mismatch'\|'write-key'}` | The session is bound to another userId, or the write key doesn't match | Drop it; start a new session **and** a new recording |
| 413 | — | Body over the limit (sized from P1's snapshot sizes; starts at 4 MiB), or gunzip output over 16 MiB | Drop it; `missing-batches` band (the recorder splits batches before this, 04) |
| 429 | `{reason:'rate'\|'quota'}` + `Retry-After` | Rate limit, or the daily quota (both keyed on userId + IP) | `rate`: wait `Retry-After`. `quota`: stop until UTC midnight with a `quota` band |
| 503 | `Retry-After` | Server backpressure (writer queue full, low disk) | Keep it; retry after `Retry-After` |
| other 5xx / network | — | Not stored | Keep it; retry with backoff |

Every 2xx response carries `X-SR-Config-Version`. If it differs from the cached config, the
recorder re-fetches the config. That's how the kill switch and rate caps reach running tabs (D22).

**Cadence and limits.** The recorder seals a batch every 5 s or at 1 MiB raw, within 1 s after a
user action, and when the tab hides or closes; one upload in flight per tab (04-L8). The server's
limits and quota are derived from P1's measured bytes per minute (05-L11); the quota is a fuse at
about 3× a busy user's day.

### Assets (`src/assets.ts`, D33, behind `assetCache.enabled`)

```ts
// Sample — the shape to build, not final code.
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const AssetMissingReq = z.object({ v: z.literal(1), hashes: z.array(Sha256).min(1).max(100) });
export const AssetMissingRes = z.object({ missing: z.array(Sha256) });
```

| Route | Body | Answer |
|---|---|---|
| `POST /sr/assets/missing` | `AssetMissingReq` | `AssetMissingRes`: the hashes the server doesn't have |
| `PUT /sr/assets/:sha256` | the raw bytes; `Content-Type: image/*` or `font/*`; at most 2 MB | 204; 400 if the bytes don't hash to `:sha256`; 413 if too big |
| `GET /assets/:sha256` | — | the cached asset, served with 05-L14's headers (replay UI port only) |

### Recorder config (`src/config.ts`)

This is what the browser receives: the server has already resolved the allow-list for this user.
The file the server reads (a ConfigMap, 05-L8) has its own format, owned by 05.

```ts
// Sample — the shape to build, not final code.
export const RateCaps = z.record(z.string(), z.record(z.string(), z.number().positive())); // gridId → colId → max states/s (D36)

export const RecorderConfig = z.object({
  v: z.literal(1),
  version: z.string(),                        // bumps on every config change (logged)
  enabled: z.boolean(),                       // allow-list result for this user (D22)
  killSwitch: z.boolean(),
  checkpointMinutes: z.number().default(12),
  checkpointMutations: z.number().int().default(200_000), // also checkpoint after this many mutation records (A5)
  budget: z.object({ cpuPct: z.number(), longFrameMs: z.number(), resumeAfterMs: z.number() }),
  rateCaps: RateCaps.default({}),
  assetCache: z.object({ enabled: z.boolean(), allow: z.array(z.string()) }), // D33
  pipeline: z.enum(['main', 'worker']).default('main'),                      // D11
  console: z.object({                                                      // D43; each field has its own default
    levels: z.array(ConsoleLevel).default(['error', 'warn']),
    maxPerSec: z.number().int().min(1).max(50).default(10),                // per bucket: error+warn, and info+log+debug
    maxChars: z.number().int().min(200).max(8000).default(2000),
    maxPerRecording: z.number().int().min(100).default(2000),
  }).prefault({}),                                                          // zod 4: .prefault parses {}, so the inner defaults apply
});
```

Sample served config for the pilot desk:

```json
{ "v": 1, "version": "2026-11-10.3", "enabled": true, "killSwitch": false,
  "checkpointMinutes": 12, "checkpointMutations": 200000,
  "budget": { "cpuPct": 3, "longFrameMs": 50, "resumeAfterMs": 10000 },
  "rateCaps": { "positions": { "bid": 2, "ask": 2, "mid": 2 } },
  "assetCache": { "enabled": false, "allow": ["/static/img/", "https://fonts.corp.example/"] },
  "console": { "levels": ["error", "warn"], "maxPerSec": 10, "maxChars": 2000, "maxPerRecording": 2000 },
  "pipeline": "main" }
```

### State bridge (`src/bridge.ts` and `src/publish.ts`)

```ts
// Sample — the shape to build, not final code. src/bridge.ts
export const BridgeMsg = z.object({
  v: z.literal(1),
  store: z.string(),                    // '<app>/redux#<n>' (07-L9); the recorder de-duplicates clashes
  kind: z.literal('redux'),             // MVP: plain Redux only (D39)
  op: z.enum(['register', 'action']),
  type: z.string().optional(),          // action: the action type
  changes: z.record(z.string(), z.unknown()).optional(),  // action: changed top-level keys ({ $root } if not an object)
  removed: z.array(z.string()).optional(),                // action: deleted top-level keys
  meta: z.object({ app: z.string(), lib: z.string(),      // register: 'redux@4.2.1'
                   deny: z.array(z.string()).optional() }).optional(), // register: denyKeys, regexes as '/src/flags'
  t: z.number(),                        // Date.now() at capture: rrweb's clock (L12)
});

/** Not validated, never serialized: the register message's live handle (L11). */
export type StoreHandle = { getState(): unknown };
export type RegisterMsg = z.infer<typeof BridgeMsg> & { op: 'register'; handle: StoreHandle };

// The global queue that whichever side loads first creates (D5). The recorder adopts it when it
// starts recording, by replacing `push` and setting `adopted`. The loader sets `killed` only on an
// explicit config answer (enabled: false or killSwitch); a kill lasts until reload (D22).
declare global {
  interface Window { __SR_BRIDGE_Q__?: unknown[] & { killed?: boolean; adopted?: boolean } }
}
```

Bridge messages hold **live references** to immutable Redux state. They never cross
`postMessage`; the recorder serializes, caps and redacts them in idle time (04-L14).

```ts
// Sample — the shape to build, not final code. src/publish.ts — no imports (L10).
type Msg = { op: string };

/** How a store wrapper publishes. It fails open (D5): it never throws into the app. */
export const publish = (msg: Msg) => {
  try {
    const q = (window.__SR_BRIDGE_Q__ ??= Object.assign([] as unknown[], { killed: false }));
    if (q.killed) return;
    if (q.adopted || msg.op === 'register') q.push(msg); // before adoption, actions are dropped (L11)
  } catch { /* never break the app */ }
};
```

### Query API for the replay UI (`src/query.ts`)

Served on the replay UI port, never on the ingest port (05). Every `/api/*` request carries
`X-SR-UI: 1` (L14); query parameters that are empty are left out, not sent as `''`.

| Route | Returns |
|---|---|
| `GET /api/sessions?user=&day=yyyymmdd&hasErrors=1&limit=50&cursor=` | `SessionPage`, newest first. `day` matches every session that **touches** that UTC day |
| `GET /api/sessions/:id` | `SessionDetail` |
| `POST /api/access` (`AccessReq`) | 204 + the `sr_viewer` cookie and an 8 h grant for **that browser**, covering every session opened in it; logged (D38, 05-L10) |
| `GET /api/sessions/:id/actions?kinds=click,input&after=&to=&failedOnly=1&limit=1000` | `ActionPage` |
| `GET /api/sessions/:id/chunks?from=<posKey>&to=<posKey>&cursor=` | the framed chunk response below |
| `GET /api/hotspots?day=yyyymmdd&app=` | `HotspotRow[]` for the Hotspots page (D32) |

- **Errors:** detail, actions and chunks without a grant → 403 `{need:'access'}`. A missing
  `X-SR-UI` → 400 `{error:'ui-header'}`, logged as `denied`. Unknown session → 404
  `{error:'not-found'}` (it may live in another region, D37). Bad parameters → 400
  `{error:'invalid', issues}`.
- **Actions** hold only the sparse kinds below; the UI builds state and request rows for the loaded
  window from its events (architect A11). `after` is exclusive, `to` exclusive. `kinds` is a comma
  list of `ActionKind`. `failedOnly=1` keeps `net` rows only when `failed`; other kinds pass.
- **Chunks:** `from` inclusive, `to` exclusive, both inside **one recording**. A replay window never
  crosses recordings (06). Without `to`, the read runs to the end of `from`'s recording. The route
  returns **whole chunks** that cover the range, and sends `Content-Length` when it knows the total,
  so the UI can show a download progress bar.
- The replay UI calls the JSON routes through Hono's typed client (`hc<QueryApi>`). `QueryApi` is
  exported from `apps/server/src/api` (05); in B2 the UI uses its mock's type instead (06-L11).

```ts
// Sample — the shape to build, not final code.
export const Day = z.string().regex(/^\d{8}$/);          // yyyymmdd, UTC
export const PosKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}:\d+:\d+$/);

export const SessionSummary = z.object({
  sessionId: z.string(), userId: z.string(), app: z.string(),
  startedAt: z.number(), endedAt: z.number(),             // raw client ms (L12)
  days: z.array(Day),                                     // the UTC days the session touches
  live: z.boolean(),                                      // a batch arrived in the last 2 min
  // counts.errors = sr:error events; counts.consoleErrors = console.error lines not marked `same` (L15)
  counts: z.object({ errors: z.number().int(), consoleErrors: z.number().int().default(0), failedReqs: z.number().int(), reports: z.number().int(),
                     bands: z.number().int(), missingBatches: z.number().int() }),
  identity: z.literal('client-asserted'),                 // D20: nothing checked the user id
});
export const SessionPage = z.object({ items: z.array(SessionSummary), next: z.string().nullable() });

export const Band = z.object({
  reason: FidelityReason, recordingId: z.string(),
  from: z.number(), to: z.number().nullable(),            // raw client ms; to = null: still open
  detail: z.string().optional(),
});

export const SessionDetail = SessionSummary.extend({
  recordings: z.array(z.object({                          // ordered by startedAt (L9)
    recordingId: z.string(), startedAt: z.number(), endedAt: z.number(),
    clockOffsetMs: z.number(),                            // add for display only (L12)
    lastSeq: z.number().int(), pipeline: z.enum(['main', 'worker']),
    cleanClose: z.boolean(),                              // an sr:close arrived (devil X19)
    gaps: z.array(z.object({ fromSeq: z.number().int(), toSeq: z.number().int() })), // missing distinct seqs, inclusive
    dups: z.number().int(),                               // flagged duplicate rows
  })),
  snapshots: z.array(StreamPos.extend({ t: z.number() })), // seek anchors: the position of each FullSnapshot event
  bands: z.array(Band),                                   // fidelity pairs + server-made gap bands
  notes: z.array(z.object({ reason: FidelityReason, t: z.number(), detail: z.string().optional() })),
  rateCaps: z.array(z.object({ t: z.number(), configVersion: z.string(), caps: RateCaps })),
  meta: SrPayload['sr:meta'].partial().optional(),        // the latest sr:meta
  files: z.array(z.object({ day: Day, file: z.string() })), // for support debugging (05)
  legalHold: z.boolean(),
});

export const AccessReq = z.object({
  sessionId: z.string().optional(),                     // the session being opened, for the log; the grant covers all (D38)
  name: z.string().min(2).max(80), reason: z.string().min(3).max(200),
});

export const ActionKind = z.enum(['click', 'input', 'nav', 'error', 'net', 'fidelity', 'report', 'hotspot', 'console']);
export const ActionRow = z.object({
  pos: StreamPos, t: z.number(), kind: ActionKind,
  name: z.string(), summary: z.string(),
  failed: z.boolean().optional(),                         // net: status 0 or ≥ 400 (only failed net rows are stored); errors
  app: z.string().optional(),                             // reserved; not filled in the MVP (01 Q27)
  level: ConsoleLevel.optional(),                         // console rows: error or warn from the API (L15)
  count: z.number().int().optional(),                     // console and error rows: folded repeats
});
export const ActionPage = z.object({ items: z.array(ActionRow), next: PosKey.nullable() }); // next → `after`

export const HotspotRow = z.object({
  app: z.string(), remote: z.string().nullable(), area: z.string(),
  pauses: z.number().int(), pausedMs: z.number(), peakMutationsPerSec: z.number(),
  users: z.number().int(),
  example: z.object({ sessionId: z.string(), pos: StreamPos }),   // the longest single pause
});
```

### Chunk response framing (`src/chunks.ts`)

The server streams the stored gzip bytes unchanged (L8); the browser inflates them with
`DecompressionStream`. One response, `Content-Type: application/vnd.sr.chunks`:

```
[4 bytes: header length N, big-endian] [N bytes: ChunksHeader as UTF-8 JSON] [blob 0][blob 1]…
```

```ts
// Sample — the shape to build, not final code.
export const ChunkMeta = z.object({
  recordingId: z.string(), seq: z.number().int(), t0: z.number(), t1: z.number(),
  bytes: z.number().int(),                                // length of this chunk's gzip blob in the body
  integrity: z.enum(['ok', 'mismatch', 'unreadable']),    // D28; unreadable: key shredded → bytes = 0
  dups: z.number().int(),                                 // flagged duplicates of this seq (only the first row is served)
});
export const ChunksHeader = z.object({
  chunks: z.array(ChunkMeta),                             // in seq order, all from one recording
  missing: z.array(z.object({ fromSeq: z.number().int(), toSeq: z.number().int() })),
  next: z.string().nullable(),                            // set when the 8 MiB cap cut the response
});

/** Splits a framed response into header + per-chunk events. Lives here so 05's tests and 06 share it. */
export declare const readChunks: (body: ReadableStream<Uint8Array>) =>
  Promise<{ header: z.infer<typeof ChunksHeader>; batches: { meta: z.infer<typeof ChunkMeta>; events: unknown[] }[] }>;
```

### Position helpers (`src/pos.ts`)

```ts
// Sample — the shape to build, not final code.
export const posKey = (p: StreamPos) => `${p.recordingId}:${p.seq}:${p.idx}`;

export const parsePos = (s: string): StreamPos | null => {
  const m = /^([A-Za-z0-9_-]{1,64}):(\d+):(\d+)$/.exec(s);
  return m ? { recordingId: m[1]!, seq: Number(m[2]), idx: Number(m[3]) } : null;
};

/** Recording order (index in SessionDetail.recordings), then seq, then idx (L9). */
export const comparePos = (a: StreamPos, b: StreamPos, order: ReadonlyMap<string, number>) =>
  (order.get(a.recordingId)! - order.get(b.recordingId)!) || a.seq - b.seq || a.idx - b.idx;
```

### Golden fixtures (`fixtures/`)

- `batch-v1-basic.json`: a full snapshot, clicks with `app`, an input, a nav, two Redux actions
  (one with `removed`), an `sr:net` with status 500, an `sr:redacted`, an `sr:close`, plus `sr:error` and `sr:console` lines at `error` (with a stack, `count` and one marked `same`), `warn` (with `dropped`) and `info` (D43).
- `batch-v1-fidelity.json`: a pause band, a hidden-tab band, a `state-capped` note, a snapshot
  with `NotRecorded` keys, a rate-cap legend.
- `session-v1-golden/`: a complete small recording. **Every future rrweb or protocol version must
  still replay it** (L3).
- `query-v1/`: one sample per JSON query schema, plus `chunks-v1.bin` (a framed response built from
  the batch fixtures by `fixtures/build-chunks.ts`). 06's mock serves them; 05's tests compare
  against them.

Every package tests against these fixtures, so parallel work meets at the same shapes.

## Acceptance

- [ ] Every schema has a passing and a failing test case.
- [ ] Golden fixtures validate against the schemas.
- [ ] The types compile in all consumer packages (`bunx tsc --noEmit` at the root).
- [ ] No runtime dependency except `zod`; the built `@sr/protocol/publish` contains no imports.
- [ ] `publish`: never throws (even with a broken queue object); does nothing when `killed`;
      before adoption the queue holds only `register` messages after 10,000 actions.
- [ ] `parsePos(posKey(p))` round-trips; `comparePos` orders across two recordings.
- [ ] `readChunks` round-trips `chunks-v1.bin`, including an `unreadable` chunk with 0 bytes and a
      response cut by `next`.

## Tasks

- [ ] T1 `packages/protocol`: schemas, types, position helpers, chunk framing and the `publish`
  entry — owns: `packages/protocol/{package.json,tsconfig.json,src/**,test/**}` — batch: **B1** —
  done when the Acceptance items pass and `exports` has `.`, `./publish` and `./secrets` (`isSecretKey`, moved from 04's serializer, and `maskCutToken`; no imports; D43).
- [ ] T2 Golden fixtures — owns: `packages/protocol/fixtures/**` — batch: **B1** — depends on: T1 —
  done when the fixtures validate and `session-v1-golden` replays in the spike Replayer.

## Risks

| Risk | Mitigation |
|---|---|
| A late contract change ripples into every package. | Additive-only rule (L3); contract changes go through the leader and get a Log line here. |
| `zod` adds weight to the recorder or app bundles. | The recorder imports types only (`import type`); apps import only `@sr/protocol/publish` (L10). Only the server validates at runtime. |
| The chunk framing is our own format. | It is tiny, shared by server and UI through `readChunks`, and round-trip tested; R0 checks `DecompressionStream` on concatenated blobs. |

## Log

- 2026-11-10 — Created from plan 01 when the user asked to split the plan for parallel agents (leader).
- 2026-11-10 — Contract requests from the 04, 05, 06 and 07 drafts merged (leader): zod 4
  `z.record` form; `sentAt` moved to `X-SR-Sent-At` (04-A); sha256 rule and flagged duplicates
  (05-C2); status bodies for 400/403/429 and 503 backpressure (05-C3); asset routes (05-C4);
  `sr:net` and `remote` on hotspots (05-C5); `sr:redacted` (04-B); `state-capped` (04-C); `app` on
  clicks and inputs (04-D, 06-C4); zod-free `publish` entry (04-E, 07-L5); `removed` and register
  `meta` (04-F, 06-C9); queue folding before adoption (07-G); `SessionPage`, `SessionDetail` (with
  `recordings`, `snapshots`, `bands`, `notes`, `live`), `ActionPage` paging, `ChunksResponse`,
  `HotspotRow`, `AccessReq` and the `posKey` URL form (05-C6, 06-C1–C6); bands vs notes table;
  `query-v1/` fixtures.
- 2026-11-10 — Architect and devil review merged (leader): identity = hash of the decoded body,
  stored gzip served as a framed binary response (A4); the store handle in `register`, no folding,
  actions dropped before adoption (A9, X12, X13); raw client time everywhere plus `clockOffsetMs`
  (X2); write key per recording and quota on userId + IP (X16); `X-SR-UI` on `/api/*` (X14);
  half-open ranges, windows inside one recording, FullSnapshot anchors with `idx`, sparse action
  kinds, gap ranges, `dups` (X25, A11); `NotRecorded` placeholders and `meta.deny` (X3, X11);
  `sr:close`, `chunk-unreadable`, `no-clean-close` and gap bands that run to the next full snapshot
  (X1, X19); `no-state` rule; `checkpointMutations` (A5); 5 s cadence (A10); limits derived from
  P1 (A1).
- 2026-11-10 — Open-question answers (user): `sr:meta` gains `tz` and `tzOffsetMin` for the recorded user's local time (D42); the viewer grant covers every session in that browser for 8 h, so `AccessReq.sessionId` is optional (D38); `app` on clicks, inputs and action rows is reserved, not filled in the MVP (Q27).
- 2026-11-10 — Console capture (01 D43): `ConsoleLevel`, the `sr:console` tag and event, `count` on `sr:error`, `RecorderConfig.console` (default `error` and `warn`, 10/s, 2,000 chars), `ActionKind` `console` with `level` and `count` on `ActionRow`, `counts.errors` includes `console.error`; L15: only `error` and `warn` become server action rows. All additive. MVP2 analytics contracts (`Fact`, `AnalyticsQuery`, `AnalyticsResult`, `domProbes`) are added additively at MVP2 start (09 AN0).
- 2026-11-10 — Console and analytics review merged (leader). `sr:error` and `sr:console` gain `dropped` and `same`; `sr:redacted` gains `userinfo`; `console-capped` note; `RecorderConfig.console` gets per-field defaults, bounds and `maxPerRecording` with `.prefault({})`; `counts.errors` stays `sr:error` only and the new `counts.consoleErrors` holds console errors (L15 rewritten); new zod-free entry `@sr/protocol/secrets` with `isSecretKey` and `maskCutToken` (T1); T2 fixtures carry console and error lines. All additive.
