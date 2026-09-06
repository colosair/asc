// Remote Review — 사실을 검수한다. 승인을 다시 받지 않는다 (0.8.0 보정 §D·§E·§I).
//
// 여기서 지키는 경계가 둘이다.
//
//   ① 승인 ≠ 검수      사람이 "게시해" 라고 한 것은 결정권을 해결한다. 대상이 맞는지,
//                      승인한 commit 이 아직 그 commit 인지는 그 말이 답해 주지 않는다.
//   ② 검수 ≠ 정책      무엇을 해야 하는지는 프로젝트가 정한다. 검수는 "지금 이 외부
//                      상태에서 그것이 정확히 실행 가능한가" 만 본다 (SSAFESTA §5).

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import {
  identityOf,
} from '../adapters/gitlab/scm.ts'
import { reviewExternalAction, verifyAgainst, type RemoteFacts } from '../core/execution/remote-review.ts'

const facts = (over: Partial<RemoteFacts> = {}): RemoteFacts => ({
  provider: 'gitlab',
  capability: true,
  resource: 'group/project',
  ...over,
})

describe('사실이 맞으면 READY 다', () => {
  it('결합이 가리키는 그 저장소로 나가는 행위는 그대로 통과한다', () => {
    const outcome = reviewExternalAction({
      action: 'git.push',
      target: 'origin/front',
      facts: facts({ observed: { 'local.head': 'abc123', 'remote.sha': 'def456' } }),
      basis: { resource: 'group/project' },
    })
    assert.equal(outcome.verdict, 'READY')
    assert.deepEqual(outcome.findings, [])
    assert.equal(outcome.expected['sha'], 'abc123', '성공했다면 밖에서 무엇이 보여야 하는지 미리 적는다')
  })

  it('F-01 — 정본 branch 가 아니라는 이유로 막지 않는다 (SSAFESTA §3)', () => {
    // canonical = develop 은 "정본 판단의 기준" 이지 "develop 외 write 금지" 가 아니다.
    // 같은 저장소 안의 part branch 로 나가는 것은 프로젝트 정책의 자리이며, 검수는
    // 그것을 금지하지 않는다.
    for (const branch of ['front', 'back', 'ai', 'game', 'feat/x']) {
      const outcome = reviewExternalAction({
        action: 'git.push',
        target: `origin/${branch}`,
        facts: facts({ observed: { branch, 'local.head': 'abc123' } }),
        basis: { resource: 'group/project', sourceSha: 'abc123' },
      })
      assert.equal(outcome.verdict, 'READY', `${branch} 가 막혔다`)
    }
  })

  it('검수는 branch 정책 어휘를 모른다 — 그것은 프로젝트의 것이다 (SSAFESTA §5·§16)', async () => {
    const source = await readFile(new URL('../core/execution/remote-review.ts', import.meta.url), 'utf8')
    // 낱말이 아니라 **규칙**이 없어야 한다. `read back` 같은 산문은 정책이 아니므로
    // 경계에 붙여 본다.
    for (const word of ['develop', 'part branch', 'canonical', 'origin/front', 'branch policy']) {
      assert.ok(!source.includes(word), `Core 검수가 '${word}' 를 알고 있다`)
    }
    assert.doesNotMatch(source, /['"`](front|back|ai|game)['"`]/, 'Core 검수에 파트 이름이 박혀 있다')
  })
})

describe('사람이 봐야 하는 것 (REVIEW_REQUIRED)', () => {
  it('F-02 — 다른 저장소로 나가려 하면 스스로 범위를 넓히지 않는다', () => {
    const outcome = reviewExternalAction({
      action: 'git.push',
      target: 'origin/main',
      facts: facts({ resource: 'group/other' }),
      basis: { resource: 'group/project' },
    })
    assert.equal(outcome.verdict, 'REVIEW_REQUIRED')
    assert.equal(outcome.findings[0]!.code, 'BINDING_MISMATCH')
  })

  it('신원 비교는 형태가 아니라 신원으로 한다', () => {
    // git@host:group/p.git 과 https://host/group/p 는 같은 곳이다.
    assert.equal(identityOf('git@lab.example.com:group/project.git'), 'group/project')
    assert.equal(identityOf('https://lab.example.com/group/project'), 'group/project')
    const outcome = reviewExternalAction({
      action: 'git.push',
      target: 'origin/front',
      facts: facts({ resource: 'Group/Project.git' }),
      basis: { resource: 'group/project' },
    })
    assert.equal(outcome.verdict, 'READY')
  })

  it('같은 것이 이미 있으면 고르지 않는다', () => {
    const outcome = reviewExternalAction({
      action: 'gitlab.mr.create',
      target: 'group/project',
      facts: facts({ ambiguity: ['!12 is already open from front into develop'] }),
      basis: { resource: 'group/project' },
    })
    assert.equal(outcome.verdict, 'REVIEW_REQUIRED')
  })

  it('모르는 것을 무조건 차단으로 번역하지 않는다 (§E)', () => {
    const outcome = reviewExternalAction({
      action: 'git.push',
      target: 'origin/front',
      facts: facts({ unknown: ['remote ref front'] }),
      basis: { resource: 'group/project' },
    })
    assert.equal(outcome.verdict, 'REVIEW_REQUIRED', '모르는 것은 사람이 볼 일이지 실행 불가가 아니다')
  })
})

describe('지금 성립하지 않는 것 (NOT_EXECUTABLE)', () => {
  it('T-10 — 승인한 commit 과 지금의 HEAD 가 다르면 나가지 않는다', () => {
    const outcome = reviewExternalAction({
      action: 'git.push',
      target: 'origin/front',
      facts: facts({ observed: { 'local.head': 'def456' } }),
      basis: { resource: 'group/project', sourceSha: 'abc123' },
    })
    assert.equal(outcome.verdict, 'NOT_EXECUTABLE')
    assert.equal(outcome.findings[0]!.code, 'DRIFT')
  })

  it('승인 뒤 원격이 움직였으면 나가지 않는다', () => {
    const outcome = reviewExternalAction({
      action: 'git.push',
      target: 'origin/front',
      facts: facts({ observed: { 'remote.sha': 'zzz999' } }),
      basis: { resource: 'group/project', remoteBaseline: 'def456' },
    })
    assert.equal(outcome.verdict, 'NOT_EXECUTABLE')
  })

  it('할 수 없는 행위는 승인 뒤가 아니라 여기서 멈춘다', () => {
    const outcome = reviewExternalAction({
      action: 'gitlab.mr.merge',
      target: 'group/project!7',
      facts: facts({ capability: false }),
    })
    assert.equal(outcome.verdict, 'NOT_EXECUTABLE')
    assert.equal(outcome.findings[0]!.code, 'NO_CAPABILITY')
  })
})

describe('T-11 — 되돌려 읽은 것이 기대와 다르면 성공이 아니다', () => {
  it('SHA 가 다르면 mismatch 로 남는다', () => {
    const verdict = verifyAgainst({ sha: 'abc123' }, { sha: 'def456' }, ['sha'])
    assert.equal(verdict.ok, false)
    assert.equal(verdict.mismatches.length, 1)
  })

  it('읽히지 않은 것을 맞다고 치지 않는다', () => {
    const verdict = verifyAgainst({ sha: 'abc123' }, { sha: undefined }, ['sha'])
    assert.equal(verdict.ok, false)
    assert.match(verdict.mismatches[0]!, /could not be read back/)
  })

  it('같으면 통과한다 — 형태 차이는 신원 차이가 아니다', () => {
    const verdict = verifyAgainst({ resource: 'group/project' }, { resource: 'Group/Project' }, ['resource'])
    assert.equal(verdict.ok, true)
  })
})
