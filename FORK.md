# Personal fork

Upstream: https://github.com/0xcaff/codex-web, baseline `0dfdc10768c724d9a6ba507a93c3d6314ef073d8` (Desktop 26.901.41123).

## Maintained changes

- Mobile sidebar overlays the conversation instead of shrinking it. Outside taps and Escape close it. Light and dark themes have opaque backgrounds.
- Disable Desktop MCP capability injection: a shared app-server does not run the Desktop MCP process. The frontend uses its dynamic-tools path instead, avoiding a partial `mcp_servers.codex_app` configuration with no transport.
- Expose native `create_thread` through dynamic tools for explicitly user-requested tasks. Its description excludes implicit authorization from planning, ticket splitting, implementation approval, or other agents. Other filtered tools remain unavailable; this is a prompt constraint, with no additional approval UI. Reuse native project, worktree, and initial-message behavior.
- Bound app-tool bridge waits and cancel pending responses when their browser disconnects. Capability discovery may try another ready browser; an uncertain dispatched call must not be replayed automatically. Preserve long `wait_threads` calls and avoid awaiting cancellation acknowledgements from an unavailable browser.
- Validate the default worktree ref before queueing creation. A repository without a resolvable commit returns an actionable error suggesting the local environment instead of inventing a `main` branch.
- Send an explicit `create_thread` prompt as the first user message, retaining its parent-task context. Tool-output-only first turns leave `first_user_message` empty and can leave otherwise completed tasks absent from the task list.
- Expose native `send_message_to_thread` in dynamic tool catalogs so an existing task can receive an authorized follow-up or continuation prompt. Preserve its host routing, current model/reasoning defaults, and native busy-thread behavior.
- Expose native `automation_update` in dynamic tool catalogs. Keep the native local-thread restriction, argument validation, and scheduling/approval behavior; exposing the tool does not create or enable any automation.
- Sidebar pagination shows a button while idle and a spinner only during a request. Automatic loading runs once per visible row count; a no-progress page requires a manual retry. New rows rearm automatic pagination.
- Catalog status reports sync failures independently of completion. Exhausted failed sources do not advertise more pages; cached cursors remain readable. The sidebar offers a separate sync retry and preserves loaded sessions.
- Keep generated server files and local runtime state out of Git.

## Shared daemon

Use the upstream `scripts/codex_remote_proxy` with `CODEX_UNIX_SOCKET` pointing to an already-running daemon and `CODEX_CLI_PATH` pointing to that script. The helper requires `websocat`. Run `node src/server/main.js --host 127.0.0.1 --port 8214` directly: the upstream `npm run server` script replaces `CODEX_CLI_PATH`.

The Web service owns connections only. Do not restart or replace the shared daemon when rebuilding the browser. Protect all HTTP and WebSocket paths with an authenticated reverse proxy or trusted tunnel; upstream exposes host file access and provides no authentication.

## Updating and checking

`npm run build:browser` builds the browser shim. `scripts/prepare_asar` reapplies the Desktop bundle patches after extraction. Patch filenames contain version-specific asset hashes; inspect every patch when updating Desktop. Keep the original extracted bundle for rollback and validate against it before replacing running assets.

Verify mobile sidebar opening/closing in both themes, existing thread history, shared-daemon connectivity and authentication after changes. Browser checks do not replace real Android keyboard, attachment, or reconnect tests. The separately deployed Android shell is not included in this repository.

Only wrapper source and small patches are maintained here; extracted Desktop bundles, credentials, runtime data and signing material are not committed.

## Pagination regression check

After extracting and patching the pinned Desktop bundle, run `node --test tests/sidebar-pagination.test.cjs tests/catalog-sync-state.test.cjs tests/catalog-page-state.test.cjs`. The tests exercise its actual pagination component and check both call sites. If the bundle changes, missing anchors intentionally fail and require review.

An incomplete cloud catalog is not necessarily another local page. An authenticated cloud fetch can fail (for example with HTTP 403) after the local catalog is complete. This fork does not pretend such a cloud catalog is complete or fix account access; it separates pagination from sync failure and offers a dedicated sync retry. The upstream five-minute cloud failure backoff remains in effect; an acknowledged retry does not mean synchronization succeeded. Failure stays visible until the server reports recovery.

## Local-only workspace

ChatGPT cloud capabilities (including inherited project/chat/cloud-automation entry points) are disabled in this fork. The catalog service also ignores ChatGPT source activation from older clients. Local app-server population, authentication, model access, and local pagination remain unchanged. `patches/local-only-catalog.patch` is applied last; run `node --test tests/local-only-catalog.test.cjs` after extraction. The sync-failure machinery above remains available for local failures; disabling cloud access does not claim that its permissions were repaired.

## Browser/server clock independence

Desktop RPC deadlines assume a shared wall clock. The browser bridge stamps each
outbound message at transmission; the server rebases `mcp-request` and
`thread-prewarm-start` deadlines from the remaining browser budget onto its own
clock. Browser queue time stays deducted and server queue expiry remains enabled.
Network transit is not measured; older cached clients fall back to their bounded
relative `timeoutMs`. No request is automatically replayed by this conversion.

Regression checks: `npm run build:server` then
`node --test tests/request-deadline.test.cjs`. Coverage includes both directions of
clock skew, expired browser queues, timeout caps, and cached clients.

## Browser viewport height

The Desktop shell has an inline `100vh` height. The browser shim overrides only
that shell with the Visual Viewport height (falling back to `100dvh`/innerHeight),
preserving Desktop CSS zoom. Browser chrome and keyboard resize events update
its height; pinch zoom keeps the existing layout so magnification still works.
When a focused composer overflows the home page's scrollable content, it is
scrolled into view, including its footer controls.

Browser regression: run `node tests/browser/viewport.cjs` against a local server.
Optional `PLAYWRIGHT_MODULE`, `CHROMIUM_PATH`, and `TEST_BASE_URL` select the test
installation and target. It simulates differing layout/visual viewport heights,
tablet/phone widths, CSS zoom and pinch zoom; it is not a physical Android test.

## Mobile sidebar hit testing

The mobile overlay must hide its entire subtree when the sidebar trigger reports
`aria-expanded=false`. Desktop route navigation may retain transparent sidebar
children; absolute positioning otherwise leaves the account button over the
composer's attachment button. Closed mobile panels now have hidden visibility
and disabled pointer events. A 44px close button stays at the viewport's upper
right while the drawer is open; desktop layout is unchanged.

`tests/browser/sidebar-touch.cjs` checks touch hit testing after navigating to an
existing thread, the actual attachment menu, close control, backdrop, and desktop
breakpoint. Set `TEST_THREAD_TITLE` to an existing thread title; it sends no turns.
It uses the same browser tool environment variables as the viewport test.

## Deliberate archive actions on touch screens

`src/browser/mobile-sidebar-actions.ts` makes the touch sidebar's English and
Chinese archive controls visible and reserves row space while retaining native icons and sizes.
Its CSS uses the existing theme layer to reveal Desktop's existing actions. A DOM dialog gates the original click; Cancel/Escape never replay it,
and confirmation replays it once only if the original button is still mounted.
Mouse-only desktop behavior is unchanged. `tests/browser/archive-touch.cjs` verifies target
visibility, native icon appearance and cancellation against existing rows without archiving them.

### Native projects and folder selection

The sidebar uses Desktop's native project tree and recent-chat list. Thread
working directories do not create synthetic workspace groups. On touch-primary devices without hover,
the original project creation and per-project menu controls stay visible. The project's hover-only action containers must also expand on
touch screens so their buttons are not clipped out of the row.

The browser bridge omits `showContextMenu`: the headless Electron shim cannot
display a native `Menu.popup`. Desktop therefore uses its existing accessible
web menus, preserving item callbacks and keyboard dismissal.

The browser shim handles both the legacy add-root message and
`electron-pick-workspace-root-option` with the host directory picker. Picking a
source emits `workspace-root-option-picked` back to the current project form;
it does not create or select a project. Cancel emits nothing. Additional folders
can be added by opening the picker again. Project creation remains with Desktop,
including its default working directory when the sources list is empty.

Checks: `node tests/browser/project-sources.cjs` and
`node tests/browser/project-actions.cjs` with the same Playwright
environment as other browser checks.

### Startup asset delivery

`build:browser` also prepares `scratch/webview-delivery` from the patched source.
The HTTP server prefers this overlay and falls back to the original webview for
other assets. The two main modules are compacted without renaming variables or
rewriting expressions; legal notices are retained. The overlay HTML preloads the
primary module so its download can overlap initial startup.

Every overlay file has matching identity, gzip and Brotli representations.
This matters with the static server's multiple-root fallback: a missing preferred
encoding can otherwise select the original asset. Unchanged builds retain file
mtimes and validators. Keep cache revalidation: upstream-looking filenames do
not change when this fork patches their contents, so immutable caching is unsafe.
Always rebuild browser delivery after changing patched webview files.

Validation: `node --test tests/delivery-module.test.cjs`, then with the server
running `node tests/browser/delivery-headers.cjs` and the existing sidebar tests.
For browser timing, Playwright `httpCredentials` disables cache through request
interception. Its repeated navigations are not warm-cache measurements; remove
that hook after browser authentication and explicitly enable cache for a warm
comparison. Preserve a separate cold-load comparison.

### Touch scrolling over sortable sidebar rows

Desktop sortable wrappers use `touch-none`, including rows whose drag sensor is
inactive. The mobile sidebar overrides these wrappers with `pan-y pinch-zoom`,
so native vertical scrolling cancels pointer dragging. Stationary long presses
retain the original context menu. Desktop drag styling stays unchanged.

`node tests/browser/sidebar-scroll.cjs` sends actual Chromium touch input over
existing rows, both immediately and after a 350ms hold, and checks scroll offset,
absence of accidental menus, touch context-menu events and desktop behavior. It temporarily constrains the scroll
viewport to work with short catalogs; it does not change stored chats. The usual
browser environment variables apply; `TEST_AUTH_FILE` optionally supplies a Basic
password from a local file (with `TEST_AUTH_USER`, default `codex`).

### Conversation history previews

The browser caps each turn's ordinary paginated history preview at 50 items.
This bounds serial item reads while opening a long conversation or paging older
turns. Existing item cursors, opening user input, and load-more behavior retain
access to the rest of each turn. Metadata-only queries and live reconciliation
keep their original behavior. This does not change durable or legacy history.

`node --test tests/thread-history-pagination.test.cjs` exercises the patched
bundle pagination against long and short histories, including cursor continuation.

### Created tasks in conversation summaries

`patches/webview-created-task-links.patch` restores the summary's created-task
links from successful native `codex_app.create_thread` receipts using complete
`thread/turns/list` and `thread/items/list` pagination, independently of the
50-item transcript preview. The original five-row limit remains. No links are
inferred from prose, and no extra relationship database is maintained.

The reader belongs to the current conversation route and host manager. It clears
results and invalidates pending reads on authentication changes or unmount;
existing in-memory receipts are fenced until durable history confirms access.
Host IDs are retained for deduplication, status reads and native navigation.
Queued worktree IDs keep the native client-to-thread mapping. A failed history
read keeps unverified links hidden; re-entering the route or an authentication
event retries the read.

Run `node --test tests/created-task-history.test.cjs` for receipt filtering,
pagination, ordering, auth isolation, lifecycle cleanup and host navigation.
Rebuild browser assets to update the compressed delivery overlay.

### Browser event telemetry

`patches/webview-disable-event-telemetry.patch` disables Statsig event logging
in the Web client. Event registration requests can receive an upstream HTTP 403
challenge page, causing repeated networking and batch-flush errors. Configuration
fetches, live-value refresh and the override adapter remain enabled.

The bundled SDK otherwise stores events while logging is disabled and starts a
coordinator that can retry previously saved batches. The patch makes disabled
logging skip event collection, non-exposure counts and logger startup as well.
Existing saved events are left untouched but are not replayed while disabled.
This does not suppress console errors or alter chat, model or authentication
requests. Run `node --test tests/statsig-telemetry.test.cjs` and rebuild browser
assets after applying the patch so the compressed delivery overlay is updated.

### Native browser capability

The Web bridge does not implement Electron's native browser surface. Advertising
`browser.in-app` lets users open an empty pane and causes native window geometry
requests to fail. `patches/webview-disable-native-browser.patch` resolves that
capability as unavailable before consulting Desktop policy or daemon config.
Desktop's existing availability checks then hide the launcher, skip saved native
browser tabs, and disable its native browser agent UI. Other capabilities and the
daemon configuration are unchanged; ordinary web URLs use the external browser
path. This does not add embedded browsing or local HTML preview support.

Keep the capability tree intact: an empty `supportedClients` list is rejected
during registration. Run `node --test tests/browser-capability.test.cjs` and
`npm run build:browser` after applying the patch to update compressed delivery.
For the UI check, set `TEST_THREAD_NAME` to an existing chat title and run
`node tests/browser/native-browser-disabled.cjs` with the browser environment
variables above. It checks the launcher and an external-link popup through the
real preload bridge, using a synthetic destination response; it does not test
third-party website availability.

The preload shim consumes HTTP(S) `open-in-browser` messages after opening the
client tab. They must not fall through to `invokeMain`: Desktop's independent
main-process feature flags can still route them into native browser surfaces or
link-destination prompts. Non-web protocol dispatch keeps its existing behavior.
The bridge regression includes default markdown intent and explicit native-tab
requests; the browser check also verifies no native IPC and usable original UI.

### Tablet touch interaction

Input adaptations use `(hover: none) and (pointer: coarse)` independently of
the sidebar layout breakpoint. A mouse-primary desktop does not opt in merely
because it also has a touchscreen. Tablets retain the two-pane layout while the
original project and chat creation controls stay visible with their native styling.
Touch rows pan natively; `webview-touch-sidebar.patch` only disables sidebar touch
drag activation. The original stationary long-press menus, mouse drag and right-click
remain available. The patch is tied to the pinned Desktop bundle and must be
rechecked when upgrading it.

The folder picker adapts to the visible height without adding controls or changing
single-click selection and double-click navigation. Composer controls retain their
native styling. Validate with `tests/browser/sidebar-scroll.cjs` (phone/tablet
swipes, original context-menu events, mouse) and `tests/browser/project-sources.cjs`
(including short landscape viewports). These browser touch simulations do not
replace testing physical tablet gestures.

Large automatic diff previews additionally require a hover-capable, non-coarse
primary pointer. `webview-touch-diff-preview.patch` disables only this tooltip
when `(hover: none), (pointer: coarse)` matches, including wide landscape tablets;
the original file click and Review controls remain available. Media changes update
the mounted component and dismiss any preview. Mouse-primary hybrid devices retain
hover previews. Run `node --test tests/touch-diff-preview.test.cjs` after preparing
the pinned Desktop assets to verify disabled rendering, native click preservation,
mouse configuration, input changes and subscription cleanup.

### Browser file downloads

`webview-file-download.patch` intercepts the native open-in helper through
`__ELECTRON_SHIM__.downloadLocalFile`. Local archive and installer links download
through `/__backend/download?path=...`. The authenticated page fetches the bytes
before saving a Blob URL so an external download handler does not need to
repeat an authenticated server request. Failed HTTP responses are shown as errors
instead of being saved as files. Source, image and document previews retain
their existing behavior. Remote host requests are not mapped onto local files.
The route streams regular files as attachments with UTF-8 filenames and uses the
same deployment authentication boundary as `/@fs/`; keep it behind that boundary.
Recheck the helper patch when upgrading Desktop bundles. Relevant checks are
`tests/browser-downloads.test.cjs` and `tests/download.test.cjs`.

### Quota interruption recovery

The account menu's “继续中断任务” action lists terminal quota and HTTP 429
failures and sends an explicit continuation message to selected tasks.
The “换号后自动继续中断任务” setting defaults to off and continues
quota-interrupted tasks after the connection confirms a different authenticated
account. It also continues after reauthentication with the same account when a
confirmed exhausted allowance before reauthentication becomes usable afterward.
The post-authentication quota read must match the account, explicitly allow ordinary
usage, and show no exhausted usage window. Missing or unknown quota data does not
trigger recovery. Initial connection and quota polling alone do not trigger it.
Automatic discovery walks all unarchived interactive history pages, including
tasks that have not been opened in the browser.

The independent “429 后自动继续” setting also defaults to off. After a terminal
rate-limit failure it waits 30, 60, then 120 seconds before sending a continuation
message. The consecutive retry limit defaults to 3 and is configurable in the
dialog; 0 means unlimited. Further retries wait 120 seconds each. Changing the
limit preserves the used count; increasing it can resume budget-exhausted pending
entries, while lowering it blocks sends beyond the new limit. Each message
starts a new turn; this does not change Codex's internal request retries. Native
retries still in progress and quota exhaustion are excluded. Retry counts persist
across restarts and toggling the setting; one successfully completed turn resets
the count immediately, and a manually started turn starts a new retry sequence.
Turning the setting off cancels pending automatic sends. Unknown delivery is
never automatically replayed.

The manual list request checks the 100 most recently updated unarchived interactive
threads. Settings are shared across tabs and persist alongside the queue in
`$CODEX_HOME/codex-web-quota-recovery.json.settings.json`. Closing the dialog does
not disable automatic recovery; turn it off with its checkbox.
The dialog hides resumed and skipped records; the server retains them for
deduplication. Sending and uncertain results remain visible until resolved.

`src/server/quota-recovery.ts` owns the shared queue, persisted to
`$CODEX_HOME/codex-web-quota-recovery.json` (default `~/.codex`). The main-process
patch registers each host connection; browser tabs share one dispatch guard.
Before sending, it checks archive state, latest failed turn, direct-input support
and live notifications. The original model and permission settings are inherited.
These checks are not an atomic server-side lock against a simultaneous manual send.

Unknown delivery results are never retried automatically; refresh reconciles them
only when the unique client message ID appears in history. A crash during dispatch
also becomes unknown. A new quota failure pauses the remaining batch when observed.
The menu and main-process patches must be reapplied on Desktop bundle upgrades.
Validate with `npm run build:server`,
`node --test tests/quota-recovery.test.cjs tests/quota-account-hook.test.cjs tests/rate-limit-recovery.test.cjs`
and `npm run build:browser`.

## Embedded web and HTML viewing

Ordinary HTTP(S) links open a Web-owned browser dialog. Its address field,
back/forward history and reload control navigate panel-requested pages; explicit
external-browser and modified/new-tab actions retain browser tab behavior.
Websites can reject embedding with CSP/X-Frame-Options, and sandboxed sites may
need the always-visible external-open action for login or other capabilities.
An iframe load event does not prove that a third-party page rendered. Navigation
inside cross-origin frames cannot reliably update the panel address/history.
The panel is not a complete browser replacement and does not embed Codex itself.

Local `.html`/`.htm` links without line references open an isolated HTML preview.
The initial file retains native source viewing and the existing download route.
A short-lived capability serves only its canonical directory, including relative
styles, scripts, images and linked HTML pages. Symlinks outside that directory
are rejected. Script-driven navigation is not reflected in the dialog history;
normal HTML links are. Network calls, remote resources, forms and nested frames
are disabled in local previews. Generated attachments without an HTML extension
keep their existing file behavior.

Preview responses and iframes use sandboxing without same-origin permission.
Cross-site/opaque-origin requests cannot reach application routes or the IPC
WebSocket, and raw `/@fs/` HTML responses are sandboxed too. Intentional top-level
GET navigation to the app root or thread pages remains available from external
links; filesystem and API routes receive no such exception. Vite proxies retain
the browser Host so same-origin validation works in development.
This does not provide Desktop's Electron
browser surface, browser-use automation, a remote-site proxy or embedding-policy
bypass. `upstream/browser-use` implements a different native browser integration
and is not required by this path.

Checks: `npm run build:server`, `node --test tests/browser-preview.test.cjs
tests/browser-isolation.test.cjs tests/browser-link-routing.test.cjs
tests/download.test.cjs`, and the actual-browser check
`tests/browser/native-browser-disabled.cjs` after `npm run build:browser`.

### Browser IPC compression

The IPC WebSocket negotiates per-message deflate for large native RPC snapshots.
Both directions reset the compression dictionary between messages; small outbound
messages skip compression and clients without extension support keep the plain transport.
Origin checks, one-use voice tokens and the decompressed message-size limit still
apply. `node --test tests/ipc-compression.test.cjs` checks negotiation, plain-client
fallback, byte-preserving delivery and message ordering over real WebSockets.

Web voice startup keeps the native 30-second preparation deadline and allows
30 seconds for connection after the renderer is ready, including thread creation
and WebRTC setup over the browser IPC transport. The bridge is detected when
startup begins; Desktop retains its 10-second connection deadline. Cancellation,
timeout cleanup and successful-start timer removal remain unchanged. Controller
checks are in `tests/realtime-voice.test.cjs`; actual audio still requires browser
acceptance against the running service.

Voice navigation from the browser overlay is directed to its launching tab using
the server-side owner binding. If that owner window has gone away, the request is
dropped rather than sent to another tab. Native and non-voice navigation retain
the existing primary-window behavior. Owner bindings are removed with the overlay;
closed renderers cannot submit trusted IPC messages.

The browser window adapter stores content bounds using the same rectangle as its
outer bounds: there is no native window frame. Native avatar layout reads and
updates this rectangle when voice is opened again after a previous presentation.
`tests/realtime-voice.test.cjs` executes the native layout setter against the real
adapter to catch missing geometry methods.
