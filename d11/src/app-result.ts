/** A boundary execution result; success alone says nothing about domain completeness. */
export type AppResult<T, E> = { ok: true; data: T } | { ok: false; error: E };
