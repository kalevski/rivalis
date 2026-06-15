/**
 * `/v1/instances` routes (§10): list (conditional GET), get one, list its rooms, and
 * the two status mutations (`drain` / `undrain`). Registered under the `/v1` prefix
 * (auth + audit hooks live on that scope). Coded errors (`INSTANCE_NOT_FOUND`, and
 * the control-path codes from `drainInstance`/`undrainInstance`) are thrown and
 * mapped centrally by `installErrorHandlers` (§10).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { RouteHandler } from '@toolcase/node'

import { FleetError } from '../domain'
import { restOk, sendConditional, type RouterContext } from './shared'

export class InstancesRouter extends RouteHandler {
    constructor(private readonly ctx: RouterContext) {
        super()
    }

    register(fastify: FastifyInstance): void {
        const deps = this.ctx.deps

        fastify.get('/instances', async (req, reply) =>
            sendConditional(req, reply, deps, deps.fleet.instances))

        fastify.get('/instances/:id', async (req, reply) => {
            const id = paramId(req)
            const instance = deps.fleet.getInstance(id)
            if (instance === null) {
                throw new FleetError('INSTANCE_NOT_FOUND', `instance ${id} not found`)
            }
            return restOk(reply, instance)
        })

        fastify.get('/instances/:id/rooms', async (req, reply) => {
            const id = paramId(req)
            if (deps.fleet.getInstance(id) === null) {
                throw new FleetError('INSTANCE_NOT_FOUND', `instance ${id} not found`)
            }
            return restOk(reply, deps.fleet.findRooms({ instanceId: id }))
        })

        fastify.post('/instances/:id/drain', async (req, reply) => {
            await deps.fleet.drainInstance(paramId(req))
            return restOk(reply)
        })

        fastify.post('/instances/:id/undrain', async (req, reply) => {
            await deps.fleet.undrainInstance(paramId(req))
            return restOk(reply)
        })
    }
}

function paramId(req: FastifyRequest): string {
    return (req.params as { id: string }).id
}
