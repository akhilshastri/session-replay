# 09 — Analytics infrastructure (MVP2)
Status: draft (MVP2: starts after the v1 pilot) · Size: large

## Goal

Answer questions across recorded users from the data the recorder already sends, for example:
- how many users have the **Orders** tab open, and how many have it on screen;
- the top errors this week, and how many users hit each one;
- console warnings by app.

MVP2 builds **the infrastructure only** (user, 2026-11-10):
- facts derived on the server;
- an analytics store, with daily summaries;
- a backfill job;
- the DOM tab reader (`$dom`);
- a query API and CLI that run any number of saved query specs.

**Out of scope for MVP2:**
- the `/analytics` query page (it comes later, on top of this API);
- totals across regions;
- facts for users who aren't recorded;
- a MongoDB or AMPS store.

The master plan holds the cross-cutting decisions: D43 (console) and D44 (this plan's scope). The
architect's design (2026-11-10) is merged below.

## Decisions

| # | Decision | Why | Who |
|---|---|---|---|
| L1 | **The server derives facts at ingest.** Ingest already decodes and parses every batch (05, ingest steps 3–4). A pure `extract()` turns those events into facts in the same pass, and they're written after the ack. The browser sends nothing new except console lines (D43) and the `$dom` store (L4). | No extra browser work. A new fact needs only a config change or a server release, never a recorder release. Facts can be rebuilt from recordings. Rejected alternatives: a browser fact stream (more browser work, no rebuild), and the browser writing straight to MongoDB or AMPS (it would skip the write key, allow-list, quota and kill switch, and put database credentials in the browser). | user (architect option c) |
| L2 | **Two tables in `data/analytics.db`.** `facts` holds one row per occurrence: kept 30 days, the same as the recordings, and rebuildable from them. `fact_days` is a daily summary: kept 13 months (`SR_FACT_DAYS=395`), not rebuildable after 30 days, and included in the daily off-PVC backup and the erasure runbook. | Trends beyond a month without keeping raw data longer. | user (retention), architect |
| L3 | **Recorded users only.** There's no facts-only mode: users who aren't enabled still run nothing (D22). | Keeps the allow-list model and the DPIA scope as they are. | user |
| L4 | **Tabs are read from the page.** Central config lists CSS selectors (flexlayout's `.flexlayout__tab_button…`). The recorder reads the visible tab labels into a built-in `$dom` store, tracking both open and visible tabs, and publishes it only when it changes. Names are the labels; a `data-sr-tab` id comes later only if renamed labels skew the counts. | No app change at all, it works for any app with tabs, and it's cheap: a few `querySelectorAll` calls. | user |
| L5 | **A neutral query spec** (filter, group by, metrics, time range) is compiled per store behind a `FactStore` interface. SQLite is the store now. A later MongoDB or AMPS store is one new module. | The query side outlives the database choice. | architect; the store move is the user's call later |
| L6 | **Queries run in a read-only `analytics` Worker**, one at a time (up to 3 queued, then 429), and stop after 10 s with a 504. They never run on the main thread. | A `GROUP BY` over millions of rows could stall ingest (05-L1). | architect |
| L7 | **A query API and CLI, with saved query specs** from the ConfigMap. No page in MVP2. | "We need multiple queries" (user): any number of named specs, run by API or CLI. | user |
| L8 | **Access is decided at MVP2 start**, together with the DPIA and staff-notice update (Q1): who may query, whether `oauth-proxy` comes first, and the minimum group size. Until then the API stays on the internal UI port with `X-SR-UI`, every query is logged, and **it doesn't go live before Q1 is answered**. | Usage analytics of staff is a new purpose beyond support. | user |
| L9 | **Only the first stored chunk per `seq` makes facts.** Retries (208) and flagged duplicates make none, the same rule as for action rows. A failed analytics write marks the recording for re-derivation, and the batch is still acked. | No double counts; analytics never blocks recording. | architect |
| L10 | **Fingerprints group errors and console lines:** digits, UUIDs and hex ids become `#`, plus the top stack frame. **Redux action types are counted per day, not stored one by one.** | "Same error from 50 users" counts as one row. Raw action rows would be about 144,000 per user per day. | architect (leader's call) |
| L11 | **A config ignore list** drops noisy fingerprints, such as AG Grid's licence banner and React development warnings. | Keeps console analytics useful. | architect |

## Design

```mermaid
flowchart LR
  R[Recorder: sr:* events, sr:console, $dom store] -->|POST /sr/ingest| I[ingest: one walk → action rows, marks, facts]
  I --> W[writer worker]
  W -->|commit, then ack| D[(day file)]
  W -->|after the ack, like master.db| A[(analytics.db: facts + fact_days)]
  B[backfill job Worker: same extract()] -->|temp file; the writer merges| A
  API[/POST /api/analytics/query · CLI/] --> Q[analytics Worker: spec → SQL] --> A
```

### Fact model

```ts
// Sample — not final code. packages/protocol/src/analytics.ts (added additively at MVP2 start, 03-L3).
export const FactKind = z.enum(['session', 'nav', 'click', 'error', 'console', 'net', 'action', 'state', 'fidelity']);
export const Fact = z.object({
  pos: StreamPos, sub: z.number().int(),           // one event can give several facts (each item of a set)
  t: z.number(), offsetMs: z.number(), day: Day,   // raw client time + offset (03-L12); the batch's day (05-L6)
  sessionId: z.string(), userId: z.string(), app: z.string(),
  kind: FactKind,
  name: z.string().max(200),                       // what: path id, fingerprint, click label, route template
  value: z.string().max(200).optional(),           // state value, console level, HTTP status, start/end
  sample: z.string().max(500).optional(),          // a readable example, e.g. the first error message
  xv: z.number().int(),                            // extractor version: a backfill rebuilds older ones
});
```

| Kind | From | `name` | `value` |
|---|---|---|---|
| `session` | first and last batch | `start` / `end` | — |
| `nav` | `sr:nav` | route template (numeric and UUID segments → `:id`) | — |
| `click` | `sr:click` | label (80 chars) + nearest `data-sr-grid` | — |
| `error` | `sr:error` | fingerprint (L10) | — |
| `console` | `sr:console` | fingerprint (L10) | level |
| `net` | failed `sr:net` only | method + route template | status |
| `action` | `sr:state` actions | action type, **counted per day only** (L10) | — |
| `state` | `sr:state` for configured paths, and every `$dom` probe | path id (`layout.visible`) | the value; one fact per item of a set |
| `fidelity` | `sr:fidelity` | reason | start/end |

### Config: the ConfigMap's `analytics` section, plus `domProbes` in the recorder config

```json
{ "analytics": {
    "statePaths": [
      { "id": "blotter.view", "store": "*/redux#1", "path": "ui.blotter.view", "as": "value" }
    ],
    "ignore": ["console:AG Grid Enterprise License*", "console:Warning: Each child in a list*"],
    "savedQueries": { "tab-visible-30d": { "v": 1, "range": { "last": "30d" },
      "where": [{ "field": "kind", "op": "eq", "value": "state" },
                { "field": "name", "op": "eq", "value": "layout.visible" }],
      "groupBy": ["value"], "metrics": ["users"], "limit": 50 } } },
  "domProbes": [
    { "id": "layout.open",    "selector": ".flexlayout__tab_button_content", "as": "set" },
    { "id": "layout.visible", "selector": ".flexlayout__tab_button--selected .flexlayout__tab_button_content", "as": "set" }
  ] }
```

- **State paths** use a small path language (`a.b`, `[n]`, `[*]`, about 40 lines): no JSONPath library and no filter expressions.
  - Only scalars are extracted. Values are capped at 200 characters and sets at 50 items.
  - A value the recorder left out (`NotRecorded`) becomes `?`, never "absent".
  - A path with a secret-named segment (D18) is refused when the config loads.
- **Matching is cheap.** Paths are indexed by store and first segment. An action is checked only when its `changes` contain that top-level key.
- **Emit on change:** an LRU keeps the last value per recording and path.
- **Every DOM probe is also a state path** in store `$dom`. It needs no second entry.

### DOM probe (recorder, L4)

```ts
// Sample — not final code. packages/recorder/src/dom-probe/index.ts (MVP2).
// Reads tab labels with config selectors and feeds them to the recorder's state intake (04 R6) as a
// built-in store named `$dom`: a snapshot at start and after every FullSnapshot, then an action only
// when a value changes. The intake serializes, caps and scrubs it like any Redux store.
type Probe = { id: string; selector: string; as: 'set' | 'first' };

export const startDomProbe = (probes: Probe[], intake: StateIntake) => {
  const read = () => Object.fromEntries(probes.map((p) => {
    const texts = [...document.querySelectorAll(p.selector)].slice(0, 50)
      .map((el) => (el.textContent ?? '').trim().slice(0, 200)).filter(Boolean);
    return [p.id, p.as === 'set' ? [...new Set(texts)].sort() : (texts[0] ?? null)];
  }));
  let state = read();
  let key = JSON.stringify(state);
  intake.registerBuiltIn('$dom', () => state);           // read again after every FullSnapshot

  const check = () => {
    if (document.visibilityState === 'hidden') return;   // nothing changes on a hidden tab
    const next = read();
    const nextKey = JSON.stringify(next);
    if (nextKey === key) return;                          // send only on change
    const changes = Object.fromEntries(Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(state[k])));
    state = next;
    key = nextKey;
    intake.action('$dom', { type: 'dom/probe', changes, t: Date.now() });
  };
  return { afterClick: () => setTimeout(check, 300), timer: setInterval(check, 30_000) };
};
```

**To check in the real workspace:**
- whether flexlayout draws tabs pushed into a tabset's "…" overflow menu. If it doesn't, those tabs are undercounted as open (Q3);
- the exact class names at the real flexlayout version.

### Storage

```sql
-- Sample — not final code. data/analytics.db (WAL), written only by the writer worker.
CREATE TABLE facts (recording_id TEXT, seq INT, idx INT, sub INT, t INT, offset_ms INT, day TEXT,
  session_id TEXT, user_id TEXT, app TEXT, kind TEXT, name TEXT, value TEXT, sample TEXT, xv INT,
  PRIMARY KEY (recording_id, seq, idx, sub)) WITHOUT ROWID;
CREATE INDEX facts_kind_name_day ON facts (kind, name, day);
CREATE INDEX facts_user ON facts (user_id);                       -- erasure

CREATE TABLE fact_days (day TEXT, kind TEXT, name TEXT, value TEXT, app TEXT, user_id TEXT,
  n INT, first_t INT, last_t INT, example_session TEXT, example_pos TEXT, sample TEXT,
  PRIMARY KEY (kind, name, day, value, app, user_id)) WITHOUT ROWID;
-- Updated in the same transaction as the facts: an upsert that adds to n and widens first/last.
```

**Retention, erasure and backup:**
- A daily retention job drops `facts` older than 30 days and `fact_days` older than `SR_FACT_DAYS`.
- The erasure runbook (05) gains `DELETE … WHERE user_id = ?` on both tables, then `VACUUM`.
  Facts are plain text even with D27 on, so they're deleted rather than crypto-shredded.
- `analytics.db` joins the daily off-PVC backup next to `control.db`.

**Volume (architect's estimate):**
- About 2,500 facts per user per 8-hour day, mostly clicks.
- That's about 125,000 rows a day for a 50-user region, about 3.75 million over 30 days, and under 1 GB.
- About 6 million summary rows over 13 months.
- Small next to the recordings (about 37 GB per region).

### Query spec, API and CLI

```ts
// Sample — not final code. packages/protocol/src/analytics.ts
export const AnalyticsQuery = z.object({
  v: z.literal(1),
  range: z.union([z.object({ from: Day, to: Day }),                    // half-open UTC days
                  z.object({ last: z.enum(['1d', '7d', '30d', '90d', '365d']) })]),
  where: z.array(z.object({ field: z.enum(['kind', 'name', 'value', 'app']),
                            op: z.enum(['eq', 'in', 'prefix']),
                            value: z.union([z.string(), z.array(z.string()).max(50)]) })).max(8),
  groupBy: z.array(z.enum(['name', 'value', 'app', 'day', 'week'])).max(2),
  metrics: z.array(z.enum(['users', 'events', 'sessions'])).min(1),
  limit: z.number().int().min(1).max(500).default(50),
});
export const AnalyticsResult = z.object({
  columns: z.array(z.string()), rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
  source: z.enum(['fact_days', 'facts']), truncated: z.boolean(), tookMs: z.number(),
});
```

**How a spec compiles:**
- The compiler reads `fact_days`. The `sessions` metric needs `facts`, so it's limited to 30 days.
- Fields and operators come only from the enums, and values are always bound parameters.
- The minimum group size (Q1) will be a `HAVING users >= ?` added here.

```sql
-- "tab-visible-30d": users who had each tab on screen in the last 30 days
SELECT value, COUNT(DISTINCT user_id) AS users FROM fact_days
WHERE day >= ?1 AND day < ?2 AND kind = 'state' AND name = 'layout.visible'
GROUP BY value ORDER BY users DESC LIMIT ?3;

-- "top-errors-7d": top errors with users affected (console.error lines are kind 'console', value 'error')
SELECT name, MAX(sample) AS sample, SUM(n) AS events, COUNT(DISTINCT user_id) AS users
FROM fact_days WHERE day >= ?1 AND day < ?2 AND kind = 'error'
GROUP BY name ORDER BY users DESC, events DESC LIMIT ?3;
```

The same spec on a later store:
- **MongoDB:** `$match → $group {events: {$sum: '$n'}, users: {$addToSet: '$user_id'}} → $project {users: {$size: '$users'}} → $sort → $limit`.
- **AMPS:** an aggregated `sow` query with `projection=[/name, SUM(/n) AS /events, COUNT_DISTINCT(/user_id) AS /users], grouping=[/name]`.

```ts
// Sample — not final code. apps/server/src/analytics/store/fact-store.ts — the seam for a later store.
export type FactStore = {
  insert(facts: Fact[]): void;                            // facts + fact_days upsert, one transaction
  query(spec: AnalyticsQuery): Promise<AnalyticsResult>;  // runs in the analytics Worker
  sessions(spec: AnalyticsQuery, row: string[]): Promise<{ sessionId: string; pos: string }[]>; // ≤ 30 days
  retain(now: Date): void;
  erase(userId: string): void;
};
```

**API** (UI port 3002, `X-SR-UI: 1`, Host check, as for `/api/*`):

| Route | Answer |
|---|---|
| `POST /api/analytics/query` (`AnalyticsQuery`) | `AnalyticsResult`; 400 for a bad spec; 429 when 3 queries are queued; 504 after 10 s |
| `GET /api/analytics/queries` | the saved specs by name, from the ConfigMap |
| `POST /api/analytics/queries/:name/run` | runs a saved spec |
| `POST /api/analytics/sessions` (`{spec, row}`) | up to 50 matching sessions with a position, for a later page's drill-down (≤ 30 days) |

Every call writes an access row `analytics-query` with the spec in `detail` (05 audit).

**CLI** (through `oc exec`, like 05's other ops; queries open `analytics.db` read-only):
```
bun apps/server/src/cli.ts analytics run top-errors-7d
bun apps/server/src/cli.ts analytics query '{"v":1,"range":{"last":"7d"},"where":[{"field":"kind","op":"eq","value":"console"}],"groupBy":["name"],"metrics":["users","events"]}'
bun apps/server/src/cli.ts analytics backfill --days 30     # goes through the request-file loop; the writer merges
bun apps/server/src/cli.ts analytics status                 # rows, days covered, last backfill, extractor version
```

**Saved queries for day one (proposal, Q2):**
- `top-errors-7d`
- `console-errors-7d` and `console-warnings-7d` by app
- `tab-open-30d` and `tab-visible-30d`
- `failed-requests-by-route-7d`
- `routes-used-30d`
- `action-types-7d`

### Store choice

SQLite stays the store for MVP2.

| Move to | When | Note |
|---|---|---|
| MongoDB | the facts become a shared company store (other tools, BI, across regions), or grow past about 100M rows | The server is under the SSPL licence (not OSI open source), and it's a new stateful service per region |
| AMPS | the goal becomes **live** boards, e.g. errors right now per desk | Aggregated `sow` queries work, but it's the weakest fit for history queries |
| DuckDB | a typical 13-month query takes more than 2 s | It can `ATTACH` `analytics.db` read-only; it's a native add-on whose Bun support isn't documented |

## Acceptance

- [ ] On the fixture layout app, opening and switching tabs:
  - shows a `$dom` store in the replay's state panel;
  - produces `state` facts `layout.open` and `layout.visible` within 5 s of the batch's ack.
- [ ] The saved queries return the expected rows (golden) on the fixture data set:
  - tab usage (open and visible);
  - top errors with users affected;
  - console errors and warnings by app.
- [ ] Retries (208) and duplicate chunks make no extra facts. A backfill over the same days gives the same facts and summaries as live ingest.
- [ ] Retention and erasure:
  - facts older than 30 days and summaries older than `SR_FACT_DAYS` are deleted;
  - erasure for a user removes their rows from both tables;
  - the daily off-PVC backup includes `analytics.db`.
- [ ] A query running longer than 10 s returns 504 and is stopped. While queries run, ingest p99 and event-loop lag stay within 05's limits.
- [ ] A bad spec gets 400: an unknown field or operator, a limit over 500, more than 8 filters. Values never appear in SQL text.
- [ ] Every API and CLI query writes an access row with its spec.
- [ ] Privacy rules hold:
  - no facts come from users who aren't recorded;
  - a state path with a secret-named segment is refused when the config loads;
  - a `NotRecorded` value becomes `?`;
  - ignore-listed fingerprints make no facts.
- [ ] The DOM probe:
  - costs ≤ 0.2 ms per check on the P1 S2 page;
  - sends only when a value changes;
  - does nothing while the tab is hidden;
  - needs no app change.
- [ ] `extract()` adds ≤ 1 ms per batch at P1's S2 rate, measured in the load test.

## Tasks

MVP2 runs after the v1 pilot, in the same way as v1: coder on Sonnet, one task per run, at most 3
agents, reviewer and qa batched.

Order: AN0 → (AN1 ∥ AN5) → AN2 → (AN3 ∥ AN4) → AN6 → AN7.

- [ ] **AN0 Contracts** — owns: `packages/protocol/src/analytics.ts`, `packages/protocol/fixtures/analytics/**`, and the additive `domProbes` field in 03's `RecorderConfig` — depends on: v1 done; plan owner's approval (03-L3) — done when: `Fact`, `AnalyticsQuery`, `AnalyticsResult` and the `analytics` config section validate the golden fixtures; tier 1 passes.
- [ ] **AN1 `extract()`** — owns: `apps/server/src/analytics/extract/**` and its tests — depends on: AN0 — done when unit tests on fixture batches cover:
  - every kind in the table: route templates, fingerprints, click labels, failed requests only, action types counted only;
  - state paths with the path language, caps, `?` for `NotRecorded`, emit-on-change, the ignore list and refused secret paths;
  - a benchmark showing ≤ 1 ms per typical batch.
- [ ] **AN2 Store and writer hook** — owns: `apps/server/src/analytics/store/**`, the after-ack call in the writer, and the analytics steps in the retention, erasure and backup jobs — depends on: AN1 — done when tests cover:
  - facts and the `fact_days` upsert in one transaction;
  - no facts from 208 retries or duplicates;
  - a failed analytics write marks the recording for re-derivation while the batch is still acked;
  - retention, erasure and backup.
- [ ] **AN3 Backfill** — owns: `apps/server/src/analytics/backfill/**`, the CLI's `analytics backfill` and `analytics status` — depends on: AN2 — done when: a job Worker re-derives up to 30 days into a temp file and the writer merges it; on fixture days, live facts equal backfilled facts; throughput is measured and logged here.
- [ ] **AN4 Query layer** — owns: `apps/server/src/analytics/query/**`, `apps/server/src/api/analytics.ts`, the CLI's `analytics run` and `analytics query` — depends on: AN2 — done when:
  - golden SQL exists for each saved spec;
  - injection tests pass (enums and bound values);
  - the analytics Worker queues at most 3 queries, gives 504 at 10 s, and holds ingest p99 steady under a heavy query;
  - audit rows are written;
  - saved specs come from the ConfigMap.
- [ ] **AN5 DOM probe** — owns: `packages/recorder/src/dom-probe/**`, and the `$dom` built-in store hook in the state intake — depends on: AN0 — done when:
  - happy-dom unit tests cover selectors, sets, caps, on-change-only sends, hidden tabs, and the snapshot after a FullSnapshot;
  - the cost per check on the P1 page is measured and is ≤ 0.2 ms.
- [ ] **AN6 Saved query set and guide** — owns: the `analytics` section of the region config samples, `docs/analytics/**` — depends on: AN4 — done when: the day-one saved queries (Q2) exist with golden results; a short guide shows how to write and run a spec.
- [ ] **AN7 Gate** (qa + leader) — owns: `fixtures/apps/layout-tabs/**` (a small flexlayout app with tabs), `e2e/analytics/**` — depends on: AN3–AN6 — done when: the Acceptance list above passes, including the load test with queries running.

## Risks

| Risk | Mitigation |
|---|---|
| `extract()` slows ingest. | One walk shared with the action rows (05); ≤ 1 ms per batch measured (AN1, AN7); writes after the ack. |
| A backfill reads tens of GB of gzip per region. | Off-hours, a short-lived job Worker, measured in AN3; usually needed only after a config or extractor change. |
| Console noise (licence banners, React warnings) swamps the results. | The ignore list (L11); fingerprints group repeats. |
| Daily summaries are durable personal data. | Kept 13 months, in the backup and the erasure runbook; the DPIA update (Q1). |
| Tab labels get renamed, or overflowed tabs aren't drawn. | `data-sr-tab` ids later (L4); the overflow check (Q3). |
| The API goes live before access is decided. | L8: no go-live before Q1; every query is logged. |
| Someone active in two regions is counted twice later. | Cross-region totals are out of scope; a later fan-out adds counts only. |

## Open questions

1. **Before MVP2 go-live:** who may run queries? Must the `oauth-proxy` login come first? What minimum group size applies? The DPIA and staff notice need an update for the new purpose. (User: decide at MVP2 start.)
2. Confirm or change the day-one saved queries listed above.
3. Does flexlayout draw tabs that are pushed into the overflow menu? Check in the B5 real-workspace run (08 §12).
4. Is "visible" a user count only, or also time on screen? Time needs intervals between `$dom` facts. Later.
5. What triggers a move to MongoDB or AMPS?

## Log

- 2026-11-10 — Created (leader) from the user's analytics brainstorm and the architect's design.
  - **User decisions:** the server derives facts (architect option c); tabs are read from the DOM as labels, both open and visible; recorded users only; facts kept 30 days and summaries 13 months; MVP2 is the infrastructure only (facts, store, backfill, DOM probe, query API and CLI with saved queries, no page); access decided at MVP2 start.
  - **v1 gets only console capture** (01 D43).
