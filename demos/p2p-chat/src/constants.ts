// Shared knobs for the peer-to-peer chat demo.

/**
 * Hard cap on the number of participants in a single mesh.
 *
 * This is the headline constraint of the demo. It is enforced by the
 * signalling room via Rivalis' own `Room.maxActors` primitive: the 11th peer
 * that tries to register is rejected by the framework with reason `room_full`
 * (see `signaling/SignalingRoom.ts`). Because every peer must register with
 * the signalling server to discover the mesh, capping signalling membership
 * caps the mesh.
 */
export const MAX_PEERS = 10

/** The single rendezvous room every peer registers in. */
export const SIGNALING_ROOM_ID = 'mesh'

/** Where the signalling server listens, and where peers look for it. */
export const DEFAULT_SIGNALING_PORT = 8080
export const DEFAULT_SIGNALING_URL = `ws://localhost:${DEFAULT_SIGNALING_PORT}`

/**
 * Each peer also runs its own tiny WebSocket endpoint that other peers dial
 * directly — that direct link, not the signalling server, carries the chat.
 * For a local demo every peer advertises loopback and picks its own port.
 */
export const DEFAULT_PEER_HOST = '127.0.0.1'
export const DEFAULT_PEER_PORT = 9000
