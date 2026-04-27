import { Broadcast } from '@toolcase/base'
import logging from '@toolcase/logging'
import { CloseCode, encode, decode } from '@rivalis/handshake'

const encoder = new window.TextEncoder()
const decoder = new window.TextDecoder()
const EMPTY_PAYLOAD = new Uint8Array()

export type ClientEventListener = (payload: Uint8Array, topic?: string) => void

export type WSClientReconnectOptions = {
    maxAttempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
}

export type TicketSource = 'query' | 'protocol'

/**
 * Payload of the `client:kicked` event. `code` is the WebSocket close
 * code the server sent (typically a `CloseCode.*` value in the 4000-4999
 * range); `reason` is the UTF-8-decoded close-frame reason. Listeners
 * receive a single object so they don't have to peek into a payload
 * `Uint8Array` and re-decode.
 */
export type ClientKickedEvent = {
    code: number
    reason: string
}

/**
 * Optional callback used to refresh the auth ticket before each
 * reconnect attempt. Required for short-lived JWTs / session tokens
 * that may have expired by the time the reconnect window opens.
 * If the callback throws or rejects, the reconnect loop terminates
 * and `client:reconnect_failed` is emitted.
 */
export type GetTicketFn = () => string | Promise<string>

export type WSClientOptions = {
    reconnect?: boolean | WSClientReconnectOptions
    /**
     * How the ticket is delivered to the server. `'query'` (default)
     * appends `?ticket=...` to the URL. `'protocol'` passes it as a
     * `Sec-WebSocket-Protocol` value — preferable when the server is
     * configured the same way, since subprotocol values do not appear
     * in URL access logs or browser history. The ticket must conform
     * to the WebSocket subprotocol token grammar (no spaces, no commas,
     * no padding `=`); standard base64url JWTs satisfy this.
     */
    ticketSource?: TicketSource
    /**
     * Called before every reconnect attempt to fetch a fresh ticket.
     * The first `connect(ticket)` call still uses its argument verbatim;
     * `getTicket` only kicks in for reconnects. If omitted, reconnects
     * reuse the last ticket — fine for long-lived credentials, broken
     * for short-lived ones.
     */
    getTicket?: GetTicketFn
}

type ReconnectConfig = {
    maxAttempts: number
    baseDelayMs: number
    maxDelayMs: number
}

const RECONNECT_DEFAULTS: ReconnectConfig = {
    maxAttempts: Infinity,
    baseDelayMs: 500,
    maxDelayMs: 10000
}

/**
 * Close codes that are terminal for the reconnect loop: the server
 * has explicitly told us not to come back, so retrying just produces
 * more rejection.
 */
const NO_RECONNECT_CODES: ReadonlySet<number> = new Set([
    CloseCode.INVALID_TICKET,
    CloseCode.KICKED,
    CloseCode.ROOM_REJECTED
])

/**
 * The set of well-known framework events emitted by the client. User
 * code can list these alongside its own topic types via the optional
 * `TTopics` generic — `new WSClient<'lobby:state' | 'chat'>(url)` —
 * for stricter `on` typing.
 */
type BuiltInEvent =
    | 'client:connect'
    | 'client:disconnect'
    | 'client:kicked'
    | 'client:reconnecting'
    | 'client:reconnect_failed'

class WSClient<TTopics extends string = string> extends Broadcast {

    private logger = logging.getLogger('ws client')

    private baseURL: string

    private ws: WebSocket | null = null

    private reconnectConfig: ReconnectConfig | null = null

    private lastTicket: string | null = null

    private reconnectAttempts: number = 0

    private reconnectTimer: ReturnType<typeof setTimeout> | null = null

    private userDisconnected: boolean = false

    private ticketSource: TicketSource = 'query'

    private getTicket: GetTicketFn | null = null

    constructor(baseURL: string, options: WSClientOptions = {}) {
        super()
        this.baseURL = baseURL
        this.reconnectConfig = this.resolveReconnect(options.reconnect)
        this.ticketSource = options.ticketSource ?? 'query'
        this.getTicket = options.getTicket ?? null
    }

    get connected(): boolean {
        return this.ws !== null
    }

    connect(ticket: string = ''): void {
        if (this.connected) {
            this.logger.warning('the client is already connected')
            return
        }
        if (typeof ticket !== 'string') {
            throw new Error(`ticket must be a sting, ${ticket} provided`)
        }
        // B-8: subprotocol values must be RFC 7230 tokens — non-empty,
        // no whitespace, no commas. `new WebSocket(url, [''])` would
        // otherwise throw a less-actionable SyntaxError out of the
        // constructor. Surface a clearer error before opening.
        if (this.ticketSource === 'protocol' && ticket.length === 0) {
            throw new Error('WSClient: ticketSource="protocol" requires a non-empty ticket')
        }
        this.cancelReconnect()
        this.userDisconnected = false
        this.reconnectAttempts = 0
        this.lastTicket = ticket
        this.openSocket(ticket)
    }

    disconnect(): void {
        this.userDisconnected = true
        this.cancelReconnect()
        // 6.6: nullify the cached ticket so a later unrelated connect()
        // can't accidentally fall back to a stale value via any future
        // code path that reads lastTicket.
        this.lastTicket = null
        if (!this.connected || this.ws === null) {
            return
        }
        // B-2: setting `this.ws = null` doesn't unbind the handlers from
        // the underlying WebSocket — when the browser actually closes
        // the socket, `onClose` would still fire and emit a SECOND
        // `client:disconnect`. Detach the handlers from the live socket
        // before nulling so only the synchronous emit below fires.
        const sock = this.ws
        this.ws = null
        sock.onclose = null
        sock.onmessage = null
        sock.onerror = null
        sock.close()
        this.emit('client:disconnect', encoder.encode('terminated'))
    }

    send(topic: string, payload: Uint8Array | string = EMPTY_PAYLOAD): void {
        // B-3: `this.ws !== null` is true the moment `openSocket` returns,
        // but the underlying socket is still in `CONNECTING` (readyState
        // 0). `WebSocket.send` throws `InvalidStateError` until the
        // socket reaches `OPEN`. Drop with a warning to match the existing
        // pre-connect path semantics.
        if (this.ws === null || this.ws.readyState !== window.WebSocket.OPEN) {
            this.logger.warning('send fail: connection is not open yet')
            return
        }

        if (typeof topic !== 'string') {
            throw new Error(`topic must be a string, ${topic} provided`)
        }

        if (payload instanceof Uint8Array) {
            return this.ws.send(encode(topic, payload))
        }

        if (typeof payload === 'string') {
            return this.ws.send(encode(topic, encoder.encode(payload)))
        }

        throw new Error(`send error: invalid payload=${payload}, must be a string or Buffer`)
    }

    // 6.5: typed overloads for `on` / `once` / `off`. The first five
    // overloads cover the framework-emitted events with their actual
    // payload shapes; the next is the user-topic overload constrained
    // by the optional `TTopics` generic; the final overload preserves
    // string/symbol back-compat. TypeScript picks the most specific
    // overload that matches the literal call site.
    override on(event: 'client:connect', listener: () => void, context?: unknown): this
    override on(event: 'client:disconnect', listener: (payload: Uint8Array) => void, context?: unknown): this
    override on(event: 'client:kicked', listener: (info: ClientKickedEvent) => void, context?: unknown): this
    override on(event: 'client:reconnecting', listener: (payload: Uint8Array) => void, context?: unknown): this
    override on(event: 'client:reconnect_failed', listener: () => void, context?: unknown): this
    override on<K extends TTopics>(event: K, listener: (payload: Uint8Array, topic: K) => void, context?: unknown): this
    override on(event: string | symbol, listener: (...args: any[]) => void, context?: unknown): this
    override on(event: string | symbol, listener: (...args: any[]) => void, context?: unknown): this {
        return super.on(event, listener, context)
    }

    override once(event: 'client:connect', listener: () => void, context?: unknown): this
    override once(event: 'client:disconnect', listener: (payload: Uint8Array) => void, context?: unknown): this
    override once(event: 'client:kicked', listener: (info: ClientKickedEvent) => void, context?: unknown): this
    override once(event: 'client:reconnecting', listener: (payload: Uint8Array) => void, context?: unknown): this
    override once(event: 'client:reconnect_failed', listener: () => void, context?: unknown): this
    override once<K extends TTopics>(event: K, listener: (payload: Uint8Array, topic: K) => void, context?: unknown): this
    override once(event: string | symbol, listener: (...args: any[]) => void, context?: unknown): this
    override once(event: string | symbol, listener: (...args: any[]) => void, context?: unknown): this {
        return super.once(event, listener, context)
    }

    override off(event: BuiltInEvent | TTopics | string | symbol, listener: (...args: any[]) => void, context?: unknown): this {
        return super.off(event, listener, context)
    }

    private openSocket(ticket: string): void {
        if (this.ticketSource === 'protocol') {
            this.ws = new window.WebSocket(this.baseURL, [ticket])
        } else {
            const url = new window.URL(this.baseURL)
            url.searchParams.append('ticket', ticket)
            this.ws = new window.WebSocket(url.toString())
        }
        this.ws.onopen = this.onOpen
        this.ws.onclose = this.onClose
        // Native browser WebSocket and the `ws` Node polyfill both surface
        // connection-refused / TLS / protocol errors via 'error' before
        // 'close'. Browsers carry no actionable detail in the event (by
        // spec), and ws's underlying EventEmitter throws on unhandled
        // 'error'. A no-op handler suppresses both — `onclose` is the
        // single source of truth for failure paths.
        this.ws.onerror = this.onError
        this.ws.binaryType = 'arraybuffer'
    }

    private onError = (): void => {}

    private onOpen = (): void => {
        if (this.ws !== null) {
            this.ws.onmessage = this.onMessage
        }
        this.reconnectAttempts = 0
        this.emit('client:connect')
    }

    private onMessage = (message: MessageEvent): void => {
        const { topic, payload } = decode(new Uint8Array(message.data as ArrayBuffer))
        this.emit(topic, payload)
    }

    private onClose = (event: CloseEvent): void => {
        this.ws = null

        // 6.3: server-initiated app-level closes carry a 4xxx code and
        // (usually) a reason string. Surface them as a typed event so
        // consumers don't have to peek inside the disconnect payload
        // to find out why.
        if (event.code >= 4000 && event.code < 5000) {
            this.emit('client:kicked', { code: event.code, reason: event.reason ?? '' } satisfies ClientKickedEvent)
        }

        this.emit('client:disconnect', encoder.encode(event.reason))

        if (this.shouldReconnect(event.code)) {
            this.scheduleReconnect()
            return
        }
        // 6.4: distinguish "ran out of retries" from "user disconnected"
        // / "terminal code" / "no reconnect configured". Only the former
        // is a failure event worth surfacing.
        if (this.reconnectExhausted()) {
            this.emit('client:reconnect_failed')
        }
    }

    private shouldReconnect(code: number): boolean {
        if (this.userDisconnected) return false
        if (this.reconnectConfig === null) return false
        if (this.lastTicket === null && this.getTicket === null) return false
        if (NO_RECONNECT_CODES.has(code)) return false
        if (this.reconnectAttempts >= this.reconnectConfig.maxAttempts) return false
        return true
    }

    private reconnectExhausted(): boolean {
        if (this.userDisconnected) return false
        if (this.reconnectConfig === null) return false
        // Only count as "exhausted" if at least one reconnect attempt
        // had been scheduled; otherwise this is the very first failure
        // (no reconnect was ever configured / available), which is just
        // a normal disconnect.
        if (this.reconnectAttempts === 0) return false
        return this.reconnectAttempts >= this.reconnectConfig.maxAttempts
    }

    private scheduleReconnect(): void {
        if (this.reconnectConfig === null) return
        const delay = this.computeBackoff(this.reconnectAttempts)
        this.reconnectAttempts += 1
        this.emit('client:reconnecting', encoder.encode(String(this.reconnectAttempts)))
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            void this.performReconnect()
        }, delay)
    }

    private async performReconnect(): Promise<void> {
        if (this.userDisconnected) return
        let ticket: string | null = null
        if (this.getTicket !== null) {
            try {
                const fresh = await this.getTicket()
                if (typeof fresh !== 'string') {
                    throw new Error(`getTicket must resolve to a string, got ${typeof fresh}`)
                }
                ticket = fresh
                this.lastTicket = fresh
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)
                this.logger.warning(`getTicket failed, aborting reconnect: ${reason}`)
                this.emit('client:reconnect_failed')
                return
            }
        } else if (this.lastTicket !== null) {
            ticket = this.lastTicket
        } else {
            return
        }
        // Re-check the disconnect flag in case the user called disconnect()
        // during the await above.
        if (this.userDisconnected) return
        this.openSocket(ticket)
    }

    private computeBackoff(attempt: number): number {
        if (this.reconnectConfig === null) return 0
        const { baseDelayMs, maxDelayMs } = this.reconnectConfig
        const exp = baseDelayMs * Math.pow(2, attempt)
        const jitter = Math.random() * baseDelayMs
        return Math.min(exp + jitter, maxDelayMs)
    }

    private cancelReconnect(): void {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
    }

    private resolveReconnect(option: WSClientOptions['reconnect']): ReconnectConfig | null {
        if (option === undefined || option === false) return null
        if (option === true) return { ...RECONNECT_DEFAULTS }
        return {
            maxAttempts: option.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts,
            baseDelayMs: option.baseDelayMs ?? RECONNECT_DEFAULTS.baseDelayMs,
            maxDelayMs: option.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
        }
    }

}

// `decoder` is held at module scope to avoid allocating one per
// onClose; it's only used by consumers that want to decode the
// `client:disconnect` payload — exported as a convenience.
export { decoder }

export default WSClient
