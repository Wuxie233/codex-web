import { minify, parseSync } from "rolldown/experimental";

export async function compactModule(name, input) {
  const parsed = parseSync(name, input);
  if (parsed.errors.length) throw new Error(JSON.stringify(parsed.errors));
  const notices = parsed.comments
    .filter((comment) =>
      /^!|@license|@preserve|copyright/i.test(comment.value.trim()),
    )
    .map((comment) =>
      comment.type === "Block" ? `/*${comment.value}*/` : `//${comment.value}`,
    );
  // Whitespace only: no variable renaming, expression rewrites or tree shaking.
  const result = await minify(name, input, {
    module: true,
    compress: false,
    mangle: false,
  });
  if (result.errors.length) throw new Error(JSON.stringify(result.errors));
  return [...notices, result.code].join("\n");
}
