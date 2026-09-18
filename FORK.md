# Personal fork

Upstream: https://github.com/0xcaff/codex-web, baseline `0dfdc10768c724d9a6ba507a93c3d6314ef073d8` (Desktop 26.901.41123).

## Maintained changes

- Mobile sidebar overlays the conversation instead of shrinking it. Outside taps and Escape close it. Light and dark themes have opaque backgrounds.
- Disable Desktop MCP capability injection: a shared app-server does not run the Desktop MCP process. The frontend uses its dynamic-tools path instead, avoiding a partial `mcp_servers.codex_app` configuration with no transport.
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

`src/browser/mobile-sidebar-actions.ts` makes the mobile sidebar's English and
Chinese archive controls visible, reserves row space, and uses 44px targets.
Its CSS uses the existing theme layer to override Desktop's important utility
sizes. A DOM dialog gates the original click; Cancel/Escape never replay it,
and confirmation replays it once only if the original button is still mounted.
Desktop behavior is unchanged. `tests/browser/archive-touch.cjs` verifies target
visibility/size and cancellation against existing rows without archiving them.

### Native projects and folder selection

The sidebar uses Desktop's native project tree and recent-chat list. Thread
working directories do not create synthetic workspace groups. On narrow screens,
the project creation control stays visible and has a 44px touch target.

The browser shim handles both the legacy add-root message and
`electron-pick-workspace-root-option` with the host directory picker. Picking a
source emits `workspace-root-option-picked` back to the current project form;
it does not create or select a project. Cancel emits nothing. Additional folders
can be added by opening the picker again. Project creation remains with Desktop,
including its default working directory when the sources list is empty.

Checks: `node tests/browser/project-sources.cjs` with the same Playwright
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
