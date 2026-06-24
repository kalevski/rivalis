// Shared wire types for the client/server chat demo.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array => encoder.encode(JSON.stringify(value))
export const decode = <T>(payload: Uint8Array): T => JSON.parse(decoder.decode(payload)) as T

export const ROOM_ID = 'chat'

export type ChatCommand = { text: string }

export type ChatEvent = {
    from: string
    name: string
    text: string
}

export type WelcomeEvent = { youId: string }

export type PresenceEvent = {
    id: string
    data: { name: string }
}
