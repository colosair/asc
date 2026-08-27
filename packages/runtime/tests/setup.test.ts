// B-21 Gate — "지금 무엇이 되고 무엇이 막혀 있는가"를 정직하게 말하는지.
//
// 이 Block의 핵심은 두 구분이다:
//   못 쓰는 것(BLOCKED)과 반쪽으로 도는 것(DEGRADED)
//   설정이 덜 찬 것(gate)과 붙은 상태가 어긋난 것(attachment)
// 둘을 섞으면 사람이 엉뚱한 것을 고치러 간다.

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { identitiesTemplate, overrideTemplate } from '../core/attach/init.ts'
import { assessSetup, renderSetup, type SetupInput } from '../core/attach/setup.ts'
import { loadIdentityMap } from '../cli/identity-config.ts'
import { LocalIdentityBinding } from '../adapters/local/identity.ts'

const dirs: string[] = []
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asc-setup-'))
  dirs.push(dir)
  return dir
}

const nothing: SetupInput = {
  attachment: 'READY',
  hasApprovers: false,
  hasControllerIdentities: false,
  hasMonitorIdentities: false,
  hasScmToken: false,
}

const gateOf = (input: SetupInput, id: 'approval' | 'monitor' | 'external-write') =>
  assessSetup(input).gates.find((g) => g.id === id)!

describe('B-21 Gate — 서식 예시가 파서를 오염시키지 않는다', () => {
  it('서식 그대로의 identities.json은 승인자가 0명이다', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'identities.json'), identitiesTemplate(), 'utf8')

    assert.deepEqual(await loadIdentityMap(dir), {})
  })

  it('$example 안의 이름으로는 승인이 통과하지 않는다', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'identities.json'), identitiesTemplate(), 'utf8')
    const binding = new LocalIdentityBinding(await loadIdentityMap(dir))

    // 예시를 실제 매핑 형태로 적었다면 이 이름이 살아난다 — 그래서 $example 안에 둔다
    const passes = await binding.verify({
      channel: 'local',
      actor: '내-계정',
      authorizedApprover: 'controller-이름',
    })
    assert.equal(passes, false)
  })

  it('서식에 형식과 재고정 안내가 실제로 들어 있다', () => {
    assert.match(identitiesTemplate(), /\$example/)
    assert.match(identitiesTemplate(), /local:/)
    assert.match(overrideTemplate(), /profile resolve --write/)
  })
})

describe('B-21 Gate — 판정 정확성', () => {
  it('아무것도 없으면 세 경로가 다 막힌다', () => {
    const status = assessSetup(nothing)
    assert.deepEqual(
      status.gates.map((g) => g.state),
      ['BLOCKED', 'BLOCKED', 'BLOCKED'],
    )
  })

  it('identities만 채우면 승인 결정만 열린다', () => {
    const status = assessSetup({ ...nothing, hasApprovers: true })
    assert.equal(status.gates.find((g) => g.id === 'approval')?.state, 'OPEN')
    assert.equal(status.gates.find((g) => g.id === 'monitor')?.state, 'BLOCKED')
    // 외부 반영은 토큰도 있어야 한다
    assert.equal(status.gates.find((g) => g.id === 'external-write')?.state, 'BLOCKED')
  })

  it('전부 채우면 전부 열린다', () => {
    const status = assessSetup({
      attachment: 'READY',
      hasApprovers: true,
      hasControllerIdentities: true,
      hasMonitorIdentities: true,
      hasScmToken: true,
    })
    assert.ok(status.gates.every((g) => g.state === 'OPEN'))
    assert.ok(status.gates.every((g) => g.missing.length === 0 && g.howTo.length === 0))
  })
})

describe('B-21 Gate — BLOCKED와 DEGRADED를 가른다', () => {
  it('monitorIdentities만 비면 DEGRADED — scan은 돌지만 나에게 온 것을 못 알아본다', () => {
    const gate = gateOf(
      { ...nothing, hasControllerIdentities: true, hasScmToken: true, hasMonitorIdentities: false },
      'monitor',
    )
    assert.equal(gate.state, 'DEGRADED')
    assert.deepEqual(gate.missing, [], 'DEGRADED인데 막힌 것으로 적혔다')
    assert.match(gate.warnings.join('\n'), /are not recognised/)
  })

  it('controller.identities가 없으면 BLOCKED이되 --as 우회를 알려준다', () => {
    const gate = gateOf(
      { ...nothing, hasMonitorIdentities: true, hasScmToken: true, hasControllerIdentities: false },
      'monitor',
    )
    assert.equal(gate.state, 'BLOCKED')
    assert.match(gate.howTo.join('\n'), /--as/)
  })

  it('토큰이 없으면 감시와 외부 반영 양쪽이 막힌다 — 우회는 없다', () => {
    const input = { ...nothing, hasApprovers: true, hasControllerIdentities: true, hasMonitorIdentities: true }
    assert.equal(gateOf({ ...input, hasScmToken: false }, 'monitor').state, 'BLOCKED')
    assert.equal(gateOf({ ...input, hasScmToken: false }, 'external-write').state, 'BLOCKED')
    assert.match(gateOf({ ...input, hasScmToken: false }, 'monitor').howTo.join('\n'), /gh auth login/)
  })
})

describe('B-21 Gate — 재고정은 필요한 곳에만', () => {
  it('override를 고치는 안내에는 재고정이 붙는다', () => {
    const gate = gateOf({ ...nothing, hasScmToken: true }, 'monitor')
    assert.match(gate.howTo.join('\n'), /profile resolve --write/)
  })

  it('identities 안내에는 재고정이 붙지 않는다 — lock에 없으므로', () => {
    const text = gateOf(nothing, 'approval').howTo.join('\n')
    assert.ok(!text.includes('profile resolve'), '필요 없는 절차를 시키면 다음부터 안내를 안 믿는다')
    assert.match(text, /no re-lock needed/)
  })
})

describe('B-21 Gate — attachment 축은 따로 선다', () => {
  it('LOCK_DRIFT는 gate가 아니라 상태로 보이고, 원인을 먼저 말한다', () => {
    const text = renderSetup(assessSetup({ ...nothing, attachment: 'LOCK_DRIFT' }))
    assert.match(text, /edited without re-locking/)
    assert.match(text.split('Working now')[0]!, /profile resolve --write/)
  })

  it('UNATTACHED는 gate를 나열하지 않는다 — 붙는 게 먼저다', () => {
    const text = renderSetup(assessSetup({ ...nothing, attachment: 'UNATTACHED' }))
    assert.match(text, /asc init/)
    assert.ok(!text.includes('Working now'))
  })

  it('BROKEN도 원인과 복구 방법을 말한다', () => {
    const text = renderSetup(assessSetup({ ...nothing, attachment: 'BROKEN' }))
    assert.match(text, /Attachment is half-finished/)
    assert.match(text, /profile resolve --write/)
  })
})

describe('B-21 Gate — 되는 것은 되는 것으로', () => {
  it('설정이 전부 비어도 로컬 루프 전체가 ready에 있다', () => {
    const ready = assessSetup(nothing).ready.join('\n')
    for (const surface of ['asc session', 'asc proceed', 'asc progress', 'asc preflight', 'asc closure']) {
      assert.ok(ready.includes(surface), `${surface} 가 되는 것 목록에 없다`)
    }
  })

  it('판정은 아무것도 고치지 않는다 — 입력을 그대로 두고 값만 낸다', () => {
    const input = { ...nothing }
    const snapshot = JSON.stringify(input)
    assessSetup(input)
    assert.equal(JSON.stringify(input), snapshot)
  })
})
