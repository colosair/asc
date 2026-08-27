// Legacy Migration — 저장소 안에 있던 `.asc/` 를 사용자 소유 공간으로 옮긴다 (C-11 §6).
//
// **가장 나쁜 결과는 팀이 채택한 artefact를 개인 상태로 오판해 옮기는 것이다.** 그래서
// 옮기기 전에 무엇인지부터 판정하고, 모르면 옮기지 않는다:
//
//   personal legacy   개인이 만든 것        → 옮길 후보
//   project adopted   팀이 채택한 것        → 그대로 둔다
//   ambiguous         판단 불가            → 자동 이동 금지, 사람이 정한다
//
// 판정은 **추론이 아니라 증거**로 한다. Git이 추적하고 있으면 팀의 것이고, 추적 제외
// 목록에 개인용으로 등록돼 있으면 개인 것이다. 둘 다 아니면 모른다 — 그 상태를
// "아마 개인 것"으로 읽는 순간 남의 팀 설정이 사라진다.
//
// 옮기는 순서도 되돌릴 수 있게 잡는다: 복사 → 확인 → 등록 → (원본은 사람이 지운다).
// verify 전에 원본을 지우지 않는다 (C-11 불변식 ⑮).

import { cp, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type Adoption =
  | { kind: 'PROJECT_ADOPTED'; evidence: string }
  | { kind: 'PERSONAL_LEGACY'; evidence: string }
  | { kind: 'AMBIGUOUS'; evidence: string }

export type AdoptionInput = {
  projectRoot: string
  /** Git이 추적하는 경로들 중 `.asc` 아래인 것. 하나라도 있으면 팀의 것이다. */
  trackedAscPaths: readonly string[]
  /** `.git/info/exclude` 내용. `.asc/` 가 등록돼 있으면 개인용으로 숨긴 것이다. */
  excludeContent?: string
  /** `.gitignore` 내용. 팀 파일에 `.asc/` 가 있으면 팀이 알고 둔 것이다. */
  gitignoreContent?: string
}

/**
 * 이 `.asc/` 가 누구 것인가.
 *
 * 순서가 중요하다. **추적된 파일이 있으면 다른 어떤 신호보다 먼저 팀의 것이다** —
 * 커밋된 설정을 개인 상태로 옮기면 다른 사람의 저장소에서 파일이 사라진다.
 */
export function judgeAdoption(input: AdoptionInput): Adoption {
  if (input.trackedAscPaths.length > 0) {
    return {
      kind: 'PROJECT_ADOPTED',
      evidence: `Git이 추적하는 .asc 파일 ${input.trackedAscPaths.length}건 (${input.trackedAscPaths.slice(0, 3).join(', ')})`,
    }
  }
  if (/^\s*\.asc\/?\s*$/m.test(input.gitignoreContent ?? '')) {
    // 팀 파일에 적혀 있다 — 팀이 이 디렉터리를 알고 무시하기로 한 것이다.
    return { kind: 'PROJECT_ADOPTED', evidence: '.gitignore 에 .asc/ 가 선언돼 있다 (팀이 아는 상태)' }
  }
  if (/^\s*\.asc\/?\s*$/m.test(input.excludeContent ?? '')) {
    return { kind: 'PERSONAL_LEGACY', evidence: '.git/info/exclude 에만 등록된 개인 작업 공간' }
  }
  return {
    kind: 'AMBIGUOUS',
    evidence: 'Git 추적도 추적 제외 등록도 없다 — 개인 것인지 팀 것인지 판단할 근거가 없다',
  }
}

export type MigrationPlan = {
  from: string
  to: string
  adoption: Adoption
  /** 옮길 항목 수. 0이면 옮길 것이 없다. */
  entries: number
}

export type MigrationOutcome =
  | { ok: true; plan: MigrationPlan; verified: string[] }
  | { ok: false; reason: 'AMBIGUOUS_ADOPTION'; adoption: Adoption; detail: string }
  | { ok: false; reason: 'PROJECT_ADOPTED'; adoption: Adoption; detail: string }
  | { ok: false; reason: 'TARGET_EXISTS'; detail: string }
  | { ok: false; reason: 'VERIFY_FAILED'; detail: string; mismatched: string[] }

export type MigrateInput = {
  from: string
  to: string
  adoption: Adoption
  /** 판정을 무시하고 옮긴다. **ambiguous에서만 의미가 있다** — 사람이 확인했다는 뜻이다. */
  force?: boolean
}

/**
 * 복사하고, 복사된 것이 같은지 확인한다. **원본은 지우지 않는다.**
 *
 * 지우는 것은 사람이 확인한 뒤에 할 일이다. 여기서 지우면 verify가 실패했을 때 되돌릴
 * 것이 없다.
 */
export async function migrate(input: MigrateInput): Promise<MigrationOutcome> {
  if (input.adoption.kind === 'PROJECT_ADOPTED') {
    return {
      ok: false,
      reason: 'PROJECT_ADOPTED',
      adoption: input.adoption,
      detail: '팀이 채택한 상태다 — 개인 공간으로 옮기지 않는다',
    }
  }
  if (input.adoption.kind === 'AMBIGUOUS' && !input.force) {
    return {
      ok: false,
      reason: 'AMBIGUOUS_ADOPTION',
      adoption: input.adoption,
      detail: '개인 것인지 팀 것인지 모른다 — 확인한 뒤 --force 로 다시 부르라',
    }
  }
  if (await exists(input.to)) {
    return { ok: false, reason: 'TARGET_EXISTS', detail: `${input.to} 가 이미 있다 — 덮어쓰지 않는다` }
  }

  const before = await fileMap(input.from)
  await cp(input.from, input.to, { recursive: true })

  // 옮겨진 것이 같은지 본다. 복사만 하고 "됐다"고 말하면 그게 유실의 시작이다.
  const after = await fileMap(input.to)
  const mismatched = [...before.entries()]
    .filter(([rel, content]) => after.get(rel) !== content)
    .map(([rel]) => rel)
  if (mismatched.length > 0) {
    return {
      ok: false,
      reason: 'VERIFY_FAILED',
      detail: `${mismatched.length}건이 원본과 다르다 — 원본은 그대로 두었다`,
      mismatched: mismatched.slice(0, 10),
    }
  }

  return {
    ok: true,
    plan: { from: input.from, to: input.to, adoption: input.adoption, entries: before.size },
    verified: [...before.keys()].sort(),
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 상대 경로 → 내용. 대조는 목록이 아니라 내용으로 한다. */
async function fileMap(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(full, rel)
      else out.set(rel, await readFile(full, 'utf8'))
    }
  }
  await walk(root, '')
  return out
}

/** 사람이 읽는 줄. 무엇을 근거로 그렇게 봤는지가 함께 와야 사람이 뒤집을 수 있다. */
export function adoptionLine(adoption: Adoption): string {
  const label = {
    PROJECT_ADOPTED: '팀이 채택한 상태',
    PERSONAL_LEGACY: '개인 작업 공간',
    AMBIGUOUS: '판단 불가',
  }[adoption.kind]
  return `${label} — ${adoption.evidence}`
}
