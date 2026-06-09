/**
 * Signal wire codec — typed binary frames for the @rivalis/signal protocol.
 *
 * Built over the shared toolkit from @rivalis/handshake (p2p.md §3.5, §4.3).
 * Schema definitions only — ~80 lines vs fleet's 417-line standalone codec.
 *
 * ── APPEND-ONLY TAG RULE ────────────────────────────────────────────────────
 * Field order within each message type is the on-wire tag. Never reorder or
 * remove fields; only append. A breaking layout change requires bumping
 * SIGNAL_WIRE_MAJOR so mismatched peers fail loudly (WireVersionError).
 */

import { createCodec, present, FieldType } from '@rivalis/handshake'

export { WireVersionError } from '@rivalis/handshake'

/** Signal protocol major — bump on any breaking schema change. */
export const SIGNAL_WIRE_MAJOR = 1

const F = FieldType

// ── Schema (APPEND ONLY) ──────────────────────────────────────────────────────

const codec = createCodec({
    namespace: '@rivalis/signal',
    major: SIGNAL_WIRE_MAJOR,
    schema: {
        Welcome: [
            { key: 'youId', type: F.STRING, rule: 'optional' },
            { key: 'hostId', type: F.STRING, rule: 'optional' },
            { key: 'iceServers', type: F.STRING, rule: 'optional' }, // JSON RTCIceServer[]
        ],
        Offer: [
            { key: 'to', type: F.STRING, rule: 'optional' },
            { key: 'sdp', type: F.STRING, rule: 'optional' },
        ],
        Answer: [
            { key: 'to', type: F.STRING, rule: 'optional' },
            { key: 'sdp', type: F.STRING, rule: 'optional' },
        ],
        IceCandidate: [
            { key: 'to', type: F.STRING, rule: 'optional' },
            { key: 'candidate', type: F.STRING, rule: 'optional' }, // JSON RTCIceCandidateInit
        ],
    }
})

// ── Payload types ─────────────────────────────────────────────────────────────

export type WelcomePayload = {
    youId: string
    hostId: string | null  // null = no host yet
    iceServers: string     // JSON-encoded RTCIceServer[]
}

export type OfferPayload = { to: string; sdp: string }
export type AnswerPayload = { to: string; sdp: string }
export type IceCandidatePayload = { to: string; candidate: string }

// ── Encode / decode ───────────────────────────────────────────────────────────

export function encodeWelcome(p: WelcomePayload): Uint8Array {
    const msg: Record<string, unknown> = { youId: p.youId, iceServers: p.iceServers }
    if (p.hostId !== null) msg.hostId = p.hostId
    return codec.encode('Welcome', msg)
}

export function decodeWelcome(frame: Uint8Array): WelcomePayload {
    const m = codec.decode('Welcome', frame)
    return {
        youId: m.youId ?? '',
        hostId: present(m, 'hostId') ? String(m.hostId) : null,
        iceServers: m.iceServers ?? '[]',
    }
}

export function encodeOffer(p: OfferPayload): Uint8Array {
    return codec.encode('Offer', { to: p.to, sdp: p.sdp })
}

export function decodeOffer(frame: Uint8Array): OfferPayload {
    const m = codec.decode('Offer', frame)
    return { to: m.to ?? '', sdp: m.sdp ?? '' }
}

export function encodeAnswer(p: AnswerPayload): Uint8Array {
    return codec.encode('Answer', { to: p.to, sdp: p.sdp })
}

export function decodeAnswer(frame: Uint8Array): AnswerPayload {
    const m = codec.decode('Answer', frame)
    return { to: m.to ?? '', sdp: m.sdp ?? '' }
}

export function encodeIceCandidate(p: IceCandidatePayload): Uint8Array {
    return codec.encode('IceCandidate', { to: p.to, candidate: p.candidate })
}

export function decodeIceCandidate(frame: Uint8Array): IceCandidatePayload {
    const m = codec.decode('IceCandidate', frame)
    return { to: m.to ?? '', candidate: m.candidate ?? '' }
}

/**
 * Extract the relay target ('to') from any offer/answer/ice-candidate frame.
 * All relay message types have 'to' as field 1 (tag 1), so the Offer schema
 * correctly decodes the first field from any of them.
 * Used by SignalRoom.relay to look up the target actor without per-type dispatch.
 */
export function decodeRelayTo(frame: Uint8Array): string {
    const m = codec.decode('Offer', frame)
    return m.to ?? ''
}
