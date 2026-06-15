/**
 * Shared error helpers. One definition (task 002) of the unknown-error
 * stringifier that was copy-pasted across the orchestrator, REST router, agent
 * and CLI.
 */

/** Human-readable message for an unknown thrown value — `Error.message` or `String(value)`. */
export function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
