import type { App } from '#engine/app.ts';
import { listReports, resolveReport } from '#engine/server/reports.ts';
import type { Operation } from '#root/api/admin/protocol.ts';

export function reportOperations(app: App): Record<string, Operation> {
  return {
    '/v1/reports/list': (body) => listReports(app.server, body),
    '/v1/reports/resolve': (body) =>
      resolveReport(app.server, body.id, body.resolution),
  };
}
