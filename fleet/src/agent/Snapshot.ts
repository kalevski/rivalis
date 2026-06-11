/**
 * Agent-side state snapshot builder with hash dedup and the §7 size guard.
 *
 * On each orchestrator poll the agent rebuilds the *full* instance state from live
 * core data (`rooms.definitions()` + `rooms.keys()` + `room.type` +
 * `room.actorCount`, the §4 additions) and lets a truncated-SHA-256 hash decide
 * between a heavy full `fleet/state` (hash differs from the poll's `knownHash`) and
 * a lightweight hash-only reply (unchanged). Per-room granularity catches offsetting
 * drift (room A +1, room B −1) that a global counter would miss. The dedup is the
 * same as the pre-011 sync/ping discipline, but orchestrator-initiated (task 011).
 *
 * Provenance (`origin: 'fleet' | 'local'`) is tracked here, agent-side: it is
 * the *only* source of `RoomInfo.local` and survives orchestrator restarts
 * because it lives in the process that owns the rooms (§7, §8).
 *
 * The size guard measures the encoded frame before it is sent and degrades
 * observably (warn at 50%, error with remediation at 90% of the 4 MiB transport
 * frame limit) — an oversized snapshot is terminated by the transport and
 * produces a permanent reconnect loop, so silent failure is the worst outcome
 * (§7, §14).
 */

import { randomBytes } from 'node:crypto'
import type { Logger } from '@toolcase/logging'
import type { Rivalis } from '@rivalis/core'

import { hash64 } from '../util/canonical'
import { NOOP_LOGGER } from '../util/logger'
import { packageVersion } from '../util/packageVersion'
import {
    PROTOCOL_VERSION,
    Topics,
    encodeFrame,
    type StatePayload,
    type SyncPayload,
    type SyncRoom
} from '../wire'
import type { Capacity, InstanceStatus } from '../domain'

/**
 * Transport frame ceiling the agent guards against — mirrors the orchestrator's
 * `WSTransport.maxPayload` (§7). The orchestrator owns the limit on its side;
 * the agent enforces the matching guard here so the instance degrades observably
 * long before the hard failure (terminated socket → reconnect loop) can occur.
 */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024

/** Warn once the encoded snapshot reaches this fraction of the frame limit. */
const WARN_RATIO = 0.5
/** Error (with remediation hints) once it reaches this fraction. */
const ERROR_RATIO = 0.9

/**
 * Minimum `@rivalis/core` version carrying the §4 additions (`Room.type`,
 * `RoomManager.definitions()`). Named in the feature-detect error so a fleet
 * installed against an older core fails clearly at startup instead of emitting
 * `undefined` room types into snapshots at runtime.
 */
const MIN_CORE_VERSION = '6.1.0'


/** Construction options for the snapshot builder (subset of `FleetAgentOptions`). */
export interface SnapshotOptions {
    /** Human-readable instance name (§6). */
    name: string
    /** Public URL game clients use to reach this instance (§6). */
    endpointUrl: string
    /** Free-form scheduling hints; defaults to `{}`. */
    labels?: Record<string, string>
    /** Capacity declaration; each dimension defaults to `null` (unlimited). */
    capacity?: { maxConnections?: number | null; maxRooms?: number | null }
    /** Whether the agent accepts orchestrator-initiated creates; defaults to `true`. */
    autoCreate?: boolean
    /** `@rivalis/fleet` version string; defaults to the resolved package version (task 009). */
    agentVersion?: string
    /** Protocol major; defaults to `PROTOCOL_VERSION`. */
    protocolVersion?: number
    /**
     * Stable per-process id (§6). Generated if omitted — it must stay constant
     * across reconnects, so the builder generates it once and never rotates it.
     */
    processUid?: string
    /** Initial lifecycle status; defaults to `'active'`. The agent owns this (§7). */
    status?: InstanceStatus
}

/** Semantic content of a snapshot — the snapshot body minus `seq`/`hash`. */
type SnapshotContent = Omit<SyncPayload, 'seq' | 'hash'>

/**
 * A `fleet/state` reply to an orchestrator poll (§7, task 011). `full: true`
 * carries the whole snapshot (the rebuilt hash differed from the poll's
 * `knownHash`); `full: false` is a hash-only liveness reply (unchanged state) whose
 * heavy fields are omitted on the wire. `encodedBytes` is the measured binary size
 * after the §7 size guard ran (0 for a hash-only reply, which is tiny by design).
 */
export interface StateFrame {
    kind: 'state'
    full: boolean
    hash: string
    encodedBytes: number
    payload: StatePayload
}

/** Generate a stable per-process id (`p_<hex>`); `node:crypto` only — no dependency. */
function generateProcessUid(): string {
    return 'p_' + randomBytes(12).toString('hex')
}

export class Snapshot {

    /** Stable per-process id (§6) — constant across reconnects. */
    readonly processUid: string

    private readonly rivalis: Rivalis
    private readonly logger: Logger

    private readonly name: string
    private readonly endpointUrl: string
    private readonly labels: Record<string, string>
    private readonly capacity: Capacity
    private readonly autoCreate: boolean
    private readonly agentVersion: string
    private readonly protocolVersion: number

    /** Room ids created in response to `fleet/cmd` → stamped `origin: 'fleet'`. */
    private readonly fleetOrigins: Set<string> = new Set()

    /** Agent owns `status` (§7); flipped via `setStatus`. */
    private statusValue: InstanceStatus

    /** Per-connection monotonic frame counter — defensive hardening only (§7). */
    private seq = 0

    constructor(rivalis: Rivalis, options: SnapshotOptions, logger?: Logger) {
        this.assertCoreSupport(rivalis)

        this.rivalis = rivalis
        this.logger = logger ?? rivalis.logging?.getLogger?.('fleet:agent') ?? NOOP_LOGGER

        this.name = options.name
        this.endpointUrl = options.endpointUrl
        this.labels = options.labels ?? {}
        this.capacity = {
            maxConnections: options.capacity?.maxConnections ?? null,
            maxRooms: options.capacity?.maxRooms ?? null
        }
        this.autoCreate = options.autoCreate ?? true
        this.agentVersion = options.agentVersion ?? packageVersion()
        this.protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION
        this.processUid = options.processUid ?? generateProcessUid()
        this.statusValue = options.status ?? 'active'
    }

    get status(): InstanceStatus {
        return this.statusValue
    }

    /** Flip the agent-owned status (§7). The next snapshot carries the new value. */
    setStatus(status: InstanceStatus): void {
        this.statusValue = status
    }

    /** Stamp a room as fleet-created (`origin: 'fleet'`). Called on a `fleet/cmd` create. */
    markFleetOrigin(roomId: string): void {
        this.fleetOrigins.add(roomId)
    }

    /** Drop provenance for a destroyed room so a future id reuse is not mis-stamped. */
    forgetRoom(roomId: string): void {
        this.fleetOrigins.delete(roomId)
    }

    /**
     * New connection (reconnect): reset the `seq` counter. The reconnect assigns a
     * fresh `instanceId`, so the orchestrator holds no prior hash and its first poll
     * carries `knownHash: null` → the next reply is always a full snapshot (§7).
     */
    resetConnection(): void {
        this.seq = 0
    }

    /**
     * Rebuild the full semantic snapshot from live core state and hash it. Pure:
     * no `seq`, no size guard, no dedup-state mutation — used for hash inspection
     * and as the basis for {@link pollReply}.
     */
    rebuild(): { content: SnapshotContent; hash: string } {
        const content = this.buildContent()
        return { content, hash: hash64(content) }
    }

    /**
     * Build a `fleet/state` reply to an orchestrator `fleet/poll` (§7, task 011).
     * The orchestrator drives the dedup: a FULL snapshot when the rebuilt hash
     * differs from the poll's `knownHash` (or `knownHash` is null — no prior state /
     * forced full), a hash-only reply otherwise. Always advances `seq`.
     */
    pollReply(reqId: string, knownHash: string | null): StateFrame {
        const { content, hash } = this.rebuild()
        const seq = this.nextSeq()
        if (knownHash !== null && hash === knownHash) {
            // Hash-only: the heavy fields ride along in-memory but are omitted on the
            // wire (the encoder drops them when full=false). Per-room granularity in
            // the rebuilt hash is what catches offsetting drift the orchestrator would
            // otherwise miss.
            const payload: StatePayload = { reqId, full: false, seq, hash, ...content }
            return { kind: 'state', full: false, hash, encodedBytes: 0, payload }
        }
        const payload: StatePayload = { reqId, full: true, seq, hash, ...content }
        // Measure the actual binary wire frame (§7, task 005), not a JSON string —
        // the size guard bounds bytes-on-the-wire against the transport ceiling.
        const encodedBytes = encodeFrame(Topics.state, payload).length
        this.checkSize(encodedBytes, content.rooms.length)
        return { kind: 'state', full: true, hash, encodedBytes, payload }
    }

    private nextSeq(): number {
        this.seq += 1
        return this.seq
    }

    private buildContent(): SnapshotContent {
        const manager = this.rivalis.rooms
        const roomTypes = [...manager.definitions()].sort()
        const rooms: SyncRoom[] = []
        for (const id of manager.keys()) {
            const room = manager.get(id)
            if (room === null) {
                continue
            }
            if (typeof room.type !== 'string') {
                throw new Error(this.coreSupportError(`room id=(${id}) has no string \`type\``))
            }
            rooms.push({
                id,
                type: room.type,
                connections: room.actorCount,
                origin: this.fleetOrigins.has(id) ? 'fleet' : 'local'
            })
        }
        // Arrays are order-significant in the canonical encoder, so sort by id:
        // the hash must be a function of logical state, never Map iteration order.
        rooms.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        return {
            name: this.name,
            processUid: this.processUid,
            agentVersion: this.agentVersion,
            protocolVersion: this.protocolVersion,
            endpointUrl: this.endpointUrl,
            labels: this.labels,
            capacity: this.capacity,
            autoCreate: this.autoCreate,
            roomTypes,
            rooms,
            status: this.statusValue
        }
    }

    private checkSize(bytes: number, roomCount: number): void {
        const pct = Math.round((bytes / MAX_SNAPSHOT_BYTES) * 100)
        if (bytes >= MAX_SNAPSHOT_BYTES * ERROR_RATIO) {
            this.logger.error(
                `fleet snapshot at ${pct}% of the 4 MiB transport frame limit ` +
                `(${bytes} bytes, ${roomCount} rooms). An oversized snapshot is terminated ` +
                `by the transport, which causes a permanent reconnect loop. Remediation: ` +
                `host fewer rooms per instance, raise the orchestrator's WSTransport.maxPayload, ` +
                `or split the fleet across more instances (chunked sync is roadmap §16).`
            )
        } else if (bytes >= MAX_SNAPSHOT_BYTES * WARN_RATIO) {
            this.logger.warning(
                `fleet snapshot at ${pct}% of the 4 MiB transport frame limit ` +
                `(${bytes} bytes, ${roomCount} rooms) — approaching the size guard.`
            )
        }
    }

    /**
     * Feature-detect the §4 core additions and throw an actionable, version-naming
     * error when they are absent — a clean failure at startup instead of
     * `undefined` types in snapshots at runtime. `Room.type` can only be checked
     * against rooms that already exist; with zero rooms the `definitions()` gate
     * is the primary guard (and `buildContent` re-checks each room defensively).
     */
    private assertCoreSupport(rivalis: Rivalis): void {
        const manager = rivalis?.rooms
        if (manager === undefined || manager === null) {
            throw new Error(this.coreSupportError('rivalis.rooms is not available'))
        }
        if (typeof manager.definitions !== 'function') {
            throw new Error(this.coreSupportError('rivalis.rooms.definitions() is not available'))
        }
        if (typeof manager.keys !== 'function' || typeof manager.get !== 'function') {
            throw new Error(this.coreSupportError('rivalis.rooms.keys()/get() are not available'))
        }
        for (const id of manager.keys()) {
            const room = manager.get(id)
            if (room !== null && typeof room.type !== 'string') {
                throw new Error(this.coreSupportError(`Room.type is not available (room id=(${id}) has no string \`type\`)`))
            }
        }
    }

    private coreSupportError(detail: string): string {
        return `@rivalis/fleet requires @rivalis/core >= ${MIN_CORE_VERSION}: ${detail}. ` +
            `Upgrade @rivalis/core to >= ${MIN_CORE_VERSION} (the §4 additions: Room.type, RoomManager.definitions()).`
    }
}
