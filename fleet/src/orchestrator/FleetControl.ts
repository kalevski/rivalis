/**
 * Control surface (§9 control API) — extracted from the Orchestrator god class.
 * Implements the mutating half of `orchestrator.fleet` (`createRoom`, `destroyRoom`,
 * `drainInstance`, `undrainInstance`) by combining placement + id reservation
 * (FleetState) with acknowledged command dispatch ({@link CommandEngine}). The
 * Orchestrator's `fleet` object delegates straight to this, and resolves the owning
 * {@link AgentLink} through the injected `getLink` (the live-links map stays the
 * Orchestrator's). Holds no state of its own, so it is unit-tested against fakes (§15).
 */

import { FleetError } from '../domain'
import type { PlacementRequest, RoomInfo } from '../domain'
import type { CmdPayload } from '../wire'
import { FleetState } from './FleetState'
import type { Placement } from './FleetState'
import type { CommandEngine } from './CommandEngine'
import type { AgentLink } from './FleetRoom'

export class FleetControl {

    constructor(
        private readonly state: FleetState,
        private readonly commands: CommandEngine,
        private readonly getLink: (instanceId: string) => AgentLink | undefined
    ) {}

    /** Place a new room and push an acknowledged `create` command (§9 command flow). */
    async createRoom(request: { type: string; roomId?: string; placement?: PlacementRequest }): Promise<RoomInfo> {
        // Reserve the id first so a concurrent create with the same explicit id
        // fails fast with ROOM_EXISTS instead of double-creating (§11).
        const roomIdReservation = this.state.reserveRoomId(request.roomId)
        let placement: Placement
        try {
            placement = this.state.place({ type: request.type, ...(request.placement ?? {}) })
        } catch (error) {
            this.state.releaseRoomId(roomIdReservation)
            throw error
        }

        const link = this.getLink(placement.instance.id)
        if (link === undefined) {
            this.state.release(placement.reservation)
            this.state.releaseRoomId(roomIdReservation)
            throw new FleetError('INSTANCE_DISCONNECTED', `instance ${placement.instance.id} is no longer connected`)
        }

        const cmd: CmdPayload = {
            cmdId: this.commands.nextCmdId(),
            op: 'create',
            roomId: roomIdReservation.roomId,
            roomType: request.type
        }
        await this.commands.send(link, cmd, placement.reservation, roomIdReservation)

        // The room surfaces in the read model on the next snapshot (source of truth,
        // §3); the returned RoomInfo is the read-your-write optimization (§14). The
        // reserved id is charset-valid, so its public id == itself.
        return {
            id: roomIdReservation.roomId,
            type: request.type,
            connections: 0,
            instanceId: placement.instance.id,
            endpointUrl: placement.instance.endpointUrl,
            local: false
        }
    }

    /** Destroy a room by its fleet-unique public id; the orchestrator resolves the owner (§9, §10). */
    async destroyRoom(roomId: string): Promise<void> {
        const located = this.state.resolveRoom(roomId)
        if (located === null) {
            throw new FleetError('ROOM_NOT_FOUND', `room ${roomId} not found`)
        }
        const link = this.getLink(located.instanceId)
        if (link === undefined) {
            throw new FleetError('INSTANCE_DISCONNECTED', `instance ${located.instanceId} is no longer connected`)
        }
        // The agent knows the room by its RAW id, never the public/namespaced one (§11).
        await this.commands.send(link, { cmdId: this.commands.nextCmdId(), op: 'destroy', roomId: located.rawRoomId })
    }

    /** Ask an instance to drain via `fleet/cmd {op:'drain'}` — the agent owns status (§7). */
    drainInstance(instanceId: string): Promise<void> {
        return this.sendStatusCommand(instanceId, 'drain')
    }

    /** Reverse of {@link drainInstance}. */
    undrainInstance(instanceId: string): Promise<void> {
        return this.sendStatusCommand(instanceId, 'undrain')
    }

    private async sendStatusCommand(instanceId: string, op: 'drain' | 'undrain'): Promise<void> {
        if (this.state.getInstance(instanceId) === null) {
            throw new FleetError('INSTANCE_NOT_FOUND', `instance ${instanceId} not found`)
        }
        const link = this.getLink(instanceId)
        if (link === undefined) {
            throw new FleetError('INSTANCE_DISCONNECTED', `instance ${instanceId} is no longer connected`)
        }
        await this.commands.send(link, { cmdId: this.commands.nextCmdId(), op })
        // Acked: the agent has flipped its agent-owned status (§7), but the read-model
        // status only catches up at the next poll reply — up to one heartbeatMs later.
        // Record a placement-only override so candidacy converges now, closing the window
        // where a fresh createRoom still lands on (or stays off) this instance (task 004).
        // On a rejected command (timeout/disconnect/failure) the await throws and we never
        // record an override — the drain/undrain did not take effect. Status ownership is
        // intact: this never writes the read-model `status`, only the placement override.
        this.state.setPendingStatus(instanceId, op === 'drain' ? 'draining' : 'active')
    }
}
