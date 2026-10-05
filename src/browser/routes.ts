export function mapBrowserPathToInitialRoute(
  pathname: string,
  search: string,
  hash = "",
) {
  if (pathname === "/share/receive" && search) {
    const params = new URLSearchParams(search);

    const prompt = ["title", "text", "url"]
      .flatMap((name) => {
        const value = params.get(name);
        return value === null ? [] : [`${name}: ${value}`];
      })
      .join("\n");

    return {
      memoryPath: prompt
        ? `/?${new URLSearchParams({ prompt }).toString()}`
        : "/",
      browserPath: "/",
    };
  }

  return {
    memoryPath: `${mapBrowserPathToRoute(pathname)}${search}${hash}`,
  };
}

function mapBrowserPathToRoute(pathname: string): string {
  const match = pathname.match(/^\/thread\/([^/]+)$/);
  if (match) {
    try {
      return `/local/${decodeURIComponent(match[1])}`;
    } catch {
      return "/";
    }
  }

  return pathname;
}

export function mapMemoryPathToBrowserPath(
  pathname: string,
  search = "",
  hash = "",
) {
  if (pathname === "/") {
    return { path: `/${search}${hash}`, titleChange: "ChatGPT" };
  }

  const match = pathname.match(/^\/local\/([^/?#]+)$/);
  if (!match) {
    return { path: `${pathname}${search}${hash}` };
  }

  return { path: `/thread/${encodeURIComponent(match[1])}${search}${hash}` };
}

export function dispatchNavigateToRoute(path: string): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "navigate-to-route",
        path,
      },
    }),
  );
}

window.addEventListener("popstate", () => {
  dispatchNavigateToRoute(
    mapBrowserPathToInitialRoute(
      window.location.pathname,
      window.location.search,
      window.location.hash,
    ).memoryPath,
  );
});
