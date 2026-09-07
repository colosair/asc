// 등록물이 무엇을 가리켜야 하는가 (C-12 · C-14 §3).
//
// 실기계에서 이런 일이 났다: `npx @asc-agent/bootstrap … setup apply` 로 처음 설치한
// 사람에게, 등록물이 **npx 캐시 안의 실행물**을 정본으로 박았다.
//
//   ~/.npm/_npx/<hash>/node_modules/@asc-agent/runtime/dist/cli/asc.js
//
// npx 캐시는 지워지는 자리다. 그것을 지우면 등록물은 남고 실행물만 사라진다 — OS 는 계속
// 부르고 매번 실패한다. 등록은 **오래 남을 설치본**이 스스로 할 때만 뜻이 있다.
//
// 그래서 이 파일은 두 가지를 가른다:
//
//   지금 이 프로세스가 어디서 도는가      bootstrap 은 임시 자리에서 돌 수 있다
//   등록물이 무엇을 가리켜야 하는가        임시 자리는 절대 안 된다
//
// Node 도 같다. 등록물이 박는 Node 는 실제로 있고, 하한을 넘고, 임시 자리가 아니어야
// 한다 — 셋 중 하나라도 아니면 **등록하지 않는다.** 깨진 등록을 남기고 나중에 실패하는
// 것보다, 등록하지 않고 그 사실을 말하는 편이 낫다.

import { MINIMUM_NODE_MAJOR, majorOf, type NodeCandidate } from './node-runtime.ts'

/**
 * 사라질 수 있는 자리인가.
 *
 * npx 캐시가 이 목록의 이유다. 임시 디렉터리도 같은 성질이고, 어느 쪽이든 **등록물이
 * 가리키면 안 되는 자리**다. 목록은 짧게 유지한다 — 길어지면 그건 판정이 아니라 추측이다.
 */
export function isTransientPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return (
    normalized.includes('/_npx/') ||
    normalized.includes('/_cacache/') ||
    normalized.startsWith('/tmp/') ||
    normalized.startsWith('/private/tmp/') ||
    normalized.startsWith('/var/folders/') ||
    /\/Temp\//i.test(normalized)
  )
}

export type ServiceRuntimeInput = {
  /**
   * 지금 이 프로세스의 진입점 절대 경로.
   *
   * **없으면 넘기지 않는다.** 부재를 경로처럼 생긴 문자열로 표현하면 `isTransientPath` 가
   * 그것을 "사라지지 않는 자리"로 읽고 등록물에 박는다 — 실기계에서 그렇게 됐다.
   */
  runningEntry?: string
  /** 지금 이 프로세스의 Node 실행 파일. */
  runningNode: string
  /** 지금 이 프로세스의 Node 버전 (`v24.1.0` 형태). */
  runningNodeVersion: string
  /** 전역 설치본의 진입점. 있으면 이것이 먼저다 — 지워지지 않는 자리이기 때문이다. */
  stableEntry?: string
  /** 이 기계에서 찾은 Node 후보들. 지금 Node 가 못 쓸 때만 본다. */
  nodeCandidates?: readonly NodeCandidate[]
}

export type ServiceRuntimeResolution =
  | { kind: 'STABLE'; node: string; entry: string }
  | {
      kind: 'UNSTABLE'
      /** 무엇이 없어서 못 하는가. 사람이 읽고 무엇을 할지 알 수 있어야 한다. */
      reason: 'NO_STABLE_ENTRY' | 'NO_COMPATIBLE_NODE'
      detail: string
    }

/**
 * 등록물에 박을 Node 와 진입점을 정한다. **아무것도 실행하지 않는다** — 사실은 호출자가
 * 관측해 넘긴다.
 *
 * 진입점: 전역 설치본이 있으면 그것. 없으면 지금 진입점이되 **임시 자리가 아닐 때만.**
 * Node: 지금 Node 가 하한을 넘고 임시 자리가 아니면 그것. 아니면 후보 중 첫 번째.
 */
export function resolveServiceRuntime(input: ServiceRuntimeInput): ServiceRuntimeResolution {
  const entry =
    input.stableEntry && !isTransientPath(input.stableEntry)
      ? input.stableEntry
      : input.runningEntry && !isTransientPath(input.runningEntry)
        ? input.runningEntry
        : null
  if (!entry) {
    return {
      kind: 'UNSTABLE',
      reason: 'NO_STABLE_ENTRY',
      // 없는 것과 임시 자리인 것은 다른 사실이다 — 사람이 무엇을 할지가 갈린다
      detail: input.runningEntry
        ? `${input.runningEntry} is a temporary location — a registration pointing there breaks when it is cleared`
        : 'no installed ASC runtime to point at — install one first, then register',
    }
  }

  const usable = (path: string, version: string): boolean => {
    const major = majorOf(version)
    return major !== null && major >= MINIMUM_NODE_MAJOR && !isTransientPath(path)
  }

  const node = usable(input.runningNode, input.runningNodeVersion)
    ? input.runningNode
    : (input.nodeCandidates ?? []).find((candidate) => usable(candidate.path, candidate.version))?.path
  if (!node) {
    return {
      kind: 'UNSTABLE',
      reason: 'NO_COMPATIBLE_NODE',
      detail: `no Node ${MINIMUM_NODE_MAJOR} or newer at a stable path (this process runs ${input.runningNodeVersion} from ${input.runningNode})`,
    }
  }

  return { kind: 'STABLE', node, entry }
}

/** 사람이 읽는 한 줄. 왜 등록하지 않았는지가 여기 있어야 한다. */
export function serviceRuntimeLine(resolution: ServiceRuntimeResolution): string {
  return resolution.kind === 'STABLE'
    ? `service runtime: ${resolution.node} ${resolution.entry}`
    : `service runtime unavailable — ${resolution.detail}`
}
