// Shared knobs for the peer-to-peer chat demo.

// Enforced by the signalling room via Rivalis' `Room.maxActors`: the 11th peer is rejected with `room_full`.
export const MAX_PEERS = 10

export const SIGNALING_ROOM_ID = 'mesh'

export const DEFAULT_SIGNALING_PORT = 8080
export const DEFAULT_SIGNALING_URL = `ws://localhost:${DEFAULT_SIGNALING_PORT}`

export const DEFAULT_PEER_HOST = '127.0.0.1'
export const DEFAULT_PEER_PORT = 9000
