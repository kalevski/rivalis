/**
 * Event reconciler (§9 events derived purely from the snapshot read model) —
 * extracted from the Orchestrator god class. Diffs the current read model against
 * the last-seen instances/rooms/stateHash and emits `instance:join`,
 * `room:create`, `room:destroy`, and `sync` events via the injected emit callback.
 * `instance:leave` is driven explicitly by teardown (the read model alone cannot
 * say *why* an instance vanished), so the Orchestrator calls {@link instanceRemoved}.
 * Holds no timers and performs no I/O, so it is unit-tested against a fake read
 * model (§15).
 */

import type { FleetEventType, FleetStats, InstanceInfo, RoomInfo } from '../domain'

/** The slice of the read model the reconciler diffs (satisfied by {@link FleetState}). */
export interface ReadModel {
    readonly instances: InstanceInfo[]
    readonly stats: FleetStats
}

export class EventReconciler {

    private readonly knownInstanceIds = new Set<string>()
    private readonly knownRooms = new Map<string, RoomInfo>()
    private lastStatsHash = ''

    constructor(
        private readonly state: ReadModel,
        private readonly emit: (event: FleetEventType, data: unknown) => void
    ) {}

    /**
     * Diff the read model and emit the derived events: `instance:join` for a new
     * instance, `room:create`/`room:destroy` for room churn, and `sync` whenever the
     * semantic `stateHash` changes. `instance:leave` is emitted by
     * {@link instanceRemoved}, not here.
     */
    reconcile(): void {
        const instances = this.state.instances
        const currentInstanceIds = new Set<string>()
        const currentRoomIds = new Set<string>()
        for (const instance of instances) {
            currentInstanceIds.add(instance.id)
            if (!this.knownInstanceIds.has(instance.id)) {
                this.knownInstanceIds.add(instance.id)
                this.emit('instance:join', instance)
            }
            for (const room of instance.rooms) {
                currentRoomIds.add(room.id)
                if (!this.knownRooms.has(room.id)) {
                    this.knownRooms.set(room.id, room)
                    this.emit('room:create', room)
                }
            }
        }
        for (const [roomId, room] of [...this.knownRooms]) {
            if (!currentRoomIds.has(roomId)) {
                this.knownRooms.delete(roomId)
                this.emit('room:destroy', room)
            }
        }
        for (const id of [...this.knownInstanceIds]) {
            if (!currentInstanceIds.has(id)) {
                this.knownInstanceIds.delete(id)
            }
        }
        const stats = this.state.stats
        if (stats.stateHash !== this.lastStatsHash) {
            this.lastStatsHash = stats.stateHash
            this.emit('sync', stats)
        }
    }

    /**
     * An instance was removed from the read model (socket close or eviction): forget
     * it and emit `instance:leave`. The caller follows with a {@link reconcile} so the
     * vanished instance's rooms surface as `room:destroy` and the `sync` fires.
     */
    instanceRemoved(removed: InstanceInfo): void {
        this.knownInstanceIds.delete(removed.id)
        this.emit('instance:leave', removed)
    }
}
