#!/usr/bin/env node
// ASC zero-install 진입 — 첫 실행만 담당한다.
//
// **여기에는 setup 정책이 한 줄도 없다** (C-14 불변식 ⑦). exact version으로 고정된
// runtime에 의존하고, 로컬에 설치된 `asc` 가 부르는 것과 **같은 명령**으로 넘긴다.
// 여기서 독자적으로 판단하면 그 판단은 곧 두 번째 구현이 되고, 둘은 반드시 갈라진다.
//
// 왜 별도 패키지인가: 아직 아무것도 설치되지 않은 machine에서 한 줄로 시작할 수 있어야
// 하는데, 그 한 줄이 곧 "설치까지 해 준다"는 뜻은 아니다. 설치는 plan에 적힌 변경이고
// apply가 한다 (C-14 §3).

import { runAscCommand } from '@asc-agent/runtime'

const USAGE = `asc-bootstrap — first run for ASC (Agent Session Control)

  npx --yes @asc-agent/bootstrap@0.2.0 init            install the runtime and attach
  npx --yes @asc-agent/bootstrap@0.2.0 setup plan --json    what would change; changes nothing
  npx --yes @asc-agent/bootstrap@0.2.0 profile adopt --json  make a profile for this repository

\`init\` is \`setup apply\`. It stops without changing anything when something
is left for you to answer.

This entry point holds no setup logic of its own. It forwards to the same
commands a locally installed \`asc\` runs.
`

async function main(argv: string[]): Promise<number> {
  const command = argv[0]
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE)
    return 0
  }
  // `init` 는 첫 실행의 사람이 쓰는 이름이고, 첫 실행이 기대하는 것은 **설치**다.
  // 여기서 `setup` 만 넘기면 runtime은 그것을 status로 읽어 진단만 찍고 0으로 끝난다 —
  // 문서가 "이 한 줄이 runtime을 설치한다"고 말하는 동안 아무것도 설치되지 않았다.
  // apply까지 붙여 넘긴다. 그래도 **판단은 runtime의 것이다** — 사람이 답해야 할 것이
  // 남아 있으면 apply는 아무것도 바꾸지 않고 그 자리에서 멈춘다 (C-14 §6).
  //
  // 그 외에는 한 글자도 바꾸지 않고 넘긴다. `profile adopt` 같은 뒤이은 명령도 같은 문으로
  // 들어와 같은 구현에 닿는다 — plan이 주는 `actions[].portable` 이 설치 전에도 그대로
  // 실행되는 근거가 이것이다 (C-14 불변식 ⑦·⑯).
  const forwarded = command === 'init' ? ['setup', 'apply', ...argv.slice(1)] : argv
  // 이 문으로 들어온 것을 알린다 — stable runtime 설치는 여기서만 계획된다 (C-14 §3.4)
  return runAscCommand(forwarded, 'bootstrap')
}

const code = await main(process.argv.slice(2))
process.exitCode = code
