/**
 * Realtime message codec — the hot-path game frame: a topic string + an opaque
 * binary payload. Fixed two-field schema, no version header (the handshake has
 * already pinned the protocol version by the time data frames flow).
 *
 * Built directly on the native Serializer (wire/serializer.ts). The versioned
 * negotiation/control wires use createCodec (codec.ts) instead.
 */

import { Serializer } from './wire/serializer'

const DATA_MODEL = 'realtime_message'

let messageSerializer: Serializer | null = null

function getMessageSerializer(): Serializer {
    if (messageSerializer !== null) return messageSerializer
    const s = new Serializer()
    s.define(DATA_MODEL, [
        { key: 'topic', type: 'string', rule: 'required' },
        { key: 'payload', type: 'bytes', rule: 'required' },
    ])
    messageSerializer = s
    return s
}

export type Message = {
    topic: string
    payload: Uint8Array
}

export const encode = (topic: string, payload: Uint8Array): Uint8Array<ArrayBuffer> => {
    return getMessageSerializer().encode(DATA_MODEL, { topic, payload }) as Uint8Array<ArrayBuffer>
}

export const decode = (buffer: Uint8Array): Message => {
    return getMessageSerializer().decode(DATA_MODEL, buffer) as unknown as Message
}
