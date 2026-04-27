import { useEffect, useState } from 'react'
import {
    Heading,
    IconButton,
    SectionCard,
    Text
} from '@toolcase/react-components'
import {
    decode,
    encode,
    type ActorIdentity,
    type CounterChangeCommand,
    type CounterStateEvent
} from '../protocol'
import { useRoom } from './useRoom'
import StatusBar from './StatusBar'

type Props = { identity: ActorIdentity }

export default function Counter({ identity }: Props) {
    const { client, state, reason } = useRoom('counter', identity)
    const [value, setValue] = useState(0)
    const [by, setBy] = useState<string | null>(null)

    useEffect(() => {
        if (!client) return
        client.on('counter:state', (payload) => {
            const event = decode<CounterStateEvent>(payload as Uint8Array)
            setValue(event.value)
            setBy(event.by)
        }, null)
    }, [client])

    const change = (delta: 1 | -1) => {
        if (!client || state !== 'connected') return
        const cmd: CounterChangeCommand = { delta }
        client.send('change', encode(cmd))
    }

    const disabled = state !== 'connected'

    return (
        <div className="room">
            <Heading as="h1">Counter</Heading>
            <Text as="p" variant="muted">
                Server-authoritative shared integer. Anyone can increment or decrement;
                the server broadcasts the new value with the actor that caused the change.
            </Text>
            <StatusBar state={state} reason={reason} />

            <SectionCard title="Shared counter" icon="hash">
                <div className="counter-display">{value}</div>
                <div className="counter-by">
                    <Text as="span" variant="muted">
                        {by ? `Last change by ${by}` : ' '}
                    </Text>
                </div>
                <div className="counter-buttons">
                    <IconButton
                        icon="dash-lg"
                        size="large"
                        variant="secondary"
                        outline
                        label="Decrement"
                        onClick={() => change(-1)}
                        disabled={disabled}
                    />
                    <IconButton
                        icon="plus-lg"
                        size="large"
                        variant="primary"
                        label="Increment"
                        onClick={() => change(1)}
                        disabled={disabled}
                    />
                </div>
            </SectionCard>
        </div>
    )
}
