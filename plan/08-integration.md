# 08 — Integration guide
Status: draft · Size: large · Parent: [01-session-replay.md](01-session-replay.md)

## Goal

This repo is the baseline. The real integration happens later in the user's own monorepo: a
webpack 5 host shell, Vite 7 remotes built with `@module-federation/vite`, Redux + React
`useState`, flexlayout-react tabs holding AG Grid, Node 22+, on-prem OpenShift, one deployment per
region (D37). This guide is the step-by-step path from "packages published" to "a desk is recorded
and support can replay it", with code for each step. Its pages ship as `docs/integration/` and its
config samples as `examples/`.

## Decisions

Inherits D1, D3, D4, D5, D11, D19, D20, D22, D32, D34, D36, D37, D38, D39 and 03-L6.

| # | Decision | Why |
|---|---|---|
| L1 | Publish **three packages** to an internal npm registry: `@sr/protocol`, `@sr/recorder`, `@sr/state-plugin`. They share **one version number** (lockstep). The scope may be renamed (03-L6). | Teams install one version of everything; there's no matrix of package versions to test. |
| L2 | The recorder ships as **self-contained IIFE bundles** in one folder: a small `sr-loader.js` that every user runs, and `sr-recorder.js` (rrweb inside, at the pinned version, D1) that the loader fetches only for enabled users (04-L1), plus `sr-worker.js` if D11 turns the worker on. The host serves the folder **from its own origin**, outside `/sr/`, and loads the loader with one `<script>` tag (04-L17). | The IIFE gives Long Animation Frame script attribution (01, Recorder). Nothing about rrweb goes through MF sharing or the host's dependency tree. |
| L3 | Only **`/sr/*`** (config and ingest) goes through the host's origin. The replay UI and `/api/*` live on a **separate internal hostname**, never behind the host's route. | App users never get a path to recordings. Ingest stays same-origin, with no CORS (D20). |
| L4 | The **server image** goes to the cluster registry. Every region runs **the same image digest**; only config differs. | One build to test; region differences are data, not code. |
| L5 | **Rollout by allow-list stages** (D22): a few users, then the desk, then the region. The kill switch is the first response; removing the script tag is the last resort. | Rollback in seconds, without a host redeploy. |
| L6 | `examples/` is **derived from the 07 fixture apps** (PL5–PL6) and checked by a test (each sample parses, and the fixture builds pass the plugin's outcome check). | Copied config samples rot; checked ones don't. |
| L7 | Mark grids with **`data-sr-grid` on the grid's own container** inside the tab component, and give capped columns an **explicit `colId`**. | flexlayout owns and moves its tab wrappers. AG Grid's `colId` defaults to `field`, so a renamed field would silently drop a cap. |

## How-to

Recorder APIs come from `04-recorder.md` and build-plugin APIs from `07-state-plugin.md`; if a
name changes there, change it here too. The server's config file format and the OpenShift YAML
belong to `05-server.md`.

### 1. Packaging and distribution

| Artifact | Contents | Used by |
|---|---|---|
| `@sr/protocol` | zod schemas and types (03) | server, tools, tests; rarely app code |
| `@sr/recorder` | `dist/iife/sr-loader.js`, `dist/iife/sr-recorder.js` (rrweb inside), `dist/iife/sr-worker.js` (used only if P1 turns the worker on, D11), `dist/esm/` | the host shell |
| `@sr/state-plugin` | `.` exports `srState.webpack()` and `srState.vite()` (ESM + CJS, for Node configs); `./runtime` holds `__srWrapCreateStore` and `srAttach` (browser ESM; its only import is `@sr/protocol/publish`) | every build that creates Redux stores |
| image `sr-server:<version>` | `apps/server` + the built replay UI | OpenShift, one StatefulSet per region |

```toml
# Sample — not final code. bunfig.toml in this repo (publishing). The token comes from the CI
# secret store as an environment variable; it is never written into a file in the repo.
[install.scopes]
"@sr" = { token = "$SR_NPM_TOKEN", url = "https://npm.internal.example/repository/npm-internal/" }
```

```sh
# Sample — not final code. Release from CI, one version for all three packages (L1).
bun run --filter '@sr/*' build
cd packages/recorder && bun publish --dry-run   # read the file list: dist/ only, no src, no .env
bun publish                                     # then protocol and state-plugin, same version
podman build -f apps/server/Dockerfile -t sr-server:1.0.0 .     # Dockerfile: see 05
podman push sr-server:1.0.0 "$SR_IMAGE_REGISTRY/session-replay/sr-server:1.0.0"
```

In the real workspace (npm or pnpm on Node 22), consumers point the scope at the registry:

```ini
# Sample — not final code. .npmrc in the real workspace; NPM_TOKEN comes from the environment.
@sr:registry=https://npm.internal.example/repository/npm-internal/
//npm.internal.example/repository/npm-internal/:_authToken=${NPM_TOKEN}
```

### 2. Host shell setup

**2a. Load the recorder.** Copy the package's `dist/iife/` folder into the host's build output as
`sr-recorder/<version>/` (see the webpack config in §3), then add one tag to the shell's HTML
template. Each remote needs nothing: they all share the host's DOM (D3).

```html
<!-- Sample — not final code. public/index.html (HtmlWebpackPlugin template) -->
<script src="/sr-recorder/<%= srVersion %>/sr-loader.js" data-app="trading-shell" data-endpoint="/sr" defer></script>
```

- The loader fetches `sr-recorder.js` (and `sr-worker.js`, if used) from **its own folder**, and
  only for enabled users (04-L1, L17). Keep the folder outside `/sr/`, which the gateway routes
  to the server (§2c).
- `data-endpoint` is where it finds `/sr/config`, `/sr/ingest` and `/sr/assets/*` (03).
- It starts after the first render and an idle callback, so `defer` is enough.

**2b. Tell it who the user is (D20).** The recorder reads `window.userId` by default. **Nothing
records until it is set** (04-L2), so the login page itself isn't recorded.

```ts
// Sample — not final code. Host shell, wherever login resolves.
type SessionRecorderApi = { identify(id: string): void; logout(o?: { purge?: boolean }): void };
declare global { interface Window { userId?: string; SessionRecorder?: SessionRecorderApi } }

export const onLogin = (user: { staffId: string }) => {
  window.userId = user.staffId;                   // D20: client-asserted; [A-Za-z0-9_.@-]{1,128}
  window.SessionRecorder?.identify(user.staffId); // optional: starts at once instead of on the next check
};
export const onLogout = () => {
  window.SessionRecorder?.logout();               // ends the session; uploads this user's queue now (01 Q26)
  delete window.userId;
};
```

If the shell already keeps the user id on another global, set the recorder's `userIdPath` option
(for example `data-user-path="app.session.staffId"`) instead of copying it.

**2c. Route `/sr/*` to the region's server.** The browser posts to its own origin; the host's
gateway forwards to the `sr-server` Service in that region (05). Prefer the gateway: by default
an OpenShift Route can't claim a host that another namespace already owns.

```nginx
# Sample — not final code. The host's gateway or nginx, in each region.
location /sr/ {
  proxy_pass http://sr-server.sr-nam.svc.cluster.local:3000;       # no URI: /sr/ is kept
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;     # limits are per userId + IP
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 2m;   # above the server's 1 MB bodyLimit, so the server answers 413
  proxy_read_timeout 30s;    # the server acks only after commit (D31)
}
```

05's NetworkPolicy admits port 3000 only from the router and gateway namespaces, so add the
gateway's namespace there. Never proxy `/api/` or `/` of the server through the host (L3).

**2d. ESM instead of a script tag (not recommended).** Importing the ESM build of
`@sr/recorder` (`dist/esm/`) in the shell's entry also works. But the recorder's time then counts as the host
bundle's time in LoAF, so the self-budget can't see its own cost.

### 3. The build plugin

The plugin wraps Redux `createStore` / `legacy_createStore` call sites in **your source** (D4,
D39). The import keeps its specifier, so MF sharing still matches `'redux'`:

```js
// Sample — not final code. What the transform emits for: import { createStore } from 'redux';
import { __srWrapCreateStore } from '@sr/state-plugin/runtime';
import { createStore as __sr$createStore } from 'redux';
function createStore() { return __srWrapCreateStore(__sr$createStore,
  { app: 'pricing', file: 'src/store.ts', lib: 'redux@4.2.1' }, arguments); }
```

**Where it goes in `plugins` doesn't matter** (07-L2). The plugin checks the outcome in every
file: if a file's source imports `'redux'` but the import reaches the transform already
rewritten (by another plugin, or by Babel/TS emitting CommonJS), the build fails and names the
file.

**Webpack 5 (host shell).** Its loader runs with `enforce: 'post'`, after Babel or ts-loader.

```js
// Sample — not final code. webpack.config.js (host shell, webpack 5)
const path = require('node:path');
const { ModuleFederationPlugin } = require('webpack').container;
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { srState } = require('@sr/state-plugin');                // CJS build for Node configs
const deps = require('./package.json').dependencies;
const srVersion = require('@sr/recorder/package.json').version;

module.exports = {
  mode: 'production',
  entry: './src/index.ts',                 // index.ts only does import('./bootstrap') (MF boundary)
  output: { path: path.resolve(__dirname, 'dist'), publicPath: 'auto', clean: true },
  resolve: { extensions: ['.tsx', '.ts', '.js'] },
  module: { rules: [{ test: /\.[jt]sx?$/, exclude: /node_modules/, use: 'babel-loader' }] },
  plugins: [
    srState.webpack({
      app: 'trading-shell',
      include: ['@corp/store-kit'],        // in-house packages under node_modules that create stores
      expectStores: 1,                     // the build fails if fewer call sites were wrapped
    }),
    new ModuleFederationPlugin({
      name: 'shell',
      remotes: { /* unchanged: keep your existing remotes */ },
      shared: {                            // keep today's sharing; the plugin needs no change here
        react: { singleton: true, requiredVersion: deps.react },
        'react-dom': { singleton: true, requiredVersion: deps['react-dom'] },
        redux: { singleton: true, requiredVersion: deps.redux },
        'react-redux': { singleton: true, requiredVersion: deps['react-redux'] },
      },
    }),
    new CopyWebpackPlugin({ patterns: [{                 // the whole folder: loader, recorder, worker
      from: path.join(path.dirname(require.resolve('@sr/recorder/package.json')), 'dist/iife'),
      to: `sr-recorder/${srVersion}/` }] }),
    new HtmlWebpackPlugin({ template: './public/index.html', templateParameters: { srVersion } }),
  ],
};
```

**Vite 7 (remote).** Any position works. Its `configResolved` hook also fails the build if
`originjs:federation` runs before it (it rewrites shared imports), and warns on Vite 8 or newer
("untested", 07-L11). P1b (02 K4) confirms `@module-federation/vite` leaves the import text alone.

```ts
// Sample — not final code. vite.config.ts (remote, Vite 7)
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { srState } from '@sr/state-plugin';

export default defineConfig({
  plugins: [
    react(),
    srState.vite({ app: 'pricing', denyKeys: ['marketData'] }), // keeps `from 'redux'` as written
    federation({
      name: 'pricing',
      filename: 'remoteEntry.js',
      exposes: { './PricingApp': './src/PricingApp.tsx' },
      shared: {
        react: { singleton: true }, 'react-dom': { singleton: true },
        redux: { singleton: true }, 'react-redux': { singleton: true },
      },
    }),
  ],
  build: { target: 'esnext' },
});
```

| Option | Meaning |
|---|---|
| `app` (required) | App name in session metadata and store names (`<app>/redux#<n>`). Use the same name as the remote root's `data-sr-app` (01 Q27) |
| `include` / `exclude` | In-house packages under `node_modules` to transform as well, or app files to skip |
| `denyKeys` | Top-level state keys never published, for volume (market-data slices) |
| `expectStores` | The build fails if fewer call sites were wrapped |

The full option list is in 07 (`StatePluginOptions`).

**A store the plugin can't see** (CommonJS `require`, a namespace import, or a package you can't
rebuild): attach it by hand (D5).

```ts
// Sample — not final code. Manual fallback; the wrapper fails open and obeys the kill flag.
import { srAttach } from '@sr/state-plugin/runtime';
export const store = createStore(rootReducer);
srAttach(store, rootReducer, { app: 'legacy-blotter' }); // wraps via replaceReducer
```

A remote built **without** the plugin still works; its stores just aren't captured, and the replay
shows a `no-state` band (D10).

### 4. Marking grids

```tsx
// Sample — not final code. A flexlayout tab that holds an AG Grid.
import type { TabNode } from 'flexlayout-react';
import { AgGridReact } from 'ag-grid-react';

const columnDefs = [
  { field: 'symbol' },
  { colId: 'bid', field: 'bidPx' },   // explicit colId: the cap key must not follow a field rename
  { colId: 'ask', field: 'askPx' },
  { colId: 'mid', valueGetter: (p: any) => (p.data.bidPx + p.data.askPx) / 2 },
];

// data-sr-grid goes on the grid's own container, not on flexlayout's tab wrapper (L7).
export const PositionsTab = ({ node }: { node: TabNode }) => (
  <div data-sr-grid="positions" style={{ height: '100%' }}>
    <AgGridReact columnDefs={columnDefs} getRowId={(p) => p.data.id} />
  </div>
);
export const factory = (node: TabNode) =>
  node.getComponent() === 'positions' ? <PositionsTab node={node} /> : null;
```

**How a cap is found (D36):** a changing cell `.ag-cell[col-id="bid"]` → its nearest
`[data-sr-grid]` ancestor (`positions`) → config `rateCaps.positions.bid` → at most that many
states per second, plus a flush at every user action.

- Grid ids: lowercase letters, digits and `-`; stable across releases. The same grid component in
  several tabs uses the same id, so it gets the same caps.
- Nested grids (master/detail): the nearest `data-sr-grid` wins.
- flexlayout keeps visited tabs mounted while hidden, so a hidden grid still ticks and is still
  recorded (P1 measures the cost). Render-on-demand delays the first mount.
- flexlayout popouts open real windows: they replay as a "popout open, not recorded" band (D34).

Check what the recorder will see, in DevTools on the live app:

```js
// Sample — not final code. Lists each marked grid and the column ids its cells carry.
[...document.querySelectorAll('[data-sr-grid]')].map((g) => ({ grid: g.dataset.srGrid,
  cols: [...new Set([...g.querySelectorAll('.ag-cell[col-id]')].map((c) => c.getAttribute('col-id')))] }));
```

**Mark each remote's root too** (proposed in 01 Q27). The element a remote mounts into gets
`data-sr-app="<name>"`, with the same name as that remote's `srState({ app })`. Clicks and inputs
then carry `app`, so the replay UI can filter actions by mini-app.

```tsx
// Sample — not final code. The host mounts a remote into a marked container.
export const RemoteSlot = ({ name, children }: { name: string; children: React.ReactNode }) => (
  <div data-sr-app={name} style={{ height: '100%' }}>{children}</div>
);
```

### 5. Rate caps and allow-list per region

Each region has its own config file (D37), mounted from the ConfigMap `sr-recorder-config` (05-L8).
A change goes through a reviewed edit of that ConfigMap; there is no admin HTTP endpoint. Every
change must bump `version`: the server checks the file every 15 s, logs a `config-change` access
row, and refuses a changed file with the same `version`. Running tabs see the new version in
`X-SR-Config-Version` (03).

```jsonc
// Sample — not final code. NAM, pilot week 1, in 05's format: defaults + per-app overrides.
{ "v": 1, "version": "2026-11-17.1", "killSwitch": false,     // top-level: every app off at once
  "defaults": { "checkpointMinutes": 12, "pipeline": "main", "retentionClass": "std",
                "budget": { "cpuPct": 3, "longFrameMs": 50, "resumeAfterMs": 10000 },
                "assetCache": { "enabled": false, "allow": ["/assets/", "/static/"] } },
  "apps": {
    "trading-shell": { "allowAll": false, "allowUsers": ["u123", "u456", "u789"],   // D22
                       "rateCaps": { "positions": { "bid": 2, "ask": 2, "mid": 2 } } } } }
```

The server serves `enabled = !killSwitch && (allowAll || allowUsers.includes(user))`. EMEA starts
later with `"allowUsers": []`, so its hosts only fetch config (no rrweb, no listeners). Start every region with **no caps**; add one only after the Hotspots page shows a grid
pausing, and record why in the change. A cap lowers audit fidelity, so the replay shows it in the
legend (D36).

### 6. Rollout playbook

| Stage | Who records | Exit criteria | Watch |
|---|---|---|---|
| 0 Dark | nobody (`allowUsers: []`) | config requests 200 in every host; no ingest traffic; app timings unchanged | gateway logs, host RUM |
| 1 Friends | 2–3 users, one on the busiest desk, 3 days | no complaints; pauses < 1 % of session time; a replay checked end to end (§8) | Hotspots page, quota hits, `seq` gaps |
| 2 Desk | the pilot desk (25–50 users), 2 weeks | the 01 performance budget holds in the field; support used it for a real ticket | as above + upload KB/min per user |
| 3 Region | other desks in the region, in steps | as stage 2 | as above |
| 4 Next region | repeat 0–3 in APAC, then EMEA | — | per region |

The DPIA and the staff notice must be done before stage 1 (D19).

**Kill switch (D22):**
1. Set `killSwitch: true` (top level: every app; or in `apps[app]`), or remove a user from
   `allowUsers` (one person). Bump `version`.
2. Apply the ConfigMap. Within about 15 s the server loads it and writes an access row.
3. Open tabs pick it up on their next upload response (about a second while recording); a tab
   that isn't uploading picks it up on its next start. Store wrappers become pass-through through
   the bridge's `killed` flag (D5). Expect under 30 s end to end.
4. Check: no new chunks for that app in the replay UI, and the ingest rate drops.
5. Last resort, if the server itself is down or misbehaving: remove the `<script>` tag. That needs
   a host redeploy.

### 7. Per-region deployment

One namespace per region, same image digest (L4). The YAML is in `05-server.md`
(`deploy/openshift/base` plus `overlays/{nam,apac,emea}`).

1. Create the namespace `sr-<region>` and give it pull access to the image registry.
2. In the overlay, set the host, the support-network CIDRs, a **ReadWriteOnce, block-backed**
   storage class (never NFS or CephFS: SQLite's WAL breaks there), `SR_REGION` and the image digest.
3. Create `sr-server-secrets` (`SR_MASTER_KEY`, `SR_COOKIE_KEY`, `SR_SUBJECT_KEY`) from Vault or
   an OpenShift Secret. Never from the repo.
4. Put the region's config (§5) in `sr-recorder-config`, with `allowUsers: []` to start.
5. `oc apply -k deploy/openshift/overlays/<region>`: the StatefulSet (1 replica), Service, the
   internal-only replay Route (`haproxy.router.openshift.io/ip_allowlist`; older OpenShift
   versions call it `ip_whitelist`), NetworkPolicy and snapshot CronJob.
6. Add the host gateway's `/sr/` location (§2c) and its namespace to the NetworkPolicy.
7. Smoke test: `GET /sr/config?app=trading-shell&user=<id>` through the host returns
   `enabled: false`, and `/healthz/ready` is 200.

### 8. Verification checklist (after integrating)

- [ ] **Recording appears:** an allow-listed user loads the app, clicks for a minute, and the session shows in the region's replay UI within a minute. Replay matches the screen.
- [ ] **Secrets masked:** type into a password field and a one-time-code field; add `?token=abc` to a URL. Search stored data (05's search tool): none of the values is there. Normal inputs replay as typed (D18).
- [ ] **Redux captured:** dispatch an action through a thunk in each remote. It shows in the action list and the state panel at the right moment, in the host and in each remote. A remote without the plugin shows `no-state`.
- [ ] **Not enabled = idle:** a user not in `allowUsers` loads only `/sr/config` (DevTools Network) and no recorder listeners.
- [ ] **Rate-cap legend:** with a cap on `positions.bid`, the replay legend says "positions grid: bid recorded at 2/s", and a click on a ticking row replays exactly.
- [ ] **Hotspots:** on a forced busy screen (or the P1 stress page in the same host), a pause shows a band and a row on the Hotspots page for that day, linked to the session.
- [ ] **Kill switch:** flip it with the app open; recording stops within seconds; the app is unaffected.
- [ ] **Failure is harmless:** with the recorder file returning 404, or the server down, the app works normally; after the server returns, the queued batches arrive.

### 9. Troubleshooting

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| **No session** | the user isn't in `allowUsers`, or `killSwitch` is on | `/sr/config` response in DevTools | add the user and bump `version`; turn the kill switch off |
| | a config edit kept the old `version` and was refused | server log / alert "config file refused" | bump `version` |
| | `window.userId` is never set | `window.userId` in the console | set it at login (§2b) or set `userIdPath` |
| | `/sr/` isn't routed, or the gateway rejects bodies | `POST /sr/ingest` status: 404, 413, 502 | add §2c; raise `client_max_body_size` |
| | the script file isn't served | Network tab: `sr-loader.js` or `sr-recorder.js` 404 | check the CopyWebpackPlugin pattern: both files must sit in the same folder |
| **No state** | the plugin isn't in that build | search the bundle for `__srWrapCreateStore` | add the plugin to that remote |
| | the store is created in `node_modules` | where `createStore` is called | add the package to `include`, or attach it with `srAttach` (§3) |
| | the store uses RTK `configureStore` | the store file | not captured in the MVP (D39); not supported by `srAttach` either; wait for v2 |
| | the kill flag is on | `window.__SR_BRIDGE_Q__.killed` | expected while the kill switch is on |
| **Build fails: "'redux' import was rewritten before sr-state ran"** | another plugin rewrote the import first, or Babel/TS emits CommonJS | the named file; `modules` in the Babel or TS config | move that plugin after sr-state, or set `modules: false` (§3) |
| **Recorder paused a lot** (bands, Hotspots rows) | a grid ticks faster than the budget allows | Hotspots: area and mutations/s | fix the source: batch grid updates (AG Grid `applyTransactionAsync`), pause hidden tabs via flexlayout's `visibility` event; then consider a rate cap (§5) |
| | cell flash doubles the mutations | grid options | turn flash off for capped columns |
| **Region mix-up** (sessions in the wrong UI) | the gateway points at another region's Service | §2c `proxy_pass` host | point each region's gateway at its own namespace |

### 10. Compatibility matrix

"Baseline tested" means covered by this repo's fixtures (P5) and e2e. Fill in the real
workspace's versions during the dry run (§12).

| Area | Supported in the MVP | Baseline tested | Notes |
|---|---|---|---|
| Browser | Chromium (Chrome, Edge) | Chrome | Others record, but without LoAF the self-budget uses callback timing only |
| React | 17, 18, 19 | all three | `useState` isn't captured as state (D39) |
| Redux | 4, 5 (`createStore`, `legacy_createStore`) | 4 and 5 | thunk and saga covered (reducer wrap, D6) |
| RTK, Zustand, TanStack Query | no (v2) | — | manual registration covers plain Redux stores only |
| webpack | 5 with the built-in `ModuleFederationPlugin` | yes | Rspack: should work (unplugin); untested |
| Vite | 7 with `@module-federation/vite` | yes | Vite 8 (Rolldown) deferred |
| Node (builds) | 22+ | 22 | Bun runs this repo, not the real builds |
| AG Grid | versions that put `col-id` on cells | the fixture's version | check with the §4 snippet |
| flexlayout-react | any | the fixture's version | popouts aren't recorded (D34) |
| Server | OpenShift 4.x, Linux, RWO block storage | local Bun | one replica per region |

### 11. Baseline here vs the real workspace

| Here (baseline) | Real workspace | What changes |
|---|---|---|
| Fixture apps (React 17 + webpack 5, React 18/19 + Vite 7) | the real host and remotes | real store files, real `include` paths |
| `workspace:*` packages, `@sr/*` scope | registry versions; maybe a renamed scope | install from the registry (§1) |
| One Bun process serves `/sr`, `/api` and the UI | gateway → `/sr` only; UI on its own internal host | §2c, L3 |
| Spike shop and the P1 stress grid | real desks, real tick rates | caps and budgets set from field data |
| Mock and fixture config | per-region admin config | §5, by the config owner |
| Synthetic users | real staff | DPIA and notice first (D19) |
| Local disk under `data/` | RWO block PVC, snapshots | §7, 05 |

### 12. Dry-run integration task

On a branch `sr/dry-run` of the real workspace, against a dev namespace:
1. Install the three packages from the registry (or `bun pm pack` tarballs before the first publish).
2. Add the script tag, `window.userId` and the gateway route to the host (§2).
3. Add the plugin to the host and to one Vite remote and one webpack remote (§3).
4. Mark one real grid (§4) and set one cap in the dev config.
5. Run §8 end to end. Record build time and bundle size before and after.
6. Write `docs/integration/dry-run-report.md`: every guide step that was wrong or missing, the
   real versions for §10, and any open question answered. Fix the guide in the same change.
7. Don't merge the branch. The pilot integration is a separate, reviewed change.

## Guidelines

**Do**
- Keep the host's existing MF `shared` config; the plugin needs no sharing change.
- Serve the recorder file from the host's origin, with the version in its name.
- Reference registry tokens and keys by environment variable or Secret only.
- Start each region dark (`allowUsers: []`) and widen in stages.
- Fix busy screens at the source first; use a rate cap only when a fix can't land soon.

**Don't**
- Proxy `/api/*` or the replay UI through the host's route (L3).
- Load the recorder from a CDN or another origin, or bundle it into a remote.
- Put the plugin after `federation()` in Vite, or skip it in a remote and expect state.
- Use NFS or CephFS for the server's data.
- Commit an `.npmrc` or `bunfig.toml` that holds a real token.

## Acceptance

- [ ] Following §1–§4 on a clean branch of the real workspace gives a replayable session with Redux state, in under a day, with no step missing from the guide.
- [ ] Every sample in `examples/` parses, and each example build config passes the plugin's outcome check (07-L2).
- [ ] Every code sample in the docs is labelled "Sample — not final code".
- [ ] The §8 checklist passes in the dry run, including the awkward states: a user not in `allowUsers`, the recorder file missing (404), the server down then back, a remote without the plugin, the kill switch flipped with the app open, and a logout/login in the same tab.
- [ ] A wrong plugin order fails the build with the documented message.
- [ ] The gateway passes gzip bodies through unchanged and returns the server's 413, not its own, for an oversized batch.
- [ ] Each region's replay UI shows only that region's sessions.
- [ ] Each troubleshooting row was reproduced once in the dry run, or is marked "not reproduced".

## Tasks

- [ ] **I1 Examples** — owns: `examples/**` — batch: B4 — depends on: 07 PL5–PL6 fixture apps; 04's recorder options; 05's config format — done when: `examples/{webpack5-host,vite7-remote,gateway,config}` exist; `bun test examples` parses each and checks plugin order.
- [ ] **I2 Guide pages** — owns: `docs/integration/**` (except the dry-run report) — batch: B4 — depends on: I1 — done when: §1–§12 exist as pages; every sample is labelled; a link check passes; reviewer passes.
- [ ] **I3 Publish dry run** — owns: `docs/integration/publishing.md` — batch: B5 — depends on: the 04 and state-plugin package builds — done when: `bun publish --dry-run` for each package lists only `dist/` and `package.json`; the page records the real registry once the user names it. (Package `files` and `publishConfig` belong to those packages' plans.)
- [ ] **I4 Real-workspace dry run** — owns: branch `sr/dry-run` in the real workspace; `docs/integration/dry-run-report.md` here — batch: B5 — depends on: I1–I3; a dev namespace with the server image — done when: §12 is complete and §8 passes. Run by the leader with the user, not a coder slice.
- [ ] **I5 Pilot rollout** — owns: region config (stages 0–2) — batch: B5 — depends on: I4; DPIA and staff notice — done when: stage 2's exit criteria are met. User-led.

## Risks

| Risk | Mitigation |
|---|---|
| The guide drifts from APIs that are still drafts (04, 05, state plugin). | Assumed names are marked; I1 derives from fixtures and is tested; I4 fixes the guide. |
| The real workspace's MF setup differs from the fixtures (manifest remotes, `@module-federation/enhanced`, a var remote). | The plugin keeps import specifiers, so sharing is untouched; the dry run covers one remote of each kind. |
| The gateway changes bodies or limits them below 1 MB. | §2c settings; an acceptance item. |
| OpenShift Routes can't share a host across namespaces by default. | Use the host's gateway (§2c). |
| Some stores use RTK `configureStore` and are silently not captured. | The troubleshooting row; ask the state-plugin plan to log a build warning when it sees `configureStore`. |
| The kill switch is slow for tabs that aren't uploading. | They read config on start and when visible again; the script-tag removal is the last resort. |
| A registry token or key ends up in a committed file. | Environment variables only; `bun publish --dry-run` file list reviewed; deny-by-default `.gitignore`. |
| The pilot starts before the DPIA is done. | Stage 1 is blocked on it (§6). |

## Open questions

Tracked in 01 as Q35–Q40.

1. Which internal npm registry and package scope (keep `@sr` or rename)?
2. Which image registry: the OpenShift internal one or a corporate registry?
3. What sits in front of the host shell in each region: an nginx gateway, an API gateway, or a plain Route?
4. 05 proposes config changes as reviewed ConfigMap edits (no admin API). Who may approve an allow-list, cap or kill-switch change in each region, and who can apply it out of hours?
5. Does the host already keep the user id on a global? Which path, for `userIdPath`?
6. Does the host send a CSP today? If so, `/sr/` and the recorder file need `connect-src` and `script-src 'self'`.
7. The real versions of React, Redux, AG Grid, flexlayout-react, webpack and Vite in the workspace.
8. Which 2–3 users and which desk for stage 1, and which region runs the pilot?

## Log

- 2026-11-10 — drafted for the plan split (agent)
- 2026-11-10 — Reviewed and merged into `plan/` by the leader. Aligned with 04 and 07: the loader and recorder bundles in one versioned folder (04-L17), `data-endpoint`, `window.SessionRecorder`, no pre-identify buffer, `srState.webpack()` / `srState.vite()` from `@sr/state-plugin`, the outcome check instead of a plugin-order rule, and `srAttach`.
