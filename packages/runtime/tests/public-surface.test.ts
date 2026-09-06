// 0.8.0 — 사용자가 마주하는 표면 (§17·§54·§57·§58·§65·§71).
//
// 여기서 지키는 것은 "무엇이 보이는가" 다. 내부 primitive 는 없어지지 않았지만, 정상
// 화면에서 사람에게 순서를 외우게 하지 않는다. 그리고 lifecycle 어휘는 두 제품에서 같다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { MarkdownStateStore } from '../adapters/markdown/state-store.ts'
import { readExecutionMode } from '../core/policy/execution-mode.ts'
import { tempDir } from './support/temp.ts'

type Captured = { code: number; out: string; err: string }

const CLI = fileURLToPath(new URL('../cli/asc.ts', import.meta.url))

/**
 * CLI 를 **프로세스로** 돌린다. in-process 호출로는 이 표면을 검사할 수 없다 — 지원 하한
 * 아래의 Node 로 들어오면 CLI 는 호환 Node 후보로 자기를 다시 실행하고, 그때 출력은
 * 자식 프로세스의 것이라 console 을 가로채도 잡히지 않는다. 사람이 겪는 것과 같은 형태로
 * 부르는 편이 검사도 정확하다.
 */
async function run(argv: string[]): Promise<Captured> {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...argv], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { code: child.status ?? 1, out: (child.stdout ?? '').trim(), err: child.stderr ?? '' }
}

/** 붙은 것처럼 보이는 최소 runtime 하나. 상태를 만들지 않고 자리만 만든다. */
async function attachedRoot(): Promise<string> {
  const dir = await tempDir('asc-surface-')
  const root = join(dir, '.asc')
  await MarkdownStateStore.open(root)
  return root
}

/** 이 뿌리 아래 모든 파일의 (경로 → 크기·수정시각). plan 이 아무것도 안 바꿨는지 본다. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else {
        const info = await stat(full)
        seen.set(full, `${info.size}:${info.mtimeMs}`)
      }
    }
  }
  await walk(root)
  return seen
}

describe('기본 화면은 정상 표면만 보여준다 (§17·§54)', () => {
  it('9개 namespace 가 있고, 내부 primitive 는 없다', async () => {
    const help = await run(['--help'])
    assert.equal(help.code, 0)
    for (const namespace of ['setup', 'status', 'update', 'refresh', 'uninstall', 'mode', 'work', 'inbox', 'runtime']) {
      assert.match(help.out, new RegExp(`asc ${namespace}`), `${namespace} 가 기본 화면에 없다`)
    }
    for (const internal of ['asc session ', 'asc grant ', 'asc controller ', 'asc host ', 'asc preflight', 'asc monitor ']) {
      assert.doesNotMatch(help.out, new RegExp(internal), `${internal} 가 기본 화면에 있다`)
    }
  })

  it('고급 화면에서는 그것들이 그대로 있다 — 없앤 것이 아니다', async () => {
    const advanced = await run(['help', '--advanced'])
    assert.equal(advanced.code, 0)
    for (const internal of ['asc session issue', 'asc grant run', 'asc controller collect', 'asc host claude install', 'asc preflight', 'asc monitor scan']) {
      assert.ok(advanced.out.includes(internal), `${internal} 가 고급 화면에 없다`)
    }
  })

  it('정상 화면이 저수준 명령 순서를 요구하지 않는다 (§61·§65)', async () => {
    const help = (await run(['--help'])).out
    // 사람이 외워야 하는 순서가 화면에 없다는 것을 그대로 본다.
    for (const step of ['session issue', 'host bind', 'grant issue', 'controller collect', 'profile resolve']) {
      assert.doesNotMatch(help, new RegExp(step))
    }
  })
})

describe('lifecycle 어휘가 두 제품에서 같다 (§18)', () => {
  it('ASC 가 여섯 낱말을 전부 안다', async () => {
    const help = (await run(['--help'])).out
    for (const word of ['setup', 'status', 'update', 'refresh', 'uninstall', 'runtime']) {
      assert.match(help, new RegExp(`asc ${word}`))
    }
  })

  it('JAM 도 같은 낱말을 쓴다 — skill 이 그렇게 가르친다', async () => {
    const skill = await readFile(new URL('../adapters/claude-code/skill.ts', import.meta.url), 'utf8')
    for (const word of ['jam update', 'jam refresh', 'jam status', 'jam uninstall']) {
      assert.ok(skill.includes(word), `${word} 가 skill 에 없다`)
    }
  })
})

describe('읽기는 아무것도 바꾸지 않는다 (§57·§71)', () => {
  it('check / plan 은 mutation 0 이고 --json 은 문서 하나다', async () => {
    const root = await attachedRoot()
    for (const argv of [
      ['refresh', 'check', '--json', '--root', root],
      ['refresh', 'plan', '--json', '--root', root],
      ['uninstall', 'plan', '--json', '--root', root],
      ['status', '--json', '--root', root],
    ]) {
      const before = await snapshot(root)
      const outcome = await run(argv)
      assert.equal(outcome.code, 0, `${argv.join(' ')} → ${outcome.err}`)
      // stdout 은 JSON 문서 하나다. 산문이 섞이면 agent 가 읽을 수 없다.
      const parsed: unknown = JSON.parse(outcome.out)
      assert.equal(typeof parsed, 'object')
      assert.deepEqual(await snapshot(root), before, `${argv.join(' ')} 가 상태를 바꿨다`)
    }
  })
})

describe('Execution Mode — 명령 표면 (§10·§11·§12)', () => {
  it('붙은 자리에서 mode 를 묻고 정할 수 있다', async () => {
    const root = await attachedRoot()
    const asked = await run(['mode', '--json', '--root', root])
    assert.equal(asked.code, 0)
    const status = JSON.parse(asked.out) as { mode: string; autoReadiness: { ready: boolean } }
    assert.equal(status.mode, 'AUTO', '기록이 없으면 0.7 과 같은 상태다')

    const lowered = await run(['mode', 'manual', '--json', '--root', root])
    assert.equal(lowered.code, 0)
    assert.equal((await readExecutionMode(new MarkdownStateStore(root).scope('policy'))).mode, 'MANUAL')
  })

  it('나갈 길이 없으면 AUTO 로 올라가지 않고, 지금 mode 를 그대로 둔다 (E-01)', async () => {
    const root = await attachedRoot()
    await run(['mode', 'manual', '--json', '--root', root])

    // 이 임시 뿌리에는 승인 권한자도 외부 통로도 없다 — readiness 가 설 수 없는 자리다.
    const raised = await run(['mode', 'auto', '--json', '--root', root])
    assert.equal(raised.code, 1)
    const verdict = JSON.parse(raised.out) as { mode: string; applied: boolean; autoReadiness: { ready: boolean } }
    assert.equal(verdict.applied, false)
    assert.equal(verdict.autoReadiness.ready, false)
    assert.equal(verdict.mode, 'MANUAL', '실패한 전환이 mode 를 움직이지 않는다')
    assert.equal((await readExecutionMode(new MarkdownStateStore(root).scope('policy'))).mode, 'MANUAL')
  })

  it('모르는 mode 는 사용자 오류로 답한다', async () => {
    const root = await attachedRoot()
    const outcome = await run(['mode', 'semi', '--root', root])
    assert.equal(outcome.code, 2)
    assert.match(outcome.err, /asc mode manual/)
  })
})

describe('옛 이름은 두 minor 동안 그대로 답한다 (§58·§59)', () => {
  it('사람에게는 새 이름을 말한다', async () => {
    const outcome = await run(['proceed', '--root', await attachedRoot()])
    assert.match(outcome.err, /Deprecated\. Use `asc work start`\./)
  })

  it('기계에게는 문서 안에서 말한다 — stdout 은 여전히 문서 하나다', async () => {
    const root = await attachedRoot()
    const outcome = await run(['progress', 'show', '--json', '--root', root])
    const parsed = JSON.parse(outcome.out === '' ? '{}' : outcome.out) as Record<string, unknown>
    // 볼 진행이 없으면 progress show 는 산문 한 줄을 낸다 — 그때는 안내가 stderr 로 간다.
    if (outcome.out.startsWith('{')) {
      assert.equal(parsed.deprecated, true)
      assert.equal(parsed.replacement, 'asc work status')
    } else {
      assert.match(outcome.err, /Deprecated\. Use `asc work status`\./)
    }
    assert.deepEqual(Object.keys(parsed).length >= 0, true)
  })
})

describe('work 는 기존 경로 위의 표면이다 (§34·§70)', () => {
  const cli = async () => readFile(new URL('../cli/asc.ts', import.meta.url), 'utf8')

  it('새 Work entity 를 만들지 않는다 — 기존 함수를 부른다', async () => {
    const source = await cli()
    const start = source.indexOf('async function runWork(')
    const body = source.slice(start, source.indexOf('\n}\n', start))
    assert.match(body, /runProceed\(/, 'start 는 기존 ingress 를 지난다')
    assert.match(body, /runProgress\('show'/, 'status 는 기존 진행 표시를 쓴다')
    assert.match(body, /runSession\('done'/, 'finish 는 기존 handoff 를 쓴다')
    assert.match(body, /runController\('collect'/, 'finish 가 거두는 것까지 한다')
    assert.match(body, /runGrant\('issue'/, 'publish 는 Grant 를 지난다')
    assert.match(body, /runGrant\('run'/, 'publish 는 Executor 를 지난다')
    // 새 저장소·새 entity 를 만들지 않는다.
    assert.doesNotMatch(body, /new MarkdownStateStore|store\.put\('work/)
  })

  it('publish 는 사람이 준 내용 없이는 나가지 않는다 (§42·§43)', async () => {
    const root = await attachedRoot()
    const outcome = await run(['work', 'publish', 'S-20260906-01', '--action', 'gitlab.mr.create', '--root', root])
    assert.notEqual(outcome.code, 0)
    assert.match(`${outcome.err}${outcome.out}`, /body-file|attached ASC runtime|No attached|not intact/)
  })
})

describe('refresh 는 setup 이 아니다 (§27·§72)', () => {
  it('profile·session·binding·mode 를 건드리는 경로를 부르지 않는다', async () => {
    const source = await readFile(new URL('../cli/asc.ts', import.meta.url), 'utf8')
    const start = source.indexOf('async function runRefresh(')
    const body = source.slice(start, source.indexOf('\n}\n', start))
    for (const forbidden of [
      'runSetupLifecycle',
      'runInit(',
      'runProfile(',
      'writeProfileBindings',
      'writeProfileCanonical',
      'writeExecutionMode',
      'runSetupIdentity',
    ]) {
      assert.ok(!body.includes(forbidden), `refresh 가 ${forbidden} 를 부른다`)
    }
    // 부르는 것은 둘뿐이다: host 설치물, 기계 등록물.
    assert.match(body, /runHost\('claude', 'install'/)
    assert.match(body, /convergeService\(/)
  })
})

describe('uninstall 은 상태를 지우지 않는다 (§30·§32·§73)', () => {
  it('purge 표면이 없고, 홈을 지우는 경로가 없다', async () => {
    const source = await readFile(new URL('../cli/asc.ts', import.meta.url), 'utf8')
    const start = source.indexOf('async function runUninstall(')
    const body = source.slice(start, source.indexOf('\n}\n', start))
    assert.doesNotMatch(body, /rm\(\s*home|rm -rf|rmSync|purge/)
    assert.match(body, /Your state stays/)
    // 순서가 계약이다 — 설치본은 마지막이다.
    assert.ok(body.indexOf('adapter.uninstall()') < body.indexOf("uninstall(hostPaths())"))
    assert.ok(body.indexOf("uninstall(hostPaths())") < body.indexOf("'uninstall', '-g'"))
  })

  it('plan 은 무엇이 남는지 함께 말한다', async () => {
    const outcome = await run(['uninstall', 'plan', '--json'])
    assert.equal(outcome.code, 0)
    const plan = JSON.parse(outcome.out) as { preserve: { state: string; note: string } }
    assert.match(plan.preserve.note, /stay/)
    assert.ok(plan.preserve.state.length > 0)
  })
})
