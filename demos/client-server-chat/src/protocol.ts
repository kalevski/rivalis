// Shared wire types for the client/server chat demo.
//
// Rivalis treats every frame payload as opaque bytes — we encode our own
// little JSON shapes here, exactly like the main `@rivalis/demo` does.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array => encoder.encode(JSON.stringify(value))
export const decode = <T>(payload: Uint8Array): T => JSON.parse(decoder.decode(payload)) as T

/** The single room every client lands in. */
export const ROOM_ID = 'chat'

/** Inbound: a client asks the server to broadcast a line of text. */
export type ChatCommand = { text: string }

/** Outbound: the server fans a chat line out to everyone in the room. */
export type ChatEvent = {
    from: string
    name: string
    text: string
}

/** Outbound: sent once to a freshly-joined client so it learns its own id. */
export type WelcomeEvent = { youId: string }

/**
 * Payload shape of the framework's `__presence:join` / `__presence:leave`
 * topics, as produced by `ChatRoom.presencePayload`.
 */
export type PresenceEvent = {
    id: string
    data: { name: string }
}
