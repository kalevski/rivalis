# Rivalis improvement tasks

Concrete, actionable work items for hardening the framework, migrating to TypeScript, and improving the product. The migration must be **API-compatible** — existing consumers of `@rivalis/core` and `@rivalis/browser` should not need to change their imports, class shapes, method signatures, or runtime behavior.

Tasks are ordered by category; within a category, prefer top-down. Each task lists the affected files (where known) and an acceptance check.

---

## A. TypeScript migration (API-preserving)

The current source is JS + JSDoc, with `.d.ts` emitted by `tsc --allowJs`. The goal is real `.ts` source that produces the *same* public API and equivalent or better `.d.ts` output.

### A1. Add a real `tsconfig.json` per workspace [x]
- Create `core/tsconfig.json`, `browser/tsconfig.json`, `demo/tsconfig.json`, plus a root `tsconfig.base.json` for shared options.
- Replace inline `tsc -d --allowJs --emitDeclarationOnly --target es5 --lib ES2015 ...` flags in `core/package.json` and `browser/package.json` `build:tsd` scripts.
- Targets: `ES2020` for core (NodeJS 18+ baseline), `ES2018` for browser. Drop `--target es5` — the codebase already uses class fields and async/await.
- Enable `strict`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`.
- **Accept:** running `npx tsc --noEmit -p core` and `-p browser` reports zero errors after migration.

### A2. Migrate `core/src/*.js` → `*.ts` [x]
File-by-file order (smallest blast radius first):
1. `Actor.js` — leaf, only imports `Room`.
2. `AuthMiddleware.js` — pure abstract.
3. `Transport.js` — pure abstract.
4. `serializer.js` — small, isolated.
5. `CustomLoggerFactory.js`.
6. `Config.js`.
7. `TLayer.js`.
8. `Room.js`.
9. `RoomManager.js`.
10. `Rivalis.js`.
11. `transports/WSTransport.js`, `clients/WSClient.js`.
12. `main.js` — barrel; verify exported names are byte-identical.
- For each file: convert `@type {X}` JSDoc to TS field annotations; keep `private`/`protected`/`readonly` modifiers in the same places they're documented today.
- Replace `Object<string,any>` with `Record<string, unknown>` (or a generic where the user supplies the type — see A4).
- **Accept:** `npm run build -w @rivalis/core` produces `lib/main.js`, `lib/module.js`, and `lib/main.d.ts` whose exported symbol names match the pre-migration output (diff the `.d.ts`).

### A3. Migrate `browser/src/*.js` → `*.ts` [x]
- `WSClient.js`, `serializer.js`, `main.js`.
- `serializer.js` is duplicated with `core/src/serializer.js` — see B7 about extracting it before migration.
- **Accept:** the demo client (`demo/src/client/index.ts`) imports `WSClient` and compiles unchanged.

### A4. Add generic types where data is currently `any` [x]
Without breaking the API, add optional generic parameters with `unknown` or `Record<string, unknown>` defaults so existing untyped callers keep working:
- `Room<TActorData = Record<string, unknown>>` → `Actor<TActorData>` exposes typed `data`.
- `AuthMiddleware<TActorData = Record<string, unknown>>` so `extractPayload` returns `TActorData | null`.
- `Actor.save<T>(key: string, value: T)` / `Actor.get<T>(key: string): T | null`.
- `WSClient` event payloads — consider a typed event map keyed by topic (opt-in via generic).
- **Accept:** the demo (`MyAuthMiddleware`, `FirstRoom`) compiles with no `any` after consumers add the generic parameter; without the parameter, behavior is unchanged.

### A5. Replace JSDoc-only callbacks with proper types [x]
- `TopicListener`, `EventFn`, `GetRoomFn`, `ForEachFn` — currently JSDoc `@callback`. Convert to exported `type` aliases.
- **Accept:** all four are importable from `@rivalis/core` and the existing JSDoc references in user code resolve to the same shape.

---

## B. Bugs and correctness fixes (do these *before* the TS migration so they're caught in commits)

### B1. Fix typo `disocnnect()` in browser `WSClient` [x]
- `browser/src/WSClient.js:68` — public method is misspelled. Rename to `disconnect()`. This is technically a breaking change, so:
  - Add `disconnect()` as the canonical name.
  - Keep `disocnnect()` as a deprecated alias that logs a warning and forwards, scheduled for removal in next major.
- **Accept:** both names work; warning shows on the typo; `disconnect()` is the only one in the new `.d.ts`.

### B2. Fix undefined variable in `RoomManager.create` error message [x]
- `core/src/RoomManager.js:89` — `${type}` references a non-existent variable. Should be `${roomType}`.
- **Accept:** triggering the error with a non-string argument prints the actual value passed.

### B3. Fix null `actor` dereference in `Room.handleMessage` [x]
- `core/src/Room.js:213-217` — when `topicListener` is null and `actor` is also null (e.g. message arrives after `handleLeave`), the code calls `actor.kick()` and crashes the process.
- Guard: if `actor === null`, log and return; do not attempt to kick.
- **Accept:** sending a message for an unknown actor id no longer throws.

### B4. Fix `Room.kick(actor)` with no payload [x]
- `Actor.kick(payload)` passes `undefined` when called without arg; `Room.kick` then throws `invalid payload=undefined`.
- Default `payload` to `''` (empty string) in `Actor.kick` to match `Room.kick`'s default.
- **Accept:** `actor.kick()` with no argument disconnects with an empty reason instead of throwing.

### B5. Remove broken `logging` export in `core/src/main.js` [x]
- `core/src/main.js:31` exports `logging` but never imports it. The symbol is `undefined` at runtime.
- Either: (a) export `CustomLoggerFactory.Instance` as `logging`, matching the JSDoc intent and the docs in `CLAUDE.md`, or (b) remove the export.
- **Accept:** `import { logging } from '@rivalis/core'` returns the singleton logger factory or the symbol is absent from the `.d.ts`.

### B6. Don't swallow errors in `TLayer.handleClose` [x]
- `core/src/TLayer.js:146-148` — bare `try/catch` with empty body hides crashes in `Room.handleLeave`.
- Log at `error` level with the actor/room id and re-evaluate whether to swallow.
- **Accept:** room exceptions on leave are visible in logs; tests can assert on them.

### B7. Deduplicate the message serializer [x]
- `core/src/serializer.js` and `browser/src/serializer.js` are byte-identical except for header comments. Drift between them silently breaks the wire.
- Extract to a shared internal package (`packages/wire/`) or inline both from a single source-of-truth and add a CI check that diffs them.
- **Accept:** changing the schema in one place is the only edit needed; CI fails if they drift.

### B8. Validate decode failures in `TLayer.handleMessage` [x]
- `core/src/TLayer.js:130-136` — `decode()` throws on malformed input, which surfaces as an uncaught exception in the WS message handler.
- Wrap in try/catch; on failure, log and kick the actor with `invalid_message` (already a defined error code in `Room.js`).
- **Accept:** sending random bytes to the WS endpoint disconnects the actor cleanly without crashing.

### B9. Guard against `getRoom` returning null in `TLayer.handleMessage`/`handleClose` [x]
- Same file — `this.getRoom(roomId)` can return `null` (rooms can be destroyed mid-flight). Both call sites assume a non-null room.
- Add null check; on miss, log and clean up `roomIds` map.
- **Accept:** destroying a room while messages are in flight no longer throws.

### B10. Stop hardcoding `https://kalevski.dev` as URL base [x]
- `core/src/transports/WSTransport.js:110` — uses a hardcoded base host to parse the request URL. Works but is misleading.
- Use `request.headers.host` or pass `null` as base and use `URLSearchParams(request.url.split('?')[1] ?? '')`.
- **Accept:** code reads what it does; no fake hostname.

### B11. `WSTransport.dispose()` is never called and is a no-op [x]
- `Transport.dispose()` exists in the abstract class but `WSTransport` doesn't override it, and `Rivalis` has no shutdown path.
- Implement `WSTransport.dispose()` to close the `WebSocketServer` and disconnect all actors.
- **Accept:** see C1 below for the `Rivalis.shutdown()` task that wires this up.

---

## C. Lifecycle and operability gaps

### C1. Add `Rivalis.shutdown()` for graceful termination [x]
- No way to cleanly stop the server today. Should: stop accepting new connections, close all rooms (firing `onDestroy`), kick remaining actors, dispose transports.
- API: `await rivalis.shutdown({ timeoutMs?: number })`.
- **Accept:** demo can `process.on('SIGINT', () => rivalis.shutdown())` and exit cleanly.

### C2. Heartbeat / idle-disconnect handling in `WSTransport` [x]
- WebSocket connections through proxies (Cloudflare, ELB) get killed silently after ~60s idle. There's no ping/pong loop.
- Add a configurable ping interval (default 30s), close on missed pong (default 2 missed = disconnect).
- **Accept:** an idle client survives behind a 60s-idle proxy.

### C3. Reconnection support in browser `WSClient` [ ]
- Today, on disconnect the caller must rebuild the client and re-call `connect(ticket)`. Common need is auto-reconnect with backoff.
- Add `WSClient` options: `{ reconnect?: boolean | { maxAttempts, baseDelayMs, maxDelayMs } }`. Emit `client:reconnecting` events. Re-use stored ticket.
- **Accept:** killing the server then bringing it back reconnects the client without app-level code; emits `client:connect` again.

### C4. Backpressure on outbound sends [x]
- `WSTransport` calls `socket.send()` with no check on `socket.bufferedAmount` or `ws.readyState`. A slow client can blow up server memory.
- Drop or queue with bounded size; expose a metric/event when the threshold is crossed.
- **Accept:** sending 10k large messages to a paused client does not OOM the server.

### C5. Per-actor / per-room rate limiting hooks [x]
- No way to throttle abusive clients. Add an optional `RateLimiter` interface invoked from `TLayer.handleMessage` before dispatch.
- **Accept:** a sample limiter (token bucket, N msgs/sec/actor) is wired in tests.

### C6. Memory leak: per-actor EventEmitter listeners are not cleaned up [x]
- `core/src/TLayer.js` — transports do `this.transportLayer.on('message', actorId, ...)` per connection but never `off`. Even after `handleClose`, the listeners remain.
- Add `TLayer.off(event, actorId)` and call it from transports on disconnect, or use `EventEmitter.removeAllListeners(`${event}:${actorId}`)`.
- **Accept:** connecting/disconnecting 10k actors leaves a flat memory profile.

### C7. `connections` count is misleading [x]
- `TLayer.connections` returns `roomIds.size`, which is the count of *joined* actors, not raw socket connections. Pre-join sockets (during `grantAccess`) aren't counted.
- Track raw transport connections separately and expose both: `rivalis.connections` (joined) vs `rivalis.sockets` (open transports).
- **Accept:** documented difference; metrics are correct.

### C8. Replace magic close codes with named constants [x]
- `core/src/transports/WSTransport.js` uses `4001`, `4002`, `4003` inline. Define `CloseCode = { INVALID_TICKET: 4001, INVALID_FRAME: 4002, KICKED: 4003 } as const` and export it from `@rivalis/core`.
- **Accept:** browser `WSClient` can map `CloseEvent.code` → human-readable reason via the same enum.

### C9. The singleton logger factory blocks multiple `Rivalis` instances [x]
- `CustomLoggerFactory.Instance` is a module singleton. Two `Rivalis` instances in the same process share log levels and reporters — fine for prod, painful for tests.
- Inject the logger factory through `Config` (`config.logging?: LoggerFactory`); fall back to the singleton.
- **Accept:** unit tests can spin up isolated `Rivalis` instances with different log levels without cross-talk.

---

## D. Product / feature gaps

### D1. Room presence: broadcast join/leave by default [x]
- Almost every realtime app needs "user joined" / "user left" events. Today the room author wires this manually.
- Add opt-in `Room` config: `{ presence: true }` — auto-broadcasts `__presence:join` and `__presence:leave` with the actor's `data`.
- **Accept:** flipping the flag eliminates the boilerplate in `FirstRoom` and similar apps.

### D2. Room capacity and joinable flag [x]
- No way to cap a room or temporarily refuse joins (e.g. game in progress).
- Add `room.maxActors` (number | null) and `room.joinable` (bool). `TLayer.grantAccess` rejects with a structured reason.
- **Accept:** an 11th actor attempting to join a 10-cap room is rejected with code/reason `room_full`.

### D4. Multi-room actors [ ]
- Today an actor belongs to exactly one room (encoded in `roomIds: Map<actorId, roomId>`). Many use cases want one socket subscribed to multiple rooms (lobby + game + global chat).
- Break the 1:1 assumption: `roomIds: Map<actorId, Set<roomId>>`; messages route by topic prefix or explicit room id in the frame.
- **Accept:** documented design tradeoff before implementing — this is a wire-format change.

### D5. State synchronization primitive [ ]
- Many use cases want server-authoritative shared state with diff-based broadcast. Today every app rolls this manually on top of `bind`/`broadcast`.
- Optional `Room.state` object with a `mark(key)` API; framework diffs and broadcasts on tick.
- **Accept:** documented as a v6 feature; spike a prototype on a branch first.

### D7. Observability hooks [ ]
- No metrics, no tracing. Add an `Observer` interface with `onConnect`, `onDisconnect`, `onMessage`, `onRoomCreate`, `onRoomDestroy`, `onError`.
- Sample reporters: console, Prometheus.
- **Accept:** running the demo with the Prometheus reporter exposes counts at `/metrics`.

### D8. Per-transport auth middleware [ ]
- `Config.authMiddleware` is global. Different transports (WS for browsers, raw TCP for game clients) often need different auth.
- Move `authMiddleware` to a per-transport option; keep `Config.authMiddleware` as the default fallback.
- **Accept:** demo wires two transports with different middlewares.

---

## E. Tooling, tests, and DX

### E2. Add a linter and formatter [ ]
- `eslint` (typescript-eslint, no-floating-promises, no-misused-promises, prefer-const) + `prettier`.
- **Accept:** `npm run lint` clean across all workspaces.

### E3. Add CI (GitHub Actions) [ ]
- Workflow: install → lint → typecheck → test → build, on push and PR.
- Matrix Node 18 / 20 / 22.
- Publish workflow on tag push, gated on test pass.
- **Accept:** PRs show check status; main branch protected behind green CI.

### E4. Replace `nodemon` polling-based dev loop [x]
- Both `core` and `browser` run `nodemon -e js -w src --exec "npm run build"` — every save runs Parcel + tsc cold. Slow.
- Switch to `tsup --watch` (if E6 chooses tsup) which incrementally rebuilds in <100ms.
- **Accept:** save-to-rebuild latency under 500ms on the demo workflow.

### E5. Demo: fix and document bootstrap [x]
- The root README says "Build the project using `npm run build`" then `npm run demo`, but the demo client references `./client.html` (not present) at `demo/src/server/index.ts:19`. The route is dead; the actual entry is `index.html` served via Parcel.
- Either remove the dead route or wire it correctly.
- **Accept:** following the README literally produces a working demo at `localhost:2334`.

### E6. Replace empty README "TBD" sections [ ]
- `README.md`, `core/README.md`, `browser/README.md` all have "Getting started: TBD" and "Features: TBD".
- Write minimum: install, 30-line server example, 20-line browser example, link to `CLAUDE.md` for architecture.
- **Accept:** a reader who finds the npm page can start a working server in under 5 minutes.

### E7. API reference docs [ ]
- Generate with `typedoc` from the new TS source. Publish to GitHub Pages.
- **Accept:** `https://kalevski.github.io/rivalis/` (or similar) shows API for all exported symbols.

---

## Suggested execution order

1. **Quick wins (1 day):** B1, B2, B3, B4, B5, B10 — pure bug fixes, no API change.
2. **Tooling foundation (2-3 days):** E1, E2, E3 — get tests + CI in place so the migration is safe.
3. **TypeScript migration (1 week):** A1 → A6, in order. Tests from E1 catch regressions.
4. **Correctness hardening (2-3 days):** B6, B7, B8, B9, B11, C1, C6, C8.
5. **Operability (1 week):** C2, C3, C4, C5, C7, C9.
6. **Product features (scope per quarter):** D1–D8, prioritized with users.
7. **Polish:** E4, E5, E6, E7.
