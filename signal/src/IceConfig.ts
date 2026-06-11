import { createHmac } from 'node:crypto'

export type RTCIceServer = {
    urls: string | string[]
    username?: string
    credential?: string
}

export type IceConfigOptions = {
    /** TURN server URLs, e.g. ['turn:turn.example.com:3478']. Empty = no TURN. */
    turnUrls: string[]
    /** HMAC-SHA1 shared secret for coturn static-auth-secret REST scheme. */
    secret: string
    /** Credential TTL in seconds. Default 86400 (24 h). */
    ttl?: number
    /** Optional extra STUN-only servers (no credentials needed). */
    stunUrls?: string[]
}

/**
 * Issues ephemeral ICE/TURN credentials for a specific peer.
 *
 * Credential format (coturn static-auth-secret REST scheme):
 *   username   = "<unixExpiry>:<peerId>"
 *   credential = base64(HMAC_SHA1(secret, username))
 *
 * coturn validates the HMAC and rejects creds past their expiry timestamp.
 * The shared secret never leaves the server — clients receive only the
 * derived username/credential pair.
 */
class IceConfig {
    private readonly turnUrls: string[]
    private readonly secret: string
    private readonly ttl: number
    private readonly stunUrls: string[]

    constructor(options: IceConfigOptions) {
        this.turnUrls = options.turnUrls
        this.secret = options.secret
        this.ttl = options.ttl ?? 86400
        this.stunUrls = options.stunUrls ?? []
    }

    /** Build an IceConfig from environment variables.
     *
     * - `ICE_TURN_URLS`   — comma-separated TURN URLs
     * - `ICE_TURN_SECRET` — HMAC shared secret
     * - `ICE_STUN_URLS`   — comma-separated STUN URLs (optional)
     * - `ICE_TTL`         — credential TTL in seconds (default 86400)
     */
    static fromEnv(): IceConfig {
        const turnUrls = (process.env['ICE_TURN_URLS'] ?? '').split(',').map(s => s.trim()).filter(Boolean)
        const secret = process.env['ICE_TURN_SECRET'] ?? ''
        const stunUrls = (process.env['ICE_STUN_URLS'] ?? '').split(',').map(s => s.trim()).filter(Boolean)
        const ttl = parseInt(process.env['ICE_TTL'] ?? '86400', 10)
        return new IceConfig({ turnUrls, secret, stunUrls, ttl: isNaN(ttl) ? 86400 : ttl })
    }

    /**
     * Mint ephemeral TURN credentials for `peerId` and return the full
     * ICE server list as a JSON string suitable for the wire codec.
     *
     * When `turnUrls` is empty or `secret` is absent, TURN entries are
     * omitted and only STUN servers (if any) are returned.
     */
    issueFor(peerId: string): string {
        const servers: RTCIceServer[] = []

        for (const url of this.stunUrls) {
            servers.push({ urls: url })
        }

        if (this.turnUrls.length > 0 && this.secret) {
            const expiry = Math.floor(Date.now() / 1000) + this.ttl
            const username = `${expiry}:${peerId}`
            const credential = createHmac('sha1', this.secret)
                .update(username)
                .digest('base64')
            servers.push({ urls: this.turnUrls, username, credential })
        }

        return JSON.stringify(servers)
    }
}

export default IceConfig
