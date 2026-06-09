import { WebSocket } from 'ws'
import CustomLoggerFactory from '../CustomLoggerFactory'
import { decode, encode } from '@rivalis/handshake'
import Client, { ClientKickedEvent } from '../Client'

const EMPTY_PAYLOAD = new Uint8Array()

export type ClientEventListener = (payload: Uint8Array, topic?: string) => void

/**
 * Where the connection ticket is carried on the wire.
 *
 * - `'query'` (default) appends `?ticket=...` to the URL — back-compat,
 *   but the ticket lands in proxy/access logs and browser history.
 * - `'protocol'` sends the ticket as the `Sec-WebSocket-Protocol` header.
 *   Pairs with `WSTransport`'s `ticketSource: 'protocol'`; keeps the
 *   ticket out of URLs entirely.
 */
export type WSClientTicketSource = 'query' | 'protocol'

export type WSClientOptions = {
    ticketSource?: WSClientTicketSource
    /**
     * Extra subprotocols offered alongside the ticket in the WS handshake.
     *
     * With `ticketSource: 'protocol'` the ticket is the FIRST offered
     * subprotocol (`WSTransport` extracts the first entry as the ticket); any
     * `subprotocols` here are appended after it. This lets a client also offer a
     * fixed sentinel so a server can echo *that* in the `101` response instead of
     * the ticket — RFC 6455 only lets the server select a subprotocol the client
     * offered, so without offering the sentinel the server can never choose it
     * and is forced to echo the ticket (a credential) into the response headers.
     */
    subprotocols?: string[]
}

/**
 * Node WebSocket client. Emits the full `Client` event taxonomy:
 * `client:connect`, `client:disconnect`, `client:kicked`, and `client:error`.
 *
 * **Reconnect** is intentionally NOT built in — it is layered by the caller
 * (e.g. `FleetAgent` drives its own exponential-backoff loop via
 * `AgentInternals.createClient`). This keeps the transport primitive simple
 * and lets the caller own retry policy, token refresh, and state transitions.
 */
class WSClient extends Client {

    private baseURL: string

    private logger = CustomLoggerFactory.Instance.getLogger('ws client')

    private ws: WebSocket | null = null

    private ticketSource: WSClientTicketSource

    private subprotocols: string[]

    constructor(baseURL: string, options: WSClientOptions = {}) {
        super()
        this.baseURL = baseURL
        this.ticketSource = options.ticketSource ?? 'query'
        this.subprotocols = options.subprotocols ?? []
    }

    /**
     * `true` only while the underlying socket is OPEN — readyState-based,
     * so it is `false` during CONNECTING (before the handshake completes)
     * and `false` once the socket has closed.
     */
    get connected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN
    }

    connect(ticket: string = ''): void {
        // Guard on socket presence, not `connected`: `connected` is now
        // OPEN-only, so a second connect() during CONNECTING must still be
        // rejected here or it would orphan the first socket.
        if (this.ws !== null) {
            this.logger.warning('the client is already connected')
            return
        }
        if (typeof ticket !== 'string') {
            throw new Error(`ticket must be a string, ${ticket} provided`)
        }
        const url = new URL(this.baseURL)
        let protocols: string | string[] | undefined
        if (this.ticketSource === 'protocol') {
            // The ticket travels in Sec-WebSocket-Protocol; never in the URL.
            // An empty ticket means "offer no subprotocol" — the server-side
            // auth will reject it, which is the correct outcome.
            // The ticket is always offered FIRST (WSTransport extracts the first
            // entry as the ticket); any configured `subprotocols` follow it so a
            // server can echo a sentinel instead of the ticket in its `101`.
            if (ticket.length > 0) {
                protocols = this.subprotocols.length > 0 ? [ticket, ...this.subprotocols] : ticket
            } else if (this.subprotocols.length > 0) {
                protocols = [...this.subprotocols]
            }
        } else {
            url.searchParams.append('ticket', ticket)
            if (this.subprotocols.length > 0) {
                protocols = [...this.subprotocols]
            }
        }
        this.ws = new WebSocket(url.toString(), protocols)
        // Attach an 'error' listener BEFORE anything can fail: a failed
        // connect (ECONNREFUSED, DNS) emits 'error' on the socket, and an
        // unhandled 'error' on a ws socket crashes the host process. Surface
        // it as a 'client:error' broadcast instead.
        this.ws.on('error', (error) => this.onError(error))
        this.ws.once('open', () => this.onOpen())
        this.ws.once('close', (code, reason) => this.onClose(code, reason))
    }

    disconnect(): void {
        if (this.ws === null) {
            return
        }
        const ws = this.ws
        this.ws = null
        ws.removeAllListeners()
        // Closing a socket that is still CONNECTING makes ws emit a
        // "WebSocket was closed before the connection was established"
        // error asynchronously. With our listeners gone that would be an
        // unhandled 'error' → process crash, so absorb it here.
        ws.on('error', () => {})
        ws.close()
        this.emit('client:disconnect', Buffer.from('terminated'))
    }

    send(topic: string, payload: Uint8Array | string = EMPTY_PAYLOAD): void {
        // send-before-open: no-op with a logged warning, never throw —
        // ws throws if you send during CONNECTING, and `connected` is
        // OPEN-only so this branch covers CONNECTING/CLOSING/closed.
        if (!this.connected || this.ws === null) {
            this.logger.warning('send fail: connection is not established yet')
            return
        }

        if (typeof topic !== 'string') {
            throw new Error(`topic must be a string, ${topic} provided`)
        }

        if (payload instanceof Uint8Array) {
            return this.ws.send(encode(topic, payload))
        }

        if (typeof payload === 'string') {
            return this.ws.send(encode(topic, Buffer.from(payload, 'utf-8')))
        }

        throw new Error(`send error: invalid payload=${payload}, must be a string or Buffer`)
    }

    private onOpen(): void {
        this.ws?.on('message', (data, isBinary) => this.onMessage(data as Uint8Array, isBinary))
        this.emit('client:connect')
    }

    private onMessage(data: Uint8Array, _isBinary: boolean): void {
        const { topic, payload } = decode(data)
        this.emit(topic, payload)
    }

    private onError(error: Error): void {
        // ws emits 'error' then 'close'; onClose performs the teardown.
        // Here we only surface the failure so the host process never sees
        // an unhandled 'error' event.
        this.emit('client:error', error)
    }

    private onClose(code: number, reason: Uint8Array): void {
        const ws = this.ws
        this.ws = null

        // Server-initiated app-level closes carry a 4xxx code — surface them as
        // a typed event, mirroring browser WSClient.ts:282-284.
        if (code >= 4000 && code < 5000) {
            const reasonStr = Buffer.isBuffer(reason) ? reason.toString('utf-8') : new TextDecoder().decode(reason)
            this.emit('client:kicked', { code, reason: reasonStr } satisfies ClientKickedEvent)
        }

        this.emit('client:disconnect', reason)
        ws?.removeAllListeners()
    }

}

export default WSClient
