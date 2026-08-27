#!/usr/bin/env node
// 배포 후보를 만든다 — 빌드하고, 각 패키지를 tarball로 싼다.
//
// `npm pack` 은 `files` allowlist를 실제로 적용한다. 빠진 것이 있으면 사용자의 첫 설치가
// 아니라 여기서 드러난다. 그래서 smoke보다 먼저 이것이 있다.

import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runNpm } from './npm-exec.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'private', 'packs')

export const PACKAGES = ['@asc-agent/runtime', '@asc-agent/bootstrap']

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

// npm은 shim이 아니라 진입 JS로 부른다 (scripts/npm-exec.mjs) — Windows의 `npm.cmd` 를
// shell로 우회하지 않기 위해서다.
const at = { cwd: root, stdio: 'inherit' }

runNpm(['run', 'build'], at)

for (const name of PACKAGES) {
  runNpm(['pack', '-w', name, '--pack-destination', out], at)
}

console.log(`\ntarball ${PACKAGES.length}개 — ${out}`)
