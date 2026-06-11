/** Port the signal server listens on (different from p2p-host-chat's 8081). */
export const SIGNAL_PORT = 8082

/** Default signal server URL peers and the host connect to. */
export const SIGNAL_URL = `ws://localhost:${SIGNAL_PORT}`

/**
 * The signal room id AND the game room id — the same string routes correctly
 * through both layers:
 *   - Signal auth extracts `roomId="world"` to place the actor in the right
 *     signal room.
 *   - Game room auth extracts `roomId="world"` to join the actor to the
 *     authoritative WorldRoom that RTCTransport created on the host.
 */
export const ROOM_ID = 'world'

/**
 * Ticket the host's RTCTransport uses to connect to the signal server.
 * The name "host" is just a label; the signal server elects the first joiner
 * as the WebRTC negotiation host regardless of the name field.
 */
export const HOST_SIGNAL_TICKET = `${ROOM_ID}:host`

/** How often the host ticks and broadcasts a snapshot to all peers (ms). */
export const TICK_MS = 1000
