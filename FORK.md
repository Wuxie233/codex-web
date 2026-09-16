# Personal fork

Upstream: https://github.com/0xcaff/codex-web, baseline `0dfdc10768c724d9a6ba507a93c3d6314ef073d8` (Desktop 26.901.41123).

## Maintained changes

- Mobile sidebar overlays the conversation instead of shrinking it. Outside taps and Escape close it. Light and dark themes have opaque backgrounds.
- Disable Desktop MCP capability injection: a shared app-server does not run the Desktop MCP process. The frontend uses its dynamic-tools path instead, avoiding a partial `mcp_servers.codex_app` configuration with no transport.
- Keep generated server files and local runtime state out of Git.

## Shared daemon

Use the upstream `scripts/codex_remote_proxy` with `CODEX_UNIX_SOCKET` pointing to an already-running daemon and `CODEX_CLI_PATH` pointing to that script. The helper requires `websocat`. Run `node src/server/main.js --host 127.0.0.1 --port 8214` directly: the upstream `npm run server` script replaces `CODEX_CLI_PATH`.

The Web service owns connections only. Do not restart or replace the shared daemon when rebuilding the browser. Protect all HTTP and WebSocket paths with an authenticated reverse proxy or trusted tunnel; upstream exposes host file access and provides no authentication.

## Updating and checking

`npm run build:browser` builds the browser shim. `scripts/prepare_asar` reapplies the Desktop bundle patches after extraction. Patch filenames contain version-specific asset hashes; inspect every patch when updating Desktop. Keep the original extracted bundle for rollback and validate against it before replacing running assets.

Verify mobile sidebar opening/closing in both themes, existing thread history, shared-daemon connectivity and authentication after changes. Browser checks do not replace real Android keyboard, attachment, or reconnect tests. The separately deployed Android shell is not included in this repository.

Only wrapper source and small patches are maintained here; extracted Desktop bundles, credentials, runtime data and signing material are not committed.
