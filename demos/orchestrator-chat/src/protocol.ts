// Shared wire types for the orchestrator chat demo.
//
// Rivalis treats every frame payload as opaque bytes — we encode our own
// little JSON shapes here, exactly like the simple client/server chat demo.
// The difference here is the *ticket*: it carries both a display name and a
// room name, so the orchestrator can route each client into (and spin up) the
// room it asked for.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array => encoder.encode(JSON.stringify(value))
export const decode = <T>(payload: Uint8Array): T => JSON.parse(decoder.decode(payload)) as T

/**
 * Room-definition key the orchestrator registers with `rooms.define`. Every
 * room instance the orchestrator spins up is of this single type; the room's
 * *id* is the user-chosen room name.
 */
export const ROOM_TYPE = 'chatroom'

/** Allowed shapes for the two halves of a ticket. */
export const NAME_PATTERN = /^[A-Za-z0-9_-]{1,20}$/
export const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export type Ticket = { name: string; room: string }

/**
 * The connection ticket is `"<name>|<room>"` — the same `|`-delimited
 * convention the main `@rivalis/demo` uses. `|` is excluded from both
 * patterns, so the split is unambiguous.
 */
export const buildTicket = (name: string, room: string): string => `${name}|${room}`

/** Parse and validate a ticket. Returns `null` for anything malformed. */
export const parseTicket = (ticket: string): Ticket | null => {
    const sep = ticket.indexOf('|')
    if (sep === -1) return null
    const name = ticket.slice(0, sep)
    const room = ticket.slice(sep + 1)
    if (!NAME_PATTERN.test(name) || !ROOM_PATTERN.test(room)) return null
    return { name, room }
}

/** Inbound: a client asks its room to broadcast a line of text. */
export type ChatCommand = { text: string }

/** Outbound: a room fans a chat line out to everyone *in that room*. */
export type ChatEvent = {
    from: string
    name: string
    text: string
}

/**
 * Outbound: sent once to a freshly-joined client so it learns its own id and
 * confirms which room the orchestrator routed it into.
 */
export type WelcomeEvent = {
    youId: string
    room: string
    occupants: number
}

/**
 * Payload shape of the framework's `__presence:join` / `__presence:leave`
 * topics, as produced by `ChatRoom.presencePayload`.
 */
export type PresenceEvent = {
    id: string
    data: { name: string }
}
