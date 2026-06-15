/**
 * Wire-protocol constants (§7) — protocol versioning, the in-flight command cap,
 * and the topic name table exchanged between agent and orchestrator. Per-topic
 * JSON payload shapes live in `./payloads`.
 */

/**
 * Protocol MAJOR spoken by agent and orchestrator — a single integer (§7).
 *
 * Bumped 1 → 2 by task 005: the wire format changed from JSON to binary
 * (`@toolcase/serializer`), a breaking change within the major.
 *
 * Bumped 2 → 3 by task 011: the protocol was inverted to strict
 * orchestrator-driven request/reply. Agent push topics (`fleet/sync`,
 * `fleet/ping`, `fleet/resync`, `fleet/status`, `fleet/status-ack`) are gone;
 * the orchestrator now polls (`fleet/poll`) and the agent replies (`fleet/state`).
 * A v2 (push) peer and a v3 (poll) peer cannot interoperate — both halves must be
 * upgraded in lockstep. The 2-byte version header on every frame
 * (`wire/serializer`) is what makes the mismatch fail loudly at `fleet/hello`.
 */
export const PROTOCOL_VERSION = 3

/**
 * Fixed sentinel subprotocol echoed in the WS `101` handshake response (§13).
 *
 * The agent key travels in `Sec-WebSocket-Protocol` as the connection ticket;
 * naively echoing the client's offered subprotocol would round-trip that key into
 * the response headers (and any logging proxy in front of the orchestrator). Both
 * halves reference this constant: the agent's `WSClient` offers it alongside the
 * ticket (so the orchestrator can select it per RFC 6455), and the orchestrator's
 * `selectSubprotocol` prefers it. It lives in `wire/` — the shared protocol layer —
 * so the agent half need not import from the orchestrator half.
 */
export const WS_SUBPROTOCOL = 'rivalis-fleet.v1'

/**
 * Per-instance in-flight command cap (§7). Single source of truth: the
 * orchestrator's rate-limiter budget derives from this in code, never a second
 * literal.
 */
export const MAX_INFLIGHT_COMMANDS = 32

/**
 * Topic names exchanged between agent and orchestrator (§7). Strict
 * orchestrator-driven request/reply (task 011): every agent frame (`fleet/state`,
 * `fleet/ack`) is a direct reply to an outstanding orchestrator request
 * (`fleet/poll`, `fleet/cmd`); an unsolicited frame gets the agent kicked.
 */
export const Topics = {
    /** orch → agent: assigns id + heartbeat (poll cadence) on join; followed by the first poll. */
    hello: 'fleet/hello',
    /** orch → agent: state poll. Carries `knownHash` (dedup) + the last recorded `status` (echo). */
    poll: 'fleet/poll',
    /** agent → orch: poll reply. Full snapshot when the hash differs from `knownHash`, hash-only otherwise. */
    state: 'fleet/state',
    /** orch → agent: command push. */
    cmd: 'fleet/cmd',
    /** agent → orch: command result. */
    ack: 'fleet/ack'
} as const

export type TopicName = typeof Topics[keyof typeof Topics]
