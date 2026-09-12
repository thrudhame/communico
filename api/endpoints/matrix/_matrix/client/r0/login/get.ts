// r0 alias — capture conclusion 1: matrix-commander hardcodes
// GET /_matrix/client/r0/login for the flows probe; the handler is the
// v3 one.
export { default } from '../../v3/login/get.ts';
export const auth = false;
