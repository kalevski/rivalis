export const WORLD = { width: 800, height: 600 } as const

export type Player = {
    id: string
    name: string
    color: string
    x: number
    y: number
}

export type StateSnapshot = {
    youId: string
    players: Player[]
}

export type MoveCommand = { x: number, y: number }
export type ChatCommand = { text: string }

export type PlayerJoinEvent = Player
export type PlayerLeaveEvent = { id: string }
export type PlayerMoveEvent = { id: string, x: number, y: number }
export type ChatEvent = { from: string, name: string, color: string, text: string, t: number }

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array => encoder.encode(JSON.stringify(value))
export const decode = <T>(payload: Uint8Array): T => JSON.parse(decoder.decode(payload)) as T
