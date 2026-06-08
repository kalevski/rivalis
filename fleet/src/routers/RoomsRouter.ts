/**
 * `/v1/rooms` routes (§10): cluster-wide list with `type`/`instanceId`/repeatable
 * `label` filters (parity with `findRooms`), get one, **create with placement**
 * (`201`), and destroy. Registered under the `/v1` prefix (auth + audit hooks live on
 * that scope). Coded errors from validation, placement, and the command engine
 * (`VALIDATION`, `NO_CANDIDATE`, `ROOM_EXISTS`, `ROOM_NOT_FOUND`, `COMMAND_*`, …) are
 * thrown and mapped centrally by `installErrorHandlers` (§10).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { RouteHandler, deriveJsonSchema } from '@toolcase/node'
import { HTTP } from '@toolcase/base'

import { FleetError, roomCreateSchema } from '../domain'
import type { PlacementRequest } from '../domain'
import { restOk, sendConditional, type RouterContext } from './shared'

/**
 * The `POST /v1/rooms` body JSON Schema, derived once from {@link roomCreateSchema}
 * (§10): `type` required non-empty string, optional `roomId` matching the §11
 * charset, optional `placement` object. Fastify validates the body against it and a
 * violation surfaces as a framework `400`, mapped to `400 VALIDATION` by
 * `installErrorHandlers` — replacing the former hand-rolled `roomCreateRequest`.
 */
const roomCreateBodySchema = deriveJsonSchema(roomCreateSchema, 'create')

export class RoomsRouter extends RouteHandler {
    constructor(private readonly ctx: RouterContext) {
        super()
    }

    register(fastify: FastifyInstance): void {
        const deps = this.ctx.deps

        fastify.get('/rooms', async (req, reply) =>
            sendConditional(req, reply, deps, deps.fleet.findRooms(roomFilter(req))))

        // Body shape/charset is validated declaratively by the derived JSON Schema
        // (§10); a violation is a framework 400 → VALIDATION. The validated body is
        // exactly `{ type, roomId?, placement? }`, handed straight to createRoom.
        fastify.post('/rooms', { schema: { body: roomCreateBodySchema } }, async (req, reply) => {
            const created = await deps.fleet.createRoom(
                req.body as { type: string; roomId?: string; placement?: PlacementRequest }
            )
            return restOk(reply, created, HTTP.Status.CREATED)
        })

        // GET/DELETE /v1/rooms/:roomId — :roomId is the PUBLIC id verbatim (it may
        // embed `%XX`/`~`); read it from the raw path, never URL-decoded, or the
        // namespaced/encoded form would no longer match the read model (§11).
        fastify.get('/rooms/:roomId', async (req, reply) => {
            const roomId = publicRoomId(req)
            const room = deps.fleet.getRoom(roomId)
            if (room === null) {
                throw new FleetError('ROOM_NOT_FOUND', `room ${roomId} not found`)
            }
            return restOk(reply, room)
        })

        fastify.delete('/rooms/:roomId', async (req, reply) => {
            await deps.fleet.destroyRoom(publicRoomId(req))
            return restOk(reply)
        })
    }
}

/** `{ type?, instanceId?, labels? }` filter from the query string (§9/§10 `findRooms` parity). */
function roomFilter(req: FastifyRequest): { type?: string; instanceId?: string; labels?: Record<string, string> } {
    const query = (req.query ?? {}) as Record<string, unknown>
    const filter: { type?: string; instanceId?: string; labels?: Record<string, string> } = {}
    if (typeof query.type === 'string') {
        filter.type = query.type
    }
    if (typeof query.instanceId === 'string') {
        filter.instanceId = query.instanceId
    }
    // `label` is repeatable; each `k:v` must match (§10). Fastify yields a string for
    // one value and an array for many.
    const raw = query.label
    const labelParams = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : []
    if (labelParams.length > 0) {
        const labels: Record<string, string> = {}
        for (const entry of labelParams) {
            if (typeof entry !== 'string') {
                continue
            }
            const idx = entry.indexOf(':')
            if (idx > 0) {
                labels[entry.slice(0, idx)] = entry.slice(idx + 1)
            }
        }
        filter.labels = labels
    }
    return filter
}

/**
 * The verbatim public room id from the raw request path — `req.params` would be
 * URL-decoded, which would break the namespaced (`<processUid>~<roomId>`) and
 * percent-encoded forms the read model is keyed by (§11). The path is parsed but
 * never decoded, so the encoded segment matches the stored id exactly.
 */
function publicRoomId(req: FastifyRequest): string {
    const path = pathnameOf(req)
    const segments = path.split('/')
    return segments[segments.length - 1] ?? ''
}

function pathnameOf(req: FastifyRequest): string {
    const url = req.url
    const q = url.indexOf('?')
    return q === -1 ? url : url.slice(0, q)
}
