/**
 * Shared typed-codec toolkit over @toolcase/serializer (p2p.md §3.5, D7).
 *
 * Provides the common framing discipline used by all control/negotiation wires
 * (fleet, signal). The game-frame codec (serializer.ts) is unchanged — it is the
 * hot path and its frame shape is fixed.
 *
 * ── 2-byte version header ────────────────────────────────────────────────────
 * Every frame is [major, minor] followed by the protobuf body. A major mismatch
 * (including a legacy JSON frame whose first byte '{' = 123 can never be a valid
 * major) throws WireVersionError. The minor byte is reserved for additive
 * evolution within a major.
 *
 * ── APPEND-ONLY TAG RULE (load-bearing — read before editing) ───────────────
 * @toolcase/serializer assigns protobuf field tags positionally from the
 * insertion order of each define(...) field list (tag = index + 1). Tags are the
 * on-wire identity of a field, so:
 *   • NEVER reorder fields within a message.
 *   • NEVER remove a field (leave it; stop populating it).
 *   • Only ever APPEND new fields at the end of a message's field list.
 * Breaking this silently corrupts decoding against any peer built before the
 * change. A genuinely breaking layout change requires bumping the codec major.
 *
 * ── Lazy serializer loader ───────────────────────────────────────────────────
 * @toolcase/serializer's ESM entry does `import … from "protobufjs/light"` (no
 * .js extension), which Node strict-ESM rejects (F5, p2p.md §1). The loader
 * uses createRequire(import.meta.url) in the ESM build and native require in
 * the CJS build, both resolving the working CJS entry — same pattern as
 * fleet/src/wire/serializer.ts:132-142.
 */

import { createRequire } from 'node:module'

// ── FieldType constants ───────────────────────────────────────────────────────

/**
 * Scalar field type names accepted by @toolcase/serializer. Use these in
 * FieldDef.type for scalar fields; use a message type name for nested messages.
 */
export const FieldType = {
    STRING: 'string',
    UINT32: 'uint32',
    INT32: 'int32',
    BOOL: 'bool',
    BYTES: 'bytes',
} as const

// ── Schema definition types ──────────────────────────────────────────────────

/** A single field in a message type definition. */
export interface FieldDef {
    /** Field name on the encoded/decoded object. */
    key: string
    /**
     * Field type — a FieldType constant for scalars, or a message type name for
     * nested messages. Position within the parent define() list is the on-wire
     * tag — APPEND ONLY.
     */
    type: string
    rule: 'optional' | 'required' | 'repeated'
    default?: unknown
}

/**
 * Message type schema. Keys are type names; values are ordered field lists.
 * Define nested types before the types that reference them. Field order within
 * each type is the on-wire tag order — APPEND ONLY per the rule above.
 */
export type Schema = Record<string, FieldDef[]>

// ── WireVersionError ──────────────────────────────────────────────────────────

/**
 * Thrown when a frame's header major does not match the codec's expected major.
 * Byte 123 means the peer is sending a legacy JSON frame ('{' = 123).
 */
export class WireVersionError extends Error {
    /** The major byte read off the incompatible frame (123 = legacy JSON '{'). */
    readonly theirVersion: number
    /** This codec's expected major. */
    readonly ourVersion: number

    constructor(theirVersion: number, ourVersion: number) {
        super(
            `wire protocol version mismatch: peer speaks major v${theirVersion}, ` +
            `this build speaks v${ourVersion} — both sides must use the same ` +
            `package major (byte 123 indicates a legacy JSON frame)`
        )
        this.name = 'WireVersionError'
        this.theirVersion = theirVersion
        this.ourVersion = ourVersion
    }
}

// ── present() ─────────────────────────────────────────────────────────────────

/**
 * True when key is a SET field on the decoded message (not a prototype default).
 * Use in fromMessage implementations to distinguish absent fields from the
 * serializer's prototype-default values (0, '', false) — critical wherever
 * null-vs-0 or absent-vs-empty matter.
 */
export function present(obj: unknown, key: string): boolean {
    return obj !== null &&
        obj !== undefined &&
        Object.prototype.hasOwnProperty.call(obj, key)
}

// ── @toolcase/serializer minimal type surface (loaded lazily) ─────────────────

interface SerializerInstance {
    define(key: string, fields?: FieldDef[]): void
    encode(key: string, message: Record<string, unknown>): Uint8Array
    decode(key: string, buffer: Uint8Array): unknown
}

interface SerializerCtor {
    new (id?: string | null): SerializerInstance
}

// ── Codec factory ─────────────────────────────────────────────────────────────

/** Options for createCodec. */
export interface CodecOptions {
    /**
     * Protocol major version — embedded in frame byte 0. A frame whose first byte
     * does not match throws WireVersionError.
     */
    major: number
    /**
     * Protocol minor version — embedded in frame byte 1. Reserved for additive
     * evolution within a major. Defaults to 0.
     */
    minor?: number
    /** Serializer namespace id (e.g. '@rivalis/signal'). Scopes the schema. */
    namespace: string
    /**
     * Message type definitions in dependency order (nested types before the types
     * that reference them). Field order within each type is the on-wire tag order
     * — APPEND ONLY.
     */
    schema: Schema
}

/** A versioned binary codec produced by createCodec. */
export interface Codec {
    /**
     * Encode a message into a versioned binary frame: [major, minor] header +
     * protobuf body. The type name must match a key in the codec's schema.
     */
    encode(type: string, message: Record<string, unknown>): Uint8Array
    /**
     * Decode a versioned binary frame. Throws WireVersionError when the header
     * major does not match, and a plain Error on truncation or malformed body.
     * The type name must match a key in the codec's schema.
     * Use present() on the returned object to distinguish set fields from defaults.
     */
    decode(type: string, frame: Uint8Array): Record<string, any>
}

const HEADER_BYTES = 2

/**
 * Create a versioned binary codec over @toolcase/serializer.
 *
 * The serializer is lazily initialized on first encode/decode call via
 * createRequire(import.meta.url), ensuring the working CJS entry is always
 * loaded regardless of whether the caller is ESM or CJS (F5 fix, p2p.md §3.5).
 *
 * Each returned codec is a self-contained singleton; create at module scope.
 */
export function createCodec(options: CodecOptions): Codec {
    const { major, minor = 0, namespace, schema } = options
    let serializer: SerializerInstance | null = null

    function getSerializer(): SerializerInstance {
        if (serializer !== null) return serializer
        const metaUrl = import.meta.url
        const req = metaUrl ? createRequire(metaUrl) : require
        const mod = req('@toolcase/serializer') as {
            Serializer?: SerializerCtor
            default?: SerializerCtor
        }
        const Serializer = (mod.Serializer ?? mod.default) as SerializerCtor
        const s = new Serializer(namespace)
        for (const [typeName, fields] of Object.entries(schema)) {
            s.define(typeName, fields)
        }
        serializer = s
        return s
    }

    return {
        encode(type: string, message: Record<string, unknown>): Uint8Array {
            const body = getSerializer().encode(type, message)
            const frame = new Uint8Array(HEADER_BYTES + body.length)
            frame[0] = major
            frame[1] = minor
            frame.set(body, HEADER_BYTES)
            return frame
        },

        decode(type: string, frame: Uint8Array): Record<string, any> {
            if (frame == null || frame.length < HEADER_BYTES) {
                throw new Error(
                    'wire: truncated frame (shorter than the 2-byte version header)'
                )
            }
            const frameMajor = frame[0] as number
            if (frameMajor !== major) {
                throw new WireVersionError(frameMajor, major)
            }
            const body = frame.subarray(HEADER_BYTES)
            return getSerializer().decode(type, body) as Record<string, any>
        }
    }
}
