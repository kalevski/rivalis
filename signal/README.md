# `@rivalis/signal`

> Signaling server for Rivalis P2P: WebRTC SDP/ICE relay and TURN credential issuance.

`@rivalis/signal` is a normal Rivalis app — a `SignalRoom` that relays SDP offers/answers
and ICE candidates between peers, plus an `IceConfig` that mints short-lived TURN credentials.
Game traffic never passes through signaling; after the WebRTC channel opens the signal server
is idle for that session.

```
peer (RTCClient)      @rivalis/signal (SignalRoom)      host (RTCTransport)
  │  WS connect + ticket ──────────────►│                       │
  │◄── signal:welcome {hostId, iceServers} ─────────────────────│
  │  signal:offer {to:host} ───────────►│─── getActor → send ──►│
  │◄────────── relay ───────────────────│◄── signal:answer ──────│
  │  signal:ice ⇄ (trickle, both ways via SignalRoom)            │
  │═══════════ DataChannel OPEN (direct or via TURN relay) ══════│
  │                                     │   (signal is idle from here)
```

## Install

```sh
npm install @rivalis/signal
```

Peer dependencies (must be installed by the host application):

```json
"@rivalis/core": ">=7 <8",
"@rivalis/handshake": ">=6 <7",
"@toolcase/base": "3.x",
"@toolcase/logging": "3.x",
"ws": "8.x"
```

## Quick start

```ts
import { SignalServer } from '@rivalis/signal'

const server = new SignalServer({
    port: 9000,
    secrets: [process.env.SIGNAL_SECRET!],
})

// server.rooms is a RoomManager — create additional sessions:
// server.rooms.create('signal', 'session-42')
```

Shut down gracefully:

```ts
process.on('SIGTERM', () => server.shutdown({ timeoutMs: 10_000 }))
```

## API

### `SignalServer`

```ts
class SignalServer {
    constructor(options: SignalServerOptions)
    readonly rooms: RoomManager<null>
    shutdown(opts?: { timeoutMs?: number }): Promise<void>
}

type SignalServerOptions = {
    port?: number            // required when server is not provided
    server?: http.Server     // attach to an existing HTTP server
    secrets: string[]        // ticket secrets; multiple = rotation support
    rateLimiter?: TokenBucketOptions
    allowedOrigins?: AllowedOrigins
}
```

### `IceConfig`

Issues ephemeral TURN credentials following coturn's `static-auth-secret` REST scheme:

```
username   = "<unixExpiry>:<peerId>"
credential = base64(HMAC_SHA1(ICE_TURN_SECRET, username))
```

```ts
class IceConfig {
    constructor(options: IceConfigOptions)
    static fromEnv(): IceConfig  // reads ICE_TURN_URLS, ICE_TURN_SECRET, ICE_STUN_URLS, ICE_TTL
    issueFor(peerId: string): string  // returns JSON-encoded RTCIceServer[]
}
```

`SignalRoom` calls `IceConfig.fromEnv()` and sends credentials to each peer inside
`signal:welcome`. Override `SignalRoom.iceConfig` in a subclass to inject a custom instance.

### `SignalAuthMiddleware`

Validates the ticket format `<roomId>:<secret>`. All configured secrets are accepted,
enabling zero-downtime rotation. Comparison is constant-time (SHA-256 + `timingSafeEqual`).

### Wire codec

```ts
import {
    encodeWelcome, decodeWelcome,
    encodeOffer, decodeOffer,
    encodeAnswer, decodeAnswer,
    encodeIceCandidate, decodeIceCandidate,
} from '@rivalis/signal'
```

Topics: `signal:welcome`, `signal:offer`, `signal:answer`, `signal:ice`, `signal:host_gone`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ICE_TURN_URLS` | _(none)_ | Comma-separated TURN URLs, e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349` |
| `ICE_TURN_SECRET` | _(none)_ | HMAC shared secret — must match `static-auth-secret` in `turnserver.conf` |
| `ICE_STUN_URLS` | _(none)_ | Comma-separated STUN-only URLs (no credentials) |
| `ICE_TTL` | `86400` | Credential TTL in seconds (default 24 h) |
| `RIVALIS_STUN_DEV` | _(off)_ | Dev-only pure-JS STUN responder (Phase 4, not yet implemented) |

When `ICE_TURN_URLS` or `ICE_TURN_SECRET` is absent, `IceConfig.issueFor()` returns an empty
array and no TURN relay is offered. Peers must fall back to direct STUN. Suitable for local
development; requires coturn in production to cross NAT.

## Deployment: coturn as a TURN relay sidecar

`@rivalis/signal` issues TURN credentials but does not implement a TURN relay — that is
coturn's job. See `p2p.md §4.3` and `p2p.md §14` for the rationale (STUN/TURN are UDP;
reimplementing them in Node would compete with game-loop CPU and is outside Node's idiomatic
strengths).

### Architecture

```
                  ┌─────────────────┐
   peers ──WS──►  │ @rivalis/signal │ (mints TURN creds via IceConfig)
                  └────────┬────────┘
                           │ shared ICE_TURN_SECRET
                  ┌────────▼────────┐
   peers ──UDP──► │ coturn (TURN)   │ (validates HMAC, relays UDP)
                  └─────────────────┘
```

Both processes use the same `static-auth-secret`. The signal server mints credentials;
coturn validates them without any network call between the two.

### Install coturn

```sh
# Debian / Ubuntu
apt-get install coturn

# macOS (dev/testing only)
brew install coturn

# Docker
docker run -d --network=host coturn/coturn
```

### Configure coturn

A ready-to-use template is at [`coturn/turnserver.conf`](coturn/turnserver.conf) in this
package. Copy it and replace the `<PLACEHOLDER>` values:

```sh
cp node_modules/@rivalis/signal/coturn/turnserver.conf /etc/turnserver.conf
$EDITOR /etc/turnserver.conf
```

Minimum required settings:

```conf
# Validates IceConfig-minted credentials. Must match ICE_TURN_SECRET.
use-auth-secret
static-auth-secret=<YOUR_SECRET>

# Realm — use your domain.
realm=turn.example.com

# Ports (see firewall section below).
listening-port=3478
tls-listening-port=5349
min-port=49152
max-port=65535

# Security: block relay to internal addresses.
fingerprint
no-loopback-peers
no-multicast-peers
```

Start coturn:

```sh
turnserver -c /etc/turnserver.conf
# or
systemctl start coturn
```

### Ports and firewall

| Port | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| 3478 | UDP | inbound | STUN binding requests and TURN allocation |
| 3478 | TCP | inbound | TURN over TCP (fallback for UDP-blocked clients) |
| 5349 | TCP | inbound | TURNS — TURN over TLS (recommended for production) |
| 49152–65535 | UDP | inbound | TURN relay ports (allocated per session) |

Open all of these in your firewall or security group. The relay port range must be reachable
by every peer that may use the relay path.

### TLS (TURNS)

TURNS (`turns:` scheme, port 5349) is strongly recommended in production — it works through
HTTPS-only proxies and corporate firewalls where plain UDP/TCP TURN is blocked.

Obtain a certificate (Let's Encrypt example):

```sh
certbot certonly --standalone -d turn.example.com
```

Add to `turnserver.conf`:

```conf
tls-listening-port=5349
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
```

Set both schemes in `ICE_TURN_URLS` so clients can fall back:

```sh
ICE_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
```

Auto-renew: certbot's renewal hook should restart coturn after cert renewal:

```sh
# /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
#!/bin/sh
systemctl restart coturn
```

### Secret rotation (zero-downtime)

Both the signal server (`ICE_TURN_SECRET`) and coturn (`static-auth-secret`) share one
secret. Rotation requires a brief overlap window:

1. **Generate a new secret.**
   ```sh
   openssl rand -hex 32
   ```

2. **Update the signal server first.** Set `ICE_TURN_SECRET` to the new secret and restart
   (or hot-reload) the signal process. New credentials are minted with the new secret from
   this point.

3. **Wait for old credentials to expire.** The maximum window is `ICE_TTL` (default 24 h).
   Peers whose credentials were minted before step 2 will continue to work on coturn (which
   still has the old `static-auth-secret`) until their credentials expire.

4. **Update coturn.** Replace `static-auth-secret` in `turnserver.conf` with the new secret
   and restart:
   ```sh
   systemctl restart coturn
   ```
   From this point coturn accepts only credentials minted with the new secret.

For a rolling coturn deployment (multiple instances behind a load balancer), restart each
instance one at a time during step 4. The TTL overlap keeps the other instances accepting
both old and new creds via the unchanged `static-auth-secret` until each restarts.

**Never log or expose `ICE_TURN_SECRET`.** Clients receive only the derived
`username`/`credential` pair, which is time-limited and peer-scoped.

### Environment example (production)

```sh
# signal server environment
SIGNAL_SECRET=<strong-random-secret-for-ticket-auth>
ICE_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
ICE_TURN_SECRET=<strong-random-secret-shared-with-coturn>
ICE_STUN_URLS=stun:turn.example.com:3478
ICE_TTL=86400

# coturn turnserver.conf (matching ICE_TURN_SECRET above)
use-auth-secret
static-auth-secret=<strong-random-secret-shared-with-coturn>
```

### Docker Compose example

```yaml
services:
  signal:
    image: your-org/signal:latest
    environment:
      SIGNAL_SECRET: "${SIGNAL_SECRET}"
      ICE_TURN_URLS: "turn:turn.example.com:3478,turns:turn.example.com:5349"
      ICE_TURN_SECRET: "${ICE_TURN_SECRET}"
      ICE_STUN_URLS: "stun:turn.example.com:3478"
    ports:
      - "9000:9000"

  coturn:
    image: coturn/coturn:latest
    network_mode: host   # required for relay port allocation
    volumes:
      - ./coturn/turnserver.conf:/etc/coturn/turnserver.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
    command: -c /etc/coturn/turnserver.conf
```

> `network_mode: host` is required because coturn allocates relay UDP ports dynamically
> from `min-port`–`max-port`. Port mapping every relay port individually is impractical;
> host networking is the standard approach for containerised coturn.

### Browser peers and TURN

When a browser `RTCClient` connects to `@rivalis/signal`, the `signal:welcome`
message includes `iceServers` — a JSON array of `RTCIceServer` objects with short-lived
TURN credentials minted by `IceConfig`. `RTCClient` passes this array to
`RTCPeerConnection` automatically. **No browser-side configuration is needed to enable
TURN** — provision coturn and set the environment variables above, and browser peers
will traverse NAT via the relay without any extra client code.

```ts
import { RTCClient } from '@rivalis/browser'

// ICE servers (including TURN creds) are delivered in signal:welcome — nothing else needed.
const client = new RTCClient('wss://signal.example.com:9000')
client.connect(ticket)   // ticket = '<roomId>:<secret>'
client.on('client:connect', () => console.log('P2P connected (direct or via TURN)'))
client.on('ttt:state', (payload) => render(decode(payload)))
client.send('place', encode({ index: 4 }))
```

#### Production requirements for browser peers

- **`wss://` for the signal URL.** Browsers block `ws://` connections from HTTPS pages.
  Deploy `@rivalis/signal` behind TLS and use `wss://` in the `RTCClient` constructor.
- **`turns:` alongside `turn:`.** Set both schemes in `ICE_TURN_URLS`. The `turns:` URL
  works through HTTPS proxies and corporate firewalls where plain UDP/TCP TURN is blocked;
  `turn:` is the direct fallback for less-restrictive networks:

  ```sh
  ICE_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
  ```

  See [TLS (TURNS)](#tls-turns) above for the coturn certificate setup.

#### Forced-relay testing for browsers

To verify that the TURN relay is reachable and credentials are correct, pass an `adapters`
override that sets `iceTransportPolicy: 'relay'`. This forces the browser to ignore direct
and STUN paths and connect only through the relay — if the channel opens, coturn is wired correctly.

```ts
import { RTCClient } from '@rivalis/browser'

const client = new RTCClient('wss://signal.example.com:9000', {
    adapters: {
        createPeerConnection: (config) =>
            new RTCPeerConnection({ ...config, iceTransportPolicy: 'relay' }),
    },
})
client.connect(ticket)
```

Revert the `adapters` override for production — `iceTransportPolicy` defaults to `'all'`
(use direct/STUN first, fall back to TURN only when needed).

> Provision coturn and configure `ICE_TURN_URLS` / `ICE_TURN_SECRET` first — see
> [Install coturn](#install-coturn) and [Configure coturn](#configure-coturn) above.
> The template at [`coturn/turnserver.conf`](coturn/turnserver.conf) documents all
> required settings.

### CI / forced-relay testing

To verify TURN relay end-to-end in CI, run a coturn container with `iceTransportPolicy:'relay'`
on the client. See task `077-node-low-nat-turn-relay-test.md` for the full test setup.

## Security

- **Credentials are ephemeral.** `IceConfig.issueFor()` mints short-lived creds
  (`username = <unixExpiry>:<peerId>`). coturn rejects creds past `unixExpiry`. The shared
  secret never leaves the server.
- **Signaling is authenticated.** The WS leg is gated by `SignalAuthMiddleware` with
  constant-time secret comparison. Configure `allowedOrigins` to mitigate CSRF.
- **No JS TURN relay.** Production relay is coturn — never reimplemented in Node. See
  `CHANGELOG.md` D6 and `p2p.md §4.3` for the full rationale.
- **DTLS by default.** WebRTC data channels are DTLS-encrypted — game traffic is encrypted
  end-to-end with no extra work.
- **`RIVALIS_STUN_DEV=true`** enables a dev-only pure-JS STUN responder (Phase 4, not yet
  implemented). It handles binding requests only, has no relay capability, and must never be
  used on a production port.

## License

MIT
