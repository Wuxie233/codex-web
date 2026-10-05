# Linux Dot validation candidate

This is an isolated compatibility candidate for official Linux Desktop
`26.930.41038`, not a production replacement or a daily-use release. It prepares
the upstream bundle with `patches/linux-dot-main.patch` and
`patches/linux-dot-webview.patch`. The 53 old patch target segments whose asset
paths changed have not all been migrated; legacy fork behavior is not covered by
this candidate's smoke checks. See [FORK.md](../FORK.md) for the existing runtime
contract, especially the shared daemon boundary.

## Prepare and build

Use a separate checkout or worktree. Supply an independently extracted, unmodified
official ASAR directory whose package provenance and checksum have already been
verified. The preparation script checks the version, not the download signature.
Keep that input outside this checkout's `scratch/asar`.

```sh
node scripts/prepare_dot_validation.mjs /absolute/cache/verified-desktop-asar
npm run build:server
npm run build:browser
```

The script stages the candidate before replacing `scratch/asar`. It refuses an
existing different Desktop version or leftover staging/backup directory. Inspect
such leftovers before retrying. Do not use the ordinary `prepare:asar` or `build`
commands for this candidate: those select the legacy preparation path. Existing
repository dependencies must be available, including a host-Node-compatible
`better-sqlite3`; preparation removes the bundle's Electron-specific copy.

## Offline isolation and browser checks

Requirements: Linux with usable Bubblewrap user/PID/mount/network namespaces,
Python 3, Node available at `/usr/local/bin/node`, repository dependencies,
Playwright-compatible Chromium, and a real native Codex executable. `--deps`
points to the dependency directory containing `playwright-core`; `--chromium`
points to its executable and exposes that browser's containing directory read
only. `--codex` must be the native executable, not the shared-daemon proxy or a
launcher that depends on an unmounted installation. Each `--state` path must be
new and task-owned.

```sh
python3 scripts/dot-validation-sandbox.py isolation \
  --state /absolute/tmp/dot-isolation-run \
  --deps /absolute/cache/node_modules \
  --chromium /absolute/cache/chromium/chrome \
  --codex /absolute/cache/codex

python3 scripts/dot-validation-sandbox.py smoke \
  --state /absolute/tmp/dot-smoke-run \
  --deps /absolute/cache/node_modules \
  --chromium /absolute/cache/chromium/chrome \
  --codex /absolute/cache/codex
```

The launcher starts the whole candidate process tree inside a private namespace,
clears inherited environment variables, and supplies empty HOME/CODEX_HOME/XDG
directories. It mounts the checkout and dependencies read only, hides checkout
`.local` state, and provides no external network route or production credentials.
It does not connect to the existing daemon. Do not run the browser test directly
on the host, copy production credentials into these runs, or substitute a live
service URL.

Isolation checks establish a live host listener and verify it is unreachable,
check that production credential/runtime-socket locations are absent, and attempt
a repository write that must fail. Smoke adds real browser rendering, two tabs,
reload, and tab return with bidirectional IPC checks. Results are written to the
selected state directory: `isolation.json`, `smoke.json`, `server.log`, and PNGs.
The verified candidate reached the official sign-in screen in all four stages:
first tab, second tab, first-tab reload, and second-tab return. Each stage had
bidirectional application IPC, with no renderer page errors, while the browser
continued to report offline. Statsig network errors remained expected in the
network-isolated run; these were not renderer page errors. Isolation and source-version preservation checks
also passed. An offline login screen or successful IPC does not prove
authenticated Dot use.

## Read-only authenticated transport

The optional `CODEX_BROWSER_FETCH_RELAY_SOCKET` adapter sends GET requests
under `https://chatgpt.com/backend-api` through a private Unix socket. Its only
POST exception is the configuration read at exactly
`/backend-api/wham/statsig/bootstrap`: JSON with an optional charset, at most
1 MiB of unchanged body bytes, without query parameters or path aliases. The
official response supplies actual feature evaluations; no gates are overridden. Other
destinations retain the ordinary fetch path; operating-system network isolation
is therefore still required. Target mutations are rejected before transmission.
This is an experimental validation transport, not a general browser proxy.

`scripts/dot-browser-fetch-relay.cjs` requires an existing browser page at exactly
`https://chatgpt.com/backend-api/tbo/primary`, reachable through a private CDP Unix
socket. It does not provision a browser, navigate, solve challenges, read an auth
file, or refresh credentials. Keep the browser in a separately isolated process
tree with restricted egress. Neither CDP nor the relay socket should be public.
Create the sockets inside an owner-only directory and supervise both processes:

```sh
node scripts/dot-browser-fetch-relay.cjs \
  --cdp-socket /absolute/private/browser-cdp.sock \
  --listen-socket /absolute/private/fetch.sock

node scripts/dot-readonly-auth.cjs \
  --auth-file /absolute/existing/codex/auth.json \
  --listen-socket /absolute/private/auth.sock
```

The auth broker reads one existing unexpired access token and account ID into
memory. It does not copy the complete auth file, rotate credentials, or refresh
the token. Possession of its socket grants access to that token: mount it only
into the intended isolated validation process. An expired token fails explicitly.

Run the authenticated candidate in another supervised process:

```sh
python3 scripts/dot-cloud-validation.py \
  --state /absolute/tmp/dot-cloud-run \
  --deps /absolute/cache/node_modules \
  --chromium /absolute/cache/chromium/chrome \
  --codex /absolute/cache/codex \
  --relay-socket /absolute/private/fetch.sock \
  --auth-socket /absolute/private/auth.sock
```

This harness additionally requires OpenSSL for a temporary namespace-local TLS
certificate. Inside the namespace only, `chatgpt.com` resolves to its local HTTPS
relay so native workspace routing retains the real official origin. The host's
hosts file and trust store remain unchanged. The native CLI uses externally managed authentication in memory;
the adapter rejects credential refresh, account changes, task execution and
unapproved RPC methods. This CLI authentication interface is unstable and pinned
to the inspected `0.160.0` executable. Local configuration changes affect only the
temporary CODEX_HOME. Never point the wrapper at the shared daemon.

The relay preserves real HTTP status and streamed bytes, strips response headers
for browser-decoded compression, and cancels requests when consumers disconnect.
Redirects are deliberately rejected, including requested `follow`, rather than
forwarding credentials to another origin. Browser-side request leases expire
within approximately 16 seconds after CDP ownership is lost, even while waiting
for response headers, an SSE event, or a backpressure acknowledgment.

Observed cloud reads returned real JSON for primary Dot selection and account
eligibility. The native CLI completed an external-auth account read, and the Dot
activity stream returned an actual `snapshot` event over HTTP 200 SSE. The
official Statsig bootstrap returned HTTP 200. A subsequent isolated Desktop
run opened the real `/dots/<thread-id>` page with the existing Dot message
history and customization control, without sending a message. This establishes
authenticated page reading, not message sending or execution. Merely showing
`Loading…` is not acceptance. Opening an existing room can also attempt a
read-receipt POST, which this read-only transport intentionally rejects.

The validation runner uses visible onboarding controls when required. Cloud
onboarding writes remain rejected, so completion through the official local
error handling is not evidence that account-wide onboarding preferences changed.

The separate durable transport at `codex-cloud-backend.chatgpt.com` is outside
this relay's allowlist and cannot connect in the isolated harness. The observed
Dot history page still rendered. This result does not validate durable sessions
or justify opening an unrestricted WebSocket tunnel.

Visual acceptance remains limited: the Dot header showed a gray ring. Local
Orbit modules, worker, data and WASM loaded successfully; a canceled module
request was not a missing asset. External images were blocked without the
optional egress below. With that egress, inspected avatar PNGs decoded at
512×512 and the interactive iframe existed, but the ring remained. These
observations establish neither a missing local resource nor a default SVG
fallback, and do not prove parity with the native desktop's avatar appearance.
Browser console errors also included rejected telemetry; a readable page does
not mean all network requests or visual features passed.

After a run, stop the auth broker, relay and task-owned browser, verify no requests
or descendants remain, and check state artifacts for credential material without
printing it. An absent `auth.json` alone is insufficient to prove no token was
logged elsewhere.

## Optional fixed-room message validation

The default transport remains read-only. Set `CODEX_DOT_MESSAGE_ROOM_ID` on both
the relay and candidate server to enable only that existing room's `/messages`
and `/live` POST endpoints. Messages are limited to plain text with matching
request/idempotency IDs. Only the native `page_context` shape containing a single
`page_id` (null or a nonempty string) is accepted; attachments, other contextual
content and reply references are rejected. The live subscription accepts no body. Original security headers
and body bytes are preserved; the transport does not manufacture attestation.

The relay consumes each message request ID before contacting the browser.
Concurrent submissions, upstream failures and native authentication retries
cannot resend that ID during the relay process's lifetime. This ledger is not
durable: after a restart, investigate any unknown result through message history
instead of replaying the request. A failed connection is not proof of rejection.

The sandbox launcher accepts `--message-room-id`, `--message-text` and
`--expected-reply` for a deliberate single-message check. It first verifies the
selected existing room and that the Dot is not paused. It does not create a room,
resume a runtime, grant computer access or register an executor. A message can
still cause the cloud Dot to act; instructions requesting only an echo are not
a server-enforced tool restriction.

The authenticated check confirmed one new human message and the Dot's exact
requested reply in server history. Sender identity is matched against the room
creator and the member whose `aeon_id` matches the selected Dot: Dot messages can
have outer `role: "user"`, so that field alone cannot distinguish the authors.
The earlier rejected attempt never reached the upstream message endpoint; it
exposed the native `{page_id: null}` context shape now covered by the validator.

For a separate visual readback, use `--readback-marker` with the existing room.
It is mutually exclusive with `--message-text`: it waits for an existing exact
reply to become visible and captures a stable screenshot without sending again.
Server-history success alone does not prove the renderer finished loading.
A separate fresh readback displayed both the submitted message and exact Dot
reply after loading, with no input or send action. Native notification WebSocket
traffic was bidirectional, but this refresh-based check does not isolate live
notifications as the cause of the reply appearing.

An optional `--browser-egress-socket` preserves the renderer's native notification
WebSocket and image loading. Start `scripts/dot-browser-egress.cjs --listen-socket
<private-socket>` separately. Its CONNECT allowlist is limited to port 443 on
`ws.chatgpt.com`, `persistent.oaistatic.com`, `cdn.auth0.com` and
`sdmntprwestus.oaiusercontent.com`, through the validation HTTP proxy.
It rejects the main API host `chatgpt.com`. TLS terminates in the
browser: this restricts destinations, not encrypted requests or WebSocket frames.
No production browser or system proxy settings are changed.

## Cloud and executor acceptance boundaries

### Computer execution

- Codex CLI `0.160.0` accepted `exec-server --help`. This proves command
  availability only, not registration, headless cloud execution, or result return.
- Direct Node access encountered a Cloudflare challenge. A real isolated browser
  subsequently returned authenticated JSON without an interactive challenge.
  This difference does not require another account login. No schema, role, or
  entitlement overrides are used to manufacture access.
- Registration uses `POST /flora/cca/executor`. Its effect on existing computers
  remains unverified, and a precise registry cleanup path has not been established. Do not
  register against the active account until both are understood. Never use the
  unscoped `DELETE /flora/cca/executor` for experiment cleanup.
- The native client also defines a targeted Dot grant revocation:
  `POST /tbo/{tbo_id}/computers/{environment_id}/disconnect?expected_thread_id={thread_id}`,
  without retries. This disconnects one computer from that Dot; it does not prove
  that the underlying executor registration can be individually deleted.
- An offline probe of the unmodified native manager verified persistent
  installation identity, registration request construction and stopping only its
  own child. HTTP and process dependencies were substituted; no real executor
  became ready. This is local protocol evidence, not cloud registration proof.
- `selected_capability_roots` describes skills/plugins, not filesystem access
  permissions. Real execution requires operating-system isolation. Keep the
  local executor disabled for these offline checks; do not force
  `CODEX_TPP_LOCAL_EXECUTOR_ENABLED=1`, which defeats the normal UI disable path.
- Real Dot authorization, dispatched execution, result return, and revocation
  have not passed acceptance. Future authenticated checks must additionally
  prevent production credential refresh/rotation, preserve existing computer
  grants, and clean up only precisely identified experimental resources.

The sandbox owns and terminates its server/browser descendants. State directories
remain as evidence; remove only the directories created for these checks after
inspection. This workflow does not authorize replacing production assets,
restarting shared services, or claiming a completed cloud execution loop.
