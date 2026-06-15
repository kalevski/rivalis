import { test } from 'node:test'
import assert from 'node:assert/strict'
import { timingSafeCompare } from '../lib/main.js'

test('returns true for identical strings', () => {
    assert.equal(timingSafeCompare('secret', 'secret'), true)
})

test('returns false when strings differ', () => {
    assert.equal(timingSafeCompare('wrong', 'secret'), false)
})

test('returns false when a is prefix of b', () => {
    assert.equal(timingSafeCompare('sec', 'secret'), false)
})

test('returns false when b is prefix of a', () => {
    assert.equal(timingSafeCompare('secret-extra', 'secret'), false)
})

test('returns false for empty vs non-empty', () => {
    assert.equal(timingSafeCompare('', 'secret'), false)
    assert.equal(timingSafeCompare('secret', ''), false)
})

test('returns true for two empty strings', () => {
    assert.equal(timingSafeCompare('', ''), true)
})

test('handles multi-byte unicode correctly — equal', () => {
    assert.equal(timingSafeCompare('tïcket-🔑', 'tïcket-🔑'), true)
})

test('handles multi-byte unicode correctly — unequal', () => {
    assert.equal(timingSafeCompare('tïcket-🔑', 'tïcket-🗝️'), false)
})

test('same byte length but different content returns false', () => {
    // 'aaa' and 'bbb' differ at every byte but have the same length
    assert.equal(timingSafeCompare('aaa', 'bbb'), false)
})

test('loop always runs b.length iterations (length-1 prefix match is still false)', () => {
    // 'abcX' vs 'abcY' — first 3 bytes match; final byte differs
    assert.equal(timingSafeCompare('abcX', 'abcY'), false)
})
