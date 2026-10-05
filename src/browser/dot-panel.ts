export interface DotPanelOptions {
  /** Explicit, independently hosted Dot application URL. No URL means no entry. */
  url?: string;
  onOpen?: () => void;
}

export interface DotPanelHooks {
  mountNavigation(element: HTMLElement | null): (() => void) | undefined;
  mountContent(element: HTMLElement | null): (() => void) | undefined;
  onHostNavigation(): void;
}

export function installDotPanel({
  url,
  onOpen,
}: DotPanelOptions): DotPanelHooks {
  const navigation = new Set<HTMLButtonElement>();
  const contents = new Set<HTMLElement>();
  const originalStates = new Map<
    HTMLElement,
    { visibility: string; inert: boolean }
  >();
  const restoreOriginal = (element: HTMLElement) => {
    const state = originalStates.get(element);
    if (!state) return;
    element.style.visibility = state.visibility;
    element.inert = state.inert;
    originalStates.delete(element);
  };
  let active = false;
  let returnFocus: HTMLElement | null = null;
  const destination = url ? new URL(url) : null;
  if (
    destination &&
    (!/^https?:$/.test(destination.protocol) ||
      destination.origin === window.location.origin ||
      destination.username ||
      destination.password)
  ) {
    throw new Error(
      "Dot panel requires an independently hosted HTTP(S) URL without credentials",
    );
  }

  const render = () => {
    for (const button of navigation) {
      button.setAttribute("aria-pressed", String(active));
      button.classList.toggle("bg-token-sidebar-item-hover", active);
    }
    for (const container of contents) {
      const original = container.querySelector<HTMLElement>(
        ":scope > [data-dot-original-content]",
      );
      if (original) {
        if (active) {
          if (!originalStates.has(original)) {
            originalStates.set(original, {
              visibility: original.style.visibility,
              inert: original.inert,
            });
          }
          original.style.visibility = "hidden";
          original.inert = true;
        } else restoreOriginal(original);
      }
      let frame = container.querySelector<HTMLIFrameElement>(
        ":scope > iframe[data-dot-panel]",
      );
      if (active && !frame && destination) {
        frame = document.createElement("iframe");
        frame.dataset.dotPanel = "";
        frame.title = "Dot";
        frame.src = destination.href;
        frame.style.cssText =
          "position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--color-token-main-surface-primary,white)";
        container.appendChild(frame);
      }
      if (frame) frame.hidden = !active;
    }
  };

  const close = (restoreFocus = true) => {
    if (!active) return;
    active = false;
    render();
    if (restoreFocus && returnFocus?.isConnected)
      returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  };

  return {
    mountNavigation(element) {
      if (!element || !destination) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "sidebar-item flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-token-text-primary hover:bg-token-sidebar-item-hover";
      button.textContent = "Dot";
      button.setAttribute("aria-label", "Dot");
      button.addEventListener("click", () => {
        if (active) return close();
        returnFocus =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        active = true;
        render();
        onOpen?.();
      });
      element.appendChild(button);
      navigation.add(button);
      render();
      return () => {
        navigation.delete(button);
        button.remove();
      };
    },
    mountContent(element) {
      if (!element || !destination) return;
      contents.add(element);
      render();
      return () => {
        contents.delete(element);
        const original = element.querySelector<HTMLElement>(
          ":scope > [data-dot-original-content]",
        );
        if (original) restoreOriginal(original);
        element.querySelector(":scope > iframe[data-dot-panel]")?.remove();
      };
    },
    onHostNavigation: () => close(false),
  };
}
