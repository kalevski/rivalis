/**
 * Declarative schema for the `POST /v1/rooms` body (§10), declared next to the
 * §11 {@link ROOM_ID_PATTERN} it references. This is the single source of truth
 * the router feeds to Fastify via `deriveJsonSchema(roomCreateSchema, 'create')`
 * — replacing the former hand-rolled `roomCreateRequest` shape-check.
 *
 * This module imports only the `FieldSchema` TYPE from `@toolcase/node` (erased
 * at build), so the domain layer — and the agent bundle that depends on it —
 * pulls no `@toolcase/node` runtime code (no eager-loaded Fastify; see the §5
 * sequencing caveat). The router (orchestrator side, which already loads
 * `@toolcase/node`) derives the JSON Schema from this declaration.
 */

import type { FieldSchema } from '@toolcase/node'
import { ROOM_ID_PATTERN } from './roomId'

/** The `POST /v1/rooms` request body (§10). */
export interface RoomCreateBody {
    type: string
    roomId?: string
    placement?: Record<string, unknown>
}

/**
 * Field rules for the create-room body (§10/§11): `type` is a required non-empty
 * string; an explicit `roomId` must match the §11 charset; `placement` is an
 * object. The placement's pin-conflict / draining / charset semantics beyond the
 * shape are enforced downstream by `FleetState.place()` / `reserveRoomId()`, whose
 * coded errors (`VALIDATION`, `NO_CANDIDATE`, `ROOM_EXISTS`, …) map cleanly (§10).
 */
export const roomCreateSchema: FieldSchema<RoomCreateBody> = {
    type: { type: 'string', required: true, min: 1 },
    roomId: { type: 'string', pattern: ROOM_ID_PATTERN.source },
    placement: { type: 'object' }
}
