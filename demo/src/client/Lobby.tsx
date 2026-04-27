import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Heading, Text } from '@toolcase/react-components'
import {
    decode,
    encode,
    type ActorIdentity,
    type LobbyChatCommand,
    type LobbyChatEvent,
    type LobbyState
} from '../protocol'
import { useRoom } from './useRoom'
import StatusBar from './StatusBar'

type Member = { id: string, name: string, color: string }

type SystemEntry = { kind: 'system', text: string, t: number }
type ChatEntry = { kind: 'chat', event: LobbyChatEvent }
type Entry = SystemEntry | ChatEntry

type Props = { identity: ActorIdentity }

const decoder = new TextDecoder()

export default function Lobby({ identity }: Props) {
    const { client, state, reason } = useRoom('lobby', identity)
    const [meId, setMeId] = useState<string>('')
    const [members, setMembers] = useState<Map<string, Member>>(new Map())
    const [entries, setEntries] = useState<Entry[]>([])
    const [draft, setDraft] = useState('')
    const logRef = useRef<HTMLUListElement | null>(null)

    useEffect(() => {
        if (!client) return

        client.on('lobby:state', (payload) => {
            const snapshot = decode<LobbyState>(payload as Uint8Array)
            setMeId(snapshot.youId)
            setEntries(snapshot.history.map((event) => ({ kind: 'chat', event })))
        }, null)

        client.on('chat', (payload) => {
            const event = decode<LobbyChatEvent>(payload as Uint8Array)
            setEntries((prev) => [...prev, { kind: 'chat', event }])
        }, null)

        client.on('__presence:join', (payload) => {
            const text = decoder.decode(payload as Uint8Array)
            const { id, data } = JSON.parse(text) as { id: string, data: ActorIdentity | null }
            if (!data) return
            setMembers((prev) => {
                const next = new Map(prev)
                next.set(id, { id, ...data })
                return next
            })
            setEntries((prev) => [...prev, { kind: 'system', text: `${data.name} joined`, t: Date.now() }])
        }, null)

        client.on('__presence:leave', (payload) => {
            const text = decoder.decode(payload as Uint8Array)
            const { id, data } = JSON.parse(text) as { id: string, data: ActorIdentity | null }
            setMembers((prev) => {
                const next = new Map(prev)
                next.delete(id)
                return next
            })
            if (data) {
                setEntries((prev) => [...prev, { kind: 'system', text: `${data.name} left`, t: Date.now() }])
            }
        }, null)
    }, [client])

    useEffect(() => {
        const log = logRef.current
        if (log) log.scrollTop = log.scrollHeight
    }, [entries])

    const send = (e: FormEvent) => {
        e.preventDefault()
        const text = draft.trim()
        if (!text || !client) return
        const cmd: LobbyChatCommand = { text }
        client.send('chat', encode(cmd))
        setDraft('')
    }

    const myMember: Member | null = members.get(meId) ?? null
    const otherMembers = [...members.values()].filter((m) => m.id !== meId)
    const memberList = myMember ? [myMember, ...otherMembers] : otherMembers

    return (
        <div className="room">
            <Heading as="h1">Lobby</Heading>
            <Text variant="muted">Open chat with auto-presence (uses <code>presence: true</code> on the server-side Room).</Text>
            <StatusBar state={state} reason={reason} />

            <div className="panel">
                <h2>Online ({members.size})</h2>
                <ul className="presence-list">
                    {memberList.map((m) => (
                        <li key={m.id} className={m.id === meId ? 'me' : ''}>
                            <span className="dot" style={{ background: m.color }} />
                            <span>{m.name}{m.id === meId ? ' (you)' : ''}</span>
                        </li>
                    ))}
                </ul>
            </div>

            <div className="panel">
                <h2>Chat</h2>
                <ul className="chat-log" ref={logRef}>
                    {entries.map((entry, i) => {
                        if (entry.kind === 'system') {
                            return <li key={i} className="system">{entry.text}</li>
                        }
                        const ev = entry.event
                        return (
                            <li key={i}>
                                <span className="name" style={{ color: ev.color }}>{ev.name}:</span>
                                <span> {ev.text}</span>
                            </li>
                        )
                    })}
                </ul>
                <form className="chat-form" onSubmit={send}>
                    <input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        maxLength={200}
                        placeholder="say something..."
                        disabled={state !== 'connected'}
                        autoComplete="off"
                    />
                    <button type="submit" className="btn" disabled={state !== 'connected' || !draft.trim()}>
                        send
                    </button>
                </form>
            </div>
        </div>
    )
}
