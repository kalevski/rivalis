/**
 * Shared infrastructure for the `/v1` REST routers (task 006, §10). The hand-rolled
 * `node:http` stack (routing, CORS, body caps, auth throttle, envelope) is replaced
 * by Fastify + `@toolcase/node`'s `RouteHandler`/`Router` and the
 * `@toolcase/base` `HTTP.RESTResponse`/`HTTP.RESTError` envelope; the §13 security
 * behaviors (uniform 401s, per-IP failed-auth throttle, audience separation, audit
 * logging by key fingerprint, SSE stream cap + query-auth opt-in) and the §10
 * contracts (64 KiB body cap, weak-ETag conditional GETs, SSE keep-alive) are
 * carried over with their constants intact.
 *
 * Testability seam (§15): the routers depend only on {@link HttpApiDeps} (read model
 * + control surface, auth config, readiness, an event subscription for SSE) plus the
 * shared {@link RouterContext}, so the HTTP suite boots the Fastify app with injected
 * fakes — no core, no WebSocket — exactly as it did against the old router.
 */

import { createHash } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { HTTP } from '@toolcase/base'
import { errorMeta } from '@toolcase/node'
import type { Logger } from '@toolcase/logging'

import type { ResolvedConfig } from '../orchestrator/Config'
import type { FleetApi } from '../orchestrator/Orchestrator'
import { matchKey } from '../orchestrator/AgentAuthenticator'
import { FleetError } from '../domain'
import type { FleetEvent } from '../domain'
import { describe } from '../util/errors'

/** Request body ceiling (§10): bodies over this are `413`d **before** any parse (Fastify `bodyLimit`). */
export const MAX_BODY_BYTES = 64 * 1024

/** SSE keep-alive comment cadence (§10) — idle proxies don't kill the stream. */
export const SSE_PING_MS = 15000

/** Per-IP failed-auth budget and window (§13): 10 failures/min → `429 AUTH_THROTTLED`. */
export const AUTH_FAILURE_LIMIT = 10
export const AUTH_FAILURE_WINDOW_MS = 60_000

/** Concurrent SSE stream cap (§13): beyond this → `429 SSE_LIMIT`. */
export const MAX_SSE_STREAMS = 100

/**
 * Upper bound on distinct failed-auth buckets the {@link AuthThrottle} retains (§13).
 * A direct-exposure attacker cycling spoofable source IPs would otherwise grow the
 * bucket map without bound; beyond this cap the oldest-touched bucket is evicted, so
 * memory is O(limit), not O(distinct IPs ever seen). Stale, fully-refilled buckets
 * are pruned first (they carry no state), so this only bites under active abuse.
 */
export const MAX_THROTTLE_BUCKETS = 4096

/** Seams the routers run against (§15) — supplied by the Orchestrator (or a test). */
export interface HttpApiDeps {
    /** Resolved config: `api`, `adminKeys`, `cors`, `sseQueryAuth`, `trustProxy`. */
    readonly config: Pick<ResolvedConfig, 'api' | 'adminKeys' | 'cors' | 'sseQueryAuth' | 'trustProxy'>
    /** Read model + control surface (the same object exposed as `orchestrator.fleet`). */
    readonly fleet: FleetApi
    /** True once HTTP is listening **and** the WS transport is attached (drives `/readyz`). */
    isReady(): boolean
    /** Subscribe to fleet events for the SSE stream; returns an unsubscribe fn. */
    subscribe(listener: (event: FleetEvent) => void): () => void
    /** Logger (`fleet:http` namespace once core is loaded). */
    getLogger(): Logger
    /** SSE keep-alive cadence; default {@link SSE_PING_MS} (tests inject a small value). */
    ssePingMs?: number
    /** Clock for the per-IP failed-auth token bucket (§13); default `Date.now`. */
    now?: () => number
    /** Concurrent SSE stream cap (§13); default {@link MAX_SSE_STREAMS} (tests inject a small value). */
    maxSseStreams?: number
}

/** One live SSE stream — its raw response and the teardown that detaches its timers/listener. */
export interface SseStream {
    end(): void
    cleanup(): void
}

/** Resolved, shared state the routers + the `/v1` scope hooks close over. */
export interface RouterContext {
    readonly deps: HttpApiDeps
    readonly throttle: AuthThrottle
    /** Every open SSE stream, so `shutdown()` can drain them before `server.close()`. */
    readonly streams: Set<SseStream>
    readonly pingMs: number
    readonly maxStreams: number
    /** Per-request authenticated-key fingerprint + ip, captured at auth for the audit log. */
    readonly authInfo: WeakMap<FastifyRequest, { fingerprint: string; ip: string }>
}

/** Build the shared {@link RouterContext} from the injected {@link HttpApiDeps}. */
export function createContext(deps: HttpApiDeps): RouterContext {
    const now = deps.now ?? Date.now
    return {
        deps,
        throttle: new AuthThrottle(AUTH_FAILURE_LIMIT, AUTH_FAILURE_WINDOW_MS, now),
        streams: new Set<SseStream>(),
        pingMs: deps.ssePingMs ?? SSE_PING_MS,
        maxStreams: deps.maxSseStreams ?? MAX_SSE_STREAMS,
        authInfo: new WeakMap()
    }
}

// ---------------------------------------------------------------------------
// Envelope helpers (@toolcase/base HTTP)
// ---------------------------------------------------------------------------

/** Success body `{ status: 'OK', data? }` at the given HTTP status (default 200). */
export function restOk(reply: FastifyReply, data?: unknown, status: number = HTTP.Status.OK): InstanceType<typeof HTTP.RESTResponse> {
    reply.code(status)
    return new HTTP.RESTResponse(status, data)
}

/**
 * Error body `{ status: 'rejected', cause }` at `status`. Returns the **serialized**
 * `RESTError` (its `toJSON()`), never the `RESTError` instance: a returned `Error`
 * would be re-routed by Fastify into the error handler (→ 500), so handlers and the
 * error/404 handlers all funnel through here.
 */
export function restError(reply: FastifyReply, status: number, cause: string): Record<string, unknown> {
    reply.code(status)
    return new HTTP.RESTError(status, cause).toJSON() as Record<string, unknown>
}

/**
 * Install the single error + 404 mapping (§10) — the one `sendError`-equivalent
 * place. `EndpointError`/`FleetError` map via `errorMeta` (so the §10 `code` lands
 * in the envelope `cause`); Fastify framework errors map by `statusCode`
 * (413 → `PAYLOAD_TOO_LARGE`, other 4xx → `VALIDATION`); anything else is a 500.
 */
export function installErrorHandlers(fastify: FastifyInstance, getLogger: () => Logger): void {
    fastify.setNotFoundHandler((req, reply) => restError(reply, HTTP.Status.NOT_FOUND, 'NOT_FOUND'))
    fastify.setErrorHandler((error, req, reply) => {
        const meta = errorMeta(error)
        if (meta !== null) {
            return restError(reply, meta.status, meta.code ?? 'INTERNAL')
        }
        const status = (error as { statusCode?: unknown }).statusCode
        if (status === HTTP.Status.PAYLOAD_TOO_LARGE) {
            return restError(reply, HTTP.Status.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE')
        }
        if (typeof status === 'number' && status >= 400 && status < 500) {
            return restError(reply, status, 'VALIDATION')
        }
        getLogger().error(`unhandled error on ${req.method} ${pathOf(req)}: ${describe(error)}`)
        return restError(reply, HTTP.Status.INTERNAL_SERVER_ERROR, 'INTERNAL')
    })
}

// ---------------------------------------------------------------------------
// Conditional GET (weak ETag over the semantic state hash — §6/§10)
// ---------------------------------------------------------------------------

/**
 * Send `data` with a weak ETag derived from the current `stateHash`, or `304` when
 * the client's `If-None-Match` already holds it (§10). The hash covers semantic
 * state only (§6), so a quiet fleet (heartbeats but no change) keeps producing 304s.
 */
export function sendConditional(
    req: FastifyRequest,
    reply: FastifyReply,
    deps: HttpApiDeps,
    data: unknown
): unknown {
    const etag = weakEtag(deps.fleet.stats.stateHash)
    reply.header('etag', etag)
    if (ifNoneMatchMatches(req, etag)) {
        reply.code(HTTP.Status.NOT_MODIFIED)
        return null
    }
    return restOk(reply, data)
}

/** Weak ETag over the semantic state hash (§6/§10): `W/"<hash>"`. */
export function weakEtag(stateHash: string): string {
    return `W/"${stateHash}"`
}

/** True when `If-None-Match` carries the current weak ETag (handles a comma list). */
function ifNoneMatchMatches(req: FastifyRequest, etag: string): boolean {
    const header = req.headers['if-none-match']
    if (typeof header !== 'string') {
        return false
    }
    if (header.trim() === '*') {
        return true
    }
    return header.split(',').some((candidate) => candidate.trim() === etag)
}

// ---------------------------------------------------------------------------
// Auth (§13) — Bearer admin key; constant-time match; per-IP throttle
// ---------------------------------------------------------------------------

/** Extract a `Bearer <token>` from the `Authorization` header, or `null`. */
export function bearerToken(req: FastifyRequest): string | null {
    const header = req.headers['authorization']
    if (typeof header !== 'string') {
        return null
    }
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    return match === null ? null : (match[1] as string)
}

/**
 * Constant-time admin-key match (§13) — the one definition lives in
 * {@link matchKey} (`orchestrator/AgentAuthenticator`), shared with the WS agent
 * auth. Re-exported under the legacy name so this module's call sites and any
 * importer are unchanged.
 */
export { matchKey as matchedKey } from '../orchestrator/AgentAuthenticator'

/** `key#<8 hex>` — truncated SHA-256 fingerprint for audit logs (§13); never the key. */
export function fingerprint(key: string): string {
    return 'key#' + createHash('sha256').update(key).digest('hex').slice(0, 8)
}

/**
 * Source IP for throttling / audit logs (§13). Uses Fastify's `req.ip`, which is the
 * direct socket address by default and the forwarded client IP (leftmost trusted
 * `X-Forwarded-For` hop) when the orchestrator is configured with `trustProxy: true`
 * — so behind the recommended TLS-terminating proxy the throttle and audit log key on
 * the real client, not the single proxy address. Falls back to `unknown`.
 */
export function remoteIp(req: FastifyRequest): string {
    return req.ip ?? 'unknown'
}

/** Pathname (no query) of a request, with the `/v1` prefix intact. */
export function pathOf(req: FastifyRequest): string {
    const url = req.url
    const q = url.indexOf('?')
    return q === -1 ? url : url.slice(0, q)
}

/** True for `GET /v1/events` — the SSE route owns its own (query-capable) auth. */
export function isEventsPath(req: FastifyRequest): boolean {
    return req.method === 'GET' && pathOf(req) === '/v1/events'
}

/** The three mutating routes that are audit-logged (§13): create/destroy room, drain/undrain. */
export function isMutatingRoute(req: FastifyRequest): boolean {
    const path = pathOf(req)
    if (req.method === 'POST' && path === '/v1/rooms') {
        return true
    }
    if (req.method === 'DELETE' && /^\/v1\/rooms\/.+$/.test(path)) {
        return true
    }
    if (req.method === 'POST' && /^\/v1\/instances\/[^/]+\/(drain|undrain)$/.test(path)) {
        return true
    }
    return false
}

/**
 * The shared `/v1` `onRequest` auth hook (§13). Per-IP throttle first (a source over
 * its failed-auth budget gets a uniform `429 AUTH_THROTTLED` before the key is even
 * examined), then audience-separated admin-key check (only `adminKeys` ever match,
 * so an agent key is one uniform `401`). The SSE route additionally accepts
 * `?key=<adminKey>` **only when `sseQueryAuth` is on** (§10/§13). On success the
 * authenticated key's fingerprint + ip are captured for the audit log; on failure a
 * coded {@link FleetError} is thrown and mapped by {@link installErrorHandlers}.
 */
export async function authHook(ctx: RouterContext, req: FastifyRequest): Promise<void> {
    const ip = remoteIp(req)
    const path = pathOf(req)
    if (ctx.throttle.blocked(ip)) {
        ctx.deps.getLogger().warning(`auth throttled ip=${ip} route=${req.method} ${path}`)
        throw new FleetError('AUTH_THROTTLED', 'too many failed authentication attempts')
    }

    let matched = matchKey(bearerToken(req), ctx.deps.config.adminKeys)
    if (matched === null && isEventsPath(req) && ctx.deps.config.sseQueryAuth) {
        const queryKey = (req.query as Record<string, unknown> | undefined)?.['key']
        if (typeof queryKey === 'string') {
            matched = matchKey(queryKey, ctx.deps.config.adminKeys)
        }
    }

    if (matched === null) {
        ctx.throttle.recordFailure(ip)
        ctx.deps.getLogger().warning(`auth failure ip=${ip} route=${req.method} ${path}`)
        throw new FleetError('UNAUTHORIZED', 'missing or invalid admin key')
    }
    ctx.authInfo.set(req, { fingerprint: fingerprint(matched), ip })
}

/**
 * The `/v1` `onResponse` audit hook (§13): the three mutating routes are logged by
 * route, key fingerprint, source IP, and outcome — never the credential.
 */
export async function auditHook(ctx: RouterContext, req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!isMutatingRoute(req)) {
        return
    }
    const info = ctx.authInfo.get(req)
    ctx.deps.getLogger().info(
        `audit route=${req.method} ${pathOf(req)} key=${info?.fingerprint ?? 'unknown'} ` +
        `ip=${info?.ip ?? remoteIp(req)} outcome=${reply.statusCode}`
    )
}

// ---------------------------------------------------------------------------
// CORS for the hijacked SSE stream (the @fastify/cors plugin's reply headers do
// not survive `reply.hijack()`, so the SSE raw response sets them itself — §10).
// ---------------------------------------------------------------------------

export function corsHeadersForSse(req: FastifyRequest, cors: false | { origins: string[] }): Record<string, string> {
    if (cors === false) {
        return {}
    }
    const origin = req.headers['origin']
    if (typeof origin !== 'string') {
        return {}
    }
    if (cors.origins.includes('*')) {
        return { 'access-control-allow-origin': '*' }
    }
    if (cors.origins.includes(origin)) {
        return { 'access-control-allow-origin': origin, vary: 'Origin' }
    }
    return {}
}

/**
 * Per-source-IP failed-authentication token bucket (§13). Starts full; each failed
 * auth consumes one token; tokens refill linearly over the window. While an IP has
 * no tokens it is {@link blocked} — a uniform `429 AUTH_THROTTLED` before the key is
 * examined, so a brute force is bounded to `limit` failures per `windowMs`.
 *
 * **Bounded memory.** A naive `Map<ip, bucket>` grows once per distinct source IP and
 * never shrinks — a slow leak under churn, and an unbounded one under a direct-exposure
 * attacker cycling spoofable IPs. Two defenses keep it O(active IPs in a window):
 * a once-per-window opportunistic sweep prunes buckets that have fully refilled (a
 * bucket back at `limit` tokens is indistinguishable from a never-seen IP, so deleting
 * it changes nothing), and a hard {@link MAX_THROTTLE_BUCKETS} cap evicts the
 * oldest-touched bucket when the map would otherwise exceed it.
 */
export class AuthThrottle {
    private readonly buckets = new Map<string, { tokens: number; last: number }>()
    /** Wall-clock of the last opportunistic sweep; gates pruning to once per window. */
    private lastPruneAt = -Infinity

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly now: () => number,
        private readonly maxBuckets: number = MAX_THROTTLE_BUCKETS
    ) {}

    /** True when the IP is over its failed-auth budget (no tokens left). */
    blocked(ip: string): boolean {
        return this.refill(ip).tokens < 1
    }

    /** Charge one token for a failed attempt (floored at zero). */
    recordFailure(ip: string): void {
        const bucket = this.refill(ip)
        bucket.tokens = Math.max(0, bucket.tokens - 1)
    }

    /** Current bucket count — a test seam for the §13 memory-bound assertions. */
    get size(): number {
        return this.buckets.size
    }

    private refill(ip: string): { tokens: number; last: number } {
        const now = this.now()
        this.prune(now)
        let bucket = this.buckets.get(ip)
        if (bucket === undefined) {
            bucket = { tokens: this.limit, last: now }
            this.buckets.set(ip, bucket)
            this.evictIfOver()
            return bucket
        }
        const elapsed = now - bucket.last
        if (elapsed > 0) {
            bucket.tokens = Math.min(this.limit, bucket.tokens + (elapsed / this.windowMs) * this.limit)
            bucket.last = now
        }
        return bucket
    }

    /**
     * Opportunistic sweep (≤ once per window): delete every bucket that has fully
     * refilled and not been touched within the last window. Such a bucket holds no
     * information — a fresh IP starts full — so removing it cannot un-throttle anyone.
     * Computing the *refilled* token count (not the stored one) also reclaims buckets
     * stuck below full only because the IP never returned after a single failure.
     */
    private prune(now: number): void {
        if (now - this.lastPruneAt < this.windowMs) {
            return
        }
        this.lastPruneAt = now
        for (const [ip, bucket] of this.buckets) {
            const elapsed = now - bucket.last
            if (elapsed <= this.windowMs) {
                continue
            }
            const refilled = Math.min(this.limit, bucket.tokens + (elapsed / this.windowMs) * this.limit)
            if (refilled >= this.limit) {
                this.buckets.delete(ip)
            }
        }
    }

    /** Hard cap: when over {@link maxBuckets}, evict the oldest-touched bucket. */
    private evictIfOver(): void {
        if (this.buckets.size <= this.maxBuckets) {
            return
        }
        let oldestIp: string | null = null
        let oldest = Infinity
        for (const [ip, bucket] of this.buckets) {
            if (bucket.last < oldest) {
                oldest = bucket.last
                oldestIp = ip
            }
        }
        if (oldestIp !== null) {
            this.buckets.delete(oldestIp)
        }
    }
}
