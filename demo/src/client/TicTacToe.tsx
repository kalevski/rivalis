import { useEffect, useState } from 'react'
import {
    Avatar,
    Badge,
    Button,
    Heading,
    SectionCard,
    Tag,
    Text
} from '@toolcase/react-components'
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

const initialOf = (name: string): string => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return '?'
    return trimmed.slice(0, 2).toUpperCase()
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

    let infoNode: React.ReactNode = null
    if (state === 'rejected') {
        infoNode = null // status bar handles it
    } else if (waiting) {
        infoNode = (
            <Badge variant="secondary">Waiting for opponent… ({game.players.length}/2)</Badge>
        )
    } else if (finished) {
        if (game.winner === 'draw') {
            infoNode = <Badge variant="secondary" size="lg">Draw</Badge>
        } else {
            infoNode = <Badge variant="success" size="lg">{game.winner} wins</Badge>
        }
    } else if (yourTurn) {
        infoNode = <Badge variant="success" size="lg">Your turn</Badge>
    } else if (game.youSymbol !== null) {
        infoNode = <Badge variant="info">Waiting for {game.turn}…</Badge>
    } else {
        infoNode = <Badge variant="secondary">Spectating</Badge>
    }

    return (
        <div className="room">
            <Heading as="h1">Tic-Tac-Toe</Heading>
            <Text as="p" variant="muted">
                Two-player turn-based game. Demonstrates room capacity (maxActors=2 closes a third
                connection with room_full) and the joinable flag (room closes to new joins while a
                game is in progress).
            </Text>
            <StatusBar state={state} reason={reason} />

            <SectionCard title="Match" icon="grid-3x3">
                <div className="ttt-players">
                    {game.players.map((p) => (
                        <div className="ttt-player" key={p.id}>
                            <Avatar
                                size="small"
                                style={{ background: p.color, color: '#fff' }}
                            >
                                {initialOf(p.name)}
                            </Avatar>
                            <Text>{p.name}{p.id === game.youId ? ' (you)' : ''}</Text>
                            <Tag variant={p.symbol === 'X' ? 'primary' : 'info'}>{p.symbol}</Tag>
                        </div>
                    ))}
                </div>

                <div className="ttt-info">{infoNode}</div>

                <div className="ttt-grid">
                    {game.board.map((cell, i) => (
                        <button
                            key={i}
                            className={`ttt-cell ${cell === null ? 'empty' : `filled-${cell}`}`}
                            onClick={() => place(i)}
                            disabled={!yourTurn || cell !== null}
                            type="button"
                            aria-label={`cell ${i + 1}`}
                        >
                            {cell ?? ''}
                        </button>
                    ))}
                </div>

                {finished && (
                    <div className="ttt-actions">
                        <Button onClick={reset} variant="primary">Play again</Button>
                    </div>
                )}
            </SectionCard>
        </div>
    )
}
