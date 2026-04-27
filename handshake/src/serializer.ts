import { Serializer } from '@toolcase/serializer'

const serializer = new Serializer('@rivalis/message')

const DATA_MODEL = 'realtime_message'

serializer.define(DATA_MODEL, [
    { key: 'topic', type: 'string', rule: 'required' },
    { key: 'payload', type: 'bytes', rule: 'required' }
])

export type Message = {
    topic: string
    payload: Uint8Array
}

export const encode = (topic: string, payload: Uint8Array): Uint8Array<ArrayBuffer> => {
    return serializer.encode(DATA_MODEL, { topic, payload }) as Uint8Array<ArrayBuffer>
}

export const decode = (buffer: Uint8Array): Message => {
    return serializer.decode(DATA_MODEL, buffer) as unknown as Message
}
