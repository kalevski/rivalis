# `@rivalis/p2p` demo — P2P game host with WebRTC

A self-contained **P2P demo**: a `@rivalis/signal` signaling server and a game
host (`Rivalis` + `RTCTransport`) in one process, running the **unchanged**
`TttRoom` from `demo/src/server` over WebRTC data channels.

This proves the parity story from `p2p.md §11`:

> **Server game logic: zero changes.** A `Room` written today runs over WebRTC
> by changing only the host bootstrap transport.

The existing React client's `TicTacToe` component works without modification —
only the connection hook changes from `useRoom` (WebSocket) to `useRoomRTC`
(WebRTC via `RTCClient`).

## Run

One process (from the repo root):

```bash
npm run p2p -w @rivalis/demo
```

Or from `demo/`:

```bash
npm run p2p
```

Then open the browser demo (built from the dev server at `http://localhost:5173`).
To connect the TicTacToe view over WebRTC, swap the hook in
`demo/src/client/TicTacToe.tsx`:

```diff
- import { useRoom } from './useRoom'
+ import { useRoomRTC as useRoom } from '../p2p/useRoomRTC'
```

The ticket format (`ttt|<name>|<color>`) and the `TttState` event structure are
identical to the WebSocket demo, so no other component changes are needed.

## How it works

```
browser (RTCClient)     signal server (SignalRoom)    game host (RTCTransport)
       │  ws:// + ticket ──────────►│                         │
       │◄── signal:welcome ─────────│                         │
       │  create PC + DataChannel   │                         │
       │  signal:offer ────────────►│──── relay ─────────────►│
       │◄── signal:answer ──────────│◄─── relay ──────────────│
       │  ICE trickle (both ways, relayed)                     │
       │═══════════════ DataChannel OPEN ═════════════════════│
       │── game ticket (first binary msg) ───────────────────►│ grantAccess
       │◄═══════ game frames (TttRoom broadcasts) ════════════│ TttRoom.onJoin
```

After the data channel opens, the signal server carries **zero** game traffic.

## Ticket format

The same `<roomId>|<name>|<color>` string is used for three purposes:

| Where | Recipient | Use |
|-------|-----------|-----|
| `RTCClient.connect(ticket)` | signal server (WS header) | identifies signal room + actor |
| first binary DC message | game host (`RTCTransport`) | game-room `grantAccess` |
| `client.send('place', ...)` onwards | game host | normal game frames |

`DemoP2PSignalAuth` (in `index.ts`) extracts only the `roomId` segment from the
ticket, delegating name/color validation to `ArenaAuthMiddleware` on the game host.

## Comparison with the WS demo

| | WS demo (`demo/src/server/`) | P2P demo (`demo/src/p2p/`) |
|---|---|---|
| Transport | `WSTransport` | `RTCTransport` + `@rivalis/signal` |
| Room | `TttRoom` (unchanged) | `TttRoom` (unchanged) |
| Client hook | `useRoom` → `WSClient` | `useRoomRTC` → `RTCClient` |
| Auth ticket format | `ttt\|name\|#color` | `ttt\|name\|#color` (same) |
| Signal server | — | co-located in same process |

## Ports

| Component | Port | Notes |
|-----------|------|-------|
| Signal server | 9000 | WS, `ticketSource: 'protocol'` |
| Game host | — | RTCTransport (no listening port; connects outbound to signal) |
| Dev client | 5173 | Vite dev server |

## Files

| File | Role |
|------|------|
| `index.ts` | Starts signal server + P2P game host (one process). |
| `protocol.ts` | Shared constants: `SIGNAL_PORT`, `SIGNAL_ROOM_ID`, `HOST_SIGNAL_TICKET`. |
| `useRoomRTC.ts` | React hook — drop-in for `useRoom` using `RTCClient`. |

The game rooms (`TttRoom`, `ArenaAuthMiddleware`) live in `demo/src/server` and
are imported unchanged.
