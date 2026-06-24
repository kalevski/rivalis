/**
 * Transport-agnostic close/kick control frame (p2p.md §3.4).
 *
 * WebSocket transports express kick/close via a numeric close code + UTF-8
 * reason. RTCDataChannel.close() carries nothing. This module defines a
 * first-class, transport-neutral convention so CloseCode semantics survive
 * over any transport:
 *
 *   1. The server sends a regular handshake frame on __rivalis:close carrying
 *      an encoded { code, reason } payload immediately before closing the
 *      underlying connection or channel.
 *   2. The client decodes it to client:kicked { code, reason } — the same
 *      event WS clients emit from the native close code — so the reconnect
 *      gate (NO_RECONNECT_CODES) works identically across transports.
 *   3. WSTransport keeps using native close frames; no observable change to
 *      existing WS clients (they receive the close code out-of-band, not via
 *      this frame).
 *
 * The __rivalis:close topic carries the `__` reserved prefix, so user code
 * cannot bind it — Room.bind() throws on any topic starting with `__`
 * (RESERVED_TOPIC_PREFIX guard, Room.ts).
 *
 * The reason string is capped at MAX_CLOSE_REASON_BYTES (123) to match the
 * WebSocket control-frame limit (RFC 6455 §5.5), keeping close-frame
 * behaviour identical regardless of transport.
 */

import { Serializer } from './wire/serializer'

/**
 * The handshake topic reserved for transport-agnostic close/kick frames.
 * Begins with `__` so Room.bind() rejects any user attempt to collide with it.
 */
export const CLOSE_CONTROL_TOPIC = '__rivalis:close'

/**
 * Maximum UTF-8-encoded byte length for the reason field — matches RFC 6455
 * §5.5's 123-byte cap on WebSocket close-frame reason strings. Enforced in
 * encodeCloseFrame so WS and RTC close behaviour are identical.
 */
export const MAX_CLOSE_REASON_BYTES = 123

export type CloseFrame = {
    /** Numeric close code — one of the CloseCode constants (4001–4005). */
    code: number
    /** Human-readable reason string, at most MAX_CLOSE_REASON_BYTES when UTF-8 encoded. */
    reason: string
}

// ── Serializer ───────────────────────────────────────────────────────────────

const CLOSE_FRAME_MODEL = 'rivalis_close_frame'
let serializer: Serializer | null = null

function getSerializer(): Serializer {
    if (serializer !== null) return serializer
    const s = new Serializer('@rivalis/close-frame')
    // APPEND-ONLY: tag 1 = code, tag 2 = reason — never reorder or remove.
    s.define(CLOSE_FRAME_MODEL, [
        { key: 'code', type: 'uint32', rule: 'required' },
        { key: 'reason', type: 'string', rule: 'required' },
    ])
    serializer = s
    return s
}

// ── UTF-8 boundary-safe truncation ───────────────────────────────────────────

/**
 * Truncate a UTF-8 string so its encoded form fits in at most maxBytes,
 * stopping at a valid codepoint boundary. Returns the original string when
 * it already fits. Uses a forward walk so a complete multi-byte sequence that
 * lands exactly at the byte limit is included, not dropped.
 */
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

function truncateUtf8(s: string, maxBytes: number): string {
    const buf = utf8Encoder.encode(s)
    if (buf.length <= maxBytes) return s
    let i = 0
    while (i < maxBytes) {
        const b = buf[i]!
        // Determine the byte length of the codepoint that starts at i.
        let seqLen: number
        if ((b & 0x80) === 0) seqLen = 1         // 0xxxxxxx — ASCII
        else if ((b & 0xe0) === 0xc0) seqLen = 2  // 110xxxxx — 2-byte
        else if ((b & 0xf0) === 0xe0) seqLen = 3  // 1110xxxx — 3-byte
        else if ((b & 0xf8) === 0xf0) seqLen = 4  // 11110xxx — 4-byte
        else { i++; continue }                    // stray continuation — skip
        if (i + seqLen > maxBytes) break           // this codepoint would overflow
        i += seqLen
    }
    return utf8Decoder.decode(buf.subarray(0, i))
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Encode a close frame payload for transmission on the __rivalis:close topic.
 * The reason string is truncated at MAX_CLOSE_REASON_BYTES (123 UTF-8 bytes)
 * before encoding.
 */
export const encodeCloseFrame = (code: number, reason: string): Uint8Array => {
    const truncated = truncateUtf8(reason, MAX_CLOSE_REASON_BYTES)
    return getSerializer().encode(CLOSE_FRAME_MODEL, { code, reason: truncated }) as Uint8Array<ArrayBuffer>
}

/**
 * Decode a close frame payload received on the __rivalis:close topic.
 */
export const decodeCloseFrame = (buffer: Uint8Array): CloseFrame => {
    return getSerializer().decode(CLOSE_FRAME_MODEL, buffer) as unknown as CloseFrame
}
