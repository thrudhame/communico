// api/engine/matrix-error.ts — spec-shaped error responses (F1).
// The endpoint outcome type pins HttpError<500>; Complement asserts real
// Matrix errcodes (M_USER_IN_USE, M_FORBIDDEN, …) and UIA 401 bodies.
// Endpoints throw MatrixError; api.ts renders {status, body} and leaves
// every other error on the legacy 400-generic path (existing endpoints
// keep their behavior).
export class MatrixError extends Error {
  readonly status: number;
  readonly errcode: string;
  readonly body?: Record<string, unknown>;

  constructor(
    status: number,
    errcode: string,
    message: string,
    body?: Record<string, unknown>,
  ) {
    super(`${errcode}: ${message}`);
    this.status = status;
    this.errcode = errcode;
    this.body = body;
  }

  responseBody(): Record<string, unknown> {
    if (this.body) return this.body;
    return { errcode: this.errcode, error: this.message };
  }
}
