/**
 * Machine-checkable audit of the raw fault-injection artifacts.
 *
 * It does not import the scheduler's replay code: it re-implements the journal
 * hash formula from the documented schema, so a bug in the scheduler cannot
 * make its own artifacts look valid.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const summaryPath = path.join(here, 'fault-report.json')
if (!fs.existsSync(summaryPath)) {
  console.error('missing fault-report.json; run node tests/fault/run.mjs first')
  process.exit(1)
}
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
const reportPath = path.join(summary.artifactDir, 'fault-report.json')
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function verifyJournal(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  const events = []
  let prevHash = null
  let expectedSeq = null
  let truncated = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '') {
      if (index !== lines.length - 1) return { ok: false, reason: `blank line ${index + 1}` }
      continue
    }
    let event
    try {
      event = JSON.parse(line)
    } catch {
      if (index === lines.length - 1) {
        truncated = true
        break
      }
      return { ok: false, reason: `unparseable line ${index + 1}` }
    }
    if (expectedSeq !== null && event.seq !== expectedSeq) {
      return { ok: false, reason: `seq gap at line ${index + 1}` }
    }
    if (prevHash !== null && event.prev !== prevHash) {
      return { ok: false, reason: `prev mismatch at line ${index + 1}` }
    }
    const { hash, prev, ...body } = event
    const canonical = {
      v: event.v,
      seq: event.seq,
      at: event.at,
      type: event.type,
      ...Object.fromEntries(Object.entries(event).filter(([key]) => !['v', 'seq', 'at', 'type', 'prev', 'hash'].includes(key))),
    }
    const expectedHash = sha256(`${prevHash ?? ''}${stableStringify(canonical)}`)
    if (hash !== expectedHash) return { ok: false, reason: `hash mismatch at line ${index + 1}` }
    prevHash = hash
    expectedSeq = event.seq + 1
    events.push(event)
  }
  return { ok: events.length > 0, events: events.length, truncated }
}

const failures = []
const checks = []
for (const result of report.results) {
  if (!result.pass) failures.push(`${result.scenario}: scenario did not pass`)
  if (!result.verify?.ok) failures.push(`${result.scenario}: scheduler verify() failed`)
  const journalFile = path.join(summary.artifactDir, `${result.scenario}.journal.jsonl`)
  const journalCheck = fs.existsSync(journalFile) ? verifyJournal(journalFile) : { ok: false, reason: 'missing journal' }
  if (!journalCheck.ok) failures.push(`${result.scenario}: ${journalCheck.reason}`)
  for (const task of result.tasks ?? []) {
    if (task.status === 'succeeded' && task.result?.error) {
      failures.push(`${result.scenario}: succeeded task ${task.id} carries an error`)
    }
  }
  checks.push({ scenario: result.scenario, pass: result.pass, verify: result.verify?.ok, journal: journalCheck })
}

const output = {
  audit: failures.length === 0 ? 'PASS' : 'FAIL',
  checkedAt: new Date().toISOString(),
  artifactDir: summary.artifactDir,
  scenarios: checks.length,
  failures,
  checks,
}
fs.writeFileSync(path.join(summary.artifactDir, 'independent-check.json'), JSON.stringify(output, null, 2))
console.log(JSON.stringify(output, null, 2))
if (failures.length > 0) process.exitCode = 1
