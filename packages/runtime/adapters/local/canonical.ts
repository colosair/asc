// 정본 baseline 을 **선언된 대로** 읽는다.
//
// Profile 은 정본 갈래마다 provider 를 적는다. `git` 이라고 적힌 갈래는 이 checkout 이
// 이미 들고 있는 사실이다 — 원격 API 로 갈 이유가 없고, 갈 수 있다는 보장도 없다.
// 실제로 그 자리에서 한 provider 의 API 로만 읽으려다, 다른 host 를 쓰는 프로젝트에서
// 세션 발급이 통째로 막혔다. 정본을 못 읽으면 무엇을 딛고 시작하는지 적을 수 없기 때문이다.
//
// 여기는 **읽기만** 한다. 쓰기 통로가 아니고, 그 사실을 execute 가 그대로 말한다.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { CanonicalSnapshot } from '../../core/model/entities.ts'
import type {
  BaselineQuery,
  ExternalAction,
  ExternalActionResult,
  ScmPort,
  ThreadSnapshot,
} from '../../ports/scm.ts'

const run = promisify(execFile)

export type LocalCanonicalDeps = {
  cwd: string
  /** sourceId → 어느 ref 를 읽는가. Profile 이 준다. */
  sourceRefs: Readonly<Record<string, { ref: string; remote?: string }>>
  exec?: (args: readonly string[], cwd: string) => Promise<string>
}

export class LocalCanonicalReader implements ScmPort {
  readonly id = 'git'
  #cwd: string
  #refs: Readonly<Record<string, { ref: string; remote?: string }>>
  #exec: (args: readonly string[], cwd: string) => Promise<string>

  constructor(deps: LocalCanonicalDeps) {
    this.#cwd = deps.cwd
    this.#refs = deps.sourceRefs
    this.#exec =
      deps.exec ??
      (async (args, cwd) => {
        const { stdout } = await run('git', [...args], { cwd })
        return stdout.trim()
      })
  }

  async getBaselines(queries: readonly BaselineQuery[]): Promise<CanonicalSnapshot[]> {
    const out: CanonicalSnapshot[] = []
    for (const query of queries) {
      const configured = this.#refs[query.sourceId]
      const ref = query.ref ?? configured?.ref
      if (!ref) {
        out.push({ sourceId: query.sourceId, baseline: 'unknown' })
        continue
      }
      // 원격 추적 ref 를 먼저 본다. 로컬 브랜치를 정본처럼 읽으면 내 작업이 정본이 된다.
      const remote = configured?.remote
      const candidates = remote ? [`${remote}/${ref}`, ref] : [ref]
      let baseline = 'unknown'
      for (const candidate of candidates) {
        const sha = await this.#exec(['rev-parse', '--verify', `${candidate}^{commit}`], this.#cwd).catch(() => '')
        if (sha) {
          baseline = sha
          break
        }
      }
      out.push({ sourceId: query.sourceId, baseline })
    }
    return out
  }

  /** 스레드는 이 통로의 것이 아니다. 모르는 것을 아는 척하지 않는다. */
  async getThread(reference: string): Promise<ThreadSnapshot> {
    return { reference, lastEventId: 'unknown', missing: true }
  }

  async execute(action: ExternalAction): Promise<ExternalActionResult> {
    return { ok: false, error: `this canonical reader performs no external action: ${action.action}` }
  }
}
