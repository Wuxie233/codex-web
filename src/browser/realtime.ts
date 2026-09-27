export type RealtimeWindowMessage =
  | { type: "realtime-window-open"; token: string }
  | { type: "realtime-window-close"; token: string };

export const realtimeToken =
  window.location.pathname === "/avatar-overlay"
    ? new URLSearchParams(window.location.hash.slice(1)).get("realtimeToken")
    : null;

const frames = new Map<string, HTMLIFrameElement>();
const disposeEvent = "codex-realtime-dispose";

function removeFrame(frame: HTMLIFrameElement | undefined): void {
  if (!frame) return;
  frame.contentWindow?.dispatchEvent(new Event(disposeEvent));
  frame.remove();
}

export function handleRealtimeWindowMessage(
  message: RealtimeWindowMessage,
): void {
  if (message.type === "realtime-window-close") {
    removeFrame(frames.get(message.token));
    frames.delete(message.token);
    return;
  }
  if (realtimeToken || frames.has(message.token)) return;
  const frame = document.createElement("iframe");
  frame.src = `/avatar-overlay#${new URLSearchParams({ realtimeToken: message.token })}`;
  frame.allow = "microphone; autoplay";
  frame.title = "Realtime voice";
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  // Keep the native renderer running, without covering the conversation controls.
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;pointer-events:none";
  frames.set(message.token, frame);
  document.documentElement.append(frame);
}

export function closeRealtimeWindows(): void {
  for (const frame of frames.values()) removeFrame(frame);
  frames.clear();
}

/** Bound media resources to this disposable voice renderer, including late captures. */
export function installRealtimeMediaCleanup(): () => void {
  const streams = new Set<MediaStream>();
  const resources = new Set<RTCPeerConnection | AudioContext>();
  let closed = false;
  const closedError = () => new DOMException("Voice renderer closed", "AbortError");
  const stopStream = (stream: MediaStream) => {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Continue releasing the remaining resources if one track fails.
      }
    }
  };
  const closeResource = (resource: RTCPeerConnection | AudioContext) => {
    try {
      Promise.resolve(resource.close()).catch(() => {});
    } catch {
      // A disposed native resource must not prevent cleanup of its siblings.
    }
  };
  const trackConstructor = <
    T extends typeof RTCPeerConnection | typeof AudioContext,
  >(constructor: T): T =>
    new Proxy(constructor, {
      construct(target, args, newTarget) {
        if (closed) throw closedError();
        const resource = Reflect.construct(target, args, newTarget);
        resources.add(resource);
        return resource;
      },
    });
  if (window.RTCPeerConnection)
    window.RTCPeerConnection = trackConstructor(window.RTCPeerConnection);
  if (window.AudioContext)
    window.AudioContext = trackConstructor(window.AudioContext);
  const audioWindow = window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  };
  if (audioWindow.webkitAudioContext)
    audioWindow.webkitAudioContext = trackConstructor(
      audioWindow.webkitAudioContext,
    );

  const media = navigator.mediaDevices;
  const capture = media?.getUserMedia.bind(media);
  if (media && capture)
    media.getUserMedia = async (constraints) => {
      if (closed) throw closedError();
      const stream = await capture(constraints);
      if (closed) {
        stopStream(stream);
        throw closedError();
      }
      streams.add(stream);
      return stream;
    };
  const dispose = () => {
    if (closed) return;
    closed = true;
    for (const stream of streams) stopStream(stream);
    streams.clear();
    for (const resource of resources) closeResource(resource);
    resources.clear();
  };
  window.addEventListener("pagehide", dispose, { once: true });
  window.addEventListener("unload", dispose, { once: true });
  window.addEventListener(disposeEvent, dispose, { once: true });
  return dispose;
}
