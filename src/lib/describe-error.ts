// Dependency-free: safe to import from browser components and server code alike.
/**
 * Turns any thrown value into a human-readable sentence — never "[object Object]".
 *
 * Errors thrown inside a server function are serialized across the RPC
 * boundary, so the browser receives a plain object (`{ message, code, hint }`
 * for Postgres failures), not an `Error` instance. `String(thatObject)` yields
 * "[object Object]", which is why real failures were invisible.
 */
export function describeUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;

  if (typeof Response !== "undefined" && error instanceof Response) {
    return `Request failed with status ${error.status}${error.url ? ` at ${error.url}` : ""}`;
  }

  if (typeof error === "string" && error.trim()) return error;

  if (error != null && typeof error === "object") {
    const shape = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const message = typeof shape.message === "string" ? shape.message.trim() : "";
    if (message) {
      const extras = [
        typeof shape.details === "string" && shape.details.trim() ? shape.details.trim() : null,
        typeof shape.hint === "string" && shape.hint.trim() ? shape.hint.trim() : null,
        typeof shape.code === "string" && shape.code.trim() ? `code ${shape.code.trim()}` : null,
      ].filter(Boolean);
      return extras.length ? `${message} (${extras.join("; ")})` : message;
    }
  }

  return "Something went wrong.";
}
