import Room from './Room'

class Actor {

    /**
     * @readonly
     * @type {string}
     */
    id = null

    /**
     * @readonly
     * @type {Object<string,any>|null}
     */
    data = null

    /**
     * @readonly
     */
    joined = new Date()

    /**
     * @private
     * @type {Room}
     */
    room = null

    /**
     * @private
     * @type {Map<string,any>}
     */
    storage = new Map()

    /**
     * 
     * @param {string} id 
     * @param {Object<string,any>} data 
     * @param {Room} room 
     */
    constructor(id, data, room) {
        this.id = id
        this.data = data
        this.room = room
    }

    /**
     * @param {string} topic
     * @param {Uint8Array|string} payload 
     */
    send(topic, payload) {
        this.room.send(this, topic, payload)
    }

    /**
     * 
     * @param {Uint8Array|string} [payload] 
     */
    kick(payload) {
        this.room.kick(this, payload)
    }

    /**
     * 
     * @param {string} key 
     * @param {any} data 
     */
    save(key, data) {
        this.storage.set(key, data)
    }

    /**
     * 
     * @param {string} key
     * @returns {any} 
     */
    get(key) {
        let data = this.storage.get(key)
        if (typeof data === 'undefined') {
            return null
        }
        return data
    }

}

export default Actor