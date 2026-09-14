// 로컬 git 관측. 읽기 전용 서브커맨드만 쓰고, 아무것도 바꾸지 않는다.
//
// 실패는 관측 안에서 흡수한다 — git 이 없거나 저장소가 아니면 `unavailable` 이 채워진
// 빈 관측이 나온다. 던지지 않는 이유는 호출측이 "보려 했으나 못 봤다"와 "아예 안 봤다"를
// 구분해야 하기 때문이다. 후자는 이 함수를 부르지 않은 것이고, 그건 판정에서 거부된다.

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
  readonly #gitIn: (cwd: string, args: readonly string[]) => Promise<string | null>

  constructor(deps: LocalRepoDeps) {
    this.#cwd = deps.cwd
    this.#git = deps.git ?? defaultGit(deps.cwd)
    this.#exists = deps.exists ?? defaultExists
    // 다른 worktree 를 볼 때만 쓴다. 주입된 runner 는 이 저장소 하나에 묶여 있으므로, 테스트가
    // 주입한 경우에는 그 runner 에 `-C <path>` 를 앞세워 넘긴다 — 같은 가짜가 답한다.
    this.#gitIn = deps.git ? async (cwd, args) => deps.git!(['-C', cwd, ...args]) : async (cwd, args) => defaultGit(cwd)(args)
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
      // 그 가지가 다른 worktree 에서 진행 중인가 — 여기 없는 곳의 미커밋 작업까지 본다 (P5)
      const elsewhere = await this.#inProgressElsewhere(observation.refs)
      if (elsewhere.length > 0) observation.inProgressElsewhere = elsewhere
    }

    // 신선도가 먼저다. 로컬 브랜치를 정본처럼 읽으면 원격이 전진한 사실을 모른 채
    // "구현 증거가 없다"가 나온다 — 그것이 이 어댑터가 실전에서 낸 사고였다.
    const canonical = await this.#freshCanonical(query)
    const canonicalRef = canonical.ref
    observation.freshness = canonical.freshness
    if (canonicalRef) {
      observation.canonicalRef = canonicalRef
      // 정본에서 방금 만든 빈 가지는 자명하게 조상이다 — 그것을 "병합됐다" 로 읽던 자리 (P5).
      // 이 작업의 commit 이 하나도 없는 가지는 증거에서 뺀다.
      const empty = query.refHint ? await this.#emptyRefs(observation.refs, canonicalRef, query.refHint) : []
      if (empty.length > 0) observation.emptyRefs = empty
      const substantive = observation.refs.filter((ref) => !empty.includes(ref))
      observation.mergedIntoCanonical = await this.#anyMerged(substantive, canonicalRef)
      if (observation.mergedIntoCanonical !== true && substantive.length > 0) {
        const equivalent = await this.#contentEquivalent(substantive, canonicalRef)
        if (equivalent !== undefined) observation.contentEquivalent = equivalent
      }
      if (query.refHint) {
        // 가지가 지워졌어도 이력은 남는다 — 커밋 메시지가 이 작업을 **정확히** 언급하는지 본다.
        // 부분 문자열(`KEY-64` ⊂ `KEY-641`)은 다른 작업이다 (P5).
        const log = await this.#git([
          'log',
          '--format=%h %s',
          '-E',
          `--grep=${exactKeyPattern(query.refHint)}`,
          '-n',
          '5',
          canonicalRef,
        ])
        const mentions = (log ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
        observation.mentionedOnCanonical = mentions

        if (mentions.length > 0) {
          // 언급만으로는 부족하다. 무엇을 건드린 커밋인지, 그 결과가 지금도 남아 있는지
          // 본다 — 되돌린 커밋도 이 작업을 "언급"하기 때문이다.
          const survival = await this.#survivalOf(mentions, canonicalRef, query.paths ?? [])
          observation.mentionedOnlyReverts = survival.onlyReverts
          if (survival.artifactsPresent !== undefined) {
            observation.mentionedArtifactsPresent = survival.artifactsPresent
          }
          if (survival.pathsOverlap !== undefined) observation.mentionedPathsOverlap = survival.pathsOverlap
        }
      }
    }

    for (const path of query.paths ?? []) {
      observation.pathsExist[path] = await this.#exists(join(this.#cwd, path))
    }

    if ((query.modulePaths?.length ?? 0) > 0) {
      const modules: Record<string, boolean> = {}
      for (const path of query.modulePaths ?? []) modules[path] = await this.#exists(join(this.#cwd, path))
      observation.modulesPresent = modules
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
   * 정본 대조 기준과 그 신선도. Profile 이 remote 를 선언했으면 당겨 온 뒤 원격 추적
   * ref 를 기준으로 삼는다 — fetch 는 읽기다(원격 write 가 아니다). 실패는 흡수하되
   * FETCH_FAILED 로 남긴다: "당기지 못했다"와 "저장소가 없다"는 다른 사실이다.
   */
  async #freshCanonical(
    query: RepoQuery,
  ): Promise<{ ref?: string; freshness: NonNullable<RepoObservation['freshness']> }> {
    const declared = query.canonicalRef
    if (query.remote && declared) {
      const branch = declared.startsWith(`${query.remote}/`)
        ? declared.slice(query.remote.length + 1)
        : declared
      const fetched = await this.#git(['fetch', query.remote, branch])
      const tracking = `${query.remote}/${branch}`
      if (fetched !== null) return { ref: tracking, freshness: { state: 'FRESH' } }
      // 당기지 못했어도 원격 추적 ref 가 있으면 그쪽이 로컬 브랜치보다 정본에 가깝다.
      const trackingExists = (await this.#git(['rev-parse', '--verify', '--quiet', tracking])) !== null
      return {
        ref: trackingExists ? tracking : declared,
        freshness: { state: 'FETCH_FAILED', detail: `git fetch ${query.remote} ${branch} 실패` },
      }
    }
    const ref = declared ?? (await this.#defaultCanonicalRef())
    return { ref, freshness: { state: 'UNKNOWN', detail: '당겨 올 원격이 선언되지 않았다' } }
  }

  /**
   * 조상은 아니지만 내용이 전부 정본에 있는가 (단일 커밋 squash·rebase·cherry-pick 등가).
   * `git cherry` 는 patch-id 로 대조한다 — `-` 만 나오면 전부 반영, `+` 가 있으면 남은
   * 커밋이 있다. 빈 출력은 가지가 정본과 같다는 뜻이라 반영으로 친다.
   *
   * 한계(검증자 실측): **여러 커밋을 하나로 합친 squash 는 못 잡는다** — 합쳐진 patch-id
   * 는 개별 커밋 어느 것과도 일치하지 않는다. 그 경우 커밋 메시지의 키 언급(grep)이
   * 남은 통로이고, 그것마저 없으면 이 관측은 반영 사실을 모른다.
   */
  async #contentEquivalent(refs: readonly string[], canonicalRef: string): Promise<boolean | undefined> {
    let measured = false
    for (const ref of refs) {
      const out = await this.#git(['cherry', canonicalRef, ref])
      if (out === null) continue
      measured = true
      const lines = out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      if (lines.every((line) => line.startsWith('-'))) return true
    }
    return measured ? false : undefined
  }

  /**
   * Profile 이 정본 ref 를 선언하지 않았을 때, 저장소 자신에게 묻는다 (origin/HEAD).
   * 추측이 아니라 관측이다 — 없으면 없는 대로 둔다.
   */
  async #defaultCanonicalRef(): Promise<string | undefined> {
    const head = await this.#git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    return head?.trim() || undefined
  }

  /**
   * 언급 커밋들이 남긴 것이 지금도 있는가. 되돌리기만 있으면 그 사실을 따로 말한다.
   *
   * 파일 목록을 하나도 못 읽으면 `artifactsPresent` 는 undefined 다 — "없다"가 아니라
   * "확인하지 못했다" 이고, 그 둘을 합치면 판정이 거짓을 만든다.
   */
  async #survivalOf(
    mentions: readonly string[],
    canonicalRef: string,
    workPaths: readonly string[] = [],
  ): Promise<{ onlyReverts: boolean; artifactsPresent?: boolean; pathsOverlap?: boolean }> {
    const commits = mentions.map((line) => {
      const at = line.indexOf(' ')
      return { hash: at > 0 ? line.slice(0, at) : line, subject: at > 0 ? line.slice(at + 1) : '' }
    })
    const onlyReverts = commits.every((commit) => /^revert\b/i.test(commit.subject.trim()))

    let readAny = false
    let present = false
    let overlap: boolean | undefined = workPaths.length > 0 ? false : undefined
    for (const commit of commits) {
      if (/^revert\b/i.test(commit.subject.trim())) continue
      const listed = await this.#git(['show', '--name-status', '--format=', commit.hash])
      if (listed === null) continue
      readAny = true
      const changed = changedPaths(listed)
      // 이 작업의 경로와 겹치는가 — 키가 같아도 다른 작업의 commit 일 수 있다 (P5)
      if (overlap === false && changed.some((path) => workPaths.some((wp) => sharesPath(path, wp)))) overlap = true
      if (!present) {
        for (const path of changed.slice(0, 20)) {
          if ((await this.#git(['cat-file', '-e', `${canonicalRef}:${path}`])) !== null) {
            present = true
            break
          }
        }
      }
    }
    if (!readAny) return { onlyReverts }
    return { onlyReverts, artifactsPresent: present, ...(overlap !== undefined ? { pathsOverlap: overlap } : {}) }
  }

  /**
   * 정본과 같은 tip 이면서 이 작업의 commit 이 없는 가지 (P5). `rev-list --count canonical..ref` 가 0 이고
   * tip 의 제목이 키를 언급하지 않으면 "방금 정본에서 만든 가지" 다 — 조상 관계는 증거가 아니다.
   */
  async #emptyRefs(refs: readonly string[], canonicalRef: string, key: string): Promise<string[]> {
    const out: string[] = []
    const exact = new RegExp(exactKeyPattern(key), 'i')
    for (const ref of refs) {
      const ahead = await this.#git(['rev-list', '--count', `${canonicalRef}..${ref}`])
      if (ahead === null || Number(ahead.trim()) !== 0) continue
      const subject = (await this.#git(['log', '-1', '--format=%s', ref])) ?? ''
      if (!exact.test(subject)) out.push(ref)
    }
    return out
  }

  /** 작업 가지가 다른 worktree 에 checkout 돼 있고 거기 미커밋 변경이 있는가 (P5). */
  async #inProgressElsewhere(refs: readonly string[]): Promise<{ ref: string; path: string; uncommitted: number }[]> {
    if (refs.length === 0) return []
    const listed = await this.#git(['worktree', 'list', '--porcelain'])
    if (!listed) return []
    const out: { ref: string; path: string; uncommitted: number }[] = []
    let path: string | undefined
    for (const line of listed.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
      if (line.startsWith('branch ') && path && resolve(path) !== resolve(this.#cwd)) {
        const branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
        if (!refs.includes(branch)) continue
        const status = await this.#gitIn(path, ['status', '--porcelain'])
        const uncommitted = (status ?? '').split('\n').filter((l) => l.trim().length > 0).length
        out.push({ ref: branch, path, uncommitted })
      }
    }
    return out
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
  // 정확한 키 일치 — `PROJ-64` 는 `feat/PROJ-641-x` 에 걸리지 않는다 (P5)
  const exact = new RegExp(exactKeyPattern(hint), 'i')
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((ref) => ref.length > 0 && exact.test(ref))
}

/** 키가 단어 경계 안에서 통째로 나타나는 ERE. 앞뒤에 영숫자가 붙으면 다른 키다. */
export function exactKeyPattern(key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`
}

/**
 * 두 경로가 같은 자리인가 — 같거나, 하나가 다른 하나의 접두 디렉터리이거나, 작업 항목이 적은 경로가
 * 저장소 경로의 **꼬리**와 맞는다. 마지막 것이 필요한 이유: monorepo 에서 작업 항목은 패키지 안의
 * 상대 경로(`tools/devGateway.mjs`)를 적고 commit 은 뿌리 기준(`festa-frontend/tools/devGateway.mjs`)
 * 으로 남는다 — 0.10.0 게시본 acceptance 에서 병합된 작업이 이 차이로 UNDECIDABLE 이 됐다.
 */
function sharesPath(changed: string, workPath: string): boolean {
  const a = changed.replace(/\/+$/, '')
  const b = workPath.replace(/^\.?\//, '').replace(/\/+$/, '').replace(/\/\*\*?$/, '')
  if (b.length === 0) return false
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) || a.endsWith(`/${b}`) || a.includes(`/${b}/`)
}

/** `--name-status` 출력에서 지금도 존재할 수 있는 경로만. 삭제(D)는 세지 않는다. */
function changedPaths(stdout: string): string[] {
  const paths: string[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    const status = parts[0]
    if (!status || status.startsWith('D')) continue
    // 이름이 바뀐 경우(R100 old new)는 새 이름이 지금의 경로다.
    const path = parts[parts.length - 1]
    if (path && path !== status) paths.push(path)
  }
  return paths
}
