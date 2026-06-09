import { createRequire } from 'node:module'

// ── @toolcase/serializer minimal type surface (loaded lazily via require) ────
// `@toolcase/serializer`'s ESM entry does `import … from "protobufjs/light"`
// (bare subpath, no `.js`), which Node strict-ESM rejects. Loading via require
// targets the working CJS entry in both build outputs: the CJS bundle has a
// native `require`; the ESM bundle derives one from `import.meta.url`.

interface FieldDef {
    key: string
    type: string
    rule: 'optional' | 'required' | 'repeated'
}
interface SerializerInstance {
    define(key: string, fields?: FieldDef[]): void
    encode(key: string, message: Record<string, unknown>): Uint8Array
    decode(key: string, buffer: Uint8Array): unknown
}
interface SerializerCtor {
    new (id?: string | null): SerializerInstance
}

const DATA_MODEL = 'realtime_message'

let serializer: SerializerInstance | null = null

function getSerializer(): SerializerInstance {
    if (serializer !== null) {
        return serializer
    }
    const metaUrl = import.meta.url
    const req = metaUrl ? createRequire(metaUrl) : require
    const mod = req('@toolcase/serializer') as { Serializer?: SerializerCtor; default?: SerializerCtor }
    const Serializer = (mod.Serializer ?? mod.default) as SerializerCtor
    const s = new Serializer('@rivalis/message')
    s.define(DATA_MODEL, [
        { key: 'topic', type: 'string', rule: 'required' },
        { key: 'payload', type: 'bytes', rule: 'required' }
    ])
    serializer = s
    return serializer
}

export type Message = {
    topic: string
    payload: Uint8Array
}

export const encode = (topic: string, payload: Uint8Array): Uint8Array<ArrayBuffer> => {
    return getSerializer().encode(DATA_MODEL, { topic, payload }) as Uint8Array<ArrayBuffer>
}

export const decode = (buffer: Uint8Array): Message => {
    return getSerializer().decode(DATA_MODEL, buffer) as unknown as Message
}
