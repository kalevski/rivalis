export { Orchestrator } from './orchestrator/Orchestrator'
export { FleetAgent } from './agent/FleetAgent'
// `FleetError` is a value export (the class embedders `instanceof`-match and read
// `.code` off, §9/§10) — without it on the public entry, coded-error branching
// forces an unsupported deep import into `lib/*` (task 010).
export { FleetError } from './domain'
export type { OrchestratorOptions } from './orchestrator/Config'
export type { FleetAgentOptions } from './agent/FleetAgent'
export type { FleetApi } from './orchestrator/Orchestrator'
export type {
    InstanceInfo, RoomInfo, FleetStats,
    PlacementRequest, PlacementStrategy,
    FleetEvent, FleetEventType, FleetErrorCode
} from './domain'
export { PROTOCOL_VERSION } from './wire'
