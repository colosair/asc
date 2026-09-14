// Release 상수 — 이 build가 어느 release에 속하는가 (C-14 §8).
//
// **exact pin on purpose.** `@latest` 도, major alias도 쓰지 않는다 — 테스트하지 않은
// runtime을 installer가 몰래 부르면 안 된다 (불변식 ⑧).
//
// 여기 값과 package.json 이 어긋나면 `npm run release:check` 가 잡는다. 소비자 환경에서
// package.json 을 런타임에 읽어 오는 방식은 쓰지 않는다 — 그 편의는 설치 형태마다 다르게
// 깨지고, drift는 어차피 사람이 release 직전에 한 번 확인하면 되는 문제다.

export const RUNTIME_PACKAGE = '@asc-agent/runtime'
export const BOOTSTRAP_PACKAGE = '@asc-agent/bootstrap'

/** runtime과 bootstrap은 초기 release에서 lockstep이다. */
export const RELEASE_VERSION = '0.10.2'

export const RUNTIME_SPEC = `${RUNTIME_PACKAGE}@${RELEASE_VERSION}`
export const BOOTSTRAP_SPEC = `${BOOTSTRAP_PACKAGE}@${RELEASE_VERSION}`

/**
 * 아직 설치되지 않은 machine에서 그대로 실행되는 형태 (C-14 §3.4).
 *
 * 사람이 읽는 `asc …` 는 설치 뒤에만 성립한다. agent에게 실행하라고 주는 것은
 * 지금 상태에서 도는 것이어야 한다 (불변식 ⑯).
 */
export function portableCommand(args: readonly string[]): string {
  return `npx --yes ${BOOTSTRAP_SPEC} ${shellWords(args)}`
}

/** 설치된 뒤 사람이 치는 형태. runtime이 CURRENT면 이것이 곧 portable이다. */
export function shorthandCommand(args: readonly string[]): string {
  return `asc ${shellWords(args)}`
}

/**
 * argv 를 사람이 그대로 붙여 넣을 수 있는 한 줄로 (0.10.0 P1).
 *
 * 공백·`>`·`[`·따옴표가 든 인자는 작은따옴표로 감싼다. 0.9.1 까지는 `join(' ')` 이어서
 * 건네진 발급 명령의 goal 이 여러 단어로 갈라지고 `>` 가 리다이렉트가 됐다 (dogfood 2026-09-13 F2).
 * POSIX sh 기준이다 — 안전한 단어(`[A-Za-z0-9_./:=@%+,-]`)는 그대로 둔다.
 */
export function shellWords(args: readonly string[]): string {
  return args.map(shellWord).join(' ')
}

export function shellWord(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_./:=@%+,<>-]*$/.test(arg) && !/[<>]/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}
