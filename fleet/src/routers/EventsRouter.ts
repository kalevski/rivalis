/**
 * `GET /v1/events` (§10) — the Server-Sent Events stream of {@link FleetEvent}s for
 * dashboards. Registered under the `/v1` prefix; auth (header **or** `?key=` when
 * `sseQueryAuth` is on) and the per-IP throttle are handled by the shared scope
 * `onRequest` hook. The handler enforces the concurrent-stream cap (`429 SSE_LIMIT`,
 * §13), then takes over the raw socket (`reply.hijack()` + `reply.raw`) for the
 * long-lived stream: a `: ping` keep-alive every `pingMs` (§10) and CORS headers set
 * directly on the raw response (the `@fastify/cors` plugin's reply headers do not
 * survive a hijack). Open streams are tracked so `shutdown()` can drain them before
 * `server.close()`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { RouteHandler } from '@toolcase/node'

import { FleetError } from '../domain'
import { corsHeadersForSse, remoteIp, type RouterContext, type SseStream } from './shared'

export class EventsRouter extends RouteHandler {
    constructor(private readonly ctx: RouterContext) {
        super()
    }

    register(fastify: FastifyInstance): void {
        fastify.get('/events', async (req, reply) => this.stream(req, reply))
    }

    private stream(req: FastifyRequest, reply: FastifyReply): void {
        const ctx = this.ctx
        // Concurrent-stream cap (§13): refuse new streams past the ceiling so a
        // dashboard storm can't exhaust sockets/memory. Thrown before the hijack so
        // the central error handler answers a clean `429 SSE_LIMIT`.
        if (ctx.streams.size >= ctx.maxStreams) {
            ctx.deps.getLogger().warning(
                `sse stream cap reached (${ctx.maxStreams}) — rejecting new stream from ip=${remoteIp(req)}`
            )
            throw new FleetError('SSE_LIMIT', `concurrent SSE stream cap reached (${ctx.maxStreams})`)
        }

        reply.hijack()
        const raw = reply.raw
        raw.writeHead(200, {
            ...corsHeadersForSse(req, ctx.deps.config.cors),
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            // No Last-Event-ID replay (§10): a reconnecting consumer re-GETs stats+instances.
            'x-accel-buffering': 'no'
        })

        // Guarded write: a stream can be aborted between a fire/ping and the `close`
        // cleanup, so never throw into the event loop on a dead socket.
        const write = (chunk: string): void => {
            if (raw.writableEnded || raw.destroyed) {
                return
            }
            try {
                raw.write(chunk)
            } catch {
                /* socket gone mid-write — the close handler will tear the stream down */
            }
        }
        write(': connected\n\n')

        const unsubscribe = ctx.deps.subscribe((event) => {
            write(`event: ${event.type}\ndata: ${JSON.stringify(event.data ?? null)}\n\n`)
        })
        const ping = setInterval(() => write(': ping\n\n'), ctx.pingMs)
        ;(ping as { unref?: () => void }).unref?.()

        const stream: SseStream = {
            end: () => { if (!raw.writableEnded) { raw.end() } },
            cleanup: () => {
                clearInterval(ping)
                unsubscribe()
                ctx.streams.delete(stream)
            }
        }
        ctx.streams.add(stream)
        req.raw.on('close', () => stream.cleanup())
    }
}
