import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";

export function registerDownloadRoute(app: FastifyInstance): void {
  // Uses the same host-filesystem and deployment-auth boundary as /@fs/.
  app.get<{ Querystring: { path?: unknown } }>(
    "/__backend/download",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("X-Content-Type-Options", "nosniff");
      const filePath = request.query.path;
      if (
        typeof filePath !== "string" ||
        !path.isAbsolute(filePath) ||
        filePath.includes("\0")
      ) {
        return reply.code(400).send({ error: "An absolute file path is required" });
      }

      let file;
      try {
        // Non-blocking open prevents a named pipe from holding a request open.
        file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
        const stat = await file.stat();
        if (!stat.isFile()) {
          await file.close();
          return reply.code(400).send({ error: "Only regular files can be downloaded" });
        }
        const filename = path.basename(filePath);
        const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
        const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) =>
          `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        reply.header(
          "Content-Disposition",
          `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
        );
        reply.header("Content-Length", stat.size);
        reply.type("application/octet-stream");
        return reply.send(file.createReadStream());
      } catch (error) {
        await file?.close().catch(() => {});
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          return reply.code(404).send({ error: "File not found" });
        }
        if (code === "EACCES" || code === "EPERM") {
          return reply.code(403).send({ error: "File is not readable" });
        }
        request.log.error(error, "File download failed");
        return reply.code(500).send({ error: "File download failed" });
      }
    },
  );
}
