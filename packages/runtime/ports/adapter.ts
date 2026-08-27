// Adapter Contract — 외부 시스템 하나를 ASC에 잇는 모듈의 공통 lifecycle (C-09 §5).
//
// 세 단계는 비용도 부작용도 다르다. 합치면 "설정을 안 한 것"과 "닿지 않는 것"이
// 구분되지 않고, 계획을 세우려고 부른 함수가 네트워크를 친다.
//
//   describe()  정적 선언. 호출도 네트워크도 없다
//   discover()  이 프로젝트·환경에서 연결 가능한 후보를 찾는다 (로컬 관찰)
//   probe()     그 후보가 실제로 쓸 수 있는지 잰다 (외부 접촉 가능)
//
// adapter는 자기가 제공하는 Port만 구현한다. 전부 구현할 필요가 없다 —
// 작업 추적기가 변경 경로를 모르고, 전달 채널은 그 둘 다 모른다 (C-09 §2.1).

import type { AdapterDescriptor, BindingCandidate, ProbeState } from '../core/binding/types.ts'

/** discover가 훑는 환경. 파일·프로세스 접근을 호출자가 정해 준다 — adapter가 임의로 뒤지지 않는다. */
export type DiscoveryContext = {
  /** 대상 프로젝트 뿌리. */
  projectRoot: string
  /** 환경변수. 자격 **존재 여부** 판단에만 쓰고 값을 실어 나르지 않는다. */
  env?: NodeJS.ProcessEnv
}

export type ProbeResult = {
  state: ProbeState
  /** 상태만 주면 고칠 수가 없다. UNCONFIGURED면 무엇을 채워야 하는지 말한다. */
  detail?: string
  /** 실측으로 확인된 제공 범위. describe보다 좁을 수 있다. */
  provides?: readonly BindingCandidate['provides'][number][]
}

/**
 * adapter 자체가 지금 쓸 수 있는 상태인가 — **프로젝트와 무관한 사실**이다.
 *
 * 왜 binding probe와 나누는가: "도구는 깔려 있고 자격도 있다"와 "이 프로젝트가 그 도구에
 * 연결돼 있다"는 다른 사실이다. 둘을 합치면 사람이 무엇을 해야 하는지 알 수 없다 —
 * 도구를 설치할 일인지, 이 프로젝트를 붙일 일인지.
 *
 * 제공하지 않는 adapter는 그 구분이 필요 없다는 뜻이다.
 */
export type RuntimeStatus = { state: ProbeState; detail?: string }

export interface Adapter {
  describe(): AdapterDescriptor
  /** 후보가 없으면 빈 배열. 그것도 사람이 알아야 할 사실이다. */
  discover(context: DiscoveryContext): Promise<BindingCandidate[]>
  probe(candidate: BindingCandidate, context: DiscoveryContext): Promise<ProbeResult>
  runtime?(context: DiscoveryContext): Promise<RuntimeStatus>
}
