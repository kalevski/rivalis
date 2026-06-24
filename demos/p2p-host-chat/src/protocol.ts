const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array =>
    encoder.encode(JSON.stringify(value))

export const decode = <T>(payload: Uint8Array): T =>
    JSON.parse(decoder.decode(payload)) as T

export const TOPIC = {
    MESSAGE: 'chat:message',
    BROADCAST: 'chat:broadcast',
    ROSTER: 'chat:roster',
    JOIN: 'chat:join',
    LEAVE: 'chat:leave',
} as const

export type ChatMessage   = { text: string }
export type ChatBroadcast = { name: string; text: string }
export type ChatRoster    = { peers: string[] }
export type ChatJoin      = { name: string }
export type ChatLeave     = { name: string }
