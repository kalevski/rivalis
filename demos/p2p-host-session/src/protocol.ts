const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array =>
    encoder.encode(JSON.stringify(value))

export const decode = <T>(payload: Uint8Array): T =>
    JSON.parse(decoder.decode(payload)) as T

export const TOPIC = {
    /** Peer → host: a game input command. Payload: `InputPayload` */
    INPUT: 'world:input',
    /** Host → all peers: full authoritative snapshot after each tick. Payload: `SnapshotPayload` */
    SNAPSHOT: 'world:snapshot',
    /** Host → all: a peer joined the session. Payload: `PeerJoinPayload` */
    PEER_JOIN: 'world:peer_join',
    /** Host → all: a peer left the session. Payload: `PeerLeavePayload` */
    PEER_LEAVE: 'world:peer_leave',
    /**
     * Host → all: the host is shutting down the session.
     * Sent by the host immediately before `rivalis.shutdown()` so peers
     * receive a clean reason string rather than only a generic kick code.
     * Payload: `SessionEndPayload`
     */
    SESSION_END: 'world:session_end',
} as const

/** Input a peer can send to mutate their own score. */
export type InputPayload = { action: 'up' | 'down' }

/** Complete authoritative snapshot broadcast every tick. */
export type SnapshotPayload = {
    /** Monotonically increasing tick counter maintained by the host. */
    tick: number
    /** All currently connected peers with their authoritative scores. */
    peers: Array<{ id: string; name: string; score: number }>
}

export type PeerJoinPayload  = { id: string; name: string }
export type PeerLeavePayload = { id: string; name: string }
export type SessionEndPayload = { reason: string }
