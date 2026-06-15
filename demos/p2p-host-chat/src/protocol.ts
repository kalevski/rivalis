const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array =>
    encoder.encode(JSON.stringify(value))

export const decode = <T>(payload: Uint8Array): T =>
    JSON.parse(decoder.decode(payload)) as T

export const TOPIC = {
    /** Peer → host: send a chat line. Payload: `{ text }` */
    MESSAGE: 'chat:message',
    /** Host → peer: broadcast a chat line with sender name. Payload: `{ name, text }` */
    BROADCAST: 'chat:broadcast',
    /** Host → newcomer: list of already-connected peer names. Payload: `{ peers }` */
    ROSTER: 'chat:roster',
    /** Host → all existing peers: someone joined. Payload: `{ name }` */
    JOIN: 'chat:join',
    /** Host → all remaining peers: someone left. Payload: `{ name }` */
    LEAVE: 'chat:leave',
} as const

export type ChatMessage   = { text: string }
export type ChatBroadcast = { name: string; text: string }
export type ChatRoster    = { peers: string[] }
export type ChatJoin      = { name: string }
export type ChatLeave     = { name: string }
