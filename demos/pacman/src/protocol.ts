// Shared wire types + the static maze for the Pac-Man demo.
//
// Rivalis treats every frame payload as opaque bytes — exactly like the other
// demos, we encode our own small JSON shapes here. The maze itself is static,
// so it lives in this shared module and is NOT sent over the wire: the server
// simulates against it and the client renders against the very same grid. Only
// the dynamic bits (entity positions, eaten pellets, scores) travel as frames.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encode = <T>(value: T): Uint8Array => encoder.encode(JSON.stringify(value))
export const decode = <T>(payload: Uint8Array): T => JSON.parse(decoder.decode(payload)) as T

/** The single room every client lands in. */
export const ROOM_ID = 'pacman'

// ---- maze ---------------------------------------------------------------
//
// Legend: '#' wall · '.' pellet (10 pts) · 'o' power pellet (50 pts) ·
// ' ' open corridor with no pellet (the two side-tunnel mouths on the
// middle row).
//
// The layout is connected *by construction*: columns 1,5,9,13,17 are open
// top-to-bottom and rows 1,5,9,13,17,19 are open left-to-right, so every
// open cell sits on a corridor that reaches the outer ring. Row 9 has the
// classic wrap-around side tunnels.

export const MAZE: readonly string[] = [
    '###################',
    '#.................#',
    '#o###.###.###.###o#',
    '#.###.###.###.###.#',
    '#.###.###.###.###.#',
    '#.................#',
    '#.###.###.###.###.#',
    '#.###.###.###.###.#',
    '#.###.###.###.###.#',
    ' ................. ',
    '#.###.###.###.###.#',
    '#.###.###.###.###.#',
    '#.###.###.###.###.#',
    '#.................#',
    '#.###.###.###.###.#',
    '#.###.###.###.###.#',
    '#.###.###.###.###.#',
    '#.................#',
    '#o###.###.###.###o#',
    '#.................#',
    '###################'
]

export const COLS = MAZE[0]!.length
export const ROWS = MAZE.length

/** Pixel size of one maze tile (used by the canvas renderer). */
export const TILE = 24

/** The row carrying the left/right wrap-around tunnels. */
export const TUNNEL_ROW = 9

/** Server simulation / broadcast rate. */
export const TICK_HZ = 30

/** Points awarded for each pellet kind. */
export const PELLET_POINTS = 10
export const POWER_POINTS = 50

/** Penalty (floored at 0) applied to a player's score when a ghost eats them. */
export const DEATH_PENALTY = 20

/** Read the maze tile at (x, y), wrapping horizontally on the tunnel row. */
export const tileAt = (x: number, y: number): string => {
    if (y < 0 || y >= ROWS) return '#'
    let cx = x
    if (cx < 0) cx += COLS
    else if (cx >= COLS) cx -= COLS
    const row = MAZE[y]!
    return row[cx] ?? '#'
}

/** Whether (x, y) is a wall (out-of-bounds counts as wall). */
export const isWall = (x: number, y: number): boolean => tileAt(x, y) === '#'

/** Flat index of a tile, used as the stable id of a pellet. */
export const pelletIndex = (x: number, y: number): number => y * COLS + x

/** The points a pellet at the given flat index is worth (0 if none there). */
export const pelletPoints = (index: number): number => {
    const x = index % COLS
    const y = Math.floor(index / COLS)
    const c = tileAt(x, y)
    if (c === '.') return PELLET_POINTS
    if (c === 'o') return POWER_POINTS
    return 0
}

/** Every pellet tile index in the maze ('.' and 'o'). */
export const allPelletIndices = (): number[] => {
    const out: number[] = []
    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            const c = tileAt(x, y)
            if (c === '.' || c === 'o') out.push(pelletIndex(x, y))
        }
    }
    return out
}

// ---- shared identity ----------------------------------------------------

/** A movement intent. Directions persist server-side until changed. */
export type Dir = 'up' | 'down' | 'left' | 'right' | 'none'

export const DIR_VECTORS: Record<Dir, { x: number; y: number }> = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
    none: { x: 0, y: 0 }
}

// ---- wire frames --------------------------------------------------------

/** Inbound: the client's latest desired direction (sent only on change). */
export type InputCommand = { dir: Dir }

/** A Pac-Man controlled by a connected player. */
export type PlayerState = {
    id: string
    name: string
    color: string
    x: number
    y: number
    dir: Dir
    score: number
}

/** A server-controlled ghost. */
export type GhostState = {
    id: number
    color: string
    x: number
    y: number
    dir: Dir
}

/** Outbound: the authoritative snapshot, broadcast every tick. */
export type GameState = {
    players: PlayerState[]
    ghosts: GhostState[]
    pelletsLeft: number
}

/** Outbound: sent once to a freshly-joined client. `eaten` lets a late
 *  joiner reconcile the board to the pellets already consumed. */
export type WelcomeEvent = {
    youId: string
    eaten: number[]
}

/** Outbound: a pellet was just eaten — clients remove it from their board. */
export type PelletEvent = {
    index: number
    by: string
}

/** Outbound: a player was caught by a ghost and respawned. */
export type DeathEvent = {
    id: string
}
