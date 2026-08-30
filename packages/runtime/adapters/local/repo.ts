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

    // 신선도가 먼저다. 로컬 브랜치를 정본처럼 읽으면 원격이 전진한 사실을 모른 채
    // "구현 증거가 없다"가 나온다 — 그것이 이 어댑터가 실전에서 낸 사고였다.
    const canonical = await this.#freshCanonical(query)
    const canonicalRef = canonical.ref
    observation.freshness = canonical.freshness
    if (canonicalRef) {
      observation.canonicalRef = canonicalRef
      observation.mergedIntoCanonical = await this.#anyMerged(observation.refs, canonicalRef)
      if (observation.mergedIntoCanonical !== true && observation.refs.length > 0) {
        const equivalent = await this.#contentEquivalent(observation.refs, canonicalRef)
        if (equivalent !== undefined) observation.contentEquivalent = equivalent
      }
      if (query.refHint) {
        // 가지가 지워졌어도 이력은 남는다 — 커밋 메시지가 이 작업을 언급하는지 본다.
        const log = await this.#git(['log', '--format=%h %s', `--grep=${query.refHint}`, '-n', '5', canonicalRef])
        const mentions = (log ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
        observation.mentionedOnCanonical = mentions

        if (mentions.length > 0) {
          // 언급만으로는 부족하다. 무엇을 건드린 커밋인지, 그 결과가 지금도 남아 있는지
          // 본다 — 되돌린 커밋도 이 작업을 "언급"하기 때문이다.
          const survival = await this.#survivalOf(mentions, canonicalRef)
          observation.mentionedOnlyReverts = survival.onlyReverts
          if (survival.artifactsPresent !== undefined) {
            observation.mentionedArtifactsPresent = survival.artifactsPresent
          }
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
   * 조상은 아니지만 내용이 전부 정본에 있는가 (rebase·squash·cherry-pick 등가).
   * `git cherry` 는 patch-id 로 대조한다 — `-` 만 나오면 전부 반영, `+` 가 있으면 남은
   * 커밋이 있다. 빈 출력은 가지가 정본과 같다는 뜻이라 반영으로 친다.
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
  ): Promise<{ onlyReverts: boolean; artifactsPresent?: boolean }> {
    const commits = mentions.map((line) => {
      const at = line.indexOf(' ')
      return { hash: at > 0 ? line.slice(0, at) : line, subject: at > 0 ? line.slice(at + 1) : '' }
    })
    const onlyReverts = commits.every((commit) => /^revert\b/i.test(commit.subject.trim()))

    let readAny = false
    for (const commit of commits) {
      if (/^revert\b/i.test(commit.subject.trim())) continue
      const listed = await this.#git(['show', '--name-status', '--format=', commit.hash])
      if (listed === null) continue
      readAny = true
      for (const path of changedPaths(listed).slice(0, 20)) {
        if ((await this.#git(['cat-file', '-e', `${canonicalRef}:${path}`])) !== null) {
          return { onlyReverts, artifactsPresent: true }
        }
      }
    }
    return readAny ? { onlyReverts, artifactsPresent: false } : { onlyReverts }
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
