import { createHmac, timingSafeEqual } from 'node:crypto'
import pg from 'pg'
import { DATABASE_URL, sleep } from './db.ts'

export const WRITER_ROLE = 'acme_ops_landing_writer'

/**
 * The landing table, its notify trigger, and a role that may insert into it and nothing else.
 * The public receiver runs as that role, so a bug or a hostile body there can add rows but cannot
 * read, change or delete one. `handled` is a flag rather than a delete, so any event can be
 * replayed by clearing it.
 */
export async function setupLanding(db: pg.ClientBase | pg.Pool, schema = 'landing'): Promise<{ createdRole: boolean }> {
  const existed = (await db.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [WRITER_ROLE])).rowCount === 1
  await db.query(`
    DROP SCHEMA IF EXISTS ${schema} CASCADE;
    CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_id text NOT NULL UNIQUE,
      body jsonb NOT NULL,
      received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      stored_by name NOT NULL DEFAULT current_user,
      handled boolean NOT NULL DEFAULT false,
      handled_at timestamptz
    );
    -- What the handler does, one row per event id: the idempotency is this primary key.
    CREATE TABLE ${schema}.effects (event_id text PRIMARY KEY, account text NOT NULL, action text NOT NULL);
    -- The inline receiver's effects, with no key: one row per time the work ran.
    CREATE TABLE ${schema}.inline_effects (event_id text NOT NULL, account text NOT NULL, action text NOT NULL);
    CREATE FUNCTION ${schema}.notify_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_notify('${schema}_events', NEW.id::text); RETURN NULL; END $$;
    CREATE TRIGGER events_notify AFTER INSERT ON ${schema}.events FOR EACH ROW EXECUTE FUNCTION ${schema}.notify_event();
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${WRITER_ROLE}') THEN CREATE ROLE ${WRITER_ROLE} NOLOGIN; END IF;
    END $$;
    GRANT USAGE ON SCHEMA ${schema} TO ${WRITER_ROLE};
    GRANT INSERT ON ${schema}.events TO ${WRITER_ROLE};
  `)
  return { createdRole: !existed }
}

/**
 * Roles are cluster-wide and outlive the database, so a run that created the writer role drops
 * it: the landing schema (and with it every grant to the role) first, then the role.
 */
export async function teardownLanding(db: pg.ClientBase | pg.Pool, createdRole: boolean, schema = 'landing'): Promise<void> {
  await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  if (createdRole) await db.query(`DROP ROLE IF EXISTS ${WRITER_ROLE}`)
}

export const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex')

export type Delivery = { signature: string; body: string }

function verified(secret: string, d: Delivery): boolean {
  const want = Buffer.from(sign(secret, d.body))
  const got = Buffer.from(d.signature)
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * The public receiver: verify, store, acknowledge. It parses only the event id. The insert runs
 * as the insert-only role, so it is written in the one form that role may run: a bare
 * `ON CONFLICT DO NOTHING` (naming the conflict target, `(event_id)`, needs SELECT on that
 * column) and no RETURNING (which needs SELECT too). A redelivery of a stored event is a 200 and
 * no new row. Nothing here waits on the handler.
 */
export async function receive(writer: pg.ClientBase, secret: string, d: Delivery, schema = 'landing'): Promise<number> {
  if (!verified(secret, d)) return 401
  let eventId: unknown
  try {
    eventId = JSON.parse(d.body).event_id
  } catch {
    return 400
  }
  if (typeof eventId !== 'string') return 400
  await writer.query(`SET ROLE ${WRITER_ROLE}`)
  try {
    await writer.query(`INSERT INTO ${schema}.events (event_id, body) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [eventId, d.body])
  } finally {
    await writer.query('RESET ROLE')
  }
  return 200
}

export type Event = { event_id: string; account: string; action: string }
export type Handler = (db: pg.ClientBase, e: Event, schema: string) => Promise<void>

/** The handler the worker runs: one effect per event id, so running it twice changes nothing. */
export const handle: Handler = async (db, e, schema) => {
  await db.query(`INSERT INTO ${schema}.effects (event_id, account, action) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`, [e.event_id, e.account, e.action])
}

/**
 * The broken receiver: does the work before answering. `workMs` stands in for whatever the
 * handler waits on. A sender that gives up first retries, and every attempt does the work.
 */
export async function receiveInline(db: pg.Pool, secret: string, d: Delivery, workMs: number, schema = 'landing'): Promise<number> {
  if (!verified(secret, d)) return 401
  const e = JSON.parse(d.body) as Event
  await sleep(workMs)
  await db.query(`INSERT INTO ${schema}.inline_effects VALUES ($1, $2, $3)`, [e.event_id, e.account, e.action])
  return 200
}

/**
 * A sender the way webhook senders behave: wait `timeoutMs` for an answer, otherwise retry, up to
 * `attempts`. The receiver's work is not cancelled by the sender giving up. Returns the attempts
 * made and a promise for every request still in flight.
 */
export async function send(receiver: () => Promise<number>, timeoutMs: number, attempts: number) {
  const inflight: Promise<number>[] = []
  for (let i = 1; i <= attempts; i++) {
    const p = receiver()
    inflight.push(p)
    const status = await Promise.race([p, sleep(timeoutMs).then(() => 0)])
    if (status === 200) return { attempts: i, settled: Promise.all(inflight) }
  }
  return { attempts, settled: Promise.all(inflight) }
}

/**
 * The private worker: claim unhandled events (SKIP LOCKED, so a notify-driven drain and the
 * sweep can overlap without doing an event twice), run the handler, mark handled, one
 * transaction per event. Returns the events it handled.
 */
export async function drain(pool: pg.Pool, handler: Handler = handle, schema = 'landing'): Promise<string[]> {
  const done: string[] = []
  for (;;) {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      const { rows } = await c.query<{ id: number; body: Event }>(
        `SELECT id, body FROM ${schema}.events WHERE NOT handled ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      )
      if (!rows[0]) {
        await c.query('COMMIT')
        return done
      }
      await handler(c, rows[0].body, schema)
      await c.query(`UPDATE ${schema}.events SET handled = true, handled_at = clock_timestamp() WHERE id = $1`, [rows[0].id])
      await c.query('COMMIT')
      done.push(rows[0].body.event_id)
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    } finally {
      c.release()
    }
  }
}

/**
 * Drain the moment an event lands. One connection LISTENs; a notification during a drain asks
 * for one more pass after it, so nothing that arrives mid-drain waits for the sweep. The sweep
 * (calling `drain` on a timer) stays as the backstop for anything missed while this reconnects.
 */
export async function listen(pool: pg.Pool, onDrained: (ids: string[]) => void | Promise<void>, schema = 'landing'): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: DATABASE_URL, application_name: 'landing-listener' })
  await client.connect()
  let running = false
  let again = false
  let current: Promise<void> = Promise.resolve()
  const run = () => {
    if (running) return void (again = true)
    running = true
    current = (async () => {
      do {
        again = false
        await onDrained(await drain(pool, handle, schema))
      } while (again)
      running = false
    })()
  }
  client.on('notification', run)
  await client.query(`LISTEN ${schema}_events`)
  return async () => {
    await current
    await client.end()
  }
}

/**
 * Runs the handler for one stored event inside a transaction that is always rolled back, and
 * reports what it would have written. Nothing changes: not the effect, not the handled flag.
 */
export async function dryRun(pool: pg.Pool, id: number, schema = 'landing'): Promise<{ event?: Event; wouldWrite: number }> {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const { rows } = await c.query<{ body: Event }>(`SELECT body FROM ${schema}.events WHERE id = $1`, [id])
    if (!rows[0]) return { wouldWrite: 0 }
    const before = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${schema}.effects`)).rows[0]!.n
    await handle(c, rows[0].body, schema)
    const after = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${schema}.effects`)).rows[0]!.n
    return { event: rows[0].body, wouldWrite: after - before }
  } finally {
    await c.query('ROLLBACK')
    c.release()
  }
}

/**
 * When a sweep-only worker first sees an event: at the next sweep after it lands. Sweeps run at
 * every multiple of `intervalMs` since the clock's zero; `landedAtMs` is on the same clock.
 */
export const sweepWait = (landedAtMs: number, intervalMs: number) => intervalMs - (landedAtMs % intervalMs)
