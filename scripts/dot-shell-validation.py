#!/usr/bin/env python3
"""Validate two actual applications in an isolated namespace; never send messages."""
import argparse, json, os, secrets, signal, socket, subprocess
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
for key in ['dot-repo','state','deps','chromium','codex','relay-socket','auth-socket','browser-egress-socket']:
    p.add_argument('--'+key,type=Path,required=not key.endswith('socket'))
p.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[1])
p.add_argument('--message-room-id')
p.add_argument('--readback-marker')
p.add_argument('--check',action='store_true')
a=p.parse_args()
if not a.check:
    for key in ['relay_socket','auth_socket','browser_egress_socket','message_room_id','readback_marker']:
        if not getattr(a,key):p.error(key+' is required outside --check')
state=a.state.resolve();state.mkdir(parents=True,exist_ok=False)
for app in ['old','new']:
    for directory in ['home','codex','config','data','cache','workspace']:
        (state/app/directory).mkdir(parents=True,exist_ok=True)
(state/'hosts').write_text('127.0.0.1 localhost chatgpt.com\n')
nonce=secrets.token_hex(16)
listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(1)
args=['bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv']
mounts=[('/etc/fonts','/etc/fonts'),('/usr','/usr'),('/lib','/lib'),('/lib64','/lib64'),(a.repo.resolve(),'/old'),(a.dot_repo.resolve(),'/dot'),(a.deps.resolve(),'/deps'),(a.chromium.resolve().parent,'/browser'),(a.codex.resolve(),'/bin/codex-real'),(state/'hosts','/etc/hosts')]
if not a.check:
    mounts += [(a.relay_socket.resolve(),'/run/dot/fetch.sock'),(a.auth_socket.resolve(),'/run/dot/auth.sock'),(a.browser_egress_socket.resolve(),'/run/dot/browser-egress.sock')]
for src,dst in mounts:args+=['--ro-bind',str(src),str(dst)]
# Preserve symlink resolution without exposing either original checkout.
for repo in [a.repo.resolve(),a.dot_repo.resolve()]:
    if (repo/'node_modules').is_symlink():args+=['--ro-bind',str(a.deps.resolve()),str((repo/'node_modules').resolve())]
args+=['--tmpfs','/old/.local','--tmpfs','/dot/.local','--bind',str(state),'/state','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chdir','/old']
env=dict(PATH='/bin:/usr/local/bin:/usr/bin',NODE_PATH='/deps',HOME='/state',CHROMIUM_PATH='/browser/'+a.chromium.name,DOT_VALIDATION_NONCE=nonce,DOT_VALIDATION_HOST_PORT=str(listener.getsockname()[1]),DOT_ROOM=a.message_room_id or '',DOT_MARKER=a.readback_marker or '',DOT_CHECK='1' if a.check else '0')
for k,v in env.items():args+=['--setenv',k,v]
args+=['--','/usr/local/bin/node','/old/tests/browser/dot-shell-integration.cjs']
try:
    child=subprocess.Popen(args,start_new_session=True)
    try:code=child.wait(timeout=360)
    except BaseException:
        os.killpg(child.pid,signal.SIGKILL);child.wait();raise
    if json.loads((state/'isolation.json').read_text())['nonce']!=nonce:raise RuntimeError('Isolation nonce mismatch')
    raise SystemExit(code)
finally:
    listener.close()
    if list(state.rglob('auth.json')):raise RuntimeError('Unexpected persisted auth.json')
