/**
 * 배포본에 실리는 Profile. **allowlist다** — 새 Profile은 여기 적기 전까지 나가지 않는다.
 *
 * `profiles/` 에는 실 프로젝트를 가리키는 Profile이 있고, 그것은 남의 저장소 이름과 조직
 * 구조를 담고 있다. source checkout에는 그대로 두고(그쪽이 관측 기록이자 실사용 설정이다)
 * 공개 artifact에서만 뺀다. 파일을 고쳐 익명화하지 않는 이유는 내용이 바뀌면 profile
 * digest가 바뀌고, 이미 붙어 있는 workspace가 LOCK_DRIFT로 멈추기 때문이다.
 *
 * 빠뜨렸을 때 새는 쪽이 아니라 없는 쪽으로 틀린다 — 적지 않으면 배포되지 않는다.
 */
export const PUBLIC_PROFILES = ['pilot-local', 'example-team']
