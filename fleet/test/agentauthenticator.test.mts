import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AgentAuthenticator, matchKey } from '../lib/AgentAuthenticator.js'

// ---------------------------------------------------------------------------
// Direct unit tests for the agent authenticator (task 008 decomposition). This is
// the ONE definition of the constant-time key match (§13), shared by the WS agent
// auth (this class) and the REST admin auth (routers/shared re-exports matchKey).
// ---------------------------------------------------------------------------

test('matchKey returns the matching configured key, or null', () => {
    const keys = ['alpha-key', 'beta-key']
    assert.equal(matchKey('beta-key', keys), 'beta-key', 'returns the key that matched (for fingerprinting)')
    assert.equal(matchKey('alpha-key', keys), 'alpha-key')
    assert.equal(matchKey('wrong', keys), null, 'an unknown key matches nothing')
})

test('matchKey is null-safe and rejects empty input without matching', () => {
    assert.equal(matchKey(null, ['k']), null)
    assert.equal(matchKey('', ['k']), null, 'an empty presented key never matches')
    assert.equal(matchKey('k', []), null, 'no configured keys → no match')
})

test('matchKey never throws on length-mismatched candidates (timingSafeEqual hazard, §13)', () => {
    // Raw timingSafeEqual throws on unequal-length buffers; hashing first makes the
    // digests fixed-length, so wildly different lengths compare without crashing.
    assert.doesNotThrow(() => matchKey('x', ['a-very-long-configured-key-0123456789']))
    assert.doesNotThrow(() => matchKey('a-very-long-presented-key-0123456789', ['k']))
    assert.equal(matchKey('x', ['a-very-long-configured-key-0123456789']), null)
})

test('AgentAuthenticator.matches is a boolean over any configured key (rotation)', () => {
    const auth = new AgentAuthenticator(['old-key', 'new-key'])
    assert.equal(auth.matches('old-key'), true, 'the old key still works mid-rotation')
    assert.equal(auth.matches('new-key'), true, 'the new key works')
    assert.equal(auth.matches('nope'), false)
    assert.equal(auth.matches(''), false)
})
