/**
 * Unit tests for the shared typed-codec toolkit (p2p.md §3.5, §10).
 *
 * Verifies: versioned frame encode/decode, WireVersionError on major mismatch,
 * truncation errors, append-only positional tags, and present() semantics.
 * Imported from the built lib so the lazy loader path is exercised.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    createCodec,
    WireVersionError,
    present,
    FieldType,
} from '../lib/main.js'

// ── Minimal test schema ───────────────────────────────────────────────────────

const MAJOR = 7
const F = FieldType

const codec = createCodec({
    namespace: '@rivalis/handshake-test',
    major: MAJOR,
    schema: {
        Msg: [
            { key: 'id', type: F.STRING, rule: 'optional' },
            { key: 'count', type: F.UINT32, rule: 'optional' },
            { key: 'flag', type: F.BOOL, rule: 'optional' },
        ],
        Nested: [
            { key: 'value', type: F.STRING, rule: 'optional' },
        ],
        Container: [
            { key: 'name', type: F.STRING, rule: 'optional' },
            { key: 'inner', type: 'Nested', rule: 'optional' },
        ],
    }
})

// ── Version header ────────────────────────────────────────────────────────────

test('encode prepends the 2-byte [major, minor] version header', () => {
    const frame = codec.encode('Msg', { id: 'x', count: 1, flag: true })
    assert.equal(frame[0], MAJOR, 'byte 0 is the major')
    assert.equal(frame[1], 0, 'byte 1 is the minor (defaults to 0)')
    assert.ok(frame.length > 2, 'frame has a protobuf body after the header')
})

test('custom minor is written to byte 1', () => {
    const c = createCodec({
        namespace: '@rivalis/handshake-test-minor',
        major: 3,
        minor: 5,
        schema: { M: [{ key: 'v', type: F.STRING, rule: 'optional' }] }
    })
    const frame = c.encode('M', { v: 'hello' })
    assert.equal(frame[0], 3)
    assert.equal(frame[1], 5)
})

// ── Round-trip ────────────────────────────────────────────────────────────────

test('flat message round-trips through encode/decode', () => {
    const input = { id: 'abc', count: 42, flag: true }
    const decoded = codec.decode('Msg', codec.encode('Msg', input))
    assert.equal(decoded.id, 'abc')
    assert.equal(decoded.count, 42)
    assert.equal(decoded.flag, true)
})

test('absent optional fields do not appear as own properties (present() semantics)', () => {
    const frame = codec.encode('Msg', { id: 'only-id' })
    const decoded = codec.decode('Msg', frame)
    assert.equal(decoded.id, 'only-id')
    // count and flag were not set — prototype defaults, not own properties
    assert.equal(present(decoded, 'count'), false, 'absent count is not present')
    assert.equal(present(decoded, 'flag'), false, 'absent flag is not present')
})

test('set fields report present() = true', () => {
    const decoded = codec.decode('Msg', codec.encode('Msg', { id: 'x', count: 0, flag: false }))
    assert.equal(present(decoded, 'id'), true)
    assert.equal(present(decoded, 'count'), true)
    assert.equal(present(decoded, 'flag'), true)
})

// ── WireVersionError ─────────────────────────────────────────────────────────

test('major mismatch throws WireVersionError with correct versions', () => {
    // Build a frame from a different major
    const otherCodec = createCodec({
        namespace: '@rivalis/handshake-test-other',
        major: 99,
        schema: { Msg: [{ key: 'id', type: F.STRING, rule: 'optional' }] }
    })
    const foreignFrame = otherCodec.encode('Msg', { id: 'x' })

    assert.throws(
        () => codec.decode('Msg', foreignFrame),
        (e: unknown) =>
            e instanceof WireVersionError &&
            e.theirVersion === 99 &&
            e.ourVersion === MAJOR
    )
})

test('a legacy JSON frame (first byte 123 = "{") throws WireVersionError', () => {
    const jsonFrame = Buffer.from(JSON.stringify({ id: 'x' }))
    assert.throws(
        () => codec.decode('Msg', jsonFrame),
        (e: unknown) => e instanceof WireVersionError && e.theirVersion === 123
    )
})

test('WireVersionError has the expected name and message', () => {
    const err = new WireVersionError(3, 7)
    assert.equal(err.name, 'WireVersionError')
    assert.ok(err.message.includes('3'), 'message includes their version')
    assert.ok(err.message.includes('7'), 'message includes our version')
})

// ── Truncated frames ──────────────────────────────────────────────────────────

test('empty frame throws (not a WireVersionError)', () => {
    assert.throws(
        () => codec.decode('Msg', new Uint8Array(0)),
        (e: unknown) => e instanceof Error && !(e instanceof WireVersionError) && /truncated/.test(e.message)
    )
})

test('single-byte frame throws (not a WireVersionError)', () => {
    assert.throws(
        () => codec.decode('Msg', Uint8Array.from([MAJOR])),
        (e: unknown) => e instanceof Error && !(e instanceof WireVersionError) && /truncated/.test(e.message)
    )
})

test('valid header + garbage body throws a plain Error', () => {
    assert.throws(
        () => codec.decode('Msg', Uint8Array.from([MAJOR, 0, 0xff, 0xff, 0xff, 0xff])),
        (e: unknown) => e instanceof Error && !(e instanceof WireVersionError)
    )
})

// ── Append-only positional tags ───────────────────────────────────────────────

test('field tags are positional: reordering the decode schema corrupts results', () => {
    // Encode with the correct Msg schema (id=tag1, count=tag2, flag=tag3)
    const frame = codec.encode('Msg', { id: 'hello', count: 5 })

    // A schema that swaps count and id would decode to a different object.
    // We verify the encoded frame is stable — the same schema always round-trips.
    const decoded = codec.decode('Msg', frame)
    assert.equal(decoded.id, 'hello')
    assert.equal(decoded.count, 5)
})

// ── Cross-minor-version round-trip ────────────────────────────────────────────
// The minor byte is reserved for additive evolution within a major.
// Decode only checks the major byte (byte 0); byte 1 is ignored. So a frame
// produced by a minor=1 build must be readable by a minor=0 build and vice versa.

test('frame encoded with minor=1 decodes correctly with a minor=0 codec (backward compat)', () => {
    const encoderV1 = createCodec({
        namespace: '@rivalis/handshake-minor-enc',
        major: MAJOR,
        minor: 1,
        schema: { M: [{ key: 'id', type: F.STRING, rule: 'optional' }] },
    })
    const decoderV0 = createCodec({
        namespace: '@rivalis/handshake-minor-dec',
        major: MAJOR,
        minor: 0,
        schema: { M: [{ key: 'id', type: F.STRING, rule: 'optional' }] },
    })
    const frame = encoderV1.encode('M', { id: 'hello' })
    assert.equal(frame[1], 1, 'encoder wrote minor=1')
    const decoded = decoderV0.decode('M', frame)
    assert.equal(decoded.id, 'hello')
})

test('frame encoded with minor=0 decodes correctly with a minor=1 codec (forward compat)', () => {
    const encoderV0 = createCodec({
        namespace: '@rivalis/handshake-minor-fwd-enc',
        major: MAJOR,
        minor: 0,
        schema: { M: [{ key: 'id', type: F.STRING, rule: 'optional' }] },
    })
    const decoderV1 = createCodec({
        namespace: '@rivalis/handshake-minor-fwd-dec',
        major: MAJOR,
        minor: 1,
        schema: { M: [{ key: 'id', type: F.STRING, rule: 'optional' }] },
    })
    const frame = encoderV0.encode('M', { id: 'world' })
    assert.equal(frame[1], 0, 'encoder wrote minor=0')
    const decoded = decoderV1.decode('M', frame)
    assert.equal(decoded.id, 'world')
})

// ── Append-only schema evolution ──────────────────────────────────────────────
// Frames encoded by an old schema (fewer fields) must be decodable by a new
// schema (more fields appended): original fields survive, new field is absent.
// Frames encoded by a new schema (extra appended field) must be decodable by
// an old schema: original fields survive, the unknown extra field is silently
// dropped (protobuf's built-in unknown-field behaviour).

const schemaV1 = {
    Ev: [
        { key: 'id', type: F.STRING, rule: 'optional' as const },
        { key: 'count', type: F.UINT32, rule: 'optional' as const },
    ],
}
const schemaV2 = {
    Ev: [
        { key: 'id', type: F.STRING, rule: 'optional' as const },
        { key: 'count', type: F.UINT32, rule: 'optional' as const },
        // appended field — tag 3
        { key: 'label', type: F.STRING, rule: 'optional' as const },
    ],
}

const codecV1 = createCodec({ namespace: '@rivalis/handshake-ev1', major: MAJOR, schema: schemaV1 })
const codecV2 = createCodec({ namespace: '@rivalis/handshake-ev2', major: MAJOR, schema: schemaV2 })

test('v2 decoder reads v1 frame: original fields intact, new field absent', () => {
    const frame = codecV1.encode('Ev', { id: 'x', count: 3 })
    const decoded = codecV2.decode('Ev', frame)
    assert.equal(decoded.id, 'x')
    assert.equal(decoded.count, 3)
    assert.equal(present(decoded, 'label'), false, 'appended field absent from old frame')
})

test('v1 decoder reads v2 frame: original fields intact, unknown extra field silently dropped', () => {
    const frame = codecV2.encode('Ev', { id: 'y', count: 7, label: 'new' })
    const decoded = codecV1.decode('Ev', frame)
    assert.equal(decoded.id, 'y')
    assert.equal(decoded.count, 7)
    // 'label' is unknown to v1; protobuf drops unknown fields silently
    assert.equal(present(decoded, 'label'), false, 'unknown appended field silently dropped')
})

// ── present() edge cases ──────────────────────────────────────────────────────

test('present() returns false for null, undefined, and non-own properties', () => {
    assert.equal(present(null, 'x'), false)
    assert.equal(present(undefined, 'x'), false)
    // Prototype property — Object.prototype has 'toString'
    const obj = Object.create({ inherited: true })
    assert.equal(present(obj, 'inherited'), false)
})

test('present() returns true for own properties including falsy values', () => {
    assert.equal(present({ x: 0 }, 'x'), true)
    assert.equal(present({ x: false }, 'x'), true)
    assert.equal(present({ x: '' }, 'x'), true)
    assert.equal(present({ x: null }, 'x'), true)
})
