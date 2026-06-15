import { createSocket } from 'node:dgram'
import type { Socket, RemoteInfo } from 'node:dgram'

const MAGIC_COOKIE     = 0x2112A442
const BINDING_REQUEST  = 0x0001
const BINDING_RESPONSE = 0x0101
const ATTR_XOR_MAPPED  = 0x0020

/**
 * Minimal pure-JS STUN Binding Request responder for local development.
 *
 * ⚠  DEV ONLY — NOT FOR PRODUCTION USE.
 *    Handles STUN Binding Requests (RFC 8489 §6.3) over UDP/IPv4.
 *    Never relays data — there is no TURN support (use coturn for TURN).
 *    No authentication, no quota, no TLS — localhost and LAN only.
 *
 * Enabled when RIVALIS_STUN_DEV=true is set in the environment, or
 * programmatically via `new DevStunResponder().listen()`.
 *
 * For production, provision a coturn sidecar and set ICE_TURN_URLS /
 * ICE_TURN_SECRET in IceConfig (see signal/coturn/turnserver.conf).
 */
class DevStunResponder {
    private readonly port: number
    private readonly host: string
    private socket: Socket | null = null
    private listening = false

    constructor(options: { port?: number; host?: string } = {}) {
        this.port = options.port ?? 3478
        this.host = options.host ?? '0.0.0.0'
    }

    /**
     * Start the UDP listener.
     * Resolves to the bound port (useful when port=0 for OS-assigned ephemeral).
     * Idempotent: a second call resolves immediately with the current port.
     */
    listen(): Promise<number> {
        if (this.listening && this.socket !== null) {
            return Promise.resolve((this.socket.address() as unknown as { port: number }).port)
        }

        return new Promise<number>((resolve, reject) => {
            const sock = createSocket('udp4')
            // Store immediately so close() can always close the socket,
            // even if called before the bind callback fires.
            this.socket = sock

            sock.on('error', (err) => {
                const wasListening = this.listening
                this.socket = null
                this.listening = false
                if (!wasListening) {
                    reject(err)
                } else {
                    process.stderr.write(`[rivalis:signal] DevStunResponder error: ${err.message}\n`)
                }
            })

            sock.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
                this.handleMessage(msg, rinfo)
            })

            sock.bind(this.port, this.host, () => {
                this.listening = true
                const bound = (sock.address() as unknown as { port: number }).port
                // Emit to stderr so users notice this is a dev-only service.
                process.stderr.write(
                    `[rivalis:signal] ⚠ DevStunResponder listening on udp://${this.host}:${bound} ` +
                    `— DEV ONLY, NOT FOR PRODUCTION. No TURN relay.\n`
                )
                resolve(bound)
            })
        })
    }

    /** Close the UDP socket. Safe to call before listen() or multiple times. */
    close(): Promise<void> {
        return new Promise<void>((resolve) => {
            if (this.socket === null) {
                resolve()
                return
            }
            this.socket.close(() => {
                this.socket = null
                this.listening = false
                resolve()
            })
        })
    }

    /**
     * Read RIVALIS_STUN_DEV from the environment and, when set to 'true',
     * create and start a DevStunResponder.
     * Returns null when the flag is absent (disabled by default).
     *
     * Optional `onError` receives bind/socket errors; defaults to stderr.
     */
    static fromEnv(onError?: (err: Error) => void): DevStunResponder | null {
        if (process.env['RIVALIS_STUN_DEV'] !== 'true') return null

        const rawPort = process.env['RIVALIS_STUN_DEV_PORT']
        const port = rawPort !== undefined ? parseInt(rawPort, 10) : 3478
        const host = process.env['RIVALIS_STUN_DEV_HOST'] ?? '0.0.0.0'

        const responder = new DevStunResponder({
            port: isNaN(port) ? 3478 : port,
            host,
        })

        responder.listen().catch((err: Error) => {
            if (onError !== undefined) {
                onError(err)
            } else {
                process.stderr.write(`[rivalis:signal] DevStunResponder failed to bind: ${err.message}\n`)
            }
        })

        return responder
    }

    private handleMessage(msg: Buffer, rinfo: RemoteInfo): void {
        // Minimum STUN header is 20 bytes.
        if (msg.byteLength < 20) return

        // Top 2 bits of byte 0 must be 0b00 (STUN indicator, RFC 8489 §5).
        if ((msg[0]! & 0xc0) !== 0x00) return

        // Validate magic cookie (bytes 4–7).
        if (msg.readUInt32BE(4) !== MAGIC_COOKIE) return

        // Only respond to Binding Request (0x0001).
        if (msg.readUInt16BE(0) !== BINDING_REQUEST) return

        // Transaction ID: bytes 8–19 (12 bytes).
        const txId = msg.subarray(8, 20)

        const response = this.buildBindingResponse(txId, rinfo)
        this.socket?.send(response, rinfo.port, rinfo.address)
    }

    private buildBindingResponse(txId: Buffer, rinfo: RemoteInfo): Buffer {
        const parts = rinfo.address.split('.').map(Number)
        const port  = rinfo.port

        // XOR-MAPPED-ADDRESS value (RFC 8489 §14.1.1, IPv4):
        //   X-Port    = port    XOR upper-16-bits(MAGIC_COOKIE) = port XOR 0x2112
        //   X-Address = ip_u32  XOR MAGIC_COOKIE
        const xPort = (port ^ (MAGIC_COOKIE >>> 16)) & 0xffff
        const ip32  = (
            ((parts[0]! << 24) |
             (parts[1]! << 16) |
             (parts[2]! <<  8) |
              parts[3]!) >>> 0
        )
        const xAddr = (ip32 ^ MAGIC_COOKIE) >>> 0

        // Attribute: type(2) + length(2) + value(8) = 12 bytes
        const attr = Buffer.allocUnsafe(12)
        attr.writeUInt16BE(ATTR_XOR_MAPPED, 0)
        attr.writeUInt16BE(8, 2)    // value length
        attr[4] = 0x00              // reserved
        attr[5] = 0x01              // IPv4 family
        attr.writeUInt16BE(xPort, 6)
        attr.writeUInt32BE(xAddr, 8)

        // STUN response header: 20 bytes
        const header = Buffer.allocUnsafe(20)
        header.writeUInt16BE(BINDING_RESPONSE, 0)
        header.writeUInt16BE(attr.byteLength, 2)
        header.writeUInt32BE(MAGIC_COOKIE, 4)
        txId.copy(header, 8)

        return Buffer.concat([header, attr])
    }
}

export default DevStunResponder
