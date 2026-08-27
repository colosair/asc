#!/usr/bin/env bash
# B-06 Walking Skeleton 데모 — 외부 시스템 없이 CLI만으로 전 구간을 걷는다.
#
#   생성 → 저장 → 조회 → 사람의 명시적 결정 → atomic 전이 → 재결정 차단
#
# 실행: ./demo/walking-skeleton.sh
set -euo pipefail

# runtime 패키지 뿌리 — 소스를 그대로 실행하는 개발 경로다 (C-14 §4)
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/runtime" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

asc() { (cd "$WORK" && node "$REPO/cli/asc.ts" "$@"); }
step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

step "0. attach 후 요청 하나와 승인자 매핑을 심는다"
# fail-closed guard(BROKEN_ATTACHMENT)를 지나려면 정식 attach가 필요하다 — pilot-local은
# 외부 canonical이 없는 fixture 전용 Profile이다
# 이 demo는 `$WORK/.asc` 를 직접 들여다보므로 저장소 안에 runtime을 둔다. 개인 사용의
# 기본은 그 반대(local scope, 저장소 footprint 0)다 — C-11 §2.
(cd "$WORK" && node "$REPO/cli/asc.ts" init --profile pilot-local --scope project --install "$REPO" >/dev/null)
node --input-type=module <<NODE
import { MarkdownStateStore } from '$REPO/adapters/markdown/state-store.ts'
import { ApprovalRequest } from '$REPO/core/model/entities.ts'
import { writeFile } from 'node:fs/promises'

const store = await MarkdownStateStore.open('$WORK/.asc')
await store.create('request', ApprovalRequest.parse({
  id: 'REQ-0042', version: 0, status: 'AWAITING_APPROVAL', type: 'actionable', priority: 'P0',
  title: 'Issue #19 답변 승인 필요', detectedAt: '2026-08-22T10:00:00+09:00',
  source: { eventKey: 'comment:531245', reference: 'Issue #19', threadLastEventId: 'evt-7' },
  situation: '오류 봉투 계약 해석을 물어왔다',
  impact: { interruptRequired: false, affectedSessions: ['S-20260822-01'] },
  recommendation: '답변 필요',
  draft: 'C안으로 확정하겠습니다. 마지막 문장은 빼주세요.',
  snapshot: [{ sourceId: 'shared-spec', baseline: 'abc123' }],
  authorizedApprover: 'controller-a',
  allowedDecisions: ['approve', 'revise', 'defer', 'dismiss'],
}))
await writeFile('$WORK/.asc/identities.json', JSON.stringify({ 'controller-a': ['local:colosair'] }, null, 2))
NODE
echo "  .asc/monitor/inbox/REQ-0042.md 생성됨"

step "1. 조회 — 무엇을 결정해야 하는지 본다"
asc inbox list

step "2. 상세 — 알림 당시 분석과 지금 사실이 갈려서 보인다"
asc inbox show REQ-0042

step "3. Agent가 자기 이름으로 승인 시도 → 거절"
asc inbox decide REQ-0042 approve --as assistant || echo "  (거절됨 — 예상된 결과)"

step "4. 사람이 고쳐서 승인"
asc inbox decide REQ-0042 revise --as colosair --revision 'C안으로 확정하겠습니다.'

step "5. 같은 요청을 다시 결정 시도 → 차단"
asc inbox decide REQ-0042 dismiss --as colosair || echo "  (차단됨 — 예상된 결과)"

step "6. Controller가 실행 계약을 발급하고 Executor가 한 번만 내보낸다"
node --input-type=module <<NODE
import { MarkdownStateStore } from '$REPO/adapters/markdown/state-store.ts'
import { GrantService } from '$REPO/core/execution/grant.ts'
import { Executor } from '$REPO/core/execution/executor.ts'
import { FakeScm } from '$REPO/adapters/memory/mocks.ts'
import { LocalIdentityBinding } from '$REPO/adapters/local/identity.ts'

const store = new MarkdownStateStore('$WORK/.asc')
const identity = new LocalIdentityBinding({ 'controller-a': ['local:colosair'] })
const scm = new FakeScm()
scm.setThread('owner/repo#19', 'evt-7')
scm.setBaseline('shared-spec', 'abc123')

const rejected = await new GrantService(store, identity).issue({
  grantId: 'G-9999', requestId: 'REQ-0042', issuedBy: 'assistant', channel: 'local',
  action: 'github.issue_comment.create', target: 'owner/repo#19',
  issuedAt: new Date().toISOString(),
})
console.log('  권한 없는 발급:', rejected.ok ? '발급됨(!)' : rejected.failure.kind)

const issued = await new GrantService(store, identity).issue({
  grantId: 'G-0001', requestId: 'REQ-0042', issuedBy: 'colosair', channel: 'local',
  action: 'github.issue_comment.create', target: 'owner/repo#19',
  issuedAt: new Date().toISOString(),
})
console.log('  발급:', issued.ok ? \`\${issued.grant.id} READY — payload="\${issued.grant.payload}"\` : issued.failure)

const executor = new Executor({ store, scm, runId: 'run-1' })
const first = await executor.run('G-0001')
console.log('  1회차:', first.ok ? \`EXECUTED → \${first.resultRef}\` : first.reason)

const second = await executor.run('G-0001')
console.log('  2회차:', second.ok ? '실행됨(!)' : \`차단 — \${second.reason}\`)
console.log('  외부 호출 횟수:', scm.executed.length)
NODE

step "7. 승인 이후 스레드가 움직였다면 나가지 않는다"
node --input-type=module <<NODE
import { MarkdownStateStore } from '$REPO/adapters/markdown/state-store.ts'
import { GrantService } from '$REPO/core/execution/grant.ts'
import { Executor } from '$REPO/core/execution/executor.ts'
import { ApprovalRequest } from '$REPO/core/model/entities.ts'
import { FakeScm } from '$REPO/adapters/memory/mocks.ts'
import { LocalIdentityBinding } from '$REPO/adapters/local/identity.ts'

const store = new MarkdownStateStore('$WORK/.asc')
await store.create('request', ApprovalRequest.parse({
  id: 'REQ-0043', version: 0, status: 'APPROVED', type: 'actionable', priority: 'P1',
  title: 'PR #50 리뷰 답변', detectedAt: '2026-08-22T11:00:00+09:00',
  source: { eventKey: 'review:88', reference: 'owner/repo#50', threadLastEventId: 'evt-3' },
  situation: '리뷰 코멘트', impact: { interruptRequired: false },
  draft: '반영하겠습니다.', snapshot: [{ sourceId: 'shared-spec', baseline: 'abc123' }],
  authorizedApprover: 'controller-a', allowedDecisions: ['approve'],
  decision: { kind: 'approve', actor: 'colosair', channel: 'local', decidedAt: '2026-08-22T12:00:00+09:00' },
}))
await new GrantService(store, new LocalIdentityBinding({ 'controller-a': ['local:colosair'] })).issue({
  grantId: 'G-0002', requestId: 'REQ-0043', issuedBy: 'colosair', channel: 'local',
  action: 'github.issue_comment.create', target: 'owner/repo#50',
  issuedAt: new Date().toISOString(),
})

const scm = new FakeScm()
scm.setThread('owner/repo#50', 'evt-9')   // 승인 이후 누군가 글을 달았다
scm.setBaseline('shared-spec', 'abc123')

const outcome = await new Executor({ store, scm, runId: 'run-2' }).run('G-0002')
console.log('  결과:', outcome.ok ? '실행됨(!)' : \`\${outcome.reason} — \${outcome.detail}\`)
console.log('  외부 호출 횟수:', scm.executed.length)
console.log('  계약 상태:', (await store.get('grant', 'G-0002')).status)
NODE

step "8. 남은 기록"
echo "monitor/log-current.md:"
sed 's/^/  /' "$WORK/.asc/monitor/log-current.md"
echo
echo "판단 대기 목록 (결정된 요청은 빠진다):"
asc inbox list | sed 's/^/  /'

printf '\n\033[1m완주.\033[0m 외부 시스템 0개. 사람이 결정하고, 계약을 받은 실행자가 한 번만 내보낸다.\n'
