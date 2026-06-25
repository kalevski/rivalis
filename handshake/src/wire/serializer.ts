/**
 * Native schema-driven binary serializer — zero runtime dependencies.
 *
 * ── Wire format ──────────────────────────────────────────────────────────────
 * A message is a flat sequence of fields. Each field is:
 *
 *     key (varint)  =  (tag << 3) | wireType
 *     value         =  varint            (wireType 0: uint32 / int32 / bool)
 *                   |  len(varint)+bytes (wireType 2: string / bytes / message)
 *
 * `tag` is the field's 1-based position in its define() list (tag = index + 1).
 * The wire type rides in the key, so a decoder can skip a field it doesn't know.
 * That is what makes append-only evolution safe: an old peer drops a newer peer's
 * appended fields; a new peer sees an old peer's missing fields as not-present.
 * varints are unsigned LEB128; int32 is zig-zag encoded.
 *
 * ── present() semantics ──────────────────────────────────────────────────────
 * Only fields written to the wire are set as OWN properties on the decoded object
 * (including falsy 0 / '' / false). Absent optional fields are simply not set.
 *
 * ── APPEND-ONLY TAG RULE ─────────────────────────────────────────────────────
 * Field order in each define() list IS the on-wire identity. Never reorder or
 * remove a field; only append. A breaking layout change requires a major bump.
 */

import { Writer, Reader } from './varint'
import type { FieldDef } from './types'

const WIRE_VARINT = 0
const WIRE_LEN = 2

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const EMPTY = new Uint8Array(0)

// ── Serializer ───────────────────────────────────────────────────────────────

/**
 * Schema-driven binary serializer: construct, define() each message type, then
 * encode()/decode() by type name. Types resolve by name, so define order is
 * irrelevant and nested types may be defined in any order.
 */
export class Serializer {
    private readonly types = new Map<string, FieldDef[]>()

    // `id` is accepted for call-site compatibility; the native format has no namespace.
    constructor(_id?: string | null) {}

    define(typeName: string, fields: FieldDef[] = []): void {
        this.types.set(typeName, fields)
    }

    encode(typeName: string, message: Record<string, unknown>): Uint8Array {
        const w = new Writer()
        this.write(w, typeName, message)
        return w.done()
    }

    decode(typeName: string, buffer: Uint8Array): Record<string, any> {
        return this.read(this.fieldsOf(typeName), new Reader(buffer))
    }

    private fieldsOf(typeName: string): FieldDef[] {
        const fields = this.types.get(typeName)
        if (fields === undefined) throw new Error(`wire: unknown message type "${typeName}"`)
        return fields
    }

    private write(w: Writer, typeName: string, message: Record<string, unknown>): void {
        const fields = this.fieldsOf(typeName)
        for (let i = 0; i < fields.length; i++) {
            const field = fields[i]!
            const tag = i + 1
            const value = message[field.key]

            if (field.rule === 'repeated') {
                if (value === null || value === undefined) continue
                if (!Array.isArray(value)) throw new Error(`wire: repeated field "${field.key}" expects an array`)
                for (const element of value) this.writeField(w, tag, field, element)
            } else if (value !== null && value !== undefined) {
                this.writeField(w, tag, field, value)
            } else if (field.rule === 'required') {
                // required fields are always written so they are present on decode
                this.writeField(w, tag, field, defaultFor(field.type))
            }
        }
    }

    private writeField(w: Writer, tag: number, field: FieldDef, value: unknown): void {
        switch (field.type) {
            case 'string':
                w.varint((tag << 3) | WIRE_LEN)
                w.lenBytes(encoder.encode(String(value)))
                return
            case 'bytes':
                w.varint((tag << 3) | WIRE_LEN)
                w.lenBytes(value instanceof Uint8Array ? value : EMPTY)
                return
            case 'uint32':
                w.varint((tag << 3) | WIRE_VARINT)
                w.varint((value as number) >>> 0)
                return
            case 'int32': {
                const n = (value as number) | 0
                w.varint((tag << 3) | WIRE_VARINT)
                w.varint(((n << 1) ^ (n >> 31)) >>> 0) // zig-zag
                return
            }
            case 'bool':
                w.varint((tag << 3) | WIRE_VARINT)
                w.varint(value ? 1 : 0)
                return
            default: {
                // nested message
                const child = new Writer()
                this.write(child, field.type, (value ?? {}) as Record<string, unknown>)
                w.varint((tag << 3) | WIRE_LEN)
                w.lenBytes(child.done())
            }
        }
    }

    private read(fields: FieldDef[], r: Reader): Record<string, any> {
        const result: Record<string, any> = {}
        while (r.more) {
            const key = r.varint()
            const tag = key >>> 3
            const wire = key & 7

            let num = 0
            let bytes: Uint8Array | null = null
            if (wire === WIRE_VARINT) num = r.varint()
            else if (wire === WIRE_LEN) bytes = r.take(r.varint())
            else throw new Error(`wire: unsupported wire type ${wire}`)

            const field = tag >= 1 && tag <= fields.length ? fields[tag - 1]! : undefined
            if (field === undefined) continue // unknown field — skip (append-only evolution)

            const value = this.readValue(field, num, bytes)
            if (field.rule === 'repeated') {
                if (!Array.isArray(result[field.key])) result[field.key] = []
                ;(result[field.key] as unknown[]).push(value)
            } else {
                result[field.key] = value
            }
        }
        return result
    }

    private readValue(field: FieldDef, num: number, bytes: Uint8Array | null): unknown {
        switch (field.type) {
            case 'string': return bytes ? decoder.decode(bytes) : ''
            case 'bytes': return bytes ?? EMPTY
            case 'uint32': return num >>> 0
            case 'int32': return (num >>> 1) ^ -(num & 1) // un-zig-zag
            case 'bool': return num !== 0
            default: return bytes ? this.read(this.fieldsOf(field.type), new Reader(bytes)) : undefined
        }
    }
}

function defaultFor(type: string): unknown {
    switch (type) {
        case 'string': return ''
        case 'uint32':
        case 'int32': return 0
        case 'bool': return false
        case 'bytes': return EMPTY
        default: return {}
    }
}
