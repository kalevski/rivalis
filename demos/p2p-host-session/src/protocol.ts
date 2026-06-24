const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array =>
    encoder.encode(JSON.stringify(value))

export const decode = <T>(payload: Uint8Array): T =>
    JSON.parse(decoder.decode(payload)) as T

export const TOPIC = {
    INPUT: 'world:input',
    SNAPSHOT: 'world:snapshot',
    PEER_JOIN: 'world:peer_join',
    PEER_LEAVE: 'world:peer_leave',
    // Sent by the host just before shutdown so peers get a clean reason, not only a kick code.
    SESSION_END: 'world:session_end',
} as const

export type InputPayload = { action: 'up' | 'down' }

export type SnapshotPayload = {
    tick: number
    peers: Array<{ id: string; name: string; score: number }>
}

export type PeerJoinPayload  = { id: string; name: string }
export type PeerLeavePayload = { id: string; name: string }
export type SessionEndPayload = { reason: string }
