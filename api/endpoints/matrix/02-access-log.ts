import { accessLog } from '@pathfinder/pathfinder/middleware';

// Access log per request: head line at response start, disposition
// (sent/aborted) at time-to-last-byte via request.completed.
export default accessLog();
