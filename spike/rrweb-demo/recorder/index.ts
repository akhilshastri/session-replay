/**
 * Session recorder (spike). Stands in for the future recorder-service that sits outside every mini-app.
 *
 * Owns: rrweb recording, batching + upload, breadcrumb custom events, and the state bridge
 * (`window.__SR_BRIDGE__`) that apps talk to instead of importing us.
 * MUST NOT import React or any state library (see CLAUDE.md project rules).
 * Loaded by: ../demo/boot.ts. Receives uploads at: ../server.ts. Bridge users: ../demo/adapters.ts.
 */
import { record } from '@rrweb/record';
import { getRecordNetworkPlugin } from '@rrweb/rrweb-plugin-network-record';
import type { eventWithTime } from '@rrweb/types';

type StartOptions = { userId: string; endpoint: string };
type StoreKind = 'redux' | 'zustand' | string;
type Bridge = {
  registerStore: (name: string, kind: StoreKind, initialState: unknown) => void;
  emit: (name: string, change: { type: string; changes: Record<string, unknown> }) => void;
};

const FLUSH_MS = 3_000;
const FLUSH_COUNT = 50;
const KEEPALIVE_LIMIT = 60_000; // browsers cap keepalive bodies at 64 KB; leave headroom

// One session per tab and per user: switching ?user= in the same tab must not reuse the old session.
const sessionIdFor = (userId: string) => {
  try {
    const saved = JSON.parse(sessionStorage.getItem("sr_session") ?? "null") as { sessionId: string; userId: string } | null;
    if (saved?.userId === userId) return saved.sessionId;
  } catch {}
  const sessionId = crypto.randomUUID();
  sessionStorage.setItem("sr_session", JSON.stringify({ sessionId, userId }));
  return sessionId;
};

/** Short readable selector: tag#id.class1.class2 */
const shortSelector = (el: Element) => {
  const id = el.id ? `#${el.id}` : '';
  const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
  return `${el.tagName.toLowerCase()}${id}${cls}`;
};

const labelFor = (el: Element) => {
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return text || el.getAttribute('aria-label') || el.tagName.toLowerCase();
};

const isMasked = (el: Element | null | undefined) =>
  !!el && ((el as HTMLInputElement).type === 'password' || !!el.closest('.rr-mask'));

const fieldName = (el: HTMLInputElement) => {
  const labelled = el.labels?.[0]?.textContent?.trim();
  return el.name || labelled || el.getAttribute('aria-label') || el.placeholder || shortSelector(el);
};

// Bridge exists from module load so apps can register before start() finishes; calls before
// recording begins are queued (rrweb's addCustomEvent throws when not recording).
const pending: Array<() => void> = [];
let recording = false;
const custom = (tag: string, payload: unknown) => {
  const run = () => record.addCustomEvent(tag, payload);
  if (recording) run();
  else pending.push(run);
};

const kinds = new Map<string, StoreKind>();
const bridge: Bridge = {
  registerStore: (store, kind, state) => {
    kinds.set(store, kind);
    custom('state', { store, kind, op: 'snapshot', type: '@@init', state });
  },
  emit: (store, { type, changes }) => custom('state', { store, kind: kinds.get(store), op: 'change', type, changes }),
};
(window as unknown as { __SR_BRIDGE__: Bridge }).__SR_BRIDGE__ = bridge;

const installBreadcrumbs = () => {
  document.addEventListener(
    'click',
    (e) => {
      const target = (e.target as Element | null)?.closest('button, a, [role=button], input, label, select') ?? (e.target as Element | null);
      if (!target) return;
      custom('ui:click', { label: labelFor(target), selector: shortSelector(target) });
    },
    true,
  );
  document.addEventListener(
    'change',
    (e) => {
      const el = e.target as HTMLInputElement | null;
      if (!el || !('value' in el)) return;
      const value = isMasked(el) ? '***' : el.value;
      custom('ui:input', { field: fieldName(el), value });
    },
    true,
  );
  let lastNav = location.href;
  // hashchange and popstate both fire on a hash change, so de-dupe on URL.
  const nav = () => {
    if (location.href === lastNav) return;
    lastNav = location.href;
    custom('nav', { url: location.href });
  };
  window.addEventListener('hashchange', nav);
  window.addEventListener('popstate', nav);
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      nav();
      return result;
    };
  }
  window.addEventListener('error', (e) => custom('error', { message: e.message, source: e.filename, line: e.lineno }));
  window.addEventListener('unhandledrejection', (e) => custom('error', { message: `Unhandled rejection: ${String(e.reason)}` }));
};

const start = ({ userId, endpoint }: StartOptions) => {
  const sessionId = sessionIdFor(userId);
  const uploadUrl = `${endpoint}/api/sessions/${sessionId}/events`;
  let buffer: eventWithTime[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (unloading = false) => {
    clearTimeout(timer);
    timer = undefined;
    if (buffer.length === 0) return;
    const body = JSON.stringify({ userId, url: location.href, events: buffer });
    buffer = [];
    // keepalive survives page unload but is size-limited; oversized batches fall back to a plain fetch.
    const keepalive = unloading && body.length < KEEPALIVE_LIMIT;
    fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive }).catch(() => {});
  };

  record({
    emit: (event) => {
      buffer.push(event);
      if (buffer.length >= FLUSH_COUNT) flush();
      else timer ??= setTimeout(() => flush(), FLUSH_MS);
    },
    checkoutEveryNms: 60_000,
    // rrweb masks input VALUES only by type/tag, and `maskTextClass` only covers text nodes. So we turn on
    // masking for password + text inputs and let maskInputFn decide: always mask passwords, and mask
    // anything inside an `.rr-mask` element; other text inputs pass through unchanged.
    maskTextClass: 'rr-mask',
    maskInputOptions: { password: true, text: true },
    maskInputFn: (text, el) => (isMasked(el) ? '*'.repeat(text.length) : text),
    plugins: [
      getRecordNetworkPlugin({
        initiatorTypes: ['fetch', 'xmlhttprequest'],
        // Plugin only fills method + status for fetch/xhr when its own observers run, and those run only if
        // recordHeaders or recordBody is truthy. An object with both false enables them but records no headers.
        recordHeaders: { request: false, response: false },
        transformRequestFn: (req) => {
          // Our own uploads must not be recorded, else every flush records itself -> infinite loop.
          if (req.name.includes('/api/sessions')) return undefined;
          for (const headers of [req.requestHeaders, req.responseHeaders]) {
            if (!headers) continue;
            for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
          }
          return req;
        },
      }),
    ],
  });
  recording = true;
  pending.splice(0).forEach((run) => run());
  installBreadcrumbs();

  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
};

(window as unknown as { SessionRecorder: { start: typeof start } }).SessionRecorder = { start };
export { start };
