# Rivalis demos

Runnable example projects that showcase what Rivalis can do. Each demo is an
independent npm sub-project, wired into the repo's npm workspaces via the
`demos/*` glob in the root `package.json`, so a single install from the repo
root bootstraps all of them at once.

Demos consume Rivalis the same way any sibling package does: the server side
imports from [`@rivalis/core`](../core) and the browser side imports from
[`@rivalis/browser`](../browser). Because these are workspace packages, npm
links them locally — no publish step or version pinning is required.

## Planned demos

| Demo | Description |
| --- | --- |
| Simple client/server chat | A minimal chat room: a single `@rivalis/core` server and a `@rivalis/browser` client exchanging messages. |
| Orchestrator chat | Chat distributed across multiple server nodes coordinated by a Rivalis orchestrator. |
| Pac-Man | A real-time multiplayer Pac-Man game demonstrating authoritative server state and client rendering. |
| Peer-to-peer chat | Browser-to-browser chat that uses Rivalis only for peer handshake/signalling. |

> These sub-projects are not scaffolded yet — this directory currently holds
> only the shared workspace wiring. Each demo will be added under
> `demos/<demo-name>/` as its own workspace package.

## Install

Run a single install from the repo root; npm resolves every workspace,
including everything under `demos/*`:

```sh
npm install
```

## Build

Build all workspaces (each demo that defines a `build` script is built):

```sh
npm run build
```

## Run a demo

Once a demo exists, run it by targeting its workspace from the repo root. For a
demo whose package is named `@rivalis/demo-<name>` and that defines a `dev`
script:

```sh
npm run dev -w @rivalis/demo-<name>
```
