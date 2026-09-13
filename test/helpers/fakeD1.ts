// Deterministic D1Database test double backed by Node's built-in node:sqlite.
// No network calls, no real Cloudflare account/binding required. Enough of
// the D1 surface (prepare/bind/first/run/all/batch) for unit and integration
// tests that exercise real SQL against real schema/migrations.
import { DatabaseSync } from 'node:sqlite'

type Row = Record<string, unknown>

class FakeStatement {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: unknown[] = []
  ) {}

  bind(...params: unknown[]) {
    return new FakeStatement(this.db, this.sql, params)
  }

  async first<T = Row>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql)
    const row = stmt.get(...(this.params as never[])) as T | undefined
    return row ?? null
  }

  async run() {
    const stmt = this.db.prepare(this.sql)
    const info = stmt.run(...(this.params as never[]))
    return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: info.changes } }
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true }> {
    const stmt = this.db.prepare(this.sql)
    const results = stmt.all(...(this.params as never[])) as T[]
    return { results, success: true }
  }
}

export class FakeD1Database {
  private db: DatabaseSync

  constructor() {
    this.db = new DatabaseSync(':memory:')
  }

  prepare(sql: string) {
    return new FakeStatement(this.db, sql)
  }

  async batch(stmts: FakeStatement[]) {
    const out = []
    for (const s of stmts) out.push(await s.run())
    return out
  }

  exec(sql: string) {
    this.db.exec(sql)
  }

  close() {
    this.db.close()
  }
}

export function createFakeD1() {
  return new FakeD1Database() as unknown as D1Database
}
