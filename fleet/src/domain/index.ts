/**
 * `domain/` barrel — the pure fleet data model (§6) and room-id helpers (§11).
 * No I/O, no wire-format concerns. Wire payloads (`../wire`) depend on these
 * types; nothing here depends on the wire layer.
 */

export * from './types'
export * from './roomId'
export * from './roomCreate'
export * from './errors'
