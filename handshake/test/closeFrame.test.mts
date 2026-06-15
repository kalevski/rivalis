/**
 * Unit tests for the __rivalis:close control frame codec (p2p.md §3.4, §10).
 *
 * Verifies: topic constant, round-trip encode/decode, 123-byte reason ceiling
 * (UTF-8 boundary-safe), and that the RESERVED_TOPIC_PREFIX guard in Room
 * already blocks user bind() on __ topics (structural assertion only — no
 * framework startup needed, the guard is a plain string-prefix check).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    CLOSE_CONTROL_TOPIC,
    MAX_CLOSE_REASON_BYTES,
    encodeCloseFrame,
    decodeCloseFrame,
} from '../lib/main.js'

// ── Topic constant ────────────────────────────────────────────────────────────

test('CLOSE_CONTROL_TOPIC is __rivalis:close', () => {
    assert.equal(CLOSE_CONTROL_TOPIC, '__rivalis:close')
})

test('CLOSE_CONTROL_TOPIC starts with the __ reserved prefix', () => {
    assert.ok(
        CLOSE_CONTROL_TOPIC.startsWith('__'),
        'topic must begin with __ so Room.bind() rejects it'
    )
})

test('MAX_CLOSE_REASON_BYTES is 123 (RFC 6455 §5.5 WebSocket cap)', () => {
    assert.equal(MAX_CLOSE_REASON_BYTES, 123)
})

// ── Round-trip ────────────────────────────────────────────────────────────────

test('encodeCloseFrame / decodeCloseFrame round-trips code and reason', () => {
    const frame = encodeCloseFrame(4003, 'room_destroyed')
    const decoded = decodeCloseFrame(frame)
    assert.equal(decoded.code, 4003)
    assert.equal(decoded.reason, 'room_destroyed')
})

test('round-trips all CloseCode values (4001–4005)', () => {
    const codes = [4001, 4002, 4003, 4004, 4005]
    for (const code of codes) {
        const decoded = decodeCloseFrame(encodeCloseFrame(code, 'test'))
        assert.equal(decoded.code, code, `CloseCode ${code} should round-trip`)
    }
})

test('round-trips an empty reason string', () => {
    const decoded = decodeCloseFrame(encodeCloseFrame(4001, ''))
    assert.equal(decoded.code, 4001)
    assert.equal(decoded.reason, '')
})

// ── 123-byte reason ceiling ───────────────────────────────────────────────────

test('reason exactly 123 ASCII bytes passes through untruncated', () => {
    const reason = 'a'.repeat(123)
    assert.equal(Buffer.from(reason, 'utf-8').length, 123)
    const decoded = decodeCloseFrame(encodeCloseFrame(4003, reason))
    assert.equal(decoded.reason, reason)
})

test('reason longer than 123 ASCII bytes is truncated to 123', () => {
    const reason = 'x'.repeat(200)
    const decoded = decodeCloseFrame(encodeCloseFrame(4003, reason))
    assert.ok(
        Buffer.from(decoded.reason, 'utf-8').length <= MAX_CLOSE_REASON_BYTES,
        'truncated reason must fit in 123 bytes'
    )
    assert.equal(decoded.reason, 'x'.repeat(123))
})

test('multibyte UTF-8 reason is truncated at a codepoint boundary', () => {
    // '€' encodes to 3 bytes (0xe2 0x82 0xac).
    // 123 / 3 = 41 whole '€' chars = 123 bytes. One more would be 124.
    const exact41 = '€'.repeat(41)             // 123 bytes exactly
    const tooLong = '€'.repeat(42)             // 126 bytes
    assert.equal(Buffer.from(exact41, 'utf-8').length, 123)
    assert.equal(Buffer.from(tooLong, 'utf-8').length, 126)

    // exact41 should pass through
    const decoded41 = decodeCloseFrame(encodeCloseFrame(4003, exact41))
    assert.equal(decoded41.reason, exact41)

    // tooLong must be truncated to 41 '€' (123 bytes), not mid-codepoint
    const decodedTooLong = decodeCloseFrame(encodeCloseFrame(4003, tooLong))
    assert.equal(decodedTooLong.reason, exact41, 'truncation stops at a codepoint boundary')
    assert.equal(
        Buffer.from(decodedTooLong.reason, 'utf-8').length,
        123
    )
})

test('4-byte UTF-8 codepoint at the boundary is dropped entirely, not split', () => {
    // '𝄞' (U+1D11E, MUSICAL SYMBOL G CLEF) encodes to 4 bytes.
    // Fill 120 ASCII bytes then append '𝄞' (would reach 124 bytes — over limit).
    const reason = 'a'.repeat(120) + '𝄞'
    assert.equal(Buffer.from(reason, 'utf-8').length, 124)
    const decoded = decodeCloseFrame(encodeCloseFrame(4003, reason))
    // The 4-byte codepoint starting at byte 120 must be dropped entirely.
    assert.equal(decoded.reason, 'a'.repeat(120))
    assert.ok(
        Buffer.from(decoded.reason, 'utf-8').length <= MAX_CLOSE_REASON_BYTES
    )
})

// ── Reserved-prefix guard (structural) ───────────────────────────────────────
// Room.bind() throws for any topic starting with '__' (RESERVED_TOPIC_PREFIX).
// Validate this invariant holds for CLOSE_CONTROL_TOPIC without needing a
// full framework startup.

test('CLOSE_CONTROL_TOPIC is rejected by the __ prefix guard logic', () => {
    const RESERVED = '__'
    assert.ok(
        CLOSE_CONTROL_TOPIC.startsWith(RESERVED),
        `"${CLOSE_CONTROL_TOPIC}" must start with "${RESERVED}" so Room.bind() rejects it`
    )
})
