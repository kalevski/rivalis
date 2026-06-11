/**
 * Round-trip tests for @rivalis/signal wire codec (p2p.md §4.3, §3.5, §10).
 *
 * Verifies that every signal message type encodes and decodes correctly,
 * including edge cases (null hostId in welcome, decodeRelayTo cross-type
 * extraction, WireVersionError on major mismatch).
 * Imported from the built lib so the lazy loader path is exercised.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    SIGNAL_WIRE_MAJOR,
    WireVersionError,
    encodeWelcome,
    decodeWelcome,
    encodeOffer,
    decodeOffer,
    encodeAnswer,
    decodeAnswer,
    encodeIceCandidate,
    decodeIceCandidate,
    decodeRelayTo,
    encodeHostState,
    decodeHostState,
} from '../lib/main.js'

// ── Version header ────────────────────────────────────────────────────────────

test('encoded frames carry the signal wire major as byte 0', () => {
    const frame = encodeOffer({ to: 'peer-1', sdp: 'v=0' })
    assert.equal(frame[0], SIGNAL_WIRE_MAJOR, 'byte 0 is the major')
    assert.equal(frame[1], 0, 'byte 1 is the minor (0)')
    assert.ok(frame.length > 2, 'frame has a protobuf body after the header')
})

// ── signal:welcome ────────────────────────────────────────────────────────────

test('welcome round-trips with a known hostId', () => {
    const input = { youId: 'peer-1', hostId: 'host-1', iceServers: '[]' }
    const decoded = decodeWelcome(encodeWelcome(input))
    assert.equal(decoded.youId, 'peer-1')
    assert.equal(decoded.hostId, 'host-1')
    assert.equal(decoded.iceServers, '[]')
})

test('welcome round-trips with null hostId (no host assigned yet)', () => {
    // hostId === null means the joining peer is the first in the room.
    const input = { youId: 'first-peer', hostId: null, iceServers: '[]' }
    const decoded = decodeWelcome(encodeWelcome(input))
    assert.equal(decoded.youId, 'first-peer')
    assert.equal(decoded.hostId, null, 'null hostId survives the round-trip')
    assert.equal(decoded.iceServers, '[]')
})

test('welcome preserves iceServers JSON payload', () => {
    const servers = JSON.stringify([
        { urls: 'stun:stun.example.com:3478' },
        { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' },
    ])
    const decoded = decodeWelcome(encodeWelcome({ youId: 'p', hostId: 'h', iceServers: servers }))
    assert.equal(decoded.iceServers, servers)
})

// ── signal:offer ──────────────────────────────────────────────────────────────

test('offer round-trips', () => {
    const input = { to: 'peer-2', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' }
    const decoded = decodeOffer(encodeOffer(input))
    assert.equal(decoded.to, 'peer-2')
    assert.equal(decoded.sdp, input.sdp)
})

// ── signal:answer ─────────────────────────────────────────────────────────────

test('answer round-trips', () => {
    const input = { to: 'peer-1', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' }
    const decoded = decodeAnswer(encodeAnswer(input))
    assert.equal(decoded.to, 'peer-1')
    assert.equal(decoded.sdp, input.sdp)
})

// ── signal:ice ────────────────────────────────────────────────────────────────

test('ice-candidate round-trips', () => {
    const candidate = JSON.stringify({
        candidate: 'candidate:1 1 UDP 2122252543 192.168.1.2 54321 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
    })
    const input = { to: 'peer-2', candidate }
    const decoded = decodeIceCandidate(encodeIceCandidate(input))
    assert.equal(decoded.to, 'peer-2')
    assert.equal(decoded.candidate, candidate)
})

// ── decodeRelayTo ─────────────────────────────────────────────────────────────
// All relay message types (offer, answer, ice-candidate) have 'to' as their
// first field (tag 1). decodeRelayTo extracts that field from any relay frame.

test('decodeRelayTo extracts the to field from an offer frame', () => {
    const frame = encodeOffer({ to: 'target-peer', sdp: 'v=0' })
    assert.equal(decodeRelayTo(frame), 'target-peer')
})

test('decodeRelayTo extracts the to field from an answer frame', () => {
    const frame = encodeAnswer({ to: 'answering-peer', sdp: 'v=0' })
    assert.equal(decodeRelayTo(frame), 'answering-peer')
})

test('decodeRelayTo extracts the to field from an ice-candidate frame', () => {
    const frame = encodeIceCandidate({ to: 'ice-target', candidate: '{}' })
    assert.equal(decodeRelayTo(frame), 'ice-target')
})

// ── WireVersionError ──────────────────────────────────────────────────────────

// ── signal:host_state ─────────────────────────────────────────────────────────

test('HostState round-trips arbitrary bytes', () => {
    const state = new Uint8Array([1, 2, 3, 4, 5])
    const decoded = decodeHostState(encodeHostState({ state }))
    assert.ok(decoded !== null, 'decodeHostState must return non-null for a valid frame')
    assert.deepEqual(decoded.state, state)
})

test('decodeHostState returns null for a frame with no state field', () => {
    // Encode an empty HostState (no state field set) — present() will be false.
    // The simplest way is to encode HostElected (which has no bytes field) and
    // try to decode it as HostState, but the major/type headers differ.
    // Instead: encode a HostState with a zero-length bytes — protobuf optional
    // bytes with length 0 is wire-absent, so present() returns false.
    // We verify by building a minimal frame with just the 2-byte header.
    const minimalFrame = new Uint8Array([SIGNAL_WIRE_MAJOR, 0])
    const decoded = decodeHostState(minimalFrame)
    assert.strictEqual(decoded, null, 'decodeHostState must return null when state field is absent')
})

// ── WireVersionError ──────────────────────────────────────────────────────────

test('decoding a frame with a wrong major throws WireVersionError', () => {
    const frame = encodeOffer({ to: 'x', sdp: 'v=0' })
    const tampered = Uint8Array.from(frame)
    tampered[0] = 99 // wrong major
    assert.throws(
        () => decodeOffer(tampered),
        (e: unknown) =>
            e instanceof WireVersionError &&
            e.theirVersion === 99 &&
            e.ourVersion === SIGNAL_WIRE_MAJOR
    )
})

test('WireVersionError is thrown for legacy JSON frames (first byte = 123)', () => {
    const jsonFrame = Buffer.from(JSON.stringify({ to: 'x', sdp: 'v=0' }))
    assert.throws(
        () => decodeOffer(jsonFrame),
        (e: unknown) => e instanceof WireVersionError && e.theirVersion === 123
    )
})
