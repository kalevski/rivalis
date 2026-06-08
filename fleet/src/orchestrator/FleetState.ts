/**
 * Instances/rooms read model plus placement with in-flight capacity
 * reservations (§9 placement). The read model is **derivable from snapshots
 * alone** (hard design rule, §3): every field comes from a validated
 * `fleet/state` payload, never from the orchestrator's own (volatile) placement
 * records — in particular `RoomInfo.local` is the agent-reported `origin`, never
 * inferred here (§6).
 *
 * Scaffold note (task 003): implemented in task 007 (fleet state & placement)
 * and extended by task 008 (room-id uniqueness: charset, id reservation,
 * namespacing, post-restart tie-break).
 *
 * Concurrency model: Node is single-threaded, so `place()` selects *and*
 * reserves within one synchronous call — two concurrent placements can never
 * both claim the last slot. Each pending create counts as one room against
 * `maxRooms` until the reservation is released on ack, timeout, or rejection
 * (§9); this is what stops N concurrent requests piling onto one near-capacity
 * instance.
 */

import { randomBytes } from 'node:crypto'

import type { Logger } from '@toolcase/logging'

import { hash64 } from '../util/canonical'
import { NOOP_LOGGER } from '../util/logger'
import {
    FleetError,
    ROOM_ID_PATTERN,
    encodeRoomId,
    isValidRoomId,
    namespaceRoomId
} from '../domain'
import type {
    Capacity,
    FleetStats,
    InstanceInfo,
    PlacementRequest,
    PlacementStrategy,
    RoomInfo
} from '../domain'
import type { SyncPayload } from '../wire'

// FleetError now lives in `../domain/errors` (task 004) — re-exported here so the
// long-standing `import { FleetState, FleetError } from './FleetState'` call sites
// (and the test suite) keep working unchanged.
export { FleetError } from '../domain'

/** Placement input: the room type plus the optional §9 `PlacementRequest` knobs. */
export interface PlacementInput extends PlacementRequest {
    type: string
}

/**
 * In-flight capacity reservation handed back by `place()`. Holds one room slot
 * against the instance's `maxRooms` until `release()` is called (on ack,
 * timeout, or rejection — §9). Opaque token; callers only pass it back.
 */
export interface Reservation {
    id: string
    instanceId: string
}

/** Result of a placement decision: the chosen instance plus its capacity reservation. */
export interface Placement {
    instance: InstanceInfo
    reservation: Reservation
}

/**
 * In-flight room-id reservation handed back by `reserveRoomId()` (§11). Holds
 * the id against the fleet-wide uniqueness check until `releaseRoomId()` is
 * called (on ack, timeout, or rejection — same lifecycle as {@link Reservation}).
 * Two concurrent creates with the same explicit id can no longer both pass the
 * existence check and land on different instances.
 */
export interface RoomIdReservation {
    roomId: string
}

/** Construction seams: a logger (out-of-order drops, etc.) and an injectable RNG for tie-breaks. */
export interface FleetStateOptions {
    logger?: Logger
    /** Deterministic randomness for placement tie-breaks / the `random` strategy. */
    random?: () => number
}

/**
 * Internal per-instance record: the public `InstanceInfo` plus the protocol
 * bookkeeping (`seq`/`hash`) that must never leak into the read model.
 */
interface InstanceRecord {
    /** `info.rooms[].id` holds the RAW agent-reported id; the public id is derived in `resolve()`. */
    info: InstanceInfo
    /** Highest `seq` applied for this connection — a lower/equal seq is a dropped reorder (§7). */
    lastSeq: number
    /** Hash of the last applied snapshot — the orchestrator sends it as the poll's `knownHash` (§7). */
    lastHash: string
    /** Monotonic join order — drives the §11 post-restart duplicate-id tie-break (earliest wins). */
    joinSeq: number
}

/** One agent-reported room flattened for the §11 id-resolution pass. */
interface RoomEntry {
    instanceId: string
    processUid: string
    joinSeq: number
    /** Raw id the agent knows the room by — what a `destroy` command must carry. */
    rawId: string
    /** API-safe base id (raw id percent-encoded when outside the charset). */
    base: string
    origin: 'fleet' | 'local'
    room: RoomInfo
    /** Canonical or namespaced public id, assigned during resolution. */
    publicId: string
}

/** A public id mapped back to its owning instance and raw id (for command routing). */
interface ResolvedLocator {
    room: RoomInfo
    instanceId: string
    rawRoomId: string
}

/** Output of the id-resolution pass: instances with public room ids + lookup indexes. */
interface ResolvedView {
    instances: InstanceInfo[]
    /** Instance by id — O(1) `getInstance` and `touch`'s in-place `lastSyncAt` refresh. */
    byId: Map<string, InstanceInfo>
    byPublicId: Map<string, ResolvedLocator>
}

export class FleetState {

    private readonly logger: Logger
    private readonly random: () => number

    /** Read model, keyed by connection-scoped `instanceId` (a reconnect is a new key). */
    private readonly records = new Map<string, InstanceRecord>()

    /** Live capacity reservations: token → instanceId. */
    private readonly reservations = new Map<string, string>()
    /** Reserved room slots per instance, derived from `reservations` for O(1) headroom checks. */
    private readonly reservedByInstance = new Map<string, number>()
    private reservationSeq = 0

    /** Room ids reserved by in-flight creates (§11) — held until ack/timeout/rejection. */
    private readonly reservedRoomIds = new Set<string>()

    /**
     * Room ids whose create has settled (acked OK or timed out) but whose room has
     * not yet appeared in an applied snapshot from the owning instance (task 003).
     * The id reservation is held *past* the command settle: releasing it on ack/timeout
     * would free the id for up to one `heartbeatMs` before the room reconciles into the
     * read model — the window in which the §10 retry-after-504 (or an immediate
     * re-create) re-reserves the id and double-creates on a *different* instance, the
     * exact cross-instance duplicate §11 exists to prevent. Keyed `roomId → owning
     * instanceId`; cleared when the owning instance's next snapshot/poll reconciles
     * (the read model takes over) or it is evicted. Held entries count toward both
     * id-uniqueness ({@link isRoomIdTaken}) and `maxRooms` headroom ({@link hasHeadroom}).
     */
    private readonly pendingRoomIds = new Map<string, string>()
    /** Pending-visibility room count per instance, for O(1) `maxRooms` headroom (task 003). */
    private readonly pendingByInstance = new Map<string, number>()

    /** Monotonic join counter — assigns each instance its tie-break order (§11). */
    private joinCounter = 0

    /**
     * Instances the orchestrator has marked stale (wedged: connected but silent
     * past 2×heartbeat — §7). Liveness bookkeeping, not snapshot-derived semantic
     * state: it is **excluded from `stateHash`** (like `lastSyncAt`) but **excludes
     * the instance from auto-placement**, so a wedged-yet-least-loaded node cannot
     * keep winning placement until it is evicted at 3×heartbeat.
     */
    private readonly staleInstances = new Set<string>()

    /**
     * Agent-acked-but-not-yet-snapshotted status, kept for PLACEMENT candidacy only
     * (task 004). On a `drain`/`undrain` ack the agent has already flipped its
     * agent-owned status (§7), but the read-model `status` only catches up at the
     * instance's next poll reply — up to one `heartbeatMs` later. Until then
     * `place()` would still see the stale value and keep selecting a just-drained
     * node (or keep excluding a just-undrained one). Like {@link staleInstances},
     * this is a placement-only override: it is **excluded from `stateHash`** and the
     * read model, and it **never writes the agent-owned `status`** (§7 status
     * ownership stays intact) — it only shifts what {@link place} treats as the
     * instance's effective status. Keyed `instanceId → effective status`; cleared the
     * moment a snapshot/poll reconciles the matching status into the read model (the
     * override has done its job) or the instance is removed.
     */
    private readonly pendingStatus = new Map<string, 'active' | 'draining'>()

    /**
     * Memoized id-resolution pass ({@link resolve}) and {@link computeStateHash}
     * result. The resolution is O(rooms) — flatten every room, group by base id,
     * sort the collision buckets, build the public-id index, clone every instance —
     * and was previously rebuilt on **every** read-model query (`stats`/`instances`/
     * `rooms`/`getRoom`/…); one `GET /v1/stats` alone resolves ≥2×. Both are now
     * computed lazily and held until the next SEMANTIC mutation.
     *
     * Invalidated by exactly the two mutations that change semantic state:
     * {@link applySnapshot} (when it actually applies) and {@link removeInstance}.
     * {@link touch} (advances `lastSyncAt`) and {@link setStale} are non-semantic —
     * both are excluded from `stateHash` (§6) and from the resolution — so neither
     * invalidates; `touch` instead keeps the cached `InstanceInfo.lastSyncAt` in step
     * in place (see below). `null` ⇒ dirty, rebuild on next read.
     *
     * Read-only contract: the cached `InstanceInfo` / `RoomInfo` objects are now
     * SHARED across callers and across queries (a query no longer clones afresh).
     * They must be treated as immutable by consumers; the only sanctioned in-place
     * write is `touch`'s `lastSyncAt` refresh, which is liveness bookkeeping outside
     * both the resolution and the hash. The `instances`/`rooms`/`findRooms` getters
     * still hand back a fresh array container so a caller's `sort()`/`push()` cannot
     * corrupt the memo — only the element objects are shared.
     */
    private resolvedView: ResolvedView | null = null
    private cachedStateHash: string | null = null

    constructor(options: FleetStateOptions = {}) {
        this.logger = options.logger ?? NOOP_LOGGER
        this.random = options.random ?? Math.random
    }

    // -----------------------------------------------------------------------
    // Read model mutation (driven by the fleet room — task 009)
    // -----------------------------------------------------------------------

    /**
     * Apply a validated full `fleet/state` snapshot to the read model. Returns `true`
     * when applied, `false` when dropped as an out-of-order/duplicate frame.
     *
     * `seq` is per-connection monotonic (§7); a frame whose `seq` does not
     * strictly exceed the last applied one is **dropped, never applied** — this
     * turns a hypothetical agent-side send-queue bug into a lost frame instead of
     * read-model corruption (§7, §14). Field validation (§13) happens upstream;
     * this method trusts the payload's shape.
     */
    applySnapshot(instanceId: string, payload: SyncPayload, lastSyncAt: number): boolean {
        const existing = this.records.get(instanceId)
        if (existing !== undefined && payload.seq <= existing.lastSeq) {
            this.logger.warning(
                `fleet: dropped out-of-order snapshot from instance=${instanceId} ` +
                `(seq=${payload.seq} <= last=${existing.lastSeq})`
            )
            return false
        }
        const info = buildInstanceInfo(instanceId, payload, lastSyncAt)
        // joinSeq is stamped once, when the connection first appears, and preserved
        // across snapshot updates so the §11 tie-break (earliest joiner keeps the
        // canonical id) is stable for the life of the connection.
        const joinSeq = existing?.joinSeq ?? ++this.joinCounter
        this.records.set(instanceId, { info, lastSeq: payload.seq, lastHash: payload.hash, joinSeq })
        this.invalidate()
        // The applied snapshot is now ground truth for this instance: any held
        // pending-visibility id is either present (read model holds it) or genuinely
        // gone — either way the hold has served its purpose (task 003).
        this.clearPendingVisibility(instanceId)
        // The read-model status just refreshed from the agent's snapshot — if it now
        // matches a pending placement override, the override is redundant (task 004).
        this.reconcilePendingStatus(instanceId)
        return true
    }

    /**
     * Bump an instance's `lastSyncAt` without touching semantic state (used on
     * a hash-only `fleet/state` reply). Deliberately does **not** affect `stateHash` — liveness
     * bookkeeping is excluded so a quiet fleet still produces ETag 304s (§6, §10).
     */
    touch(instanceId: string, lastSyncAt: number): void {
        const record = this.records.get(instanceId)
        if (record === undefined) {
            return
        }
        record.info.lastSyncAt = lastSyncAt
        // A hash-only reply confirms the agent's current state equals the last applied
        // snapshot (its hash matched the poll's knownHash), so the last-applied room set
        // is current truth — resolve any pending-visibility hold for this instance
        // against it (task 003). A create that truly failed (no new room → hash
        // unchanged → hash-only reply) thus frees its id within one poll, not only on
        // the every-12-poll forced full.
        this.clearPendingVisibility(instanceId)
        // Same logic for a placement override (task 004): the last-applied status is
        // current truth, so an override matching it is confirmed and can be dropped.
        // (A status flip changes the hash → a full reply, never a hash-only one, so this
        // only clears an idempotent drain/undrain whose status never actually moved.)
        this.reconcilePendingStatus(instanceId)
        // `lastSyncAt` is liveness bookkeeping — excluded from the resolution and the
        // stateHash (§6) — so a ping must NOT invalidate the memoized view. Keep the
        // cached InstanceInfo's `lastSyncAt` in step with the live record so reads
        // (which return the shared cached object) stay fresh, exactly as the pre-cache
        // per-query clone reflected the live value. No effect when the view is dirty.
        const cached = this.resolvedView?.byId.get(instanceId)
        if (cached !== undefined) {
            cached.lastSyncAt = lastSyncAt
        }
    }

    /** Remove an instance from the read model (socket close or eviction, §7). */
    removeInstance(instanceId: string): InstanceInfo | null {
        const record = this.records.get(instanceId)
        if (record === undefined) {
            return null
        }
        this.records.delete(instanceId)
        this.staleInstances.delete(instanceId)
        this.pendingStatus.delete(instanceId)
        // The instance's rooms vanish from the read model on eviction/close, so any
        // held pending-visibility id is released too — no leak (task 003).
        this.clearPendingVisibility(instanceId)
        this.invalidate()
        return record.info
    }

    /**
     * Mark/unmark an instance stale (orchestrator liveness — §7). A stale instance
     * stays in the read model and the `stateHash` (so dashboards keep seeing it
     * until eviction) but is dropped from auto-placement candidacy. Cleared
     * automatically on {@link removeInstance}.
     */
    setStale(instanceId: string, stale: boolean): void {
        if (stale) {
            this.staleInstances.add(instanceId)
        } else {
            this.staleInstances.delete(instanceId)
        }
    }

    /**
     * Record an agent-acked-but-not-yet-snapshotted status for PLACEMENT only
     * (task 004) — called on a `drain`/`undrain` ack, where the agent has already
     * flipped its status (§7) but the read model lags by up to one poll. `place()`
     * reads this through {@link effectiveStatus} so candidacy converges at ack time
     * (`drain` excludes the node, `undrain` re-includes it) instead of one poll
     * interval later. Never writes the agent-owned read-model `status` and is absent
     * from `stateHash`, so §7 status ownership and the §10 ETag are untouched. The
     * override clears itself once a snapshot reconciles the matching status (see
     * {@link reconcilePendingStatus}). No-op on an unknown instance — there is nothing
     * to place onto, and a later join starts clean.
     */
    setPendingStatus(instanceId: string, status: 'active' | 'draining'): void {
        if (!this.records.has(instanceId)) {
            return
        }
        this.pendingStatus.set(instanceId, status)
    }

    /** Hash of the last applied snapshot for an instance (sent as the poll `knownHash` for dedup, §7). */
    lastHashOf(instanceId: string): string | null {
        return this.records.get(instanceId)?.lastHash ?? null
    }

    // -----------------------------------------------------------------------
    // Read model queries (§9)
    // -----------------------------------------------------------------------

    get instances(): InstanceInfo[] {
        // Fresh array container (cheap reference copy) over the shared cached
        // InstanceInfo objects, so a caller's sort()/push() can't corrupt the memo.
        return [...this.resolve().instances]
    }

    get rooms(): RoomInfo[] {
        const rooms: RoomInfo[] = []
        for (const instance of this.resolve().instances) {
            rooms.push(...instance.rooms)
        }
        return rooms
    }

    get stats(): FleetStats {
        const instances = this.resolve().instances
        let connections = 0
        let rooms = 0
        const roomTypes = new Set<string>()
        for (const instance of instances) {
            connections += instance.connections
            rooms += instance.rooms.length
            for (const type of instance.roomTypes) {
                roomTypes.add(type)
            }
        }
        if (this.cachedStateHash === null) {
            this.cachedStateHash = this.computeStateHash(instances)
            this.logger.debug('fleet: computed semantic state hash')
        }
        return {
            instances: instances.length,
            rooms,
            connections,
            roomTypes: [...roomTypes].sort(),
            stateHash: this.cachedStateHash
        }
    }

    getInstance(id: string): InstanceInfo | null {
        return this.resolve().byId.get(id) ?? null
    }

    /**
     * Resolve an instance by its stable `processUid` (§6 pinning) to the **most
     * recent connection** — the record with the highest `joinSeq` (task 011). During
     * a reconnect overlap two records share a `processUid` (the live new connection
     * plus the old wedged one not yet evicted, up to 3 poll intervals); `processUid`
     * is the documented *stable* handle across reconnects, so it must resolve to the
     * live connection. First-match (map insertion order) would pick the OLDEST — the
     * dead connection in exactly the scenario `processUid` pinning exists for.
     */
    getInstanceByProcessUid(processUid: string): InstanceInfo | null {
        const record = this.latestRecordByProcessUid(processUid)
        return record === null ? null : this.resolve().byId.get(record.info.id) ?? null
    }

    /** Look up a room by its PUBLIC id (canonical, namespaced, or percent-encoded — §11). */
    getRoom(roomId: string): RoomInfo | null {
        return this.resolve().byPublicId.get(roomId)?.room ?? null
    }

    /**
     * Map a public room id (possibly namespaced or percent-encoded) back to its
     * owning instance and the RAW id the agent knows it by — what a `fleet/cmd`
     * `destroy` must carry, since the agent never sees the public id (§11). Returns
     * null when no room has that public id.
     */
    resolveRoom(roomId: string): { instanceId: string; rawRoomId: string } | null {
        const locator = this.resolve().byPublicId.get(roomId)
        if (locator === undefined) {
            return null
        }
        return { instanceId: locator.instanceId, rawRoomId: locator.rawRoomId }
    }

    /** Rooms cluster-wide, filtered by type / owning instance / owning-instance labels (§9). */
    findRooms(filter: { type?: string; instanceId?: string; labels?: Record<string, string> } = {}): RoomInfo[] {
        const result: RoomInfo[] = []
        for (const instance of this.resolve().instances) {
            if (filter.instanceId !== undefined && instance.id !== filter.instanceId) {
                continue
            }
            if (filter.labels !== undefined && !matchesLabels(instance.labels, filter.labels)) {
                continue
            }
            for (const room of instance.rooms) {
                if (filter.type !== undefined && room.type !== filter.type) {
                    continue
                }
                result.push(room)
            }
        }
        return result
    }

    // -----------------------------------------------------------------------
    // Placement (§9)
    // -----------------------------------------------------------------------

    /**
     * Select an instance for a new room and reserve a capacity slot on it,
     * atomically (§9). Throws a coded {@link FleetError} on validation /
     * no-candidate / draining-pin. The reservation must be released by the
     * caller on ack, timeout, or rejection.
     */
    place(request: PlacementInput): Placement {
        if (request.instanceId !== undefined && request.processUid !== undefined) {
            throw new FleetError('VALIDATION', 'specify at most one of placement.instanceId or placement.processUid')
        }

        // Pinned placement bypasses scoring and the type/labels/capacity filters
        // — the caller chose this instance explicitly — but NOT the status and
        // autoCreate filters (§9): silently landing on a draining node mid-deploy
        // is exactly the surprise `status` exists to prevent.
        if (request.instanceId !== undefined || request.processUid !== undefined) {
            // Placement reads only counts/capacity/status — never room ids — so it
            // works off the raw records and skips the §11 id-resolution pass.
            const instance = request.instanceId !== undefined
                ? this.rawInstanceById(request.instanceId)
                : this.rawInstanceByProcessUid(request.processUid as string)
            if (instance === null) {
                const which = request.instanceId !== undefined
                    ? `instanceId=${request.instanceId}`
                    : `processUid=${request.processUid}`
                throw new FleetError('INSTANCE_NOT_FOUND', `no instance matches ${which}`)
            }
            if (this.effectiveStatus(instance) === 'draining' && request.force !== true) {
                throw new FleetError(
                    'INSTANCE_DRAINING',
                    `instance ${instance.id} is draining; pin requires force: true`
                )
            }
            // Pinning also respects staleness (task 011): a stale instance (2 missed
            // poll replies — likely wedged/disconnecting) would otherwise sit until
            // COMMAND_TIMEOUT, while strategy placement already excludes it (filter
            // below). Fail fast with a coded, retryable INSTANCE_DISCONNECTED (502)
            // — the caller re-looks-up and retries — gated by `force: true` to mirror
            // the draining rule for callers that knowingly accept the risk.
            if (this.staleInstances.has(instance.id) && request.force !== true) {
                throw new FleetError(
                    'INSTANCE_DISCONNECTED',
                    `instance ${instance.id} is stale (missed poll replies); pin requires force: true`
                )
            }
            if (!instance.autoCreate) {
                throw new FleetError('NO_CANDIDATE', `instance ${instance.id} has autoCreate disabled`)
            }
            return { instance, reservation: this.reserve(instance.id) }
        }

        // Strategy-based placement (§9 step 1: filter). Raw records: room ids are
        // irrelevant here, and the count used for headroom is identical either way.
        const candidates = this.rawInstances().filter((instance) =>
            this.effectiveStatus(instance) === 'active' &&
            !this.staleInstances.has(instance.id) &&
            instance.autoCreate === true &&
            instance.roomTypes.includes(request.type) &&
            (request.labels === undefined || matchesLabels(instance.labels, request.labels)) &&
            this.hasHeadroom(instance)
        )
        if (candidates.length === 0) {
            throw new FleetError('NO_CANDIDATE', `no active instance can host room type "${request.type}"`)
        }

        const instance = this.pick(candidates, request.strategy ?? 'least-loaded')
        return { instance, reservation: this.reserve(instance.id) }
    }

    /** Release a capacity reservation (on ack, timeout, or rejection — §9). Idempotent. */
    release(reservation: Reservation): void {
        if (!this.reservations.delete(reservation.id)) {
            return
        }
        const count = this.reservedByInstance.get(reservation.instanceId) ?? 0
        if (count <= 1) {
            this.reservedByInstance.delete(reservation.instanceId)
        } else {
            this.reservedByInstance.set(reservation.instanceId, count - 1)
        }
    }

    /** Reserved (in-flight) room slots currently held against an instance. */
    reservedRooms(instanceId: string): number {
        return this.reservedByInstance.get(instanceId) ?? 0
    }

    // -----------------------------------------------------------------------
    // Room-id uniqueness & reservation (§11)
    // -----------------------------------------------------------------------

    /**
     * Validate, uniqueness-check, and reserve a room id for an in-flight create
     * (§11). When `roomId` is omitted a collision-free `r_<id>` within the charset
     * is generated. Throws {@link FleetError} `VALIDATION` (explicit id outside the
     * charset) or `ROOM_EXISTS` (id already in the fleet or already reserved). The
     * reservation closes the race window: two concurrent creates with the same
     * explicit id cannot both pass — exactly one reserves, the rest fail fast. The
     * caller must `releaseRoomId` on ack, timeout, or rejection.
     */
    reserveRoomId(roomId?: string): RoomIdReservation {
        if (roomId === undefined) {
            const generated = this.generateFreeRoomId()
            this.reservedRoomIds.add(generated)
            return { roomId: generated }
        }
        if (!isValidRoomId(roomId)) {
            throw new FleetError('VALIDATION', `roomId "${roomId}" must match ${ROOM_ID_PATTERN.source}`)
        }
        if (this.isRoomIdTaken(roomId)) {
            throw new FleetError('ROOM_EXISTS', `room id "${roomId}" already exists or is reserved`)
        }
        this.reservedRoomIds.add(roomId)
        return { roomId }
    }

    /** Release a room-id reservation (on ack, timeout, or rejection — §11). Idempotent. */
    releaseRoomId(reservation: RoomIdReservation): void {
        this.reservedRoomIds.delete(reservation.roomId)
    }

    /**
     * Transition a create's reservations from *in-flight* to *pending-visibility*
     * (task 003) — called by the command engine when a create **acks OK or times
     * out**, instead of releasing. The room id stays reserved and one `maxRooms` slot
     * stays counted until the owning instance's next snapshot/poll reconciles the room
     * into the read model (or it is evicted). This closes the §11 window where a
     * `504`-then-retry (§10) or an ack-then-immediate re-create would re-reserve the id
     * after the command settled but before the room was visible, and double-create it on
     * another instance. The original capacity reservation token is released and both
     * holds collapse into one pending-visibility entry (still one id, one room slot).
     */
    holdUntilVisible(roomIdReservation: RoomIdReservation, reservation: Reservation): void {
        // Free the in-flight capacity token; the pending-visibility entry now carries
        // the headroom slot in its place (see hasHeadroom).
        this.release(reservation)
        this.reservedRoomIds.delete(roomIdReservation.roomId)
        if (this.pendingRoomIds.has(roomIdReservation.roomId)) {
            return
        }
        this.pendingRoomIds.set(roomIdReservation.roomId, reservation.instanceId)
        this.pendingByInstance.set(
            reservation.instanceId,
            (this.pendingByInstance.get(reservation.instanceId) ?? 0) + 1
        )
    }

    /** Acked-but-not-yet-visible room slots held against an instance (task 003). */
    pendingRooms(instanceId: string): number {
        return this.pendingByInstance.get(instanceId) ?? 0
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /**
     * A public id is taken when an in-flight reservation holds it, a settled-but-not-
     * yet-visible create holds it (task 003), or a live room already uses it.
     */
    private isRoomIdTaken(roomId: string): boolean {
        return this.reservedRoomIds.has(roomId) || this.pendingRoomIds.has(roomId) || this.getRoom(roomId) !== null
    }

    /**
     * Clear every pending-visibility hold for an instance (task 003) — called when the
     * instance's snapshot/poll reconciles its room set (the read model now holds
     * whatever rooms truly exist) or when it is evicted (its rooms vanish). Either way
     * the in-flight hold has done its job: a present room is taken via the read model,
     * an absent one is genuinely free. Idempotent.
     */
    private clearPendingVisibility(instanceId: string): void {
        if (this.pendingByInstance.get(instanceId) === undefined) {
            return
        }
        for (const [roomId, owner] of [...this.pendingRoomIds]) {
            if (owner === instanceId) {
                this.pendingRoomIds.delete(roomId)
            }
        }
        this.pendingByInstance.delete(instanceId)
    }

    /**
     * The status `place()` should treat the instance as having (task 004): the
     * pending placement override when one is held, else the snapshot-derived
     * read-model `status`. The override exists only between a `drain`/`undrain` ack
     * and the snapshot that confirms it.
     */
    private effectiveStatus(instance: InstanceInfo): 'active' | 'draining' {
        return this.pendingStatus.get(instance.id) ?? instance.status
    }

    /**
     * Drop the placement override once the read model has caught up (task 004) — i.e.
     * the last-applied snapshot's status now equals the pending value. Called on every
     * snapshot apply and hash-only poll reply. Idempotent; no-op when no override is held.
     */
    private reconcilePendingStatus(instanceId: string): void {
        const pending = this.pendingStatus.get(instanceId)
        if (pending !== undefined && this.records.get(instanceId)?.info.status === pending) {
            this.pendingStatus.delete(instanceId)
        }
    }

    /** Generate a `r_<id>` not currently reserved or in use; near-certain on the first try. */
    private generateFreeRoomId(): string {
        for (let attempt = 0; attempt < 1000; attempt++) {
            const candidate = generateRoomId()
            if (!this.isRoomIdTaken(candidate)) {
                return candidate
            }
        }
        // 21 random charset chars (~126 bits) make a collision astronomically
        // unlikely; fail loud rather than spin forever if the impossible happens.
        throw new FleetError('ROOM_EXISTS', 'could not generate a unique room id after 1000 attempts')
    }

    /** Raw read-model rows (raw room ids) — the placement candidate source. */
    private rawInstances(): InstanceInfo[] {
        return [...this.records.values()].map((record) => record.info)
    }

    private rawInstanceById(id: string): InstanceInfo | null {
        return this.records.get(id)?.info ?? null
    }

    private rawInstanceByProcessUid(processUid: string): InstanceInfo | null {
        return this.latestRecordByProcessUid(processUid)?.info ?? null
    }

    /**
     * The record for `processUid` with the highest `joinSeq` — the most recent
     * connection (task 011). Shared by {@link getInstanceByProcessUid} (read API)
     * and the pinned {@link place} path so both resolve a reconnect-overlapped
     * `processUid` to the live connection, never the wedged old one.
     */
    private latestRecordByProcessUid(processUid: string): InstanceRecord | null {
        let latest: InstanceRecord | null = null
        for (const record of this.records.values()) {
            if (record.info.processUid === processUid && (latest === null || record.joinSeq > latest.joinSeq)) {
                latest = record
            }
        }
        return latest
    }

    /**
     * Resolve raw agent-reported room ids into the fleet-unique PUBLIC id space
     * (§11). Pure function of the current read model — derivable from snapshots
     * alone (§3), so it survives an orchestrator restart. Rules:
     *  - Local ids outside the charset are percent-encoded ({@link encodeRoomId}).
     *  - When several rooms map to the same base id, exactly one keeps it: a
     *    `fleet` room beats a `local` one, then the earliest joiner wins, then the
     *    lower instance id (deterministic — never map-iteration order). The losers
     *    surface namespaced as `<processUid>~<base>`, flagged `local` per their own
     *    origin. Two `fleet` rooms colliding can only happen across a restart, so
     *    that case is logged naming both instances (post-restart tie-break, §11).
     */
    private resolve(): ResolvedView {
        if (this.resolvedView !== null) {
            return this.resolvedView
        }
        const entries: RoomEntry[] = []
        for (const record of this.records.values()) {
            for (const room of record.info.rooms) {
                entries.push({
                    instanceId: record.info.id,
                    processUid: record.info.processUid,
                    joinSeq: record.joinSeq,
                    rawId: room.id,
                    base: encodeRoomId(room.id),
                    origin: room.local ? 'local' : 'fleet',
                    room,
                    publicId: ''
                })
            }
        }

        const groups = new Map<string, RoomEntry[]>()
        for (const entry of entries) {
            const bucket = groups.get(entry.base)
            if (bucket === undefined) {
                groups.set(entry.base, [entry])
            } else {
                bucket.push(entry)
            }
        }

        for (const [base, bucket] of groups) {
            if (bucket.length === 1) {
                (bucket[0] as RoomEntry).publicId = base
                continue
            }
            const ordered = [...bucket].sort(compareForCanonical)
            const keeper = ordered[0] as RoomEntry
            keeper.publicId = base
            for (const entry of ordered) {
                if (entry !== keeper) {
                    entry.publicId = namespaceRoomId(entry.processUid, base)
                }
            }
            // Two fleet rooms with the same id is the §11 post-restart case: make it
            // visible (nothing hidden, nothing destroyed) and name both instances.
            const fleetDuplicates = ordered.filter((entry) => entry.origin === 'fleet')
            if (fleetDuplicates.length > 1) {
                for (const loser of fleetDuplicates) {
                    if (loser !== keeper) {
                        this.logger.warning(
                            `fleet: duplicate room id "${base}" reported by instance ${keeper.instanceId} ` +
                            `(joined earliest, keeps the canonical id) and instance ${loser.instanceId} ` +
                            `(surfaced as "${loser.publicId}") — §11 post-restart tie-break, no room hidden or destroyed`
                        )
                    }
                }
            }
        }

        const roomsByInstance = new Map<string, RoomInfo[]>()
        const byPublicId = new Map<string, ResolvedLocator>()
        for (const entry of entries) {
            const room: RoomInfo = { ...entry.room, id: entry.publicId }
            const list = roomsByInstance.get(entry.instanceId)
            if (list === undefined) {
                roomsByInstance.set(entry.instanceId, [room])
            } else {
                list.push(room)
            }
            byPublicId.set(entry.publicId, { room, instanceId: entry.instanceId, rawRoomId: entry.rawId })
        }

        const instances: InstanceInfo[] = []
        const byId = new Map<string, InstanceInfo>()
        for (const record of this.records.values()) {
            const instance: InstanceInfo = { ...record.info, rooms: roomsByInstance.get(record.info.id) ?? [] }
            instances.push(instance)
            byId.set(instance.id, instance)
        }
        this.logger.debug('fleet: rebuilt id-resolution view')
        this.resolvedView = { instances, byId, byPublicId }
        return this.resolvedView
    }

    /**
     * Drop the memoized resolution + state hash. Called by the two SEMANTIC
     * mutations only ({@link applySnapshot}, {@link removeInstance}); the next read
     * rebuilds. Non-semantic mutations ({@link touch}, {@link setStale}) never call
     * this — see {@link resolvedView}.
     */
    private invalidate(): void {
        this.resolvedView = null
        this.cachedStateHash = null
    }

    private reserve(instanceId: string): Reservation {
        const id = `res_${++this.reservationSeq}`
        this.reservations.set(id, instanceId)
        this.reservedByInstance.set(instanceId, (this.reservedByInstance.get(instanceId) ?? 0) + 1)
        return { id, instanceId }
    }

    /**
     * Headroom against capacity, counting in-flight reservations as rooms (§9).
     * A pending create occupies a room slot but contributes no connections (the
     * room is empty until clients join), so reservations gate `maxRooms` only;
     * `maxConnections` is gated by the real connection count.
     */
    private hasHeadroom(instance: InstanceInfo): boolean {
        const capacity = instance.capacity
        if (capacity.maxRooms !== null) {
            // In-flight reservations AND acked-but-not-yet-visible rooms (task 003) both
            // occupy a slot: an acked room not yet in the snapshot would otherwise let
            // `maxRooms` over-admit until the next poll reconciles it.
            const projected = instance.rooms.length + this.reservedRooms(instance.id) + this.pendingRooms(instance.id)
            if (projected >= capacity.maxRooms) {
                return false
            }
        }
        if (capacity.maxConnections !== null && instance.connections >= capacity.maxConnections) {
            return false
        }
        return true
    }

    /**
     * Pick among filtered candidates (§9 steps 2–3). `least-loaded`/`most-loaded`
     * score by `connections / maxConnections` only when *every* candidate
     * declares `maxConnections`; if any leaves it undeclared, all are scored by
     * raw `connections` (a normalized 0.93 and a raw 1500 are not comparable).
     * Ties are broken randomly; `random` ignores load entirely.
     */
    private pick(candidates: InstanceInfo[], strategy: PlacementStrategy): InstanceInfo {
        if (strategy === 'random') {
            return this.choose(candidates)
        }
        const allDeclare = candidates.every((instance) => instance.capacity.maxConnections !== null)
        const scoreOf = (instance: InstanceInfo): number => allDeclare
            ? instance.connections / (instance.capacity.maxConnections as number)
            : instance.connections

        let best = scoreOf(candidates[0] as InstanceInfo)
        for (const instance of candidates) {
            const score = scoreOf(instance)
            best = strategy === 'most-loaded' ? Math.max(best, score) : Math.min(best, score)
        }
        const tied = candidates.filter((instance) => scoreOf(instance) === best)
        return this.choose(tied)
    }

    /** Uniform random choice from a non-empty list (placement tie-break / `random` strategy). */
    private choose(list: InstanceInfo[]): InstanceInfo {
        const index = Math.floor(this.random() * list.length)
        // Clamp defensively: a `random()` returning exactly 1 would index past the end.
        return list[Math.min(index, list.length - 1)] as InstanceInfo
    }

    /**
     * Hash of SEMANTIC fleet state only (§6): instances, rooms, counts, statuses,
     * capacities, versions — explicitly EXCLUDING `lastSyncAt` and all liveness
     * bookkeeping, so the §10 ETag does not churn on every heartbeat. Order-
     * independent: instances are sorted by id before encoding.
     */
    private computeStateHash(instances: InstanceInfo[]): string {
        const projection = instances
            .map((instance) => ({
                id: instance.id,
                name: instance.name,
                processUid: instance.processUid,
                endpointUrl: instance.endpointUrl,
                labels: instance.labels,
                roomTypes: instance.roomTypes,
                connections: instance.connections,
                capacity: instance.capacity,
                autoCreate: instance.autoCreate,
                status: instance.status,
                agentVersion: instance.agentVersion,
                protocolVersion: instance.protocolVersion,
                rooms: instance.rooms.map((room) => ({
                    id: room.id,
                    type: room.type,
                    connections: room.connections,
                    instanceId: room.instanceId,
                    endpointUrl: room.endpointUrl,
                    local: room.local
                }))
            }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        return hash64(projection)
    }
}

/** Build the read-model `InstanceInfo` from a snapshot (connections summed from rooms, §6). */
function buildInstanceInfo(instanceId: string, payload: SyncPayload, lastSyncAt: number): InstanceInfo {
    const rooms: RoomInfo[] = payload.rooms.map((room) => ({
        id: room.id,
        type: room.type,
        connections: room.connections,
        instanceId,
        // Denormalized from the owning instance so room lookups carry the URL (§6).
        endpointUrl: payload.endpointUrl,
        // Provenance is the agent's call, never inferred here (§6).
        local: room.origin === 'local'
    }))
    let connections = 0
    for (const room of rooms) {
        connections += room.connections
    }
    return {
        id: instanceId,
        name: payload.name,
        processUid: payload.processUid,
        endpointUrl: payload.endpointUrl,
        labels: payload.labels,
        roomTypes: payload.roomTypes,
        rooms,
        connections,
        capacity: payload.capacity,
        autoCreate: payload.autoCreate,
        status: payload.status,
        lastSyncAt,
        agentVersion: payload.agentVersion,
        protocolVersion: payload.protocolVersion
    }
}

/** True when `instanceLabels` contains every key/value pair in `required`. */
function matchesLabels(instanceLabels: Record<string, string>, required: Record<string, string>): boolean {
    for (const key of Object.keys(required)) {
        if (instanceLabels[key] !== required[key]) {
            return false
        }
    }
    return true
}

/**
 * Order rooms that share a base id so the first is the canonical keeper (§11):
 * `fleet` provenance beats `local`, then the earliest joiner, then the lower
 * instance id (total order — never map-iteration order, so the tie-break is
 * reproducible across restarts).
 */
function compareForCanonical(a: RoomEntry, b: RoomEntry): number {
    const rankA = a.origin === 'fleet' ? 0 : 1
    const rankB = b.origin === 'fleet' ? 0 : 1
    if (rankA !== rankB) {
        return rankA - rankB
    }
    if (a.joinSeq !== b.joinSeq) {
        return a.joinSeq - b.joinSeq
    }
    return a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0
}

/**
 * 64 charset characters (`A-Za-z0-9_-`), so each random byte maps to one with
 * `& 63` — uniform, no rejection sampling needed.
 */
const ROOM_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

/** Random chars after the `r_` prefix; 21 gives ~126 bits, well within the 64-char id cap. */
const ROOM_ID_RANDOM_LENGTH = 21

/**
 * Orchestrator-generated room id: `r_<21 charset chars>`, globally unique without
 * coordination (§11). `node:crypto` only — keeps the zero-runtime-dependency rule
 * (§5); a real dependency (e.g. nanoid) was deliberately avoided.
 */
function generateRoomId(): string {
    const bytes = randomBytes(ROOM_ID_RANDOM_LENGTH)
    let id = 'r_'
    for (let i = 0; i < ROOM_ID_RANDOM_LENGTH; i++) {
        id += ROOM_ID_ALPHABET[(bytes[i] as number) & 63] as string
    }
    return id
}

// Re-export the capacity type so the orchestrator can type placement plumbing
// without reaching back into the protocol module for this one alias.
export type { Capacity }
