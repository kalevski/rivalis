import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

import {
    parseArgs,
    resolveCliConfig,
    installSignalHandlers,
    readVersion,
    mapLogLevel,
    generateDevKey
} from '../lib/cli.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

// Parse with captured commander output so `--help`/`--version`/parse-error text
// never escapes to the real process streams. commander's `.exitOverride()` throws a
// `CommanderError` (carrying `code` + `exitCode`) instead of calling `process.exit`.
function parseCapture(argv: string[]): { parsed?: ReturnType<typeof parseArgs>, error?: any, out: string, err: string } {
    let out = ''
    let err = ''
    try {
        const parsed = parseArgs(argv, { writeOut: (s) => { out += s }, writeErr: (s) => { err += s } })
        return { parsed, out, err }
    } catch (error) {
        return { error, out, err }
    }
}

// ---------------------------------------------------------------------------
// Acceptance: `--help` covers the §12 option surface + footnote and exits zero;
// `--version` prints the package version and exits zero.
// ---------------------------------------------------------------------------

test('--help covers the full §12 option surface plus the dev-key footnote, and exits zero', () => {
    const { error, out } = parseCapture(['--help'])
    assert.equal(error.code, 'commander.helpDisplayed')
    assert.equal(error.exitCode, 0, '--help exits zero')
    const surface = [
        '-H, --host', '-p, --port', '--agent-key', '--admin-key', '--no-api',
        '--cors', '--sse-query-auth', '--trust-proxy', '--heartbeat', '--command-timeout',
        '--log-level', '-v, --version', '-h, --help',
        'FLEET_HOST', 'FLEET_PORT', 'FLEET_AGENT_KEY', 'FLEET_ADMIN_KEY',
        'FLEET_CORS_ORIGINS', 'FLEET_SSE_QUERY_AUTH', 'FLEET_TRUST_PROXY', 'FLEET_HEARTBEAT_MS',
        'FLEET_COMMAND_TIMEOUT_MS', 'FLEET_LOG_LEVEL',
        'trace|debug|info|warn|error',
        // §12 footnote (dev-key auto-generation, production refusal, env rotation):
        'crypto.randomBytes', 'NODE_ENV=production', 'comma-separated lists for key rotation'
    ]
    for (const token of surface) {
        assert.ok(out.includes(token), `--help is missing "${token}"`)
    }
})

test('-h is an alias for --help', () => {
    assert.equal(parseCapture(['-h']).error.code, 'commander.helpDisplayed')
})

test('--version / -v print the package version and exit zero', () => {
    for (const flag of ['--version', '-v']) {
        const { error, out } = parseCapture([flag])
        assert.equal(error.code, 'commander.version')
        assert.equal(error.exitCode, 0, `${flag} exits zero`)
        assert.equal(out, `${pkg.version}\n`)
    }
})

test('readVersion returns the package version', () => {
    assert.equal(readVersion(), pkg.version)
    assert.match(readVersion(), /^\d+\.\d+\.\d+/)
})

// ---------------------------------------------------------------------------
// Arg parsing (commander, task 010). Every §12 flag — long, short, repeatable,
// `=`-form — maps identically into ParsedArgs.
// ---------------------------------------------------------------------------

test('parseArgs reads scalar flags in both space and = forms', () => {
    assert.deepEqual(parseArgs(['-H', '127.0.0.1', '-p', '9000']), { host: '127.0.0.1', port: 9000 })
    assert.deepEqual(parseArgs(['--host=10.0.0.1', '--port=8080']), { host: '10.0.0.1', port: 8080 })
})

test('parseArgs accumulates repeatable flags into lists', () => {
    const parsed = parseArgs(['--agent-key', 'a1', '--agent-key', 'a2', '--admin-key', 'm1', '--cors', 'https://x', '--cors', 'https://y'])
    assert.deepEqual(parsed.agentKeys, ['a1', 'a2'])
    assert.deepEqual(parsed.adminKeys, ['m1'])
    assert.deepEqual(parsed.cors, ['https://x', 'https://y'])
})

test('repeatable flags also accumulate in = form', () => {
    assert.deepEqual(parseArgs(['--agent-key=a1', '--agent-key=a2']).agentKeys, ['a1', 'a2'])
})

test('parseArgs reads boolean switches', () => {
    const parsed = parseArgs(['--no-api', '--sse-query-auth'])
    assert.equal(parsed.api, false)
    assert.equal(parsed.sseQueryAuth, true)
})

test('an absent --no-api leaves api undefined so resolveCliConfig defaults apply', () => {
    // commander reports a negatable option's default; parseArgs must NOT surface it,
    // else `parsed.api ?? true` and the env fallback would never run.
    assert.equal('api' in parseArgs([]), false)
})

test('parseArgs reads numeric and log-level flags', () => {
    const parsed = parseArgs(['--heartbeat', '3000', '--command-timeout', '20000', '--log-level', 'debug'])
    assert.equal(parsed.heartbeat, 3000)
    assert.equal(parsed.commandTimeout, 20000)
    assert.equal(parsed.logLevel, 'debug')
})

test('an unknown flag exits non-zero with usage on stderr', () => {
    const { error, err } = parseCapture(['--nope'])
    assert.equal(error.code, 'commander.unknownOption')
    assert.notEqual(error.exitCode, 0)
    assert.match(err, /unknown option/)
    assert.match(err, /Usage: rivalis-fleet/)
})

test('a value flag missing its argument exits non-zero with usage on stderr', () => {
    const { error, err } = parseCapture(['--port'])
    assert.equal(error.code, 'commander.optionMissingArgument')
    assert.notEqual(error.exitCode, 0)
    assert.match(err, /argument missing/)
    assert.match(err, /Usage: rivalis-fleet/)
})

test('a non-integer numeric flag exits non-zero with the integer-validation message', () => {
    const { error, err } = parseCapture(['--port', 'abc'])
    assert.notEqual(error.exitCode, 0)
    assert.match(err, /non-negative integer/)
})

// ---------------------------------------------------------------------------
// Acceptance: env vars and flags both work; flags win; comma-separated env keys
// parsed as lists.
// ---------------------------------------------------------------------------

const noGen = () => { throw new Error('dev key should not be generated in this case') }

test('env vars supply options when no flag is given', () => {
    const env = {
        FLEET_HOST: '0.0.0.0', FLEET_PORT: '9100', FLEET_AGENT_KEY: 'ak', FLEET_ADMIN_KEY: 'mk',
        FLEET_HEARTBEAT_MS: '6000', FLEET_COMMAND_TIMEOUT_MS: '15000', FLEET_LOG_LEVEL: 'warn'
    } as NodeJS.ProcessEnv
    const { options, logLevel } = resolveCliConfig({}, { env, randomKey: noGen })
    assert.equal(options.host, '0.0.0.0')
    assert.equal(options.port, 9100)
    assert.deepEqual(options.agentKey, ['ak'])
    assert.deepEqual(options.adminKey, ['mk'])
    assert.equal(options.heartbeatMs, 6000)
    assert.equal(options.commandTimeoutMs, 15000)
    assert.equal(logLevel, 'warn')
})

test('flags win over env vars', () => {
    const env = {
        FLEET_HOST: '0.0.0.0', FLEET_PORT: '9100', FLEET_AGENT_KEY: 'env-ak', FLEET_ADMIN_KEY: 'env-mk', FLEET_LOG_LEVEL: 'error'
    } as NodeJS.ProcessEnv
    const parsed = parseArgs(['-H', '127.0.0.1', '-p', '7000', '--agent-key', 'flag-ak', '--admin-key', 'flag-mk', '--log-level', 'debug'])
    const { options, logLevel } = resolveCliConfig(parsed, { env, randomKey: noGen })
    assert.equal(options.host, '127.0.0.1')
    assert.equal(options.port, 7000)
    assert.deepEqual(options.agentKey, ['flag-ak'])
    assert.deepEqual(options.adminKey, ['flag-mk'])
    assert.equal(logLevel, 'debug')
})

test('comma-separated env keys are parsed as rotation lists (§13)', () => {
    const env = { FLEET_AGENT_KEY: 'old, new ,newer', FLEET_ADMIN_KEY: 'a,b' } as NodeJS.ProcessEnv
    const { options } = resolveCliConfig({}, { env, randomKey: noGen })
    assert.deepEqual(options.agentKey, ['old', 'new', 'newer'])
    assert.deepEqual(options.adminKey, ['a', 'b'])
})

test('defaults apply when neither flag nor env is set', () => {
    const env = { FLEET_AGENT_KEY: 'ak', FLEET_ADMIN_KEY: 'mk' } as NodeJS.ProcessEnv
    const { options, logLevel } = resolveCliConfig({}, { env, randomKey: noGen })
    assert.equal(options.port, 7350)
    assert.equal(options.heartbeatMs, 5000)
    assert.equal(options.commandTimeoutMs, 10000)
    assert.equal(options.api, true)
    assert.equal(options.sseQueryAuth, false)
    assert.equal(options.trustProxy, false)
    assert.equal(options.cors, false)
    assert.equal(logLevel, 'info')
    assert.equal(options.host, undefined, 'host left unset so the Orchestrator default (0.0.0.0) applies')
})

test('--no-api disables REST and needs no admin key', () => {
    const env = { FLEET_AGENT_KEY: 'ak' } as NodeJS.ProcessEnv
    const { options } = resolveCliConfig(parseArgs(['--no-api']), { env, randomKey: noGen })
    assert.equal(options.api, false)
    assert.equal(options.adminKey, undefined, 'no admin key required or generated when --no-api')
})

test('repeatable --cors and FLEET_CORS_ORIGINS map to cors.origins', () => {
    const flag = resolveCliConfig(parseArgs(['--cors', 'https://a', '--cors', 'https://b']), {
        env: { FLEET_AGENT_KEY: 'ak', FLEET_ADMIN_KEY: 'mk' } as NodeJS.ProcessEnv, randomKey: noGen
    })
    assert.deepEqual(flag.options.cors, { origins: ['https://a', 'https://b'] })

    const fromEnv = resolveCliConfig({}, {
        env: { FLEET_AGENT_KEY: 'ak', FLEET_ADMIN_KEY: 'mk', FLEET_CORS_ORIGINS: 'https://a, https://b' } as NodeJS.ProcessEnv,
        randomKey: noGen
    })
    assert.deepEqual(fromEnv.options.cors, { origins: ['https://a', 'https://b'] })
})

test('--sse-query-auth and FLEET_SSE_QUERY_AUTH both enable query auth', () => {
    const base = { FLEET_AGENT_KEY: 'ak', FLEET_ADMIN_KEY: 'mk' }
    assert.equal(resolveCliConfig(parseArgs(['--sse-query-auth']), { env: base as NodeJS.ProcessEnv, randomKey: noGen }).options.sseQueryAuth, true)
    assert.equal(resolveCliConfig({}, { env: { ...base, FLEET_SSE_QUERY_AUTH: 'true' } as NodeJS.ProcessEnv, randomKey: noGen }).options.sseQueryAuth, true)
    assert.equal(resolveCliConfig({}, { env: { ...base, FLEET_SSE_QUERY_AUTH: '0' } as NodeJS.ProcessEnv, randomKey: noGen }).options.sseQueryAuth, false)
})

test('--trust-proxy and FLEET_TRUST_PROXY both enable forwarded-IP attribution; default off (§13)', () => {
    const base = { FLEET_AGENT_KEY: 'ak', FLEET_ADMIN_KEY: 'mk' }
    assert.equal(resolveCliConfig({}, { env: base as NodeJS.ProcessEnv, randomKey: noGen }).options.trustProxy, false)
    assert.equal(resolveCliConfig(parseArgs(['--trust-proxy']), { env: base as NodeJS.ProcessEnv, randomKey: noGen }).options.trustProxy, true)
    assert.equal(resolveCliConfig({}, { env: { ...base, FLEET_TRUST_PROXY: 'true' } as NodeJS.ProcessEnv, randomKey: noGen }).options.trustProxy, true)
    // A flag wins over a conflicting env value (flag → env → default precedence).
    assert.equal(resolveCliConfig(parseArgs(['--trust-proxy']), { env: { ...base, FLEET_TRUST_PROXY: 'false' } as NodeJS.ProcessEnv, randomKey: noGen }).options.trustProxy, true)
})

test('resolveCliConfig rejects an invalid log level', () => {
    const env = { FLEET_AGENT_KEY: 'ak', FLEET_ADMIN_KEY: 'mk' } as NodeJS.ProcessEnv
    assert.throws(() => resolveCliConfig(parseArgs(['--log-level', 'loud']), { env, randomKey: noGen }), /invalid log level/)
})

test('a malformed FLEET_PORT falls back to the default (single env() semantics, task 003)', () => {
    // The typed env() loader (src/env.ts) is lenient: a value that fails the
    // parseInt round-trip falls back to the default — one parsing behavior across
    // the CLI, replacing the old envInt that *threw* on a malformed integer.
    const env = { FLEET_AGENT_KEY: 'ak', FLEET_ADMIN_KEY: 'mk', FLEET_PORT: 'eighty' } as NodeJS.ProcessEnv
    assert.equal(resolveCliConfig({}, { env, randomKey: noGen }).options.port, 7350)
})

test('mapLogLevel maps §12 tokens onto @toolcase/logging levels', () => {
    assert.equal(mapLogLevel('trace'), 'verbose')
    assert.equal(mapLogLevel('debug'), 'debug')
    assert.equal(mapLogLevel('info'), 'info')
    assert.equal(mapLogLevel('warn'), 'warning')
    assert.equal(mapLogLevel('error'), 'error')
})

// ---------------------------------------------------------------------------
// Acceptance: no keys + dev mode → generated key printed once; no keys +
// NODE_ENV=production → refuses to start.
// ---------------------------------------------------------------------------

test('missing keys in dev mode generate a key and queue a one-time notice', () => {
    let calls = 0
    const randomKey = () => `devkey-${++calls}`
    const { options, notices } = resolveCliConfig({}, { env: {} as NodeJS.ProcessEnv, randomKey })
    assert.deepEqual(options.agentKey, ['devkey-1'])
    assert.deepEqual(options.adminKey, ['devkey-2'])
    assert.equal(calls, 2, 'one key generated per missing audience')
    assert.equal(notices.length, 2, 'one notice per generated key')
    assert.ok(notices.some((n) => n.includes('devkey-1') && /agent key/.test(n)))
    assert.ok(notices.some((n) => n.includes('devkey-2') && /admin key/.test(n)))
})

test('the generated dev key is 32 bytes base64url (always above the §13 strength threshold)', () => {
    const key = generateDevKey()
    assert.match(key, /^[A-Za-z0-9_-]+$/, 'base64url charset')
    // 32 bytes base64url-encodes to 43 chars (no padding).
    assert.equal(key.length, 43)
})

test('missing agent key under NODE_ENV=production refuses to start (§12)', () => {
    const env = { NODE_ENV: 'production', FLEET_ADMIN_KEY: 'a-sufficiently-long-admin-key' } as NodeJS.ProcessEnv
    assert.throws(() => resolveCliConfig({}, { env, randomKey: noGen }), /refusing to auto-generate.*NODE_ENV=production/)
})

test('missing admin key under NODE_ENV=production refuses to start (§12)', () => {
    const env = { NODE_ENV: 'production', FLEET_AGENT_KEY: 'a-sufficiently-long-agent-key' } as NodeJS.ProcessEnv
    assert.throws(() => resolveCliConfig({}, { env, randomKey: noGen }), /admin key.*refusing to auto-generate.*NODE_ENV=production/)
})

test('supplied keys under production are NOT auto-generated (no refusal)', () => {
    const env = { NODE_ENV: 'production', FLEET_AGENT_KEY: 'a-long-agent-key-value', FLEET_ADMIN_KEY: 'a-long-admin-key-value' } as NodeJS.ProcessEnv
    const { options, notices } = resolveCliConfig({}, { env, randomKey: noGen })
    assert.deepEqual(options.agentKey, ['a-long-agent-key-value'])
    assert.equal(notices.length, 0, 'nothing generated when keys are supplied')
})

// ---------------------------------------------------------------------------
// Acceptance: SIGTERM triggers a clean shutdown() (no orphaned sockets/timers).
// ---------------------------------------------------------------------------

test('SIGTERM triggers orchestrator.shutdown() then exit(0)', async () => {
    const proc = new EventEmitter()
    let shutdowns = 0
    const orchestrator = { shutdown: async () => { shutdowns++ } }
    const exits: number[] = []
    const logged: string[] = []
    installSignalHandlers(orchestrator, {
        process: proc,
        logger: { info: (...a) => logged.push(String(a[0])), error: (...a) => logged.push(String(a[0])) },
        exit: (code) => exits.push(code)
    })

    proc.emit('SIGTERM')
    await new Promise((r) => setImmediate(r))
    assert.equal(shutdowns, 1, 'shutdown() was called on SIGTERM')
    assert.deepEqual(exits, [0], 'process exits 0 after a clean shutdown')
    assert.ok(logged.some((l) => /SIGTERM/.test(l)))
})

test('SIGINT is wired the same way', async () => {
    const proc = new EventEmitter()
    let shutdowns = 0
    installSignalHandlers({ shutdown: async () => { shutdowns++ } }, {
        process: proc,
        logger: { info() {}, error() {} },
        exit() {}
    })
    proc.emit('SIGINT')
    await new Promise((r) => setImmediate(r))
    assert.equal(shutdowns, 1)
})

test('a second signal during shutdown is ignored (idempotent — no double shutdown)', async () => {
    const proc = new EventEmitter()
    let shutdowns = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    installSignalHandlers({ shutdown: async () => { shutdowns++; await gate } }, {
        process: proc,
        logger: { info() {}, error() {} },
        exit() {}
    })
    proc.emit('SIGTERM')
    proc.emit('SIGINT') // arrives while the first shutdown is still in flight
    release()
    await new Promise((r) => setImmediate(r))
    assert.equal(shutdowns, 1, 'only the first signal drives shutdown')
})

test('a shutdown error exits non-zero', async () => {
    const proc = new EventEmitter()
    const exits: number[] = []
    const logged: string[] = []
    installSignalHandlers({ shutdown: async () => { throw new Error('boom') } }, {
        process: proc,
        logger: { info() {}, error: (...a) => logged.push(String(a[0])) },
        exit: (code) => exits.push(code)
    })
    proc.emit('SIGTERM')
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(exits, [1])
    assert.ok(logged.some((l) => /shutdown error.*boom/.test(l)))
})
