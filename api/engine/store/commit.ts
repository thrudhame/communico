// Commit dependencies belong to the storage owner, after snapshot admission.
// Checks may compose without losing their shared/exclusive authority permits.
export type CommitPermit = {
  run<T>(commit: () => Promise<T>): Promise<T>;
};

export type CommitCheck = (() => void) & {
  permits?: readonly CommitPermit[];
};

export function commitCheck(
  check: () => void,
  ...dependencies: readonly CommitCheck[]
): CommitCheck {
  return Object.assign(check, {
    permits: dependencies.flatMap((dependency) => dependency.permits ?? []),
  });
}

export function commitAdmitted<T>(
  checks: ReadonlySet<CommitCheck>,
  commit: () => Promise<T>,
): Promise<T> {
  let run = () => {
    for (const check of checks) check();
    return commit();
  };
  const permits = new Set([...checks].flatMap((check) => check.permits ?? []));
  for (const permit of permits) {
    const next = run;
    run = () => permit.run(next);
  }
  return run();
}
