import { timing } from '@pathfinder/pathfinder/middleware';

// Server-Timing header (`server-timing: total;dur=<ms>`) on every response
// through this tree.
export default timing();
