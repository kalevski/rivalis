import type { IncomingMessage } from 'http'
import { createHash } from 'node:crypto'
import { WebSocketServer, WebSocket, type ServerOptions } from 'ws'
import { CloseCode } from '@rivalis/handshake'
import logging from '@toolcase/logging'
import type { LoggerFactory } from '@toolcase/logging'
import { Transport, ConnectionLimiter, KickReason, checkBackpressure, DEFAULT_MAX_BUFFERED_BYTES } from '@rivalis/core'
import type { TLayer, ConnectionContext, BackpressureDropFn } from '@rivalis/core'
export type { BackpressureDropFn } from '@rivalis/core'

type HeartbeatOptions = { intervalMs?: number; missThreshold?: number }

export type AllowedOrigins = ReadonlyArray<string> | ((origin: string | undefined) => boolean)

export type TicketSource = 'query' | 'protocol'

export type WSTransportOptions = {
    heartbeat?: false | HeartbeatOptions
    maxBufferedBytes?: number
    /** Hard cap on a single inbound frame, in bytes. Default 64 KiB. */
    maxPayload?: number
    /**
     * Reject upgrade requests whose `Origin` header is not allow-listed.
     * Required mitigation for Cross-Site WebSocket Hijacking when the
     * authentication ticket is derived from a cookie. When omitted any
     * origin is accepted (back-compat default).
     */
    allowedOrigins?: AllowedOrigins
    /** Per-IP connection rate limit applied before `AuthMiddleware` runs. */
    connectionLimiter?: ConnectionLimiter
    /**
     * Where to read the auth ticket from. `'query'` (default) keeps the
     * back-compat behaviour of `?ticket=...`. `'protocol'` reads it from
     * the `Sec-WebSocket-Protocol` header — preferable in production
     * because subprotocol values do not appear in URL access logs or
     * browser history. The chosen value is echoed back so the WebSocket
     * handshake completes.
     */
    ticketSource?: TicketSource
    /**
     * Invoked when an outbound frame is dropped because the socket's
     * `bufferedAmount` exceeds `maxBufferedBytes`. Userland can use this
     * to escalate (kick the slow actor) or just observe the drop.
     */
    onBackpressureDrop?: BackpressureDropFn
}

type SocketWithHeartbeat = WebSocket & { missedPings?: number }

const DEFAULT_MAX_PAYLOAD = 64 * 1024

class WSTransport extends Transport {

    private logger = logging.getLogger('transport:websocket')

    private loggerFactory: LoggerFactory = logging

    private readonly QUERY_TICKET_PARAM: string = 'ticket'

    private ws: WebSocketServer | null = null

    private transportLayer: TLayer<any> | null = null

    private heartbeat: { intervalMs: number; missThreshold: number } | null = null

    private heartbeatTimer: NodeJS.Timeout | null = null

    private maxBufferedBytes: number = DEFAULT_MAX_BUFFERED_BYTES

    private resolvedMaxPayload: number = DEFAULT_MAX_PAYLOAD

    private allowedOrigins: ((origin: string | undefined) => boolean) | null = null

    private connectionLimiter: ConnectionLimiter | null = null

    private ticketSource: TicketSource = 'query'

    private onBackpressureDrop: BackpressureDropFn | null = null

    constructor(options: ServerOptions, queryTicketParam: string | null = null, transportOptions: WSTransportOptions = {}) {
        super()
        if (typeof queryTicketParam === 'string') {
            this.QUERY_TICKET_PARAM = queryTicketParam
        }

        this.ticketSource = transportOptions.ticketSource ?? 'query'

        const resolvedMaxPayload = transportOptions.maxPayload
            ?? options.maxPayload
            ?? DEFAULT_MAX_PAYLOAD
        this.resolvedMaxPayload = resolvedMaxPayload

        const serverOptions: ServerOptions = {
            ...options,
            maxPayload: resolvedMaxPayload
        }

        if (this.ticketSource === 'protocol') {
            // Echo back the first offered protocol so the upgrade handshake
            // completes. The actual ticket is read from the request headers
            // in extractTicket().
            serverOptions.handleProtocols = (protocols: Set<string>) => {
                for (const p of protocols) {
                    return p
                }
                return false
            }
        }

        this.ws = new WebSocketServer(serverOptions)
        this.ws.on('connection', this.handleReject)

        if (typeof transportOptions?.maxBufferedBytes === 'number' && transportOptions.maxBufferedBytes > 0) {
            this.maxBufferedBytes = transportOptions.maxBufferedBytes
        }

        if (typeof transportOptions.allowedOrigins === 'function') {
            this.allowedOrigins = transportOptions.allowedOrigins
        } else if (Array.isArray(transportOptions.allowedOrigins)) {
            const set = new Set<string>(transportOptions.allowedOrigins)
            this.allowedOrigins = (origin) => origin !== undefined && set.has(origin)
        }

        if (transportOptions.connectionLimiter !== undefined && transportOptions.connectionLimiter !== null) {
            if (!(transportOptions.connectionLimiter instanceof ConnectionLimiter)) {
                throw new Error('WSTransport error: connectionLimiter must be an instance of ConnectionLimiter')
            }
            this.connectionLimiter = transportOptions.connectionLimiter
        }

        if (typeof transportOptions.onBackpressureDrop === 'function') {
            this.onBackpressureDrop = transportOptions.onBackpressureDrop
        }

        const heartbeatConfig = transportOptions?.heartbeat
        if (heartbeatConfig !== false) {
            this.heartbeat = {
                intervalMs: heartbeatConfig?.intervalMs ?? 30000,
                missThreshold: heartbeatConfig?.missThreshold ?? 2
            }
            this.heartbeatTimer = setInterval(this.runHeartbeat, this.heartbeat.intervalMs)
            this.heartbeatTimer.unref?.()
        }
    }

    override onInitialize(transportLayer: TLayer<any>): void {
        this.transportLayer = transportLayer
        this.loggerFactory = transportLayer.logging
        this.logger = transportLayer.logging.getLogger('transport:websocket')
        this.ws?.off('connection', this.handleReject)
        this.ws?.on('connection', this.handleConnect)
        transportLayer.registerCapabilities(this.capabilities)
        this.logger.info('initialized')
    }

    override get sockets(): number {
        return this.ws !== null ? this.ws.clients.size : 0
    }

    override get maxFrameBytes(): number {
        return this.resolvedMaxPayload
    }

    private handleReject = (socket: WebSocket, _request: IncomingMessage): void => {
        socket.close(CloseCode.INVALID_TICKET)
    }

    private handleConnect = async (socket: WebSocket, request: IncomingMessage): Promise<void> => {
        if (this.transportLayer === null) {
            return socket.close(CloseCode.INVALID_TICKET)
        }

        if (!this.checkOrigin(request)) {
            this.logger.debug(`origin rejected: ${request.headers.origin ?? '(none)'}`)
            return socket.close(CloseCode.INVALID_TICKET)
        }

        if (this.connectionLimiter !== null) {
            const remoteAddress = request.socket.remoteAddress ?? 'unknown'
            try {
                const allowed = await this.connectionLimiter.check(remoteAddress)
                if (allowed === false) {
                    this.logger.debug(`connection rate limited from ${remoteAddress}`)
                    return socket.close(CloseCode.RATE_LIMITED, KickReason.RATE_LIMITED)
                }
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)
                this.logger.warning(`connectionLimiter.check threw: ${reason}`)
                return socket.close(CloseCode.RATE_LIMITED, KickReason.RATE_LIMITED)
            }
        }

        const ticket = this.extractTicket(request)
        if (ticket === null) {
            this.logger.debug('client disconnected, missing ticket')
            return socket.close(CloseCode.INVALID_TICKET)
        }

        // Register the close listener BEFORE awaiting grantAccess so a socket
        // that closes during auth is still cleaned up. While actorId is null
        // the listener flips a flag; once we know the id, the post-grant
        // path drains the close itself. After grantAccess succeeds and
        // actorId is set, this same listener handles the normal disconnect.
        let actorId: string | null = null
        let closedEarly = false
        socket.once('close', () => {
            if (actorId === null) {
                closedEarly = true
                return
            }
            this.transportLayer?.handleClose(actorId)
        })

        const connectionCtx: ConnectionContext = {
            kind: 'ws',
            remoteId: request.socket.remoteAddress,
            meta: { origin: request.headers.origin }
        }

        const ticketFingerprint = this.fingerprint(ticket)
        let resolvedActorId: string
        try {
            resolvedActorId = await this.transportLayer.grantAccess(ticket, connectionCtx, this)
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.logger.debug(`grant access failure, ticket=${ticketFingerprint}, reason=${reason}`)
            if (reason === KickReason.ROOM_FULL || reason === KickReason.ROOM_NOT_JOINABLE) {
                return socket.close(CloseCode.ROOM_REJECTED, reason)
            }
            return socket.close(CloseCode.INVALID_TICKET)
        }

        actorId = resolvedActorId
        const aid: string = resolvedActorId

        if (closedEarly) {
            this.logger.debug(`actor id=${aid} socket closed during handshake, cleaning up`)
            this.transportLayer.handleClose(aid)
            return
        }

        const heartbeatSocket = socket as SocketWithHeartbeat
        if (this.heartbeat !== null) {
            heartbeatSocket.missedPings = 0
            socket.on('pong', () => { heartbeatSocket.missedPings = 0 })
        }

        socket.on('message', (data, isBinary) => {
            if (!isBinary) {
                this.logger.debug(`actor id=(${aid}) ticket=${ticketFingerprint} sent non-binary data`)
                return socket.close(CloseCode.INVALID_FRAME)
            }
            if (this.loggerFactory.level === 'verbose') {
                this.logger.verbose('message received', data)
            }
            // B-1 defence-in-depth: the inner Room.handleMessage already
            // catches synchronous user-listener throws, but anything async
            // inside TLayer (rateLimiter.check, future awaited paths) could
            // still reject. Catch here so the rejection never reaches the
            // process unhandled-rejection handler.
            const tl = this.transportLayer
            if (tl !== null) {
                tl.handleMessage(aid, data as Uint8Array).catch((error) => {
                    const reason = error instanceof Error ? error.message : String(error)
                    this.logger.error(`handleMessage rejected for actor=${aid}: ${reason}`)
                })
            }
        })

        this.transportLayer.on('message', aid, (_, message) => {
            if (socket.readyState !== WebSocket.OPEN) {
                return
            }
            if (checkBackpressure(aid, socket.bufferedAmount, this.maxBufferedBytes, this.onBackpressureDrop, (msg) => this.logger.warning(msg))) {
                return
            }
            socket.send(message)
        })
        this.transportLayer.on('kick', aid, (_, message) => {
            socket.close(CloseCode.KICKED, Buffer.from(message))
        })
    }

    private checkOrigin(request: IncomingMessage): boolean {
        if (this.allowedOrigins === null) {
            return true
        }
        const origin = request.headers.origin
        return this.allowedOrigins(typeof origin === 'string' ? origin : undefined)
    }

    private extractTicket(request: IncomingMessage): string | null {
        if (this.ticketSource === 'protocol') {
            const header = request.headers['sec-websocket-protocol']
            if (typeof header !== 'string' || header.length === 0) {
                return null
            }
            const first = header.split(',')[0]?.trim()
            return first && first.length > 0 ? first : null
        }
        const queryString = request.url?.split('?')[1] ?? ''
        const params = new URLSearchParams(queryString)
        return params.get(this.QUERY_TICKET_PARAM)
    }

    private fingerprint(ticket: string): string {
        return createHash('sha256').update(ticket).digest('hex').slice(0, 8)
    }

    private runHeartbeat = (): void => {
        if (this.ws === null || this.heartbeat === null) {
            return
        }
        for (const socket of this.ws.clients) {
            const heartbeatSocket = socket as SocketWithHeartbeat
            if ((heartbeatSocket.missedPings ?? 0) >= this.heartbeat.missThreshold) {
                this.logger.debug('terminating idle socket: missed pong threshold reached')
                socket.terminate()
                continue
            }
            heartbeatSocket.missedPings = (heartbeatSocket.missedPings ?? 0) + 1
            try {
                socket.ping()
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)
                this.logger.warning(`heartbeat ping failed: ${reason}`)
            }
        }
    }

    /**
     * Stop accepting new connections, terminate live sockets, and shut
     * down the underlying WebSocketServer. Idempotent.
     */
    override dispose(): Promise<void> {
        if (this.ws === null) {
            return Promise.resolve()
        }
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = null
        }
        const server = this.ws
        this.ws = null
        server.off('connection', this.handleConnect)
        server.off('connection', this.handleReject)
        server.on('connection', this.handleReject)
        for (const client of server.clients) {
            try {
                client.close(CloseCode.KICKED, KickReason.SERVER_SHUTDOWN)
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)
                this.logger.warning(`failed to close client during dispose: ${reason}`)
            }
        }
        return new Promise((resolve) => {
            server.close((error) => {
                if (error) {
                    this.logger.warning(`server close reported error: ${error.message}`)
                }
                this.logger.info('disposed')
                resolve()
            })
        })
    }

}

export default WSTransport
