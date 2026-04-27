import { Actor, Room } from '@rivalis/core'
import {
    encode,
    decode,
    type TttCell,
    type TttPlaceCommand,
    type TttPlayer,
    type TttState,
    type TttStatus,
    type TttOutcome
} from '../protocol'
import type { ActorData } from './AuthMiddleware'

const WIN_LINES: ReadonlyArray<readonly [number, number, number]> = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
]

/**
 * Two-player turn-based tic-tac-toe. Demonstrates capacity (`maxActors=2`)
 * and the `joinable` flag: a third connection is rejected with
 * `room_full`; while a game is in progress the room is marked
 * `joinable=false` so spectators are rejected with `room_not_joinable`.
 * On a player leaving mid-game the game is reset and the room reopens.
 */
class TttRoom extends Room<ActorData> {

    override maxActors = 2

    private board: TttCell[] = Array(9).fill(null)
    private turn: 'X' | 'O' | null = null
    private status: TttStatus = 'waiting'
    private winner: TttOutcome = null
    private players: TttPlayer[] = []

    protected override onCreate(): void {
        this.bind('place', this.onPlace)
        this.bind('reset', this.onReset)
    }

    protected override onJoin(actor: Actor<ActorData>): void {
        const data = actor.data as ActorData
        const symbol: 'X' | 'O' = this.players.length === 0 ? 'X' : 'O'
        this.players.push({ id: actor.id, name: data.name, color: data.color, symbol })

        if (this.players.length === 2) {
            this.startGame()
        }

        setImmediate(() => this.sendStateTo(actor))
        setImmediate(() => this.broadcastState())
    }

    protected override onLeave(actor: Actor<ActorData>): void {
        this.players = this.players.filter((p) => p.id !== actor.id)
        // Any leave aborts the game so the room can accept new players.
        this.resetBoard()
        this.status = 'waiting'
        this.turn = null
        this.winner = null
        this.joinable = true
        this.broadcastState()
    }

    private onPlace(actor: Actor<ActorData>, payload: Uint8Array): void {
        if (this.status !== 'playing') return
        const command = decode<TttPlaceCommand>(payload)
        const player = this.players.find((p) => p.id === actor.id)
        if (!player) return
        if (player.symbol !== this.turn) return

        const index = command.index | 0
        if (index < 0 || index >= 9) return
        if (this.board[index] !== null) return

        this.board[index] = player.symbol
        const outcome = this.evaluate()
        if (outcome !== null) {
            this.status = 'finished'
            this.winner = outcome
            this.turn = null
            this.joinable = true
        } else {
            this.turn = this.turn === 'X' ? 'O' : 'X'
        }
        this.broadcastState()
    }

    private onReset(actor: Actor<ActorData>): void {
        if (this.status !== 'finished') return
        if (!this.players.some((p) => p.id === actor.id)) return
        this.startGame()
        this.broadcastState()
    }

    private startGame(): void {
        this.resetBoard()
        this.status = 'playing'
        this.turn = 'X'
        this.winner = null
        this.joinable = false
    }

    private resetBoard(): void {
        this.board = Array(9).fill(null)
    }

    private evaluate(): TttOutcome {
        for (const [a, b, c] of WIN_LINES) {
            const v = this.board[a]
            if (v !== null && v === this.board[b] && v === this.board[c]) {
                return v
            }
        }
        return this.board.every((c) => c !== null) ? 'draw' : null
    }

    private snapshotFor(actorId: string | null): TttState {
        const me = actorId === null ? null : this.players.find((p) => p.id === actorId) ?? null
        return {
            youId: actorId ?? '',
            youSymbol: me?.symbol ?? null,
            board: this.board.slice(),
            turn: this.turn,
            status: this.status,
            winner: this.winner,
            players: this.players.slice()
        }
    }

    private sendStateTo(actor: Actor<ActorData>): void {
        actor.send('ttt:state', encode(this.snapshotFor(actor.id)))
    }

    private broadcastState(): void {
        this.each((actor) => {
            actor.send('ttt:state', encode(this.snapshotFor(actor.id)))
        })
    }

}

export default TttRoom
