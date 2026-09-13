#!/usr/bin/env node
// Explicit, development-only admin bootstrap for the LOCAL D1 database.
// Never used automatically and never seeds a default/known password.
//
// Usage:
//   node scripts/create-admin.mjs --email you@example.com --password 'choose-a-strong-one' [--remote]
//
// Produces the same password hash format as src/auth.ts (hashPassword):
//   pbkdf2$<saltHex>$<hashHex>  (PBKDF2-SHA-256, 100000 iterations, 32-byte key)
import { randomBytes, pbkdf2Sync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}

const email = arg('email')
const password = arg('password')
const remote = process.argv.includes('--remote')

if (!email || !password) {
  console.error('Usage: node scripts/create-admin.mjs --email <email> --password <password> [--remote]')
  process.exit(1)
}
if (password.length < 12) {
  console.error('Refusing weak password: use at least 12 characters.')
  process.exit(1)
}
if (remote) {
  console.error('Refusing --remote: this script is for local/dev D1 only. Rotate production credentials through your platform secret manager and an authenticated admin-management flow instead.')
  process.exit(1)
}

const salt = randomBytes(16)
const hash = pbkdf2Sync(password, salt, 100_000, 32, 'sha256')
const stored = `pbkdf2$${salt.toString('hex')}$${hash.toString('hex')}`

// Escape single quotes for the SQL literal.
const esc = (s) => s.replace(/'/g, "''")
const sql = `INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', '${esc(email)}', '${esc(stored)}', 'admin') ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin';`

console.log(`Creating/updating local admin for ${email} ...`)
// Confirmed bug (found via live audit testing): passing the SQL as a
// `--command` array element through execFileSync with shell:true on Windows
// gets the whole args array re-concatenated and re-tokenized by cmd.exe —
// spaces/parens inside the SQL string break it into "unknown arguments".
// Writing it to a temp .sql file and using --file sidesteps shell quoting
// entirely (same pattern the project's own db:seed script already uses).
const sqlFile = join(tmpdir(), `ww-admin-bootstrap-${Date.now()}.sql`)
writeFileSync(sqlFile, sql, 'utf8')
try {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'webapp-production', '--local', '--file', sqlFile], {
    stdio: 'inherit',
    shell: true
  })
} finally {
  try {
    unlinkSync(sqlFile)
  } catch {}
}
console.log('Done. This only touched your local D1 state (.wrangler/state) — nothing was sent anywhere else.')
