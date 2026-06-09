// Shared constants for the @rivalis/p2p demo.
// The P2P demo runs a @rivalis/signal signaling server and a game host
// (Rivalis + RTCTransport + TttRoom) in one process. The browser client
// uses RTCClient pointed at the signal server — an identical ticket format
// to the WS demo so existing game components need no changes.

/** Port the @rivalis/signal server listens on (separate from the WS server at 2334). */
export const SIGNAL_PORT = 9000

/**
 * Signal-room ID for the ttt P2P session. The host and peers both join this
 * room on the signal server to negotiate WebRTC data channels.
 */
export const SIGNAL_ROOM_ID = 'ttt'

/**
 * Ticket the game host sends to @rivalis/signal when it registers as the
 * host of the ttt signal room.
 *
 * The DemoP2PSignalAuth (index.ts) accepts game-ticket format
 * (`<roomId>|<name>|<color>`) for both host and peer connections, so the
 * same auth code path serves both sides. The host uses a well-known
 * placeholder name so it is identifiable in logs.
 *
 * Never send browser-client-facing peers a token that can be mistaken for
 * the host — in production, use a distinct secret-keyed host ticket and a
 * stricter signal auth strategy.
 */
export const HOST_SIGNAL_TICKET = `${SIGNAL_ROOM_ID}|host|#000000`
