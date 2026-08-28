// 로컬 git 관측. 읽기 전용 서브커맨드만 쓰고, 아무것도 바꾸지 않는다.
//
// 실패는 관측 안에서 흡수한다 — git 이 없거나 저장소가 아니면 `unavailable` 이 채워진
// 빈 관측이 나온다. 던지지 않는 이유는 호출측이 "보려 했으나 못 봤다"와 "아예 안 봤다"를
// 구분해야 하기 때문이다. 후자는 이 함수를 부르지 않은 것이고, 그건 판정에서 거부된다.

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { LocalRepoPort, RepoObservation, RepoQuery } from '../../ports/local-repo.ts'

const run = promisify(execFile)

/** 명령 실행. 성공하면 stdout, 실패하면 null — 종료코드로 답하는 질문이 있어서다. */
export type GitRunner = (args: readonly string[]) => Promise<string | null>

export type LocalRepoDeps = {
  cwd: string
  git?: GitRunner
  /** 경로 존재 확인. 테스트에서 갈아끼운다. */
  exists?: (path: string) => Promise<boolean>
}

const defaultGit =
  (cwd: string): GitRunner =>
  async (args) => {
    try {
      const { stdout } = await run('git', ['-C', cwd, ...args])
      return stdout
    } catch {
      return null
    }
  }

const defaultExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export class LocalRepoAdapter implements LocalRepoPort {
  readonly id = 'local-repo'
  readonly #cwd: string
  readonly #git: GitRunner
  readonly #exists: (path: string) => Promise<boolean>

  constructor(deps: LocalRepoDeps) {
    this.#cwd = deps.cwd
    this.#git = deps.git ?? defaultGit(deps.cwd)
    this.#exists = deps.exists ?? defaultExists
  }

  async observe(query: RepoQuery): Promise<RepoObservation> {
    const head = await this.#git(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (head === null) {
      return {
        branch: null,
        remotes: [],
        refs: [],
        pathsExist: {},
        unavailable: 'git 저장소를 읽지 못했다 (git 부재 또는 저장소 아님)',
      }
    }

    const observation: RepoObservation = {
      branch: head.trim() || null,
      remotes: parseRemotes(await this.#git(['remote', '-v'])),
      refs: [],
      pathsExist: {},
    }

    if (query.refHint) {
      observation.refs = filterRefs(
        await this.#git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']),
        query.refHint,
      )
    }

    const canonicalRef = query.canonicalRef ?? (await this.#defaultCanonicalRef())
    if (canonicalRef) {
      observation.canonicalRef = canonicalRef
      observation.mergedIntoCanonical = await this.#anyMerged(observation.refs, canonicalRef)
      if (query.refHint) {
        // 가지가 지워졌어도 이력은 남는다 — 커밋 메시지가 이 작업을 언급하는지 본다.
        const log = await this.#git(['log', '--format=%h %s', `--grep=${query.refHint}`, '-n', '5', canonicalRef])
        observation.mentionedOnCanonical = (log ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      }
    }

    for (const path of query.paths ?? []) {
      observation.pathsExist[path] = await this.#exists(join(this.#cwd, path))
    }

    if (canonicalRef && (query.paths?.length ?? 0) > 0) {
      const onCanonical: Record<string, boolean> = {}
      for (const path of query.paths ?? []) {
        // squash 병합이면 ref 는 조상이 아니다. 산출물이 정본에 있는지는 따로 물어야 한다.
        onCanonical[path] = (await this.#git(['cat-file', '-e', `${canonicalRef}:${path}`])) !== null
      }
      observation.pathsOnCanonical = onCanonical
    }

    return observation
  }

  /**
   * Profile 이 정본 ref 를 선언하지 않았을 때, 저장소 자신에게 묻는다 (origin/HEAD).
   * 추측이 아니라 관측이다 — 없으면 없는 대로 둔다.
   */
  async #defaultCanonicalRef(): Promise<string | undefined> {
    const head = await this.#git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    return head?.trim() || undefined
  }

  async #anyMerged(refs: readonly string[], canonicalRef: string): Promise<boolean> {
    for (const ref of refs) {
      if ((await this.#git(['merge-base', '--is-ancestor', ref, canonicalRef])) !== null) return true
    }
    return false
  }
}

function parseRemotes(stdout: string | null): { name: string; url: string }[] {
  if (!stdout) return []
  const seen = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const [name, url] = line.trim().split(/\s+/)
    if (name && url && !seen.has(name)) seen.set(name, url)
  }
  return [...seen].map(([name, url]) => ({ name, url }))
}

function filterRefs(stdout: string | null, hint: string): string[] {
  if (!stdout) return []
  const needle = hint.toLowerCase()
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((ref) => ref.length > 0 && ref.toLowerCase().includes(needle))
}
