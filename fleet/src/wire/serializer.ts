/**
 * Binary agent ↔ orchestrator wire codec (§7, task 005).
 *
 * Replaces the ad-hoc JSON `JSON.stringify`/`JSON.parse` frames with compact
 * protobuf, using `@toolcase/serializer` (runtime-defined schemas — no `.proto`
 * build step). One `Serializer('fleet')` instance defines a message type per
 * topic; {@link encodeFrame}/{@link decodeFrame} map a topic name to its type.
 *
 * ── 2-byte version header ───────────────────────────────────────────────────
 * Every frame is `[major, minor]` followed by the protobuf body. `major` is
 * {@link PROTOCOL_VERSION} (the protocol MAJOR, §7); `minor` is reserved for
 * future additive evolution. The header replaces the old hand-checked
 * `protocolVersion` field as the *wire-format* guard: a peer speaking a
 * different major (or the legacy JSON protocol, whose first byte `{` = 123 can
 * never be a valid major) is detected at decode and surfaced as a
 * {@link WireVersionError}. The agent turns that into a loud connect failure at
 * `fleet/hello`; for every other topic it is logged and the frame dropped (§8 —
 * never throw into the host). The semantic `protocolVersion` field stays in the
 * `Hello`/`State` payloads as a redundant, human-readable guard.
 *
 * ── APPEND-ONLY TAG RULE (load-bearing — read before editing) ───────────────
 * `@toolcase/serializer` assigns protobuf field tags **positionally** from the
 * insertion order of each `define(...)` field list (tag = index + 1). Tags are
 * the on-wire identity of a field, so:
 *   • NEVER reorder fields within a message.
 *   • NEVER remove a field (leave it in place; stop populating it instead).
 *   • Only ever APPEND new fields at the end of a message's field list.
 * Breaking this silently corrupts decoding against any peer built before the
 * change. A genuinely breaking layout change requires bumping
 * {@link PROTOCOL_VERSION} (the header major) so mismatched peers fail loudly
 * rather than misread bytes.
 *
 * ── CJS-only consumption (the known ESM blocker) ────────────────────────────
 * `@toolcase/serializer`'s ESM build does `import ... from 'protobufjs/light'`
 * (no `.js`), which Node's strict ESM resolver rejects — the same breakage that
 * forces core to be loaded via CJS (`util/loadCore`). We therefore load the
 * serializer **lazily via `require`** (never a top-level `import`), so neither
 * fleet build statically pulls the broken ESM entry: the CJS bundle gets a
 * native `require`, the ESM bundle derives one from `import.meta.url`, and both
 * resolve the serializer's working CJS entry.
 */

import { createRequire } from 'node:module'

import { PROTOCOL_VERSION, Topics, type TopicName } from './topics'
import type {
    AckPayload,
    CmdPayload,
    HelloPayload,
    PollPayload,
    StatePayload,
    SyncRoom
} from './payloads'
import type { Capacity, InstanceStatus } from '../domain'

/** Header major byte — the protocol MAJOR carried on every frame (§7). */
const WIRE_MAJOR = PROTOCOL_VERSION
/** Header minor byte — reserved for future additive evolution within a major. */
const WIRE_MINOR = 0
/** Fixed header length: `[major, minor]`. */
const HEADER_BYTES = 2

/** Raised when a frame's header major does not match this build's {@link PROTOCOL_VERSION}. */
export class WireVersionError extends Error {
    /** The major byte read off the incompatible frame (123 for a legacy JSON `{...}` frame). */
    readonly theirVersion: number
    /** This build's protocol major. */
    readonly ourVersion: number

    constructor(theirVersion: number) {
        super(
            `fleet wire protocol version mismatch: peer speaks major v${theirVersion}, ` +
            `this build speaks v${PROTOCOL_VERSION} — agents and orchestrator must run the ` +
            `same @rivalis/fleet major (§7). A v1 (JSON) peer against a v${PROTOCOL_VERSION} ` +
            `peer is exactly this case; upgrade both halves in lockstep.`
        )
        this.name = 'WireVersionError'
        this.theirVersion = theirVersion
        this.ourVersion = PROTOCOL_VERSION
    }
}

// ── @toolcase/serializer minimal type surface (loaded lazily via require) ────

interface FieldDef {
    key: string
    type: string
    rule: 'optional' | 'required' | 'repeated'
    default?: unknown
}
interface SerializerInstance {
    define(key: string, fields?: FieldDef[]): void
    encode(key: string, message: Record<string, unknown>): Uint8Array
    decode(key: string, buffer: Uint8Array): unknown
}
interface SerializerCtor {
    new (id?: string | null): SerializerInstance
    // Named props (not just an index signature) so each reads as `string`, not
    // `string | undefined` under noUncheckedIndexedAccess.
    FieldType: { STRING: string; UINT32: string; INT32: string; BOOL: string }
}

/** Message-type names defined on the serializer (one per topic, plus nested types). */
const Type = {
    Label: 'Label',
    SyncRoom: 'SyncRoom',
    Capacity: 'Capacity',
    AckRoom: 'AckRoom',
    Hello: 'Hello',
    Poll: 'Poll',
    State: 'State',
    Cmd: 'Cmd',
    Ack: 'Ack'
} as const

/** Map every topic to the message type that carries its payload. */
const TOPIC_TYPE: Record<TopicName, string> = {
    [Topics.hello]: Type.Hello,
    [Topics.poll]: Type.Poll,
    [Topics.state]: Type.State,
    [Topics.cmd]: Type.Cmd,
    [Topics.ack]: Type.Ack
}

let serializer: SerializerInstance | null = null

/**
 * Lazily build (once) the `Serializer('fleet')` with every message type. The
 * field order in each `define` list is the on-wire tag order — APPEND ONLY
 * (see the file header). Loaded via `require` to avoid the broken serializer ESM.
 */
function getSerializer(): SerializerInstance {
    if (serializer !== null) {
        return serializer
    }
    const metaUrl = import.meta.url
    const req = metaUrl ? createRequire(metaUrl) : require
    const mod = req('@toolcase/serializer') as { Serializer?: SerializerCtor; default?: SerializerCtor }
    const Serializer = (mod.Serializer ?? mod.default) as SerializerCtor
    const F = Serializer.FieldType

    const s = new Serializer('fleet')

    // Nested types first so the message types can reference them by name.
    s.define(Type.Label, [
        { key: 'key', type: F.STRING, rule: 'optional' },
        { key: 'value', type: F.STRING, rule: 'optional' }
    ])
    s.define(Type.SyncRoom, [
        { key: 'id', type: F.STRING, rule: 'optional' },
        { key: 'type', type: F.STRING, rule: 'optional' },
        { key: 'connections', type: F.UINT32, rule: 'optional' },
        { key: 'origin', type: F.STRING, rule: 'optional' }
    ])
    s.define(Type.Capacity, [
        // null = unlimited (§6). Absent on the wire ⇒ null; an explicit 0 ⇒ 0.
        { key: 'maxConnections', type: F.INT32, rule: 'optional', default: null },
        { key: 'maxRooms', type: F.INT32, rule: 'optional', default: null }
    ])
    s.define(Type.AckRoom, [
        { key: 'id', type: F.STRING, rule: 'optional' },
        { key: 'type', type: F.STRING, rule: 'optional' }
    ])

    s.define(Type.Hello, [
        { key: 'instanceId', type: F.STRING, rule: 'optional' },
        { key: 'protocolVersion', type: F.UINT32, rule: 'optional' },
        { key: 'heartbeatMs', type: F.UINT32, rule: 'optional' }
    ])
    s.define(Type.Poll, [
        { key: 'reqId', type: F.STRING, rule: 'optional' },
        // Absent ⇒ null (no prior state / forced full, subsumes the old fleet/resync).
        { key: 'knownHash', type: F.STRING, rule: 'optional' },
        { key: 'status', type: F.STRING, rule: 'optional' }
    ])
    s.define(Type.State, [
        { key: 'reqId', type: F.STRING, rule: 'optional' },
        // full=false is a hash-only liveness reply: the snapshot fields below are
        // omitted on the wire (preserving the old sync/ping dedup, orch-initiated).
        { key: 'full', type: F.BOOL, rule: 'optional' },
        { key: 'seq', type: F.UINT32, rule: 'optional' },
        { key: 'hash', type: F.STRING, rule: 'optional' },
        { key: 'name', type: F.STRING, rule: 'optional' },
        { key: 'processUid', type: F.STRING, rule: 'optional' },
        { key: 'agentVersion', type: F.STRING, rule: 'optional' },
        { key: 'protocolVersion', type: F.UINT32, rule: 'optional' },
        { key: 'endpointUrl', type: F.STRING, rule: 'optional' },
        { key: 'labels', type: Type.Label, rule: 'repeated' },
        { key: 'capacity', type: Type.Capacity, rule: 'optional' },
        { key: 'autoCreate', type: F.BOOL, rule: 'optional' },
        { key: 'roomTypes', type: F.STRING, rule: 'repeated' },
        { key: 'rooms', type: Type.SyncRoom, rule: 'repeated' },
        { key: 'status', type: F.STRING, rule: 'optional' }
    ])
    s.define(Type.Cmd, [
        { key: 'cmdId', type: F.STRING, rule: 'optional' },
        { key: 'op', type: F.STRING, rule: 'optional' },
        { key: 'roomId', type: F.STRING, rule: 'optional' },
        { key: 'roomType', type: F.STRING, rule: 'optional' }
    ])
    s.define(Type.Ack, [
        { key: 'cmdId', type: F.STRING, rule: 'optional' },
        { key: 'ok', type: F.BOOL, rule: 'optional' },
        { key: 'error', type: F.STRING, rule: 'optional' },
        { key: 'alreadyGone', type: F.BOOL, rule: 'optional' },
        { key: 'room', type: Type.AckRoom, rule: 'optional' },
        // APPEND-ONLY (task 003): the room-already-exists signal must stay LAST so
        // existing tags are unmoved (see the append-only tag rule in the file header).
        { key: 'exists', type: F.BOOL, rule: 'optional' }
    ])

    serializer = s
    return s
}

// ── topic → serializer-message mappers ───────────────────────────────────────
// `toMessage` shapes a typed payload into the structure the serializer encodes
// (labels as a repeated key/value list, capacity as a nested message). `from*`
// rebuilds the typed payload from the decoded protobuf message.
//
// Decoding reads field PRESENCE via own-property checks ({@link present}), never
// the protobuf prototype default: an unset optional `int32` reads as 0 and an
// unset optional `string` as '' on the message prototype, which would erase the
// null-vs-0 distinction capacity depends on (null = unlimited, §6) and turn an
// absent `cmd.roomId` into '' instead of "not provided". Own-property presence
// keeps both distinguishable without any JSON round-trip — the wire stays binary.

/** True when `key` is a SET field on the decoded message (not a prototype default). */
function present(obj: any, key: string): boolean {
    return obj !== null && obj !== undefined && Object.prototype.hasOwnProperty.call(obj, key)
}

function labelsToList(labels: Record<string, string> | undefined): Array<{ key: string; value: string }> {
    return Object.entries(labels ?? {}).map(([key, value]) => ({ key, value }))
}

function labelsFromList(list: Array<{ key?: string; value?: string }> | undefined): Record<string, string> {
    const labels: Record<string, string> = {}
    for (const entry of list ?? []) {
        labels[entry.key ?? ''] = entry.value ?? ''
    }
    return labels
}

function capacityToMessage(capacity: Capacity | undefined): Record<string, unknown> {
    return {
        maxConnections: capacity?.maxConnections ?? null,
        maxRooms: capacity?.maxRooms ?? null
    }
}

function capacityFromMessage(capacity: any): Capacity {
    return {
        // Absent ⇒ null (unlimited, §6); an explicit 0 is preserved as 0.
        maxConnections: present(capacity, 'maxConnections') ? capacity.maxConnections : null,
        maxRooms: present(capacity, 'maxRooms') ? capacity.maxRooms : null
    }
}

function stateToMessage(p: StatePayload): Record<string, unknown> {
    // A hash-only reply (full=false) omits the heavy snapshot fields entirely —
    // that is the whole point of the dedup (no resending unchanged state).
    if (!p.full) {
        return { reqId: p.reqId, full: false, seq: p.seq, hash: p.hash }
    }
    return {
        reqId: p.reqId,
        full: true,
        seq: p.seq,
        hash: p.hash,
        name: p.name,
        processUid: p.processUid,
        agentVersion: p.agentVersion,
        protocolVersion: p.protocolVersion,
        endpointUrl: p.endpointUrl,
        labels: labelsToList(p.labels),
        capacity: capacityToMessage(p.capacity),
        autoCreate: p.autoCreate,
        roomTypes: p.roomTypes ?? [],
        rooms: (p.rooms ?? []).map((r) => ({
            id: r.id,
            type: r.type,
            connections: r.connections,
            origin: r.origin
        })),
        status: p.status
    }
}

function stateFromMessage(m: Record<string, any>): StatePayload {
    return {
        reqId: m.reqId ?? '',
        full: m.full ?? false,
        seq: m.seq ?? 0,
        hash: m.hash ?? '',
        name: m.name ?? '',
        processUid: m.processUid ?? '',
        agentVersion: m.agentVersion ?? '',
        protocolVersion: m.protocolVersion ?? 0,
        endpointUrl: m.endpointUrl ?? '',
        labels: labelsFromList(m.labels),
        capacity: capacityFromMessage(m.capacity),
        autoCreate: m.autoCreate ?? false,
        roomTypes: Array.isArray(m.roomTypes) ? m.roomTypes : [],
        rooms: (Array.isArray(m.rooms) ? m.rooms : []).map((r: Record<string, any>): SyncRoom => ({
            id: r.id ?? '',
            type: r.type ?? '',
            connections: r.connections ?? 0,
            origin: (r.origin ?? 'local') as SyncRoom['origin']
        })),
        status: (m.status ?? 'active') as InstanceStatus
    }
}

/** Build the serializer message object for a topic's payload (encode side). */
function toMessage(topic: TopicName, payload: any): Record<string, unknown> {
    switch (topic) {
        case Topics.state:
            return stateToMessage(payload as StatePayload)
        case Topics.poll: {
            // knownHash null ⇒ omit the field (decodes back to null / forced full).
            const p = payload as PollPayload
            const msg: Record<string, unknown> = { reqId: p.reqId, status: p.status }
            if (p.knownHash !== null && p.knownHash !== undefined) { msg.knownHash = p.knownHash }
            return msg
        }
        default:
            // Hello/Cmd/Ack are flat scalar shapes the serializer encodes directly;
            // an `undefined` optional is simply omitted.
            return payload as Record<string, unknown>
    }
}

/** Rebuild the typed payload for a topic from the decoded protobuf message (decode side). */
function fromMessage(topic: TopicName, m: Record<string, any>): unknown {
    switch (topic) {
        case Topics.hello:
            return {
                instanceId: m.instanceId ?? '',
                protocolVersion: m.protocolVersion ?? 0,
                heartbeatMs: m.heartbeatMs ?? 0
            } satisfies HelloPayload
        case Topics.poll:
            return {
                reqId: m.reqId ?? '',
                // Absent knownHash ⇒ null (no prior state / forced full).
                knownHash: present(m, 'knownHash') ? m.knownHash : null,
                status: (m.status ?? 'active') as InstanceStatus
            } satisfies PollPayload
        case Topics.state:
            return stateFromMessage(m)
        case Topics.cmd: {
            const cmd: CmdPayload = { cmdId: m.cmdId ?? '', op: m.op }
            if (present(m, 'roomId')) { cmd.roomId = m.roomId }
            if (present(m, 'roomType')) { cmd.roomType = m.roomType }
            return cmd
        }
        case Topics.ack: {
            const ack: AckPayload = { cmdId: m.cmdId ?? '', ok: m.ok ?? false }
            if (present(m, 'error')) { ack.error = m.error }
            if (present(m, 'alreadyGone')) { ack.alreadyGone = m.alreadyGone }
            if (present(m, 'exists')) { ack.exists = m.exists }
            if (present(m, 'room')) { ack.room = { id: m.room.id ?? '', type: m.room.type ?? '' } }
            return ack
        }
        default:
            return m
    }
}

// ── public codec ─────────────────────────────────────────────────────────────

/**
 * Encode a topic payload into a versioned binary frame: the 2-byte
 * `[major, minor]` header followed by the protobuf body.
 */
export function encodeFrame(topic: string, payload: unknown): Uint8Array {
    const type = TOPIC_TYPE[topic as TopicName]
    if (type === undefined) {
        throw new Error(`fleet wire: no message type for topic=${topic}`)
    }
    const body = getSerializer().encode(type, toMessage(topic as TopicName, payload))
    const frame = new Uint8Array(HEADER_BYTES + body.length)
    frame[0] = WIRE_MAJOR
    frame[1] = WIRE_MINOR
    frame.set(body, HEADER_BYTES)
    return frame
}

/**
 * Decode a versioned binary frame for a topic. Throws {@link WireVersionError}
 * when the header major does not match this build (incl. a legacy JSON frame,
 * whose `{` first byte reads as major 123), and a plain `Error` when the body is
 * malformed/truncated. Callers log + drop on failure (§8), except the agent's
 * `fleet/hello` path which turns a {@link WireVersionError} into a loud connect
 * failure.
 */
export function decodeFrame(topic: string, frame: Uint8Array): unknown {
    const type = TOPIC_TYPE[topic as TopicName]
    if (type === undefined) {
        throw new Error(`fleet wire: no message type for topic=${topic}`)
    }
    if (frame === null || frame === undefined || frame.length < HEADER_BYTES) {
        throw new Error('fleet wire: truncated frame (shorter than the 2-byte version header)')
    }
    // Length checked above, so byte 0 is present.
    const major = frame[0] as number
    if (major !== WIRE_MAJOR) {
        throw new WireVersionError(major)
    }
    const body = frame.subarray(HEADER_BYTES)
    // The wire stays binary: `fromMessage` reads the decoded protobuf message
    // directly, using own-property presence (not prototype defaults) where the
    // null-vs-0 / absent-vs-empty distinction matters. No JSON on the path.
    const decoded = getSerializer().decode(type, body) as Record<string, any>
    return fromMessage(topic as TopicName, decoded)
}
