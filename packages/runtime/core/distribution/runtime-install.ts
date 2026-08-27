// 이 machine에 stable `asc` 가 있는가 (C-14 §3).
//
// **두 가지를 절대 혼동하지 않는다.**
//
// ```text
// bootstrap이 자기 의존성으로 들고 온 runtime      임시다. 프로세스가 끝나면 없다.
// 이 machine에 전역 설치된 runtime                 지속된다. 그것이 `asc` 다.
// ```
//
// npx 캐시나 node_modules 안에 runtime이 보인다고 "이미 설치됐다"고 하면, bootstrap이
// 끝난 뒤 사용자에게는 아무 명령도 남지 않는다. 그래서 판정은 **전역 설치 조회**로만 한다.
//
// 실행물 링크는 npm의 몫이다 (불변식 ⑰). 여기서 PATH도 shell도 고치지 않는다.

import { RELEASE_VERSION, RUNTIME_PACKAGE } from './release.ts'

/** 명령 하나를 돌리고 결과를 돌려준다. 테스트는 가짜를, pilot은 진짜 npm을 넣는다. */
export type ProcessRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ ok: boolean; stdout: string; stderr: string }>

export type StableInstallStatus =
  | 'NOT_INSTALLED'
  /** 기대한 exact version이 전역에 있고 실행물이 보인다. */
  | 'CURRENT'
  /** 설치는 돼 있는데 버전이 다르다. */
  | 'VERSION_MISMATCH'
  /** package는 있는데 실행물이 안 보이거나 조회가 깨졌다. */
  | 'BROKEN'

export type StableInstallState = {
  status: StableInstallStatus
  expectedVersion: string
  /** 전역에 실제로 있는 버전. 없으면 undefined. */
  installedVersion?: string
  /** `asc` 가 이 프로세스에서 보이는가. */
  executableVisible: boolean
  detail?: string
}

/**
 * 전역 설치 상태를 읽는다. **읽기만 한다** (C-14 §6 detect).
 *
 * `npm ls -g --json` 은 전역 트리만 본다 — bootstrap이 들고 온 자기 의존성은 여기 안 나온다.
 * 그것이 이 함수가 `npm ls` 를 쓰는 이유다.
 */
export async function detectStableInstall(
  run: ProcessRunner,
  expectedVersion: string = RELEASE_VERSION,
): Promise<StableInstallState> {
  const listed = await run('npm', ['ls', '-g', '--depth=0', '--json', RUNTIME_PACKAGE])
  const installedVersion = parseGlobalVersion(listed.stdout)

  // 실행물이 보이는가는 별개 사실이다. node manager에 따라 설치는 됐는데 이 프로세스의
  // PATH에는 없을 수 있고, 그때 "설치됨"이라고만 말하면 사람이 갇힌다 (C-14 §3.3).
  const which = await run(process.platform === 'win32' ? 'where' : 'which', ['asc'])
  const executableVisible = which.ok && which.stdout.trim().length > 0

  if (!installedVersion) {
    return { status: 'NOT_INSTALLED', expectedVersion, executableVisible }
  }
  if (installedVersion !== expectedVersion) {
    return {
      status: 'VERSION_MISMATCH',
      expectedVersion,
      installedVersion,
      executableVisible,
      detail: `global ${RUNTIME_PACKAGE} is ${installedVersion}, expected ${expectedVersion}`,
    }
  }
  if (!executableVisible) {
    return {
      status: 'BROKEN',
      expectedVersion,
      installedVersion,
      executableVisible,
      detail: '`asc` is not visible in this process — npm global prefix or PATH',
    }
  }
  return { status: 'CURRENT', expectedVersion, installedVersion, executableVisible }
}

/** `npm ls --json` 에서 이 패키지의 버전만 꺼낸다. 못 읽으면 없는 것으로 본다. */
function parseGlobalVersion(stdout: string): string | undefined {
  try {
    const tree = JSON.parse(stdout) as { dependencies?: Record<string, { version?: unknown }> }
    const version = tree.dependencies?.[RUNTIME_PACKAGE]?.version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

export type InstallOutcome = { ok: boolean; detail?: string }

/**
 * 전역에 exact version으로 설치한다. **exact 말고는 쓰지 않는다** (불변식 ⑧).
 *
 * 여기서 조건을 다시 따지지 않는다 — 무엇을 설치할지는 plan이 이미 정했다 (불변식 ⑩).
 */
export async function installStableRuntime(
  run: ProcessRunner,
  version: string = RELEASE_VERSION,
): Promise<InstallOutcome> {
  const spec = `${RUNTIME_PACKAGE}@${version}`
  const result = await run('npm', ['install', '-g', spec])
  return result.ok ? { ok: true } : { ok: false, detail: result.stderr.trim() || result.stdout.trim() }
}

/**
 * 설치했다고 끝이 아니다 — exit 0은 "npm이 화내지 않았다"까지다 (C-14 §3.3).
 *
 * 버전이 맞는지, 그리고 **실행물이 실제로 보이는지**까지 본다. 안 보이면 성공으로
 * 뭉개지 않고 새 터미널을 열라고 말한다.
 */
export async function verifyStableInstall(
  run: ProcessRunner,
  expectedVersion: string = RELEASE_VERSION,
): Promise<{ ok: boolean; state: StableInstallState; remedy?: string }> {
  const state = await detectStableInstall(run, expectedVersion)
  if (state.status === 'CURRENT') return { ok: true, state }
  if (state.status === 'BROKEN' && state.installedVersion === expectedVersion) {
    return {
      ok: false,
      state,
      remedy: 'Runtime package was installed, but `asc` is not visible in this process. Open a new terminal and run `asc setup status`.',
    }
  }
  return { ok: false, state, remedy: state.detail }
}
