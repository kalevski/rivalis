import { Broadcast, generateId } from '@toolcase/base'
import type { LoggerFactory } from '@toolcase/logging'
import CustomLoggerFactory from './CustomLoggerFactory'
import Room from './Room'
import type TLayer from './TLayer'

type RoomConstructor<TActorData> = new (
    roomId: string,
    manager: RoomManager<TActorData>,
    transportLayer: TLayer<TActorData>
) => Room<TActorData>

class RoomManager<TActorData = Record<string, unknown>> extends Broadcast {

    readonly logging: LoggerFactory

    private transportLayer: TLayer<TActorData>

    private defs: Map<string, RoomConstructor<TActorData>> = new Map()

    private rooms: Map<string, Room<TActorData>> = new Map()

    constructor(transportLayer: TLayer<TActorData>, logging: LoggerFactory = CustomLoggerFactory.Instance) {
        super()
        this.transportLayer = transportLayer
        this.logging = logging
    }

    get count(): number {
        return this.rooms.size
    }

    keys(): IterableIterator<string> {
        return this.rooms.keys()
    }

    get(roomId: string): Room<TActorData> | null {
        return this.rooms.get(roomId) ?? null
    }

    define(key: string, roomClass: RoomConstructor<TActorData>): void {
        if (typeof key !== 'string') {
            throw new Error(`room define error: definition key=(${key}) must be of the type string`)
        }
        if (typeof roomClass !== 'function') {
            throw new Error(`room define error: roomClass=(${roomClass}) is not a class`)
        }
        if (!(roomClass.prototype instanceof Room)) {
            throw new Error(`room define error: roomClass=(${roomClass}) must extends Room`)
        }
        if (this.defs.has(key)) {
            throw new Error(`room define error: definition key=(${key}) exists`)
        }
        this.defs.set(key, roomClass)
        this.emit('define', key)
    }

    create(roomType: string, roomId: string | null = null): Room<TActorData> {
        if (typeof roomType !== 'string') {
            throw new Error(`room create error: type=(${roomType}) must be a string`)
        }
        const RoomClass = this.defs.get(roomType)
        if (RoomClass === undefined) {
            throw new Error(`room create error: type=(${roomType}) is not defined`)
        }

        let resolvedRoomId: string
        if (roomId === null) {
            resolvedRoomId = generateId(32)
        } else if (typeof roomId !== 'string') {
            throw new Error(`room create error: room id=(${roomId}) must be a string`)
        } else {
            resolvedRoomId = roomId
        }

        if (this.rooms.has(resolvedRoomId)) {
            throw new Error(`room create error: room id=(${resolvedRoomId}) is taken`)
        }

        const room = new RoomClass(resolvedRoomId, this, this.transportLayer)
        this.rooms.set(resolvedRoomId, room)
        this.emit('create', resolvedRoomId)
        return room
    }

    destroy(roomId: string): void {
        const room = this.rooms.get(roomId)
        if (room === undefined) {
            throw new Error(`room destroy error: roomId=(${roomId}) does not exist`)
        }

        this.rooms.delete(roomId)
        room.handleDestroy()
        this.emit('destroy', roomId)
    }

    protected override emit(event: string | symbol, ...messages: unknown[]): boolean {
        return super.emit(event, ...messages)
    }

}

export default RoomManager
