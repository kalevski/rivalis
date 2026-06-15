/**
 * DevStunResponder tests (p2p.md §4.3, §12 Phase 4).
 *
 * Acceptance criteria:
 *  - Dev STUN responder works behind a flag (RIVALIS_STUN_DEV=true or stunDev option).
 *  - Disabled by default (fromEnv() returns null unless env var is set).
 *  - No TURN relay — only Binding Request → Binding Response.
 *  - Ignores malformed / non-STUN / non-Binding-Request packets.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { DevStunResponder } from '../lib/main.js'

const MAGIC_COOKIE     = 0x2112A442
const BINDING_RESPONSE = 0x0101
const ATTR_XOR_MAPPED  = 0x0020

// ── helpers ───────────────────────────────────────────────────────────────────

function buildBindingRequest(txId?: Buffer): Buffer {
    const buf = Buffer.allocUnsafe(20)
    buf.writeUInt16BE(0x0001, 0)          // Binding Request
    buf.writeUInt16BE(0,      2)          // no attributes
    buf.writeUInt32BE(MAGIC_COOKIE, 4)
    // Transaction ID must be exactly 12 bytes (96 bits per RFC 8489).
    const id = txId ?? Buffer.from('abcdef012345abcdef012345', 'hex')
    id.copy(buf, 8)
    return buf
}

type StunResponse = {
    type: number
    length: number
    magic: number
    txId: Buffer
    attrType: number
    attrLen: number
    family: number
    xPort: number
    xAddr: number
}

function parseResponse(buf: Buffer): StunResponse {
    assert.ok(buf.byteLength >= 32, 'response must be at least 32 bytes')
    return {
        type:     buf.readUInt16BE(0),
        length:   buf.readUInt16BE(2),
        magic:    buf.readUInt32BE(4),
        txId:     buf.subarray(8, 20),
        attrType: buf.readUInt16BE(20),
        attrLen:  buf.readUInt16BE(22),
        family:   buf[25]!,
        xPort:    buf.readUInt16BE(26),
        xAddr:    buf.readUInt32BE(28),
    }
}

async function send(
    msg: Buffer,
    port: number,
    host: string,
    timeoutMs = 500,
): Promise<Buffer | null> {
    return new Promise((resolve) => {
        const client = createSocket('udp4')
        const timer = setTimeout(() => { client.close(); resolve(null) }, timeoutMs)

        client.once('message', (buf) => {
            clearTimeout(timer)
            client.close()
            resolve(buf)
        })

        client.bind(0, '127.0.0.1', () => {
            client.send(msg, port, host)
        })
    })
}

// ── fromEnv ───────────────────────────────────────────────────────────────────

test('DevStunResponder.fromEnv returns null when RIVALIS_STUN_DEV is absent', () => {
    const prev = process.env['RIVALIS_STUN_DEV']
    delete process.env['RIVALIS_STUN_DEV']
    const result = DevStunResponder.fromEnv()
    assert.equal(result, null)
    if (prev !== undefined) process.env['RIVALIS_STUN_DEV'] = prev
})

test('DevStunResponder.fromEnv returns null when RIVALIS_STUN_DEV is not "true"', () => {
    const prev = process.env['RIVALIS_STUN_DEV']
    process.env['RIVALIS_STUN_DEV'] = 'false'
    const result = DevStunResponder.fromEnv()
    assert.equal(result, null)
    process.env['RIVALIS_STUN_DEV'] = prev ?? ''
    if (prev === undefined) delete process.env['RIVALIS_STUN_DEV']
})

test('DevStunResponder.fromEnv creates a responder when RIVALIS_STUN_DEV=true', async () => {
    const prev = process.env['RIVALIS_STUN_DEV']
    process.env['RIVALIS_STUN_DEV'] = 'true'
    process.env['RIVALIS_STUN_DEV_PORT'] = '0'    // ephemeral port — avoids conflicts

    const responder = DevStunResponder.fromEnv()
    // The responder starts asynchronously; give it a tick.
    await new Promise(r => setTimeout(r, 50))

    assert.notEqual(responder, null, 'should return a DevStunResponder instance')
    await responder?.close()

    process.env['RIVALIS_STUN_DEV'] = prev ?? ''
    if (prev === undefined) delete process.env['RIVALIS_STUN_DEV']
    delete process.env['RIVALIS_STUN_DEV_PORT']
})

// ── lifecycle ─────────────────────────────────────────────────────────────────

test('listen() resolves to a positive port number', async () => {
    const responder = new DevStunResponder({ port: 0, host: '127.0.0.1' })
    const port = await responder.listen()
    assert.ok(port > 0, `expected a positive port, got ${port}`)
    await responder.close()
})

test('listen() is idempotent — second call resolves to same port', async () => {
    const responder = new DevStunResponder({ port: 0, host: '127.0.0.1' })
    const port1 = await responder.listen()
    const port2 = await responder.listen()
    assert.equal(port1, port2, 'idempotent listen must return the same port')
    await responder.close()
})

test('close() is safe to call before listen()', async () => {
    const responder = new DevStunResponder({ port: 0, host: '127.0.0.1' })
    await assert.doesNotReject(responder.close())
})

test('close() is idempotent', async () => {
    const responder = new DevStunResponder({ port: 0, host: '127.0.0.1' })
    await responder.listen()
    await responder.close()
    await assert.doesNotReject(responder.close())
})

// ── STUN protocol ─────────────────────────────────────────────────────────────

test('responds to STUN Binding Request with Binding Response', async () => {
    const responder = new DevStunResponder({ port: 0, host: '127.0.0.1' })
    const port = await responder.listen()

    const txId = Buffer.from('deadbeef010203040a0b0c0d', 'hex')
    const request = buildBindingRequest(txId)
    const raw = await send(request, port, '127.0.0.1')

    assert.notEqual(raw, null, 'should receive a response')
    const r = parseResponse(raw!)

    assert.equal(r.type, BINDING_RESPONSE, 'message type = 0x0101 (Binding Response)')
    assert.equal(r.magic, MAGIC_COOKIE, 'magic cookie must be 0x2112A442')
    assert.deepEqual(r.txId, txId, 'transaction ID must be echoed')
    assert.equal(r.attrType, ATTR_XOR_MAPPED, 'attribute type = XOR-MAPPED-ADDRESS (0x0020)')
    assert.equal(r.attrLen, 8, 'attribute length = 8 (IPv4)')
    assert.equal(r.family, 0x01, 'family = IPv4 (0x01)')

    await responder.close()
})

test('XOR-MAPPED-ADDRESS encodes the correct reflexive address', async () => {
    const responder = new DevStunResponder({ port: 0, host: '127.0.0.1' })
    const port = await responder.listen()

    const request = buildBindingRequest()
    const raw = await send(request, port, '127.0.0.1')
    assert.notEqual(raw, null, 'must receive a response')

    const r = parseResponse(raw!)

    // Decode X-Port: port XOR upper-16-bits(MAGIC) = port XOR 0x2112
    const decodedPort = r.xPort ^ (MAGIC_COOKIE >>> 16)
    assert.ok(decodedPort > 0, 'decoded source port must be positive')

    // Decode X-Address: ip_u32 XOR MAGIC_COOKIE  →  must equal 127.0.0.1
    const decodedIp = (r.xAddr ^ MAGIC_COOKIE) >>> 0
    // 127.0.0.1 as uint32
    const expected = ((127 << 24) | (0 << 16) | (0 << 8) | 1) >>> 0
    assert.equal(decodedIp, expected, 'decoded IP must equal 127.0.0.1')

    await responder.close()
})

test('ignores packets shorter than 20 bytes', async () => {
    const responder = new DevStunResponder({ port: 0, host: '127.0.0.1' })
    const port = await responder.listen()

    const short = Buffer.from([0x00, 0x01, 0x00, 0x00])
    const response = await send(short, port, '127.0.0.1', 200)
    assert.equal(response, null, 'must not reply to truncated packet')

    await responder.close()
})

test('ignores packets with wrong magic cookie', async () => {
    const responder = new DevStunResponder({ port: 0, host: '127.0.0.1' })
    const port = await responder.listen()

    const bad = buildBindingRequest()
    bad.writeUInt32BE(0xDEADBEEF, 4)   // overwrite magic cookie
    const response = await send(bad, port, '127.0.0.1', 200)
    assert.equal(response, null, 'must not reply when magic cookie is wrong')

    await responder.close()
})

test('ignores packets with non-zero top two bits (non-STUN)', async () => {
    const responder = new DevStunResponder({ port: 0, host: '127.0.0.1' })
    const port = await responder.listen()

    const nonStun = buildBindingRequest()
    nonStun[0] = 0x80   // top 2 bits = 0b10 — not a STUN packet
    const response = await send(nonStun, port, '127.0.0.1', 200)
    assert.equal(response, null, 'must not reply to non-STUN UDP data')

    await responder.close()
})

test('ignores non-Binding-Request STUN messages', async () => {
    const responder = new DevStunResponder({ port: 0, host: '127.0.0.1' })
    const port = await responder.listen()

    // Allocate Request (0x0003) — not handled; never relays.
    const allocate = buildBindingRequest()
    allocate.writeUInt16BE(0x0003, 0)
    const response = await send(allocate, port, '127.0.0.1', 200)
    assert.equal(response, null, 'must not reply to non-Binding-Request STUN messages')

    await responder.close()
})
