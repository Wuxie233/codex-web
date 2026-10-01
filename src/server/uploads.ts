import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";

export const MAX_UPLOAD_FILE_BYTES = 128 * 1024 * 1024;

export async function registerUploadRoutes(
  app: FastifyInstance,
  options: { root?: string; maxFileBytes?: number } = {},
): Promise<void> {
  await app.register(fastifyMultipart, {
    limits: { fileSize: options.maxFileBytes ?? MAX_UPLOAD_FILE_BYTES },
  });
  const root =
    options.root ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "codex-web-uploads-")));

  app.post("/__backend/upload", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }
    const writtenPaths: string[] = [];
    const files: { label: string; path: string; fsPath: string }[] = [];
    try {
      for await (const part of request.files()) {
        // Multipart parsing may close a queued part before it is consumed.
        // pipeline cannot observe a close event that already happened.
        if (part.file.destroyed && !part.file.readableEnded) {
          throw Object.assign(new Error("incomplete multipart file"), {
            statusCode: 400,
          });
        }
        const label = part.filename?.trim() || "upload";
        // The native composer classifies images using the local path suffix.
        const extension = path.extname(label).toLowerCase();
        const safeExtension = /^\.[a-z0-9]{1,16}$/.test(extension)
          ? extension
          : "";
        const uploadedPath = path.join(root, randomUUID() + safeExtension);
        writtenPaths.push(uploadedPath);
        await pipeline(
          part.file,
          createWriteStream(uploadedPath, { flags: "wx" }),
        );
        if (part.file.truncated) {
          throw new app.multipartErrors.RequestFileTooLargeError();
        }
        files.push({ label, path: uploadedPath, fsPath: uploadedPath });
      }
      return reply.send({ files });
    } catch (error) {
      // Include the in-progress file and earlier files from this request.
      await Promise.all(
        writtenPaths.map((file) => fs.rm(file, { force: true })),
      );
      throw error;
    }
  });
}
