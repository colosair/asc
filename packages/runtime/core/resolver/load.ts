// Profile Resolver — 파일에서 계층을 읽어 하나의 Resolved Profile을 만들고,
// 그 조합을 재현할 수 있게 lock에 박아 둔다 (OM §4.7~4.9).
//
// 산출물 셋의 성격이 다르다:
//   resolved-profile — 언제든 다시 만들 수 있는 파생물. 지워도 된다.
//   ASC.md           — 사람과 Agent가 읽는 생성물. 정책의 정본이 아니다 (OM §7.1).
//   profile.lock     — 재현성 기록. Resolver만 쓰고, 저절로 갱신되지 않는다.
//
// 마지막 것이 앞의 둘과 다른 이유: 파생물은 낡으면 다시 만들면 그만이지만, lock이 저 혼자
// 갱신되면 "무엇으로 돌렸는지"를 영영 잃는다. 그래서 불일치는 고쳐 주지 않고 알린다.

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

import { OperationalPreset, ProfileLock, ProjectProfile, UserOverride } from '../../schemas/profile.ts'
import type { MonitorConfig } from '../monitor/signals.ts'
import type { OwnershipMap } from '../policy/ownership.ts'
import { resolveProfile, type ConfigLayer, type ResolvedProfile } from './resolve.ts'
import { satisfies } from './version.ts'

export type LoadedLayers = {
  profile: ProjectProfile
  profileSource: string
  preset?: OperationalPreset
  presetSource?: string
  override?: UserOverride
}

export type ResolvedRuntime = {
  resolved: ResolvedProfile
  layers: LoadedLayers
  /** Monitor에 그대로 넘길 수 있는 형태로 합쳐 둔다. */
  monitor: MonitorConfig
  canonicalSources: string[]
  /** 승인 권한자 → 채널:actor. Override가 채운다 (OM §11.6). */
  controllerIdentities: Record<string, string[]>
  /** 역할 → 쓰기 영역·결정권. Profile만 선언한다 (C-04 §6). 없는 것이 정상이다. */
  ownership?: OwnershipMap
  degraded: string[]
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

/**
 * 설치 경로에서 Profile과 Preset을, 프로젝트에서 Override를 읽는다.
 * Override가 없는 것은 정상이다 — 팀 설정만으로도 돌아가야 한다.
 */
export async function loadLayers(input: {
  installRoot: string
  profileId: string
  presetId?: string
  overridePath?: string
}): Promise<LoadedLayers> {
  const profileSource = join(input.installRoot, 'profiles', input.profileId, 'profile.json')
  const profile = ProjectProfile.parse(await readJson(profileSource))

  let preset: OperationalPreset | undefined
  let presetSource: string | undefined
  if (input.presetId) {
    presetSource = join(input.installRoot, 'presets', `${input.presetId}.json`)
    preset = OperationalPreset.parse(await readJson(presetSource))
  }

  let override: UserOverride | undefined
  if (input.overridePath) {
    try {
      override = UserOverride.parse(await readJson(input.overridePath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  return {
    profile,
    profileSource,
    ...(preset ? { preset } : {}),
    ...(presetSource ? { presetSource } : {}),
    ...(override ? { override } : {}),
  }
}

/** Vanilla Defaults — 어느 프로젝트에서도 풀리지 않는 바닥 (OM §5.2). */
export function vanillaLayer(): ConfigLayer {
  return {
    id: 'vanilla',
    kind: 'vanilla',
    // 외부 write와 정본 수정은 Session 계약으로 열 수 없다. 나가는 길은 Execution Grant뿐이다.
    hardDeny: ['external.write', 'canonical.modify', 'policy.change'],
    softDeny: ['dependency.add', 'shared-module.change'],
    roleScopes: { implementer: ['**'], researcher: ['**'], planner: ['**'], verifier: [] },
  }
}

export function toLayers(loaded: LoadedLayers): ConfigLayer[] {
  const layers: ConfigLayer[] = [vanillaLayer()]

  layers.push({
    id: `profile:${loaded.profile.id}`,
    kind: 'profile',
    ...loaded.profile.policy,
    requiredCapabilities: loaded.profile.requires.capabilities,
    optionalCapabilities: loaded.profile.optionalCapabilities,
  })

  if (loaded.preset) layers.push({ id: `preset:${loaded.preset.id}`, kind: 'preset', ...loaded.preset.policy })
  if (loaded.override) layers.push({ id: 'override:local', kind: 'override', ...loaded.override.policy })

  return layers
}

export function resolveRuntime(
  loaded: LoadedLayers,
  availableCapabilities: readonly string[],
  ascVersion: string,
) {
  const result = resolveProfile(toLayers(loaded), availableCapabilities)
  if (!result.ok) return result

  // Profile이 요구한 Core 범위를 벗어나면 bootstrap 실패다. capability가 모자란 것과
  // 같은 급으로 다룬다 — 맞지 않는 Core에서 도는 것이 없는 기능을 쓰는 것보다 낫지 않다.
  const required = loaded.profile.requires.asc
  if (required) {
    const check = satisfies(ascVersion, required)
    if (!check.ok) {
      return {
        ok: false as const,
        failures: [
          {
            kind: 'INCOMPATIBLE_CORE' as const,
            detail: `Profile '${loaded.profile.id}' 는 ASC ${required} 를 요구한다 (${check.reason}: ${check.detail})`,
          },
        ],
      }
    }
  }

  const monitor: MonitorConfig = {
    identities: loaded.override?.monitorIdentities ?? [],
    reasonSignals: loaded.profile.monitor.reasonSignals,
    priorityLabels: loaded.profile.monitor.priorityLabels,
    escalationLabels: loaded.profile.monitor.escalationLabels,
    signalPriority: loaded.profile.monitor.signalPriority,
    ...(loaded.profile.monitor.inboxSignals ? { inboxSignals: loaded.profile.monitor.inboxSignals } : {}),
  }

  const runtime: ResolvedRuntime = {
    resolved: result.profile,
    layers: loaded,
    monitor,
    canonicalSources: loaded.profile.canonical.sources.map((s) => s.id),
    controllerIdentities: loaded.override?.controller.identities ?? {},
    ...(loaded.profile.ownership ? { ownership: loaded.profile.ownership } : {}),
    degraded: result.degraded,
  }
  return { ok: true as const, runtime }
}

// ── profile.lock ────────────────────────────────────────────────────────────

export function buildLock(input: {
  runtime: ResolvedRuntime
  ascVersion: string
  adapters: Record<string, string>
  generatedAt: string
}): ProfileLock {
  const { layers, resolved } = input.runtime
  return ProfileLock.parse({
    schemaVersion: 1,
    ascCore: { version: input.ascVersion },
    profile: { id: layers.profile.id, source: layers.profileSource, digest: digest(layers.profile) },
    ...(layers.preset && layers.presetSource
      ? { preset: { id: layers.preset.id, source: layers.presetSource, digest: digest(layers.preset) } }
      : {}),
    ...(layers.override ? { overrideDigest: digest(layers.override) } : {}),
    adapters: input.adapters,
    capabilities: resolved.capabilities,
    // 계층 하나만 달라져도 값이 바뀐다 — 무엇이 달라졌는지는 아래 compareLock이 짚는다
    configurationDigest: digest({
      profile: layers.profile,
      preset: layers.preset ?? null,
      override: layers.override ?? null,
      capabilities: resolved.capabilities,
      adapters: input.adapters,
    }),
    generatedAt: input.generatedAt,
  })
}

/**
 * 이전 lock을 무손실로 옮긴다 (OM §4.9·§7.4). 덮어쓰기만 하면 어떤 조합으로 돌렸는지가
 * 사라지고, 그러면 "그때는 됐는데"를 재현할 방법이 없다.
 * 파일명에 생성 시각과 digest를 함께 넣어 같은 날 여러 번 바꿔도 부딪히지 않게 한다.
 */
export async function archiveLock(ascRoot: string, previous: ProfileLock): Promise<string> {
  const dir = join(ascRoot, 'archive', 'profile-locks')
  await mkdir(dir, { recursive: true })
  const stamp = previous.generatedAt.replace(/[:.]/g, '-')
  const destination = join(dir, `${stamp}-${previous.configurationDigest}.json`)
  await rename(join(ascRoot, 'profile.lock'), destination)
  return destination
}

export type LockDrift = { field: string; locked: string; current: string }

/**
 * lock과 지금을 견준다. **자동으로 다시 만들지 않는다** — 무엇이 달라졌는지 사람이 보고
 * 정하는 것이 이 파일의 존재 이유다 (OM §4.9).
 */
export function compareLock(locked: ProfileLock, current: ProfileLock): LockDrift[] {
  const drifts: LockDrift[] = []
  const check = (field: string, a: string | undefined, b: string | undefined) => {
    if ((a ?? '(없음)') !== (b ?? '(없음)')) drifts.push({ field, locked: a ?? '(없음)', current: b ?? '(없음)' })
  }

  check('ascCore.version', locked.ascCore.version, current.ascCore.version)
  check('profile.id', locked.profile.id, current.profile.id)
  check('profile.digest', locked.profile.digest, current.profile.digest)
  check('preset.id', locked.preset?.id, current.preset?.id)
  check('preset.digest', locked.preset?.digest, current.preset?.digest)
  check('override.digest', locked.overrideDigest, current.overrideDigest)
  check('capabilities', locked.capabilities.join(','), current.capabilities.join(','))
  for (const name of new Set([...Object.keys(locked.adapters), ...Object.keys(current.adapters)])) {
    check(`adapters.${name}`, locked.adapters[name], current.adapters[name])
  }
  check('configurationDigest', locked.configurationDigest, current.configurationDigest)
  return drifts
}

// ── Run 시작 guard ──────────────────────────────────────────────────────────

export type BootstrapOutcome =
  | { ok: true; runtime: ResolvedRuntime; lock: ProfileLock }
  /** attach 전이다. `.asc/` 자체가 없다 — 설정 없이 도는 경로만 허용된다. */
  | { ok: false; reason: 'NOT_ATTACHED' }
  /**
   * `.asc/`는 있는데 lock이 없다. init이 중간에 죽었거나 lock을 잃은 상태이며,
   * attach 전과 구분되지 않으면 무엇으로 도는지 모르는 채 굴러간다.
   */
  | { ok: false; reason: 'BROKEN_ATTACHMENT'; detail: string }
  | { ok: false; reason: 'RESOLVE_FAILED'; details: string[] }
  /** 지금 조합이 lock과 다르다. 무엇으로 돌지 사람이 정해야 한다. */
  | { ok: false; reason: 'LOCK_DRIFT'; drifts: LockDrift[]; runtime: ResolvedRuntime }

/**
 * 모든 Run이 시작 전에 지나는 문 (OM §4.9). 지금 계층을 다시 합쳐 lock과 견주고,
 * 어긋나면 멈춘다.
 *
 * **자동으로 다시 resolve하거나 lock을 덮지 않는다.** 설정이 바뀐 채로 계속 돌면 그 Run이
 * 무엇을 근거로 판단했는지 나중에 알 수 없고, 사람이 바꾼 것인지 무언가 어긋난 것인지도
 * 구분되지 않는다. 멈추고 묻는 편이 싸다.
 */
export async function bootstrapGuard(input: {
  ascRoot: string
  installRoot: string
  profileId?: string
  presetId?: string
  capabilities: readonly string[]
  adapters: Record<string, string>
  ascVersion: string
}): Promise<BootstrapOutcome> {
  let lockedRaw: string
  try {
    lockedRaw = await readFile(join(input.ascRoot, 'profile.lock'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // `.asc/`가 있느냐 없느냐가 갈림길이다. 없으면 아직 붙이지 않은 것이고,
    // 있는데 lock만 없으면 붙이다 만 것이다 — 뒤엣것은 통과시키면 안 된다.
    try {
      await readFile(join(input.ascRoot, 'ASC.md'), 'utf8')
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code === 'ENOENT') {
        const attached = await pathExists(input.ascRoot)
        return attached
          ? { ok: false, reason: 'BROKEN_ATTACHMENT', detail: 'profile.lock 이 없다' }
          : { ok: false, reason: 'NOT_ATTACHED' }
      }
      throw inner
    }
    return { ok: false, reason: 'BROKEN_ATTACHMENT', detail: 'ASC.md 는 있는데 profile.lock 이 없다' }
  }
  const locked = ProfileLock.parse(JSON.parse(lockedRaw))

  const layers = await loadLayers({
    installRoot: input.installRoot,
    profileId: input.profileId ?? locked.profile.id,
    ...(input.presetId ?? locked.preset?.id ? { presetId: input.presetId ?? locked.preset!.id } : {}),
    overridePath: join(input.ascRoot, 'override.json'),
  })

  const resolved = resolveRuntime(layers, input.capabilities, input.ascVersion)
  if (!resolved.ok) {
    return {
      ok: false,
      reason: 'RESOLVE_FAILED',
      details: resolved.failures.map((f) =>
        f.kind === 'POLICY' ? `${f.violation.kind}: ${f.violation.detail}` : `${f.kind}: ${f.detail}`,
      ),
    }
  }

  const current = buildLock({
    runtime: resolved.runtime,
    ascVersion: input.ascVersion,
    adapters: input.adapters,
    // 시각은 비교 대상이 아니다 — 조합이 같은지만 본다
    generatedAt: locked.generatedAt,
  })
  const drifts = compareLock(locked, current)
  if (drifts.length > 0) return { ok: false, reason: 'LOCK_DRIFT', drifts, runtime: resolved.runtime }

  return { ok: true, runtime: resolved.runtime, lock: locked }
}
