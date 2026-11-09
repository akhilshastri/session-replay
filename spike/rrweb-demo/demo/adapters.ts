/**
 * Adapters that connect app state stores to the recorder's window.__SR_BRIDGE__.
 * Stand in for a future build plugin that would inject this automatically.
 * Apps never import the recorder; if the bridge is absent (no recorder) these are no-ops.
 */
import type { Reducer, UnknownAction } from '@reduxjs/toolkit';
import type { StoreApi } from 'zustand';

const bridge = () => window.__SR_BRIDGE__;

/** Top-level keys whose reference changed, with their new values (functions skipped). */
const diff = (prev: Record<string, unknown>, next: Record<string, unknown>) => {
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(next)) {
    if (prev[key] !== next[key] && typeof next[key] !== 'function') changes[key] = next[key];
  }
  return changes;
};

/**
 * Wrap the ROOT REDUCER, not store.dispatch: thunks bypass a patched dispatch,
 * but every action ends up in the reducer.
 */
export const wrapReducer = <S extends object>(name: string, reducer: Reducer<S>): Reducer<S> => (state, action) => {
  const next = reducer(state, action);
  if (state !== undefined && next !== state) {
    const changes = diff(state as Record<string, unknown>, next as Record<string, unknown>);
    if (Object.keys(changes).length) bridge()?.emit(name, { type: (action as UnknownAction).type, changes });
  }
  return next;
};

export const registerReduxSnapshot = (name: string, getState: () => unknown) =>
  bridge()?.registerStore(name, 'redux', getState());

export const connectZustand = <S extends object>(name: string, store: StoreApi<S>) => {
  bridge()?.registerStore(name, 'zustand', store.getState());
  store.subscribe((next, prev) => {
    const changes = diff(prev as Record<string, unknown>, next as Record<string, unknown>);
    if (Object.keys(changes).length) bridge()?.emit(name, { type: 'set', changes });
  });
};
