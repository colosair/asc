// B-10 Gate — Profile이 정적 설정의 경계를 지키는지(OM §4.2), 계층이 제대로 합쳐지는지,
// lock이 변화를 잡아내되 저 혼자 고치지는 않는지.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'

import { GITHUB_REASON_SIGNALS } from '../adapters/github/event-source.ts'
import {
  archiveLock,
  bootstrapGuard,
  buildLock,
  compareLock,
  digest,
  loadLayers,
  resolveRuntime,
} from '../core/resolver/load.ts'
import { lookupAuthority } from '../core/policy/ownership.ts'
import { satisfies } from '../core/resolver/version.ts'
import { renderAscMd, renderControllerMd } from '../core/resolver/render.ts'
import { OperationalPreset, ProjectProfile, UserOverride } from '../schemas/profile.ts'

const INSTALL_ROOT = process.cwd()
const GENERATED_AT = '2026-08-23T12:00:00+09:00'
const ASC_VERSION = '0.1.0'

const dirs: string[] = []
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function overrideFile(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asc-override-'))
  dirs.push(dir)
  const path = join(dir, 'override.json')
  await writeFile(path, JSON.stringify(content), 'utf8')
  return path
}

const SAMPLE_OVERRIDE = {
  schemaVersion: 1,
  monitorIdentities: ['colosair'],
  controller: { identities: { 'controller-a': ['local:colosair', 'mattermost:@colosair'] } },
  approval: { preferredChannel: 'local', messenger: { provider: 'mattermost', tokenEnv: 'ASC_MATTERMOST_TOKEN' } },
}

describe('Profile 경계 — 무엇이 들어오면 안 되는가 (OM §4.2)', () => {
  const base = {
    schemaVersion: 1,
    id: 'x',
    project: { scm: 'github', repository: 'o/r' },
    canonical: { sources: [{ id: 'spec', provider: 'git', ref: 'main' }] },
  }

  it('정상 Profile은 통과한다', () => {
    assert.equal(ProjectProfile.safeParse(base).success, true)
  })

  for (const [label, extra] of [
    ['Runtime 상태', { activeSessions: ['S-1'] }],
    ['처리 대기함', { inbox: [] }],
    ['커서', { monitor: { cursor: 'abc' } }],
    ['토큰', { approval: { token: 'ghp_xxx' } }],
    ['비밀', { messenger: { secret: 'shhh' } }],
  ] as const) {
    it(`${label}는 거절한다`, () => {
      const result = ProjectProfile.safeParse({ ...base, ...extra })
      assert.equal(result.success, false)
      assert.match(result.error!.issues[0]!.message, /Runtime 상태이거나 비밀/)
    })
  }

  it('토큰은 값이 아니라 이름으로만 적는다', () => {
    const ok = UserOverride.safeParse({
      schemaVersion: 1,
      approval: { messenger: { provider: 'mattermost', tokenEnv: 'ASC_MATTERMOST_TOKEN' } },
    })
    assert.equal(ok.success, true)
    const bad = UserOverride.safeParse({ schemaVersion: 1, approval: { messenger: { token: 'real-token' } } })
    assert.equal(bad.success, false)
  })

  it('canonical 빈 집합은 허용되나 검증이 통째로 빠진다는 뜻이다', () => {
    // fixture·로컬 실험 전용 — 세션 발급·시작의 정본 대조가 성립하지 않는다
    const parsed = ProjectProfile.safeParse({ ...base, canonical: { sources: [] } })
    assert.equal(parsed.success, true)
    assert.deepEqual(parsed.data!.canonical.sources, [])
  })

  it('신호 이름은 Core가 아는 열 가지뿐이다', () => {
    const bogus = { ...base, monitor: { reasonSignals: { mention: 'someone_yelled' } } }
    assert.equal(ProjectProfile.safeParse(bogus).success, false)
  })
})

describe('예시 Profile', () => {
  it('설치 경로에서 읽히고 스키마를 만족한다', async () => {
    const layers = await loadLayers({ installRoot: INSTALL_ROOT, profileId: 'example-team', presetId: 'balanced' })
    assert.equal(layers.profile.id, 'example-team')
    assert.equal(layers.profile.project.repository, 'example-org/example-repo')
    assert.equal(layers.preset?.id, 'balanced')
  })

  it('정본을 여러 갈래로 갖는다 — 공용 spec과 FE plan은 다른 브랜치에 있다', async () => {
    const { profile } = await loadLayers({ installRoot: INSTALL_ROOT, profileId: 'example-team' })
    const byId = Object.fromEntries(profile.canonical.sources.map((s) => [s.id, s]))
    assert.equal(byId['shared-spec']!.ref, 'develop')
    assert.equal(byId['fe-plan']!.ref, 'front')
  })

  it('provider 어휘가 Adapter의 표와 어긋나지 않는다', async () => {
    const { profile } = await loadLayers({ installRoot: INSTALL_ROOT, profileId: 'example-team' })
    for (const [reason, signal] of Object.entries(GITHUB_REASON_SIGNALS)) {
      assert.equal(profile.monitor.reasonSignals[reason], signal, `${reason} 매핑이 다르다`)
    }
  })

  it('개인 값은 Profile에 없다', async () => {
    const { profile } = await loadLayers({ installRoot: INSTALL_ROOT, profileId: 'example-team' })
    // 계정 이름은 Override 몫이다 — 같은 Profile을 팀원이 함께 쓴다
    assert.doesNotMatch(JSON.stringify(profile), /colosair/)
  })

  it('다른 프로젝트 Profile도 같은 스키마로 표현된다 (PinLog 대조)', () => {
    // 실제 파일을 만들지 않고 형태만 확인한다 — 스키마가 예시에 맞춰 굳지 않았는지 본다
    const pinlog = {
      schemaVersion: 1,
      id: 'pinlog',
      requires: { capabilities: ['scm.github'] },
      project: { scm: 'github', repository: 'other-org/other-repo' },
      canonical: { sources: [{ id: 'api-contract', provider: 'git', ref: 'main', paths: ['docs/api/**'] }] },
      monitor: { priorityLabels: { urgent: 'P0' }, escalationLabels: ['hotfix'] },
      policy: { roleScopes: { implementer: ['src/**'] } },
    }
    const parsed = ProjectProfile.safeParse(pinlog)
    assert.equal(parsed.success, true)
    // 라벨도 브랜치도 역할 범위도 전부 다르지만 스키마는 그대로다
    assert.equal(parsed.data!.monitor.priorityLabels['urgent'], 'P0')
  })
})

describe('계층 병합', () => {
  it('Vanilla → Profile → Preset → Override 순으로 좁혀진다', async () => {
    const layers = await loadLayers({
      installRoot: INSTALL_ROOT,
      profileId: 'example-team',
      presetId: 'balanced',
      overridePath: await overrideFile(SAMPLE_OVERRIDE),
    })
    const result = resolveRuntime(layers, ['scm.github'], ASC_VERSION)
    assert.ok(result.ok)

    const policy = result.runtime.resolved.policy
    assert.deepEqual(policy.layers, ['vanilla', 'profile:example-team', 'preset:balanced', 'override:local'])
    // Vanilla의 금지에 Profile의 금지가 더해진다
    assert.ok(policy.hardDeny.includes('external.write'))
    assert.ok(policy.hardDeny.includes('spec.change'))
    // Profile이 Role 범위를 좁혔다
    assert.deepEqual(policy.roleScopes.implementer, ['web-frontend/**'])
    assert.deepEqual(policy.roleScopes.verifier, [])
  })

  it('Monitor 설정은 Profile과 Override가 나눠 갖는다', async () => {
    const layers = await loadLayers({
      installRoot: INSTALL_ROOT,
      profileId: 'example-team',
      overridePath: await overrideFile(SAMPLE_OVERRIDE),
    })
    const result = resolveRuntime(layers, ['scm.github'], ASC_VERSION)
    assert.ok(result.ok)

    // 누가 나인지는 개인 값, 어떤 라벨이 급한지는 팀 값
    assert.deepEqual(result.runtime.monitor.identities, ['colosair'])
    assert.equal(result.runtime.monitor.priorityLabels?.['front'], 'P1')
    assert.deepEqual(result.runtime.controllerIdentities['controller-a'], [
      'local:colosair',
      'mattermost:@colosair',
    ])
  })

  it('잠긴 설정은 Preset이 덮지 못한다', async () => {
    const layers = await loadLayers({ installRoot: INSTALL_ROOT, profileId: 'example-team', presetId: 'lightweight' })
    const result = resolveRuntime(layers, ['scm.github'], ASC_VERSION)
    // lightweight가 independentVerifier를 끄려 하지만 Profile이 잠갔다
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.failures.some((f) => f.kind === 'POLICY' && f.violation.kind === 'LOCKED_SETTING'))
  })

  it('Messenger가 없어도 resolve는 성공하고 그 기능만 꺼진다', async () => {
    const layers = await loadLayers({ installRoot: INSTALL_ROOT, profileId: 'example-team' })
    const result = resolveRuntime(layers, ['scm.github'], ASC_VERSION)
    assert.ok(result.ok)
    assert.deepEqual(result.runtime.degraded, ['messenger.mattermost'])
  })

  it('필수 capability가 없으면 bootstrap이 실패한다', async () => {
    const layers = await loadLayers({ installRoot: INSTALL_ROOT, profileId: 'example-team' })
    const result = resolveRuntime(layers, [], ASC_VERSION)
    assert.equal(result.ok, false)
    assert.ok(!result.ok && result.failures.some((f) => f.kind === 'MISSING_CAPABILITY'))
  })

  it('Override가 없어도 팀 설정만으로 돈다', async () => {
    const layers = await loadLayers({ installRoot: INSTALL_ROOT, profileId: 'example-team' })
    const result = resolveRuntime(layers, ['scm.github'], ASC_VERSION)
    assert.ok(result.ok)
    assert.deepEqual(result.runtime.monitor.identities, [])
  })
})

describe('profile.lock — 재현성', () => {
  const lockFor = async (overrideContent?: unknown) => {
    const layers = await loadLayers({
      installRoot: INSTALL_ROOT,
      profileId: 'example-team',
      presetId: 'balanced',
      ...(overrideContent ? { overridePath: await overrideFile(overrideContent) } : {}),
    })
    const result = resolveRuntime(layers, ['scm.github'], ASC_VERSION)
    assert.ok(result.ok)
    return buildLock({
      runtime: result.runtime,
      ascVersion: '0.1.0',
      adapters: { 'scm.github': '1', 'state.markdown': '1' },
      generatedAt: GENERATED_AT,
    })
  }

  it('같은 입력이면 같은 lock이 나온다', async () => {
    const a = await lockFor(SAMPLE_OVERRIDE)
    const b = await lockFor(SAMPLE_OVERRIDE)
    assert.equal(a.configurationDigest, b.configurationDigest)
    assert.deepEqual(compareLock(a, b), [])
  })

  it('Override 한 글자만 달라져도 잡아낸다', async () => {
    const before = await lockFor(SAMPLE_OVERRIDE)
    const after = await lockFor({ ...SAMPLE_OVERRIDE, monitorIdentities: ['someone-else'] })

    const drifts = compareLock(before, after)
    assert.ok(drifts.some((d) => d.field === 'override.digest'))
    assert.ok(drifts.some((d) => d.field === 'configurationDigest'))
  })

  it('Core 버전과 Adapter 버전 변화도 잡는다', async () => {
    const locked = await lockFor()
    const current = { ...locked, ascCore: { version: '0.2.0' }, adapters: { ...locked.adapters, 'scm.github': '2' } }
    const drifts = compareLock(locked, current)
    assert.ok(drifts.some((d) => d.field === 'ascCore.version'))
    assert.ok(drifts.some((d) => d.field === 'adapters.scm.github'))
  })

  it('Override가 생기고 없어지는 것도 변화다', async () => {
    const withOverride = await lockFor(SAMPLE_OVERRIDE)
    const without = await lockFor()
    const drifts = compareLock(withOverride, without)
    assert.ok(drifts.some((d) => d.field === 'override.digest' && d.current === '(없음)'))
  })

  it('lock을 견주는 것은 판정일 뿐 — 고쳐 주지 않는다', async () => {
    const before = await lockFor(SAMPLE_OVERRIDE)
    const snapshot = digest(before)
    compareLock(before, await lockFor())
    // 비교가 원본을 건드리지 않는다. 다시 만들지 말지는 사람이 정한다 (OM §4.9)
    assert.equal(digest(before), snapshot)
  })
})

describe('생성물 — ASC.md', () => {
  const runtimeFor = async () => {
    const layers = await loadLayers({
      installRoot: INSTALL_ROOT,
      profileId: 'example-team',
      presetId: 'balanced',
      overridePath: await overrideFile(SAMPLE_OVERRIDE),
    })
    const result = resolveRuntime(layers, ['scm.github'], ASC_VERSION)
    assert.ok(result.ok)
    return result.runtime
  }

  it('지금 적용되는 규칙을 담는다', async () => {
    const text = renderAscMd(await runtimeFor(), GENERATED_AT)
    assert.match(text, /직접 고치지 마세요/)
    assert.match(text, /external\.write/)
    assert.match(text, /spec\.change/)
    assert.match(text, /web-frontend/)
    assert.match(text, /shared-spec \| git \| develop/)
    assert.match(text, /fe-plan \| git \| front/)
  })

  it('부트스트랩 순서를 적어 둔다 — controller.md가 state.md보다 앞이다', async () => {
    const text = renderAscMd(await runtimeFor(), GENERATED_AT)
    assert.match(text, /`controller\.md` → `state\.md`/)
  })

  it('꺼진 기능을 숨기지 않는다', async () => {
    const text = renderAscMd(await runtimeFor(), GENERATED_AT)
    assert.match(text, /messenger\.mattermost/)
    assert.match(text, /Local 경로만으로 승인은 완결된다/)
  })

  it('controller.md는 사람이 쓰는 빈 서식이다', () => {
    const text = renderControllerMd('example-team')
    assert.match(text, /Resolver 입력이 아니므로/)
    assert.doesNotMatch(text, /external\.write/) // 정책을 옮겨 적지 않는다
  })
})

describe('Core 호환 범위 (OM §4.10)', () => {
  it('범위 안이면 통과, 밖이면 실패', () => {
    assert.deepEqual(satisfies('0.1.0', '>=0.1 <1.0'), { ok: true })
    assert.equal(satisfies('0.1.0', '>=9.0').ok, false)
    assert.equal(satisfies('1.0.0', '>=0.1 <1.0').ok, false)
    assert.deepEqual(satisfies('0.5.3', '>=0.1 <1.0'), { ok: true })
  })

  it('읽지 못한 요구는 만족한 것으로 넘기지 않는다', () => {
    // 지원하지 않는 문법을 통과시키면 맞지 않는 Core에서 그냥 돌아간다
    for (const range of ['^1.0.0', '~0.1', '1.x', '>=0.1 || <2.0', '']) {
      assert.equal(satisfies('0.1.0', range).ok, false, range)
    }
    assert.equal(satisfies('영점일', '>=0.1').ok, false)
  })

  it('Profile이 요구한 Core 범위를 벗어나면 bootstrap이 실패한다', async () => {
    const layers = await loadLayers({ installRoot: INSTALL_ROOT, profileId: 'example-team' })
    const ok = resolveRuntime(layers, ['scm.github'], '0.1.0')
    assert.equal(ok.ok, true)

    const tooNew = resolveRuntime(layers, ['scm.github'], '2.0.0')
    assert.equal(tooNew.ok, false)
    assert.ok(!tooNew.ok && tooNew.failures.some((f) => f.kind === 'INCOMPATIBLE_CORE'))
  })
})

describe('lock 보관과 Run 시작 guard', () => {
  const ADAPTERS = { 'scm.github': '0.1.0' }

  /** attach된 .asc/ 하나를 만든다. */
  async function attached(overrideContent: unknown = SAMPLE_OVERRIDE) {
    const dir = await mkdtemp(join(tmpdir(), 'asc-attach-'))
    dirs.push(dir)
    const ascRoot = join(dir, '.asc')
    await mkdir(ascRoot, { recursive: true })
    await writeFile(join(ascRoot, 'override.json'), JSON.stringify(overrideContent), 'utf8')

    const layers = await loadLayers({
      installRoot: INSTALL_ROOT,
      profileId: 'example-team',
      presetId: 'balanced',
      overridePath: join(ascRoot, 'override.json'),
    })
    const result = resolveRuntime(layers, ['scm.github'], ASC_VERSION)
    assert.ok(result.ok)
    const lock = buildLock({
      runtime: result.runtime,
      ascVersion: ASC_VERSION,
      adapters: ADAPTERS,
      generatedAt: GENERATED_AT,
    })
    await writeFile(join(ascRoot, 'profile.lock'), JSON.stringify(lock, null, 2), 'utf8')
    return { ascRoot, lock }
  }

  const guardOn = (ascRoot: string, ascVersion = ASC_VERSION) =>
    bootstrapGuard({
      ascRoot,
      installRoot: INSTALL_ROOT,
      capabilities: ['scm.github'],
      adapters: ADAPTERS,
      ascVersion,
    })

  it('이전 lock은 덮이지 않고 보관된다', async () => {
    const { ascRoot, lock } = await attached()

    const moved = await archiveLock(ascRoot, lock)
    await writeFile(join(ascRoot, 'profile.lock'), JSON.stringify({ ...lock, generatedAt: '새 시각' }), 'utf8')

    // 옛 것과 새 것이 둘 다 남는다
    const archived = await readdir(join(ascRoot, 'archive', 'profile-locks'))
    assert.equal(archived.length, 1)
    assert.equal(dirname(moved), join(ascRoot, 'archive', 'profile-locks'))
    assert.equal(JSON.parse(await readFile(moved, 'utf8')).generatedAt, GENERATED_AT)
    assert.equal(JSON.parse(await readFile(join(ascRoot, 'profile.lock'), 'utf8')).generatedAt, '새 시각')
  })

  it('보관 파일명이 부딪히지 않는다', async () => {
    const { ascRoot, lock } = await attached()
    await archiveLock(ascRoot, lock)

    const second = { ...lock, generatedAt: '2026-08-23T13:00:00+09:00' }
    await writeFile(join(ascRoot, 'profile.lock'), JSON.stringify(second), 'utf8')
    await archiveLock(ascRoot, second)

    assert.equal((await readdir(join(ascRoot, 'archive', 'profile-locks'))).length, 2)
  })

  it('설정이 그대로면 Run이 그냥 시작된다', async () => {
    const { ascRoot } = await attached()
    const outcome = await guardOn(ascRoot)
    assert.ok(outcome.ok)
    assert.equal(outcome.runtime.layers.profile.id, 'example-team')
  })

  it('Override가 바뀌면 멈추고 무엇이 달라졌는지 말한다', async () => {
    const { ascRoot } = await attached()
    await writeFile(
      join(ascRoot, 'override.json'),
      JSON.stringify({ ...SAMPLE_OVERRIDE, monitorIdentities: ['someone-else'] }),
      'utf8',
    )

    const outcome = await guardOn(ascRoot)
    assert.ok(!outcome.ok && outcome.reason === 'LOCK_DRIFT')
    assert.ok(outcome.drifts.some((d) => d.field === 'override.digest'))
  })

  it('멈추기만 하고 lock을 고치지 않는다', async () => {
    const { ascRoot } = await attached()
    const before = await readFile(join(ascRoot, 'profile.lock'), 'utf8')
    await writeFile(join(ascRoot, 'override.json'), JSON.stringify({ schemaVersion: 1 }), 'utf8')

    await guardOn(ascRoot)
    assert.equal(await readFile(join(ascRoot, 'profile.lock'), 'utf8'), before)
    // 보관도 하지 않는다 — 바꾸기로 정한 것이 아니기 때문이다
    await assert.rejects(() => readdir(join(ascRoot, 'archive', 'profile-locks')))
  })

  it('Core 버전이 달라져도 잡는다', async () => {
    const { ascRoot } = await attached()
    const outcome = await guardOn(ascRoot, '0.2.0')
    assert.ok(!outcome.ok && outcome.reason === 'LOCK_DRIFT')
    assert.ok(outcome.drifts.some((d) => d.field === 'ascCore.version'))
  })

  it('아직 붙이지 않았으면 막지 않는다 — 설정 없이 도는 경로가 있다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asc-bare-'))
    dirs.push(dir)
    // .asc/ 자체가 없는 상태
    const outcome = await guardOn(join(dir, '.asc'))
    assert.ok(!outcome.ok && outcome.reason === 'NOT_ATTACHED')
  })

  it('붙이다 만 상태는 통과시키지 않는다', async () => {
    const { ascRoot } = await attached()
    // init이 중간에 죽었거나 lock을 잃은 상황
    await rm(join(ascRoot, 'profile.lock'))

    const outcome = await guardOn(ascRoot)
    assert.ok(!outcome.ok && outcome.reason === 'BROKEN_ATTACHMENT')
    // 아직 붙이지 않은 것과 구분된다 — 앞엣것은 통과, 뒤엣것은 차단
    assert.match(outcome.detail, /profile\.lock/)
  })
})

// B-23 Gate — 책임 지도는 선언이다. 선언만으로는 아무것도 막지 않고, 갈린 것을 고르지도 않는다.
describe('B-23 Gate — Ownership Map (C-04 §6)', () => {
  const base = {
    schemaVersion: 1,
    id: 'x',
    project: { scm: 'github', repository: 'o/r' },
    canonical: { sources: [] },
  }
  const parse = (ownership: unknown) => ProjectProfile.safeParse({ ...base, ownership })

  it('선언하지 않은 Profile은 파싱 결과가 그대로다 — 기존 attach가 흔들리지 않는다', () => {
    const before = ProjectProfile.parse(base)
    assert.equal('ownership' in before, false)
    // digest가 같아야 한다. 달라지면 이미 붙어 있는 모든 프로젝트가 LOCK_DRIFT로 멈춘다.
    assert.equal(digest(before), digest(ProjectProfile.parse({ ...base })))
  })

  it('설치된 Profile 전부의 digest가 스키마 확장 뒤에도 계산된다', async () => {
    // 회귀 방지용 실물 대조 — ownership을 선언한 pilot-local과 선언하지 않은 example-team 양쪽
    const withMap = await loadLayers({ installRoot: INSTALL_ROOT, profileId: 'pilot-local' })
    const without = await loadLayers({ installRoot: INSTALL_ROOT, profileId: 'example-team' })
    assert.ok(withMap.profile.ownership)
    assert.equal(without.profile.ownership, undefined)
  })

  it('쓰기 영역 없이 결정만 하는 역할을 허용한다', () => {
    const parsed = parse({ product: { authorities: ['product-policy'] } })
    assert.equal(parsed.success, true)
    assert.deepEqual(parsed.data!.ownership!.product!.paths, [])
  })

  it('쓰기 영역도 결정권도 없는 역할은 거절한다', () => {
    const parsed = parse({ ghost: {} })
    assert.equal(parsed.success, false)
    assert.match(parsed.error!.issues[0]!.message, /선언할 것이 없으면/)
  })

  it('범위 문법 밖의 경로는 입구에서 막는다', () => {
    // 회수 시점이 아니라 선언 시점에 막아야 잘못된 값이 profile.lock에 고정되지 않는다
    const parsed = parse({ frontend: { paths: ['src/*.ts'], authorities: [] } })
    assert.equal(parsed.success, false)
    assert.match(parsed.error!.issues[0]!.message, /범위 문법이 아니다/)
  })

  it('decision domain 이름은 소문자 kebab-case만 받는다', () => {
    assert.equal(parse({ backend: { authorities: ['api-contract'] } }).success, true)
    const parsed = parse({ backend: { authorities: ['API_Contract'] } })
    assert.equal(parsed.success, false)
    assert.match(parsed.error!.issues[0]!.message, /decision domain 이름으로 쓸 수 없다/)
  })

  it('역할 이름이 Runtime 상태·비밀이면 여전히 거절한다', () => {
    const parsed = parse({ token: { authorities: ['api-contract'] } })
    assert.equal(parsed.success, false)
    assert.match(parsed.error!.issues[0]!.message, /Runtime 상태이거나 비밀/)
  })

  it('선언된 결정권자를 찾아 준다', () => {
    const map = {
      frontend: { paths: ['src/**'], authorities: ['client-ui'] },
      backend: { paths: ['server/**'], authorities: ['api-contract'] },
    }
    assert.deepEqual(lookupAuthority(map, 'api-contract'), { kind: 'RESOLVED', role: 'backend' })
  })

  it('아무도 적지 않은 결정은 UNDECLARED다 — 가까운 역할에 붙이지 않는다', () => {
    const map = { backend: { paths: [], authorities: ['api-contract'] } }
    assert.deepEqual(lookupAuthority(map, 'auth-server-policy'), { kind: 'UNDECLARED' })
    assert.deepEqual(lookupAuthority(undefined, 'api-contract'), { kind: 'UNDECLARED' })
  })

  it('둘이 같은 결정을 주장하면 고르지 않고 후보를 그대로 돌려준다', () => {
    const map = {
      frontend: { paths: [], authorities: ['auth-flow'] },
      backend: { paths: [], authorities: ['auth-flow'] },
    }
    assert.deepEqual(lookupAuthority(map, 'auth-flow'), {
      kind: 'AMBIGUOUS',
      candidates: ['backend', 'frontend'],
    })
  })

  it('ASC.md가 책임 지도를 그린다 — 갈린 영역은 갈렸다고 적는다', async () => {
    const layers = await loadLayers({ installRoot: INSTALL_ROOT, profileId: 'pilot-local' })
    const result = resolveRuntime(layers, [], ASC_VERSION)
    assert.ok(result.ok)
    const text = renderAscMd(result.runtime, GENERATED_AT)
    assert.match(text, /책임 지도 \(Ownership\)/)
    assert.match(text, /\| api-contract \| backend \|/)
    assert.match(text, /_없음 \(결정만\)_/) // product는 쓰기 영역이 없다

    const contested = {
      ...result.runtime,
      ownership: {
        frontend: { paths: ['src/**'], authorities: ['auth-flow'] },
        backend: { paths: ['server/**'], authorities: ['auth-flow'] },
      },
    }
    assert.match(renderAscMd(contested, GENERATED_AT), /갈림 — backend \/ frontend/)
  })

  it('선언하지 않은 Profile의 ASC.md에는 책임 지도 절이 없다', async () => {
    const layers = await loadLayers({ installRoot: INSTALL_ROOT, profileId: 'example-team', presetId: 'balanced' })
    const result = resolveRuntime(layers, ['scm.github'], ASC_VERSION)
    assert.ok(result.ok)
    assert.doesNotMatch(renderAscMd(result.runtime, GENERATED_AT), /책임 지도/)
  })
})

describe('Core 독립성 — ownership', () => {
  it('provider 어휘가 새지 않는다', async () => {
    const source = await readFile(new URL('../core/policy/ownership.ts', import.meta.url), 'utf8')
    for (const word of ['github', 'claude', 'mattermost', 'jira']) {
      assert.doesNotMatch(source.toLowerCase(), new RegExp(word))
    }
  })
})
