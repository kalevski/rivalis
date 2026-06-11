/**
 * `rivalis-fleet` binary entry (§12) — consumption mode 3: a zero-code standalone
 * orchestrator configured by env vars / CLI flags. A thin (~50-line of logic)
 * wrapper: parse env/flags → `new Orchestrator(...)` → `listen()` → wire
 * `SIGINT`/`SIGTERM` to `shutdown()`. Everything testable lives in this library —
 * the arg/env parsing, config resolution and signal wiring are exported as pure
 * functions ({@link parseArgs}, {@link resolveCliConfig}, {@link installSignalHandlers})
 * and exercised directly in unit tests; only {@link main} touches core / the network.
 *
 * Flags are parsed with `commander` ({@link buildProgram}). The original hand-rolled
 * parser predated tasks 003–006 relaxing §5's zero-dependency rule (it adopted
 * `@toolcase/node` + fastify as real deps); commander now owns the option surface,
 * `=`/space forms, repeatable flags, unknown-flag/missing-value errors, and the
 * generated `--help`/`--version`, so none of that drifts from a hand-maintained string.
 */

import { randomBytes } from 'node:crypto'

import { Command, InvalidArgumentError } from 'commander'
import type { CommanderError } from 'commander'

import { Orchestrator } from './orchestrator/Orchestrator'
import type { OrchestratorOptions } from './orchestrator/Config'
import { readEnv, splitCsv } from './env'
import { describe } from './util/errors'
import { loadCore } from './util/loadCore'
import { packageVersion } from './util/packageVersion'

/** Accepted `--log-level` tokens (§12). Mapped onto `@toolcase/logging` levels below. */
export const CLI_LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error'])

/**
 * Map a §12 CLI log level onto a `@toolcase/logging` `LoggerLevel`. The CLI surface
 * uses the conventional `trace`/`warn` spellings; core's factory uses `verbose`/`warning`.
 */
const LOG_LEVEL_MAP: Record<string, string> = {
    trace: 'verbose',
    debug: 'debug',
    info: 'info',
    warn: 'warning',
    error: 'error'
}

export function mapLogLevel(level: string): string {
    return LOG_LEVEL_MAP[level] ?? 'info'
}

/** §12 env defaults live in `src/env.ts` (the single env home); re-exported here for back-compat. */
export { DEFAULT_PORT, DEFAULT_HEARTBEAT_MS, DEFAULT_COMMAND_TIMEOUT_MS } from './env'

/**
 * Raw, parsed CLI flags. Optional fields are `undefined` when the flag is absent,
 * so {@link resolveCliConfig} can apply the env-then-default fallback (flags win).
 * Repeatable flags (`--agent-key`, `--admin-key`, `--cors`) accumulate into arrays.
 */
export interface ParsedArgs {
    host?: string
    port?: number
    agentKeys?: string[]
    adminKeys?: string[]
    /** `false` only when `--no-api` is present; `undefined` otherwise (defaults to enabled). */
    api?: boolean
    cors?: string[]
    /** `true` only when `--sse-query-auth` is present; `undefined` otherwise. */
    sseQueryAuth?: boolean
    /** `true` only when `--trust-proxy` is present; `undefined` otherwise. */
    trustProxy?: boolean
    heartbeat?: number
    commandTimeout?: number
    logLevel?: string
    help?: boolean
    version?: boolean
}

/**
 * §12 footnote appended to `--help` (commander generates the option list above it).
 * Mirrors the dev-key auto-generation, production refusal, and comma-separated env
 * rotation notes from the spec.
 */
const HELP_FOOTNOTE = `
* If omitted, a random key (32 bytes from crypto.randomBytes, base64url-encoded) is
  generated and printed once at startup (dev convenience; refused when NODE_ENV=production).
  Supplied keys are checked against the §13 strength rule at startup. Env vars accept
  comma-separated lists for key rotation.`

/** commander `argParser` for the integer flags — non-negative integers only (§12). */
function parseIntArg(raw: string): number {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) {
        throw new InvalidArgumentError('must be a non-negative integer')
    }
    return n
}

/** commander `argParser` that accumulates a repeatable flag into a list. */
function collect(value: string, previous?: string[]): string[] {
    return previous ? [...previous, value] : [value]
}

/** Output sinks for {@link buildProgram} — defaulted to the real streams, injectable in tests. */
export interface ParseDeps {
    /** Sink for `--help` / `--version` text (commander's stdout). */
    writeOut?: (str: string) => void
    /** Sink for error/usage text (commander's stderr). */
    writeErr?: (str: string) => void
}

/**
 * Build the `rivalis-fleet` commander program for the §12 flag surface.
 * `.exitOverride()` makes commander **throw** a `CommanderError` instead of calling
 * `process.exit` — so {@link parseArgs} stays unit-testable (the error carries `code`
 * and `exitCode`) and `--help`/`--version`/parse-error output is captured via the
 * injected {@link ParseDeps} sinks rather than escaping to the real streams.
 */
export function buildProgram(deps: ParseDeps = {}): Command {
    const program = new Command()
    program
        .name('rivalis-fleet')
        .usage('[options]')
        .exitOverride()
        .configureOutput({
            writeOut: deps.writeOut ?? ((str) => process.stdout.write(str)),
            writeErr: deps.writeErr ?? ((str) => process.stderr.write(str))
        })
        .showHelpAfterError()
        .option('-H, --host <addr>', 'bind address (env FLEET_HOST, default 0.0.0.0)')
        .option('-p, --port <n>', 'HTTP/WS port (env FLEET_PORT, default 7350)', parseIntArg)
        .option('--agent-key <key>', 'agent auth key, repeatable (env FLEET_AGENT_KEY, required*)', collect)
        .option('--admin-key <key>', 'REST admin key, repeatable (env FLEET_ADMIN_KEY, required* when --api)', collect)
        .option('--no-api', 'disable REST API')
        .option('--cors <origin>', 'CORS allow-origin, repeatable (env FLEET_CORS_ORIGINS, default off)', collect)
        .option('--sse-query-auth', 'allow ?key= on /v1/events (env FLEET_SSE_QUERY_AUTH, default off)')
        .option('--trust-proxy', 'trust X-Forwarded-For from a front proxy (env FLEET_TRUST_PROXY, default off)')
        .option('--heartbeat <ms>', 'agent heartbeat interval (env FLEET_HEARTBEAT_MS, default 5000)', parseIntArg)
        .option('--command-timeout <ms>', 'command ack timeout (env FLEET_COMMAND_TIMEOUT_MS, default 10000)', parseIntArg)
        .option('--log-level <level>', 'trace|debug|info|warn|error (env FLEET_LOG_LEVEL, default info)')
        .version(readVersion(), '-v, --version', 'output the version number')
        .addHelpText('after', HELP_FOOTNOTE)
    return program
}

/**
 * Parse argv into {@link ParsedArgs} via commander ({@link buildProgram}). Flags win
 * over env in {@link resolveCliConfig}, so an absent flag maps to `undefined` (never an
 * empty array) — otherwise `?? env` fallback would short-circuit. Throws a
 * `CommanderError` (via `.exitOverride()`) on an unknown flag, a missing value, an
 * invalid integer, or `--help`/`--version`; {@link main} maps those to exit codes.
 */
export function parseArgs(argv: string[], deps: ParseDeps = {}): ParsedArgs {
    const program = buildProgram(deps)
    program.parse(argv, { from: 'user' })

    const opts = program.opts()
    const out: ParsedArgs = {}
    if (opts.host !== undefined) {
        out.host = opts.host as string
    }
    if (opts.port !== undefined) {
        out.port = opts.port as number
    }
    if (opts.agentKey !== undefined) {
        out.agentKeys = opts.agentKey as string[]
    }
    if (opts.adminKey !== undefined) {
        out.adminKeys = opts.adminKey as string[]
    }
    // `--no-api` is negatable, so commander always reports `api` (default `true`).
    // Only record the explicit `false` so resolveCliConfig's env/default still applies.
    if (program.getOptionValueSource('api') === 'cli') {
        out.api = opts.api as boolean
    }
    if (opts.cors !== undefined) {
        out.cors = opts.cors as string[]
    }
    if (opts.sseQueryAuth === true) {
        out.sseQueryAuth = true
    }
    if (opts.trustProxy === true) {
        out.trustProxy = true
    }
    if (opts.heartbeat !== undefined) {
        out.heartbeat = opts.heartbeat as number
    }
    if (opts.commandTimeout !== undefined) {
        out.commandTimeout = opts.commandTimeout as number
    }
    if (opts.logLevel !== undefined) {
        out.logLevel = opts.logLevel as string
    }
    return out
}

/** Generate a 32-byte base64url dev key (§12, §13) — always above the strength threshold. */
export function generateDevKey(): string {
    return randomBytes(32).toString('base64url')
}

/** Resolved CLI configuration: orchestrator options + the log level + startup notices. */
export interface CliConfig {
    options: OrchestratorOptions
    /** Normalized §12 log-level token (not yet mapped to a `LoggerLevel`). */
    logLevel: string
    /** Lines to surface at startup before listening (e.g. generated dev-key warnings). */
    notices: string[]
}

/** Injectable seams for {@link resolveCliConfig} (env + key generator), defaulted for production use. */
export interface ResolveDeps {
    env?: NodeJS.ProcessEnv
    /** Override the dev-key generator in tests for deterministic output. */
    randomKey?: () => string
}

/**
 * Merge parsed flags with environment variables into {@link OrchestratorOptions}
 * (§12). Precedence is **flag → env → default**; env key lists are comma-separated
 * for rotation (§13). When no agent/admin key is supplied, a random dev key is
 * generated and a notice queued — **except** under `NODE_ENV=production`, where the
 * orchestrator *refuses to auto-generate* and this throws (§12). Supplied keys are
 * not strength-checked here; that is enforced by the Orchestrator constructor (§13).
 */
export function resolveCliConfig(parsed: ParsedArgs, deps: ResolveDeps = {}): CliConfig {
    // All env reading + typing + defaults live in `src/env.ts`; this function owns
    // only the flag → env → default precedence (flags win). `deps.env` is the
    // injectable test seam — passed straight through to `readEnv`, which falls back
    // to the real environment (see `src/env.ts`) when the seam is undefined.
    const env = readEnv(deps.env)
    const randomKey = deps.randomKey ?? generateDevKey
    const isProduction = env.NODE_ENV === 'production'
    const notices: string[] = []

    const host = parsed.host ?? env.FLEET_HOST
    const port = parsed.port ?? env.FLEET_PORT
    const api = parsed.api ?? true

    // Keys: flags win over env entirely (a present flag list ignores the env var);
    // env values are comma-separated lists for key rotation (§13).
    let agentKeys = parsed.agentKeys ?? splitCsv(env.FLEET_AGENT_KEY)
    if (agentKeys.length === 0) {
        if (isProduction) {
            throw new Error(
                'no agent key configured (--agent-key / FLEET_AGENT_KEY) — refusing to ' +
                'auto-generate a key when NODE_ENV=production (§12)'
            )
        }
        const key = randomKey()
        agentKeys = [key]
        notices.push(`no agent key configured — generated a random dev key: ${key} (set --agent-key / FLEET_AGENT_KEY in production)`)
    }

    let adminKeys = parsed.adminKeys ?? splitCsv(env.FLEET_ADMIN_KEY)
    if (api && adminKeys.length === 0) {
        if (isProduction) {
            throw new Error(
                'no admin key configured (--admin-key / FLEET_ADMIN_KEY) — refusing to ' +
                'auto-generate a key when NODE_ENV=production (§12)'
            )
        }
        const key = randomKey()
        adminKeys = [key]
        notices.push(`no admin key configured — generated a random dev key: ${key} (set --admin-key / FLEET_ADMIN_KEY in production)`)
    }

    const heartbeatMs = parsed.heartbeat ?? env.FLEET_HEARTBEAT_MS
    const commandTimeoutMs = parsed.commandTimeout ?? env.FLEET_COMMAND_TIMEOUT_MS

    const corsOrigins = parsed.cors ?? splitCsv(env.FLEET_CORS_ORIGINS)
    const cors: false | { origins: string[] } = corsOrigins.length > 0 ? { origins: corsOrigins } : false

    const sseQueryAuth = parsed.sseQueryAuth ?? env.FLEET_SSE_QUERY_AUTH
    const trustProxy = parsed.trustProxy ?? env.FLEET_TRUST_PROXY

    const logLevel = parsed.logLevel ?? env.FLEET_LOG_LEVEL
    if (!CLI_LOG_LEVELS.has(logLevel)) {
        throw new Error(`invalid log level "${logLevel}" — expected one of trace|debug|info|warn|error (§12)`)
    }

    const options: OrchestratorOptions = {
        port,
        agentKey: agentKeys,
        api,
        heartbeatMs,
        commandTimeoutMs,
        cors,
        sseQueryAuth,
        trustProxy
    }
    // exactOptionalPropertyTypes: only set host/adminKey when present (never `undefined`/
    // `null` — `env.FLEET_HOST` is `null` when unset, so the Orchestrator default applies).
    if (host != null) {
        options.host = host
    }
    if (adminKeys.length > 0) {
        options.adminKey = adminKeys
    }

    return { options, logLevel, notices }
}

/** Minimal signal source (the global `process`, or a fake `EventEmitter` in tests). */
export interface SignalSource {
    on(signal: string, listener: (...args: unknown[]) => void): unknown
}

/** Minimal logger surface used by the signal wiring (just info/error). */
export interface SignalLogger {
    info(...args: unknown[]): void
    error(...args: unknown[]): void
}

/** Just the lifecycle method the signal handler needs from the orchestrator. */
export interface ShutdownTarget {
    shutdown(): Promise<void>
}

/** Dependencies for {@link installSignalHandlers} — all injectable for tests. */
export interface SignalDeps {
    process: SignalSource
    logger: SignalLogger
    exit: (code: number) => void
}

/**
 * Wire `SIGINT`/`SIGTERM` to a clean `orchestrator.shutdown()` then `exit` (§12).
 * The handler is **idempotent**: a second signal during an in-flight shutdown is
 * ignored, so a impatient double `Ctrl-C` does not race two shutdowns. A shutdown
 * error is logged and exits non-zero rather than leaving the process wedged.
 */
export function installSignalHandlers(orchestrator: ShutdownTarget, deps: SignalDeps): void {
    let shuttingDown = false
    const handle = (signal: string): void => {
        if (shuttingDown) {
            return
        }
        shuttingDown = true
        deps.logger.info(`received ${signal}, shutting down`)
        orchestrator.shutdown().then(
            () => deps.exit(0),
            (error: unknown) => {
                deps.logger.error(`shutdown error: ${describe(error)}`)
                deps.exit(1)
            }
        )
    }
    for (const signal of ['SIGINT', 'SIGTERM']) {
        deps.process.on(signal, () => handle(signal))
    }
}

/**
 * Read the package version for `--version`. Delegates to the shared
 * {@link packageVersion} helper so the CLI and the agent's snapshot `agentVersion`
 * resolve from one place (task 009); falls back to `0.0.0` if unreadable.
 */
export function readVersion(): string {
    return packageVersion()
}

/**
 * Binary entry: parse flags/env, handle `--help`/`--version`, then construct and
 * `listen()` an {@link Orchestrator} and wire shutdown signals. Parse/config errors
 * print to stderr and set a non-zero exit code; a `listen()` failure rejects to the
 * bin shim, which reports and exits non-zero.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
    let parsed: ParsedArgs
    try {
        parsed = parseArgs(argv)
    } catch (error) {
        // commander (`.exitOverride()`) already wrote help/version to stdout and
        // parse errors to stderr; here we only translate its `CommanderError` into a
        // process exit code. `--help`/`--version` exit 0; any parse error exits non-zero.
        const code = (error as Partial<CommanderError>).code
        if (code === 'commander.helpDisplayed' || code === 'commander.version') {
            return
        }
        process.exitCode = (error as Partial<CommanderError>).exitCode ?? 1
        return
    }

    let cli: CliConfig
    try {
        cli = resolveCliConfig(parsed)
    } catch (error) {
        process.stderr.write(`rivalis-fleet: ${describe(error)}\n`)
        process.exitCode = 1
        return
    }

    const core = loadCore()
    // Apply the §12 log level to core's shared logger factory (the internal Rivalis
    // uses the same singleton), then take a `fleet` logger for startup notices and
    // the Orchestrator's construction-time security warnings (§13).
    ;(core.logging as unknown as { level: string }).level = mapLogLevel(cli.logLevel)
    const logger = core.logging.getLogger('fleet')

    for (const notice of cli.notices) {
        logger.warning(notice)
    }

    const orchestrator = new Orchestrator(cli.options, { logger })
    await orchestrator.listen()
    installSignalHandlers(orchestrator, { process, logger, exit: (code) => process.exit(code) })
}
