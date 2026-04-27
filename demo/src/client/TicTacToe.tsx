import { useEffect, useState } from 'react'
import { Heading, Text, Button } from '@toolcase/react-components'
import {
    decode,
    encode,
    type ActorIdentity,
    type TttPlaceCommand,
    type TttResetCommand,
    type TttState
} from '../protocol'
import { useRoom } from './useRoom'
import StatusBar from './StatusBar'

type Props = { identity: ActorIdentity }

const EMPTY_STATE: TttState = {
    youId: '',
    youSymbol: null,
    board: Array(9).fill(null),
    turn: null,
    status: 'waiting',
    winner: null,
    players: []
}

export default function TicTacToe({ identity }: Props) {
    const { client, state, reason } = useRoom('ttt', identity)
    const [game, setGame] = useState<TttState>(EMPTY_STATE)

    useEffect(() => {
        if (!client) return
        client.on('ttt:state', (payload) => {
            setGame(decode<TttState>(payload as Uint8Array))
        }, null)
    }, [client])

    const place = (index: number) => {
        if (!client || state !== 'connected') return
        if (game.status !== 'playing') return
        if (game.youSymbol !== game.turn) return
        if (game.board[index] !== null) return
        const cmd: TttPlaceCommand = { index }
        client.send('place', encode(cmd))
    }

    const reset = () => {
        if (!client || state !== 'connected') return
        if (game.status !== 'finished') return
        const cmd: TttResetCommand = {}
        client.send('reset', encode(cmd))
    }

    const yourTurn = game.status === 'playing' && game.turn === game.youSymbol
    const finished = game.status === 'finished'
    const waiting = game.status === 'waiting'

    let info = ''
    let infoCls = ''
    if (state === 'rejected' && reason === 'room_full') {
        info = 'room is full (already 2 players)'
    } else if (state === 'rejected' && reason === 'room_not_joinable') {
        info = 'a game is already in progress — try again later'
    } else if (waiting) {
        info = `waiting for opponent... (${game.players.length}/2)`
    } else if (finished) {
        if (game.winner === 'draw') info = 'draw'
        else info = `${game.winner} wins`
        infoCls = 'winner'
    } else if (yourTurn) {
        info = 'your turn'
        infoCls = 'your-turn'
    } else if (game.youSymbol !== null) {
        info = `waiting for ${game.turn}...`
    } else {
        info = 'spectating'
    }

    return (
        <div className="room">
            <Heading as="h1">Tic-Tac-Toe</Heading>
            <Text variant="muted">2-player turn-based game. Demonstrates room capacity (<code>maxActors=2</code>, third connection closes with <code>room_full</code>) and the <code>joinable</code> flag (room closes to new joins while a game is in progress).</Text>
            <StatusBar state={state} reason={reason} />

            <div className="panel">
                <div className="ttt-players">
                    {game.players.map((p) => (
                        <div className="ttt-player" key={p.id}>
                            <span className="dot" style={{ background: p.color }} />
                            <span>{p.name}{p.id === game.youId ? ' (you)' : ''}</span>
                            <span className="symbol">[{p.symbol}]</span>
                        </div>
                    ))}
                </div>

                <div className={`ttt-info ${infoCls}`}>{info}</div>

                <div className="ttt-grid">
                    {game.board.map((cell, i) => (
                        <button
                            key={i}
                            className={`ttt-cell ${cell === null ? 'empty' : ''}`}
                            onClick={() => place(i)}
                            disabled={!yourTurn || cell !== null}
                        >
                            {cell ?? ''}
                        </button>
                    ))}
                </div>

                {finished && (
                    <div className="row" style={{ justifyContent: 'center' }}>
                        <Button onClick={reset} variant="primary">play again</Button>
                    </div>
                )}
            </div>
        </div>
    )
}
