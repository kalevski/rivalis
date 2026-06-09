/**
 * SignalServer bootstrap (p2p.md §4.3).
 *
 * Wires a Rivalis WS server with:
 *  - WSTransport with ticketSource:'protocol' — the auth ticket is read from the
 *    WS `Sec-WebSocket-Protocol` header rather than the URL, so it never appears
 *    in access logs or browser history.
 *  - SignalAuthMiddleware (ticket format: `<roomId>:<secret>`).
 *  - TokenBucketRateLimiter (default 30 tokens / 30 per second per actor).
 *  - A default 'signal' room defined and created on construction. Additional
 *    sessions can be created via server.rooms.create(SIGNAL_ROOM_TYPE, sessionId).
 *
 * Mirrors fleet's attachControlPlane
 * (fleet/src/orchestrator/transport.ts:109-163), including ticketSource:'protocol'
 * and a TokenBucketRateLimiter.
 */

import type { Server } from 'node:http'
import { Rivalis, TokenBucketRateLimiter } from '@rivalis/core'
import type { TokenBucketOptions, RoomManager } from '@rivalis/core'
import { WSTransport } from '@rivalis/core/transports/ws'
import type { AllowedOrigins } from '@rivalis/core/transports/ws'
import SignalAuthMiddleware from './SignalAuthMiddleware'
import SignalRoom from './SignalRoom'

/** Definition key for all signaling rooms. */
export const SIGNAL_ROOM_TYPE = 'signal'

/** Id of the default signaling room created on construction. */
export const SIGNAL_ROOM_ID = 'signal'

export type SignalServerOptions = {
    /**
     * Port the WS transport should listen on.
     * Required when `server` is not provided.
     */
    port?: number
    /**
     * Existing `node:http` Server to attach the WS transport to.
     * Required when `port` is not provided. The caller is responsible
     * for calling `server.listen()`.
     */
    server?: Server
    /**
     * Ticket secrets forwarded to SignalAuthMiddleware.
     * At least one secret is required. All listed secrets are accepted,
     * enabling zero-downtime rotation (issue new, wait a TTL, revoke old).
     */
    secrets: string[]
    /**
     * Token-bucket rate-limiter parameters per actor.
     * Defaults: capacity 30, refillPerSecond 30.
     */
    rateLimiter?: TokenBucketOptions
    /**
     * Origin allow-list for the WS transport (CSRF mitigation).
     * When omitted, any origin is accepted (back-compat default).
     */
    allowedOrigins?: AllowedOrigins
}

class SignalServer {
    private readonly rivalis: Rivalis<null>

    /**
     * Direct access to the room manager.
     * Use `rooms.create(SIGNAL_ROOM_TYPE, sessionId)` to create additional
     * signaling sessions beyond the default 'signal' room.
     */
    readonly rooms: RoomManager<null>

    constructor(options: SignalServerOptions) {
        const serverOpts = options.server !== undefined
            ? { server: options.server }
            : options.port !== undefined
                ? { port: options.port }
                : {}

        const transport = new WSTransport(
            serverOpts,
            null,
            {
                ticketSource: 'protocol',
                ...(options.allowedOrigins !== undefined ? { allowedOrigins: options.allowedOrigins } : {}),
            }
        )

        const auth = new SignalAuthMiddleware({ secrets: options.secrets })
        const rateLimiter = new TokenBucketRateLimiter(options.rateLimiter ?? {})

        this.rivalis = new Rivalis<null>({
            transports: [transport],
            authMiddleware: auth,
            rateLimiter,
        })

        this.rooms = this.rivalis.rooms
        this.rooms.define(SIGNAL_ROOM_TYPE, SignalRoom)
        this.rooms.create(SIGNAL_ROOM_TYPE, SIGNAL_ROOM_ID)
    }

    /** Gracefully shut down: kick remaining actors, destroy rooms, close transport. */
    shutdown(opts?: { timeoutMs?: number }): Promise<void> {
        return this.rivalis.shutdown(opts)
    }
}

export default SignalServer
