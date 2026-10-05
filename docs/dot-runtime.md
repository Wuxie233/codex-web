# Isolated Dot service

`scripts/dot-runtime-supervisor.py` runs the native Dot application separately
from the existing Codex service. It needs Bubblewrap, Node, Python, OpenSSL,
Xvfb, a verified native Codex executable, prepared Dot assets, Chromium, and an
existing externally managed Codex token. The deployment user must be able to
create private namespaces and the nginx group is `www`.

Supply `--repo`, `--state`, `--deps`, `--chromium`, `--codex`, `--auth-file`,
`--target-file` and `--parent-origin`. The target JSON contains the confirmed
existing `selection.messaging_room_id`; it is not a credential. Keep it private.
The server ingress is `/run/codex-dot/http.sock` (root:www, 0660); every public
HTTP and WebSocket path must have an authentication gate. The supervisor does
not expose a TCP listener on the host. Its namespace-local port is 8215.

Use one systemd service with `KillMode=control-group`, `Restart=on-failure`,
`UMask=0077` and core dumps disabled. A state-directory lock prevents duplicate
supervisors. On restart after the previous cgroup has been reaped, only stale
sockets owned by the service user are removed. Keep the state directory between
restarts: it contains the durable message request-ID hashes and native local
preferences. Do not delete or reset the message ledger to retry an unknown send.

The browser and app have separate PID/mount/network namespaces. They cannot
see the production daemon or source credentials. The browser has a restricted
CONNECT proxy and an ephemeral profile. Host transport processes read the
existing token into memory only; they neither refresh nor write the source
login. Source-token changes or expiry restart the isolated group. Every 30
seconds a read-only authenticated primary-selection request verifies the relay
and confirms the selected room. Transport failure stops and restarts the group;
a different selected room remains unavailable until deliberately reconciled.
A successful local HTTP response alone does not establish Dot cloud health.

The app uses the existing external-auth CLI allowlist. Computer execution,
registration and permission grants remain unavailable. Cloud sends retain the
fixed-room, plain-text and durable duplicate-ID restrictions. These restrictions
do not constrain tools already granted to the cloud Dot elsewhere. Browser
notification and avatar origins are contacted by the user's real browser, as in
the native renderer. The internal transport browser is not an executor.

`runtime-status.json` records `starting`, `running`, `unavailable` or `stopped`
without secrets. App output is discarded; source tokens and auth response bodies
must never be added to logs. Stop the service before moving its state or replacing
its runtime files. Verify existing message readback after deployment; do not send
a duplicate compatibility marker.
