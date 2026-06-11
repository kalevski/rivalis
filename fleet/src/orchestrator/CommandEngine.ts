/**
 * Command engine (§7 command flow) — extracted from the Orchestrator god class.
 * Owns the per-instance pending-command map, the in-flight cap, the ack/timeout/
 * disconnect settle paths, and the release of capacity / room-id reservations on
 * every settle. Owns nothing about liveness or the read model beyond the injected
 * {@link TimerScheduler} and a {@link ReservationReleaser}, so it is unit-tested
 * directly against fakes — no Orchestrator, no WebSocket (§15).
 */

import { FleetError } from '../domain'
import { MAX_INFLIGHT_COMMANDS, Topics } from '../wire'
import type { AckPayload, CmdPayload } from '../wire'
import type { Reservation, RoomIdReservation } from './FleetState'
import type { AgentLink } from './FleetRoom'
import type { TimerScheduler } from '../util/scheduler'
import { describe } from '../util/errors'

/** Disposes the reservations a create rides on — satisfied by {@link FleetState}. */
export interface ReservationReleaser {
    release(reservation: Reservation): void
    releaseRoomId(reservation: RoomIdReservation): void
    /**
     * Hold a settled create's id (and a `maxRooms` slot) until its room is visible in
     * an applied snapshot from the owning instance (task 003). Called on ack-OK and
     * timeout instead of releasing, so a retry-after-504 cannot re-reserve the id and
     * double-create on another instance before the room reconciles.
     */
    holdUntilVisible(roomIdReservation: RoomIdReservation, reservation: Reservation): void
}

/** One outstanding `fleet/cmd` awaiting its `fleet/ack` (or timeout / disconnect). */
interface PendingCommand {
    resolve: (ack: AckPayload) => void
    reject: (error: Error) => void
    timer: unknown
    /** Capacity slot to release on settle (create only — §9). */
    reservation: Reservation | null
    /** Room-id reservation to release on settle (create only — §11). */
    roomIdReservation: RoomIdReservation | null
}

export class CommandEngine {

    /** Pending commands keyed by instance id, then by `cmdId`. */
    private readonly pending = new Map<string, Map<string, PendingCommand>>()
    private cmdSeq = 0

    constructor(
        private readonly scheduler: TimerScheduler,
        private readonly reservations: ReservationReleaser,
        private readonly commandTimeoutMs: number
    ) {}

    /** Monotonic command id (`cmd_N`) — connection-agnostic, unique per orchestrator. */
    nextCmdId(): string {
        return `cmd_${++this.cmdSeq}`
    }

    /** How many commands are currently in flight for an instance. */
    inFlight(instanceId: string): number {
        return this.pending.get(instanceId)?.size ?? 0
    }

    /**
     * Push a `fleet/cmd` and return a promise that resolves on its `fleet/ack`
     * (rejects on `COMMAND_FAILED`), or rejects on timeout (`COMMAND_TIMEOUT`) /
     * disconnect (`INSTANCE_DISCONNECTED`). Caps in-flight commands per instance at
     * {@link MAX_INFLIGHT_COMMANDS} → `INSTANCE_BUSY` rather than queueing unbounded
     * promises behind a slow agent (§7). Reservations (create only) ride on the
     * pending entry and are released on every settle path.
     */
    send(
        link: AgentLink,
        cmd: CmdPayload,
        reservation: Reservation | null = null,
        roomIdReservation: RoomIdReservation | null = null
    ): Promise<AckPayload> {
        const map = this.mapFor(link.instanceId)
        if (map.size >= MAX_INFLIGHT_COMMANDS) {
            // Not yet owned by a pending entry — release here so nothing leaks.
            if (reservation !== null) { this.reservations.release(reservation) }
            if (roomIdReservation !== null) { this.reservations.releaseRoomId(roomIdReservation) }
            return Promise.reject(new FleetError(
                'INSTANCE_BUSY',
                `instance ${link.instanceId} has ${map.size} commands in flight (max ${MAX_INFLIGHT_COMMANDS})`
            ))
        }
        return new Promise<AckPayload>((resolve, reject) => {
            const timer = this.scheduler.setTimeout(() => {
                this.settle(link.instanceId, cmd.cmdId, (pending) => {
                    // A timeout does NOT mean the room wasn't created — the agent may
                    // have created it and the ack was lost/late (§10). Hold the
                    // reservations until the owning instance's next snapshot proves the
                    // room present or absent (task 003), so a retry inside the window
                    // gets a fast 409 ROOM_EXISTS rather than double-creating.
                    this.holdOrRelease(pending)
                    pending.reject(new FleetError(
                        'COMMAND_TIMEOUT',
                        `command ${cmd.cmdId} (${cmd.op}) timed out after ${this.commandTimeoutMs}ms`
                    ))
                })
            }, this.commandTimeoutMs)
            map.set(cmd.cmdId, { resolve, reject, timer, reservation, roomIdReservation })
            try {
                link.send(Topics.cmd, cmd)
            } catch (error) {
                // A synchronous `link.send` failure (core `Room.send` throw, encode error)
                // means the command never reached the agent. Settle the just-created
                // pending entry NOW — clear its timer and release its reservations —
                // instead of leaking the in-flight slot and reservations until
                // `commandTimeoutMs`; the caller already failed, nothing was created
                // (§14). Settled before any await resolves, so no double-settle race.
                this.settle(link.instanceId, cmd.cmdId, (pending) => {
                    this.releaseReservations(pending)
                    pending.reject(new FleetError(
                        'INSTANCE_DISCONNECTED',
                        `failed to send command ${cmd.cmdId} (${cmd.op}) to instance ${link.instanceId}: ${describe(error)}`
                    ))
                })
            }
        })
    }

    /**
     * Resolve/reject the originating promise for an inbound `fleet/ack`. Returns
     * `false` when no such pending exists (a late ack after a timeout, or an unknown
     * cmd) so the caller can log-and-drop — never a double-resolve (§14).
     */
    ack(instanceId: string, ack: AckPayload): boolean {
        return this.settle(instanceId, ack.cmdId, (pending) => {
            if (ack.ok) {
                // The room now exists on the instance but is not yet in any applied
                // snapshot — hold the id reservation until it reconciles (task 003).
                this.holdOrRelease(pending)
                pending.resolve(ack)
            } else {
                // Create failed → release immediately (no room created, id free). The
                // agent's explicit "already exists" signal maps to the §10-documented
                // 409 ROOM_EXISTS rather than a generic 502 COMMAND_FAILED (task 003).
                this.releaseReservations(pending)
                pending.reject(ack.exists === true
                    ? new FleetError('ROOM_EXISTS', ack.error ?? 'room id already exists')
                    : new FleetError('COMMAND_FAILED', ack.error ?? 'agent reported command failure'))
            }
        })
    }

    /**
     * Reject every in-flight command for a disconnected/evicted instance immediately
     * with `INSTANCE_DISCONNECTED` — callers never wait out `commandTimeoutMs` for an
     * instance the orchestrator already knows is gone (§7).
     */
    rejectAll(instanceId: string, reason: string): void {
        const map = this.pending.get(instanceId)
        if (map === undefined) {
            return
        }
        for (const cmdId of [...map.keys()]) {
            this.settle(instanceId, cmdId, (pending) => {
                // The instance is gone and its rooms vanish from the read model, so a
                // create's reservations are released outright (no hold) — and FleetState
                // also clears any already-held pending-visibility ids on removeInstance.
                this.releaseReservations(pending)
                pending.reject(new FleetError('INSTANCE_DISCONNECTED', `instance ${instanceId} disconnected (${reason})`))
            })
        }
        this.pending.delete(instanceId)
    }

    /**
     * Settle exactly one pending command: delete it and clear its timer, then run
     * `action` (which disposes the reservations — release or {@link holdOrRelease} —
     * and resolves/rejects). Returns `false` when no such pending exists (already
     * settled) — the single guard against double-resolve from a timeout-then-late-ack
     * or disconnect-then-ack race (§14). Reservation disposition moved into the per-path
     * `action` callbacks (task 003): ack-OK / timeout hold until visible, every other
     * path releases.
     */
    settle(instanceId: string, cmdId: string, action: (pending: PendingCommand) => void): boolean {
        const map = this.pending.get(instanceId)
        const pending = map?.get(cmdId)
        if (map === undefined || pending === undefined) {
            return false
        }
        map.delete(cmdId)
        this.scheduler.clearTimeout(pending.timer)
        action(pending)
        return true
    }

    /**
     * Hold a create's reservations until its room is visible (task 003) — used on
     * ack-OK and timeout. A create carries BOTH a capacity and a room-id reservation;
     * any other command (destroy/drain/undrain) carries neither, so this degrades to a
     * release of whatever (if anything) is present.
     */
    private holdOrRelease(pending: PendingCommand): void {
        if (pending.reservation !== null && pending.roomIdReservation !== null) {
            this.reservations.holdUntilVisible(pending.roomIdReservation, pending.reservation)
        } else {
            this.releaseReservations(pending)
        }
    }

    /** Release a settled command's reservations immediately (failure / disconnect / busy). */
    private releaseReservations(pending: PendingCommand): void {
        if (pending.reservation !== null) { this.reservations.release(pending.reservation) }
        if (pending.roomIdReservation !== null) { this.reservations.releaseRoomId(pending.roomIdReservation) }
    }

    private mapFor(instanceId: string): Map<string, PendingCommand> {
        let map = this.pending.get(instanceId)
        if (map === undefined) {
            map = new Map<string, PendingCommand>()
            this.pending.set(instanceId, map)
        }
        return map
    }
}
