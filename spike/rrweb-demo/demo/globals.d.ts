// Globals installed by ../recorder/index.ts. Apps only see the bridge, never the recorder module.
interface Window {
  SessionRecorder: { start: (opts: { userId: string; endpoint: string }) => void };
  __SR_BRIDGE__?: {
    registerStore: (name: string, kind: string, initialState: unknown) => void;
    emit: (name: string, change: { type: string; changes: Record<string, unknown> }) => void;
  };
}
