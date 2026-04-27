/**
 * Optional pre-handshake connection rate limiter. Implementations are
 * invoked from `WSTransport.handleConnect` before any ticket validation,
 * once per inbound socket. Returning `false` causes the connection to be
 * closed with `CloseCode.RATE_LIMITED` before `AuthMiddleware` is ever
 * called — useful for capping per-IP socket churn from a single source.
 *
 * The argument is the remote address as reported by `request.socket.remoteAddress`.
 * Deployments behind a reverse proxy must extract the real client address
 * from headers (e.g. `X-Forwarded-For`) themselves.
 *
 * Implementations are responsible for their own state (sliding window,
 * token bucket, etc.) and for expiring it on their own schedule — there
 * is no `release` callback because pre-handshake we do not yet have an
 * actor identity to scope cleanup against.
 */
abstract class ConnectionLimiter {

    abstract check(remoteAddress: string): boolean | Promise<boolean>

}

export default ConnectionLimiter
