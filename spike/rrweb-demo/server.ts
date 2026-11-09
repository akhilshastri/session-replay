/**
 * Spike server: serves the demo app (/), the replay UI (/replay) and a tiny sessions API.
 * Storage is bun:sqlite in ./data/sessions.db (gitignored). Bun bundles the TSX/CSS via HTML imports.
 * Throwaway: no auth, no retention, no pagination.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import demo from './demo/index.html';
import replay from './replay/index.html';

mkdirSync(`${import.meta.dir}/data`, { recursive: true });
const db = new Database(`${import.meta.dir}/data/sessions.db`);
db.run('PRAGMA journal_mode = WAL');
db.run(`CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, day TEXT NOT NULL,
  started_at INTEGER NOT NULL, last_at INTEGER NOT NULL, event_count INTEGER NOT NULL DEFAULT 0, url TEXT)`);
db.run(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL, json TEXT NOT NULL)`);
db.run('CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts)');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^\d{8}$/;
const yyyymmdd = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

type Batch = { userId?: string; url?: string; events?: Array<{ timestamp: number }> };

const upsertSession = db.prepare(`INSERT INTO sessions (id, user_id, day, started_at, last_at, event_count, url)
  VALUES ($id, $user, $day, $first, $last, $n, $url)
  ON CONFLICT(id) DO UPDATE SET last_at = max(last_at, $last), event_count = event_count + $n, url = $url`);
const insertEvent = db.prepare('INSERT INTO events (session_id, ts, json) VALUES (?, ?, ?)');

const saveBatch = db.transaction((id: string, user: string, url: string, events: NonNullable<Batch['events']>) => {
  const stamps = events.map((e) => e.timestamp);
  const first = Math.min(...stamps);
  upsertSession.run({ $id: id, $user: user, $day: yyyymmdd(first), $first: first, $last: Math.max(...stamps), $n: events.length, $url: url });
  for (const e of events) insertEvent.run(id, e.timestamp, JSON.stringify(e));
});

Bun.serve({
  port: 3300,
  development: true,
  routes: {
    '/': demo,
    '/replay': replay,
    '/api/sessions/:id/events': {
      POST: async (req) => {
        const { id } = req.params;
        if (!ID_RE.test(id)) return new Response('bad session id', { status: 400 });
        const body = (await req.json().catch(() => null)) as Batch | null;
        if (!body?.userId || !ID_RE.test(body.userId) || !Array.isArray(body.events) || body.events.length === 0) {
          return new Response('bad body', { status: 400 });
        }
        saveBatch(id, body.userId, String(body.url ?? ''), body.events);
        return new Response(null, { status: 204 });
      },
      GET: (req) => {
        const { id } = req.params;
        if (!ID_RE.test(id)) return new Response('bad session id', { status: 400 });
        const rows = db.query('SELECT json FROM events WHERE session_id = ? ORDER BY ts, id').all(id) as { json: string }[];
        return new Response(`[${rows.map((r) => r.json).join(',')}]`, { headers: { 'Content-Type': 'application/json' } });
      },
    },
    '/api/sessions': (req) => {
      const q = new URL(req.url).searchParams;
      const user = q.get('user') ?? '';
      const day = q.get('day') ?? '';
      if (user && !ID_RE.test(user)) return new Response('bad user', { status: 400 });
      if (day && !DAY_RE.test(day)) return new Response('bad day', { status: 400 });
      const rows = db
        .query(`SELECT * FROM sessions WHERE ($user = '' OR user_id = $user) AND ($day = '' OR day = $day) ORDER BY started_at DESC`)
        .all({ $user: user, $day: day });
      return Response.json(rows);
    },
    '/api/demo/order': {
      POST: async (req) => {
        const { total } = (await req.json().catch(() => ({}))) as { total?: number };
        if (typeof total === 'number' && total > 500) return Response.json({ error: 'Payment declined: total too high' }, { status: 500 });
        return Response.json({ ok: true, orderId: crypto.randomUUID().slice(0, 8) });
      },
    },
  },
});
console.log('rrweb-demo: demo http://localhost:3300  replay http://localhost:3300/replay');
