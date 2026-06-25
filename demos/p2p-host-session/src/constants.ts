export const SIGNAL_PORT = 8082

export const SIGNAL_URL = `ws://localhost:${SIGNAL_PORT}`

// Used as both the signal room id and the game room id.
export const ROOM_ID = 'world'

// Separator is "." not ":" because the ticket is sent as a WebSocket subprotocol, which forbids ":".
export const HOST_SIGNAL_TICKET = `${ROOM_ID}.host`

export const TICK_MS = 1000
