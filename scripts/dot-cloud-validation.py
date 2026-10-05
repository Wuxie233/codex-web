#!/usr/bin/env python3
"""Run isolated Dot cloud checks, with explicit opt-in for one message attempt."""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--relay-socket', type=Path, required=True)
p.add_argument('--auth-socket', type=Path, required=True)
p.add_argument('--browser-egress-socket', type=Path, help='Optional restricted browser CONNECT egress')
p.add_argument('--readback-marker', help='Observe an existing exact reply in the UI without input or sending')
p.add_argument('--message-room-id', help='Explicit existing Dot room allowed for message verification')
p.add_argument('--expected-reply', help='Exact assistant reply marker; requires --message-text')
p.add_argument('--message-text', help='Caller-approved echo text; requires --message-room-id')
p.add_argument('--skip-account-preflight', action='store_true', help='Reuse earlier account read proof while diagnosing UI')
p.add_argument('--check', action='store_true', help='Run isolation checks only')
p.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
p.add_argument('--state', type=Path, required=True, help='Fresh task-owned output directory')
p.add_argument('--deps', type=Path, required=True)
p.add_argument('--chromium', type=Path, required=True, help='Chromium executable')
p.add_argument('--codex', type=Path, required=True)
a = p.parse_args()
if a.message_text is not None and not a.message_room_id:
    p.error("--message-text requires --message-room-id")
if a.message_text is not None and not a.message_text.strip():
    p.error("--message-text must not be empty")
if a.expected_reply is not None and a.message_text is None:
    p.error("--expected-reply requires --message-text")
if a.readback_marker is not None and not a.readback_marker.strip():
    p.error("--readback-marker must not be empty")
if a.readback_marker is not None and (not a.message_room_id or a.message_text is not None):
    p.error("--readback-marker requires room and forbids --message-text")
repo, state, deps, chromium, codex = [x.resolve() for x in [a.repo, a.state, a.deps, a.chromium, a.codex]]
state.mkdir(parents=True, exist_ok=False)
for name in ['home', 'codex', 'config', 'data', 'cache', 'workspace']:
    (state / name).mkdir()
(state / 'hosts').write_text('127.0.0.1 localhost chatgpt.com\n')
nonce = secrets.token_hex(16)
# A live host listener establishes that refused access is namespace isolation,
# not merely the absence of a production service.
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen(1)
args = ['bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--clearenv']
for source, target in [('/usr', '/usr'), ('/lib', '/lib'), ('/lib64', '/lib64'),
                       (str(repo), '/app'), (str(deps), '/deps'),
                       (str(chromium.parent), '/browser'), (str(codex), '/bin/codex-real'),
                       (str(a.relay_socket.resolve()), '/run/dot/fetch.sock'),
                       (str(a.auth_socket.resolve()), '/run/dot/auth.sock'),
                       (str(state / 'hosts'), '/etc/hosts')]:
    args += ['--ro-bind', source, target]
if a.browser_egress_socket:
    args += ['--ro-bind', str(a.browser_egress_socket.resolve()), '/run/dot/browser-egress.sock']
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
           CODEX_CLI_PATH='/app/scripts/dot-external-auth-cli.cjs', CODEX_TPP_LOCAL_EXECUTOR_CLI_PATH='/bin/codex-real',
           CODEX_BROWSER_FETCH_RELAY_SOCKET='/run/dot/fetch.sock',
           NODE_PATH='/deps', CHROMIUM_PATH='/browser/' + chromium.name,
           DOT_VALIDATION_NONCE=nonce, DOT_VALIDATION_HOST_PORT=str(listener.getsockname()[1]),
           DOT_SKIP_ACCOUNT_PREFLIGHT='1' if a.skip_account_preflight else '0',
           DOT_VALIDATION_MODE='isolation' if a.check else 'cloud')
if a.browser_egress_socket:
    env["DOT_BROWSER_EGRESS_SOCKET"] = "/run/dot/browser-egress.sock"
if a.message_room_id:
    env["CODEX_DOT_MESSAGE_ROOM_ID"] = a.message_room_id
if a.message_text is not None:
    env["DOT_VALIDATION_MESSAGE_TEXT"] = a.message_text
if a.expected_reply is not None:
    env["DOT_VALIDATION_EXPECTED_REPLY"] = a.expected_reply
if a.readback_marker is not None:
    env["DOT_VALIDATION_READBACK_MARKER"] = a.readback_marker
for key, value in env.items():
    args += ['--setenv', key, value]
args += ['--', '/usr/local/bin/node', '/app/tests/browser/dot-cloud-validation.cjs']
try:
    process = subprocess.Popen(args, start_new_session=True)
    try:
        code = process.wait(timeout=300 if a.message_text is not None or a.readback_marker is not None else 180)
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
    auth_files = list(state.rglob('auth.json'))
    if auth_files:
        raise RuntimeError('Unexpected persisted auth.json')
