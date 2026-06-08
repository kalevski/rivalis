/**
 * Transport bootstrap (§7 dogfooded control plane) — extracted from the
 * Orchestrator god class so the boot file only wires collaborators. Owns the
 * control-plane constants, the WS subprotocol selector (§13), the derived
 * rate-limiter budget (§7), the shared `node:http` server factory with the §13
 * slowloris timeouts, and {@link attachControlPlane} (the core-loading wiring that
 * builds the internal Rivalis, its auth middleware and the dogfooded FleetRoom).
 * The Orchestrator retains lifecycle (`listen`/`shutdown`); only this module knows
 * how the control plane is stood up.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'

import type { Logger } from '@toolcase/logging'

import { MAX_INFLIGHT_COMMANDS, WS_SUBPROTOCOL } from '../wire'
import { createFleetRoomClass } from './FleetRoom'
import type { FleetController } from './FleetRoom'
import type { AgentAuthenticator } from './AgentAuthenticator'

type CoreModule = typeof import('@rivalis/core')

/** Definition key / id of the single internal room hosting all agents (§7). */
export const FLEET_ROOM_TYPE = '@rivalis/fleet'
export const FLEET_ROOM_ID = 'fleet'

/** Snapshot transport frame ceiling — 4 MiB (§7), ~30k+ rooms of headroom. */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024

// Re-exported from the shared wire layer (`wire/topics`) — the sentinel is a
// protocol constant both halves reference, so it lives there to keep the agent
// half free of an agent→orchestrator import (it offers the sentinel via WSClient).
export { WS_SUBPROTOCOL }

/**
 * Explicit `node:http` timeouts (§13) — a hand-rolled router is not exempt from
 * slowloris, so we do not trust Node's defaults. `headersTimeout` bounds how long
 * a client may take to send request headers; `requestTimeout` bounds the whole
 * request. Both apply to receiving a request, not to a long-lived SSE response.
 */
export const HEADERS_TIMEOUT_MS = 10_000
export const REQUEST_TIMEOUT_MS = 30_000

/**
 * Choose the subprotocol echoed in the WS `101` response (§13). Prefer the fixed
 * {@link WS_SUBPROTOCOL} sentinel whenever the client offers it, so the agent key
 * (offered as the first subprotocol = the ticket) is never round-tripped into the
 * response. Falls back to the first offered protocol only for a client that does
 * not offer the sentinel, where echoing it back is the sole value the WS client
 * will accept — without that fallback the handshake fails outright.
 */
export function selectSubprotocol(protocols: Set<string>): string | false {
    if (protocols.has(WS_SUBPROTOCOL)) {
        return WS_SUBPROTOCOL
    }
    for (const protocol of protocols) {
        return protocol
    }
    return false
}

/**
 * Control-plane rate-limiter budget, **derived from {@link MAX_INFLIGHT_COMMANDS}**
 * — never a second literal (§7). Under strict orchestrator-driven request/reply
 * (task 011) the agent only ever replies, so the worst-case legitimate concurrent
 * inbound burst is bounded by the outstanding requests: at most
 * `MAX_INFLIGHT_COMMANDS` acks plus one `fleet/state` poll reply. The budget shrinks
 * from the pre-011 push-era 4×/2× to 2× capacity / 1× refill of that bound (at the
 * default cap of 32: capacity 66, refill 33/s) — defense-in-depth behind the kick
 * rule, with headroom for the full ack volley plus the poll reply.
 */
export function controlPlaneRateLimiterOptions(): { capacity: number; refillPerSecond: number } {
    const maxOutstanding = MAX_INFLIGHT_COMMANDS + 1
    return {
        capacity: 2 * maxOutstanding,
        refillPerSecond: maxOutstanding
    }
}

/**
 * Create the shared `node:http` server (the same-port recipe: REST + the WS
 * transport share it) with the §13 slowloris timeouts set before any bind. Passed
 * as Fastify's `serverFactory` so Fastify routes HTTP on the very server the WS
 * upgrade handler later attaches to.
 */
export function createSharedHttpServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Server {
    const server = createServer((req, res) => handler(req, res))
    server.headersTimeout = HEADERS_TIMEOUT_MS
    server.requestTimeout = REQUEST_TIMEOUT_MS
    return server
}

/** Minimal runtime surface of the internal Rivalis the orchestrator drives (§7). */
export interface RivalisLike {
    logging: { getLogger(ns: string): Logger }
    rooms: { define(key: string, roomClass: unknown): void; create(type: string, id: string | null): unknown }
    shutdown(opts?: { timeoutMs?: number }): Promise<void>
}

/**
 * Stand up the dogfooded control plane on an already-created shared HTTP server (§7):
 * a WS transport with `ticketSource: 'protocol'` (§13) and the 4 MiB snapshot cap,
 * the `101` sentinel subprotocol selector, an `AuthMiddleware` that routes any valid
 * agent key into the fleet room, the derived rate-limiter budget, and the single
 * `FleetRoom` that forwards agent frames to the `controller`. Returns the running
 * Rivalis (typed structurally — see {@link RivalisLike}).
 */
export function attachControlPlane(
    core: CoreModule,
    httpServer: Server,
    deps: { authenticator: AgentAuthenticator; controller: FleetController; logger: Logger }
): RivalisLike {
    // Agent key as WS ticket → fleet room. Constant-time compare (§13). The
    // throttling / audience-separation / fingerprint hardening is task 011.
    class FleetAuth extends core.AuthMiddleware<null> {
        override async authenticate(ticket: string): Promise<{ data: null; roomId: string } | null> {
            return deps.authenticator.matches(ticket) ? { data: null, roomId: FLEET_ROOM_ID } : null
        }
    }

    const transport = new core.Transports.WSTransport(
        { server: httpServer },
        null,
        { ticketSource: 'protocol', maxPayload: MAX_SNAPSHOT_BYTES }
    )

    // §13: echo the fixed sentinel subprotocol in the `101`, never the ticket.
    // WSTransport reads the ticket from the FIRST offered subprotocol but, left to
    // its default, also echoes that first value — round-tripping the agent key into
    // the response headers. Override the WS server's protocol selector (read
    // per-handshake) so the sentinel wins whenever a client offers it.
    const wss = (transport as unknown as { ws?: { options?: { handleProtocols?: unknown } } }).ws
    if (wss?.options !== undefined) {
        wss.options.handleProtocols = (protocols: Set<string>) => {
            const selected = selectSubprotocol(protocols)
            // A real FleetAgent offers the sentinel, so the sentinel wins. A legacy
            // client that offers only the ticket forces the fallback — echoing it
            // round-trips the agent key into the `101` response headers (§13). Warn
            // so the leak is observable; never log the value (it is a credential).
            if (selected !== false && selected !== WS_SUBPROTOCOL) {
                deps.logger.warning(
                    `fleet: WS 101 fell back to echoing a client-offered subprotocol that is not the ` +
                    `'${WS_SUBPROTOCOL}' sentinel — this round-trips the connection ticket (agent key) into ` +
                    `the response headers (§13). Upgrade the agent client to offer the sentinel. (value not logged)`
                )
            }
            return selected
        }
    } else {
        deps.logger.warning('fleet: could not install WS subprotocol selector — 101 may echo the ticket (§13)')
    }

    const rivalis = new core.Rivalis<null>({
        transports: [transport],
        authMiddleware: new FleetAuth(),
        rateLimiter: new core.TokenBucketRateLimiter(controlPlaneRateLimiterOptions())
    }) as unknown as RivalisLike

    const FleetRoomClass = createFleetRoomClass(core, deps.controller)
    rivalis.rooms.define(FLEET_ROOM_TYPE, FleetRoomClass)
    rivalis.rooms.create(FLEET_ROOM_TYPE, FLEET_ROOM_ID)
    return rivalis
}
