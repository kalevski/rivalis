import { useEffect, useState } from 'react'
import { WSClient } from '@rivalis/browser'
import type { Client } from '@rivalis/core'
import type { ActorIdentity, RoomId } from '../protocol'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'rejected'

const decoder = new TextDecoder()

export type RoomConnection = {
    client: Client | null
    state: ConnectionState
    reason: string
}

const PERSISTENT_REJECTIONS = new Set(['room_full', 'room_not_joinable'])

/**
 * Connects to a room over WS. Disconnects + reconnects on `roomId` /
 * identity change. Returns the live client (null until connected) and
 * connection state. Components attach their own topic listeners via the
 * client handle inside their own `useEffect`s.
 */
export function useRoom(roomId: RoomId, identity: ActorIdentity): RoomConnection {
    const [client, setClient] = useState<Client | null>(null)
    const [state, setState] = useState<ConnectionState>('connecting')
    const [reason, setReason] = useState<string>('')

    useEffect(() => {
        const url = `ws://${location.hostname}:2334`
        const ws = new WSClient(url)
        let mounted = true

        ws.on('client:connect', () => {
            if (!mounted) return
            setState('connected')
            setReason('')
        }, null)

        ws.on('client:disconnect', (payload) => {
            if (!mounted) return
            const r = decoder.decode(payload as Uint8Array)
            setReason(r)
            setState(PERSISTENT_REJECTIONS.has(r) ? 'rejected' : 'disconnected')
        }, null)

        const ticket = `${roomId}|${identity.name}|${identity.color}`
        ws.connect(ticket)
        setClient(ws)
        setState('connecting')

        return () => {
            mounted = false
            ws.disconnect()
            setClient(null)
        }
    }, [roomId, identity.name, identity.color])

    return { client, state, reason }
}
