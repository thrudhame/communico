import { join } from '@std/path';
import type { Store } from '#engine/store/index.ts';
import type { CandidateStore } from '#engine/store/candidate.ts';
import { canonicalRoot } from '#engine/store/ownership.ts';
import { syncPath } from '#engine/store/files.ts';
import {
  completeRecovery,
  type RecoveryState,
  recoveryState,
} from '#engine/server/recovery.ts';
import { describePayload } from './manifest.ts';

// The release marker covers the whole fsynced report, including command/job and
// RPO disclosures supplied by the offline restore coordinator.
export type RestoreReport = {
  format: 1;
  id: string;
  epoch: string;
  backupId: string;
  cut: { started: string; completed: string };
  restoredAt: string;
  audits: unknown;
  migrations: unknown;
  sanitation: unknown;
  pendingWork: unknown;
  warnings: string[];
};

function reportPath(root: string, state: RecoveryState): string {
  return join(root, 'restore-reports', state.reportId + '.json');
}

export async function writeRestoreReport(
  candidate: CandidateStore,
  root: string,
  report: RestoreReport,
): Promise<string> {
  root = await canonicalRoot(root);
  const server = candidate.files.find((file) => file.kind === 'server')!;
  const state = await candidate.read(server, recoveryState);
  if (
    !state || report.format !== 1 || state.epoch !== report.epoch ||
    state.reportId !== report.id || state.reportSha256 !== null
  ) throw new Error('restore report does not match recovery marker');
  const directory = join(root, 'restore-reports');
  await Deno.mkdir(directory, { mode: 0o700 });
  const path = reportPath(root, state);
  const file = await Deno.open(path, {
    write: true,
    createNew: true,
    mode: 0o600,
  });
  try {
    const bytes = new TextEncoder().encode(
      JSON.stringify(report, null, 2) + '\n',
    );
    let offset = 0;
    while (offset < bytes.length) {
      offset += await file.write(bytes.subarray(offset));
    }
    await file.sync();
  } finally {
    file.close();
  }
  await syncPath(directory);
  await syncPath(root);
  const payload = await describePayload(
    root,
    'restore-reports/' + state.reportId + '.json',
  );
  await candidate.tx(
    server,
    (conn) => completeRecovery(conn, state, payload.sha256),
  );
  return path;
}

export async function assertRestoreReport(store: Store): Promise<void> {
  const state = await recoveryState(await store.server());
  if (state === null) return; // No restore: retain pre-feature startup/token behavior.
  if (state.reportSha256 === null) {
    throw new Error('restore report is incomplete; refusing to start workers');
  }
  const relative = 'restore-reports/' + state.reportId + '.json';
  const payload = await describePayload(store.directory, relative);
  if (payload.sha256 !== state.reportSha256) {
    throw new Error('restore report digest mismatch');
  }
  const report = JSON.parse(
    await Deno.readTextFile(reportPath(store.directory, state)),
  ) as RestoreReport;
  if (
    report.format !== 1 || report.id !== state.reportId ||
    report.epoch !== state.epoch
  ) throw new Error('restore report identity mismatch');
}
