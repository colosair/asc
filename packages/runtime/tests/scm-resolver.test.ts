// B-49 Gate — provider는 선언과 실측으로 풀리고, 갈리면 고르지 않는다 (C-11 §7).
//
// 예시 실측이 이 Gate의 출처다: Profile은 GitHub를 못 박고 있었는데 저장소의 실제
// primary는 자체 호스팅 GitLab이고 GitHub는 mirror였다. 그 상태에서 조용히 한쪽을 고르면
// "감시가 도는데 아무것도 안 잡히는" 상태가 된다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BindingPlan, Capability, ResolvedBinding } from '../core/binding/types.ts'
import { buildObservationChannels, buildRuntimePorts, rolesFor } from '../composition/runtime.ts'

const CODE: Capability[] = ['observe.delta', 'inventory.enumerate', 'context.change', 'context.resource']

const binding = (over: Partial<ResolvedBinding> = {}): ResolvedBinding => ({
  adapterId: 'github',
  resource: 'org/repo',
  provides: CODE,
  state: 'AVAILABLE',
  ...over,
})

const planOf = (...bindings: ResolvedBinding[]): BindingPlan => ({ bindings, runtimes: [] })

describe('B-49 Gate — 갈리면 고르지 않는다 (silent substitution 0)', () => {
  it('같은 capability를 둘이 제공하면 아무 것도 만들지 않고 이유를 남긴다', async () => {
    const ports = await buildRuntimePorts({
      plan: planOf(
        binding({ adapterId: 'gitlab', resource: 'team/project' }),
        binding({ adapterId: 'github', resource: 'org/mirror' }),
      ),
      findToken: async () => 'token',
    })

    assert.equal(ports.eventSource, undefined, 'mirror가 있다고 primary를 대신 고르지 않는다')
    assert.match(ports.unavailable.join('\n'), /후보가 둘 이상이라 고르지 않았다/)
    assert.match(ports.unavailable.join('\n'), /Profile bindings/)
  })

  it('Profile이 역할을 선언하면 그때 풀린다', async () => {
    const declared = [
      { role: 'code-primary', adapter: 'gitlab', resource: 'team/project' },
      { role: 'code-mirror', adapter: 'github', resource: 'org/mirror' },
    ]
    const plan = planOf(
      binding({ adapterId: 'gitlab', resource: 'team/project', role: 'code-primary' }),
      binding({ adapterId: 'github', resource: 'org/mirror', role: 'code-mirror' }),
    )

    const roles = rolesFor(plan, declared)
    // 두 binding이 같은 capability를 제공하므로 역할은 자동으로 정해지지 않는다
    assert.equal(roles['observe.delta'], undefined, '선언이 갈리면 여기서도 고르지 않는다')

    const ports = await buildRuntimePorts({
      plan,
      roles: { 'observe.delta': 'code-primary', 'context.change': 'code-primary' },
      findToken: async () => 'token',
    })
    assert.ok(ports.eventSource, '사람이 역할을 정하면 풀린다')
    assert.equal(ports.eventSource!.id, 'gitlab-todo')
  })

  it('한 갈래만 제공하는 역할은 선언에서 그대로 따라온다', () => {
    const declared = [{ role: 'work', adapter: 'jam', resource: 'FESTA' }]
    const plan = planOf(
      binding({ adapterId: 'jam', resource: 'FESTA', role: 'work', provides: ['inventory.enumerate'] }),
    )
    assert.deepEqual(rolesFor(plan, declared), { 'inventory.enumerate': 'work' })
  })
})

describe('B-49 Gate — multi-binding이 서로를 덮지 않는다 (버그 B)', () => {
  it('두 binding이 각자 다른 갈래를 맡는다', async () => {
    const ports = await buildRuntimePorts({
      plan: planOf(
        binding({ adapterId: 'gitlab', resource: 'team/project', role: 'code', provides: ['observe.delta', 'context.change'] }),
        binding({
          adapterId: 'github',
          resource: 'org/repo',
          role: 'mirror',
          provides: ['inventory.enumerate', 'canonical.read', 'context.resource'],
        }),
      ),
      roles: {
        'observe.delta': 'code',
        'context.change': 'code',
        'inventory.enumerate': 'mirror',
        'canonical.read': 'mirror',
        'context.resource': 'mirror',
      },
      findToken: async () => 'token',
    })

    // 예전에는 Object.assign 으로 통째로 덮어써서 나중 binding이 앞 것의 Port까지 밀어냈다
    assert.equal(ports.eventSource!.id, 'gitlab-todo', 'code는 GitLab이 맡는다')
    assert.ok(ports.inventory, 'mirror가 맡은 갈래도 남아 있다')
    assert.ok(ports.scm, 'canonical도 mirror가 맡는다')
    // 두 binding 중 누구도 조율 표면을 맡지 않았다. 없는 것은 없다고 남는다.
    assert.deepEqual(ports.unavailable, [
      "coordination.surface: 'coordination.surface' 를 제공하는 binding이 없다",
    ])
  })

  it('작업 항목 adapter도 조립된다 — 등록만 되고 못 만들던 것을 닫는다', async () => {
    const ports = await buildRuntimePorts({
      plan: planOf(
        binding({
          adapterId: 'jam',
          resource: 'FESTA',
          provides: ['inventory.enumerate', 'context.resource'],
        }),
      ),
      jam: { command: 'jam', cwd: '/tmp' },
      findToken: async () => null,
    })

    // JAM은 토큰을 받지 않는다 — 자격은 도구가 자기 안에서 진다
    assert.ok(ports.inventory)
    assert.ok(ports.resourceContext)
    assert.doesNotMatch(ports.unavailable.join('\n'), /조립 경로가 없다/)
  })

  it('JAM 통로가 주어지지 않으면 만들지 않고 그 사실을 남긴다', async () => {
    const ports = await buildRuntimePorts({
      plan: planOf(binding({ adapterId: 'jam', resource: 'FESTA', provides: ['inventory.enumerate'] })),
      findToken: async () => null,
    })
    assert.equal(ports.inventory, undefined)
    assert.match(ports.unavailable.join('\n'), /이 갈래를 만들지 않았다/)
  })
})

describe('B-49 Gate — provider 이름이 Surface에 박혀 있지 않다', () => {
  it('monitor 조립이 adapter를 직접 new 하지 않는다', async () => {
    const source = await (await import('node:fs/promises')).readFile('cli/asc.ts', 'utf8')
    const monitorBlock = source.slice(source.indexOf('const engine = new MonitorEngine({'))
    const block = monitorBlock.slice(0, monitorBlock.indexOf('\n  })'))

    // 조립은 Composition의 몫이다. 여기서 다시 new 하면 provider 교체가 CLI 수정이 된다.
    assert.doesNotMatch(block, /new GitHub/)
    assert.doesNotMatch(block, /new GitLab/)
    // 통로는 Composition이 만든 채널에서만 온다 — CLI가 provider를 아는 자리가 없다
    assert.match(block, /channel\.eventSource/)
  })

  it('관측 기록 scope가 provider 이름으로 박혀 있지 않다', async () => {
    const source = await (await import('node:fs/promises')).readFile('cli/asc.ts', 'utf8')
    // 'github-poll' 은 이제 이전 설치를 읽기 위한 기본값 한 곳에만 남는다
    const occurrences = source.match(/monitor:github-poll/g) ?? []
    assert.deepEqual(occurrences, [], "scope 문자열에 provider 이름이 박혀 있다")
  })
})

// 설계 §8 — 관측은 "하나를 고르는 문제"가 아니다.
//
// 코드가 한 곳에 있고 작업 항목이 다른 곳에 있는 프로젝트에서 둘 다 봐야 한다는 것은
// 요구이지 모호함이 아니다. 그런데 같은 capability 를 둘이 제공한다는 이유만으로
// AMBIGUOUS 가 되어 감시가 통째로 서지 않았다 (실 프로젝트 실측).
describe('관측 채널 — 선언된 binding 마다 하나씩 (설계 §8)', () => {
  const binding = (adapterId: string, resource: string, role?: string) => ({
    adapterId,
    resource,
    provides: ['observe.delta', 'inventory.enumerate', 'context.resource'] as const,
    state: 'AVAILABLE' as const,
    discoveredBy: 'test',
    ...(role ? { role } : {}),
  })

  const build = (bindings: ReturnType<typeof binding>[]) =>
    buildObservationChannels({
      plan: { bindings },
      findToken: async () => 'x',
      jam: { command: 'jam', args: ['serve'], cwd: '/p' },
    })

  it('선언이 둘이면 채널도 둘이다 — 어느 쪽도 다른 쪽을 밀어내지 않는다', async () => {
    const built = await build([
      binding('gitlab', 'group/project', 'code-primary'),
      binding('jam', 'WORK', 'work'),
    ])
    assert.equal(built.channels.length, 2)
    assert.deepEqual(built.channels.map((channel) => channel.role).sort(), ['code-primary', 'work'])
    // 통로가 서로 다른 source id 를 갖는다 — cursor·coverage 가 갈려야 중복이 안 생긴다
    assert.equal(new Set(built.channels.map((channel) => channel.eventSource.id)).size, 2)
  })

  it('선언이 있으면 발견만 된 것은 채널이 되지 않는다', async () => {
    // 과거 mirror 로 남은 remote 가 있다는 이유로 감시 대상이 하나 더 생기면,
    // 사람이 고르지 않은 곳을 보게 된다 (C-11 §7).
    const built = await build([
      binding('gitlab', 'group/project', 'code-primary'),
      binding('github', 'owner/mirror'),
    ])
    assert.deepEqual(built.channels.map((channel) => channel.adapterId), ['gitlab'])
  })

  it('선언이 하나도 없으면 발견된 것을 쓴다 — 기존 사용을 끊지 않는다', async () => {
    const built = await build([binding('github', 'owner/repo')])
    assert.deepEqual(built.channels.map((channel) => channel.adapterId), ['github'])
  })

  it('열지 못한 통로는 이유가 남는다 — 조용히 빠지지 않는다', async () => {
    const built = await buildObservationChannels({
      plan: { bindings: [binding('gitlab', 'group/project', 'code-primary')] },
      // 자격이 없는 것은 "변화 없음"이 아니다
      findToken: async () => null,
    })
    assert.equal(built.channels.length, 0)
    assert.match(built.unavailable.join('\n'), /자격이 없어/)
  })

  it('쓸 수 없는 binding 은 채널이 되지 않고, 그 사실을 말한다', async () => {
    const built = await buildObservationChannels({
      plan: { bindings: [{ ...binding('gitlab', 'group/project', 'code-primary'), state: 'UNCONFIGURED' }] },
      findToken: async () => 'x',
    })
    assert.equal(built.channels.length, 0)
    assert.match(built.unavailable.join('\n'), /지금 쓸 수 없다/)
  })
})

// 실사용 실패 — GitLab 이 정본인 저장소에서 AUTO 가 raw push 를 막고도 관리 경로를
// 내놓지 못했다. 위 테스트들은 `provides` 를 손으로 써서 실제 어댑터를 부르지 않았고,
// 그래서 선언과 구현이 어긋난 것을 잡지 못했다. 여기서는 어댑터 자신에게 묻는다.
describe('선언과 구현이 어긋나지 않는다 (실제 어댑터)', () => {
  it('GitLab 은 scm 슬롯에 걸리는 capability 를 선언한다', async () => {
    const { GitLabAdapter } = await import('../adapters/gitlab/adapter.ts')
    const provides = new GitLabAdapter().describe().provides
    // canonical.read 는 PORT_OF 에서 scm 슬롯에 닿는 유일한 열쇠다. 이것이 없으면
    // 후보 필터가 GitLab 을 먼저 걸러내고, 조립된 GitLabScm 이 버려진다.
    assert.ok(provides.includes('canonical.read'), `provides=${provides.join(', ')}`)
  })

  it('scm 슬롯을 선언한 adapter 는 그 갈래를 실제로 만든다', async () => {
    // 선언만 늘리면 "있다고 말하는데 없는" 상태가 된다 — 그쪽이 더 나쁘다.
    for (const adapterId of ['gitlab', 'github'] as const) {
      const ports = await buildRuntimePorts({
        plan: planOf(binding({ adapterId, resource: 'team/project', provides: ['canonical.read'] })),
        findToken: async () => 'token',
      })
      assert.ok(ports.scm, `${adapterId} 가 canonical.read 를 선언하고도 scm 을 만들지 않았다`)
      assert.equal(ports.scm!.id, adapterId)
    }
  })

  it('GitLab scm 은 git.push 를 수행하고 되돌려 읽는다', async () => {
    const ports = await buildRuntimePorts({
      plan: planOf(binding({ adapterId: 'gitlab', resource: 'team/project', provides: ['canonical.read'] })),
      findToken: async () => 'token',
    })
    // 실행할 수 있다는 것과 확인할 수 있다는 것은 다른 질문이고, 둘 다 필요하다.
    assert.equal(ports.scm!.supports?.('git.push'), true, 'git.push 를 수행하지 못한다')
    assert.equal(ports.scm!.verifies?.('git.push'), true, 'git.push 를 되돌려 읽지 못한다')
  })

  it('GitHub mirror 가 있어도 선언된 역할이 GitLab 을 고른다', async () => {
    // 실사용 구성: origin 은 자체 호스팅 GitLab, github 은 mirror. Profile 이 선언한
    // 것은 GitLab 하나뿐이다. mirror 는 발견될 뿐 역할이 없다.
    const declared = [{ role: 'code-primary', adapter: 'gitlab', resource: 'team/project' }]
    const plan = planOf(
      binding({ adapterId: 'gitlab', resource: 'team/project', role: 'code-primary', provides: ['canonical.read'] }),
      binding({ adapterId: 'github', resource: 'org/mirror', provides: ['canonical.read'] }),
    )
    const roles = rolesFor(plan, declared)
    assert.equal(roles['canonical.read'], 'code-primary', '선언되지 않은 mirror 가 역할을 흐렸다')

    const ports = await buildRuntimePorts({ plan, roles, findToken: async () => 'token' })
    assert.equal(ports.scm!.id, 'gitlab', 'mirror 가 executor 를 가져갔다')
    // 다른 갈래를 아무도 안 맡은 것은 이 테스트의 관심이 아니다. canonical 이 갈렸는지만 본다.
    assert.equal(
      ports.unavailable.filter((u) => u.startsWith('canonical.read')).join(''),
      '',
      '역할로 갈렸는데도 AMBIGUOUS 가 남았다',
    )
  })
})

// AUTO dead-end — Guard 가 막는데 관리 경로가 없으면 그 사실이 이름으로 나와야 한다.
// 실사용에서 사람이 mode manual 로 내려간 것은 화면이 그것을 권해서가 아니라, 막힌 뒤
// 아무 말도 없었기 때문이다.
describe('막는 것과 내보내는 것이 어긋나면 이름을 댄다', () => {
  it('action key 가 붙은 금지 패턴은 관리 어휘 안에 있다', async () => {
    const { FORBIDDEN_COMMAND_PATTERNS } = await import('../adapters/claude-code/guard.ts')
    const { MANAGED_EXTERNAL_ACTIONS } = await import('../ports/scm.ts')
    const vocabulary = new Set<string>(MANAGED_EXTERNAL_ACTIONS)
    for (const entry of FORBIDDEN_COMMAND_PATTERNS) {
      if (entry.action === undefined) continue // 한 행위로 환원되지 않는 패턴 — 정상이다
      assert.ok(vocabulary.has(entry.action), `${entry.label} 의 action '${entry.action}' 가 어휘 밖이다`)
    }
  })

  it('일부 패턴은 action 이 없어도 된다 — 억지 매핑을 강요하지 않는다', async () => {
    const { FORBIDDEN_COMMAND_PATTERNS } = await import('../adapters/claude-code/guard.ts')
    // 한 명령이 여러 행위를 덮는 경우가 실제로 있다. 전부 채우라고 요구하면 이 파일이
    // provider 목록이 된다.
    assert.ok(
      FORBIDDEN_COMMAND_PATTERNS.some((entry) => entry.action === undefined),
      '모든 패턴에 action 이 붙었다 — 억지 매핑이 들어갔는지 본다',
    )
  })

  it('push 를 못 싣는 통로가 슬롯을 맡으면 git.push 가 dead-end 다', async () => {
    // 실사용 실패 그대로: mirror 가 executor 를 맡았고 그 통로는 push 를 못 한다.
    const ports = await buildRuntimePorts({
      plan: planOf(binding({ adapterId: 'github', resource: 'org/mirror', provides: ['canonical.read'] })),
      findToken: async () => 'token',
    })
    assert.equal(ports.scm!.supports?.('git.push'), false, '이 통로가 push 를 싣는다고 답한다')
  })

  it('GitLab 이 슬롯을 맡으면 git.push 는 dead-end 가 아니다', async () => {
    const ports = await buildRuntimePorts({
      plan: planOf(binding({ adapterId: 'gitlab', resource: 'team/project', provides: ['canonical.read'] })),
      findToken: async () => 'token',
    })
    assert.equal(ports.scm!.supports?.('git.push'), true)
  })
})
