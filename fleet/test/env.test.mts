import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readEnv, splitCsv, nodeEnv, DEFAULT_PORT, DEFAULT_HEARTBEAT_MS, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_LOG_LEVEL } from '../lib/env.js'

// ---------------------------------------------------------------------------
// Acceptance (task 003): src/env.ts is the single typed home for every env var.
// readEnv() reads from an injectable source and applies the §12 defaults; the
// flag→env→default precedence stays in cli.ts. One parsing behavior (the ported
// @toolcase/node env() semantics), no hand-rolled envInt/envBool.
// ---------------------------------------------------------------------------

test('readEnv applies §12 defaults when the source is empty', () => {
    const e = readEnv({} as NodeJS.ProcessEnv)
    assert.equal(e.FLEET_PORT, DEFAULT_PORT)
    assert.equal(e.FLEET_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS)
    assert.equal(e.FLEET_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS)
    assert.equal(e.FLEET_LOG_LEVEL, DEFAULT_LOG_LEVEL)
    assert.equal(e.FLEET_SSE_QUERY_AUTH, false)
    assert.equal(e.FLEET_TRUST_PROXY, false)
    // String vars with no default are null when unset (so cli.ts can leave host unset).
    assert.equal(e.FLEET_HOST, null)
    assert.equal(e.FLEET_AGENT_KEY, null)
    assert.equal(e.FLEET_ADMIN_KEY, null)
    assert.equal(e.FLEET_CORS_ORIGINS, null)
    assert.equal(e.NODE_ENV, null)
})

test('readEnv reads typed values from the injected source', () => {
    const e = readEnv({
        NODE_ENV: 'production', FLEET_HOST: '127.0.0.1', FLEET_PORT: '9100',
        FLEET_AGENT_KEY: 'ak', FLEET_HEARTBEAT_MS: '6000', FLEET_SSE_QUERY_AUTH: 'true',
        FLEET_TRUST_PROXY: 'true', FLEET_LOG_LEVEL: 'warn'
    } as NodeJS.ProcessEnv)
    assert.equal(e.NODE_ENV, 'production')
    assert.equal(e.FLEET_HOST, '127.0.0.1')
    assert.equal(e.FLEET_PORT, 9100)
    assert.equal(e.FLEET_AGENT_KEY, 'ak')
    assert.equal(e.FLEET_HEARTBEAT_MS, 6000)
    assert.equal(e.FLEET_SSE_QUERY_AUTH, true)
    assert.equal(e.FLEET_TRUST_PROXY, true)
    assert.equal(e.FLEET_LOG_LEVEL, 'warn')
})

test('numbers and booleans fall back on a malformed value (lenient env() semantics)', () => {
    const e = readEnv({ FLEET_PORT: 'eighty', FLEET_SSE_QUERY_AUTH: 'yes' } as NodeJS.ProcessEnv)
    assert.equal(e.FLEET_PORT, DEFAULT_PORT, 'parseInt round-trip fails → default')
    assert.equal(e.FLEET_SSE_QUERY_AUTH, false, "only 'true'/'false' parse; anything else → default")
})

test('readEnv restores process.env after binding the injected source', () => {
    const sentinel = '__fleet_env_test_sentinel__'
    process.env[sentinel] = 'present'
    try {
        readEnv({ FLEET_PORT: '1234' } as NodeJS.ProcessEnv)
        assert.equal(process.env[sentinel], 'present', 'process.env is restored after readEnv')
    } finally {
        delete process.env[sentinel]
    }
})

test('splitCsv trims, drops empties, and tolerates null/undefined', () => {
    assert.deepEqual(splitCsv('old, new ,newer'), ['old', 'new', 'newer'])
    assert.deepEqual(splitCsv('a,,b, '), ['a', 'b'])
    assert.deepEqual(splitCsv(null), [])
    assert.deepEqual(splitCsv(undefined), [])
})

test('nodeEnv reads NODE_ENV from process.env', () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'staging'
    try {
        assert.equal(nodeEnv(), 'staging')
    } finally {
        if (previous === undefined) {
            delete process.env.NODE_ENV
        } else {
            process.env.NODE_ENV = previous
        }
    }
})
