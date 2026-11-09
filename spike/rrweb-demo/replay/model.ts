/**
 * Pure helpers for the replay UI: turn raw rrweb events into action-list rows and compute app state
 * at a point in time. No React, no DOM. Used by ./Player.tsx and ./main.tsx.
 */
import type { eventWithTime, NetworkData } from '@rrweb/types';
import { PLUGIN_NAME } from '@rrweb/rrweb-plugin-network-record';

export type Row = { t: number; kind: string; text: string; error?: boolean };
type StateEvent = { t: number; store: string; op: 'snapshot' | 'change'; payload: Record<string, unknown> };

const CUSTOM = 5; // EventType.Custom
const PLUGIN = 6; // EventType.Plugin (the enum is a runtime value in @rrweb/types; plain numbers keep this file import-light)

type Custom = { tag: string; payload: Record<string, any> };
const asCustom = (e: eventWithTime): Custom | null => (e.type === CUSTOM ? (e.data as Custom) : null);

const pathOf = (url: string) => {
  try {
    const u = new URL(url, location.href);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

/** Builds the action list. `t` is the offset in ms from the first event (same base as Replayer.getCurrentTime). */
export const buildRows = (events: eventWithTime[]): Row[] => {
  const base = events[0]?.timestamp ?? 0;
  const rows: Row[] = [];
  for (const e of events) {
    const t = e.timestamp - base;
    const c = asCustom(e);
    if (c) {
      const p = c.payload;
      if (c.tag === 'ui:click') rows.push({ t, kind: 'click', text: `${p.label} (${p.selector})` });
      else if (c.tag === 'ui:input') rows.push({ t, kind: 'input', text: `${p.field} = ${p.value}` });
      else if (c.tag === 'nav') rows.push({ t, kind: 'nav', text: String(p.url) });
      else if (c.tag === 'error') rows.push({ t, kind: 'error', text: String(p.message), error: true });
      else if (c.tag === 'state' && p.op === 'change') rows.push({ t, kind: 'state', text: `${p.store}: ${p.type}` });
      continue;
    }
    if (e.type === PLUGIN && (e.data as { plugin: string }).plugin === PLUGIN_NAME) {
      const data = (e.data as { payload: NetworkData }).payload;
      for (const r of data.requests) {
        if (r.isInitial) continue; // skip page-load resource timings; only fetch/xhr matter here
        const status = r.status ?? 0;
        rows.push({ t, kind: 'net', text: `${r.method ?? r.initiatorType ?? 'req'} ${pathOf(r.name)} ${status || '(no status)'}`, error: status >= 400 });
      }
    }
  }
  return rows;
};

const stateEvents = (events: eventWithTime[]): StateEvent[] => {
  const base = events[0]?.timestamp ?? 0;
  const out: StateEvent[] = [];
  for (const e of events) {
    const c = asCustom(e);
    if (c?.tag !== 'state') continue;
    const p = c.payload;
    out.push({ t: e.timestamp - base, store: p.store, op: p.op, payload: (p.op === 'snapshot' ? p.state : p.changes) ?? {} });
  }
  return out;
};

/** Per store: last snapshot at or before `t`, then every later change up to `t` merged on top. */
export const stateAt = (all: StateEvent[], t: number): Record<string, unknown> => {
  const result: Record<string, Record<string, unknown>> = {};
  for (const s of all) {
    if (s.t > t) {
      // Nothing recorded yet for this store (e.g. t=0): show its first snapshot rather than an empty panel.
      if (!(s.store in result) && s.op === "snapshot") result[s.store] = { ...s.payload };
      continue;
    }
    result[s.store] = s.op === 'snapshot' ? { ...s.payload } : { ...result[s.store], ...s.payload };
  }
  return result;
};

export const prepareState = stateEvents;
export type StateTimeline = ReturnType<typeof stateEvents>;

export const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
