# Client/server chat

The "hello world" of Rivalis: a single server hosts one chat room, and every
connected client broadcasts its messages to all the others. Join/leave
notifications are included.

It is intentionally tiny — no orchestration, no persistence, no auth beyond
picking a name. Both the server and the client are plain Node processes:

- the **server** uses [`@rivalis/core`](../../core) (`Rivalis` + `WSTransport`
  + a `Room`),
- the **client** is a CLI that uses the Node WebSocket client that ships inside
  `@rivalis/core` as `Clients.WSClient`.

## How it works

- Connecting sends a *ticket* — here just your display name. `ChatAuthMiddleware`
  validates it and drops you into the single `chat` room.
- The room sets `presence = true`, so Rivalis auto-broadcasts
  `__presence:join` / `__presence:leave` — that is where join/leave lines come
  from, with no extra server wiring.
- Sending a line publishes a `chat` frame; the room re-broadcasts it to everyone.
  Each client learns its own actor id from a one-off `welcome` frame and uses it
  to skip its own echo.

Payloads are opaque bytes to Rivalis; `src/protocol.ts` encodes/decodes the
small JSON shapes both sides share.

## Run it

From the **repo root**, install once so every workspace (including this demo)
is linked, then build so `@rivalis/core` produces the `lib/` output this demo
imports:

```sh
npm install
npm run build
```

Then, from this directory (`demos/client-server-chat/`):

**1. Start the server** (terminal 1):

```sh
npm start
```

You should see `chat server listening on ws://localhost:8080`.

**2. Open a client** (terminal 2):

```sh
npm run client -- alice
```

**3. Open a second client** (terminal 3):

```sh
npm run client -- bob
```

Type a message in either client and press Enter — it appears in the other one.
Each client also prints `* <name> joined` / `* <name> left` as people come and
go. Press `Ctrl+C` (or `Ctrl+D`) in a client to leave.

> The client is run separately (rather than alongside the server) because it is
> interactive — each terminal owns its own stdin. Open as many clients as you
> like.

### Running from the repo root

You can target the workspace by name instead of `cd`-ing in:

```sh
npm start -w @rivalis/demo-client-server-chat
npm run client -w @rivalis/demo-client-server-chat -- alice
```

### Options

- `PORT` — server listen port (default `8080`).
- `RIVALIS_URL` — client connection URL (default `ws://localhost:8080`).
- `npm run dev` — like `npm start`, but restarts the server on source changes.
