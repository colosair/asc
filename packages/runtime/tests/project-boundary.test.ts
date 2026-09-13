// 프로젝트 정책 계층과의 책임 경계.
//
// ASC 는 그 프로젝트의 업무 규칙을 소유하지 않는다. 어느 branch 가 파트 branch 인지,
// 언제 develop 을 반영하는지, 어떤 문서를 회수하는지는 프로젝트 정책의 자리다.
// ASC 가 지는 몫은 그 정책이 정한 행동을 **지금 이 외부 상태에서 정확히 실행 가능한가**,
// 그리고 그 실행이 승인·검수·감사를 지나는가뿐이다.
//
// 여기 있는 검사들은 그 경계가 코드에서 실제로 지켜지는지 본다. 프로젝트 쪽 스킬을
// 흉내 내지 않는다 — 그것은 이 저장소의 것이 아니다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { CLAUDE_PROVIDER, claudeBindings } from '../adapters/claude-code/binding.ts'
import { MarkdownStateStore } from '../adapters/markdown/state-store.ts'
import { writeExecutionMode } from '../core/policy/execution-mode.ts'
import { tempDir } from './support/temp.ts'

const NOW = '2026-09-07T10:00:00+09:00'

const core = async (path: string): Promise<string> =>
  readFile(new URL(`../${path}`, import.meta.url), 'utf8')

describe('ASC Core 는 프로젝트 workflow 를 들고 있지 않다 (§1·§16)', () => {
  it('파트 branch·정본 branch 이름이 Core 에 박혀 있지 않다', async () => {
    for (const path of [
      'core/execution/remote-review.ts',
      'core/execution/executor.ts',
      'core/policy/execution-mode.ts',
    ]) {
      const source = await core(path)
      assert.doesNotMatch(source, /['"`](develop|front|back|ai|game)['"`]/, `${path} 에 branch 이름이 있다`)
    }
  })

  it('정본(canonical)이 쓰기 금지 목록으로 쓰이지 않는다 (§3)', async () => {
    // canonical 은 "무엇을 기준으로 판단하는가" 이지 "어디에만 쓸 수 있는가" 가 아니다.
    // 검수는 저장소 신원만 견주고, branch 는 사실로만 관측한다.
    const review = await core('core/execution/remote-review.ts')
    assert.ok(!review.includes('canonical'), '검수가 정본 개념을 판정에 쓴다')
    assert.match(review, /BINDING_MISMATCH/)
    // 결합 비교의 대상은 resource(저장소 신원) 하나다.
    assert.match(review, /basis\?\.resource/)
  })

  it('F-06 — Inbox 상태는 한 곳이다. 프로젝트용 사본을 만들지 않는다', async () => {
    // 프로젝트 계층이 자기 방식으로 걸러 보여 주는 것은 표현이다. 그 표현이 자기
    // 결정 상태를 따로 저장하기 시작하면 두 장부가 갈리고, 그때부터 무엇이 정본인지
    // 아무도 모른다. ASC 쪽에서 지킬 수 있는 것은 "여기에 사본을 만들지 않는다" 다.
    const cli = await core('cli/asc.ts')
    const readers = cli.match(/new LocalOperator\(/g) ?? []
    assert.ok(readers.length > 0, 'Inbox 를 읽는 자리가 있다')
    // 판단 상태를 담는 다른 저장소를 CLI 가 만들지 않는다.
    assert.ok(!/new\s+\w*Inbox\w*Store/.test(cli), 'Inbox 용 별도 저장소가 있다')
    assert.ok(!/decisions\.json|inbox-state/.test(cli), 'Inbox 상태 사본 파일이 있다')
  })

  it('F-05 — work finish 는 논리 세션 하나를 닫는다. 프로젝트 전체 인계를 대신하지 않는다', async () => {
    const cli = await core('cli/asc.ts')
    const start = cli.indexOf('async function runWork(')
    const body = cli.slice(start, cli.indexOf('\n}\n', start))
    const finish = body.slice(body.indexOf("case 'finish'"), body.indexOf("case 'publish'"))
    // 닫는 것은 세션과 그 결합·수거뿐이다. 프로젝트 문서·파트 상태·branch 상황은 없다.
    assert.match(finish, /runSession\('done'/)
    assert.match(finish, /runController\('collect'/)
    for (const beyond of ['branch', 'document', 'part', 'handoff.md']) {
      assert.ok(!finish.includes(beyond), `work finish 가 ${beyond} 까지 손댄다`)
    }
  })
})
