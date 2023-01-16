import { Serializer } from '@toolcase/base'

const serializer = new Serializer('@toolcase/realtime')

const DATA_MODEL = 'realtime_message'

serializer.define(DATA_MODEL, [
    { key: 'topic', type: 'string', rule: 'required' },
    { key: 'payload', type: 'bytes', rule: 'required' }
])

/** 
 * @typedef Message
 * @property {string} topic
 * @property {Uint8Array} payload
 */

/**
 * 
 * @param {string} topic 
 * @param {Uint8Array} payload 
 * @param {string} sender 
 * @returns {Uint8Array}
 */
export const encode = (topic, payload) => {
    return serializer.encode(DATA_MODEL, {
        topic, payload
    })
}

/**
 * 
 * @param {Uint8Array} buffer 
 * @returns {Message}
 */
export const decode = (buffer) => {
    return serializer.decode(DATA_MODEL, buffer)
}