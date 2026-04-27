import type { Logger } from '@toolcase/logging'
import Actor from './Actor'
import type RoomManager from './RoomManager'
import type TLayer from './TLayer'
import type { ForEachFn, TopicListener } from './types'

const ERROR = {
    INVALID_MESSAGE: 'invalid_message',
    ROOM_DESTROYED: 'room_destroyed'
}

const PRESENCE_JOIN_TOPIC = '__presence:join'
const PRESENCE_LEAVE_TOPIC = '__presence:leave'

class Room<TActorData = Record<string, unknown>> {

    readonly id: string

    /**
     * Opt-in: when `true`, the room auto-broadcasts `__presence:join` and
     * `__presence:leave` whenever an actor joins or leaves. The payload is
     * JSON `{ id, data }`. Subclasses enable with `protected override presence = true`.
     */
    protected presence: boolean = false

    /**
     * Maximum number of joined actors. `null` means unlimited. When reached,
     * `TLayer.grantAccess` rejects new joins with reason `room_full`.
     */
    maxActors: number | null = null

    /**
     * Whether new actors may join. Set to `false` to temporarily refuse joins
     * (e.g. game in progress). Rejection reason is `room_not_joinable`.
     */
    joinable: boolean = true

    protected logger: Logger | null = null

    private manager: RoomManager<TActorData> | null = null

    private transportLayer: TLayer<TActorData> | null = null

    private topics: Map<string, TopicListener<TActorData>> = new Map()

    private actors: Map<string, Actor<TActorData>> = new Map()

    constructor(roomId: string, manager: RoomManager<TActorData>, transportLayer: TLayer<TActorData>) {
        this.id = roomId
        this.logger = manager.logging.getLogger(`room=${roomId}`)
        this.manager = manager
        this.transportLayer = transportLayer
        this.onCreate()
        this.logger.info('created')
    }

    get actorCount(): number {
        return this.actors.size
    }

    protected onCreate(): void {}

    protected onJoin(_actor: Actor<TActorData>): void {}

    protected onLeave(_actor: Actor<TActorData>): void {}

    protected onDestroy(): void {}

    protected bind(topic: string, topicListener: TopicListener<TActorData>, context: unknown = null): boolean {
        if (typeof topic !== 'string') {
            throw new Error(`topic must be a string, ${topic} provided`)
        }
        if (typeof topicListener !== 'function') {
            throw new Error(`topicListener must be a function, ${topicListener} provided`)
        }
        if (this.topics.has(topic)) {
            return false
        }
        this.topics.set(topic, topicListener.bind(context === null ? this : context) as TopicListener<TActorData>)
        return true
    }

    protected unbind(topic: string): boolean {
        if (typeof topic !== 'string') {
            throw new Error(`topic must be a string, ${topic} provided`)
        }
        return this.topics.delete(topic)
    }

    send(actor: Actor<TActorData>, topic: string, payload: Uint8Array | string): void {
        if (typeof topic !== 'string') {
            throw new Error(`send error: topic must be a sting, ${topic} provided`)
        }
        if (!(actor instanceof Actor)) {
            throw new Error(`send error: actor=${actor} must be an instance of Actor`)
        }
        if (this.transportLayer === null) {
            return
        }
        if (payload instanceof Uint8Array) {
            return this.transportLayer.send(actor.id, topic, payload)
        }
        if (typeof payload === 'string') {
            return this.transportLayer.send(actor.id, topic, Buffer.from(payload, 'utf-8'))
        }
        throw new Error(`send error: invalid payload=${payload}, must be a string or Buffer`)
    }

    broadcast(topic: string, payload: Uint8Array | string): void {
        this.each(actor => this.send(actor, topic, payload))
    }

    each(foreachFn: ForEachFn<TActorData>): void {
        this.actors.forEach(foreachFn)
    }

    kick(actor: Actor<TActorData>, payload: Uint8Array | string = ''): void {
        if (this.transportLayer === null) {
            return
        }
        if (payload instanceof Uint8Array) {
            return this.transportLayer.kick(actor.id, payload)
        }
        if (typeof payload === 'string') {
            return this.transportLayer.kick(actor.id, Buffer.from(payload, 'utf-8'))
        }
        throw new Error(`kick error: invalid payload=${payload}, must be a string or Buffer`)
    }

    destroy(): void {
        this.manager?.destroy(this.id)
    }

    /** @internal */
    handleDestroy(): void {
        this.each(actor => actor.kick(ERROR.ROOM_DESTROYED))
        this.onDestroy()
        this.actors.clear()
        this.topics.clear()
        this.transportLayer = null
        this.manager = null
        this.logger?.info('destroyed')
        this.logger = null
    }

    /** @internal */
    handleJoin(actorId: string, data: TActorData | null = null): void {
        const actor = new Actor<TActorData>(actorId, data, this)
        this.actors.set(actorId, actor)
        this.onJoin(actor)
        if (this.presence) {
            this.broadcast(PRESENCE_JOIN_TOPIC, JSON.stringify({ id: actorId, data }))
        }
    }

    /** @internal */
    handleMessage(actorId: string, topic: string, payload: Uint8Array): void {
        let topicListener = this.topics.get(topic) ?? null
        if (topicListener === null) {
            topicListener = this.topics.get('*') ?? null
        }
        const actor = this.actors.get(actorId) ?? null
        if (actor === null) {
            this.logger?.debug(`message dropped for unknown actor id=${actorId} on topic=${topic}`)
            return
        }
        if (topicListener === null) {
            this.logger?.debug(`actor id=${actorId} is kicked, reason: sending message on non existing topic=${topic}`)
            return actor.kick(ERROR.INVALID_MESSAGE)
        }
        topicListener(actor, payload, topic)
    }

    /** @internal */
    handleLeave(actorId: string): void {
        const actor = this.actors.get(actorId)
        if (actor !== undefined) {
            this.onLeave(actor)
            if (this.presence) {
                this.actors.delete(actorId)
                this.broadcast(PRESENCE_LEAVE_TOPIC, JSON.stringify({ id: actorId, data: actor.data }))
                return
            }
        }
        this.actors.delete(actorId)
    }
}

export default Room
