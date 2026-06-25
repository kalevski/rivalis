import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { type PeerInfo, type MeshMessage } from '../protocol'

type ChatHandler = (from: string, text: string) => void
type LogHandler = (line: string) => void

// One inbound WebSocket server other peers dial, plus the outbound clients this peer dials.
// Per pair, only the peer with the greater signalling id dials, so exactly one socket exists.
class Mesh {

    private selfId: string = ''

    private readonly selfName: string
    private readonly host: string
    private readonly port: number
    private readonly onChat: ChatHandler
    private readonly log: LogHandler

    // Live sockets, keyed by the remote peer's signalling id.
    private links: Map<string, WebSocket> = new Map()

    // Names of every known peer (a superset of `links`), so a leave can be reported even without a socket.
    private names: Map<string, string> = new Map()

    private server: WebSocketServer | null = null

    constructor(selfName: string, host: string, port: number, onChat: ChatHandler, log: LogHandler) {
        this.selfName = selfName
        this.host = host
        this.port = port
        this.onChat = onChat
        this.log = log
    }

    setSelfId(id: string): void {
        this.selfId = id
    }

    // Start the inbound endpoint other peers dial. Resolves once listening.
    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = new WebSocketServer({ host: this.host, port: this.port })
            server.on('connection', socket => this.onInbound(socket))
            server.once('listening', () => resolve())
            server.once('error', reject)
            this.server = server
        })
    }

    // Dial only if we sort after the peer; otherwise their inbound connection will arrive.
    link(peer: PeerInfo): void {
        if (peer.id === this.selfId) return
        this.names.set(peer.id, peer.name)
        if (this.links.has(peer.id)) return
        if (this.selfId > peer.id) {
            this.dial(peer)
        }
    }

    // Tear down the link to a peer that left. Returns its name, or null.
    drop(peerId: string): string | null {
        const name = this.names.get(peerId) ?? null
        const socket = this.links.get(peerId)
        if (socket !== undefined) {
            this.links.delete(peerId)
            this.names.delete(peerId)
            try { socket.close() } catch { /* already closing */ }
        }
        return name
    }

    broadcast(text: string): void {
        const message: MeshMessage = { kind: 'chat', text }
        this.links.forEach(socket => this.write(socket, message))
    }

    get size(): number {
        return this.links.size
    }

    stop(): void {
        this.links.forEach(socket => { try { socket.close() } catch { /* noop */ } })
        this.links.clear()
        this.names.clear()
        this.server?.close()
        this.server = null
    }

    private dial(peer: PeerInfo): void {
        const socket = new WebSocket(`ws://${peer.host}:${peer.port}`)
        socket.on('open', () => {
            this.write(socket, { kind: 'hello', peerId: this.selfId, name: this.selfName })
            this.register(peer.id, peer.name, socket)
        })
        socket.on('message', raw => this.onMessage(peer.id, raw))
        socket.on('close', () => this.forget(peer.id))
        socket.on('error', error => this.log(`direct link to ${peer.name} failed: ${asMessage(error)}`))
    }

    private onInbound(socket: WebSocket): void {
        let peerId: string | null = null
        socket.on('message', raw => {
            const message = parse(raw)
            if (message === null) return
            if (message.kind === 'hello') {
                if (peerId !== null) return
                if (this.links.has(message.peerId)) {
                    // A link to this peer already exists — drop the duplicate.
                    try { socket.close() } catch { /* noop */ }
                    return
                }
                peerId = message.peerId
                this.register(peerId, message.name, socket)
                return
            }
            if (message.kind === 'chat' && peerId !== null) {
                this.onChat(this.names.get(peerId) ?? '?', message.text)
            }
        })
        socket.on('close', () => { if (peerId !== null) this.forget(peerId) })
        socket.on('error', () => { /* inbound peer vanished; signalling drives the leave */ })
    }

    private onMessage(peerId: string, raw: RawData): void {
        const message = parse(raw)
        if (message === null) return
        if (message.kind === 'chat') {
            this.onChat(this.names.get(peerId) ?? '?', message.text)
        }
    }

    private register(peerId: string, name: string, socket: WebSocket): void {
        this.links.set(peerId, socket)
        this.names.set(peerId, name)
    }

    // Drop the socket but keep the name; the authoritative leave comes from signalling `peer:leave`.
    private forget(peerId: string): void {
        this.links.delete(peerId)
    }

    private write(socket: WebSocket, message: MeshMessage): void {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(message))
        }
    }

}

const parse = (raw: RawData): MeshMessage | null => {
    try {
        const value = JSON.parse(raw.toString()) as MeshMessage
        if (value.kind === 'hello' || value.kind === 'chat') return value
        return null
    } catch {
        return null
    }
}

const asMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

export default Mesh
