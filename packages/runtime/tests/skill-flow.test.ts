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

  it('적힌 명령에 deprecated alias 가 없다 — skill 이 옛 길을 정상 경로처럼 가르치지 않는다', () => {
    assert.doesNotMatch(skill.body, /asc proceed\b/)
    assert.doesNotMatch(skill.body, /asc progress show\b/)
  })

  // 0.9.0 — 실행 모드는 "누가 승인된 행위를 수행하는가" 하나를 답한다. skill 이 그 뜻을
  // 두 모드에서 서로 모순되게 적으면 Agent 는 어느 쪽에서도 움직일 수 없다. 여기서는
  // 절대 문장을 요구하지 않고 **두 모드의 계약이 서로 어긋나지 않는지** 를 본다.
  describe('AUTO 와 MANUAL 의 계약이 서로 모순되지 않는다', () => {
    const paragraphs = skill.body.split(/\n\s*\n/)
    const auto = paragraphs.filter((p) => /^\*\*In AUTO\*\*/.test(p.trim()))
    const manual = paragraphs.filter((p) => /^\*\*In MANUAL\*\*/.test(p.trim()))

    it('두 모드가 각각 한 문단으로 적혀 있다', () => {
      assert.equal(auto.length, 1)
      assert.equal(manual.length, 1)
    })

    it('AUTO 문단은 관리 경로(publish → grant run)를 가리킨다', () => {
      assert.match(auto[0]!, /asc work publish/)
      assert.match(auto[0]!, /asc grant run/)
    })

    it('MANUAL 문단은 셸을 가로막지 않는다고 말하고, 직접 수행을 열어 둔다', () => {
      assert.match(manual[0]!, /does not intercept or sandbox the shell/)
      assert.match(manual[0]!, /may perform an external mutation directly/)
    })

    it('MANUAL 문단이 raw 쓰기를 절대 금지하지 않는다 — skill 이 guard 를 글로 재생성하지 않는다', () => {
      assert.doesNotMatch(manual[0]!, /\b(never|must not)\b[^.]*\bgit push\b/i)
      assert.doesNotMatch(manual[0]!, /\bgit push\b[^.]*\b(never|must not)\b/i)
    })

    it('MANUAL 문단이 Agent 에게 자체 거절을 만들지 말라고 적는다', () => {
      assert.match(manual[0]!, /Do not invent a\s+refusal of your own/)
    })

    it('두 문단이 같은 행위에 상반된 절대 지시를 내리지 않는다', () => {
      // AUTO 가 "raw 로 우회하지 말라" 고 하는 것과 MANUAL 이 "직접 해도 된다" 고 하는 것은
      // 같은 행위에 대한 상반된 지시가 아니다 — 모드가 다르다. 모순은 한쪽이 "어느 모드에서도
      // (either mode / in both modes) 안 된다" 고 적는 순간 생긴다.
      assert.doesNotMatch(auto[0]!, /either mode|both modes|in any mode/i)
      assert.doesNotMatch(manual[0]!, /either mode|both modes|in any mode/i)
    })
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
