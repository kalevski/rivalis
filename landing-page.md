# Rivalis Landing Page

Content specification for the Rivalis marketing site. Each top-level section
below maps 1:1 to a section component on the page.

## Contents

1. [Site metadata](#site-metadata)
2. [Navigation](#navigation)
3. [Hero](#hero)
4. [Code preview](#code-preview)
5. [Why Rivalis](#why-rivalis)
6. [Use cases](#use-cases)
7. [Comparison](#comparison)
8. [Community](#community)
9. [CTA](#cta)
10. [Footer](#footer)

---

## Site metadata

| Field       | Value |
| ----------- | ----- |
| Site URL    | https://rivalis.io |
| Title       | Rivalis — Open-source real-time framework for Node.js |
| Description | Build multiplayer games and real-time apps on Node.js. Rooms, actors, and a typed binary protocol — no boilerplate. Free, MIT-licensed. |
| Author      | [kalevski](https://github.com/kalevski) |
| License     | MIT |
| Repository  | https://github.com/kalevski/rivalis |

---

## Navigation

**Brand** — RIVALIS
**Primary CTA** — View on GitHub → https://github.com/kalevski/rivalis

| Item        | Target |
| ----------- | ------ |
| Features    | `#why-rivalis` |
| Use cases   | `#use-cases` |
| Docs        | https://github.com/kalevski/rivalis#readme |

---

## Hero

**Eyebrow** — OPEN SOURCE · MIT · NODE.JS
**Title** — Ship multiplayer faster.
**Description** — Build real-time multiplayer experiences with Rivalis.
Open-source framework for Node.js with rooms, actors, and a typed binary
wire protocol — built-in.

**Install command** — `npm install @rivalis/core`
**Helper text** — Requires Node.js 18+

**Primary action** — Get started → `#code-preview`
**Secondary action** — View on GitHub → https://github.com/kalevski/rivalis

---

## Code preview

**Eyebrow** — SEE IT IN ACTION
**Heading** — Real-time rooms in minutes.
**Subtitle** — Define your room on the server. The client subscribes to
topics. Frames flow in both directions over a single binary protocol.

### Server tab — `GameRoom.ts`

```typescript
import { Room, type Actor } from '@rivalis/core'

type PlayerData = { name: string; score: number }

export class GameRoom extends Room<PlayerData> {

    protected override presence = true

    protected override onCreate() {
        this.bind('move', this.onMove)
    }

    private onMove(actor: Actor<PlayerData>, payload: Uint8Array) {
        this.broadcast('move', payload)
    }
}
```

### Client tab — `client.ts`

```typescript
import { WSClient } from '@rivalis/browser'

const ws = new WSClient('ws://localhost:8080', { reconnect: true })

ws.on('client:connect', () => console.log('connected'))
ws.on('move', (payload) => renderMove(payload))

ws.connect('alice')
ws.send('move', new TextEncoder().encode(JSON.stringify({ x: 12, y: 34 })))
```

**Footer link** — Read the full quick start → https://github.com/kalevski/rivalis#readme

---

## Why Rivalis

**Eyebrow** — WHY RIVALIS
**Heading** — Everything you need for multiplayer.

| Icon            | Title                  | Body |
| --------------- | ---------------------- | ---- |
| `door-open`     | Rooms & Actors         | Model your game as rooms full of actors with a clean lifecycle. Two concepts, one mental model. |
| `broadcast-pin` | Topic-based messaging  | Bind a topic to a handler, broadcast or unicast — no manual switch statements. |
| `shield-lock`   | Pluggable auth         | Validate any ticket — JWT, session token, anything — and attach typed actor data. |
| `box-seam`      | Binary wire protocol   | A typed `{ topic, payload }` format keeps clients and servers in lockstep. |
| `code-square`   | TypeScript-first       | Strict types end-to-end. Actor data, room handlers, and the wire format all share generics. |
| `power`         | Free & open source     | MIT licensed. Free forever, even for commercial games. Your server, your rules. |

---

## Use cases

**Eyebrow** — USE CASES
**Heading** — What you can build.
**Subtitle** — Anywhere multiple humans need to share state in real time.

| Eyebrow      | Title           | Description |
| ------------ | --------------- | ----------- |
| Multiplayer  | Game servers    | Arena, .io, party, MMO zones, turn-based — rooms with presence and tick-rate broadcasts. |
| Collaborative | Live apps      | Whiteboards, editors, dashboards, chat — every interaction is a topic frame. |
| Operational  | Real-time ops   | Auctions, IoT panels, dispatch, live polls — server-authoritative state with rate limiting. |

---

## Comparison

**Eyebrow** — HOW RIVALIS COMPARES
**Heading** — Lightweight by design.

### vs Colyseus

- Free-form binary payloads — no `@type`-decorated `Schema` classes
- Drop-in to any Node.js `http.Server` — works with Express, Fastify, bare HTTP
- Two concepts only — Rooms and Actors, learn the API in an afternoon

### vs From scratch

- Heartbeats, rate limiting, backpressure, and reconnect — built in
- TypeScript-native, zero hidden runtime dependencies
- Ship in days, not months

---

## Community

**Eyebrow** — JOIN THE COMMUNITY
**Heading** — Built in the open.

| Stat        | Value | Helper |
| ----------- | ----- | ------ |
| License     | MIT   | free forever |
| Repository  | GitHub | https://github.com/kalevski/rivalis |
| Issues      | GitHub Issues | https://github.com/kalevski/rivalis/issues |

**Primary action** — View on GitHub → https://github.com/kalevski/rivalis

---

## CTA

**Eyebrow** — OPEN SOURCE · MIT · NODE.JS
**Heading** — Build something that talks back.
**Body** — Star the repo, ship a prototype, file an issue.

**Primary action** — Star on GitHub → https://github.com/kalevski/rivalis
**Secondary action** — Read the docs → https://github.com/kalevski/rivalis#readme

---

## Footer

**Brand** — RIVALIS
**Tagline** — The framework for real-time multiplayer on Node.js.

### Framework

| Link               | Target |
| ------------------ | ------ |
| `@rivalis/core`    | https://github.com/kalevski/rivalis |
| `@rivalis/browser` | https://github.com/kalevski/rivalis |
| Changelog          | https://github.com/kalevski/rivalis/releases |

### Resources

| Link          | Target |
| ------------- | ------ |
| Documentation | https://github.com/kalevski/rivalis#readme |
| Examples      | https://github.com/kalevski/rivalis/tree/main/demo |

### Community

| Link   | Target |
| ------ | ------ |
| GitHub | https://github.com/kalevski/rivalis |
| Issues | https://github.com/kalevski/rivalis/issues |
| Author | https://github.com/kalevski |

**Legal** — © 2026 rivalis. Released under the MIT License.
