#!/usr/bin/env node
// 배포 산출물을 만든다 — 컴파일하고, 코드가 아닌 실행 자산을 같이 옮긴다.
//
// `profiles/` 와 `presets/` 는 코드가 아니라 데이터다. tsc는 그것을 모르고, 빠지면 attach가
// Profile을 못 찾는다 (B-27에서 이미 한 번 겪은 계열의 결함).
//
// dist 안의 위치가 소스와 같은 이유: `installRoot()` 가 진입점 기준 `..` 로 설치 뿌리를
// 잡는다. `dist/cli/asc.js` 의 `..` 는 `dist/` 이므로, 자산이 `dist/` 안에 같은 이름으로
// 있으면 그 함수를 한 줄도 고치지 않아도 된다.

import { execFileSync } from 'node:child_process'
import { cp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PUBLIC_PROFILES } from './public-profiles.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

/** 코드가 아니지만 실행에 필요한 것. 빠지면 런타임에서야 안다. */
const ASSETS = ['profiles', 'presets']


await rm(dist, { recursive: true, force: true })

// `npx` 로 부르지 않는다. `npx` 는 shell·PATH·PATHEXT 위에 있는 shim이고, Windows에서는
// 그 shim(`npx.cmd`)이 `spawn` 의 기본 경로 해석에 걸리지 않아 ENOENT로 끝난다.
// 컴파일러는 이미 node_modules 안에 있으므로, 그 진입 파일을 찾아 지금 도는 node로 직접
// 돌린다 — 세 OS에서 같은 argv, 같은 실행 경로다.
const tsc = createRequire(import.meta.url).resolve('typescript/lib/tsc.js')
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' })

await mkdir(dist, { recursive: true })
const profilesDir = join(root, 'profiles')
for (const asset of ASSETS) {
  await cp(join(root, asset), join(dist, asset), {
    recursive: true,
    filter: (source) => {
      // `.gitkeep` 같은 저장소 전용 표식은 배포본에 들어갈 이유가 없다.
      if (source.endsWith('.gitkeep')) return false
      if (!source.startsWith(profilesDir)) return true
      const rest = source.slice(profilesDir.length).split(sep).filter(Boolean)
      // `profiles/` 자신은 통과시키고, 그 아래 첫 칸(= Profile id)만 판정한다.
      return rest.length === 0 || PUBLIC_PROFILES.includes(rest[0])
    },
  })
}

console.log(`dist 생성 — 컴파일 + 자산 ${ASSETS.join(', ')} (공개 Profile: ${PUBLIC_PROFILES.join(', ')})`)
