"""Transport-only child evidence collection. Failure to verify blocks cleanup.

Gate drivers call collect_child_logs before deleting their owned guest TMPDIR.
No project workload runs in this module; `remote` addresses the assigned CT.
"""
import hashlib
import json
from pathlib import Path
import shlex


def collect_child_logs(remote, scratch, out, label):
    root = Path(out) / (label + '-children')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    # NUL delimiters retain spaces/newlines without changing the inventory.
    query = 'find ' + shlex.quote(scratch) + ' -type f -path "*/child-logs-*/*" -printf "%P\\0"'
    inventory = [p.decode() for p in remote(query).split(b'\0') if p]
    manifest = {}
    for name in inventory:
        path = Path(name)
        if path.is_absolute() or '..' in path.parts:
            raise ValueError('invalid diagnostic path')
        guest = shlex.quote(scratch + '/' + name)
        data = remote('cat -- ' + guest)
        digest = hashlib.sha256(data).hexdigest()
        if remote('sha256sum -- ' + guest).decode().split()[0] != digest:
            raise ValueError('diagnostics changed during collection: ' + name)
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        target.write_bytes(data)
        target.chmod(0o600)
        if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise ValueError('diagnostic copy mismatch: ' + name)
        manifest[name] = digest
    # Catch arrivals/removals between inventory and collection. A live child or
    # changed log cannot silently qualify the directory for deletion.
    if [p.decode() for p in remote(query).split(b'\0') if p] != inventory:
        raise ValueError('child diagnostic inventory changed during collection')
    for name, digest in manifest.items():
        if remote('sha256sum -- ' + shlex.quote(scratch + '/' + name)).decode().split()[0] != digest:
            raise ValueError('child diagnostics still changing: ' + name)
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (root / 'manifest.json').chmod(0o600)
    return manifest
