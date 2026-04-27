export const ROOMS = ['lobby', 'counter', 'ttt'] as const
export type RoomId = (typeof ROOMS)[number]

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array => encoder.encode(JSON.stringify(value))
export const decode = <T>(payload: Uint8Array): T => JSON.parse(decoder.decode(payload)) as T

// ---- shared identity ----------------------------------------------------

export type ActorIdentity = { name: string, color: string }

// ---- lobby --------------------------------------------------------------
// Chat-only room. Presence (join/leave) is auto-broadcast by Room when
// `presence: true` is set on the server.

export type LobbyChatCommand = { text: string }
export type LobbyChatEvent = {
    from: string
    name: string
    color: string
    text: string
    t: number
}
export type LobbyState = {
    youId: string
    history: LobbyChatEvent[]
}

// ---- counter ------------------------------------------------------------
// Server-authoritative integer. Anyone can `inc`/`dec`; everyone receives
// the new value.

export type CounterChangeCommand = { delta: number }
export type CounterStateEvent = { value: number, by: string | null }

// ---- tic-tac-toe --------------------------------------------------------
// 2-player turn-based. Capacity 2 (D2). `joinable=false` while a game is
// in progress.

export type TttCell = 'X' | 'O' | null
export type TttPlayer = { id: string, name: string, color: string, symbol: 'X' | 'O' }
export type TttStatus = 'waiting' | 'playing' | 'finished'
export type TttOutcome = 'X' | 'O' | 'draw' | null

export type TttPlaceCommand = { index: number }
export type TttResetCommand = {}

export type TttState = {
    youId: string
    youSymbol: 'X' | 'O' | null
    board: TttCell[]
    turn: 'X' | 'O' | null
    status: TttStatus
    winner: TttOutcome
    players: TttPlayer[]
}
