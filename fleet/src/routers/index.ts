/**
 * `/v1` REST surface (§10), rebuilt on Fastify + `@toolcase/node`'s
 * `RouteHandler`/`Router` (task 006) — replacing the hand-rolled `node:http` router.
 * {@link createHttpApi} composes the routers ({@link HealthRouter} at the root,
 * {@link StatsRouter}/{@link InstancesRouter}/{@link RoomsRouter}/{@link EventsRouter}
 * under the auth-gated `/v1` scope) onto one Fastify instance and returns a small
 * lifecycle handle.
 *
 * Same-port recipe (the WS transport and REST share one `node:http` server, §5/task):
 * the Orchestrator passes a `serverFactory` that creates the shared server (and sets
 * the §13 slowloris timeouts on it), so Fastify routes HTTP while the WS upgrade
 * handler stays attached to the very same server. Without a `serverFactory` (tests),
 * Fastify creates its own server and {@link HttpApi.listen} binds an ephemeral port.
 *
 * The §10/§13 contracts are carried over with their constants: the 64 KiB pre-parse
 * body cap (Fastify `bodyLimit`), weak-ETag conditional GETs, SSE keep-alive + stream
 * cap + `?key=` opt-in, the per-IP `AUTH_THROTTLED` bucket, audit logging by key
 * fingerprint, uniform 401s, and CORS via `@fastify/cors`.
 */

import Fastify from 'fastify'
import type { FastifyInstance, FastifyServerFactory } from 'fastify'
import cors from '@fastify/cors'
import { Router } from '@toolcase/node'

import {
    MAX_BODY_BYTES,
    authHook,
    auditHook,
    createContext,
    installErrorHandlers,
    type HttpApiDeps
} from './shared'
import { HealthRouter } from './HealthRouter'
import { StatsRouter } from './StatsRouter'
import { InstancesRouter } from './InstancesRouter'
import { RoomsRouter } from './RoomsRouter'
import { EventsRouter } from './EventsRouter'

export {
    MAX_BODY_BYTES,
    SSE_PING_MS,
    AUTH_FAILURE_LIMIT,
    AUTH_FAILURE_WINDOW_MS,
    MAX_SSE_STREAMS,
    MAX_THROTTLE_BUCKETS,
    AuthThrottle
} from './shared'
export type { HttpApiDeps } from './shared'

/** Optional construction seam: the shared-server `serverFactory` (Orchestrator only). */
export interface CreateHttpApiOptions {
    serverFactory?: FastifyServerFactory
}

/** Lifecycle handle returned by {@link createHttpApi}. */
export interface HttpApi {
    /** The composed Fastify instance (its `.server` is the shared `node:http` server). */
    readonly fastify: FastifyInstance
    /** Boot plugins/routes without binding a port (Orchestrator awaits this before WS work is final). */
    ready(): Promise<void>
    /** Bind and start serving. */
    listen(opts: { host: string; port: number }): Promise<void>
    /** Synchronously end every open SSE stream so `server.close()` can drain (§9 shutdown ordering). */
    shutdown(): void
    /** End SSE streams and close Fastify (and the underlying server). */
    close(): Promise<void>
}

/**
 * Build the `/v1` REST surface (§10) from its {@link HttpApiDeps} seams. Health
 * probes are always mounted at the root (unauthenticated, available with `api: false`);
 * the `/v1` routes are mounted only when `api` is enabled, behind the auth + audit hooks.
 */
export function createHttpApi(deps: HttpApiDeps, options: CreateHttpApiOptions = {}): HttpApi {
    const ctx = createContext(deps)

    // `trustProxy` (§13): when on, Fastify resolves `req.ip` from `X-Forwarded-For`
    // so the throttle + audit log key on the real client behind a front proxy; off
    // (default) ignores the header and keys on the direct socket address.
    const base = { logger: false as const, bodyLimit: MAX_BODY_BYTES, trustProxy: deps.config.trustProxy }
    const fastify = options.serverFactory !== undefined
        ? Fastify({ ...base, serverFactory: options.serverFactory })
        : Fastify({ ...base })

    installErrorHandlers(fastify, deps.getLogger)

    // CORS (§10) — off by default; an allowed Origin is echoed onto /v1 + preflight.
    if (deps.config.cors !== false) {
        const origins = deps.config.cors.origins
        void fastify.register(cors, { origin: origins.includes('*') ? '*' : origins })
    }

    // Health probes at the root — unauthenticated, available even when api:false (§10).
    new HealthRouter(ctx).register(fastify)

    // The /v1 surface — auth-gated, audited; mounted only when REST is enabled.
    if (deps.config.api) {
        void fastify.register(async (v1) => {
            v1.addHook('onRequest', (req) => authHook(ctx, req))
            v1.addHook('onResponse', (req, reply) => auditHook(ctx, req, reply))
            new Router()
                .add(new StatsRouter(ctx))
                .add(new InstancesRouter(ctx))
                .add(new RoomsRouter(ctx))
                .add(new EventsRouter(ctx))
                .register(v1)
        }, { prefix: '/v1' })
    }

    const drainStreams = (): void => {
        for (const stream of [...ctx.streams]) {
            stream.cleanup()
            stream.end()
        }
    }

    return {
        fastify,
        ready: async () => { await fastify.ready() },
        listen: async (opts) => { await fastify.listen(opts) },
        shutdown: drainStreams,
        close: async () => {
            drainStreams()
            await fastify.close()
        }
    }
}
