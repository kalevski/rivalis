// Shared constants and tiny wire codec for the @rivalis/fleet demo.
//
// This demo runs an Orchestrator (control plane) plus several game-server
// instances (each a Rivalis process with a FleetAgent attached) in ONE node
// process, and drives them with a Matchmaker built on top of the fleet API.

/** Room type every game instance hosts; what the matchmaker places. */
export const MATCH_ROOM_TYPE = 'match'

/** Orchestrator WS + REST control-plane port (agents + admin connect here). */
export const ORCH_PORT = 7350
export const ORCH_URL = `ws://localhost:${ORCH_PORT}`

// Dev credentials. Two distinct keys (agent vs admin) — the fleet refuses
// intersecting key sets in production (audience separation, §13). 32+ chars so
// the strength check stays quiet. NEVER ship these; load from env in real use.
export const AGENT_KEY = 'fleet-demo-agent-key-change-me!!'
export const ADMIN_KEY = 'fleet-demo-admin-key-change-me!!'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array => encoder.encode(JSON.stringify(value))
export const decode = <T>(payload: Uint8Array): T => JSON.parse(decoder.decode(payload)) as T

// ---- match room protocol -------------------------------------------------

export type MatchPlayer = { id: string; name: string }
export type MatchState = { status: 'waiting' | 'playing'; players: MatchPlayer[] }
