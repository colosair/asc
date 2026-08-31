#!/usr/bin/env node
// Repository presentation drift check — read-only, maintenance-time.
//
// The README was overhauled once while the GitHub About panel stayed empty for
// months; nothing tracked what the repo page was SUPPOSED to say. The expected
// state now lives in .github/repo-metadata.json, and this compares it against
// the live repository. It is deliberately not a release gate: publishing to
// npm must never fail because the GitHub API had weather.

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const expected = JSON.parse(await readFile(join(root, '.github', 'repo-metadata.json'), 'utf8'))
const REPO = 'colosair/asc'

const headers = { 'User-Agent': 'presentation-check' }
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  OK  ' : '  DRIFT'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const repo = await (await fetch(`https://api.github.com/repos/${REPO}`, { headers })).json()
check(repo.description === expected.description, 'description', String(repo.description))
check(repo.homepage === expected.homepage, 'homepage', String(repo.homepage))
check(
  JSON.stringify([...(repo.topics ?? [])].sort()) === JSON.stringify([...expected.topics].sort()),
  'topics',
  (repo.topics ?? []).join(', ') || '(none)',
)
check(repo.license?.spdx_id === expected.license, 'detected license', String(repo.license?.spdx_id))

const security = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${expected.securityPolicy}`, { headers })
check(security.ok, `security policy present (${expected.securityPolicy})`)

console.log(failures === 0 ? '\npresentation matches the tracked expectation' : `\npresentation drift: ${failures}`)
process.exitCode = failures === 0 ? 0 : 1
