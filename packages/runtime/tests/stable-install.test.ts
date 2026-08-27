// B-70 closure Gate — 이 machine에 stable `asc` 가 있는가 (C-14 §3, 불변식 ⑧·⑯·⑰).
//
// 두 가지가 핵심이다.
//   ① bootstrap이 들고 온 임시 runtime을 "설치됨"으로 오판하지 않는다
//   ② agent에게 주는 command는 지금 이 machine 상태에서 그대로 실행된다

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  computeSetupPlan,
  applySetupPlan,
  renderSetupPlan,
  type SetupChange,
  type SetupState,
} from '../core/attach/setup-plan.ts'
import {
  BOOTSTRAP_SPEC,
  RELEASE_VERSION,
  RUNTIME_PACKAGE,
  portableCommand,
  shorthandCommand,
} from '../core/distribution/release.ts'
import {
  detectStableInstall,
  installStableRuntime,
  verifyStableInstall,
  type ProcessRunner,
} from '../core/distribution/runtime-install.ts'

/** npm/which를 흉내낸다. 실제 전역 npm·PATH·HOME은 테스트에서 건드리지 않는다 (C-14 §11). */
function fakeRunner(opts: {
  globalVersion?: string
  ascOnPath?: boolean
  installFails?: boolean
  installedAfter?: string
}): { run: ProcessRunner; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = []
  let version = opts.globalVersion
  const run: ProcessRunner = async (command, args) => {
    calls.push({ command, args: [...args] })
    if (command === 'npm' && args[0] === 'ls') {
      const tree = version ? { dependencies: { [RUNTIME_PACKAGE]: { version } } } : { dependencies: {} }
      return { ok: true, stdout: JSON.stringify(tree), stderr: '' }
    }
    if (command === 'npm' && args[0] === 'install') {
      if (opts.installFails) return { ok: false, stdout: '', stderr: 'EACCES: permission denied' }
      version = opts.installedAfter ?? RELEASE_VERSION
      return { ok: true, stdout: '', stderr: '' }
    }
    // which/where asc
    return opts.ascOnPath === false
      ? { ok: false, stdout: '', stderr: '' }
      : { ok: true, stdout: '/usr/local/bin/asc\n', stderr: '' }
  }
  return { run, calls }
}

const state = (over: Partial<SetupState> = {}): SetupState => ({
  projectRoot: '/tmp/project',
  git: true,
  profileCandidates: ['pilot-local'],
  scope: 'local',
  host: [{ id: 'claude', status: 'INSTALLED_CURRENT' }],
  ...over,
})

describe('B-70 Gate — stable install detect (C-14 §3)', () => {
  it('전역에 없으면 NOT_INSTALLED다', async () => {
    const { run } = fakeRunner({})
    const found = await detectStableInstall(run)
    assert.equal(found.status, 'NOT_INSTALLED')
    assert.equal(found.installedVersion, undefined)
  })

  it('bootstrap이 들고 온 자기 의존성을 설치됨으로 세지 않는다', async () => {
    // `npm ls -g` 는 전역 트리만 본다. 그것이 이 판정이 npx 캐시에 속지 않는 이유다.
    const { run, calls } = fakeRunner({})
    await detectStableInstall(run)
    const ls = calls.find((c) => c.command === 'npm' && c.args[0] === 'ls')
    assert.ok(ls, 'npm ls 를 부르지 않았다')
    assert.ok(ls!.args.includes('-g'), '전역이 아닌 트리를 봤다')
  })

  it('기대 버전이 있고 실행물이 보이면 CURRENT다', async () => {
    const { run } = fakeRunner({ globalVersion: RELEASE_VERSION, ascOnPath: true })
    assert.equal((await detectStableInstall(run)).status, 'CURRENT')
  })

  it('버전이 다르면 VERSION_MISMATCH다 — 무엇이 있는지 함께 든다', async () => {
    const { run } = fakeRunner({ globalVersion: '0.0.9', ascOnPath: true })
    const found = await detectStableInstall(run)
    assert.equal(found.status, 'VERSION_MISMATCH')
    assert.equal(found.installedVersion, '0.0.9')
    assert.match(found.detail ?? '', /0\.0\.9/)
  })

  it('설치는 됐는데 실행물이 안 보이면 BROKEN이다 — 성공으로 뭉개지 않는다', async () => {
    const { run } = fakeRunner({ globalVersion: RELEASE_VERSION, ascOnPath: false })
    const found = await detectStableInstall(run)
    assert.equal(found.status, 'BROKEN')
    assert.equal(found.executableVisible, false)
  })
})

describe('B-70 Gate — plan이 설치를 드러낸다 (불변식 ⑩)', () => {
  const runtime = (status: 'NOT_INSTALLED' | 'CURRENT' | 'VERSION_MISMATCH' | 'BROKEN', installed?: string) => ({
    status,
    expectedVersion: RELEASE_VERSION,
    ...(installed ? { installedVersion: installed } : {}),
    executableVisible: status === 'CURRENT',
  })

  it('없으면 정확히 한 번 설치를 계획한다', () => {
    const plan = computeSetupPlan(state({ stableRuntime: runtime('NOT_INSTALLED') }))
    const installs = plan.changes.filter((c) => c.target === 'runtime-install')
    assert.equal(installs.length, 1)
    assert.deepEqual(installs[0], {
      target: 'runtime-install',
      package: RUNTIME_PACKAGE,
      version: RELEASE_VERSION,
      strategy: 'npm-global',
      from: 'NOT_INSTALLED',
    })
  })

  it('CURRENT면 runtime 변경이 0이다', () => {
    const plan = computeSetupPlan(state({ ascRoot: '/w', stableRuntime: runtime('CURRENT', RELEASE_VERSION) }))
    assert.equal(plan.changes.some((c) => c.target === 'runtime-install'), false)
    assert.equal(plan.status, 'already_configured')
  })

  it('버전이 다르면 기대 버전으로 수렴시킨다', () => {
    const plan = computeSetupPlan(state({ stableRuntime: runtime('VERSION_MISMATCH', '0.0.9') }))
    const install = plan.changes.find((c) => c.target === 'runtime-install')
    assert.equal(install && 'version' in install ? install.version : null, RELEASE_VERSION)
  })

  it('BROKEN도 수렴 대상이다', () => {
    const plan = computeSetupPlan(state({ stableRuntime: runtime('BROKEN', RELEASE_VERSION) }))
    assert.equal(plan.changes.some((c) => c.target === 'runtime-install'), true)
  })

  it('runtime 축을 넘기지 않으면 그리지 않는다 — 설치된 runtime은 자기를 다시 설치하지 않는다', () => {
    const plan = computeSetupPlan(state())
    assert.equal(plan.changes.some((c) => c.target === 'runtime-install'), false)
    assert.equal(plan.executionMode, 'bootstrap')
  })

  it('사람이 profile을 골라야 해도 설치 준비는 계획에 남는다 (C-13 dependency-local)', () => {
    const plan = computeSetupPlan(
      state({ profileCandidates: ['a', 'b'], stableRuntime: runtime('NOT_INSTALLED') }),
    )
    assert.equal(plan.code, 'ASC_PROFILE_SELECTION_REQUIRED')
    assert.equal(plan.requiresUserAction, true)
    assert.equal(
      plan.changes.some((c) => c.target === 'runtime-install'),
      true,
      '관계없는 준비까지 통째로 WAIT 하지 않는다',
    )
  })

  it('runtime과 host가 둘 다 필요하면 둘 다 담는다', () => {
    const plan = computeSetupPlan(
      state({
        ascRoot: '/w',
        stableRuntime: runtime('NOT_INSTALLED'),
        host: [{ id: 'claude', status: 'INSTALLED_STALE' }],
      }),
    )
    assert.deepEqual(
      plan.changes.map((c) => c.target).sort(),
      ['host-install', 'runtime-install'],
    )
  })

  it('사람이 읽는 줄이 무엇을 설치하는지 말한다', () => {
    const plan = computeSetupPlan(state({ stableRuntime: runtime('NOT_INSTALLED') }))
    assert.match(renderSetupPlan(plan).join('\n'), /install @asc-agent\/runtime@0\.1\.0 globally/)
  })
})

describe('B-70 Gate — apply는 exact 전역 설치만 한다 (불변식 ⑧)', () => {
  it('exact version으로, 전역으로, 딱 그 변경만', async () => {
    const { run, calls } = fakeRunner({})
    const plan = computeSetupPlan(
      state({
        ascRoot: '/w',
        stableRuntime: { status: 'NOT_INSTALLED', expectedVersion: RELEASE_VERSION, executableVisible: false },
      }),
    )
    const done: SetupChange[] = []
    await applySetupPlan(plan, {
      installRuntime: async (change) => {
        done.push(change)
        await installStableRuntime(run, change.version)
      },
      attachWorkspace: async () => assert.fail('계획에 없는 변경'),
      installHost: async () => assert.fail('계획에 없는 변경'),
    })
    assert.deepEqual(done, plan.changes)
    const install = calls.find((c) => c.args[0] === 'install')
    assert.deepEqual(install?.args, ['install', '-g', `${RUNTIME_PACKAGE}@${RELEASE_VERSION}`])
  })

  it('floating spec을 쓰지 않는다', async () => {
    const { run, calls } = fakeRunner({})
    await installStableRuntime(run)
    const spec = calls.find((c) => c.args[0] === 'install')!.args[2]!
    assert.doesNotMatch(spec, /@latest$|@\d+$/)
    assert.ok(spec.endsWith(`@${RELEASE_VERSION}`))
  })

  it('설치 실패를 성공으로 삼키지 않는다', async () => {
    const { run } = fakeRunner({ installFails: true })
    const outcome = await installStableRuntime(run)
    assert.equal(outcome.ok, false)
    assert.match(outcome.detail ?? '', /EACCES/)
  })
})

describe('B-70 Gate — verify는 exit 0을 믿지 않는다 (C-14 §3.3)', () => {
  it('버전과 실행물이 둘 다 맞아야 통과다', async () => {
    const { run } = fakeRunner({ globalVersion: RELEASE_VERSION, ascOnPath: true })
    assert.equal((await verifyStableInstall(run)).ok, true)
  })

  it('설치는 됐는데 안 보이면 새 터미널을 열라고 말한다', async () => {
    const { run } = fakeRunner({ globalVersion: RELEASE_VERSION, ascOnPath: false })
    const verified = await verifyStableInstall(run)
    assert.equal(verified.ok, false)
    assert.match(verified.remedy ?? '', /Open a new terminal/)
  })

  it('버전이 어긋나면 통과하지 않는다', async () => {
    const { run } = fakeRunner({ globalVersion: '0.0.9', ascOnPath: true })
    assert.equal((await verifyStableInstall(run)).ok, false)
  })

  it('설치 뒤 다시 계획하면 남은 설치가 없다 — 멱등', async () => {
    const { run } = fakeRunner({})
    await installStableRuntime(run)
    const after = computeSetupPlan(state({ ascRoot: '/w', stableRuntime: await detectStableInstall(run) }))
    assert.equal(after.changes.some((c) => c.target === 'runtime-install'), false)
  })
})

describe('B-70 Gate — invocation portability (C-14 §3.4, 불변식 ⑯)', () => {
  it('설치 전에는 실행 가능한 action이 bare asc가 아니다', () => {
    const plan = computeSetupPlan(
      state({
        profileCandidates: ['a', 'b'],
        stableRuntime: { status: 'NOT_INSTALLED', expectedVersion: RELEASE_VERSION, executableVisible: false },
      }),
    )
    assert.equal(plan.executionMode, 'bootstrap')
    for (const action of plan.actions) {
      assert.doesNotMatch(action.portable, /^asc /, 'fresh machine에서 실행되지 않는 명령을 줬다')
      assert.ok(action.portable.startsWith(`npx --yes ${BOOTSTRAP_SPEC}`))
      assert.match(action.display, /^asc /, '사람이 읽는 형태는 짧아야 한다')
    }
    for (const command of plan.nextActions) assert.doesNotMatch(command, /^asc /)
  })

  it('설치 뒤에는 둘이 같다 — asc 자체가 portable이다', () => {
    const plan = computeSetupPlan(
      state({
        ascRoot: '/w',
        stableRuntime: {
          status: 'CURRENT',
          expectedVersion: RELEASE_VERSION,
          installedVersion: RELEASE_VERSION,
          executableVisible: true,
        },
      }),
    )
    assert.equal(plan.executionMode, 'installed-runtime')
    for (const action of plan.actions) assert.equal(action.portable, action.display)
  })

  it('두 형태를 만드는 곳이 하나다', () => {
    assert.equal(shorthandCommand(['setup', 'apply']), 'asc setup apply')
    assert.equal(portableCommand(['setup', 'apply']), `npx --yes ${BOOTSTRAP_SPEC} setup apply`)
    assert.ok(BOOTSTRAP_SPEC.endsWith(`@${RELEASE_VERSION}`))
  })

  it('agent가 산문을 읽을 필요가 없다 — action은 타입과 명령을 데이터로 든다', () => {
    const plan = computeSetupPlan(
      state({ profileCandidates: ['a', 'b'], stableRuntime: { status: 'NOT_INSTALLED', expectedVersion: RELEASE_VERSION, executableVisible: false } }),
    )
    assert.equal(plan.actions[0]?.type, 'select_profile')
    assert.equal(typeof plan.actions[0]?.portable, 'string')
  })
})
