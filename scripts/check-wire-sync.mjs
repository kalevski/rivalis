#!/usr/bin/env node
// Verify that the wire format is identical between @rivalis/core and
// @rivalis/browser. The two packages must hold a byte-identical copy of
// `serializer.js` because they sit on opposite ends of the same socket;
// any drift silently breaks the wire.
//
// Run from the repo root:
//   node scripts/check-wire-sync.js

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

const a = resolve(repo, 'core/src/serializer.js')
const b = resolve(repo, 'browser/src/serializer.js')

const left = readFileSync(a)
const right = readFileSync(b)

if (!left.equals(right)) {
    console.error(`wire sync error: ${a} and ${b} differ.`)
    console.error('these two files must be byte-identical because they encode/decode the same frames.')
    process.exit(1)
}

console.log('wire sync ok: serializer.js matches between core and browser')
