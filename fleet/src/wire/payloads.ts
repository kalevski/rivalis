/**
 * Per-topic wire payloads (§7) — the binary (protobuf) bodies carried under each
 * topic name (`./topics`). Transport is core's topic messaging inside `FleetRoom`;
 * every message is the topic name plus a payload, no further envelope. Correlation
 * fields (`seq`, `cmdId`, `reqId`) live in the payload.
 *
 * Strict orchestrator-driven request/reply (task 011): the orchestrator polls
 * (`fleet/poll { reqId, knownHash, status }`) and the agent replies
 * (`fleet/state { reqId, full, ... }`). Commands keep their direction
 * (`fleet/cmd { cmdId }` → `fleet/ack { cmdId }`) but every reply must match an
 * outstanding request by correlation id or the agent is kicked.
 *
 * These reference the pure data-model types from `../domain` (`Capacity`,
 * `InstanceStatus`); the wire layer depends on the domain layer, never the reverse.
 */

import type { Capacity, InstanceStatus } from '../domain'

/** Provenance stamp the agent puts on each room it reports (§6, §7). */
export type RoomOrigin = 'fleet' | 'local'

/** Operation carried by a `fleet/cmd` push (§7). */
export type CommandOp = 'create' | 'destroy' | 'drain' | 'undrain'

/** `fleet/hello` (orch → agent). */
export interface HelloPayload {
    instanceId: string
    protocolVersion: number
    heartbeatMs: number
}

/** Per-room entry inside a full `fleet/state` snapshot (agent-reported). */
export interface SyncRoom {
    id: string
    type: string
    connections: number
    origin: RoomOrigin
}

/**
 * `fleet/poll` (orch → agent) — the orchestrator-initiated state request (task 011).
 * `knownHash` is the orchestrator's last-known snapshot hash for this instance
 * (`null` ⇒ no prior state / forced full — this also subsumes the old `fleet/resync`).
 * `status` echoes the orchestrator's last-recorded instance status, so the agent's
 * `drain()` / `undrain()` resolves when a poll arrives echoing its target status —
 * an acknowledged confirmation with no unsolicited frame.
 */
export interface PollPayload {
    reqId: string
    knownHash: string | null
    status: InstanceStatus
}

/**
 * The semantic snapshot body (§6) — the fields a *full* `fleet/state` carries.
 * Built by the agent's `Snapshot`, validated by the orchestrator (§13) into the
 * read model. Named `SyncPayload` for continuity with the pre-011 push protocol;
 * it is now the snapshot portion of a `fleet/state` reply rather than its own topic.
 */
export interface SyncPayload {
    seq: number
    hash: string
    name: string
    processUid: string
    agentVersion: string
    protocolVersion: number
    endpointUrl: string
    labels: Record<string, string>
    capacity: Capacity
    autoCreate: boolean
    roomTypes: string[]
    rooms: SyncRoom[]
    status: InstanceStatus
}

/**
 * `fleet/state` (agent → orch) — the reply to a `fleet/poll` (task 011). `reqId`
 * echoes the poll it answers (the orchestrator consumes it from its outstanding-
 * request table; an unmatched / duplicate `reqId` is an unsolicited frame → kick).
 * `full: true` carries the whole snapshot (hash differed from the poll's
 * `knownHash`); `full: false` is a hash-only liveness reply (snapshot unchanged) and
 * the snapshot fields are absent on the wire — preserving the old sync/ping dedup,
 * but orchestrator-initiated.
 */
export interface StatePayload extends SyncPayload {
    reqId: string
    full: boolean
}

/** `fleet/cmd` (orch → agent). */
export interface CmdPayload {
    cmdId: string
    op: CommandOp
    roomId?: string
    roomType?: string
}

/** `fleet/ack` (agent → orch) — result of a command. */
export interface AckPayload {
    cmdId: string
    ok: boolean
    error?: string
    /** `destroy` of an already-gone room: desired end state holds (idempotent). */
    alreadyGone?: boolean
    /**
     * `create` failed because the room id already exists on the instance (task 003,
     * defense in depth). Lets the orchestrator surface the §10-documented
     * `409 ROOM_EXISTS` instead of a generic `502 COMMAND_FAILED`, so the
     * "treat 409 as success" retry contract holds even on the residual race where a
     * create reaches an agent that already owns the id.
     */
    exists?: boolean
    room?: {
        id: string
        type: string
    }
}
