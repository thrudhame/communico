import { cors } from '@pathfinder/pathfinder/middleware';

// Matrix client API is cross-origin by spec (web clients on any origin).
// Preflight short-circuits here; the post-fn stamps every response —
// including 404/405/500 outcomes and thrown HttpErrors.
export default cors({
  origin: '*',
  headers: 'Authorization, Content-Type',
  methods: 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
});
