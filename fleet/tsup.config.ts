import { defineConfig } from 'tsup'

// Runtime/peer deps are externalized (never inlined): the REST surface (task 006)
// is built on `@toolcase/node`'s `RouteHandler`/`Router` over Fastify + `@fastify/cors`,
// and the `EndpointError`/`errorMeta` hierarchy now ships from `@toolcase/node`
// (src/domain/errors.ts). Externalizing `@toolcase/node` keeps its one `EndpointError`
// class identity shared across every entry, so `errorMeta`'s `instanceof` check maps a
// `FleetError` thrown in any bundle.
const external = ['ws', 'fastify', '@fastify/cors', '@rivalis/core', '@rivalis/node', '@toolcase/base', '@toolcase/logging', '@toolcase/node', '@toolcase/serializer', 'commander']

export default defineConfig([
    {
        // `canonical`/`wire`/`domain`/`Snapshot`/`FleetAgent`/`FleetState`/`Orchestrator`/
        // `routers` plus the task-008 orchestrator collaborators (`AgentAuthenticator`/
        // `CommandEngine`/`Poller`/`EventReconciler`/`FleetControl`) are emitted as standalone CJS
        // modules so the test suite can import the internal hashing, wire constants, domain
        // helpers, snapshot builder, agent, read-model/placement engine, control plane, REST
        // surface and each decomposed collaborator directly (these test seams live off the
        // §5 public `main` surface). `Poller` (task 011) replaced the pre-011 `LivenessTracker`.
        entry: { main: 'src/main.ts', cli: 'src/cli.ts', env: 'src/env.ts', canonical: 'src/util/canonical.ts', wire: 'src/wire/index.ts', domain: 'src/domain/index.ts', Snapshot: 'src/agent/Snapshot.ts', FleetAgent: 'src/agent/FleetAgent.ts', FleetState: 'src/orchestrator/FleetState.ts', Orchestrator: 'src/orchestrator/Orchestrator.ts', routers: 'src/routers/index.ts', AgentAuthenticator: 'src/orchestrator/AgentAuthenticator.ts', CommandEngine: 'src/orchestrator/CommandEngine.ts', Poller: 'src/orchestrator/Poller.ts', EventReconciler: 'src/orchestrator/EventReconciler.ts', FleetControl: 'src/orchestrator/FleetControl.ts' },
        format: 'cjs',
        outDir: 'lib',
        target: 'node18',
        platform: 'node',
        clean: true,
        sourcemap: false,
        dts: { entry: { main: 'src/main.ts' } },
        outExtension: () => ({ js: '.js' }),
        external,
        // `loadCore`/`serializer` read `import.meta.url` on purpose: in the CJS
        // bundle esbuild empties it, and the `metaUrl ? createRequire(metaUrl) : require`
        // fallback relies on that emptiness to fall back to the native `require`
        // (see those files' headers). esbuild's empty-import-meta warning is therefore
        // expected here — silence it so the CJS build stays clean. The ESM bundle below
        // keeps a real `import.meta.url`, so it never trips this warning.
        esbuildOptions(options) {
            options.logOverride = { ...options.logOverride, 'empty-import-meta': 'silent' }
        }
    },
    {
        entry: { module: 'src/main.ts' },
        format: 'esm',
        outDir: 'lib',
        target: 'node18',
        platform: 'node',
        clean: false,
        sourcemap: false,
        dts: false,
        outExtension: () => ({ js: '.js' }),
        external
    }
])
