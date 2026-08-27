#!/usr/bin/env node
// 배포본만으로 서는지 본다 — **저장소 소스를 지운 자리에서**.
//
// 저장소 트리에서 도는 테스트는 이 결함을 못 잡는다. dist가 `../core/foo.ts` 를 부르고
// 있어도 그 파일이 옆에 있으니 성공한다. 그래서 dist를 딴 곳에 복사하고, 그 자리에는
// 소스가 아예 없게 만든 뒤 실행한다.

import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const base = await mkdtemp(join(tmpdir(), 'asc-dist-smoke-'))

try {
  const app = join(base, 'app')
  await mkdir(app, { recursive: true })
  await cp(join(root, 'dist'), join(app, 'dist'), { recursive: true })
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify({ name: 'asc-dist-smoke', private: true, type: 'module', dependencies: { zod: '^3.25.76' } }, null, 2),
    'utf8',
  )
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], {
    cwd: app,
    stdio: 'pipe',
    env: { ...process.env, npm_config_cache: join(base, '.npm') },
  })

  const entry = join(app, 'dist', 'cli', 'asc.js')
  const home = join(base, 'home')
  const work = join(base, 'work')
  await mkdir(home, { recursive: true })
  await mkdir(work, { recursive: true })

  const run = (args) =>
    execFileSync(process.execPath, [entry, ...args], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, ASC_HOME: join(home, '.asc'), NO_COLOR: '1' },
    })

  const help = run(['--help'])
  if (!help.includes('asc proceed')) throw new Error('--help 가 명령 목록을 내지 않았다')

  // Profile 후보가 보이면 dist 안의 자산까지 닿았다는 뜻이다
  const detect = run(['init'])
  if (!detect.includes('pilot-local')) throw new Error('dist 안의 profiles 를 읽지 못했다')

  console.log('dist smoke OK — 소스 없는 자리에서 --help · init 감지 통과')
} finally {
  await rm(base, { recursive: true, force: true })
}
