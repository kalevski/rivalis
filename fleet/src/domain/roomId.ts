/**
 * Room-id charset, namespacing, and encoding helpers (§11) — pure, no I/O.
 *
 * Fleet-created ids (explicit or generated) must match {@link ROOM_ID_PATTERN};
 * local ids created by arbitrary game code are percent-encoded and, on a
 * cross-instance collision, surfaced under `<processUid>~<roomId>`.
 */

/**
 * Charset every fleet-created room id (explicit or generated) must match (§11).
 * Ids appear verbatim in URL path segments and in the `<processUid>~<roomId>`
 * namespacing scheme below; a `/`, `%`, or `~` would break routing or namespace
 * parsing. Core imposes no charset of its own, so the fleet enforces it at the door.
 */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Separator joining `<processUid>` and `<roomId>` in a namespaced id (§11).
 * Excluded from {@link ROOM_ID_PATTERN}, so a `~` in an id unambiguously means
 * "namespaced" and the joined id stays URL-safe in a path segment.
 */
export const NAMESPACE_SEPARATOR = '~'

/** Single-char form of the charset, used by {@link encodeRoomId} per byte. */
const ROOM_ID_CHAR = /[A-Za-z0-9_-]/

/** True when `id` is a legal fleet-created room id (§11 charset). */
export function isValidRoomId(id: string): boolean {
    return ROOM_ID_PATTERN.test(id)
}

/**
 * Percent-encode (RFC 3986) every byte outside the room-id charset so a local
 * room id created by arbitrary game code is URL-safe wherever it surfaces as an
 * API id — read model, routes, SSE events (§11). Ids already in the charset are
 * returned unchanged; everything else (including `~`, `/`, and non-ASCII encoded
 * as its UTF-8 bytes) becomes `%XX`. Unlike `encodeURIComponent`, this also
 * encodes `~`, `.`, `!`, `*`, `'`, `(`, `)` — none of which are in the charset,
 * and `~` in particular must never survive or it would forge a namespace marker.
 */
export function encodeRoomId(id: string): string {
    if (isValidRoomId(id)) {
        return id
    }
    let out = ''
    for (const byte of Buffer.from(id, 'utf8')) {
        const ch = String.fromCharCode(byte)
        out += ROOM_ID_CHAR.test(ch) ? ch : '%' + byte.toString(16).toUpperCase().padStart(2, '0')
    }
    return out
}

/** Join a stable `processUid` and an (already API-encoded) room id (§11). */
export function namespaceRoomId(processUid: string, encodedRoomId: string): string {
    return processUid + NAMESPACE_SEPARATOR + encodedRoomId
}
