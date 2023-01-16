import { Broadcast, generateId } from '@toolcase/base'
import Room from './Room'
import TLayer from './TLayer'

/**
 * @typedef EventTypes
 * @type {('define'|'create'|'destroy')}
 */

/**
 * @extends {Broadcast<EventTypes,string,any>}
 */
class RoomManager extends Broadcast {



    /**
     * @private
     * @type {TLayer}
     */
    transportLayer = null

    /**
     * @private
     * @type {Map<string,typeof Room>}
     */
    defs = new Map()

    /**
     * @private
     * @type {Map<string,Room>}
     */
    rooms = new Map()

    /**
     * 
     * @param {TLayer} transportLayer 
     */
    constructor(transportLayer) {
        super()
        this.transportLayer = transportLayer
    }

    /**
     * 
     * @param {string} roomId 
     */
    get(roomId) {
        return this.rooms.get(roomId) || null
    }

    /**
     * 
     * @param {string} key 
     * @param {typeof Room} roomClass 
     */
    define(key, roomClass) {
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

    /**
     * 
     * @param {string} roomType 
     * @param {string} [roomId] 
     * @returns {Room}
     */
    create(roomType, roomId = null) {
        if (typeof roomType !== 'string') {
            throw new Error(`room create error: type=(${type}) must be a string`)
        }
        if (!this.defs.has(roomType)) {
            throw new Error(`room create error: type=(${roomType}) is not defined`)
        }

        if (roomId === null) {
            roomId = generateId(32)
        } else if (typeof roomId !== 'string') {
            throw new Error(`room create error: room id=(${roomId}) must be a string`)
        }

        if (this.rooms.has(roomId)) {
            throw new Error(`room create error: room id=(${roomId}) is taken`)
        }

        let RoomClass = this.defs.get(roomType)
        let room = new RoomClass(roomId, this, this.transportLayer)
        this.rooms.set(roomId, room)
        this.emit('create', roomId)
        return room
    }

    destroy(roomId) {
        if (!this.rooms.has(roomId)) {
            throw new Error(`room destroy error: roomId=(${roomId}) does not exist`)
        }

        let room = this.rooms.get(roomId)
        this.rooms.delete(roomId)
        room.handleDestroy()
        this.emit('destroy', roomId)
    }
    

}

export default RoomManager