/**
 * Declarative validation of agent-supplied `fleet/state` snapshots (§13). The §13
 * field caps live as a `@toolcase/node` {@link FieldSchema} next to the
 * {@link SyncPayload} wire type they guard — one source of truth, replacing the
 * former hand-rolled if-chain in `Orchestrator.ts`. The numeric caps are exported
 * as named constants and referenced by the schema, so raising one cap can never
 * drift from the rule that enforces it.
 *
 * "Agent data is authenticated, not trusted" (§13): a snapshot is bounds-checked
 * before it touches the read model. {@link validateSnapshot} returns `null` when
 * the snapshot is acceptable or a short, human-readable reason otherwise — a
 * reason that NEVER echoes an agent-supplied value (§13: rejection logs must not
 * carry attacker-controlled content).
 *
 * Three §13 checks a `FieldSchema` cannot express stay as small post-schema steps:
 *   1. `endpointUrl` must parse as a URL with an allow-listed scheme — the schema
 *      bounds its type/length, but URL semantics are not a `FieldRule`.
 *   2. `labels` is a free-form `Record<string,string>`; a `FieldRule` describes
 *      named fields and array items, not map entries, so the entry-count and
 *      per-key/value length caps have no rule equivalent.
 *   3. `rooms[]` is an array of objects; the schema caps the array length and that
 *      each entry is an object, but a `FieldRule`'s `items` is a single rule, not a
 *      nested field schema, so the per-room id/type length and connections ceiling
 *      have no rule equivalent.
 *
 * This module imports only the `FieldSchema`/`FieldRule` TYPES from
 * `@toolcase/node` (erased at build), so the wire layer — and the agent bundle
 * that depends on it — pulls no `@toolcase/node` runtime code (and thus no
 * eager-loaded Fastify; see the §5 sequencing caveat).
 */

import type { FieldRule, FieldSchema } from '@toolcase/node'
import type { SyncPayload } from './payloads'

// §13 snapshot field caps: these bound *semantic memory per agent* (the 4 MiB
// frame cap bounds bytes per frame) and limit the blast radius of the shared
// agent-key risk. Exported so the schema below — and any test — references one
// source of truth.
export const MAX_ENDPOINT_URL_LENGTH = 512
export const MAX_NAME_LENGTH = 64
export const MAX_LABELS = 32
export const MAX_LABEL_KEY_LENGTH = 64
export const MAX_LABEL_VALUE_LENGTH = 64
export const MAX_ROOM_TYPES = 256
// `rooms` is the largest snapshot field; without these caps only the 4 MiB frame
// bounds it, and percent-encoding can expand a hostile id ~3× past it in the read
// model (§13). `MAX_ROOMS` bounds the entry count; `MAX_ROOM_ID_LENGTH` /
// `MAX_ROOM_TYPE_LENGTH` bound a single entry's id/type (the latter also caps each
// `roomTypes` entry — the def-key reality is ≤ 64); `MAX_ROOM_CONNECTIONS` is a
// sanity ceiling on the wire-`uint32` per-room count so a hostile ~4.29e9 cannot
// inflate `FleetStats.connections` and skew `least-loaded` placement fleet-wide.
export const MAX_ROOMS = 50_000
export const MAX_ROOM_ID_LENGTH = 256
export const MAX_ROOM_TYPE_LENGTH = 64
export const MAX_ROOM_CONNECTIONS = 1_000_000

/** `endpointUrl` is handed verbatim to game clients and rendered by dashboards (§13). */
export const ALLOWED_ENDPOINT_SCHEMES = new Set(['ws:', 'wss:', 'http:', 'https:'])

/**
 * The §13 caps expressible as `FieldRule`s, declared next to {@link SyncPayload}.
 * Field order is the check order, so the first reason reported is deterministic.
 * The map-shaped `labels` caps, the per-room `rooms[]` field caps, and the URL
 * semantics of `endpointUrl` are enforced by the post-schema steps in
 * {@link validateSnapshot}.
 */
export const syncPayloadSchema: FieldSchema<SyncPayload> = {
    endpointUrl: { type: 'string', required: true, max: MAX_ENDPOINT_URL_LENGTH },
    name: { type: 'string', required: true, max: MAX_NAME_LENGTH },
    labels: { type: 'object', required: true },
    roomTypes: { type: 'array', required: true, max: MAX_ROOM_TYPES, items: { type: 'string', max: MAX_ROOM_TYPE_LENGTH } },
    rooms: { type: 'array', required: true, max: MAX_ROOMS, items: { type: 'object' } }
}

/**
 * Check a value against one {@link FieldRule}, returning a reason (never the value)
 * or `null`. Covers the rule kinds the snapshot schema uses: `required`, `type`
 * (string/number/integer/boolean/object/array), `min`/`max` (string length,
 * numeric bound, or array length), `pattern` (string), and `items` (array element
 * rule). Reasons name the field, never echo agent content (§13).
 */
function checkRule(field: string, value: unknown, rule: FieldRule): string | null {
    if (value === undefined || value === null) {
        return rule.required === true ? `${field} is required` : null
    }
    switch (rule.type) {
        case 'string':
            if (typeof value !== 'string') { return `${field} must be a string` }
            if (rule.max !== undefined && value.length > rule.max) { return `${field} exceeds ${rule.max} characters` }
            if (rule.min !== undefined && value.length < rule.min) { return `${field} must be at least ${rule.min} characters` }
            if (rule.pattern !== undefined && !new RegExp(rule.pattern).test(value)) { return `${field} has an invalid format` }
            return null
        case 'number':
        case 'integer':
            if (typeof value !== 'number' || (rule.type === 'integer' && !Number.isInteger(value))) { return `${field} must be a number` }
            if (rule.max !== undefined && value > rule.max) { return `${field} exceeds ${rule.max}` }
            if (rule.min !== undefined && value < rule.min) { return `${field} is below ${rule.min}` }
            return null
        case 'boolean':
            return typeof value === 'boolean' ? null : `${field} must be a boolean`
        case 'object':
            return typeof value === 'object' && !Array.isArray(value) ? null : `${field} must be an object`
        case 'array':
            if (!Array.isArray(value)) { return `${field} must be an array` }
            if (rule.max !== undefined && value.length > rule.max) { return `${field} exceeds ${rule.max} entries` }
            if (rule.min !== undefined && value.length < rule.min) { return `${field} must have at least ${rule.min} entries` }
            if (rule.items !== undefined) {
                for (const entry of value) {
                    const reason = checkRule(`${field} entry`, entry, rule.items)
                    if (reason !== null) { return reason }
                }
            }
            return null
        default:
            return null
    }
}

/** Walk a {@link FieldSchema} over `data`, returning the first failure reason or `null`. */
function checkSchema<T extends object>(schema: FieldSchema<T>, data: Record<string, unknown>): string | null {
    for (const key of Object.keys(schema) as Array<keyof T & string>) {
        const rule = schema[key]
        if (rule === undefined) { continue }
        const reason = checkRule(key, data[key], rule)
        if (reason !== null) { return reason }
    }
    return null
}

/**
 * Validate the security-sensitive fields of an agent-supplied snapshot (§13).
 * Returns `null` when the snapshot is acceptable, or a human-readable reason
 * (never containing agent-supplied values) when it must be rejected. The caller
 * drops a rejected snapshot with a logged warning and keeps the last good read
 * model (§13).
 */
export function validateSnapshot(payload: SyncPayload): string | null {
    const data = payload as unknown as Record<string, unknown>

    // 1. The FieldSchema-expressible caps (types + sizes + counts).
    const reason = checkSchema(syncPayloadSchema, data)
    if (reason !== null) {
        return reason
    }

    // 2. `endpointUrl` URL parse + scheme allowlist — keeps `javascript:` and
    // friends out of the read model and any dashboard that renders it. Not a
    // FieldRule, so it stays a post-schema step.
    let parsed: URL
    try {
        parsed = new URL(payload.endpointUrl)
    } catch {
        return 'endpointUrl is not a valid URL'
    }
    if (!ALLOWED_ENDPOINT_SCHEMES.has(parsed.protocol)) {
        // Never echo the agent-supplied scheme into the reason (§13).
        return 'endpointUrl scheme is not allowed'
    }

    // 3. `labels` map caps (entry count + per-key/value length) — no FieldRule
    // equivalent for a free-form Record, so enforced here.
    const labels = payload.labels as Record<string, unknown>
    const labelKeys = Object.keys(labels)
    if (labelKeys.length > MAX_LABELS) {
        return `labels exceeds ${MAX_LABELS} entries`
    }
    for (const key of labelKeys) {
        if (key.length > MAX_LABEL_KEY_LENGTH) {
            return `a label key exceeds ${MAX_LABEL_KEY_LENGTH} characters`
        }
        const value = labels[key]
        if (typeof value !== 'string' || value.length > MAX_LABEL_VALUE_LENGTH) {
            return `a label value is not a string of at most ${MAX_LABEL_VALUE_LENGTH} characters`
        }
    }

    // 4. `rooms[]` per-entry caps (id/type length, connections ceiling). The schema
    // above bounds the array length (MAX_ROOMS) and that each entry is an object; a
    // FieldRule's `items` is a single rule, not a nested schema, so the per-room
    // field caps are enforced here. Reasons name the field, never echo agent content
    // (§13) — a hostile room id can itself be megabytes.
    const rooms = payload.rooms as unknown as Array<Record<string, unknown>>
    for (const entry of rooms) {
        const id = entry.id
        if (typeof id !== 'string' || id.length > MAX_ROOM_ID_LENGTH) {
            return `a room id is not a string of at most ${MAX_ROOM_ID_LENGTH} characters`
        }
        const type = entry.type
        if (typeof type !== 'string' || type.length > MAX_ROOM_TYPE_LENGTH) {
            return `a room type is not a string of at most ${MAX_ROOM_TYPE_LENGTH} characters`
        }
        const connections = entry.connections
        if (typeof connections !== 'number' || connections > MAX_ROOM_CONNECTIONS) {
            return `a room connections value exceeds ${MAX_ROOM_CONNECTIONS}`
        }
    }
    return null
}
