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

  npx --yes @asc-agent/bootstrap@0.1.0 init
  npx --yes @asc-agent/bootstrap@0.1.0 setup plan --json

This entry point holds no setup logic of its own. It forwards to the same
commands a locally installed \`asc\` runs.
`

async function main(argv: string[]): Promise<number> {
  const command = argv[0]
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE)
    return 0
  }
  // `init` 는 첫 실행의 사람이 쓰는 이름이다. 그 외에는 한 글자도 바꾸지 않고 넘긴다.
  const forwarded = command === 'init' ? ['setup', ...argv.slice(1)] : argv
  // 이 문으로 들어온 것을 알린다 — stable runtime 설치는 여기서만 계획된다 (C-14 §3.4)
  return runAscCommand(forwarded, 'bootstrap')
}

const code = await main(process.argv.slice(2))
process.exitCode = code
