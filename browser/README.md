# @rivalis/browser

[![GitHub](https://img.shields.io/github/license/kalevski/rivalis?style=for-the-badge)](https://github.com/kalevski/rivalis/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/@rivalis/browser?color=teal&label=VERSION&style=for-the-badge)](https://www.npmjs.com/package/@rivalis/browser)
[![npm downloads](https://img.shields.io/npm/dw/@rivalis/browser?label=downloads&style=for-the-badge)](https://www.npmjs.com/package/@rivalis/browser)

The browser WebSocket client for [Rivalis](https://github.com/kalevski/rivalis). Connects to a [`@rivalis/core`](https://github.com/kalevski/rivalis/tree/main/core) server, decodes binary frames into typed events, and handles reconnection.

## ⭐ Features

- **Tiny surface** — `connect`, `disconnect`, `send`, `on` / `once` / `off`. That's it.
- **Typed events** — `client:connect`, `client:disconnect`, `client:kicked`, `client:reconnecting`, `client:reconnect_failed` with their actual payload shapes; user topics typed via an optional generic.
- **Exponential-backoff reconnect** with jitter (opt-in).
- **Token-refresh hook** — `getTicket` is called before every reconnect attempt; perfect for short-lived JWTs.
- **Two ticket-delivery modes** — query string (default, back-compat) or `Sec-WebSocket-Protocol` header (recommended for production — keeps credentials out of access logs and browser history).
- **Native browser WebSocket only** — no `ws` dependency, no polyfill.

## 🚀 Install

```bash
npm install @rivalis/browser
```

`@rivalis/browser` declares its dependencies as **peers**:

```bash
npm install @toolcase/base @toolcase/logging @toolcase/serializer
```

## 🚀 Hello world

```ts
import { WSClient } from '@rivalis/browser'

const ws = new WSClient('ws://localhost:8080')
const encoder = new TextEncoder()
const decoder = new TextDecoder()

ws.on('client:connect', () => console.log('connected'))
ws.on('client:disconnect', (reason) => console.log('disconnected:', decoder.decode(reason)))
ws.on('chat', (payload) => console.log('chat:', decoder.decode(payload)))

ws.connect('alice')                                // ticket = "alice"
ws.send('chat', encoder.encode('hello world'))     // payload is opaque bytes
```

`payload` is always a `Uint8Array`. The framework never inspects it — encode it however you like (JSON + `TextEncoder`, protobuf, msgpack…).

## 🧠 API

### Constructor

```ts
new WSClient<TTopics extends string = string>(baseURL: string, options?: WSClientOptions)
```

```ts
type WSClientOptions = {
    reconnect?: boolean | WSClientReconnectOptions
    ticketSource?: 'query' | 'protocol'      // default 'query'
    getTicket?: () => string | Promise<string>
}

type WSClientReconnectOptions = {
    maxAttempts?: number      // default Infinity
    baseDelayMs?: number      // default 500
    maxDelayMs?: number       // default 10_000
}
```

### Methods

| Method | Description |
|---|---|
| `connect(ticket?)` | Open a new connection. The ticket is what your server's `AuthMiddleware.authenticate` receives. |
| `disconnect()` | Close gracefully. Cancels pending reconnects, nulls `lastTicket`. |
| `send(topic, payload?)` | Send a frame. `payload`: `Uint8Array \| string` (strings are UTF-8 encoded for you). Drops with a warning if not in `OPEN` state. |
| `on(event, listener, context?)` | Subscribe to an event. |
| `once(event, listener, context?)` | One-shot subscribe. |
| `off(event, listener, context?)` | Unsubscribe. |

### Events

| Event | Payload | When it fires |
|---|---|---|
| `client:connect` | – | WebSocket handshake completed (auth may still kick the connection right after). |
| `client:disconnect` | `Uint8Array` (close-frame reason, UTF-8) | Socket closed for any reason. |
| `client:kicked` | `{ code: number, reason: string }` | Server closed with a 4xxx app-level code. Fires *before* `client:disconnect`. |
| `client:reconnecting` | `Uint8Array` (attempt number as UTF-8 string) | Reconnect attempt scheduled; backoff is already running. |
| `client:reconnect_failed` | – | `maxAttempts` exhausted, or `getTicket` threw. Terminal — no further attempts. |
| `<your topic>` | `Uint8Array` | Inbound frame on a server-broadcast topic. |

The default — non-reconnecting — flow is `client:connect` → … → `client:disconnect` (with a `client:kicked` in between if the server actively closed with a 4xxx code).

### Typed topics generic

Constrain user-topic listeners to a known set:

```ts
type AppTopics = 'lobby:state' | 'chat' | 'game:tick'

const ws = new WSClient<AppTopics>('ws://localhost:8080')

ws.on('chat', (payload) => { ... })           // ✓
ws.on('typo:state', (payload) => { ... })     // type error
ws.on('client:kicked', ({ code, reason }) => { ... })  // built-in events still typed
```

Built-in `client:*` events keep their typed payload shape regardless of the generic.

## 🔁 Reconnection

```ts
const ws = new WSClient(url, { reconnect: true })   // exp backoff with jitter, no attempt limit

const ws2 = new WSClient(url, {
    reconnect: { maxAttempts: 8, baseDelayMs: 250, maxDelayMs: 5000 }
})

ws2.on('client:reconnecting', (n) => {
    console.log('attempt', new TextDecoder().decode(n))
})
ws2.on('client:reconnect_failed', () => {
    console.log('gave up — surface a "reconnect" button to the user')
})
```

**Reconnect skips terminal close codes.** If the server kicked the connection with `INVALID_TICKET`, `KICKED`, or `ROOM_REJECTED`, the client treats it as terminal and won't reconnect — those mean the server doesn't want you back, so retrying is just noise.

## 🪪 Refreshing tickets across reconnects

If your tickets are short-lived (signed JWTs that expire), reconnects must fetch a fresh one. The `getTicket` hook is called before every reconnect attempt:

```ts
const ws = new WSClient(url, {
    reconnect: true,
    getTicket: async () => {
        const res = await fetch('/api/realtime-token', { credentials: 'include' })
        if (!res.ok) throw new Error('token endpoint failed')
        return await res.text()
    }
})

ws.connect(initialTicket)   // first call still uses its argument verbatim
```

If `getTicket` throws or rejects, the loop terminates with `client:reconnect_failed` (you can't reconnect without a ticket).

## 🪧 Putting the ticket in the subprotocol header

Production deployments should keep credentials out of URL access logs and browser history. Set `ticketSource: 'protocol'` on **both** the server (`WSTransportOptions`) and the client (`WSClientOptions`):

```ts
const ws = new WSClient('wss://api.example.com/ws', {
    ticketSource: 'protocol',
    reconnect: true
})
ws.connect(jwt)   // sent via Sec-WebSocket-Protocol, NOT ?ticket=
```

The ticket must conform to the WebSocket subprotocol token grammar — no spaces, no commas, no padding `=`. Standard base64url JWTs satisfy this. Empty tickets in protocol mode throw a clear error before opening the socket.

## 📡 Sending and receiving structured payloads

The framework treats `payload` as opaque bytes. Most apps wrap a JSON encode/decode helper:

```ts
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array => encoder.encode(JSON.stringify(value))
export const decode = <T>(payload: Uint8Array): T => JSON.parse(decoder.decode(payload)) as T

// usage
ws.send('chat', encode({ text: 'hello' }))
ws.on('chat', (payload) => console.log(decode<{ text: string }>(payload)))
```

For higher-throughput / lower-overhead protocols, swap in `protobufjs`, `@bufbuild/protobuf`, `msgpackr`, etc. — the wire layer doesn't care.

## 🛑 Close codes

`CloseCode` is re-exported from `@rivalis/handshake` (bundled into `@rivalis/browser` — no extra install).

```ts
import { CloseCode } from '@rivalis/browser'

CloseCode.INVALID_TICKET   // 4001 — bad / missing ticket
CloseCode.INVALID_FRAME    // 4002 — non-binary frame
CloseCode.KICKED           // 4003 — server-initiated kick
CloseCode.ROOM_REJECTED    // 4004 — room_full / room_not_joinable
CloseCode.RATE_LIMITED     // 4005 — pre-handshake connection limiter
```

`client:kicked` fires for any 4xxx code with the parsed `{ code, reason }` so you don't have to peek into the close payload yourself.

## License

MIT — see [LICENSE](https://github.com/kalevski/rivalis/blob/main/LICENSE).
