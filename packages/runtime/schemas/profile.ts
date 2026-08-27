// Profile / Preset / Override 스키마.
//
// 형식은 JSON이다. 사람이 쓰는 설정이라 주석이 아쉽지만, 파서를 하나 더 들이지 않는 값이
// 더 컸다 — 설명은 이 스키마의 주석과 `$comment` 필드가 진다. 읽기만 바꾸면 되므로
// YAML이 필요해지면 로더 한 곳만 늘리면 된다.
//
// 여기서 가장 중요한 것은 **무엇이 들어오면 안 되는가**다 (OM §4.2). Profile은 정적
// 설정이고 Runtime 상태나 개인 비밀이 아니다. 그 경계를 스키마가 직접 막는다 —
// 문서로만 적어 두면 언젠가 누가 편하다는 이유로 토큰을 적어 넣는다.

import { z } from 'zod'

import { GENERIC_SIGNALS } from '../core/monitor/signals.ts'
import { DECISION_DOMAIN } from '../core/policy/ownership.ts'
import { parseScope } from '../core/policy/scope.ts'
import { CLOSURE_ITEM_ID } from '../core/runtime/closure.ts'

const Priority = z.enum(['P0', 'P1', 'P2'])
const Signal = z.enum(GENERIC_SIGNALS)

/** Runtime 상태·개인 비밀이 설정 파일에 섞이는 것을 막는다 (OM §4.2·§4.5). */
const FORBIDDEN_KEYS = [
  'activeSession',
  'activeSessions',
  'queue',
  'inbox',
  'handoff',
  'cursor',
  'eventIds',
  'token',
  'apiToken',
  'secret',
  'password',
]

/**
 * 파싱 **전에** 원본을 훑는다. zod는 모르는 키를 먼저 떼어내므로, 파싱 결과를 보면
 * 금지 키는 이미 사라진 뒤다 — 조용히 무시되는 것이 가장 나쁜 결과다.
 */
function rejectRuntimeAndSecrets<T extends z.ZodTypeAny>(schema: T) {
  const guard = z.unknown().superRefine((value, ctx) => {
    const walk = (node: unknown, path: (string | number)[]): void => {
      if (node === null || typeof node !== 'object') return
      for (const [key, child] of Object.entries(node)) {
        const lowered = key.toLowerCase()
        const hit = FORBIDDEN_KEYS.find((f) => lowered === f.toLowerCase())
        if (hit) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, key],
            message:
              `'${key}' 는 Runtime 상태이거나 비밀이라 이 파일에 둘 수 없다. ` +
              `상태는 .asc/ 에, 비밀은 환경변수나 자격 저장소에 둔다 (OM §4.2·§4.5).`,
          })
        }
        walk(child, [...path, key])
      }
    }
    walk(value, [])
  })
  return guard.pipe(schema)
}

/** 정본 한 갈래. 프로젝트는 하나가 아니라 집합을 갖는다 (OM §8). */
export const CanonicalSourceSpec = z.object({
  id: z.string().min(1),
  provider: z.enum(['git', 'github']),
  remote: z.string().optional(),
  ref: z.string().optional(),
  paths: z.array(z.string()).default([]),
  $comment: z.string().optional(),
})

/** Profile이 마무리 항목을 선언하는 관례 키 (B-20). */
const CLOSURE_CHECKLIST_KEY = 'closureChecklist'

const PolicySpec = z.object({
  hardDeny: z.array(z.string()).default([]),
  softDeny: z.array(z.string()).default([]),
  allow: z.array(z.string()).default([]),
  roleScopes: z.record(z.array(z.string())).default({}),
  settings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  lockedSettings: z.array(z.string()).default([]),
  /**
   * 계층마다 합집합으로 쌓이는 이름 목록. 병합은 Core에 이미 있는데 여기 선언이 없어
   * Profile로 채울 길이 없었다. 관례 키 `closureChecklist` — 세션이 끝난 뒤 확인해야 할
   * 프로젝트 마무리 항목 id (B-20).
   *
   * 항목 id 문법을 **여기서** 막는 이유: 잘못된 선언을 회수 시점까지 끌고 가면 세션이
   * 끝나고 나서야 "이 항목은 쓸 수 없다"를 알게 된다. resolve는 선언이 들어오는 입구이고,
   * 여기서 막으면 잘못된 값이 profile.lock에 고정되지도 않는다.
   *
   * default를 주지 않는 이유: 파싱 결과 객체가 바뀌면 profile digest가 달라져
   * 기존 attach가 전부 LOCK_DRIFT로 멈춘다.
   */
  unionLists: z
    .record(z.array(z.string()))
    .optional()
    .superRefine((lists, ctx) => {
      for (const item of lists?.[CLOSURE_CHECKLIST_KEY] ?? []) {
        if (CLOSURE_ITEM_ID.test(item)) continue
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [CLOSURE_CHECKLIST_KEY],
          message: `마무리 항목 id로 쓸 수 없다: '${item}' (허용: A-Z a-z 0-9 . _ -)`,
        })
      }
    }),
})

export const ProjectProfile = rejectRuntimeAndSecrets(
  z.object({
    schemaVersion: z.literal(1),
    $comment: z.string().optional(),
    id: z.string().min(1),
    requires: z
      .object({ asc: z.string().optional(), capabilities: z.array(z.string()).default([]) })
      .default({ capabilities: [] }),
    optionalCapabilities: z.array(z.string()).default([]),

    project: z.object({
      scm: z.string().min(1),
      repository: z.string().min(1),
    }),

    /**
     * 빈 집합은 "canonical 검증이 성립하지 않는 프로젝트"다 — 세션 발급·시작에서 정본
     * 대조가 통째로 빠진다. fixture·로컬 실험 전용이며, 실 프로젝트는 반드시 선언하라.
     */
    canonical: z.object({ sources: z.array(CanonicalSourceSpec).default([]) }).default({ sources: [] }),

    monitor: z
      .object({
        /** provider 어휘 → Generic Signal. Adapter가 내놓는 표를 여기서 고른다 (OM §10.6). */
        reasonSignals: z.record(Signal).default({}),
        priorityLabels: z.record(Priority).default({}),
        escalationLabels: z.array(z.string()).default([]),
        signalPriority: z.record(Signal, Priority).default({}),
        inboxSignals: z.array(Signal).optional(),
      })
      .default({ reasonSignals: {}, priorityLabels: {}, escalationLabels: [], signalPriority: {} }),

    workflow: z
      .object({
        blockSource: z.string().optional(),
        taskSource: z.array(z.string()).default([]),
        $comment: z.string().optional(),
      })
      .default({ taskSource: [] }),

    policy: PolicySpec.default({
      hardDeny: [],
      softDeny: [],
      allow: [],
      roleScopes: {},
      settings: {},
      lockedSettings: [],
    }),

    /**
     * 책임 지도 — 역할 → 쓰기 영역과 결정권 (C-04 §6). 매 세션 사람이 owner·authority를
     * 손으로 적지 않아도 되게 하는 **선언**이며, 이것만으로는 아무것도 막지 않는다.
     *
     * Preset·Override에는 두지 않는다. 책임 지도는 팀의 사실이라 개인 설정이 이것을 바꾸면
     * 사람마다 다른 결정권자를 보게 되고, 그때부터는 누구 말이 맞는지 정할 방법이 없다.
     *
     * default를 주지 않는 이유는 `unionLists`와 같다 — 파싱 결과 객체가 바뀌면 profile
     * digest가 달라져 기존 attach가 전부 LOCK_DRIFT로 멈춘다. Session의 `.default([])`와
     * 성격이 다르다: 저쪽은 이미 저장된 entity를 읽는 문제이고, 이쪽은 설정 identity를
     * 보존하는 문제다.
     */
    ownership: z
      .record(
        z.object({
          paths: z.array(z.string()).default([]),
          authorities: z.array(z.string()).default([]),
        }),
      )
      .optional()
      .superRefine((map, ctx) => {
        for (const [role, spec] of Object.entries(map ?? {})) {
          if (spec.paths.length === 0 && spec.authorities.length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [role],
              message: `'${role}' 은 쓰기 영역도 결정권도 없다 — 선언할 것이 없으면 적지 않는다.`,
            })
          }
          for (const path of spec.paths) {
            if (parseScope(path)) continue
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [role, 'paths'],
              message: `범위 문법이 아니다: '${path}' (허용: **, prefix/**, prefix/*, 정확한 경로)`,
            })
          }
          for (const domain of spec.authorities) {
            if (DECISION_DOMAIN.test(domain)) continue
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [role, 'authorities'],
              message: `decision domain 이름으로 쓸 수 없다: '${domain}' (소문자 kebab-case)`,
            })
          }
        }
      }),

    /**
     * Resource Binding 역할 배정 (C-09 §3). 프로젝트는 외부 시스템을 하나만 쓰지 않는다 —
     * 코드가 한 곳, 작업 항목이 다른 곳, 전달이 또 다른 곳일 수 있다.
     *
     * **역할은 사람이 정한다.** 어느 binding이 code-primary인지 ASC가 추론하지 않는다.
     * adapter가 발견하는 것은 "여기 붙을 수 있다"까지이고, 그것이 무슨 역할인지는 정책이다.
     *
     * `project.scm`은 하위호환으로 남지만 runtime 조립의 중심이 아니다.
     *
     * ownership과 같은 이유로 default를 주지 않는다 — 파싱 결과가 바뀌면 profile digest가
     * 달라져 기존 attach가 전부 LOCK_DRIFT로 멈춘다 (C-04 §6.3).
     */
    bindings: z
      .array(
        z.object({
          /** 'code-primary' | 'work' | 'presentation' … 자유 문자열이다. */
          role: z.string().min(1),
          /** adapter id. Core는 이 값으로 분기하지 않는다 — 조립은 Composition의 몫이다. */
          adapter: z.string().min(1),
          /** 문법은 adapter 소관. Core는 문자열로만 다룬다. */
          resource: z.string().min(1),
        }),
      )
      .optional()
      .superRefine((bindings, ctx) => {
        // 같은 역할을 둘이 주장하면 어느 쪽인지 정할 수 없다. 선언 입구에서 막는다 —
        // 회수 시점에 AMBIGUOUS_BINDING으로 만나면 이미 늦다.
        const seen = new Set<string>()
        for (const binding of bindings ?? []) {
          if (seen.has(binding.role)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `역할 '${binding.role}' 이 두 번 선언됐다 — 하나로 정하라.`,
            })
          }
          seen.add(binding.role)
        }
      }),

    /** 프로젝트 용어를 Core 개념에 붙인다. 사람이 읽는 문서에만 쓰인다. */
    terminology: z.record(z.string()).default({}),
  }),
)
export type ProjectProfile = z.infer<typeof ProjectProfile>

/** 운영 성향. HARD DENY는 여기서 풀 수 없다 (OM §4.3). */
export const OperationalPreset = rejectRuntimeAndSecrets(
  z.object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    $comment: z.string().optional(),
    policy: PolicySpec.partial().default({}),
  }),
)
export type OperationalPreset = z.infer<typeof OperationalPreset>

/**
 * 개인 몫. 같은 Profile을 쓰는 팀원끼리 여기만 달라진다 (OM §4.4).
 * 비밀은 값이 아니라 참조로만 적는다 — `tokenEnv` 는 이름이지 토큰이 아니다.
 */
export const UserOverride = rejectRuntimeAndSecrets(
  z.object({
    schemaVersion: z.literal(1),
    $comment: z.string().optional(),
    identity: z.record(z.string()).default({}),
    /** "나"로 인정할 계정들. Monitor의 신호 판정에 쓰인다. */
    monitorIdentities: z.array(z.string()).default([]),
    controller: z
      .object({
        /** 승인 권한자 → `채널:actor` 목록 (OM §11.6). */
        identities: z.record(z.array(z.string())).default({}),
      })
      .default({ identities: {} }),
    approval: z
      .object({
        preferredChannel: z.string().optional(),
        messenger: z.object({ provider: z.string(), tokenEnv: z.string() }).optional(),
      })
      .default({}),
    monitor: z
      .object({
        realtime: z.boolean().optional(),
        /**
         * 내가 맡은 ownership 역할들 (C-04 §6의 역할 이름). 관련성 판정에서 "내 영역"의
         * 기준이 된다 — 팀 공통 사실이 아니라 개인 사실이라 Profile이 아니라 여기 산다.
         *
         * `.optional()`인 이유: 기존 override 파일의 parse 결과를 바꾸지 않기 위해서다.
         * 기본값을 주면 없던 키가 생겨 overrideDigest가 흔들리고, 아무것도 고치지
         * 않은 사용자가 LOCK_DRIFT를 본다.
         */
        roles: z.array(z.string()).optional(),
      })
      .default({}),
    policy: PolicySpec.partial().default({}),
  }),
)
export type UserOverride = z.infer<typeof UserOverride>

/** attach 재현성 metadata (OM §4.9). Resolver만 쓴다. */
export const ProfileLock = z.object({
  schemaVersion: z.literal(1),
  ascCore: z.object({ version: z.string(), commit: z.string().optional() }),
  profile: z.object({ id: z.string(), source: z.string(), digest: z.string() }),
  preset: z.object({ id: z.string(), source: z.string(), digest: z.string() }).optional(),
  overrideDigest: z.string().optional(),
  adapters: z.record(z.string()).default({}),
  capabilities: z.array(z.string()).default([]),
  configurationDigest: z.string(),
  generatedAt: z.string(),
})
export type ProfileLock = z.infer<typeof ProfileLock>
