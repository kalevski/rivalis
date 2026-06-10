// Wire shapes for the peer-to-peer chat demo.
//
// There are two independent channels here:
//
//   1. SIGNALLING — peer <-> Rivalis server. Used only for discovery: a peer
//      announces its direct-link address and learns about the others. These
//      frames ride Rivalis' opaque-bytes transport, so we JSON-encode them
//      exactly like the other demos.
//
//   2. MESH LINK — peer <-> peer, over a plain WebSocket the peers open
//      directly between themselves. This is where the actual chat flows; it
//      never touches the Rivalis server. These messages are sent as JSON text
//      frames (see `peer/Mesh.ts`).

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array => encoder.encode(JSON.stringify(value))
export const decode = <T>(payload: Uint8Array): T => JSON.parse(decoder.decode(payload)) as T

// ---------------------------------------------------------------------------
// Signalling channel (Rivalis frames)
// ---------------------------------------------------------------------------

/** Everything one peer needs to dial another directly. */
export type PeerInfo = {
    id: string
    name: string
    host: string
    port: number
}

/** Server -> newcomer, once, so it learns its own signalling id. */
export type WelcomeEvent = { youId: string }

/** Peer -> server: "here is the address other peers should dial me on". */
export type AnnounceCommand = { host: string, port: number }

/** Server -> newcomer: every peer already registered in the mesh. */
export type RosterEvent = { peers: PeerInfo[] }

/** Server -> everyone else: a peer left the mesh. (`peer:join` carries `PeerInfo`.) */
export type PeerLeaveEvent = { id: string }

/** Signalling topic names shared by the server and the peer client. */
export const TOPIC = {
    ANNOUNCE: 'announce',
    WELCOME: 'welcome',
    ROSTER: 'roster',
    PEER_JOIN: 'peer:join',
    PEER_LEAVE: 'peer:leave'
} as const

// ---------------------------------------------------------------------------
// Mesh-link channel (direct peer-to-peer WebSocket)
// ---------------------------------------------------------------------------

/** First frame on a direct link: the dialer identifies itself. */
export type MeshHello = { kind: 'hello', peerId: string, name: string }

/** A chat line, sent directly to a connected peer. */
export type MeshChat = { kind: 'chat', text: string }

export type MeshMessage = MeshHello | MeshChat
