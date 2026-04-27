import { useEffect, useRef } from 'react'
import * as Phaser from 'phaser'
import {
    Heading,
    Kbd,
    SectionCard,
    Text
} from '@toolcase/react-components'
import {
    decode,
    encode,
    ARENA_HEIGHT,
    ARENA_PLAYER_RADIUS,
    ARENA_WIDTH,
    type ActorIdentity,
    type ArenaInput,
    type ArenaState
} from '../protocol'
import { useRoom } from './useRoom'
import StatusBar from './StatusBar'

type Props = { identity: ActorIdentity }

type SpriteEntry = {
    circle: Phaser.GameObjects.Arc
    label: Phaser.GameObjects.Text
}

const hexToColorNumber = (hex: string): number => {
    const cleaned = hex.startsWith('#') ? hex.slice(1) : hex
    const parsed = parseInt(cleaned, 16)
    return Number.isFinite(parsed) ? parsed : 0x4a7eff
}

/**
 * Phaser scene that mirrors authoritative server state into circles +
 * name labels. Owns no game logic — `setState(...)` is called by the
 * outer React component every time a frame arrives, and `update()`
 * just reconciles the graphics tree.
 */
class ArenaScene extends Phaser.Scene {

    private state: ArenaState = { youId: '', players: [] }

    private sprites: Map<string, SpriteEntry> = new Map()

    constructor() {
        super('arena')
    }

    create(): void {
        // Subtle play-area frame so out-of-bounds vs in-bounds is obvious.
        const half = { w: ARENA_WIDTH / 2, h: ARENA_HEIGHT / 2 }
        this.add
            .rectangle(half.w, half.h, ARENA_WIDTH, ARENA_HEIGHT, 0xf3f4f6)
            .setStrokeStyle(2, 0xd1d5db)
        this.add
            .text(half.w, ARENA_HEIGHT - 16, 'WASD or arrow keys to move', {
                fontFamily: 'system-ui, -apple-system, sans-serif',
                fontSize: '12px',
                color: '#6b7280'
            })
            .setOrigin(0.5, 1)
    }

    override update(_time: number, _delta: number): void {
        const seen = new Set<string>()
        for (const player of this.state.players) {
            seen.add(player.id)
            let entry = this.sprites.get(player.id)
            if (entry === undefined) {
                entry = this.spawnSprite(player.id, player.name, player.color)
                this.sprites.set(player.id, entry)
            }
            entry.circle.setPosition(player.x, player.y)
            entry.label.setPosition(player.x, player.y - ARENA_PLAYER_RADIUS - 14)
            const isYou = player.id === this.state.youId
            entry.circle.setStrokeStyle(isYou ? 4 : 2, isYou ? 0x111827 : 0xffffff)
        }
        for (const [id, entry] of this.sprites) {
            if (!seen.has(id)) {
                entry.circle.destroy()
                entry.label.destroy()
                this.sprites.delete(id)
            }
        }
    }

    private spawnSprite(id: string, name: string, color: string): SpriteEntry {
        const colorNum = hexToColorNumber(color)
        const circle = this.add.circle(0, 0, ARENA_PLAYER_RADIUS, colorNum)
        circle.setStrokeStyle(2, 0xffffff)
        const label = this.add
            .text(0, 0, name, {
                fontFamily: 'system-ui, -apple-system, sans-serif',
                fontSize: '12px',
                color: '#1f2937',
                backgroundColor: '#ffffffcc',
                padding: { x: 4, y: 1 }
            })
            .setOrigin(0.5, 0.5)
        return { circle, label }
    }

    setRemoteState(state: ArenaState): void {
        this.state = state
    }
}

export default function Arena({ identity }: Props) {
    const { client, state, reason } = useRoom('arena', identity)
    const containerRef = useRef<HTMLDivElement>(null)
    const sceneRef = useRef<ArenaScene | null>(null)

    // Boot Phaser once when the canvas div is mounted.
    useEffect(() => {
        if (containerRef.current === null) return
        const scene = new ArenaScene()
        sceneRef.current = scene
        const game = new Phaser.Game({
            type: Phaser.AUTO,
            width: ARENA_WIDTH,
            height: ARENA_HEIGHT,
            parent: containerRef.current,
            backgroundColor: '#ffffff',
            scene: [scene],
            scale: {
                mode: Phaser.Scale.FIT,
                autoCenter: Phaser.Scale.CENTER_HORIZONTALLY
            }
        })
        return () => {
            sceneRef.current = null
            game.destroy(true)
        }
    }, [])

    // Pump server state into the scene.
    useEffect(() => {
        if (client === null) return
        client.on(
            'arena:state',
            (payload) => {
                const next = decode<ArenaState>(payload as Uint8Array)
                sceneRef.current?.setRemoteState(next)
            },
            null
        )
    }, [client])

    // Bind WASD / arrow keys. Send a frame ONLY on key state changes —
    // a player holding W for 5s sends 1 keydown frame and 1 keyup frame,
    // not 150 frames of "still pressing W". This keeps us well inside
    // the default 30 fps token-bucket rate limit.
    useEffect(() => {
        if (client === null || state !== 'connected') return
        const input: ArenaInput = {
            up: false,
            down: false,
            left: false,
            right: false
        }
        const apply = (key: keyof ArenaInput, value: boolean): boolean => {
            if (input[key] === value) return false
            input[key] = value
            return true
        }
        const dispatch = (key: keyof ArenaInput, value: boolean) => {
            if (apply(key, value)) {
                client.send('input', encode(input))
            }
        }
        const keyOf = (e: KeyboardEvent): keyof ArenaInput | null => {
            switch (e.key.toLowerCase()) {
                case 'w':
                case 'arrowup':
                    return 'up'
                case 's':
                case 'arrowdown':
                    return 'down'
                case 'a':
                case 'arrowleft':
                    return 'left'
                case 'd':
                case 'arrowright':
                    return 'right'
                default:
                    return null
            }
        }
        const onDown = (e: KeyboardEvent) => {
            if (e.repeat) return
            const k = keyOf(e)
            if (k === null) return
            e.preventDefault()
            dispatch(k, true)
        }
        const onUp = (e: KeyboardEvent) => {
            const k = keyOf(e)
            if (k === null) return
            dispatch(k, false)
        }
        window.addEventListener('keydown', onDown)
        window.addEventListener('keyup', onUp)
        return () => {
            window.removeEventListener('keydown', onDown)
            window.removeEventListener('keyup', onUp)
            // Ensure the server doesn't think we're still walking when
            // we navigate away mid-press.
            const stop: ArenaInput = { up: false, down: false, left: false, right: false }
            try {
                client.send('input', encode(stop))
            } catch {
                /* socket may already be closed; that's fine */
            }
        }
    }, [client, state])

    return (
        <div className="room">
            <Heading as="h1">Arena</Heading>
            <Text as="p" variant="muted">
                Server-authoritative top-down playfield. Move with{' '}
                <Kbd keys={['W', 'A', 'S', 'D']} /> or the arrow keys. Each press / release
                sends a single input frame — the server runs the simulation at 30 Hz and
                broadcasts everyone&apos;s positions back.
            </Text>
            <StatusBar state={state} reason={reason} />

            <SectionCard title="Playfield" icon="dpad">
                <div ref={containerRef} className="arena-canvas" />
            </SectionCard>
        </div>
    )
}
