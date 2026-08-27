#!/usr/bin/env node
// 실 저장소 대상 read-only 확인. 쓰기는 하지 않는다.
//
// 단위 테스트는 fixture로 돌지만, 실제 응답 모양이 우리가 가정한 것과 같은지는 한 번
// 눈으로 봐야 한다. GitHub API가 바뀌거나 권한이 모자라면 여기서 먼저 드러난다.
//
//   node scripts/github-probe.ts <owner/repo> [thread-number]

import { GitHubClient, discoverToken } from '../adapters/github/client.ts'
import { GitHubEventSource, parseCursor } from '../adapters/github/event-source.ts'
import { GitHubScm } from '../adapters/github/scm.ts'

const [repo, threadNumber] = process.argv.slice(2)
if (!repo) {
  console.error('사용법: node scripts/github-probe.ts <owner/repo> [thread-number]')
  process.exit(2)
}

const token = await discoverToken()
if (!token) {
  console.error('토큰을 찾지 못했다. ASC_GITHUB_TOKEN 을 두거나 `gh auth login` 을 하라.')
  process.exit(2)
}

const client = new GitHubClient({ token })
const source = new GitHubEventSource({ client, repo, perPage: 10 })

console.log(`▶ ${repo} — 이벤트 수집 (read-only)`)
const first = await source.drain(null)
console.log(`  수집: ${first.events.length}건`)
for (const event of first.events.slice(0, 8)) {
  console.log(`  ${event.eventKey.padEnd(46)} ${event.reference.padEnd(24)} ${event.detectedAt}`)
}

const cursor = parseCursor(first.cursor)
console.log(`\n▶ cursor`)
console.log(`  ${JSON.stringify(cursor)}`)

console.log(`\n▶ 같은 cursor로 다시 — 중복이 걸러지는지`)
const second = await source.drain(first.cursor)
const before = new Set(first.events.map((e) => e.eventKey))
const overlap = second.events.filter((e) => before.has(e.eventKey))
console.log(`  2회차 수집: ${second.events.length}건, 그중 1회차와 겹치는 key: ${overlap.length}건`)
console.log(`  (겹친 것은 event key exact lookup으로 걸러진다 — 누락보다 중복이 안전하다)`)

if (threadNumber) {
  const scm = new GitHubScm({ client, defaultRepo: repo })
  const reference = `${repo}#${threadNumber}`
  console.log(`\n▶ ${reference} — 스레드 마지막 사건`)
  const thread = await scm.getThread(reference)
  console.log(`  ${thread.missing ? '읽지 못했다 (missing)' : thread.lastEventId}`)
}

console.log('\n쓰기는 하지 않았다.')
