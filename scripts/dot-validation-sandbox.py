#!/usr/bin/env python3
"""Run offline Dot checks in a private filesystem, PID and network namespace."""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('mode', choices=['isolation', 'smoke'], nargs='?', default='isolation')
p.add_argument('--check', action='store_true', help='Run isolation checks only')
p.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
p.add_argument('--state', type=Path, required=True, help='Fresh task-owned output directory')
p.add_argument('--deps', type=Path, required=True)
p.add_argument('--chromium', type=Path, required=True, help='Chromium executable')
p.add_argument('--codex', type=Path, required=True)
a = p.parse_args()
repo, state, deps, chromium, codex = [x.resolve() for x in [a.repo, a.state, a.deps, a.chromium, a.codex]]
state.mkdir(parents=True, exist_ok=False)
for name in ['home', 'codex', 'config', 'data', 'cache', 'workspace']:
    (state / name).mkdir()
nonce = secrets.token_hex(16)
# A live host listener establishes that refused access is namespace isolation,
# not merely the absence of a production service.
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen(1)
args = ['bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--clearenv']
for source, target in [('/usr', '/usr'), ('/lib', '/lib'), ('/lib64', '/lib64'),
                       (str(repo), '/app'), (str(deps), '/deps'),
                       (str(chromium.parent), '/browser'), (str(codex), '/bin/codex')]:
    args += ['--ro-bind', source, target]
# npm's existing symlink can target outside /app; expose only its dependency tree.
modules = repo / 'node_modules'
if modules.is_symlink():
    args += ['--ro-bind', str(deps), str(modules.resolve())]
else:
    args += ['--ro-bind', str(deps), '/app/node_modules']
args += ['--tmpfs', '/app/.local', '--bind', str(state), '/state',
         '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chdir', '/app']
env = dict(HOME='/state/home', CODEX_HOME='/state/codex', XDG_CONFIG_HOME='/state/config',
           XDG_DATA_HOME='/state/data', XDG_CACHE_HOME='/state/cache', PATH='/bin:/usr/local/bin:/usr/bin',
           CODEX_CLI_PATH='/bin/codex', CODEX_TPP_LOCAL_EXECUTOR_CLI_PATH='/bin/codex',
           NODE_PATH='/deps', CHROMIUM_PATH='/browser/' + chromium.name,
           DOT_VALIDATION_NONCE=nonce, DOT_VALIDATION_HOST_PORT=str(listener.getsockname()[1]),
           DOT_VALIDATION_MODE='isolation' if a.check else a.mode)
for key, value in env.items():
    args += ['--setenv', key, value]
args += ['--', '/usr/local/bin/node', '/app/tests/browser/dot-validation.cjs']
try:
    process = subprocess.Popen(args, start_new_session=True)
    try:
        code = process.wait(timeout=120)
    except BaseException:
        # Killing the namespace's bwrap supervisor also closes its lifetime pipe.
        # The private PID namespace kernel-reaps every descendant when PID 1 exits.
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise
    output = json.loads((state / 'isolation.json').read_text())
    if output['nonce'] != nonce:
        raise RuntimeError('Isolation nonce mismatch')
    raise SystemExit(code)
finally:
    listener.close()
