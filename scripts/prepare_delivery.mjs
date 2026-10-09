// Keep patchable upstream sources separate from optimized HTTP delivery files.
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { compactModule } from "./delivery-module.mjs";

const source = path.resolve("scratch/asar/webview");
const output = path.resolve("scratch/webview-delivery");
await fs.mkdir(path.join(output, "assets"), { recursive: true });
async function writeChanged(file, bytes) {
  const previous = await fs.readFile(file).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (previous?.equals(bytes)) return;
  await fs.writeFile(file + ".tmp", bytes);
  await fs.rename(file + ".tmp", file);
}
const assets = await fs.readdir(path.join(source, "assets"));
const modules = assets.filter((name) =>
  /^app-(initial|primary)-[a-f0-9]+\.js$/.test(name),
);
if (
  modules.length !== 2 ||
  modules.filter((name) => name.startsWith("app-primary-")).length !== 1
)
  throw new Error(
    "Expected exactly one initial and primary application module",
  );
// These resources are required by every startup, including warm reloads.
const startupModules = assets.filter((name) =>
  /^(rpc|app-main|authed-route|home-composer-route)-[a-f0-9]+\.js$/.test(name),
);
const styles = assets.filter((name) =>
  /^app-(initial|primary)-[a-f0-9]+\.css$/.test(name),
);
// Lazy route chunks and locale packs also block the first usable screen.
const names = assets.filter((name) => /\.(js|css)$/.test(name));
for (const name of names) {
  const input = await fs.readFile(path.join(source, "assets", name), "utf8");
  const bytes = Buffer.from(
    modules.includes(name) || name === "preload.js"
      ? await compactModule(name, input)
      : input,
  );
  await writeChanged(path.join(output, "assets", name), bytes);
  await writeChanged(
    path.join(output, "assets", name + ".gz"),
    gzipSync(bytes, { level: 9 }),
  );
  await writeChanged(
    path.join(output, "assets", name + ".br"),
    brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
    }),
  );
  if (modules.includes(name) || name === "preload.js")
    console.log(
      `${name}: ${Buffer.byteLength(input)} -> ${bytes.length} bytes`,
    );
}
console.log(`Prepared ${names.length} JavaScript and CSS assets`);
let html = await fs.readFile(path.join(source, "index.html"), "utf8");
const primary = modules.find((name) => name.startsWith("app-primary-"));
html = html.replace(
  "</head>",
  [
    ...[primary, ...startupModules].map(
      (name) => `  <link rel="modulepreload" href="./assets/${name}" />`,
    ),
    ...styles
      .filter((name) => name.startsWith("app-primary-"))
      .map(
        (name) =>
          `  <link rel="preload" as="style" crossorigin href="./assets/${name}" />`,
      ),
    "</head>",
  ].join("\n"),
);
await writeChanged(path.join(output, "index.html"), Buffer.from(html));
await writeChanged(
  path.join(output, "index.html.gz"),
  gzipSync(Buffer.from(html), { level: 9 }),
);
await writeChanged(
  path.join(output, "index.html.br"),
  brotliCompressSync(Buffer.from(html)),
);
// Discard artifacts from an older upstream version after the new files are ready.
for (const name of await fs.readdir(path.join(output, "assets"))) {
  if (
    !names.some(
      (current) =>
        name === current ||
        name === current + ".gz" ||
        name === current + ".br",
    )
  )
    await fs.unlink(path.join(output, "assets", name));
}
