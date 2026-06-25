// Wire shapes for the peer-to-peer chat demo.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array => encoder.encode(JSON.stringify(value))
export const decode = <T>(payload: Uint8Array): T => JSON.parse(decoder.decode(payload)) as T

// Signalling channel (Rivalis frames)

export type PeerInfo = {
    id: string
    name: string
    host: string
    port: number
}

export type WelcomeEvent = { youId: string }

export type AnnounceCommand = { host: string, port: number }

export type RosterEvent = { peers: PeerInfo[] }

export type PeerLeaveEvent = { id: string }

export const TOPIC = {
    ANNOUNCE: 'announce',
    WELCOME: 'welcome',
    ROSTER: 'roster',
    PEER_JOIN: 'peer:join',
    PEER_LEAVE: 'peer:leave'
} as const

// Mesh-link channel (direct peer-to-peer WebSocket)

export type MeshHello = { kind: 'hello', peerId: string, name: string }

export type MeshChat = { kind: 'chat', text: string }

export type MeshMessage = MeshHello | MeshChat
