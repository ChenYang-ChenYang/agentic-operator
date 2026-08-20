/** Tenant-scoped SSE tail for the exact append-only runtime log file. */

import type { FastifyInstance } from "fastify";
import { constants } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createGunzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { authorizedRunLogPath } from "@agentic/runtime";
import { requirePermission } from "../../plugins/rbac";
import { getRun } from "../../queries/runs";

const POLL_MS = 250;
const HEARTBEAT_MS = 15_000;
const MAX_READ_BYTES = 256 * 1024;
const MAX_PARTIAL_LINE_BYTES = 1024 * 1024;
const gunzipAsync = promisify(gunzip);

function dateDir(at: Date): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sseFrame(event: string, data: string, id?: string): string {
  const lines: string[] = [];
  if (id) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  for (const line of data.split("\n")) lines.push(`data: ${line}`);
  lines.push("", "");
  return lines.join("\n");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export async function runsLogsRoute(app: FastifyInstance) {
  app.get<{
    Params: { id: string };
    Querystring: { follow?: string; cursor?: string };
  }>("/runs/:id/logs", async (req, reply) => {
    const auth = requirePermission(req, "runs.read");
    const run = await getRun(auth.tenantSlug, req.params.id);
    if (!run) return reply.fail("not_found", "run not found", 404);

    const follow = req.query.follow === "1" || req.query.follow === "true";
    const startedAt = run.startedAt ?? new Date();
    const fallback = path.resolve(
      process.env.AGENTIC_LOGS_DIR ?? "./logs",
      auth.tenantSlug,
      "runs",
      dateDir(startedAt),
      `${run.id}.log`,
    );
    let filePath: string;
    try {
      filePath = authorizedRunLogPath(auth.tenantSlug, run.logPath || fallback);
    } catch {
      return reply.fail(
        "invalid_log_path",
        "the persisted run log path is outside this tenant's configured log root",
        409,
      );
    }

    const tenantLogRoot = path.resolve(
      process.env.AGENTIC_LOGS_DIR ?? "./logs",
      auth.tenantSlug,
      "runs",
    );
    const assertResolvedDirectory = async (): Promise<void> => {
      const [root, directory] = await Promise.all([
        realpath(tenantLogRoot),
        realpath(path.dirname(filePath)),
      ]);
      if (!isInside(root, directory)) {
        throw new Error("run log directory resolves outside tenant log root");
      }
    };

    let archived = false;
    // A one-shot read of a missing file is not a successful empty log. Rotated
    // logs remain readable from the sibling .gz archive.
    // before hijacking so callers receive a normal, inspectable HTTP error.
    try {
      await stat(filePath);
      await assertResolvedDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await stat(`${filePath}.gz`);
          filePath = `${filePath}.gz`;
          archived = true;
          await assertResolvedDirectory();
        } catch (archiveError) {
          if (
            (archiveError as NodeJS.ErrnoException).code === "ENOENT" &&
            follow
          ) {
            // Runtime creates the file after inserting the run row.
          } else if (
            (archiveError as NodeJS.ErrnoException).code === "ENOENT"
          ) {
            return reply.fail(
              "log_not_found",
              "run log file is not present",
              404,
            );
          } else {
            return reply.fail(
              "log_unreadable",
              "run log archive could not be safely read",
              409,
            );
          }
        }
      } else {
        return reply.fail(
          "log_unreadable",
          "run log path could not be safely read",
          409,
        );
      }
    }

    const headerCursor = req.headers["last-event-id"];
    const rawCursor =
      req.query.cursor ??
      (Array.isArray(headerCursor) ? headerCursor[0] : headerCursor);
    if (rawCursor != null && rawCursor !== "") {
      const parsed = Number(rawCursor);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        return reply.fail(
          "bad_request",
          "cursor must be a non-negative byte offset",
          400,
        );
      }
    }
    let pos = rawCursor ? Number(rawCursor) : 0;
    let carry = Buffer.alloc(0);
    let carryStart = pos;
    let closed = false;
    let reading = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.write("retry: 1000\n\n");

    const close = () => {
      if (closed) return;
      closed = true;
      if (poll) clearInterval(poll);
      if (heartbeat) clearInterval(heartbeat);
      poll = null;
      heartbeat = null;
      try {
        raw.end();
      } catch {
        // Socket may already be gone.
      }
    };

    const writeFrame = async (frame: string): Promise<void> => {
      if (closed || raw.destroyed || raw.writableEnded) return;
      if (raw.write(frame)) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          raw.off("drain", done);
          raw.off("close", done);
          raw.off("error", done);
          resolve();
        };
        raw.once("drain", done);
        raw.once("close", done);
        raw.once("error", done);
      });
    };

    const emitLine = async (bytes: Buffer, byteCursor: number) => {
      if (closed || bytes.length === 0) return;
      const line = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
      await writeFrame(
        sseFrame("log", line.toString("utf8"), String(byteCursor)),
      );
    };

    const pump = async (flushCarry = false): Promise<"ok" | "missing"> => {
      if (closed || reading) return "ok";
      reading = true;
      try {
        if (archived) {
          const uncompressed = await gunzipAsync(await readFile(filePath));
          if (pos > uncompressed.length) pos = 0;
          let lineStart = pos;
          for (let index = pos; index < uncompressed.length; index += 1) {
            if (uncompressed[index] !== 0x0a) continue;
            await emitLine(uncompressed.subarray(lineStart, index), index + 1);
            lineStart = index + 1;
          }
          pos = uncompressed.length;
          if (lineStart < uncompressed.length) {
            await emitLine(uncompressed.subarray(lineStart), pos);
          }
          return "ok";
        }
        let fileStat;
        try {
          fileStat = await stat(filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return "missing";
          throw error;
        }
        await assertResolvedDirectory();
        if (fileStat.size < pos) {
          pos = 0;
          carry = Buffer.alloc(0);
          carryStart = 0;
          await writeFrame(
            sseFrame("info", "(log rotated; following replacement file)"),
          );
        }

        const handle = await open(
          filePath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          while (!closed && fileStat.size > pos) {
            const readStart = pos;
            const length = Math.min(MAX_READ_BYTES, fileStat.size - pos);
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, pos);
            if (bytesRead === 0) break;
            pos += bytesRead;
            const bytes = buffer.subarray(0, bytesRead);
            const combinedStart = carry.length > 0 ? carryStart : readStart;
            const combined =
              carry.length > 0 ? Buffer.concat([carry, bytes]) : bytes;
            let lineStart = 0;
            for (let index = 0; index < combined.length; index += 1) {
              if (combined[index] !== 0x0a) continue;
              await emitLine(
                combined.subarray(lineStart, index),
                combinedStart + index + 1,
              );
              lineStart = index + 1;
            }
            carry = Buffer.from(combined.subarray(lineStart));
            carryStart = combinedStart + lineStart;
            if (carry.length > MAX_PARTIAL_LINE_BYTES) {
              throw new Error(
                `run log contains a line larger than ${MAX_PARTIAL_LINE_BYTES} bytes`,
              );
            }
          }
        } finally {
          await handle.close();
        }
        if (flushCarry && carry.length > 0) {
          await emitLine(carry, pos);
          carry = Buffer.alloc(0);
          carryStart = pos;
        }
        return "ok";
      } finally {
        reading = false;
      }
    };

    const failStream = async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      req.log.error({ error, runId: run.id }, "run log tail failed");
      await writeFrame(sseFrame("error", message));
      close();
    };

    try {
      const initial = await pump(!follow);
      if (initial === "missing") {
        await writeFrame(
          sseFrame(
            "info",
            "(log file not yet present; waiting for runtime output)",
          ),
        );
      }
    } catch (error) {
      await failStream(error);
      return reply;
    }

    if (!follow) {
      await writeFrame(sseFrame("end", "ok", String(pos)));
      close();
      return reply;
    }
    if (archived) {
      await writeFrame(
        sseFrame("info", "(archived log loaded; live follow is unavailable)"),
      );
      await writeFrame(sseFrame("end", "ok", String(pos)));
      close();
      return reply;
    }

    poll = setInterval(() => {
      void pump().catch(failStream);
    }, POLL_MS);
    poll.unref?.();
    heartbeat = setInterval(() => {
      if (!closed && !reading && raw.writableNeedDrain !== true) {
        void writeFrame(`: keepalive ${Date.now()}\n\n`);
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    req.raw.on("close", close);
    req.raw.on("error", close);
    raw.on("close", close);
    raw.on("error", close);
    return reply;
  });

  // Full-fidelity download. Unlike the browser log viewer this never applies
  // a line-window cap, and transparently decompresses a rotated .log.gz file.
  app.get<{ Params: { id: string } }>(
    "/runs/:id/logs/raw",
    async (req, reply) => {
      const auth = requirePermission(req, "runs.read");
      const run = await getRun(auth.tenantSlug, req.params.id);
      if (!run) return reply.fail("not_found", "run not found", 404);
      const startedAt = run.startedAt ?? new Date();
      const fallback = path.resolve(
        process.env.AGENTIC_LOGS_DIR ?? "./logs",
        auth.tenantSlug,
        "runs",
        dateDir(startedAt),
        `${run.id}.log`,
      );
      let filePath: string;
      try {
        filePath = authorizedRunLogPath(
          auth.tenantSlug,
          run.logPath || fallback,
        );
      } catch {
        return reply.fail("invalid_log_path", "invalid run log path", 409);
      }
      let archived = false;
      try {
        await stat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        filePath = `${filePath}.gz`;
        archived = true;
        try {
          await stat(filePath);
        } catch (archiveError) {
          if ((archiveError as NodeJS.ErrnoException).code === "ENOENT") {
            return reply.fail(
              "log_not_found",
              "run log file is not present",
              404,
            );
          }
          throw archiveError;
        }
      }
      const tenantLogRoot = path.resolve(
        process.env.AGENTIC_LOGS_DIR ?? "./logs",
        auth.tenantSlug,
        "runs",
      );
      try {
        const [root, directory] = await Promise.all([
          realpath(tenantLogRoot),
          realpath(path.dirname(filePath)),
        ]);
        if (!isInside(root, directory)) throw new Error("path escape");
      } catch {
        return reply.fail("log_unreadable", "run log path is not safe", 409);
      }
      reply.header("Content-Type", "text/plain; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="${run.id.replace(/[^A-Za-z0-9_-]/g, "_")}.log"`,
      );
      const handle = await open(
        filePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stream = handle.createReadStream();
      return reply.send(archived ? stream.pipe(createGunzip()) : stream);
    },
  );
}
