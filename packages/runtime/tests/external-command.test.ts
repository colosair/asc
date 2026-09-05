// ASC-7 — Windows에서 npm `.cmd` shim CLI를 실제로 찾는다 (실 프로젝트 실측).
//
// claude.cmd·jam.cmd가 PATH에 실재하는데 bare 이름 execFile이 실패해
// "Claude Code: not found" → external_write_guard STOP까지 이어진 사고의 회귀 고정.
// 파일시스템은 전부 주입한다 — 이 테스트는 어느 OS에서 돌아도 같은 답을 내야 한다.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveExternalCommand, shimTarget } from '../core/distribution/external-command.ts'

const NPM_DIR = 'C:\\Users\\u\\AppData\\Roaming\\npm'
const win = (files: Record<string, string>) => ({
  platform: 'win32' as NodeJS.Platform,
  env: { PATH: `C:\\Windows\\system32;${NPM_DIR}` },
  exists: (path: string) => path in files,
  readText: (path: string) => files[path] ?? null,
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
})

const NPM_SHIM = [
  '@ECHO off',
  'SETLOCAL',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  '"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\r\n')

describe('resolveExternalCommand — Windows npm shim (ASC-7)', () => {
  it('POSIX는 그대로 통과한다', () => {
    const resolved = resolveExternalCommand('claude', ['--version'], { platform: 'linux' })
    assert.deepEqual(resolved, { command: 'claude', args: ['--version'] })
  })

  it('PATH의 .exe를 찾으면 직접 부른다 — shell이 필요 없다', () => {
    const exe = `${NPM_DIR}\\glab.exe`
    const resolved = resolveExternalCommand('glab', ['--version'], win({ [exe]: '' }))
    assert.deepEqual(resolved, { command: exe, args: ['--version'] })
  })

  it('npm .cmd shim이면 그 안의 JS 진입점을 지금 node로 부른다', () => {
    const shim = `${NPM_DIR}\\claude.cmd`
    const js = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`
    const resolved = resolveExternalCommand('claude', ['--version'], win({ [shim]: NPM_SHIM, [js]: '' }))
    assert.equal(resolved.command, 'C:\\Program Files\\nodejs\\node.exe')
    assert.deepEqual(resolved.args, [js, '--version'])
  })

  it('shim을 못 읽으면 cmd.exe로 그 .cmd를 부른다 — shell 옵션 없이', () => {
    const shim = `${NPM_DIR}\\claude.cmd`
    const resolved = resolveExternalCommand('claude', ['agents', '--json'], win({ [shim]: 'REM opaque' }))
    assert.equal(resolved.command, 'cmd.exe')
    assert.deepEqual(resolved.args, ['/d', '/c', shim, 'agents', '--json'])
  })

  it('경로·확장자를 이미 갖춘 명령은 손대지 않는다', () => {
    for (const command of ['C:\\tools\\x.exe', 'dir\\x', 'x.cmd']) {
      const resolved = resolveExternalCommand(command, [], win({}))
      assert.equal(resolved.command, command)
    }
  })

  it('아무것도 못 찾으면 이름 그대로 — 진짜 실행 파일이 PATH에 있는 환경이다', () => {
    const resolved = resolveExternalCommand('git', ['status'], win({}))
    assert.deepEqual(resolved, { command: 'git', args: ['status'] })
  })
})

describe('shimTarget — npm shim 두 세대', () => {
  it('_prog 세대', () => {
    assert.equal(
      shimTarget(NPM_SHIM),
      'node_modules\\@anthropic-ai\\claude-code\\cli.js',
    )
  })

  it('node.exe 직접 세대', () => {
    assert.equal(
      shimTarget('"%dp0%\\node.exe"  "%dp0%\\node_modules\\@jam-mcp\\launcher\\dist\\cli.js" %*'),
      'node_modules\\@jam-mcp\\launcher\\dist\\cli.js',
    )
  })

  it('모르는 형태는 null — 아는 척하지 않는다', () => {
    assert.equal(shimTarget('powershell -File thing.ps1 %*'), null)
  })
})
