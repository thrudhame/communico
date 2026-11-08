// api/engine/matrix-error.ts — spec-shaped error responses (F1), now on
// pathfinder's payload-agnostic HttpError (spike): the second super() arg is
// the response BODY, verbatim — Matrix errcode/error bodies render exactly.
// The errcode/status/responseBody() fields stay for engine callers and
// tests (tests/tenant.test.ts).
import { HttpError } from '@pathfinder/pathfinder';

export class MatrixError extends HttpError {
  readonly errcode: string;

  constructor(
    status: number,
    errcode: string,
    message: string,
    body?: Record<string, unknown>,
  ) {
    super(status, body ?? { errcode, error: message });
    this.errcode = errcode;
    this.message = `${errcode}: ${message}`;
  }

  responseBody(): Record<string, unknown> {
    return this.body as Record<string, unknown>;
  }
}
