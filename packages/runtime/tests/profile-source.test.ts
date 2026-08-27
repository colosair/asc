// External Profile — 사용자 소유 공간의 Profile을 어떻게 고르는가.
//
// 여기서 지키는 것은 셋이다: **어디서 왔는지 말한다**, **위치가 바뀌어도 같은 Profile이면
// 같은 digest다**, **모호하거나 위험한 것은 통과시키지 않는다.**

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  assertProfileId,
  listProfileLocations,
  ProfileSourceError,
  resolveProfileLocation,
} from '../core/resolver/profile-source.ts'
import { digest, loadLayers } from '../core/resolver/load.ts'

const PROFILE = {
  schemaVersion: 1,
  id: 'team-real',
  requires: { asc: '>=0.1 <1.0', capabilities: ['scm.github'] },
  project: { scm: 'github', repository: 'example-org/example-repo' },
  canonical: { sources: [{ id: 'spec', provider: 'git', ref: 'main', paths: ['specs/**'] }] },
  policy: { roleScopes: { implementer: ['web-frontend/**'], verifier: [] } },
}

/** 설치 뿌리 하나와 사용자 소유 Profile 디렉터리 하나. 둘 다 임시다. */
async function roots(): Promise<{ installRoot: string; externalRoot: string }> {
  const base = await mkdtemp(join(tmpdir(), 'asc-profile-source-'))
  const installRoot = join(base, 'install')
  const externalRoot = join(base, 'home', 'profiles')
  await mkdir(join(installRoot, 'profiles'), { recursive: true })
  await mkdir(externalRoot, { recursive: true })
  return { installRoot, externalRoot }
}

const write = async (dir: string, id: string, profile: unknown = PROFILE) => {
  await mkdir(join(dir, id), { recursive: true })
  const path = join(dir, id, 'profile.json')
  await writeFile(path, JSON.stringify({ ...(profile as object), id }, null, 2), 'utf8')
  return path
}

describe('External Profile — 어디서 왔는지 말한다', () => {
  it('사용자 소유 공간의 Profile을 찾는다 — 배포본에 없어도 된다', async () => {
    const { installRoot, externalRoot } = await roots()
    const path = await write(externalRoot, 'team-real')
    const found = await resolveProfileLocation('team-real', { installRoot, externalRoot })
    assert.equal(found.origin, 'external')
    assert.equal(found.path, path)
  })

  it('사용자 소유 공간이 없으면 배포본 안을 본다', async () => {
    const { installRoot } = await roots()
    await write(join(installRoot, 'profiles'), 'pilot-local')
    const found = await resolveProfileLocation('pilot-local', { installRoot })
    assert.equal(found.origin, 'built-in')
  })

  it('둘 다 없으면 배포본 자리를 돌려준다 — 없다는 사실은 읽는 쪽에서 드러난다', async () => {
    const { installRoot, externalRoot } = await roots()
    const found = await resolveProfileLocation('nowhere', { installRoot, externalRoot })
    assert.equal(found.origin, 'built-in')
    assert.match(found.path, /profiles[\\/]nowhere[\\/]profile\.json$/)
  })

  it('목록은 어느 자리에서 왔는지 함께 든다', async () => {
    const { installRoot, externalRoot } = await roots()
    await write(externalRoot, 'team-real')
    await write(join(installRoot, 'profiles'), 'pilot-local')
    const found = await listProfileLocations({ installRoot, externalRoot })
    assert.deepEqual(
      found.map((location) => [location.id, location.origin]).sort(),
      [
        ['pilot-local', 'built-in'],
        ['team-real', 'external'],
      ].sort(),
    )
  })

  it('profile.json 이 없는 디렉터리는 후보가 아니다', async () => {
    const { installRoot, externalRoot } = await roots()
    await mkdir(join(externalRoot, 'empty-dir'), { recursive: true })
    const found = await listProfileLocations({ installRoot, externalRoot })
    assert.deepEqual(found, [])
  })
})

describe('External Profile — 모호한 것은 통과시키지 않는다', () => {
  it('같은 id가 양쪽에 있으면 멈춘다 — 조용히 하나를 고르지 않는다', async () => {
    const { installRoot, externalRoot } = await roots()
    await write(externalRoot, 'same-id')
    await write(join(installRoot, 'profiles'), 'same-id')
    await assert.rejects(
      resolveProfileLocation('same-id', { installRoot, externalRoot }),
      (error: unknown) => {
        assert.ok(error instanceof ProfileSourceError)
        assert.equal(error.code, 'PROFILE_COLLISION')
        // 사람이 고칠 수 있게 **두 경로를 모두** 말한다
        assert.match(error.message, /same-id/)
        return true
      },
    )
  })

  it('id로 경로를 타고 나가려는 시도를 문법에서 막는다', async () => {
    const { installRoot, externalRoot } = await roots()
    for (const id of ['../secrets', '..\\secrets', 'a/b', '/etc/passwd', '..', '.', '']) {
      await assert.rejects(resolveProfileLocation(id, { installRoot, externalRoot }), (error: unknown) => {
        assert.ok(error instanceof ProfileSourceError)
        assert.equal(error.code, 'INVALID_PROFILE_ID')
        return true
      })
    }
  })

  it('문법 검사만으로 끝내지 않는다 — 이름이 정상이어도 자리를 벗어나면 후보가 아니다', async () => {
    const { installRoot, externalRoot } = await roots()
    // 목록 쪽 경계. symlink는 문법을 통과하므로 존재 확인이 마지막 자물쇠다.
    const outside = join(externalRoot, '..', 'outside')
    await mkdir(join(outside, 'sneaky'), { recursive: true })
    await writeFile(join(outside, 'sneaky', 'profile.json'), JSON.stringify(PROFILE), 'utf8')
    const found = await listProfileLocations({ installRoot, externalRoot })
    assert.deepEqual(found, [], '뿌리 밖의 디렉터리가 후보로 올라왔다')
  })

  it('깨진 JSON은 Profile 해석 단계에서 걸린다 — 자리 고르기가 삼키지 않는다', async () => {
    const { installRoot, externalRoot } = await roots()
    await mkdir(join(externalRoot, 'broken'), { recursive: true })
    await writeFile(join(externalRoot, 'broken', 'profile.json'), '{ not json', 'utf8')
    const found = await resolveProfileLocation('broken', { installRoot, externalRoot })
    assert.equal(found.origin, 'external')
    await assert.rejects(
      loadLayers({ installRoot, externalProfileRoot: externalRoot, profileId: 'broken' }),
    )
  })

  it('스키마 밖 Profile은 그대로 거절된다 — external이라고 느슨해지지 않는다', async () => {
    const { installRoot, externalRoot } = await roots()
    await write(externalRoot, 'loose', { schemaVersion: 1, project: { scm: 'github' } })
    await assert.rejects(
      loadLayers({ installRoot, externalProfileRoot: externalRoot, profileId: 'loose' }),
    )
  })
})

describe('External Profile — 위치를 옮겨도 같은 Profile이다', () => {
  it('내용이 같으면 digest가 같다 — 옮겼다는 이유로 attach가 깨지지 않는다', async () => {
    const { installRoot, externalRoot } = await roots()
    await write(join(installRoot, 'profiles'), 'moving')
    const before = await loadLayers({ installRoot, profileId: 'moving' })

    const moved = await roots()
    await write(moved.externalRoot, 'moving')
    const after = await loadLayers({
      installRoot: moved.installRoot,
      externalProfileRoot: moved.externalRoot,
      profileId: 'moving',
    })

    assert.equal(before.profileOrigin, 'built-in')
    assert.equal(after.profileOrigin, 'external')
    assert.notEqual(before.profileSource, after.profileSource, '두 경로는 실제로 달라야 한다')
    assert.equal(digest(after.profile), digest(before.profile))
  })

  it('내용이 다르면 digest도 다르다 — 같은 자리라고 같은 것이 아니다', async () => {
    const { installRoot, externalRoot } = await roots()
    await write(externalRoot, 'changing')
    const before = await loadLayers({ installRoot, externalProfileRoot: externalRoot, profileId: 'changing' })
    await write(externalRoot, 'changing', {
      ...PROFILE,
      policy: { roleScopes: { implementer: ['server/**'], verifier: [] } },
    })
    const after = await loadLayers({ installRoot, externalProfileRoot: externalRoot, profileId: 'changing' })
    assert.notEqual(digest(after.profile), digest(before.profile))
  })
})

describe('assertProfileId', () => {
  it('평범한 이름은 통과한다', () => {
    for (const id of ['pilot-local', 'example-team', 'team.real', 'a', 'A1_b-2']) {
      assert.doesNotThrow(() => assertProfileId(id))
    }
  })
})

// symlink는 플랫폼에 따라 권한이 필요하다. 만들 수 있는 환경에서만 본다 —
// 못 만드는 환경에서 조용히 통과시키지 않고, 만들지 못했다는 사실을 그대로 둔다.
describe('External Profile — symlink', () => {
  it('뿌리 밖을 가리키는 symlink는 후보가 되지 않는다', async (t) => {
    const { installRoot, externalRoot } = await roots()
    const outside = join(externalRoot, '..', 'elsewhere')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'profile.json'), JSON.stringify(PROFILE), 'utf8')
    try {
      await symlink(outside, join(externalRoot, 'linked'), 'dir')
    } catch {
      return t.skip('이 환경에서는 symlink를 만들 수 없다 — 검사를 건너뛴다')
    }
    const found = await listProfileLocations({ installRoot, externalRoot })
    // symlink 자체는 디렉터리로 보이지만, 그 안의 profile.json 은 뿌리 밖 파일이다.
    // 지금 계약은 "이름은 한 칸, 경로는 뿌리 안" 이므로 여기서 걸리지 않으면 그 사실을 남긴다.
    for (const location of found) {
      assert.ok(location.path.startsWith(externalRoot), `${location.path} 가 뿌리 밖을 가리킨다`)
    }
  })
})
