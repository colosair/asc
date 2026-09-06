// 0.7.0 / L-01 — skill 문서가 실제 흐름과 같은 것을 말하는가.
//
// 조사에서 확인된 공백이다. skill 이 **설치되는지** 검사하는 테스트는 있었고, 그 안에
// 적힌 명령이 이 build 에 실제로 있는지 보는 것은 없었다. 문서가 낡으면 agent 는 낡은
// 순서를 따르고, 그 오류는 사람 눈에 "ASC 가 안 된다" 로 보인다.
//
// 여기서 검사하는 것은 세 가지다: 적힌 명령이 존재하는가, 자연어 의도마다 갈 자리가
// 있는가, 금지된 지름길을 권하지 않는가.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { readFile } from 'node:fs/promises'

import { skillText } from '../adapters/claude-code/skill.ts'

const skill = { body: skillText() }
/** 이 build 가 실제로 아는 명령. CLI 의 USAGE 를 그대로 읽는다 — 사본을 만들지 않는다. */
const USAGE = await readFile(new URL('../cli/asc.ts', import.meta.url), 'utf8')

/**
 * 문서가 **치라고 준 명령**의 첫 두 낱말. 산문 속의 낱말은 세지 않는다 — 코드로 표시된
 * 것만 본다(인라인 백틱 또는 블록). 인자와 옵션은 보지 않는다.
 */
function commandsIn(text: string): Set<string> {
  const found = new Set<string>()
  const marked = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('asc ')) marked.push(trimmed)
  }
  for (const snippet of marked) {
    const match = /^\s*asc\s+([a-z]+)(?:\s+([a-z-]+))?/.exec(snippet)
    if (!match) continue
    const sub = match[2]
    found.add(sub && !sub.startsWith('-') ? `${match[1]} ${sub}` : match[1]!)
  }
  return found
}

describe('skill 이 말하는 명령은 이 build 에 있다', () => {
  it('적힌 명령이 전부 USAGE 에 있다', () => {
    const missing = [...commandsIn(skill.body)].filter((command) => !USAGE.includes(`asc ${command}`))
    assert.deepEqual(missing, [], '문서가 이 build 에 없는 명령을 시킨다')
  })
})

describe('자연어 의도마다 갈 자리가 있다', () => {
  const intents: { intent: string; mustMention: RegExp[] }[] = [
    { intent: 'setup', mustMention: [/setup apply --json/, /asc setup/] },
    { intent: 'update', mustMention: [/asc update/, /jam update/] },
    { intent: 'refresh', mustMention: [/asc refresh/, /jam refresh/] },
    { intent: 'uninstall', mustMention: [/asc uninstall/, /jam uninstall/] },
    { intent: 'start work', mustMention: [/asc work start/] },
    { intent: 'continue work', mustMention: [/RESUMED|CONTINUE_ACTIVE/, /checkpoint/] },
    { intent: 'publish', mustMention: [/asc work publish/] },
    { intent: 'finish', mustMention: [/asc work finish/] },
    { intent: 'check status', mustMention: [/asc inbox/, /asc status/] },
    // 실행 축은 결정 축과 다르다는 것을 문서가 말해야 한다 (H-01~H-04).
    { intent: 'execution mode', mustMention: [/asc mode manual/, /asc mode auto/, /AUTO is not the opposite/] },
  ]

  for (const { intent, mustMention } of intents) {
    it(`"${intent}" 가 갈 자리를 말한다`, () => {
      for (const pattern of mustMention) {
        assert.match(skill.body, pattern, `${intent}: ${pattern}`)
      }
    })
  }
})

describe('권한 경계와 금지된 지름길', () => {
  it('외부 쓰기는 승인을 지난다고 적는다', () => {
    assert.match(skill.body, /grant/i)
    assert.match(skill.body, /git push/, '무엇이 막히는지 이름을 댄다')
  })

  it('막힌 것을 우회하라고 말하지 않는다', () => {
    // guard 에 걸리는 것은 풀 문제가 아니라 계약으로 가라는 신호다.
    assert.match(skill.body, /being stopped is not a puzzle to solve/)
  })

  it('발급과 선택은 사람의 자리라고 적는다', () => {
    assert.match(skill.body, /Do not pick one yourself/)
    assert.match(skill.body, /issuance is the Controller's/)
  })

  it('업데이트에 setup 을 쓰지 말라고 적는다 — 그것이 profile 을 다시 추론하는 경로다', () => {
    assert.match(skill.body, /Do not reach for .?setup apply.? to update/)
  })

  it('두 제품의 lifecycle 이 분리돼 있다고 적는다', () => {
    assert.match(skill.body, /ASC never updates JAM and JAM never updates ASC/)
  })
})
