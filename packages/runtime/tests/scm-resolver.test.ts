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
    assert.deepEqual(ports.unavailable, [])
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
