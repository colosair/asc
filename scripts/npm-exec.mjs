#!/usr/bin/env node
// npm을 shim 없이 부른다.
//
// Windows에서 `npm` 은 `npm.cmd` 이고, Node는 보안 수정 이후 shell 없이 `.cmd` 를 실행하지
// 않는다(ENOENT). shell을 켜면 이번에는 인자가 escape 없이 이어붙는다(DEP0190). 둘 다
// 피하려면 shim이 아니라 **npm의 진입 JS**를 지금 도는 node로 직접 돌리면 된다 —
// 세 OS에서 같은 argv, 같은 실행 경로다.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * npm 진입 JS의 위치. npm script 안에서 돌면 npm이 자기 경로를 환경에 남긴다
 * (`npm_execpath`). 그 밖에서는 node 옆의 설치 구조를 본다.
 */
export function npmCliEntry() {
  const declared = process.env.npm_execpath
  if (declared && declared.endsWith('.js') && existsSync(declared)) return declared
  const base = dirname(process.execPath)
  for (const candidate of [
    join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows 설치 배치
    join(base, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX 설치 배치
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** npm 명령 하나를 돌린다. 진입 JS를 못 찾으면 그 사실을 그대로 말한다 — 조용히 shell로 넘어가지 않는다. */
export function runNpm(args, options = {}) {
  const entry = npmCliEntry()
  if (!entry) throw new Error('npm 진입 JS를 찾지 못했다 — npm 없이 이 단계는 성립하지 않는다')
  return execFileSync(process.execPath, [entry, ...args], options)
}
