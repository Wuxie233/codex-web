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

## Cloud and executor acceptance boundaries

- Codex CLI `0.160.0` accepted `exec-server --help`. This proves command
  availability only, not registration, headless cloud execution, or result return.
- A direct cloud read returned HTTP 403 with an HTML response. That response does
  not establish account eligibility or prove the absence of the feature. No
  schema, role, or entitlement overrides are used to manufacture access.
- Registration uses `POST /flora/cca/executor`. Its effect on existing computers
  remains unverified, and a precise cleanup path has not been established. Do not
  register against the active account until both are understood. Never use the
  unscoped `DELETE /flora/cca/executor` for experiment cleanup.
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
