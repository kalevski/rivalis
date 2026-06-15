/**
 * Stable JSON encoding + truncated SHA-256 (64-bit) used for snapshot hash
 * dedup (§7) and the REST ETag (§10). Shared by both halves; `node:crypto`
 * only — no runtime dependency.
 *
 * The hash dedup's correctness rests entirely on encoding stability: two
 * logically-equal values (same keys/values, any insertion order) must always
 * encode to byte-identical strings, and one changed field must change the
 * output. `canonicalize` mirrors `JSON.stringify` semantics (skips `undefined`
 * / functions / symbols in objects, maps them to `null` in arrays, non-finite
 * numbers to `null`) but sorts object keys so order can never leak in.
 */

import { createHash } from 'node:crypto'

/**
 * Deterministic JSON encoding: object keys sorted, arrays left in order,
 * numbers/strings formatted exactly as `JSON.stringify` would. Pure — same
 * logical input always yields the same string.
 */
export function canonicalize(value: unknown): string {
    return encode(value)
}

function encode(value: unknown): string {
    if (value === null) {
        return 'null'
    }
    const type = typeof value
    if (type === 'string') {
        return JSON.stringify(value)
    }
    if (type === 'number') {
        // Match JSON: NaN/Infinity serialize to null; everything else is the
        // shortest round-trippable form (V8's Number→string is deterministic).
        return Number.isFinite(value as number) ? String(value) : 'null'
    }
    if (type === 'boolean') {
        return value ? 'true' : 'false'
    }
    if (type === 'bigint') {
        return (value as bigint).toString()
    }
    if (Array.isArray(value)) {
        const items = value.map((item) => encodeArrayItem(item))
        return '[' + items.join(',') + ']'
    }
    if (type === 'object') {
        const obj = value as Record<string, unknown>
        const keys = Object.keys(obj).sort()
        const parts: string[] = []
        for (const key of keys) {
            const child = obj[key]
            if (isSkippable(child)) {
                continue
            }
            parts.push(JSON.stringify(key) + ':' + encode(child))
        }
        return '{' + parts.join(',') + '}'
    }
    // undefined / function / symbol at the top level — JSON.stringify yields
    // undefined; we normalize to 'null' so the encoder is always total.
    return 'null'
}

function encodeArrayItem(item: unknown): string {
    // JSON renders undefined / functions / symbols inside arrays as null.
    return isSkippable(item) ? 'null' : encode(item)
}

function isSkippable(value: unknown): boolean {
    const type = typeof value
    return value === undefined || type === 'function' || type === 'symbol'
}

/**
 * Truncated SHA-256 of the canonical encoding: the first 64 bits as 16 lower-
 * case hex chars. `node:crypto` only — no runtime dependency (xxhash rejected,
 * §7). 64 bits because a colliding consecutive snapshot would freeze the
 * orchestrator's view until the next unrelated change; truncated SHA-256's
 * collision behavior beats any non-crypto 64-bit hash.
 */
export function hash64(value: unknown): string {
    const digest = createHash('sha256').update(canonicalize(value)).digest()
    return digest.subarray(0, 8).toString('hex')
}
