// 테스트 소유 임시 디렉터리 — 생성과 회수를 한 곳에서 묶는다.
//
// 각 테스트 파일이 mkdtemp만 하고 떠난 디렉터리가 %TEMP%에 수천 개 쌓였다
// (실측: asc-profile-source-* 18개/suite). 여기서 만든 디렉터리는 프로세스
// 종료 시 일괄 삭제된다 — node --test는 파일마다 자식 프로세스를 띄우므로
// assertion 실패나 throw로 테스트가 죽어도 정상 exit 경로에서 회수되고,
// 병렬 실행끼리는 각자 자기 목록만 지운다. 만들지 않은 경로는 건드리지 않는다.

import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const owned: string[] = []
let hooked = false

/** mkdtemp + 소유 등록. 반환 경로는 프로세스 종료 시 삭제된다. */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  track(dir)
  return dir
}

/** 다른 경로로 만든 디렉터리를 회수 대상으로 등록한다. */
export function track(dir: string): void {
  owned.push(dir)
  if (!hooked) {
    hooked = true
    process.on('exit', cleanupNow)
  }
}

/**
 * 등록된 것을 지금 지운다. exit 훅이 부르지만 테스트가 직접 불러 lifecycle을
 * 검증할 수도 있다. Windows의 EBUSY/EPERM은 재시도하지 않고 한 줄로 남긴다 —
 * 오류를 숨기면 다음 누수가 조용해진다.
 */
export function cleanupNow(): void {
  while (owned.length > 0) {
    const dir = owned.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      process.stderr.write(`temp cleanup left ${dir}: ${String((error as Error).message)}\n`)
    }
  }
}
