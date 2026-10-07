# architecture

a bit on how this whole thing is put together.

the general approach here is to download the electron app, unpack it and apply
as small a set of patches to it as possible to get it working.

an electron app has two parts, a part which runs in the main process and a part
which runs in the renderer process.

the main process part is basically a node process with a `require('electron')`
dependency. it runs even before anything is visible on the screen, setting up
the system tray widget, running background tasks and hooking up listeners for
app launcher events. there is a single instance of the main process regardless
of how many windows are open.

the ui runs inside an electron renderer process. in the desktop app, this looks
sorta like a browser with some modifications to the browser's chrome. it handles
displaying the interface, reacting to events from user interaction and holding
onto state which lives close to the ui (what text is in the prompt box for
example).

the electron renderer process usually launched by the electron main process. the
main process and render process communicate via an IPC setup in a [preload
script]. the preload script is injected into the renderer process before
anything else loads, has privileged access and can expose functions and data to
the renderer realm through `contextBridge.exposeInMainWorld`. the preload script
has access to [`ipcRenderer`].

codex-web hooks the preload script by providing [shim.ts](./src/browser/shim.ts)
as a stand-in for electron in the renderer process and then setting up preload
to run in the renderer realm (see
[vite.browser.config.ts](./vite.browser.config.ts)).

next, we apply a series of patches to both code running in the main process and
the renderer process. these are applied at postinstall time through the
[`prepare_asar`](./scripts/prepare_asar) script. patches are located
in [./patches](./patches) and applied ontop of the prettified code extracted
from the upstream app. care was taken here to patch at installation time to
avoid redistributing the original code.
the [./patches/webview-preload.patch](patches/webview-preload.patch) connects
the shimmed preload script to the index.html entrypoint.

we aim for the patches to be as small as possible as they're the most annoying
part to change. the patches today are mostly around routing, urls, page title,
pwa and mobile behavior.

to connect the ipc from the renderer process to the main process, we use a
websocket for most messages intercepting and handing a small handful of messages
directly (file picker, workspace picker). today, the remaining parts of shim are
for connecting the in memory router to the browser history and setting up the
sidebar behavior on mobile.

the ipc websocket is hosted by [main.ts](./src/server/main.ts). this process
binds a port and listens for incoming websocket connections. it also shims
electron (see `installModuleAliasHook`) before loading the electron shell
entrypoint. the shims are located in
[./src/server/electron](./src/server/electron) and focus on providing the
minimum amount of functionality needed to make the app work. this comes down to
some network transport to the outside world and hooking up to the ipc pipe from
the renderer. this part is the most sloppy part of the codebase as i left codex
to figure it out unattended. the parts around `__codexElectronIpcBridge` are the
important bits related to wiring up the ipc bridge.

[preload script]: https://www.electronjs.org/docs/latest/tutorial/tutorial-preload
[`ipcRenderer`]: https://www.electronjs.org/docs/latest/api/ipc-renderer

## Inline visualizations

Desktop inline visualizations use an Electron `webview` and the `codex-sandbox`
protocol, which browsers cannot run. The visualization patch routes only these
previews through `src/browser/visualization-sandbox.ts`, retaining the upstream
HTML wrapper, sizing, theme updates, and host capability handlers.

The browser adapter uses a `srcdoc` iframe with `sandbox="allow-scripts"` and an
opaque origin. Its CSP restricts resources to the upstream visualization policy
and blocks network connections, nested frames, and form submissions. A dedicated
MessageChannel is transferred only after checking the frame's window and origin;
host tool calls still pass through the upstream allowlist and authorization.
Abort, initialization timeout, and teardown dispose the frame and its ports.
After Desktop upgrades, verify an inline preview in a real browser, including
interaction, resizing, and navigation away and back.

## Browser configuration readiness

Composer configuration and model eligibility reads must not wait behind background
catalog work. The Fast-mode loading patch prioritizes those reads while preserving
server eligibility decisions. The composer recovery patch cancels a queued submit
on configuration failure or after 20 seconds, retaining the draft for manual retry.
It does not retry message delivery or replay a canceled submit after a late reply.

Quota recovery lists return a bounded snapshot while history discovery continues.
Browser polling passes `refresh: false` through IPC so reading progress does not
start another scan. Explicit refresh starts discovery; resume rechecks eligibility
before sending and keeps uncertain delivery results separate from retryable failures.

## Realtime voice renderers

Desktop realtime voice runs in a separate `/avatar-overlay` renderer. The Web
bridge hosts that renderer in an offscreen iframe owned by the tab that started
voice. A single-use random token binds its WebSocket to the existing native window;
renderer IDs are never accepted from the client. Keep IPC directed to each window,
including during startup, and reject another tab's start while ownership is reserved.

The native runtime still owns WebRTC, voice controls, and app-server requests.
Cancel, timeout, end, and owner disconnect dispose the child window and IPC ports.
The browser also closes its peer connections and audio contexts, stops microphone
tracks, and stops any capture that resolves after disposal. An ended renderer is
not reused by a later session or another tab.

The Web shim selects Desktop's existing animated Canvas voice renderer. The WebGL
path can stall the browser event loop long enough to time out voice startup.
This choice changes only the voice visualization, not its audio transport.
After upgrading Desktop, revalidate both realtime patches and run
`node --test tests/realtime-voice.test.cjs tests/realtime-media.test.cjs`.
Browser checks should use the default autoplay policy and cover microphone denial,
cancel, end, reentry, tab isolation, and actual inbound/outbound media. Simulated
microphone tests do not establish physical-device or mobile-browser acceptance.

## Mobile connection recovery

The browser probes IPC transport health on foreground/online return and while
visible. Missing replies expire after 4 seconds; connection attempts after
8 seconds. Hidden pages defer retries until return. Resumable pages keep their
renderer and MessagePorts for up to one hour after transport loss. Server events
are replayed from the browser's last received sequence before queued work resumes.
Client messages also carry a sequence: the server confirms receipt and suppresses
duplicates, so only messages beyond its confirmed receipt boundary are resent.
See `FORK.md` for replay limits and compatibility. Expired or unavailable sessions
still require a reload; legacy recovery uses `recoveryProbe=1` without allocating
a throwaway renderer. Never replay uncertain writes into a new renderer.
Verify with `node --test tests/connection-recovery.test.cjs` and a real mobile
background/foreground cycle; simulated timers do not establish device latency.
