/**
 * `GET /v1/stats` (§10) — the {@link FleetStats} read model, served with a weak ETag
 * over the semantic state hash so a quiet fleet answers `304` to `If-None-Match`
 * (§6/§10). Registered under the `/v1` prefix (auth + audit hooks live on that scope).
 */

import type { FastifyInstance } from 'fastify'
import { RouteHandler } from '@toolcase/node'

import { sendConditional, type RouterContext } from './shared'

export class StatsRouter extends RouteHandler {
    constructor(private readonly ctx: RouterContext) {
        super()
    }

    register(fastify: FastifyInstance): void {
        fastify.get('/stats', async (req, reply) =>
            sendConditional(req, reply, this.ctx.deps, this.ctx.deps.fleet.stats))
    }
}
