// B-35 Gate — 실제 작업 항목 도구를 Work Binding으로 물려도 Investigation Core가 그대로인가.
//
// 여기 있는 것은 mock transport 기반이다. 실 도구·실 Jira 실측은 pilot 문서에 따로 있다
// (docs/pilots/B-35_jam_adapter.md) — 자동 테스트가 남의 서버 사정으로 깨지면 아무도 안 본다.
//
// 가장 중요한 검사 둘:
//   ① provider가 "다 못 봤다"고 말하면 그대로 옮긴다 — 잘린 목록을 전체로 읽지 않는다
//   ② 자격 값이 ASC 어디에도 나타나지 않는다

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'

import { JamAdapter, parseProjectKey, resolveJamCommand } from '../adapters/jam/adapter.ts'
import { JamEventSource } from '../adapters/jam/event-source.ts'
import { JamMcpClient } from '../adapters/jam/mcp-client.ts'
import { JamInventory, JamResourceContext } from '../adapters/jam/ports.ts'
import { investigate } from '../core/monitor/investigation.ts'

// ── mock stdio 프로세스 ───────────────────────────────────────────────────────

type Handler = (method: string, params: unknown) => unknown

/** 실제 자식 프로세스 대신 붙는 가짜. 프로토콜 왕복만 흉내 낸다. */
function mockProcess(handler: Handler, options: { stderr?: string; raw?: string[] } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    exitCode: number | null
    kill: () => void
  }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.kill = () => {}

  let buffer = ''
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line) as { id?: number; method: string; params?: unknown }
      if (message.id === undefined) continue // 알림
      if (options.raw) {
        for (const out of options.raw) child.stdout.write(`${out}\n`)
        continue
      }
      const result = handler(message.method, message.params)
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
    }
  })

  if (options.stderr) setTimeout(() => child.stderr.write(options.stderr!), 0)
  return child as never
}

const HANDSHAKE = {
  protocolVersion: '2024-11-05',
  capabilities: {},
  serverInfo: { name: 'work-tool', version: '1.0.0' },
}

/** tool 응답 하나. 실제 도구가 그러듯 text content 한 덩어리에 담는다. */
const toolText = (payload: unknown, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  ...(isError ? { isError: true } : {}),
})

function clientOn(handler: Handler, options: Parameters<typeof mockProcess>[1] = {}) {
  return new JamMcpClient({
    command: 'unused',
    timeoutMs: 500,
    spawnProcess: () => mockProcess(handler, options),
  })
}

const ISSUE = {
  key: 'WORK-12',
  summary: '로그인 콜백 정리',
  status: '진행 중',
  updated: '2026-08-26T09:00:00.000+0900',
  assignee: '담당자',
  labels: ['frontend'],
  components: ['Web'],
}

// ── MCP client ───────────────────────────────────────────────────────────────

describe('B-35 Gate — stdio MCP client (§3)', () => {
  it('악수하고 tool을 부른다', async () => {
    const client = clientOn((method) =>
      method === 'initialize' ? HANDSHAKE : toolText({ issues: [ISSUE], meta: { complete: true } }),
    )
    const started = await client.start()
    assert.equal(started.ok, true)

    const result = await client.callTool<{ issues: unknown[] }>('jira_search', { jql: 'x' })
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.value.issues.length, 1)
    await client.stop()
  })

  it('요청이 여럿이어도 각자 자기 답을 받는다', async () => {
    const client = clientOn((method, params) =>
      method === 'initialize'
        ? HANDSHAKE
        : toolText({ issues: [{ ...ISSUE, key: (params as { arguments: { issueKeys: string[] } }).arguments.issueKeys[0] }] }),
    )
    await client.start()
    const [a, b] = await Promise.all([
      client.callTool<{ issues: { key: string }[] }>('jira_context', { issueKeys: ['A-1'] }),
      client.callTool<{ issues: { key: string }[] }>('jira_context', { issueKeys: ['B-2'] }),
    ])
    assert.equal(a.ok && a.value.issues[0]?.key, 'A-1')
    assert.equal(b.ok && b.value.issues[0]?.key, 'B-2')
    await client.stop()
  })

  it('답이 없으면 매달리지 않고 시간으로 끊는다', async () => {
    const client = clientOn((method) => (method === 'initialize' ? HANDSHAKE : undefined))
    // handler가 undefined를 돌려주면 result:undefined로 즉시 답하므로, 아예 안 답하는 통로를 만든다
    const silent = new JamMcpClient({
      command: 'unused',
      timeoutMs: 120,
      spawnProcess: () => mockProcess(() => HANDSHAKE, { raw: [] }),
    })
    const started = await silent.start()
    assert.equal(started.ok, false)
    assert.equal(started.ok === false && started.kind, 'TIMEOUT')
    await client.stop()
    await silent.stop()
  })

  it('프로토콜 버전이 다르면 조용히 계속하지 않는다', async () => {
    const client = clientOn(() => ({ ...HANDSHAKE, protocolVersion: '1999-01-01' }))
    const started = await client.start()
    assert.equal(started.ok, false)
    assert.equal(started.ok === false && started.kind, 'PROTOCOL_ERROR')
    assert.match(started.ok === false ? started.detail : '', /버전이 다르다/)
  })

  it('프로토콜이 아닌 줄이 오면 이유를 주고 끊는다', async () => {
    const client = new JamMcpClient({
      command: 'unused',
      timeoutMs: 300,
      spawnProcess: () => mockProcess(() => HANDSHAKE, { raw: ['이건 JSON이 아니다'] }),
    })
    const started = await client.start()
    assert.equal(started.ok, false)
    assert.equal(started.ok === false && started.kind, 'PROTOCOL_ERROR')
  })

  it('자식이 먼저 죽으면 기다리던 요청을 깨운다', async () => {
    // 답하지 않는 통로여야 "먼저 죽는" 상황이 성립한다
    const child = mockProcess(() => HANDSHAKE, { raw: [] }) as unknown as EventEmitter & {
      exitCode: number | null
    }
    const client = new JamMcpClient({
      command: 'unused',
      timeoutMs: 2000,
      spawnProcess: () => child as never,
    })
    const pending = client.start()
    setTimeout(() => child.emit('exit', 1, null), 20)
    const started = await pending
    assert.equal(started.ok, false)
    assert.equal(started.ok === false && started.kind, 'PROCESS_EXITED')
  })

  it('도구가 알린 실패와 우리가 못 읽은 것을 구분한다', async () => {
    const client = clientOn((method) =>
      method === 'initialize' ? HANDSHAKE : toolText({ error: { code: 'JQL_INVALID', message: '잘못된 질의' } }, true),
    )
    await client.start()
    const result = await client.callTool('jira_search', { jql: 'x' })
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.kind, 'TOOL_ERROR')
    assert.match(result.ok === false ? result.detail : '', /JQL_INVALID/)
    await client.stop()
  })

  it('stderr를 프로토콜로 읽지 않는다 — 진단으로만 쓴다', async () => {
    const client = new JamMcpClient({
      command: 'unused',
      timeoutMs: 150,
      spawnProcess: () => mockProcess(() => HANDSHAKE, { stderr: '[tool] 로그 한 줄\n', raw: [] }),
    })
    const started = await client.start()
    // stderr가 왔다고 악수가 성사되지 않는다
    assert.equal(started.ok, false)
    assert.match(started.ok === false ? started.detail : '', /로그 한 줄/)
    await client.stop()
  })
})

// ── Adapter 계약 ─────────────────────────────────────────────────────────────

describe('B-35 Gate — Adapter 계약 (§4)', () => {
  const context = { projectRoot: '/nowhere', env: {} }

  it('실제로 되는 것만 선언한다 — 이력은 없다', () => {
    const provides = new JamAdapter().describe().provides
    assert.deepEqual(
      [...provides].sort(),
      ['context.resource', 'context.thread', 'inventory.enumerate', 'observe.delta'],
    )
    // provider가 변경 이력을 주지 않는다 — 요청 경로 자체가 없다
    assert.ok(!provides.includes('context.history'))
  })

  it('observe.delta 는 열되 푸시라고 말하지 않는다 (B-53)', async () => {
    // C-07 §1.1이 Delta에 updated-since를 명시적으로 포함한다. JAM이 여는 것은 그것이고,
    // webhook이 아니다 — 이 구분이 코드에 남아 있어야 "실시간"이라는 오해가 생기지 않는다.
    const source = await readFile('adapters/jam/event-source.ts', 'utf8')
    assert.match(source, /푸시가 있다고 말하지 않는다/)
    assert.doesNotMatch(source, /webhook 수신|push 수신/)

    const adapter = await readFile('adapters/jam/adapter.ts', 'utf8')
    assert.match(adapter, /푸시가 있다는 뜻이 아니다/)
  })

  it('선언 파일이 있을 때만 후보를 만든다 — 이름으로 추측하지 않는다', async () => {
    const declared = new JamAdapter({ readDeclaration: async () => 'project:\n  key: WORK\n' })
    const found = await declared.discover(context)
    assert.equal(found.length, 1)
    assert.equal(found[0]?.resource, 'WORK')

    const bare = new JamAdapter({ readDeclaration: async () => null })
    assert.deepEqual(await bare.discover(context), [])

    // 파일은 있는데 키가 없으면 후보가 아니다
    const empty = new JamAdapter({ readDeclaration: async () => 'version: 1\n' })
    assert.deepEqual(await empty.discover(context), [])
  })

  it('자격 없음과 실행 불가를 나눈다', async () => {
    const missing = new JamAdapter({
      authStatus: async () => ({ status: 'not_configured', code: 'JAM_AUTH_REQUIRED' }),
    })
    const status = await missing.runtime(context)
    assert.equal(status.state, 'UNCONFIGURED')
    // 사람이 할 일을 말한다 — 대신 하지 않는다
    assert.match(status.detail ?? '', /사람이 직접/)

    const broken = new JamAdapter({ authStatus: async () => ({ error: 'command not found' }) })
    assert.equal((await broken.runtime(context)).state, 'UNAVAILABLE')

    const ready = new JamAdapter({ authStatus: async () => ({ status: 'configured', baseUrl: 'https://example' }) })
    assert.equal((await ready.runtime(context)).state, 'AVAILABLE')
  })

  it('자격을 대신 다루지 않는다 — 값이 어디에도 나타나지 않는다', async () => {
    const source = await readFile(new URL('../adapters/jam/adapter.ts', import.meta.url), 'utf8')
    // 토큰을 받는 입력도, 넘기는 경로도 없다
    assert.doesNotMatch(source, /token|apiToken|password|secret/i)
    assert.match(new JamAdapter().describe().requiresCredential?.join(' ') ?? '', /대신 로그인하지 않는다/)
  })

  it('실행 경로는 환경에서만 온다', () => {
    assert.deepEqual(resolveJamCommand({ ASC_JAM_PATH: '/x/server.js' }).args, ['/x/server.js'])
    assert.equal(resolveJamCommand({ ASC_JAM_PATH: '/usr/local/bin/tool' }).command, '/usr/local/bin/tool')
    assert.equal(resolveJamCommand({}, 'fallback').command, 'fallback')
  })

  it('선언 파일에서 키만 꺼낸다', () => {
    assert.equal(parseProjectKey('project:\n  key: ABC123\n'), 'ABC123')
    assert.equal(parseProjectKey('project:\n  key: "Q_1"\n'), 'Q_1')
    assert.equal(parseProjectKey('version: 1\n'), null)
  })
})

// ── Inventory · ResourceContext ──────────────────────────────────────────────

describe('B-35 Gate — Inventory 완결성·겹쳐 읽기 (§5·§6)', () => {
  function inventoryOn(
    payload: unknown,
    capture?: { jql?: string; scope?: string },
    timezone?: string,
  ) {
    const client = clientOn((method, params) => {
      if (method === 'initialize') return HANDSHAKE
      const args = (params as { arguments: { jql: string; scope: string } }).arguments
      if (capture) {
        capture.jql = args.jql
        capture.scope = args.scope
      }
      return toolText(payload)
    })
    return new JamInventory({ client, projectKey: 'WORK', ...(timezone ? { timezone } : {}) })
  }

  it('회수 경로는 언제나 전수로 부른다 — 규모로 짐작하지 않는다', async () => {
    const seen: { scope?: string } = {}
    await inventoryOn({ issues: [], meta: { complete: true } }, seen).enumerate({})
    assert.equal(seen.scope, 'complete')
  })

  it('기준선을 조금 뒤로 물려 겹쳐 읽는다', async () => {
    const seen: { jql?: string } = {}
    // Jira 계정 timezone을 선언한 경우. 같은 순간이 그 timezone의 벽시계로 서식된다.
    await inventoryOn({ issues: [], meta: { complete: true } }, seen, 'Asia/Seoul').enumerate({
      updatedSince: '2026-08-26T09:05:30.000+0900',
    })
    assert.match(seen.jql ?? '', /project = WORK/)
    assert.match(seen.jql ?? '', /updated >= "2026\/08\/26 09:04"/) // 1분 겹침
    assert.match(seen.jql ?? '', /ORDER BY updated ASC/)
  })

  it('선언하지 않으면 UTC로 읽는다 — 기계의 timezone을 빌리지 않는다', async () => {
    const seen: { jql?: string } = {}
    await inventoryOn({ issues: [], meta: { complete: true } }, seen).enumerate({
      updatedSince: '2026-08-26T09:05:30.000+0900',
    })
    assert.match(seen.jql ?? '', /updated >= "2026\/08\/26 00:04"/)
  })

  it('같은 순간은 host timezone이 달라도 같은 JQL이 된다 (3-OS CI 결함)', async () => {
    const instant = '2026-08-26T09:05:30.000+0900'
    const jqlUnder = async (hostTz: string) => {
      const before = process.env.TZ
      process.env.TZ = hostTz
      try {
        const seen: { jql?: string } = {}
        await inventoryOn({ issues: [], meta: { complete: true } }, seen, 'Asia/Seoul').enumerate({
          updatedSince: instant,
        })
        return seen.jql ?? ''
      } finally {
        if (before === undefined) delete process.env.TZ
        else process.env.TZ = before
      }
    }
    // KST 기계와 UTC 기계, 그리고 서쪽 기계. 셋이 같은 문장을 만들어야 한다.
    const [kst, utc, la] = await Promise.all([
      jqlUnder('Asia/Seoul'),
      jqlUnder('UTC'),
      jqlUnder('America/Los_Angeles'),
    ])
    assert.equal(kst, utc)
    assert.equal(utc, la)
    assert.match(kst, /updated >= "2026\/08\/26 09:04"/)
  })

  it('provider가 완결을 부인하면 그대로 옮긴다 — 잘린 목록을 전체로 읽지 않는다', async () => {
    const page = await inventoryOn({
      issues: [ISSUE],
      meta: { complete: false, reason: 'OUTPUT_BUDGET', overflow: ['pages'] },
    }).enumerate({})
    assert.equal(page.items.length, 1)
    assert.equal(page.complete, false) // Core가 이 값으로 상실 판정·기준선 이동을 보류한다
  })

  it('조회에 실패하면 "없다"가 아니라 "모른다"로 돌려준다', async () => {
    const client = clientOn((method) =>
      method === 'initialize' ? HANDSHAKE : toolText({ error: { code: 'JIRA_UNAVAILABLE' } }, true),
    )
    const page = await new JamInventory({ client, projectKey: 'WORK' }).enumerate({})
    assert.deepEqual(page.items, [])
    assert.equal(page.complete, false)
  })

  it('이어받을 지점이 없다는 사실을 그대로 다룬다', async () => {
    const page = await inventoryOn({ issues: [ISSUE], meta: { complete: true } }).enumerate({}, '2')
    assert.deepEqual(page.items, [])
  })

  it('유일한 변화 신호를 marker로 쓴다', async () => {
    const page = await inventoryOn({ issues: [ISSUE], meta: { complete: true } }).enumerate({})
    assert.equal(page.items[0]?.revisionMarker, ISSUE.updated)
    assert.equal(page.items[0]?.reference, 'WORK-12')
    assert.deepEqual(page.items[0]?.labels, ['frontend', 'Web'])
  })
})

describe('B-35 Gate — Resource Context (§8)', () => {
  const contextOn = (payload: unknown) => {
    const client = clientOn((method) => (method === 'initialize' ? HANDSHAKE : toolText(payload)))
    return new JamResourceContext({ client, projectKey: 'WORK' })
  }

  it('연결 항목을 모아 주되, 막는 것을 앞에 싣는다', async () => {
    const snapshot = await contextOn({
      issues: [
        {
          ...ISSUE,
          parent: { key: 'WORK-1' },
          links: [{ issue: { key: 'WORK-9' } }, { blocksThisIssue: true, issue: { key: 'WORK-4' } }],
          subtasks: [{ key: 'WORK-13' }],
        },
      ],
      meta: { complete: true },
    }).getResource('WORK-12')
    assert.equal(snapshot.title, ISSUE.summary)
    // 상한에 걸려 잘릴 때 blocker 가 부모·하위 작업 뒤로 밀리면 막힌 작업이 착수 가능으로 보인다.
    assert.deepEqual(snapshot.related, ['WORK-4', 'WORK-9', 'WORK-1', 'WORK-13'])
  })

  it('안 돌아온 키는 원인을 지어내지 않는다', async () => {
    const snapshot = await contextOn({ issues: [], meta: { missingKeys: ['WORK-99'] } }).getResource('WORK-99')
    assert.equal(snapshot.missing, true)
    // "삭제됨"도 "권한 없음"도 적지 않는다 — provider가 둘을 구분해 주지 않는다
    assert.equal(snapshot.state, 'unknown')
  })

  it('논의가 잘렸으면 그 사실을 사람이 보게 한다', async () => {
    const comments = await contextOn({
      issues: [{ ...ISSUE, comments: [{ id: '1', created: ISSUE.updated, body: '확인 부탁' }] }],
      meta: { commentsComplete: false },
    }).getComments('WORK-12')

    assert.equal(comments.length, 2)
    assert.match(comments.at(-1)?.body ?? '', /일부만 받았다/)
  })

  it('다 받았으면 군더더기를 붙이지 않는다', async () => {
    const comments = await contextOn({
      issues: [{ ...ISSUE, comments: [{ id: '1', created: ISSUE.updated, body: '확인 부탁', author: '동료' }] }],
      meta: { commentsComplete: true },
    }).getComments('WORK-12')
    assert.equal(comments.length, 1)
    assert.equal(comments[0]?.author, '동료')
  })
})

// ── Swap: fixture → 실제 도구 ────────────────────────────────────────────────

describe('B-35 Gate — Work Binding 교체 (§10)', () => {
  it('fixture 자리에 실제 도구 adapter를 물려도 조사가 같은 모양으로 돈다', async () => {
    const client = clientOn((method, params) => {
      if (method === 'initialize') return HANDSHAKE
      const name = (params as { name: string }).name
      return toolText({
        issues: [{ ...ISSUE, parent: { key: 'WORK-1' }, ...(name === 'jira_full' ? { comments: [] } : {}) }],
        meta: { complete: true, commentsComplete: true },
      })
    })
    const work = new JamResourceContext({ client, projectKey: 'WORK' })

    const result = await investigate({ reference: 'code/repo#1', workReference: 'WORK-12' }, { work })
    const step = result.steps.find((s) => s.id === 'work-context')!
    assert.equal(step.kind, 'DONE')
    const findings = step.kind === 'DONE' ? step.findings.join('\n') : ''
    assert.match(findings, /로그인 콜백 정리 — 진행 중/)
    assert.match(findings, /연결: WORK-1/)

    // 이력 통로가 없다 — 그래도 이 단계는 무너지지 않는다 (C-07 §6.1 ⑦)
    assert.ok(!result.undecidable.some((line) => line.startsWith('work-context:')))
    await client.stop()
  })

  it('Core는 이 도구를 모른다', async () => {
    // core/** 전반의 어휘 검사는 tests/binding.test.ts가 한다. 여기서는 이 라운드에서
    // 손댄 Core 파일만 다시 확인한다.
    for (const file of ['../core/attach/bootstrap.ts', '../core/binding/types.ts']) {
      const source = await readFile(new URL(file, import.meta.url), 'utf8')
      assert.doesNotMatch(source.toLowerCase(), /jam|jira/)
    }
  })
})

// B-53 Gate — 증분 회수는 하되 푸시라고 말하지 않는다 (C-07 §1.1).
describe('B-53 Gate — JAM Incremental Observation', () => {
  const item = (key: string, updated: string) => ({
    reference: key,
    state: '진행 중',
    updatedAt: updated,
    revisionMarker: updated,
    title: `${key} 작업`,
    assignees: ['minyong'],
    labels: ['front'],
  })

  /** enumerate 호출을 기록하는 fixture. 무엇을 물었는지가 이 Gate의 핵심이다. */
  class RecordingInventory {
    readonly id = 'jam'
    calls: { updatedSince?: string }[] = []
    #pages: { items: ReturnType<typeof item>[]; complete: boolean }[]
    #at = 0

    constructor(pages: { items: ReturnType<typeof item>[]; complete: boolean }[]) {
      this.#pages = pages
    }

    async enumerate(query: { updatedSince?: string }) {
      this.calls.push(query)
      const page = this.#pages[Math.min(this.#at, this.#pages.length - 1)] ?? { items: [], complete: true }
      this.#at += 1
      return page
    }
  }

  it('cursor 이후만 묻되 분 단위 정밀도만큼 겹쳐 읽는다', async () => {
    const inventory = new RecordingInventory([{ items: [item('WORK-1', '2026-08-26T11:05:00.000Z')], complete: true }])
    const source = new JamEventSource({ inventory })

    await source.drain('2026-08-26T11:00:00.000Z')
    // 겹치지 않으면 같은 분 안의 변경이 영영 안 보인다 — 누락이 중복보다 위험하다
    assert.equal(inventory.calls[0]!.updatedSince, '2026-08-26T10:59:00.000Z')
  })

  it('처음에는 아무것도 묻지 않고 전부 본다', async () => {
    const inventory = new RecordingInventory([{ items: [], complete: true }])
    await new JamEventSource({ inventory }).drain(null)
    assert.equal(inventory.calls[0]!.updatedSince, undefined)
  })

  it('같은 항목이 같은 시각으로 다시 와도 같은 사건이다', async () => {
    const inventory = new RecordingInventory([
      { items: [item('WORK-1', '2026-08-26T11:05:00.000Z')], complete: true },
      { items: [item('WORK-1', '2026-08-26T11:05:00.000Z')], complete: true },
    ])
    const source = new JamEventSource({ inventory })

    const first = await source.drain(null)
    const second = await source.drain(first.cursor)
    assert.equal(first.events[0]!.eventKey, second.events[0]!.eventKey, 'dedupe가 접을 수 있는 키다')
  })

  it('목록을 끝까지 못 봤으면 시계를 옮기지 않는다', async () => {
    const inventory = new RecordingInventory([
      { items: [item('WORK-1', '2026-08-26T11:05:00.000Z')], complete: false },
    ])
    const source = new JamEventSource({ inventory })

    const batch = await source.drain('2026-08-26T11:00:00.000Z')
    assert.equal(batch.cursor, '2026-08-26T11:00:00.000Z', '못 본 구간을 본 것으로 표시하지 않는다')
    assert.equal(batch.hasMore, true)
    assert.equal(batch.events.length, 1, '본 것은 그대로 흘린다')
  })

  it('이번에 아무것도 없으면 시계를 옮길 근거가 없다', async () => {
    const inventory = new RecordingInventory([{ items: [], complete: true }])
    const batch = await new JamEventSource({ inventory }).drain('2026-08-26T11:00:00.000Z')
    assert.equal(batch.cursor, '2026-08-26T11:00:00.000Z')
  })

  it('사건에 provider 상태와 담당자가 힌트로 실린다', async () => {
    const inventory = new RecordingInventory([{ items: [item('WORK-7', '2026-08-26T11:05:00.000Z')], complete: true }])
    const batch = await new JamEventSource({ inventory }).drain(null)

    assert.equal(batch.events[0]!.reference, 'WORK-7')
    assert.deepEqual(batch.events[0]!.hints?.actors, ['minyong'])
    assert.deepEqual(batch.events[0]!.hints?.labels, ['front'])
  })
})
