/**
 * Chunk/reassemble helpers for RTC data channel frames (p2p.md §7).
 *
 * Problem: WebRTC SCTP caps a single message at ~16 KiB cross-implementation,
 * while WSTransport defaults to 64 KiB. Without chunking, host→peer broadcasts
 * (e.g. arena snapshots) silently fail over RTC.
 *
 * Wire format of a chunk message:
 *   handshake.encode('__rivalis:chunk', [seq_hi, seq_lo, total, index, ...data])
 *
 *   seq_hi, seq_lo  — uint16 big-endian sequence number; groups chunks of one message.
 *   total           — number of chunks (1–255).
 *   index           — 0-based chunk index.
 *   data            — slice of the original handshake-encoded game frame.
 *
 * Non-chunked frames (≤ RTC_MAX_FRAME_BYTES) are sent as-is; no prefix is added
 * so existing tooling and reference-equality checks are unaffected.
 *
 * Detection: the first 17 bytes of any chunk message are always
 *   0x0A 0x0F <15 bytes of "__rivalis:chunk">
 * — the protobuf topic-field encoding. isChunkFrame() checks this prefix without
 * calling handshakeDecode(), preserving reference equality for regular frames.
 *
 * This file is structurally identical to node/src/peer/RtcFrameChunker.ts;
 * it exists as a local copy so @rivalis/browser has no dependency on @rivalis/node.
 */

import { encode as handshakeEncode, decode as handshakeDecode } from '@rivalis/handshake'

/** Reserved internal topic for chunk frames. */
export const CHUNK_CONTROL_TOPIC = '__rivalis:chunk'

/** Safe cross-implementation SCTP message ceiling (p2p.md §7). */
export const RTC_MAX_FRAME_BYTES = 16 * 1024

// Overhead budget per chunk message (conservative):
//   topic field:   0x0A (1) + length varint 0x0F (1) + 15 topic bytes = 17
//   payload field: 0x12 (1) + 2-byte varint for lengths < 16384     =  3
//   chunk header:  seq_hi + seq_lo + total + index                   =  4
//                                                               total = 24
// We reserve 32 bytes to stay safely below the ceiling in all varint cases.
const CHUNK_OVERHEAD_BYTES = 32

/** Maximum data bytes per chunk (frame data only, not the chunk envelope). */
export const CHUNK_DATA_BYTES = RTC_MAX_FRAME_BYTES - CHUNK_OVERHEAD_BYTES  // 16352

// ── Prefix detection ──────────────────────────────────────────────────────────
// Lazily-computed: first 17 bytes of encode('__rivalis:chunk', emptyPayload).
// These bytes are the protobuf topic-field encoding and are identical for every
// chunk message regardless of payload size.

let _chunkFramePrefix: Uint8Array | null = null

function getChunkFramePrefix(): Uint8Array {
    if (_chunkFramePrefix !== null) return _chunkFramePrefix
    const sample = handshakeEncode(CHUNK_CONTROL_TOPIC, new Uint8Array(0))
    _chunkFramePrefix = sample.slice(0, 17)
    return _chunkFramePrefix
}

/**
 * Returns true if `buf` is a chunk frame without calling handshakeDecode.
 * Buffers shorter than 17 bytes (too small to be chunk frames) return false.
 */
export function isChunkFrame(buf: Uint8Array): boolean {
    if (buf.byteLength < 17) return false
    const prefix = getChunkFramePrefix()
    for (let i = 0; i < 17; i++) {
        if (buf[i] !== prefix[i]) return false
    }
    return true
}

/**
 * Split `frame` (a complete handshake-encoded game frame) into chunk messages.
 * Each chunk message is ready to be sent via channel.sendBinary().
 *
 * Throws if the frame is too large for ≤255 chunks
 * (max frame ≈ 255 × CHUNK_DATA_BYTES ≈ 4.1 MiB).
 */
export function chunkFrame(frame: Uint8Array, seq: number): Uint8Array[] {
    const total = Math.ceil(frame.byteLength / CHUNK_DATA_BYTES)
    if (total > 255) {
        throw new Error(
            `rtc: frame too large to chunk: ${frame.byteLength} bytes requires ` +
            `${total} chunks (max 255 = ${255 * CHUNK_DATA_BYTES} bytes)`
        )
    }
    const seqHi = (seq >> 8) & 0xFF
    const seqLo =  seq       & 0xFF
    const chunks: Uint8Array[] = []
    for (let i = 0; i < total; i++) {
        const start   = i * CHUNK_DATA_BYTES
        const end     = Math.min(start + CHUNK_DATA_BYTES, frame.byteLength)
        const data    = frame.subarray(start, end)
        const payload = new Uint8Array(4 + data.byteLength)
        payload[0] = seqHi
        payload[1] = seqLo
        payload[2] = total
        payload[3] = i
        payload.set(data, 4)
        chunks.push(handshakeEncode(CHUNK_CONTROL_TOPIC, payload))
    }
    return chunks
}

/**
 * Decode the raw payload bytes (from handshakeDecode) of a chunk frame.
 * Returns null if the payload is malformed (< 4 bytes).
 */
export function decodeChunkPayload(
    payload: Uint8Array,
): { seq: number; total: number; index: number; data: Uint8Array } | null {
    if (payload.byteLength < 4) return null
    const seq   = (payload[0]! << 8) | payload[1]!
    const total =  payload[2]!
    const index =  payload[3]!
    const data  = payload.subarray(4)
    return { seq, total, index, data }
}

// ── ChunkReassembler ──────────────────────────────────────────────────────────

/**
 * Per-channel stateful chunk reassembler.
 *
 * Ordered channel guarantee: at most one chunked message is in flight at a time.
 * A new seq that differs from the active one resets state; any in-flight partial
 * message is silently discarded (the sender dropped the connection mid-message).
 */
export class ChunkReassembler {
    private activeSeq    = -1
    private totalChunks  = 0
    private received     = 0
    private chunks: (Uint8Array | null)[] = []

    /**
     * Feed one decoded chunk into the assembler.
     * Returns the complete reassembled frame once all chunks arrive; null otherwise.
     */
    feed(seq: number, total: number, index: number, data: Uint8Array): Uint8Array | null {
        if (seq !== this.activeSeq) {
            this.activeSeq   = seq
            this.totalChunks = total
            this.chunks      = new Array<Uint8Array | null>(total).fill(null)
            this.received    = 0
        }
        if (index >= this.totalChunks || total !== this.totalChunks) return null
        if (this.chunks[index] !== null) return null  // duplicate

        this.chunks[index] = data
        this.received++
        if (this.received < this.totalChunks) return null

        // All chunks present — concatenate into the complete frame
        let totalLen = 0
        for (const c of this.chunks) { if (c) totalLen += c.byteLength }
        const result = new Uint8Array(totalLen)
        let offset = 0
        for (const c of this.chunks) {
            if (c) { result.set(c, offset); offset += c.byteLength }
        }
        // Reset for the next message
        this.activeSeq   = -1
        this.totalChunks = 0
        this.chunks      = []
        this.received    = 0
        return result
    }

    clear(): void {
        this.activeSeq   = -1
        this.totalChunks = 0
        this.chunks      = []
        this.received    = 0
    }
}

