// B-29 Gate — Core가 외부 시스템을 모르는 상태로 조립을 판정하는지.
//
// 가장 중요한 검사는 마지막 두 개다: core/**가 adapter를 import하지 않고, provider 이름으로
// 분기하지 않는다. 나머지가 다 맞아도 그 둘이 무너지면 provider 교체는 다시 Core 수술이 된다.

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  availableCapabilities,
  resolveAll,
  resolveCapability,
  type BindingPlan,
  type ResolvedBinding,
} from '../core/binding/types.ts'
import { composeBindings, describeAll } from '../composition/registry.ts'
import { GitHubAdapter, parseRemote } from '../adapters/github/adapter.ts'
import { buildRuntimePorts } from '../composition/runtime.ts'
import type { Adapter } from '../ports/adapter.ts'

const binding = (over: Partial<ResolvedBinding> = {}): ResolvedBinding => ({
  adapterId: 'alpha',
  resource: 'org/one',
  provides: ['observe.delta', 'context.change'],
  state: 'AVAILABLE',
  ...over,
})

const planOf = (...bindings: ResolvedBinding[]): BindingPlan => ({ bindings })

describe('B-29 Gate — Capability resolution (C-09 §4)', () => {
  it('필요한 Port를 제공하는 binding을 찾는다 — provider를 묻지 않는다', () => {
    const result = resolveCapability(planOf(binding()), { capability: 'observe.delta' })
    assert.equal(result.kind, 'RESOLVED')
  })

  it('둘이 제공하면 고르지 않는다', () => {
    const result = resolveCapability(
      planOf(binding(), binding({ adapterId: 'beta', resource: 'org/two' })),
      { capability: 'observe.delta' },
    )
    assert.equal(result.kind, 'AMBIGUOUS')
    assert.equal(result.kind === 'AMBIGUOUS' && result.candidates.length, 2)
  })

  it('역할로 좁히면 하나로 정해진다 — 역할은 사람이 선언한 것이다', () => {
    const result = resolveCapability(
      planOf(binding({ role: 'code-primary' }), binding({ adapterId: 'beta', resource: 'org/two', role: 'work' })),
      { capability: 'observe.delta', role: 'code-primary' },
    )
    assert.equal(result.kind, 'RESOLVED')
    assert.equal(result.kind === 'RESOLVED' && result.binding.adapterId, 'alpha')
  })

  it('제공자가 없으면 조용히 통과하지 않고 없다고 말한다', () => {
    const result = resolveCapability(planOf(binding()), { capability: 'presentation.digest' })
    assert.equal(result.kind, 'UNAVAILABLE')
    assert.match(result.kind === 'UNAVAILABLE' ? result.detail : '', /제공하는 binding이 없다/)
  })

  it('있는데 못 쓰는 것과 아예 없는 것을 구분해 말한다', () => {
    const result = resolveCapability(
      planOf(binding({ state: 'UNCONFIGURED', detail: '토큰이 없다' })),
      { capability: 'observe.delta' },
    )
    assert.equal(result.kind, 'UNAVAILABLE')
    assert.match(result.kind === 'UNAVAILABLE' ? result.detail : '', /지금 쓸 수 없다/)
  })

  it('DEGRADED는 후보로 남는다 — 일부만 되는 것과 안 되는 것은 다르다', () => {
    const result = resolveCapability(planOf(binding({ state: 'DEGRADED' })), { capability: 'observe.delta' })
    assert.equal(result.kind, 'RESOLVED')
  })

  it('쓸 수 있는 capability만 센다', () => {
    const plan = planOf(binding(), binding({ adapterId: 'beta', state: 'UNAVAILABLE', provides: ['canonical.read'] }))
    assert.deepEqual(availableCapabilities(plan), ['context.change', 'observe.delta'])
    assert.deepEqual(availableCapabilities({ bindings: [] }), [])
  })

  it('여러 요구를 한 번에 풀되 못 푼 것을 감추지 않는다', () => {
    const results = resolveAll(planOf(binding()), [
      { capability: 'observe.delta' },
      { capability: 'context.history' },
    ])
    assert.deepEqual(results.map((r) => r.kind), ['RESOLVED', 'UNAVAILABLE'])
  })
})

describe('B-29 Gate — Adapter contract (C-09 §5)', () => {
  const context = { projectRoot: '/nowhere', env: {} }

  it('describe는 정적이다 — 네트워크도 파일도 건드리지 않는다', () => {
    const descriptor = new GitHubAdapter().describe()
    assert.ok(descriptor.provides.includes('inventory.enumerate'))
    // 자격은 이름까지만. 값이 descriptor에 실리면 그 자체가 유출 경로다
    assert.ok(descriptor.requiresCredential?.length)
    assert.doesNotMatch(JSON.stringify(descriptor), /ghp_|Bearer /)
  })

  it('remote에서 후보를 찾고, 다른 host는 자기 것으로 보지 않는다', async () => {
    const adapter = new GitHubAdapter({
      listRemotes: async () => [
        'git@github.com:org/one.git',
        'https://github.com/org/one.git',
        'git@elsewhere.example:org/two.git',
      ],
    })
    const found = await adapter.discover(context)
    assert.equal(found.length, 1) // 같은 저장소의 ssh·https 중복은 하나로
    assert.equal(found[0]?.resource, 'org/one')
    assert.equal(found[0]?.discoveredBy, 'git remote')
  })

  it('remote가 없으면 빈 목록이다 — 그것도 사람이 알아야 할 사실이다', async () => {
    const adapter = new GitHubAdapter({ listRemotes: async () => [] })
    assert.deepEqual(await adapter.discover(context), [])
  })

  it('자격 없음과 닿지 않음을 나눠서 돌려준다', async () => {
    const candidate = { adapterId: 'github', resource: 'org/one', provides: [] as never[] }

    const unconfigured = await new GitHubAdapter({ findToken: async () => null }).probe(candidate, context)
    assert.equal(unconfigured.state, 'UNCONFIGURED')
    assert.match(unconfigured.detail ?? '', /토큰이 없다/)

    const unreachable = await new GitHubAdapter({
      findToken: async () => 'token',
      reach: async () => ({ ok: false, detail: 'HTTP 404' }),
    }).probe(candidate, context)
    assert.equal(unreachable.state, 'UNAVAILABLE')

    const available = await new GitHubAdapter({
      findToken: async () => 'token',
      reach: async () => ({ ok: true }),
    }).probe(candidate, context)
    assert.equal(available.state, 'AVAILABLE')
  })

  it('probe가 터져도 후보에서 조용히 빠지지 않는다', async () => {
    const broken: Adapter = {
      describe: () => ({ id: 'broken', version: '1', provides: ['observe.delta'] }),
      discover: async () => [{ adapterId: 'broken', resource: 'x', provides: ['observe.delta'] }],
      probe: async () => {
        throw new Error('boom')
      },
    }
    const plan = await composeBindings({ context, adapters: [broken] })
    assert.equal(plan.bindings.length, 1)
    assert.equal(plan.bindings[0]?.state, 'UNAVAILABLE')
    assert.match(plan.bindings[0]?.detail ?? '', /boom/)
  })

  it('Profile이 선언한 역할이 binding에 붙는다 — Core가 추론하지 않는다', async () => {
    const adapter = new GitHubAdapter({
      listRemotes: async () => ['git@github.com:org/one.git'],
      findToken: async () => 'token',
      reach: async () => ({ ok: true }),
    })
    const plan = await composeBindings({
      context,
      adapters: [adapter],
      roles: [{ adapterId: 'github', resource: 'org/one', role: 'code-primary' }],
    })
    assert.equal(plan.bindings[0]?.role, 'code-primary')
  })

  it('등록된 adapter만 참여한다', () => {
    const ids = describeAll().map((d) => d.id)
    assert.ok(ids.length > 0)
    assert.deepEqual([...new Set(ids)], ids) // 중복 등록 없음
  })

  it('remote 문법 두 가지를 푼다', () => {
    assert.deepEqual(parseRemote('git@github.com:org/one.git'), { host: 'github.com', repo: 'org/one' })
    assert.deepEqual(parseRemote('https://github.com/org/one'), { host: 'github.com', repo: 'org/one' })
    assert.equal(parseRemote('nonsense'), null)
  })
})

describe('B-29 Gate — Runtime 조립 (C-09 §6)', () => {
  it('쓸 수 있는 binding이 없으면 Port를 만들지 않고 이유를 남긴다', async () => {
    const ports = await buildRuntimePorts({ plan: { bindings: [] }, findToken: async () => 'token' })
    assert.equal(ports.eventSource, undefined)
    assert.ok(ports.unavailable.length > 0)
  })

  it('후보가 갈리면 만들지 않고 무엇이 갈렸는지 말한다', async () => {
    const ports = await buildRuntimePorts({
      plan: planOf(
        binding({ provides: ['observe.delta'] }),
        binding({ adapterId: 'beta', resource: 'org/two', provides: ['observe.delta'] }),
      ),
      findToken: async () => 'token',
    })
    assert.equal(ports.eventSource, undefined)
    assert.match(ports.unavailable.join('\n'), /후보가 둘 이상이라 고르지 않았다/)
  })

  it('자격이 없으면 만들지 않는다', async () => {
    const ports = await buildRuntimePorts({
      plan: planOf(binding({ adapterId: 'github', provides: ['observe.delta', 'inventory.enumerate'] })),
      findToken: async () => null,
    })
    assert.equal(ports.eventSource, undefined)
    assert.match(ports.unavailable.join('\n'), /자격이 없어/)
  })

  it('조립 경로가 없는 adapter는 그 사실을 말한다', async () => {
    const ports = await buildRuntimePorts({
      plan: planOf(binding({ adapterId: 'unknown-adapter', provides: ['observe.delta'] })),
      findToken: async () => 'token',
    })
    assert.match(ports.unavailable.join('\n'), /이 빌드에 조립 경로가 없다/)
  })

  it('binding 하나로 Port 묶음이 선다', async () => {
    const ports = await buildRuntimePorts({
      plan: planOf(
        binding({
          adapterId: 'github',
          provides: [
            'observe.delta',
            'inventory.enumerate',
            'context.change',
            'context.resource',
            'canonical.read',
          ],
        }),
      ),
      findToken: async () => 'token',
    })
    assert.ok(ports.eventSource)
    assert.ok(ports.inventory)
    assert.ok(ports.changeContext)
    assert.ok(ports.resourceContext)
    assert.ok(ports.scm)
    assert.deepEqual(ports.unavailable, [])
  })

  it('제공하지 않는 갈래는 조용히 빠지지 않고 이유가 남는다', async () => {
    const ports = await buildRuntimePorts({
      plan: planOf(binding({ adapterId: 'github', provides: ['observe.delta'] })),
      findToken: async () => 'token',
    })
    assert.ok(ports.eventSource)
    assert.equal(ports.scm, undefined)
    assert.match(ports.unavailable.join('\n'), /canonical\.read/)
  })
})

describe('B-29 Gate — External-System Independence (C-09 §6.1)', () => {
  async function coreSources(dir = 'core'): Promise<string[]> {
    const out: string[] = []
    for (const entry of await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...(await coreSources(path)))
      else if (entry.name.endsWith('.ts')) out.push(path)
    }
    return out
  }

  it('core/** 는 adapter도 composition도 import하지 않는다', async () => {
    for (const path of await coreSources()) {
      const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
      assert.doesNotMatch(source, /from '.*adapters\//, `${path} 가 adapter를 import한다`)
      assert.doesNotMatch(source, /from '.*composition\//, `${path} 가 composition을 import한다`)
    }
  })

  it('core/** 에 provider 이름으로 갈라지는 코드가 없다', async () => {
    // 문자열이 등장하는 것 자체를 막지 않는다 — 막는 것은 그 값으로 **행동이 바뀌는** 것이다.
    // 지금은 어휘 자체가 core에 없으므로 등장 여부로 검사한다.
    const forbidden = /\b(github|gitlab|jira|jam|mattermost|slack)\b/i
    for (const path of await coreSources()) {
      const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
      assert.doesNotMatch(source, forbidden, `${path} 에 provider 어휘가 있다`)
    }
  })

  it('Core가 아는 capability는 전부 provider-neutral 하다', async () => {
    const { CAPABILITIES } = await import('../core/binding/types.ts')
    for (const capability of CAPABILITIES) {
      assert.match(capability, /^[a-z]+\.[a-z]+$/, `${capability} 형식`)
      assert.doesNotMatch(capability, /github|gitlab|jira|jam|mattermost|slack/)
    }
  })
})
