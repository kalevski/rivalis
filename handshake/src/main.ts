export { encode, decode } from './serializer'
export type { Message } from './serializer'

export { default as CloseCode } from './CloseCode'
export type { CloseCode as CloseCodeType } from './CloseCode'

export { createCodec, WireVersionError, present, FieldType } from './codec/index'
export type { FieldDef, Schema, CodecOptions, Codec } from './codec/index'

export {
    CLOSE_CONTROL_TOPIC,
    MAX_CLOSE_REASON_BYTES,
    encodeCloseFrame,
    decodeCloseFrame,
} from './closeFrame'
export type { CloseFrame } from './closeFrame'
