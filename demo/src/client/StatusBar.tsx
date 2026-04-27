import { Alert, Badge, Spinner } from '@toolcase/react-components'
import type { ConnectionState } from './useRoom'

type Props = {
    state: ConnectionState
    reason: string
}

const REASON_LABELS: Record<string, string> = {
    room_full: 'Room is full.',
    room_not_joinable: 'Room is closed to new joins right now.',
    rate_limited: 'Rate limit exceeded.',
    invalid_message: 'Invalid message sent to server.',
    room_destroyed: 'Room was destroyed.',
    server_shutdown: 'Server is shutting down.'
}

export default function StatusBar({ state, reason }: Props) {
    if (state === 'connecting') {
        return (
            <div className="status-row">
                <Badge variant="secondary">
                    <Spinner size="small" /> connecting…
                </Badge>
            </div>
        )
    }
    if (state === 'connected') {
        return (
            <div className="status-row">
                <Badge variant="success" pill>connected</Badge>
            </div>
        )
    }
    const label = REASON_LABELS[reason] ?? reason ?? ''
    if (state === 'rejected') {
        return (
            <Alert variant="danger" icon="exclamation-octagon" title="Cannot join">
                {label || 'Server rejected the connection.'}
            </Alert>
        )
    }
    return (
        <Alert variant="warning" icon="plug" title="Disconnected">
            {label || 'Connection closed.'}
        </Alert>
    )
}
