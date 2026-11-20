/** Child output belongs to the runner's evidence workspace, not the fixture's
 * disposable store. Retain it unconditionally: cleanup cannot know whether an
 * assertion in its caller failed. No open descriptors survive the child. */
export async function childDiagnostics() {
  const dir = await Deno.makeTempDir({ prefix: 'child-logs-' });
  await Deno.chmod(dir, 0o700);
  const append = (name: string) => {
    const path = `${dir}/${name}.log`;
    Deno.writeTextFileSync(path, '', { mode: 0o600 });
    return (text: string) =>
      Deno.writeTextFileSync(path, text, { append: true });
  };
  const stdout = append('stdout'), stderr = append('stderr');
  console.error('child diagnostics: ' + dir);
  return { dir, stdout, stderr };
}
