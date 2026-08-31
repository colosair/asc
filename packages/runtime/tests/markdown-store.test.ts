// B-04 Gate — 파일 왕복이 무손실인지, 동시 경쟁에서 파일이 깨지지 않는지.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { MarkdownStateStore } from '../adapters/markdown/state-store.ts'
import { ParseError, parseEntity, serializeEntity } from '../adapters/markdown/serialize.ts'
import { toFileName } from '../adapters/markdown/layout.ts'
import { ApprovalRequest, Handoff, Session } from '../core/model/entities.ts'
import { transitionRequest, transitionSession } from '../core/model/transitions.ts'
import { describeStateStoreContract, sampleRequest } from './support/state-store-contract.ts'

const roots: string[] = []

async function freshStore(): Promise<MarkdownStateStore> {
  const root = await mkdtemp(join(tmpdir(), 'asc-md-'))
  roots.push(root)
  return MarkdownStateStore.open(join(root, '.asc'))
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

// in-memory 구현과 똑같은 계약 테스트를 통과해야 한다 — 그래야 Adapter 교체가 말이 된다
describeStateStoreContract('markdown', freshStore)

describe('파일 표현', () => {
  const NOW = '2026-08-22T10:00:00+09:00'

  it('직렬화 → 파싱 왕복이 무손실이다', () => {
    const session = Session.parse({
      id: 'S-20260822-01',
      version: 3,
      status: 'DONE',
      role: 'implementer',
      goal: '한글 목표 · 특수문자 "인용" & <태그>',
      writeBoundary: ['frontend/src/studio/**'],
      policyExceptions: ['dependency.add'],
      canonicalSources: [{ sourceId: 'shared-spec', baseline: 'abc123' }],
      handoff: Handoff.parse({
        done: ['T-004'],
        changed: ['a.ts'],
        verified: 'self-check',
        unresolved: ['미결 1', '미결 2'],
        next: '다음 작업',
        snapshot: [{ sourceId: 'shared-spec', baseline: 'abc123' }],
        recordedAt: NOW,
      }),
    })
    assert.deepEqual(parseEntity(serializeEntity('session', session)), session)
  })

  it('사람이 읽는 본문과 기계가 읽는 블록이 한 파일에 같이 있다', async () => {
    const store = await freshStore()
    await store.create('request', sampleRequest())
    const text = await readFile(join(store.root, 'monitor/inbox/REQ-0042.md'), 'utf8')

    assert.match(text, /<!-- asc:entity/)
    assert.match(text, /# REQ-0042 · P0 · Issue #19/)
    assert.match(text, /## 답변 초안/)
    assert.match(text, /- shared-spec @ abc123/)
    // 본문을 지워도 데이터는 JSON 블록에 남아 있다
    assert.deepEqual((parseEntity(text) as ApprovalRequest).snapshot, [{ sourceId: 'shared-spec', baseline: 'abc123' }])
  })

  it('본문만 고친 파일도 그대로 읽힌다 — 정본은 JSON 블록이다', async () => {
    const store = await freshStore()
    await store.create('request', sampleRequest())
    const file = join(store.root, 'monitor/inbox/REQ-0042.md')

    const text = await readFile(file, 'utf8')
    await writeFile(file, text + '\n\n사람이 덧붙인 메모\n', 'utf8')
    assert.equal((await store.get('request', 'REQ-0042'))!.title, 'Issue #19 답변 승인 필요')

    // 다음 저장에서 본문은 다시 그려진다
    const current = (await store.get('request', 'REQ-0042'))!
    await store.compareAndSet(
      'request',
      'REQ-0042',
      current.version,
      transitionRequest(current, 'DISMISSED', 'controller', {
        decision: { kind: 'dismiss', actor: 'controller-a', channel: 'local', decidedAt: NOW },
      }),
    )
    assert.doesNotMatch(await readFile(file, 'utf8'), /사람이 덧붙인 메모/)
  })

  it('깨진 파일은 조용히 넘어가지 않는다', () => {
    assert.throws(() => parseEntity('# 제목만 있는 파일', 'x.md'), ParseError)
    assert.throws(() => parseEntity('<!-- asc:entity\n{ 깨진 json\n-->'), /invalid JSON/)
  })

  it('파일명에 못 쓰는 문자는 바뀌지만 id는 보존된다', async () => {
    const store = await freshStore()
    await store.create('event', {
      eventKey: 'review_comment:99/88',
      version: 0,
      detectedAt: NOW,
      type: 'actionable',
      suggestedPriority: 'P1',
      processing: 'PENDING_RETRY',
      inboxCandidate: true,
    })
    assert.equal(toFileName('review_comment:99/88'), 'review_comment-99-88')
    assert.deepEqual(await readdir(join(store.root, 'monitor/events')), ['review_comment-99-88.md'])
    assert.equal((await store.get('event', 'review_comment:99/88'))!.processing, 'PENDING_RETRY')
  })
})

describe('동시 전이', () => {
  it('경쟁 뒤에도 임시 파일·락 파일이 남지 않는다', async () => {
    const store = await freshStore()
    await store.create('request', sampleRequest())
    const seen = (await store.get('request', 'REQ-0042'))!

    await Promise.all(
      ['local', 'mattermost', 'web', 'cli'].map((channel) =>
        store.compareAndSet(
          'request',
          'REQ-0042',
          seen.version,
          transitionRequest(seen, 'APPROVED', 'controller', {
            decision: { kind: 'approve', actor: 'controller-a', channel, decidedAt: '2026-08-22T10:00:00+09:00' },
          }),
        ),
      ),
    )

    assert.deepEqual(await readdir(join(store.root, 'monitor/inbox')), ['REQ-0042.md'])
  })

  it('서로 다른 entity는 서로를 막지 않는다', async () => {
    const store = await freshStore()
    const ids = ['S-20260822-01', 'S-20260822-02', 'S-20260822-03']
    for (const id of ids) {
      await store.create('session', Session.parse({ id, version: 0, status: 'READY', role: 'implementer', goal: id }))
    }

    const started = await Promise.all(
      ids.map(async (id) => {
        const current = (await store.get('session', id))!
        return store.compareAndSet('session', id, current.version, transitionSession(current, 'ACTIVE', 'session'))
      }),
    )
    assert.equal(started.filter((r) => r.ok).length, 3)
  })
})

describe('Derived View', () => {
  it('inbox 목록은 판단 대기 항목만 담고 상태 변화를 따라간다', async () => {
    const store = await freshStore()
    await store.create('request', sampleRequest())
    await store.create('request', sampleRequest({ id: 'REQ-0043', priority: 'P1', title: 'PR #50 리뷰' }))

    const viewFile = join(store.root, 'monitor/views/inbox.md')
    let view = await readFile(viewFile, 'utf8')
    assert.match(view, /REQ-0042/)
    assert.match(view, /REQ-0043/)

    const current = (await store.get('request', 'REQ-0043'))!
    await store.compareAndSet(
      'request',
      'REQ-0043',
      current.version,
      transitionRequest(current, 'DISMISSED', 'controller', {
        decision: { kind: 'dismiss', actor: 'controller-a', channel: 'local', decidedAt: '2026-08-22T10:00:00+09:00' },
      }),
    )

    view = await readFile(viewFile, 'utf8')
    assert.match(view, /REQ-0042/)
    assert.doesNotMatch(view, /REQ-0043/)
  })

  it('지워도 다시 만들 수 있다', async () => {
    const store = await freshStore()
    await store.create('request', sampleRequest())
    const viewFile = join(store.root, 'monitor/views/inbox.md')

    await rm(viewFile)
    await store.refreshViews()
    assert.match(await readFile(viewFile, 'utf8'), /REQ-0042/)
  })
})

describe('ASC-8 — capability evidence는 한글 그대로 왕복한다 (UTF-8)', () => {
  it('scoped set/get과 파일 바이트 모두 유효한 UTF-8이다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asc-utf8-'))
    const store = new MarkdownStateStore(root)
    const detail = 'claude CLI가 없으면 guard 등록을 확인할 수 없다'
    await store.scope('claude-code').set('capabilities', JSON.stringify({ detail }))

    const path = join(root, 'adapters', 'claude-code', 'capabilities.json')
    const bytes = await readFile(path)
    // 유효하지 않은 UTF-8이 섞이면 replacement character로 드러난다.
    assert.equal(bytes.toString('utf8').includes('�'), false)
    const stored = JSON.parse(bytes.toString('utf8')) as { value: string }
    assert.equal((JSON.parse(stored.value) as { detail: string }).detail, detail)
    await rm(root, { recursive: true, force: true })
  })
})
