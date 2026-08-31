// Release SHA integrity — the finalize stage tags the commit the registry
// actually published, resolved from npm's signed provenance. These pin the
// refusal paths: a wrong repository, a torn publish, and a missing
// attestation must all stop finalization rather than let a tag drift to
// whatever main happens to be.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// @ts-expect-error — plain .mjs script, no type surface on purpose
import { resolvePublishedCommit } from '../../../scripts/resolve-published-commit.mjs'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

const document = (commit: string, repository = 'https://github.com/colosair/asc') => ({
  attestations: [
    { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: { dsseEnvelope: { payload: '' } } },
    {
      predicateType: 'https://slsa.dev/provenance/v1',
      bundle: {
        dsseEnvelope: {
          payload: Buffer.from(
            JSON.stringify({
              predicate: {
                buildDefinition: {
                  externalParameters: { workflow: { repository } },
                  resolvedDependencies: [{ digest: { gitCommit: commit } }],
                },
              },
            }),
          ).toString('base64'),
        },
      },
    },
  ],
})

describe('resolve-published-commit — the tag target is the published commit', () => {
  it('agreeing provenance across both packages resolves to that commit', async () => {
    const commit = await resolvePublishedCommit('0.3.9', [document(SHA_A), document(SHA_A)])
    assert.equal(commit, SHA_A)
  })

  it('a torn publish (packages naming different commits) is refused', async () => {
    await assert.rejects(
      () => resolvePublishedCommit('0.3.9', [document(SHA_A), document(SHA_B)]),
      /torn publish/,
    )
  })

  it('provenance from another repository is refused', async () => {
    await assert.rejects(
      () => resolvePublishedCommit('0.3.9', [document(SHA_A, 'https://github.com/evil/asc'), document(SHA_A)]),
      /names https:\/\/github.com\/evil\/asc/,
    )
  })

  it('a missing provenance attestation is refused', async () => {
    await assert.rejects(
      () => resolvePublishedCommit('0.3.9', [{ attestations: [] }, document(SHA_A)]),
      /no SLSA provenance/,
    )
  })

  it('a missing document is refused', async () => {
    await assert.rejects(() => resolvePublishedCommit('0.3.9', [undefined, document(SHA_A)]), /no attestation document/)
  })

  it('a malformed gitCommit is refused', async () => {
    await assert.rejects(
      () => resolvePublishedCommit('0.3.9', [document('not-a-sha'), document('not-a-sha')]),
      /no usable gitCommit/,
    )
  })
})
