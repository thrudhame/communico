import { accessLog } from '@pathfinder/pathfinder/middleware';

// Access log per request: head line + disposition via request.completed.
export default accessLog();
