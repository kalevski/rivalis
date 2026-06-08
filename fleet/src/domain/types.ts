/**
 * Pure fleet data model (§6) — the read-model rows surfaced over the library and
 * REST APIs and the placement-request shape. No I/O, no wire-format concerns:
 * the agent builds `fleet/state` payloads (see `../wire`) which the orchestrator
 * validates into these `InstanceInfo`/`RoomInfo` rows.
 */

/** Lifecycle status of an instance (§6). The agent owns this value (§7). */
export type InstanceStatus = 'active' | 'draining'

/** Resolved capacity declaration; `null` means "unlimited" for that dimension. */
export interface Capacity {
    maxConnections: number | null
    maxRooms: number | null
}

export type PlacementStrategy = 'least-loaded' | 'most-loaded' | 'random'

export interface PlacementRequest {
    /** Pin to a connection-scoped instance id (see §9 pinning caveat). */
    instanceId?: string
    /** Pin to an instance by its stable process id. */
    processUid?: string
    strategy?: PlacementStrategy
    /** Only instances matching all listed labels are candidates. */
    labels?: Record<string, string>
    /** Pinning to a draining instance requires `force: true`. */
    force?: boolean
}

export interface InstanceInfo {
    id: string
    name: string
    processUid: string
    endpointUrl: string
    labels: Record<string, string>
    roomTypes: string[]
    rooms: RoomInfo[]
    connections: number
    capacity: Capacity
    autoCreate: boolean
    status: InstanceStatus
    lastSyncAt: number
    agentVersion: string
    protocolVersion: number
}

export interface RoomInfo {
    id: string
    type: string
    connections: number
    instanceId: string
    endpointUrl: string
    local: boolean
}

export interface FleetStats {
    instances: number
    rooms: number
    connections: number
    roomTypes: string[]
    stateHash: string
}

/** Stable, machine-readable error codes surfaced over REST (§10) and control APIs. */
export type FleetErrorCode =
    | 'VALIDATION'
    | 'UNAUTHORIZED'
    | 'INSTANCE_NOT_FOUND'
    | 'ROOM_NOT_FOUND'
    | 'NO_CANDIDATE'
    | 'ROOM_EXISTS'
    | 'INSTANCE_DRAINING'
    | 'PAYLOAD_TOO_LARGE'
    | 'INSTANCE_BUSY'
    | 'AUTH_THROTTLED'
    | 'SSE_LIMIT'
    | 'COMMAND_FAILED'
    | 'INSTANCE_DISCONNECTED'
    | 'COMMAND_TIMEOUT'

export type FleetEventType =
    | 'instance:join'
    | 'instance:leave'
    | 'instance:stale'
    | 'room:create'
    | 'room:destroy'
    | 'sync'

export interface FleetEvent {
    type: FleetEventType
    data?: unknown
}
