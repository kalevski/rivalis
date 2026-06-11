/** Port the signal server listens on. */
export const SIGNAL_PORT = 8081

/** Default signal server URL peers and the host connect to. */
export const SIGNAL_URL = `ws://localhost:${SIGNAL_PORT}`

/**
 * The signal room id AND the game room id — both use the same string so the
 * peer's single ticket `"chat:<name>"` routes correctly through both layers:
 *   - Signal auth extracts `roomId="chat"` to place the peer in the right
 *     signal room.
 *   - Game room auth extracts `roomId="chat"` to join the actor to the right
 *     game room that RTCTransport created on the host.
 */
export const ROOM_ID = 'chat'

/**
 * Ticket the host's RTCTransport uses to connect to the signal server.
 * Format: `<roomId>:<name>`. The name "host" is just a label; the signal
 * server does not distinguish it from peer names — position (first joiner)
 * is what makes it the WebRTC negotiation host.
 */
export const HOST_SIGNAL_TICKET = `${ROOM_ID}:host`
