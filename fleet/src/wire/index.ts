/**
 * `wire/` barrel — wire-format constants (§7), per-topic payload types, and the
 * binary serializer codec (task 005). Depends on `../domain` for the pure types
 * its payloads reference; the domain layer never depends on wire.
 */

export * from './topics'
export * from './payloads'
export * from './snapshotSchema'
export { encodeFrame, decodeFrame, WireVersionError } from './serializer'
