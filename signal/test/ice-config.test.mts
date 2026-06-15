/**
 * IceConfig unit tests (p2p.md §4.3, §8, §10).
 *
 * Verifies that IceConfig.issueFor() mints TURN credentials in the exact
 * format coturn's static-auth-secret REST scheme expects:
 *
 *   username   = "<unixExpiry>:<peerId>"
 *   credential = base64(HMAC_SHA1(secret, username))
 *
 * Tests run against the built lib (CJS path) so the node:crypto import is live.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { IceConfig } from '../lib/main.js'
import type { RTCIceServer } from '../lib/main.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function parseServers(json: string): RTCIceServer[] {
    return JSON.parse(json) as RTCIceServer[]
}

function expectedCredential(secret: string, username: string): string {
    return createHmac('sha1', secret).update(username).digest('base64')
}

// ── no-TURN (empty config) ────────────────────────────────────────────────────

test('returns empty JSON array when no turnUrls or secret are configured', () => {
    const cfg = new IceConfig({ turnUrls: [], secret: '', stunUrls: [] })
    const result = cfg.issueFor('peer-1')
    assert.equal(result, '[]')
})

test('returns empty JSON array when turnUrls is set but secret is empty', () => {
    const cfg = new IceConfig({ turnUrls: ['turn:turn.example.com:3478'], secret: '' })
    const result = cfg.issueFor('peer-1')
    assert.equal(result, '[]')
})

// ── STUN-only ────────────────────────────────────────────────────────────────

test('includes STUN servers without credentials when no TURN secret', () => {
    const cfg = new IceConfig({
        turnUrls: [],
        secret: '',
        stunUrls: ['stun:stun.example.com:3478'],
    })
    const servers = parseServers(cfg.issueFor('p'))
    assert.equal(servers.length, 1)
    assert.equal(servers[0]!.urls, 'stun:stun.example.com:3478')
    assert.equal(servers[0]!.username, undefined, 'STUN server must not have a username')
    assert.equal(servers[0]!.credential, undefined, 'STUN server must not have a credential')
})

// ── TURN credential format ────────────────────────────────────────────────────

test('TURN credential username is <unixExpiry>:<peerId>', () => {
    const secret = 'test-secret'
    const ttl = 3600
    const before = Math.floor(Date.now() / 1000)
    const cfg = new IceConfig({ turnUrls: ['turn:turn.example.com:3478'], secret, ttl })
    const servers = parseServers(cfg.issueFor('peer-abc'))
    const after = Math.floor(Date.now() / 1000) + ttl

    assert.equal(servers.length, 1)
    const server = servers[0]!
    assert.ok(typeof server.username === 'string', 'username must be present')

    const parts = server.username!.split(':')
    assert.equal(parts.length, 2, 'username must be "<expiry>:<peerId>"')
    const expiry = parseInt(parts[0]!, 10)
    assert.equal(parts[1], 'peer-abc', 'peerId part must match')
    assert.ok(expiry >= before + ttl, 'expiry must be at least now+ttl')
    assert.ok(expiry <= after, 'expiry must not exceed now+ttl')
})

test('TURN credential is base64(HMAC_SHA1(secret, username)) — matches coturn format', () => {
    const secret = 'my-coturn-secret'
    const cfg = new IceConfig({ turnUrls: ['turn:turn.example.com:3478'], secret, ttl: 86400 })
    const servers = parseServers(cfg.issueFor('some-peer'))

    const server = servers[0]!
    const username = server.username!
    const expected = expectedCredential(secret, username)

    assert.equal(server.credential, expected, 'credential must equal base64(HMAC_SHA1(secret, username))')
})

test('TURN urls are forwarded verbatim into the RTCIceServer entry', () => {
    const urls = ['turn:turn1.example.com:3478', 'turns:turn1.example.com:5349']
    const cfg = new IceConfig({ turnUrls: urls, secret: 's', ttl: 3600 })
    const servers = parseServers(cfg.issueFor('p'))
    const server = servers[0]!
    assert.deepEqual(server.urls, urls, 'all TURN urls must be present in the single entry')
})

// ── combined STUN + TURN ──────────────────────────────────────────────────────

test('returns STUN entry first, then TURN entry with creds', () => {
    const cfg = new IceConfig({
        stunUrls: ['stun:stun.example.com:3478'],
        turnUrls: ['turn:turn.example.com:3478'],
        secret: 'secret',
    })
    const servers = parseServers(cfg.issueFor('peer-x'))
    assert.equal(servers.length, 2)
    // First entry: STUN — urls is a plain string, no credentials
    assert.equal(typeof servers[0]!.urls, 'string', 'STUN entry has a string url')
    assert.ok(!servers[0]!.username, 'first entry is STUN — no username')
    // Second entry: TURN — urls is an array, with credentials
    assert.ok(Array.isArray(servers[1]!.urls), 'TURN entry has an array of urls')
    assert.ok(servers[1]!.username, 'second entry is TURN — has username')
    assert.ok(servers[1]!.credential, 'second entry is TURN — has credential')
})

// ── TTL default ───────────────────────────────────────────────────────────────

test('default TTL is 86400 seconds (24 h)', () => {
    const before = Math.floor(Date.now() / 1000)
    const cfg = new IceConfig({ turnUrls: ['turn:t.example.com:3478'], secret: 's' })
    const servers = parseServers(cfg.issueFor('p'))
    const expiry = parseInt(servers[0]!.username!.split(':')[0]!, 10)
    assert.ok(expiry >= before + 86400, 'expiry must be at least 24 h from now')
    assert.ok(expiry <= before + 86400 + 2, 'expiry must be at most 24 h + 2 s from now (clock slack)')
})

// ── fromEnv ───────────────────────────────────────────────────────────────────

test('fromEnv builds IceConfig from ICE_TURN_* environment variables', () => {
    const prev = {
        ICE_TURN_URLS: process.env['ICE_TURN_URLS'],
        ICE_TURN_SECRET: process.env['ICE_TURN_SECRET'],
        ICE_STUN_URLS: process.env['ICE_STUN_URLS'],
        ICE_TTL: process.env['ICE_TTL'],
    }
    try {
        process.env['ICE_TURN_URLS'] = 'turn:turn.example.com:3478'
        process.env['ICE_TURN_SECRET'] = 'env-secret'
        process.env['ICE_STUN_URLS'] = 'stun:stun.example.com:3478'
        process.env['ICE_TTL'] = '3600'

        const cfg = IceConfig.fromEnv()
        const servers = parseServers(cfg.issueFor('env-peer'))

        assert.equal(servers.length, 2, 'should have STUN + TURN')
        const turn = servers.find(s => {
            const urls = Array.isArray(s.urls) ? s.urls : [s.urls as string]
            return urls.some(u => u.startsWith('turn:'))
        })
        assert.ok(turn, 'must have a TURN entry')
        assert.ok(turn!.username?.endsWith(':env-peer'), 'username must include peerId')
        const expected = expectedCredential('env-secret', turn!.username!)
        assert.equal(turn!.credential, expected, 'credential matches HMAC from env secret')
    } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
    }
})
