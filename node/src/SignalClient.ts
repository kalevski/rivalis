/**
 * SignalClient — a Client<SignalTopic> for @rivalis/signal (p2p.md §4.2/§4.4).
 *
 * Wraps the node WSClient configured with ticketSource:'protocol' — the
 * @rivalis/signal server reads the auth ticket from Sec-WebSocket-Protocol,
 * keeping it out of URLs, access logs, and browser history.
 *
 * Reconnect is not built in: it is layered by RTCTransport/RTCClient, which own
 * the SignalClient, observe client:disconnect, and call connect() again with a
 * refreshed ticket — the same caller-layered pattern node WSClient uses for fleet.
 *
 * Usage in RTCAdapters.createSignalingClient (§4.5):
 *   createSignalingClient: (url: string) => new SignalClient(url)
 */

import { Client } from '@rivalis/core'
import type { ClientKickedEvent } from '@rivalis/core'
import { WSClient } from '@rivalis/core/clients/ws'

export type SignalTopic =
    | 'signal:welcome'
    | 'signal:host_gone'
    | 'signal:host_elected'
    | 'signal:offer'
    | 'signal:answer'
    | 'signal:ice'

const SIGNAL_TOPICS: readonly SignalTopic[] = [
    'signal:welcome',
    'signal:host_gone',
    'signal:host_elected',
    'signal:offer',
    'signal:answer',
    'signal:ice',
]

export type SignalClientOptions = {
    /**
     * Extra subprotocols offered alongside the ticket in the WS handshake.
     * Forwarded to the underlying WSClient (see WSClientOptions.subprotocols).
     */
    subprotocols?: string[]
}

/**
 * WebSocket client for @rivalis/signal. Extends Client<SignalTopic> so it is
 * a drop-in for RTCAdapters.createSignalingClient and works with the typed
 * on/once/off overloads in the Client base.
 *
 * The third constructor parameter is an optional pre-built Client for test
 * injection (same pattern as NodeDataChannelPeer's ndc? param). Production
 * callers omit it and receive a WSClient preconfigured for signal.
 */
class SignalClient extends Client<SignalTopic> {
    private readonly ws: Client

    constructor(signalUrl: string, options: SignalClientOptions = {}, ws?: Client) {
        super()
        this.ws = ws ?? new WSClient(signalUrl, {
            ticketSource: 'protocol',
            subprotocols: options.subprotocols,
        })
        this.ws.on('client:connect', () => this.emit('client:connect'))
        this.ws.on('client:disconnect', (payload: Uint8Array) => this.emit('client:disconnect', payload))
        this.ws.on('client:kicked', (info: ClientKickedEvent) => this.emit('client:kicked', info))
        this.ws.on('client:error', (error: Error) => this.emit('client:error', error))
        for (const topic of SIGNAL_TOPICS) {
            this.ws.on(topic, (payload: Uint8Array) => this.emit(topic, payload))
        }
    }

    get connected(): boolean {
        return this.ws.connected
    }

    connect(ticket = ''): void {
        this.ws.connect(ticket)
    }

    disconnect(): void {
        this.ws.disconnect()
    }

    send(topic: string, payload?: Uint8Array | string): void {
        this.ws.send(topic, payload)
    }
}

export default SignalClient
