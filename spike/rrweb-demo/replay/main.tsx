/** Replay UI: session list | player | action list + state panel. Talks to /api/sessions on the spike server. */
import type { eventWithTime } from '@rrweb/types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { buildRows, fmtClock, prepareState, stateAt } from './model';
import { SPEEDS, usePlayer } from './usePlayer';

type Session = { id: string; user_id: string; day: string; started_at: number; last_at: number; event_count: number };

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString();

const SessionList = ({ selected, onSelect }: { selected: string | null; onSelect: (s: string) => void }) => {
  const [user, setUser] = useState('');
  const [date, setDate] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  useEffect(() => {
    const q = new URLSearchParams();
    if (user) q.set('user', user);
    if (date) q.set('day', date.replaceAll('-', ''));
    fetch(`/api/sessions?${q}`).then((r) => (r.ok ? r.json() : [])).then(setSessions);
  }, [user, date]);
  return (
    <aside className="left">
      <input placeholder="User id" value={user} onChange={(e) => setUser(e.target.value.trim())} />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <ul className="sessions">
        {sessions.map((s) => (
          <li key={s.id} className={s.id === selected ? 'active' : ''} onClick={() => onSelect(s.id)}>
            <b>{s.user_id}</b> <span>{fmtTime(s.started_at)}</span>
            <small>
              {fmtClock(s.last_at - s.started_at)} · {s.event_count} events
            </small>
          </li>
        ))}
        {sessions.length === 0 && <li className="empty">No sessions</li>}
      </ul>
    </aside>
  );
};

const App = () => {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<eventWithTime[] | null>(null);
  useEffect(() => {
    setEvents(null);
    if (sessionId) fetch(`/api/sessions/${sessionId}/events`).then((r) => r.json()).then(setEvents);
  }, [sessionId]);

  const tooShort = !!events && events.length < 2;
  const rows = useMemo(() => (events ? buildRows(events) : []), [events]);
  const timeline = useMemo(() => (events ? prepareState(events) : []), [events]);
  const { rootRef, current, total, playing, speed, seek, toggle, setSpeed } = usePlayer(events);

  const activeIdx = rows.reduce((acc, r, i) => (r.t <= current ? i : acc), -1);
  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  // Back/Next jump between action rows; 50 ms tolerance so Back from a row's own time goes to the previous one.
  // Seeks use row.t + 1 because Replayer applies only events with timestamp < baseline (strict).
  const prevRow = [...rows].reverse().find((r) => r.t < current - 50);
  const nextRow = rows.find((r) => r.t > current + 50);
  const states = useMemo(() => stateAt(timeline, current), [timeline, current]);

  return (
    <div className="layout">
      <SessionList selected={sessionId} onSelect={setSessionId} />
      <section className="center">
        {!sessionId && <p className="msg">Pick a session on the left.</p>}
        {sessionId && !events && <p className="msg">Loading...</p>}
        {tooShort && <p className="msg">This session has fewer than 2 events, nothing to replay.</p>}
        <div className="stage" ref={rootRef} style={{ display: events && !tooShort ? 'block' : 'none' }} />
        {events && !tooShort && (
          <div className="controls">
            <div className="row">
              <button onClick={() => prevRow && seek(prevRow.t + 1)} disabled={!prevRow}>◀ Back</button>
              <button className="primary" onClick={toggle}>{playing ? 'Pause' : 'Play'}</button>
              <button onClick={() => nextRow && seek(nextRow.t + 1)} disabled={!nextRow}>Next ▶</button>
              <span className="speeds">
                {SPEEDS.map((s) => (
                  <button key={s} className={s === speed ? 'on' : ''} onClick={() => setSpeed(s)}>{s}x</button>
                ))}
              </span>
              <span className="clock">{fmtClock(current)} / {fmtClock(total)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={total}
              value={Math.min(current, total)}
              onChange={(e) => seek(Number(e.target.value))}
            />
          </div>
        )}
      </section>
      <aside className="right">
        <div className="panel actions">
          <h3>Actions</h3>
          <ul>
            {rows.map((r, i) => (
              <li
                key={i}
                ref={i === activeIdx ? activeRef : undefined}
                className={`${i === activeIdx ? 'active' : ''} ${r.error ? 'err' : ''}`}
                onClick={() => seek(r.t + 1)}
              >
                <time>{fmtClock(r.t)}</time>
                <em>{r.kind}</em>
                <span>{r.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel state">
          <h3>State @ {fmtClock(current)}</h3>
          {Object.entries(states).map(([store, s]) => (
            <details key={store} open>
              <summary>{store}</summary>
              <pre>{JSON.stringify(s, null, 2)}</pre>
            </details>
          ))}
        </div>
      </aside>
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<App />);
