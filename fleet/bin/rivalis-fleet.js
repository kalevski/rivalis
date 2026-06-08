#!/usr/bin/env node
'use strict'

// Thin shim → lib/cli.js (§5). All logic lives in the library so it stays testable;
// this only invokes main() and turns an escaping failure (e.g. listen() EADDRINUSE)
// into a non-zero exit instead of an unhandled rejection.
require('../lib/cli.js').main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error))
    process.exit(1)
})
