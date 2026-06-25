/**
 * Schema vocabulary for the native binary engine — the single source of truth
 * for field definitions and scalar type names.
 *
 * `FieldType` (the public constant) and the scalar string union are defined here
 * against each other so the engine's accepted type names and the published
 * constant can never drift. codec.ts and main.ts re-export `FieldType`/`FieldDef`.
 */

// ── Scalar type names ───────────────────────────────────────────────────────────

/** The scalar field type names understood by the serializer. */
export type ScalarType = 'string' | 'uint32' | 'int32' | 'bool' | 'bytes'

/**
 * Scalar field type names. Use these in FieldDef.type for scalar fields; use a
 * message type name for nested messages.
 */
export const FieldType = {
    STRING: 'string',
    UINT32: 'uint32',
    INT32: 'int32',
    BOOL: 'bool',
    BYTES: 'bytes',
} as const

// ── Field definition ─────────────────────────────────────────────────────────────

/** A single field in a message type definition. */
export interface FieldDef {
    /** Field name on the encoded/decoded object. */
    key: string
    /** A scalar name ('string'|'uint32'|'int32'|'bool'|'bytes') or a message type name. */
    type: string
    rule: 'optional' | 'required' | 'repeated'
    default?: unknown
}
