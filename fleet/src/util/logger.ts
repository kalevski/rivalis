/**
 * Shared never-throws no-op logger, used as the fallback when the host did not
 * wire a `@toolcase/logging` logger in. One definition (task 002) so that a
 * change forced by a `Logger`-shape revision in `@toolcase/logging` lands in a
 * single place instead of the five copies it replaced (Config, Orchestrator,
 * FleetState, FleetAgent, Snapshot).
 */

import type { Logger } from '@toolcase/logging'

/** Never-throws no-op logger used when the host did not wire one in. */
export const NOOP_LOGGER = {
    error() {}, warning() {}, info() {}, debug() {}, verbose() {}, log() {}
} as unknown as Logger
