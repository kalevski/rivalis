import type Room from './Room'

class Actor<TActorData = Record<string, unknown>> {

    readonly id: string

    readonly data: TActorData | null

    readonly joined: Date = new Date()

    private room: Room<TActorData>

    private storage: Map<string, unknown> = new Map()

    constructor(id: string, data: TActorData | null, room: Room<TActorData>) {
        this.id = id
        this.data = data
        this.room = room
    }

    send(topic: string, payload: Uint8Array | string): void {
        this.room.send(this, topic, payload)
    }

    kick(payload: Uint8Array | string = ''): void {
        this.room.kick(this, payload)
    }

    save<T = unknown>(key: string, data: T): void {
        this.storage.set(key, data)
    }

    get<T = unknown>(key: string): T | null {
        const data = this.storage.get(key)
        if (typeof data === 'undefined') {
            return null
        }
        return data as T
    }

}

export default Actor
