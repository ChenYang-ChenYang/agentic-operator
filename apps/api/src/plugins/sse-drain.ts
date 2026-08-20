import type { FastifyInstance } from "fastify";

type StreamCloser = () => void;
export type SseDrainRegistrar = (close: StreamCloser) => () => void;

/**
 * Register one hijacked/SSE response with the Fastify shutdown lifecycle.
 *
 * Fastify cannot finish `app.close()` while a hijacked response remains open.
 * In development that previously turned every source edit into a 10-second
 * API outage, and Next.js surfaced the refused proxy request as a plain-text
 * HTTP 500. `preClose` is Fastify's intended place to end long-lived sockets
 * before the normal request drain begins.
 */
export function createSseDrainRegistry(
  app: FastifyInstance,
): SseDrainRegistrar {
  const closers = new Set<StreamCloser>();
  // Hooks must be installed while the plugin is registering, before Fastify
  // becomes ready/listening. Adding one lazily from a route handler is too
  // late and Fastify correctly rejects that mutation.
  app.addHook("preClose", async () => {
    const active = [...closers];
    // Clear first so socket-level `close` callbacks can be safely re-entrant.
    closers.clear();
    for (const close of active) {
      try {
        close();
      } catch {
        // A stream socket may already have disappeared. Shutdown must still
        // continue so the watcher can replace the API process promptly.
      }
    }
  });
  return (close) => {
    closers.add(close);
    return () => {
      closers.delete(close);
    };
  };
}
