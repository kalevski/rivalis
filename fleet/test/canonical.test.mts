import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { canonicalize, hash64 } from '../lib/canonical.js'

// ---------------------------------------------------------------------------
// Deterministic PRNG + random-value generator. No fast-check dependency (the
// package is zero-dep, §5), so the property tests are hand-rolled over a seeded
// LCG — failures are reproducible by re-running with the same seed.
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
    let state = seed >>> 0
    return () => {
        // Numerical Recipes LCG; returns a float in [0, 1).
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state / 0x100000000
    }
}

const UNICODE_SAMPLES = [
    'plain',
    'with space',
    'emoji 🚀🔥',
    'café',
    'naïve',
    '日本語',
    'quote " and \\ backslash',
    'newline\ntab\t',
    'ключ',
    'a/b~c%d',
    ''
]

function randomKey(rng: () => number): string {
    return UNICODE_SAMPLES[Math.floor(rng() * UNICODE_SAMPLES.length)]
}

function randomNumber(rng: () => number): number {
    const pick = rng()
    if (pick < 0.2) return Math.floor(rng() * 2000) - 1000      // signed int
    if (pick < 0.4) return (rng() - 0.5) * 1e6                  // float
    if (pick < 0.6) return rng() * 1e21                         // large → exponential form
    if (pick < 0.7) return -0                                   // negative zero
    if (pick < 0.8) return 0
    return rng() * 100
}

function randomScalar(rng: () => number): unknown {
    const pick = rng()
    if (pick < 0.3) return randomNumber(rng)
    if (pick < 0.55) return UNICODE_SAMPLES[Math.floor(rng() * UNICODE_SAMPLES.length)]
    if (pick < 0.7) return rng() < 0.5
    return null
}

function randomValue(rng: () => number, depth: number): unknown {
    if (depth <= 0 || rng() < 0.5) {
        return randomScalar(rng)
    }
    if (rng() < 0.5) {
        const len = Math.floor(rng() * 4)
        const arr: unknown[] = []
        for (let i = 0; i < len; i++) {
            arr.push(randomValue(rng, depth - 1))
        }
        return arr
    }
    const size = Math.floor(rng() * 5)
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < size; i++) {
        obj[randomKey(rng) + '_' + i] = randomValue(rng, depth - 1)
    }
    return obj
}

// Deep clone that re-inserts every object's keys in a shuffled order. Arrays
// keep their order (arrays are ordered data); only object key order is jumbled.
function cloneWithShuffledKeys(value: unknown, rng: () => number): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => cloneWithShuffledKeys(item, rng))
    }
    if (value !== null && typeof value === 'object') {
        const obj = value as Record<string, unknown>
        const keys = Object.keys(obj)
        // Fisher–Yates shuffle.
        for (let i = keys.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1))
            ;[keys[i], keys[j]] = [keys[j], keys[i]]
        }
        const out: Record<string, unknown> = {}
        for (const key of keys) {
            out[key] = cloneWithShuffledKeys(obj[key], rng)
        }
        return out
    }
    return value
}

// ---------------------------------------------------------------------------
// Property: key insertion order never changes the output (§15).
// ---------------------------------------------------------------------------

test('property: key insertion order never changes the canonical output', () => {
    const gen = makeRng(0xC0FFEE)
    const shuf = makeRng(0xBADF00D)
    for (let i = 0; i < 1000; i++) {
        const original = randomValue(gen, 5)
        const reordered = cloneWithShuffledKeys(original, shuf)
        assert.equal(
            canonicalize(reordered),
            canonicalize(original),
            `canonical output diverged on iteration ${i} for ${JSON.stringify(original)}`
        )
        assert.equal(hash64(reordered), hash64(original))
    }
})

test('property: nested structures encode their leaves identically regardless of order', () => {
    const a = { outer: { z: 1, a: [{ q: 1, p: 2 }, { b: false, a: true }] }, first: 'x' }
    const b = { first: 'x', outer: { a: [{ p: 2, q: 1 }, { a: true, b: false }], z: 1 } }
    assert.equal(canonicalize(a), canonicalize(b))
    assert.equal(canonicalize(a), '{"first":"x","outer":{"a":[{"p":2,"q":1},{"a":true,"b":false}],"z":1}}')
})

test('arrays preserve element order (only object keys are sorted)', () => {
    assert.equal(canonicalize([3, 1, 2]), '[3,1,2]')
    assert.notEqual(canonicalize([1, 2, 3]), canonicalize([3, 2, 1]))
})

// ---------------------------------------------------------------------------
// Unicode + number formatting stability.
// ---------------------------------------------------------------------------

test('unicode keys and values round-trip and stay order-independent', () => {
    const a = { '日本語': '🚀', café: 'naïve', ключ: 1 }
    const b = { ключ: 1, café: 'naïve', '日本語': '🚀' }
    assert.equal(canonicalize(a), canonicalize(b))
    // Strings escaped exactly as JSON.stringify would (parses back unchanged).
    assert.deepEqual(JSON.parse(canonicalize(a)), a)
})

test('number formatting matches JSON and is stable', () => {
    assert.equal(canonicalize(1.5), '1.5')
    assert.equal(canonicalize(1e21), '1e+21')
    assert.equal(canonicalize(-0), '0')              // negative zero normalizes
    assert.equal(canonicalize(0), '0')
    assert.equal(canonicalize({ n: 0.1 + 0.2 }), '{"n":0.30000000000000004}')
    // Non-finite numbers map to null, exactly like JSON.stringify.
    assert.equal(canonicalize(NaN), 'null')
    assert.equal(canonicalize(Infinity), 'null')
})

test('undefined / functions are skipped in objects and null in arrays (JSON parity)', () => {
    assert.equal(canonicalize({ a: undefined, b: 1 }), '{"b":1}')
    assert.equal(canonicalize([undefined, 1]), '[null,1]')
})

// ---------------------------------------------------------------------------
// Hash contract (§7, acceptance criteria).
// ---------------------------------------------------------------------------

test('same logical object → same hash; one-field change → different hash', () => {
    const base = { id: 'i_1', connections: 10, rooms: ['a', 'b'], status: 'active' }
    const same = { status: 'active', rooms: ['a', 'b'], connections: 10, id: 'i_1' }
    assert.equal(hash64(base), hash64(same))

    const changed = { ...base, connections: 11 }
    assert.notEqual(hash64(base), hash64(changed))
})

test('hash is 16 lower-case hex chars (truncated 64-bit SHA-256)', () => {
    for (const value of [{}, { a: 1 }, [1, 2, 3], 'string', 42, null]) {
        const h = hash64(value)
        assert.match(h, /^[0-9a-f]{16}$/, `bad hash shape: ${h}`)
    }
})

test('hash equals the first 8 bytes of SHA-256 over the canonical encoding', () => {
    const value = { region: 'eu', rooms: 3, nested: { a: [1, 2] } }
    const expected = createHash('sha256').update(canonicalize(value)).digest().subarray(0, 8).toString('hex')
    assert.equal(hash64(value), expected)
})

test('hash is stable across runs (no time/random input)', () => {
    const value = { instances: 2, rooms: 7, roomTypes: ['match', 'lobby'] }
    assert.equal(hash64(value), hash64(value))
    // Pinned literal — regression guard against an encoder change silently
    // shifting every hash in the fleet.
    assert.equal(hash64({ a: 1, b: 2 }), '43258cff783fe703')
})
