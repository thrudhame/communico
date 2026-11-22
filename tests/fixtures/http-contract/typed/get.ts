import { MatrixError } from '#engine/matrix-error.ts';

export default function () {
  const error = new MatrixError(503, 'M_UNAVAILABLE', 'fixture unavailable');
  error.cause = new TypeError('typed-child-marker');
  throw error;
}
