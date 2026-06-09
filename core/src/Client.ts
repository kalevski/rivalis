import { Broadcast } from '@toolcase/base'

export type ClientEvent =
    | 'client:connect'
    | 'client:disconnect'
    | 'client:kicked'
    | 'client:reconnecting'
    | 'client:reconnect_failed'
    | 'client:error'

export type ClientKickedEvent = {
    code: number
    reason: string
}

abstract class Client<TTopics extends string = string> extends Broadcast {

    abstract get connected(): boolean
    abstract connect(ticket?: string): void
    abstract disconnect(): void
    abstract send(topic: string, payload?: Uint8Array | string): void

    override on(event: 'client:connect', listener: () => void, context?: unknown): this
    override on(event: 'client:disconnect', listener: (payload: Uint8Array) => void, context?: unknown): this
    override on(event: 'client:kicked', listener: (info: ClientKickedEvent) => void, context?: unknown): this
    override on(event: 'client:reconnecting', listener: (payload: Uint8Array) => void, context?: unknown): this
    override on(event: 'client:reconnect_failed', listener: () => void, context?: unknown): this
    override on(event: 'client:error', listener: (error: Error) => void, context?: unknown): this
    override on<K extends TTopics>(event: K, listener: (payload: Uint8Array, topic: K) => void, context?: unknown): this
    override on(event: string | symbol, listener: (...args: any[]) => void, context?: unknown): this
    override on(event: string | symbol, listener: (...args: any[]) => void, context?: unknown): this {
        return super.on(event, listener, context)
    }

    override once(event: 'client:connect', listener: () => void, context?: unknown): this
    override once(event: 'client:disconnect', listener: (payload: Uint8Array) => void, context?: unknown): this
    override once(event: 'client:kicked', listener: (info: ClientKickedEvent) => void, context?: unknown): this
    override once(event: 'client:reconnecting', listener: (payload: Uint8Array) => void, context?: unknown): this
    override once(event: 'client:reconnect_failed', listener: () => void, context?: unknown): this
    override once(event: 'client:error', listener: (error: Error) => void, context?: unknown): this
    override once<K extends TTopics>(event: K, listener: (payload: Uint8Array, topic: K) => void, context?: unknown): this
    override once(event: string | symbol, listener: (...args: any[]) => void, context?: unknown): this
    override once(event: string | symbol, listener: (...args: any[]) => void, context?: unknown): this {
        return super.once(event, listener, context)
    }

    override off(event: ClientEvent | TTopics | string | symbol, listener: (...args: any[]) => void, context?: unknown): this {
        return super.off(event, listener, context)
    }

}

export default Client
