/**
 * Liveness/readiness probes (§10) — `GET /healthz` and `GET /readyz`. Registered at
 * the **root** (never under the `/v1` prefix) and **unauthenticated**, so k8s probes
 * keep working even on a control-plane-only deployment (`api: false`). `/readyz`
 * distinguishes "HTTP listening" from "WS transport attached" via {@link HttpApiDeps.isReady}.
 */

import type { FastifyInstance } from 'fastify'
import { RouteHandler } from '@toolcase/node'
import { HTTP } from '@toolcase/base'

import { restError, restOk, type RouterContext } from './shared'

export class HealthRouter extends RouteHandler {
    constructor(private readonly ctx: RouterContext) {
        super()
    }

    register(fastify: FastifyInstance): void {
        fastify.get('/healthz', async (_req, reply) => restOk(reply))
        fastify.get('/readyz', async (_req, reply) => {
            if (this.ctx.deps.isReady()) {
                return restOk(reply)
            }
            return restError(reply, HTTP.Status.SERVICE_UNAVAILABLE, 'NOT_READY')
        })
    }
}
