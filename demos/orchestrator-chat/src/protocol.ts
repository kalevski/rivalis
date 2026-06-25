// Shared wire types for the orchestrator chat demo.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array => encoder.encode(JSON.stringify(value))
export const decode = <T>(payload: Uint8Array): T => JSON.parse(decoder.decode(payload)) as T

// Room-definition key; every room instance is this type, keyed by its room name.
export const ROOM_TYPE = 'chatroom'

export const NAME_PATTERN = /^[A-Za-z0-9_-]{1,20}$/
export const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export type Ticket = { name: string; room: string }

// The ticket is "<name>|<room>"; `|` is excluded from both patterns.
export const buildTicket = (name: string, room: string): string => `${name}|${room}`

export const parseTicket = (ticket: string): Ticket | null => {
    const sep = ticket.indexOf('|')
    if (sep === -1) return null
    const name = ticket.slice(0, sep)
    const room = ticket.slice(sep + 1)
    if (!NAME_PATTERN.test(name) || !ROOM_PATTERN.test(room)) return null
    return { name, room }
}

export type ChatCommand = { text: string }

export type ChatEvent = {
    from: string
    name: string
    text: string
}

export type WelcomeEvent = {
    youId: string
    room: string
    occupants: number
}

export type PresenceEvent = {
    id: string
    data: { name: string }
}
